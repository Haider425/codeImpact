import { writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ALGORITHM_VERSION, analyzeRepository } from '../src/analysis/engine'
import { PARSER_VERSION } from '../src/analysis/parser'
import { groupFindings } from '../src/analysis/merge'
import type { ReviewFinding } from '../src/analysis/types'
import { loadConfig } from './config'
import { Store } from './db'
import { AnalysisError } from './errors'
import { buildEvidenceBundle, explainAnalysis } from './explain'
import { compactResult } from './pipeline'
import { collectEvidence, DEFAULT_EVIDENCE_OPTIONS } from './evidence'
import type { EvidenceReport } from './evidence'
import { loadRepositoryRevisions, mergeBase, resolveCommit } from './git'
import { GitHubClient, parsePullRequestRef } from './github'

const USAGE = `Usage:
  npm run review -- <owner/repo#number | github.com pull-request URL> [options]
  npm run review -- --repo <path> --base <ref> --head <ref> [options]

Options:
  --typecheck         run the project's type checker (tsc / pyright) on base and head
  --run-tests         run the top-ranked impacted tests (executes repository code)
  --max-tests <n>     impacted tests to run (default ${DEFAULT_EVIDENCE_OPTIONS.maxTests})
  --timeout <s>       time limit per checker or test run, in seconds
  --json              print machine-readable output
  --output <file>     write the machine-readable report to a file (used by the GitHub Action)
  --store             save the analysis, with its evidence, to the local database for the web UI
  --as <owner/repo#n> label a --repo analysis with the public pull request it belongs to`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    base: { type: 'string' },
    head: { type: 'string' },
    typecheck: { type: 'boolean', default: false },
    'run-tests': { type: 'boolean', default: false },
    'max-tests': { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean', default: false },
    output: { type: 'string' },
    store: { type: 'boolean', default: false },
    as: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

if (values.help || (!values.repo && positionals.length === 0)) {
  console.error(USAGE)
  process.exit(values.help ? 0 : 2)
}

const config = loadConfig()
const timeoutMs = values.timeout ? Number(values.timeout) * 1000 : undefined
const evidenceOptions = {
  ...DEFAULT_EVIDENCE_OPTIONS,
  typecheck: values.typecheck,
  runTests: values['run-tests'],
  ...(values['max-tests'] ? { maxTests: Number(values['max-tests']) } : {}),
  ...(timeoutMs ? { typecheckTimeoutMs: timeoutMs, testTimeoutMs: timeoutMs } : {}),
}

async function resolveTarget() {
  if (values.repo) {
    if (!values.base || !values.head) throw new AnalysisError('invalid_arguments', '--repo needs --base and --head.', false)
    const head = await resolveCommit(values.repo, values.head)
    const base = await mergeBase(values.repo, await resolveCommit(values.repo, values.base), head)
    // --as labels a local checkout of a public repository with its GitHub identity, so stored reports link to it.
    const identity = values.as ? parsePullRequestRef(values.as) : undefined
    if (values.as && !identity) throw new AnalysisError('invalid_arguments', `--as expects owner/repo#number, got ${values.as}`, false)
    if (identity) {
      return { cwd: values.repo, base, head, owner: identity.owner, name: identity.repo, title: `${values.base}…${values.head}`, number: identity.number, author: '', baseRef: values.base, headRef: values.head }
    }
    const name = basename(resolve(values.repo))
    return { cwd: values.repo, base, head, owner: 'local', name, title: `${values.base}…${values.head}`, number: 0, author: '', baseRef: values.base, headRef: values.head }
  }
  const ref = parsePullRequestRef(positionals[0])
  if (!ref) throw new AnalysisError('invalid_arguments', `Not a pull-request reference: ${positionals[0]}\n\n${USAGE}`, false)
  const github = new GitHubClient(config.githubToken)
  const pull = await github.pullRequest(ref.owner, ref.repo, ref.number)
  const base = await github.mergeBase(ref.owner, ref.repo, pull.baseSha, pull.headSha)
  const cwd = await github.fetchCommits(config.dataDir, ref.owner, ref.repo, ref.number, [base, pull.headSha])
  return { cwd, base, head: pull.headSha, owner: ref.owner, name: ref.repo, title: pull.title, number: pull.number, author: pull.author, baseRef: pull.baseRef, headRef: pull.headRef }
}

function printEvidence(report: EvidenceReport) {
  for (const run of report.typecheck ?? []) {
    const detail = run.head.status === 'ran'
      ? `${run.head.errors} errors on head, ${run.base?.status === 'ran' ? `${run.base.errors} on base` : `base ${run.base?.status ?? 'not run'}`}, ${run.reported} reported`
      : run.head.reason ?? run.head.status
    console.log(`type check (${run.head.tool}): ${run.head.status} — ${detail}${run.head.durationMs ? ` · ${run.head.durationMs} ms` : ''}`)
  }
  if (report.tests) {
    const t = report.tests
    const counts = t.status === 'ran' ? `${t.selected} of ${t.totalTests} tests selected, ${t.passed + t.failed + t.errors + t.skipped} ran · ${t.passed} passed, ${t.failed} failed, ${t.errors} errors, ${t.skipped} skipped · ${t.durationMs} ms` : t.reason ?? ''
    console.log(`impacted tests${t.runner ? ` (${t.runner})` : ''}: ${t.status} — ${counts}`)
    for (const problem of t.environmentErrors.slice(0, 5)) console.log(`  environment: ${problem}`)
    if (t.environmentErrors.length > 5) console.log(`  … ${t.environmentErrors.length - 5} more environment errors`)
  }
}

try {
  const target = await resolveTarget()
  const loaded = await loadRepositoryRevisions(target.cwd, {
    owner: target.owner,
    name: target.name,
    pullRequest: { number: target.number, title: target.title, author: target.author, baseRef: target.baseRef, headRef: target.headRef },
  }, target.base, target.head)
  const result = await analyzeRepository(loaded.repository, { wasmBasePath: config.wasmBasePath, maxDepth: config.maxDepth, limitations: loaded.limitations })
  const evidence = await collectEvidence({
    repoDir: target.cwd,
    baseSha: target.base,
    headSha: target.head,
    result,
    changedPaths: new Set(loaded.changed.map((file) => file.path)),
    options: evidenceOptions,
  })
  const order = { high: 0, medium: 1, low: 2 }
  const findings = [...result.review, ...evidence.findings].sort((a, b) => order[a.severity] - order[b.severity])
  const groups = groupFindings(findings, result.edges)

  const report = {
    schemaVersion: 2,
    tool: { name: 'codeimpact', parser: result.settings.parserVersion, algorithm: result.settings.algorithmVersion },
    target: { owner: target.owner, name: target.name, number: target.number, title: target.title, baseSha: target.base, headSha: target.head },
    findings,
    /** Findings merged by affected location; the PR comment and web UI render these. */
    groups,
    evidence: evidence.report,
    stats: result.stats,
    limitations: result.limitations,
  }
  if (values.output) writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`)
  if (values.store) {
    const store = new Store(config.dbPath)
    const repository = store.upsertRepository(target.owner === 'local'
      ? { source: 'local', owner: 'local', name: target.name }
      : { source: 'github', owner: target.owner, name: target.name })
    // Rule, type-checker, and test findings all go into the stored review so the web UI shows every source.
    const reviewed = { ...result, review: findings }
    const flags = `${values.typecheck ? 't' : ''}${values['run-tests'] ? 'r' : ''}`
    const id = store.recordCompleted({
      repository_id: repository.id,
      pull_request_number: target.number || null,
      pull_request_title: target.title,
      pull_request_author: target.author || null,
      base_ref: target.baseRef,
      head_ref: target.headRef,
      base_sha: target.base,
      head_sha: target.head,
      dedupe_key: `cli:${repository.source}:${target.owner}/${target.name}#${target.number}@${target.base}..${target.head}/${PARSER_VERSION}/${ALGORITHM_VERSION}/${flags}`,
    }, {
      result: { ...compactResult(reviewed, loaded.repository.base.files, loaded.repository.head.files, loaded.changed), evidence: evidence.report },
      timings: {},
      mergeBase: target.base,
      parserVersion: PARSER_VERSION,
      algorithmVersion: ALGORITHM_VERSION,
    })
    const explanation = explainAnalysis(buildEvidenceBundle(reviewed, { repository: `${target.owner}/${target.name}`, number: target.number, title: target.title }))
    store.saveExplanation(id, { structuredOutput: explanation.explanation, modelIdentifier: explanation.modelIdentifier, promptVersion: explanation.promptVersion, status: explanation.status, issues: explanation.issues, latencyMs: explanation.latencyMs })
    store.db.close()
    if (!values.json) console.log(`Stored as analysis #${id} in ${config.dbPath}`)
  }
  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    const where = (location: ReviewFinding['changed']) => `${location.path}:${location.line}${location.revision === 'base' ? ' (base)' : ''}`
    console.log(`${target.owner}/${target.name}${target.number ? `#${target.number}` : ''}  ${target.title}`)
    console.log(`${target.base.slice(0, 7)}..${target.head.slice(0, 7)} · ${result.stats.changedSymbols} changed symbols · ${result.stats.impactedSymbols} impacted · ${result.stats.recommendedTests} tests recommended · ${result.stats.durationMs} ms`)
    printEvidence(evidence.report)
    console.log('')
    if (groups.length === 0) console.log('No findings. That does not mean the change is safe; see the impact report.')
    const sourceLabel = { rule: 'rule', typecheck: 'type checker', 'test-run': 'test run' }
    for (const group of groups) {
      console.log(`[${group.severity.toUpperCase()}] ${where(group.affected)}${group.affected.symbol ? `  ${group.affected.symbol}` : ''}  ·  evidence: ${group.sources.map((source) => sourceLabel[source]).join(', ')}`)
      console.log(`  changed: ${group.changed.map(where).join(', ')}`)
      for (const finding of group.findings) {
        console.log(`  - ${finding.ruleId} (${sourceLabel[finding.source]}, ${finding.severity}${finding.confidence === 'inferred' ? ', inferred link' : ''}): ${finding.message.replaceAll('`', '')}`)
        if (finding.source === 'test-run') console.log(`      test: ${where(finding.affected)}`)
        for (const caller of finding.details?.callers ?? []) {
          const status = caller.affected ? `affected${caller.confirmed ? '' : ', inferred link'}` : 'not affected'
          console.log(`      ${where(caller.location)}  ${caller.location.symbol}  [${status}]${caller.reasons.length ? ` ${caller.reasons.join('; ').replaceAll('`', '')}` : ''}`)
        }
      }
      console.log('')
    }
  }
} catch (error) {
  console.error(error instanceof AnalysisError ? `${error.code}: ${error.message}` : error)
  process.exit(1)
}
