import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { analyzeRepository } from '../../src/analysis/engine'
import type { AnalysisResult, SymbolRecord } from '../../src/analysis/types'
import { git, loadRepositoryRevisions } from '../git'
import { collectEvidence, DEFAULT_EVIDENCE_OPTIONS } from './index'
import { materialize, runCommand, sanitizedEnv } from './sandbox'
import { parseJestJson, parseJunit } from './tests'
import { diagnosticFindings, parsePyright, runPyright, runTsc } from './typecheck'
import type { Diagnostic } from './typecheck'

const ROOT = resolve(import.meta.dirname, '../..')
const wasmBasePath = join(ROOT, 'public/wasm')
const workspaces: string[] = []
afterAll(() => workspaces.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

/** Create a git repo with a base commit and a head commit, returning both SHAs. */
async function fixtureRepo(base: Record<string, string>, head: Record<string, string | null>) {
  const dir = mkdtempSync(join(tmpdir(), 'codeimpact-fixture-'))
  workspaces.push(dir)
  const write = (files: Record<string, string | null>) => {
    for (const [path, source] of Object.entries(files)) {
      if (source === null) rmSync(join(dir, path))
      else {
        mkdirSync(join(dir, path, '..'), { recursive: true })
        writeFileSync(join(dir, path), source)
      }
    }
  }
  await git(dir, ['init', '--quiet', '-b', 'main'])
  await git(dir, ['config', 'user.email', 't@example.com'])
  await git(dir, ['config', 'user.name', 'T'])
  write(base)
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--quiet', '-m', 'base'])
  write(head)
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--quiet', '-m', 'head'])
  const sha = async (ref: string) => (await git(dir, ['rev-parse', ref])).toString().trim()
  return { dir, baseSha: await sha('HEAD~1'), headSha: await sha('HEAD') }
}

async function analyzeFixture(repo: { dir: string; baseSha: string; headSha: string }) {
  const loaded = await loadRepositoryRevisions(repo.dir, { owner: 't', name: 'r', pullRequest: { number: 1, title: '', author: '', baseRef: 'base', headRef: 'head' } }, repo.baseSha, repo.headSha)
  const result = await analyzeRepository(loaded.repository, { wasmBasePath })
  return { result, changedPaths: new Set(loaded.changed.map((file) => file.path)) }
}

describe('sandbox', () => {
  it('drops credentials from child environments', async () => {
    process.env.GITHUB_TOKEN = 'ghs_secret'
    process.env.NPM_TOKEN = 'npm_secret'
    try {
      const run = await runCommand(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { cwd: ROOT, timeoutMs: 20_000 })
      const env = JSON.parse(run.stdout)
      expect(env.GITHUB_TOKEN).toBeUndefined()
      expect(env.NPM_TOKEN).toBeUndefined()
      expect(env.CI).toBe('true')
      expect(sanitizedEnv().PATH ?? sanitizedEnv().Path).toBeTruthy()
    } finally {
      delete process.env.GITHUB_TOKEN
      delete process.env.NPM_TOKEN
    }
  })

  it('kills commands that exceed their time limit', async () => {
    const run = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: ROOT, timeoutMs: 500 })
    expect(run.timedOut).toBe(true)
    expect(run.durationMs).toBeLessThan(15_000)
  }, 20_000)

  it('reports a missing executable instead of throwing', async () => {
    const run = await runCommand('codeimpact-no-such-binary', [], { cwd: ROOT, timeoutMs: 5_000 })
    expect(run.spawnError).toBeTruthy()
  })

  it('materializes a revision without touching the repository index or linked node_modules', async () => {
    const repo = await fixtureRepo({ 'a.txt': 'one\n' }, { 'a.txt': 'two\n' })
    mkdirSync(join(repo.dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo.dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
    const before = (await git(repo.dir, ['status', '--porcelain', '--untracked-files=no'])).toString()
    const workspace = await materialize(repo.dir, repo.baseSha, 'test')
    expect(spawnSync('git', ['-C', repo.dir, 'status', '--porcelain', '--untracked-files=no']).stdout.toString()).toBe(before)
    expect(readdirSync(workspace.dir).sort()).toEqual(['a.txt', 'node_modules'])
    expect(existsSync(join(workspace.dir, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    workspace.cleanup()
    expect(existsSync(workspace.dir)).toBe(false)
    expect(existsSync(join(repo.dir, 'node_modules', 'pkg', 'index.js'))).toBe(true)

    // A relative repository path must still link to the real node_modules, not to the link itself.
    const fromRelative = await materialize(relative(process.cwd(), repo.dir), repo.baseSha, 'test')
    expect(existsSync(join(fromRelative.dir, 'node_modules', 'pkg', 'index.js'))).toBe(true)
    fromRelative.cleanup()
  }, 30_000)
})

describe('type checker evidence', () => {
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', noEmit: true, incremental: true, tsBuildInfoFile: 'node_modules/.tmp/x.tsbuildinfo' }, include: ['src'] })

  it('reports new errors in untouched files that reference a changed symbol, and nothing else', async () => {
    const repo = await fixtureRepo({
      'tsconfig.json': tsconfig,
      'src/price.ts': 'export function price(amount: number, rate: number): number {\n  return amount * rate\n}\n',
      'src/cart.ts': 'import { price } from "./price"\n\nexport function total(x: number) {\n  return price(x, 2)\n}\n',
      'src/unrelated.ts': 'export const broken: number = "not a number"\n',
    }, {
      'src/price.ts': 'export function price(amount: number, rate: number, tax: number): number {\n  return amount * rate + tax\n}\n\nexport const own = price(1, 2)\n',
    })
    const { result, changedPaths } = await analyzeFixture(repo)
    const { findings, report } = await collectEvidence({ ...repo, repoDir: repo.dir, result, changedPaths, options: { ...DEFAULT_EVIDENCE_OPTIONS, typecheck: true } })

    expect(report.typecheck).toMatchObject([{ head: { tool: 'tsc', status: 'ran' }, base: { status: 'ran' }, reported: 1 }])
    expect(report.typecheck![0].head.errors).toBe(3) // cart.ts (new), price.ts (changed file), unrelated.ts (pre-existing)
    expect(findings).toEqual([expect.objectContaining({
      ruleId: 'typecheck/tsc',
      source: 'typecheck',
      severity: 'high',
      changed: expect.objectContaining({ path: 'src/price.ts', line: 1 }),
      affected: expect.objectContaining({ path: 'src/cart.ts', line: 4 }),
    })])
    expect(findings[0].message).toMatch(/^tsc TS2554: Expected 3 arguments, but got 2/)
    expect(existsSync(join(repo.dir, 'node_modules', '.tmp'))).toBe(false)
  }, 120_000)

  it('skips quietly when the project is not set up for a checker', async () => {
    const repo = await fixtureRepo({ 'src/a.ts': 'export const a = 1\n' }, { 'src/a.ts': 'export const a = 2\n' })
    expect(await runTsc(repo.dir, 10_000)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('tsconfig') })
    expect(await runPyright(repo.dir, 10_000)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('configuration') })
  }, 30_000)

  it('keeps only PR-introduced diagnostics that refer to a changed symbol', () => {
    const change = { symbolId: 'app/core.py::load::function', changeType: 'signature' as const, head: { id: 'app/core.py::load::function', name: 'load', qualifiedName: 'load', path: 'app/core.py', startLine: 3, kind: 'function' } as SymbolRecord }
    const result = { changes: [change], edges: [{ id: 'e1', type: 'calls', source: 'x', target: change.symbolId, evidencePath: 'app/use.py', evidenceLine: 9, evidenceRevision: 'head' }] } as unknown as AnalysisResult
    const d = (path: string, line: number, message: string, code = 'reportCallIssue'): Diagnostic => ({ tool: 'pyright', path, line, code, message })
    const head = [
      d('app/use.py', 9, 'Argument missing for parameter "mode"'), // on a call edge to the changed symbol
      d('app/other.py', 4, 'Cannot access attribute "x" for class "load"'), // names the symbol
      d('app/other.py', 7, 'Expression of type "str" is incompatible'), // unrelated
      d('app/core.py', 3, 'Argument missing for parameter "mode"'), // in a changed file
      d('app/old.py', 2, '"load" is possibly unbound'), // already present on base
    ]
    const base = [d('app/old.py', 2, '"load" is possibly unbound')]
    const findings = diagnosticFindings(head, base, { result, changedPaths: new Set(['app/core.py']), lineText: () => '' })
    expect(findings.map((f) => `${f.affected.path}:${f.affected.line}`)).toEqual(['app/use.py:9', 'app/other.py:4'])
    expect(findings[0]).toMatchObject({ evidence: ['e1'], changed: { path: 'app/core.py', line: 3 } })
    expect(diagnosticFindings(head.slice(0, 1), undefined, { result, changedPaths: new Set(), lineText: () => '' })[0].message).toContain('could not be checked')
  })

  it('parses pyright JSON output', () => {
    const dir = resolve('/repo')
    const stdout = JSON.stringify({
      generalDiagnostics: [
        { file: join(dir, 'app', 'use.py'), severity: 'error', message: 'Argument missing for parameter "mode"\n  extra detail', rule: 'reportCallIssue', range: { start: { line: 8, character: 4 } } },
        { file: join(dir, 'app', 'use.py'), severity: 'warning', message: 'ignored', range: { start: { line: 1, character: 0 } } },
      ],
    })
    expect(parsePyright(stdout, dir)).toEqual([{ path: 'app/use.py', line: 9, code: 'reportCallIssue', message: 'Argument missing for parameter "mode"' }])
    expect(parsePyright('not json', dir)).toBeUndefined()
  })
})

const pytestAvailable = spawnSync('python', ['-m', 'pytest', '--version']).status === 0

describe('impacted test runs', () => {
  it.skipIf(!pytestAvailable)('runs top-ranked impacted tests and separates regressions from pre-existing failures', async () => {
    const repo = await fixtureRepo({
      'app/__init__.py': '',
      'app/calc.py': 'def add(a, b):\n    return a + b\n',
      'tests/test_calc.py': [
        'from app.calc import add',
        '',
        'def test_add():',
        '    assert add(2, 2) == 4',
        '',
        'def test_already_broken():',
        '    assert add(1, 1) == 3',
        '',
        'def test_unrelated():',
        '    assert True',
        '',
      ].join('\n'),
      'tests/test_missing_dep.py': 'import codeimpact_missing_module\nfrom app.calc import add\n\ndef test_needs_dep():\n    assert add(1, 2) == 3\n',
    }, { 'app/calc.py': 'def add(a, b):\n    return a - b\n' })
    const { result, changedPaths } = await analyzeFixture(repo)
    const { findings, report } = await collectEvidence({ ...repo, repoDir: repo.dir, result, changedPaths, options: { ...DEFAULT_EVIDENCE_OPTIONS, runTests: true } })

    expect(report.tests).toMatchObject({ runner: 'pytest', status: 'ran', selected: 4, totalTests: 4, passed: 1, failed: 2, errors: 0 })
    // The uncollectable module is reported as an environment problem, and the other tests still ran.
    expect(report.tests!.environmentErrors).toEqual(['tests.test_missing_dep: collection failure'])
    const bySymbol = Object.fromEntries(findings.map((f) => [f.affected.symbol, f]))
    expect(bySymbol.test_add).toMatchObject({ ruleId: 'tests/failure', source: 'test-run', severity: 'high', changed: { path: 'app/calc.py', line: 1 } })
    expect(bySymbol.test_add.message).toContain('passes on the base revision')
    expect(bySymbol.test_already_broken).toMatchObject({ severity: 'low' })
    expect(bySymbol.test_already_broken.message).toContain('also fails on the base revision')
    expect(readdirSync(repo.dir).filter((name) => name.startsWith('.codeimpact') || name === '.pytest_cache')).toEqual([])
  }, 120_000)

  it('reports a missing test runner instead of failing', async () => {
    const repo = await fixtureRepo({
      'package.json': '{"devDependencies":{"vitest":"^4"}}',
      'src/a.ts': 'export function a() {\n  return 1\n}\n',
      'src/a.test.ts': 'import { a } from "./a"\n\nit("a", () => {\n  expect(a()).toBe(1)\n})\n',
    }, { 'src/a.ts': 'export function a() {\n  return 2\n}\n' })
    const { result, changedPaths } = await analyzeFixture(repo)
    const { findings, report } = await collectEvidence({ ...repo, repoDir: repo.dir, result, changedPaths, options: { ...DEFAULT_EVIDENCE_OPTIONS, runTests: true } })
    expect(findings).toEqual([])
    expect(report.tests).toMatchObject({ status: 'skipped', reason: expect.stringContaining('not installed'), totalTests: 1 })
  }, 60_000)

  it('maps JUnit XML onto test symbols, folding parametrized cases and separating collection errors', () => {
    const tests = [
      { id: 't1', path: 'tests/test_a.py', qualifiedName: 'TestA.test_x' },
      { id: 't2', path: 'tests/test_a.py', qualifiedName: 'test_y' },
    ] as SymbolRecord[]
    const xml = `<testsuite>
      <testcase classname="tests.test_a.TestA" name="test_x[1]" time="0.1"/>
      <testcase classname="tests.test_a.TestA" name="test_x[2]" time="0.1"><failure message="assert 1 == 2&#10;more">trace</failure></testcase>
      <testcase classname="tests.test_a" name="test_y" time="0.1"><skipped message="skip"/></testcase>
      <testcase classname="" name="tests.test_b" time="0"><error message="collection failure">ImportError</error></testcase>
    </testsuite>`
    const { outcomes, environmentErrors } = parseJunit(xml, tests)
    expect(outcomes).toEqual([{ testId: 't1', status: 'failed', message: 'assert 1 == 2&#10;more' }, { testId: 't2', status: 'skipped', message: undefined }])
    expect(environmentErrors).toEqual(['tests.test_b: collection failure'])
  })

  it('maps Jest and Vitest JSON reports by file and describe path', () => {
    const tests = [{ id: 't1', path: 'src/a.test.ts', qualifiedName: 'math > adds' }] as SymbolRecord[]
    const json = JSON.stringify({
      testResults: [
        { name: '/repo/src/a.test.ts', assertionResults: [{ ancestorTitles: ['math'], title: 'adds', status: 'failed', failureMessages: ['Expected 3\nReceived 4'] }] },
        { name: '/repo/src/b.test.ts', status: 'failed', message: 'Cannot find module ./b', assertionResults: [] },
      ],
    })
    expect(parseJestJson(json, tests, '/repo')).toEqual({
      outcomes: [{ testId: 't1', status: 'failed', message: 'Expected 3' }],
      environmentErrors: ['src/b.test.ts: Cannot find module ./b'],
    })
  })
})
