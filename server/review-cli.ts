import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { analyzeRepository } from '../src/analysis/engine'
import type { ReviewFinding } from '../src/analysis/types'
import { loadConfig } from './config'
import { AnalysisError } from './errors'
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
  --json              print machine-readable output`

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

  if (values.json) {
    console.log(JSON.stringify({ target: { ...target, cwd: undefined }, review: findings, evidence: evidence.report, stats: result.stats }, null, 2))
  } else {
    const where = (location: ReviewFinding['changed']) => `${location.path}:${location.line}${location.revision === 'base' ? ' (base)' : ''}`
    console.log(`${target.owner}/${target.name}${target.number ? `#${target.number}` : ''}  ${target.title}`)
    console.log(`${target.base.slice(0, 7)}..${target.head.slice(0, 7)} · ${result.stats.changedSymbols} changed symbols · ${result.stats.impactedSymbols} impacted · ${result.stats.recommendedTests} tests recommended · ${result.stats.durationMs} ms`)
    printEvidence(evidence.report)
    console.log('')
    if (findings.length === 0) console.log('No findings. That does not mean the change is safe; see the impact report.')
    for (const finding of findings) {
      console.log(`[${finding.severity.toUpperCase()}] ${finding.ruleId} (${finding.source}, ${finding.confidence})`)
      console.log(`  ${finding.message.replaceAll('`', '')}`)
      console.log(`  changed:  ${where(finding.changed)}`)
      if (finding.details) {
        console.log(`  callers outside the PR (${finding.details.changeKinds.join(', ')}):`)
        for (const caller of finding.details.callers) {
          const status = caller.affected ? `affected${caller.confirmed ? '' : ', inferred link'}` : 'not affected'
          console.log(`    ${where(caller.location)}  ${caller.location.symbol}  [${status}]${caller.reasons.length ? ` ${caller.reasons.join('; ').replaceAll('`', '')}` : ''}`)
        }
        console.log('')
      } else {
        console.log(`  affected: ${where(finding.affected)}\n`)
      }
    }
  }
} catch (error) {
  console.error(error instanceof AnalysisError ? `${error.code}: ${error.message}` : error)
  process.exit(1)
}
