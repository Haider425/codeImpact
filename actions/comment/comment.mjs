// CodeImpact PR comment step. Runs in the job that holds `pull-requests: write`, so it never executes
// repository code and treats the report artifact as untrusted input: the job that produced it ran the
// project's install command, type checker, and tests.
//
// Dependency-free on purpose: it runs with the runner's Node and nothing from npm.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MARKER = '<!-- codeimpact-review -->'
const COMMENT_LIMIT = 60_000
const MESSAGE_LIMIT = 600
const SHOWN = { high: 30, medium: 30, low: 20 }
const SEVERITIES = ['high', 'medium', 'low']
const SOURCE_LABELS = { rule: 'rule', typecheck: 'type checker', 'test-run': 'test run' }
const ZWSP = '\u200b'

/** Plain text → safe inline markdown: no HTML, no markdown syntax, no mentions, no autolinks, no references. */
export function escapeText(value, max = MESSAGE_LIMIT) {
  return escapeInline(normalize(value, max))
}

/** Strip control and bidi override characters, collapse whitespace to single spaces, and truncate. */
function normalize(value, max) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '') // control and bidi override characters
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function escapeInline(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+!|~]/g, '\\$&')
    .replace(/#(\d)/g, `#${ZWSP}$1`) // #123 issue and PR references
    .replace(/@/g, `@${ZWSP}`) // @user and @org/team mentions
    .replace(/:\/\//g, `:${ZWSP}//`) // http(s):// autolinks
    .replace(/\bwww\./gi, (match) => `${match.slice(0, 3)}${ZWSP}.`) // www. autolinks
    .replace(/\b(GH-)(\d)/gi, `$1${ZWSP}$2`) // GH-123 references
}

/** Render a finding message, turning `code` spans into escaped <code> elements. */
export function renderMessage(value) {
  // Normalize once so the spaces around code spans survive; segments are only escaped.
  return normalize(value, MESSAGE_LIMIT).split('`')
    .map((part, index) => (index % 2 ? `<code>${escapeInline(part.slice(0, 200))}</code>` : escapeInline(part)))
    .join('')
}

/** A repository-relative path we are willing to put into a link. */
export function safePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return undefined
  if (value.startsWith('/') || value.includes('\\') || value.split('/').some((segment) => segment === '..' || segment === '' || segment === '.')) return undefined
  if (!/^[\w.\-/@+ ]+$/.test(value)) return undefined
  return value
}

const safeLine = (value) => (Number.isInteger(value) && value >= 1 && value <= 10_000_000 ? value : undefined)
const safeSha = (value) => (typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : undefined)

export function locationLink(location, context) {
  const path = safePath(location?.path)
  if (!path) return '_unknown location_'
  const line = safeLine(location.line)
  const sha = location.revision === 'base' ? context.baseSha : context.headSha
  const label = `${escapeText(path, 300)}${line ? `:${line}` : ''}${location.revision === 'base' ? ' (base)' : ''}`
  if (!sha) return label
  const url = `${context.serverUrl}/${context.repository}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}`
  return `[${label}](${url})`
}

function isFinding(value) {
  return value && typeof value === 'object' && SEVERITIES.includes(value.severity) && typeof value.message === 'string'
}

const RULE_TITLES = {
  'signature/missing-argument': 'Caller misses a required argument',
  'signature/too-many-arguments': 'Caller passes too many arguments',
  'signature/unknown-keyword': 'Caller passes a removed keyword',
  'signature/reordered-parameters': 'Parameters were reordered',
  'reference/removed-symbol': 'Removed symbol is still called',
  'reference/renamed-symbol': 'Renamed symbol is still called by its old name',
  'reference/broken-import': 'Import no longer resolves',
  'impact/unupdated-caller': 'Callers outside the PR may be affected',
  'typecheck/tsc': 'Type error in untouched code',
  'typecheck/pyright': 'Type error in untouched code',
  'tests/failure': 'Impacted test fails',
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 }
const SOURCE_ORDER = ['rule', 'typecheck', 'test-run']
const MAX_ITEMS_PER_GROUP = 8

/**
 * Groups come from the untrusted artifact too, so they are rebuilt from validated parts. Reports without
 * groups (schema version 1) render each finding as its own group.
 */
export function readGroups(report) {
  const raw = Array.isArray(report?.groups) ? report.groups : (Array.isArray(report?.findings) ? report.findings : []).map((finding) => ({ findings: [finding] }))
  return raw.flatMap((group) => {
    const findings = (Array.isArray(group?.findings) ? group.findings : []).filter(isFinding).slice(0, 50)
    if (findings.length === 0) return []
    findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    const affected = group.affected && typeof group.affected === 'object' ? group.affected : findings[0].affected
    const changed = [...new Map(findings.map((finding) => finding.changed).filter((location) => location && typeof location === 'object')
      .map((location) => [`${location.revision}:${location.path}:${location.line}`, location])).values()]
    const sources = SOURCE_ORDER.filter((source) => findings.some((finding) => finding.source === source))
    // Severity is recomputed from the evidence rather than trusted from the group.
    return [{ severity: findings[0].severity, affected, changed, findings, sources }]
  }).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

function evidenceSummary(group) {
  const count = (source) => group.findings.filter((finding) => finding.source === source).length
  return group.sources.map((source) => {
    if (source === 'test-run') return `${count(source)} failing test${count(source) === 1 ? '' : 's'}`
    return SOURCE_LABELS[source]
  }).join(', ')
}

function renderGroup(group, context) {
  const lead = group.findings[0]
  const ruleId = typeof lead.ruleId === 'string' ? lead.ruleId : 'unknown'
  const title = RULE_TITLES[ruleId] ?? escapeText(ruleId, 80)
  const symbol = typeof group.affected?.symbol === 'string' ? ` in <code>${escapeText(group.affected.symbol, 120)}</code>` : ''
  const inferred = group.findings.every((finding) => finding.confidence === 'inferred') ? ' · inferred link' : ''
  const lines = [
    `- **${title}**${symbol} · evidence: ${evidenceSummary(group)}${inferred}`,
    `  Affected: ${locationLink(group.affected, context)} · Changed: ${group.changed.slice(0, 5).map((location) => locationLink(location, context)).join(', ')}`,
  ]
  for (const finding of group.findings.slice(0, MAX_ITEMS_PER_GROUP)) {
    const findingRule = typeof finding.ruleId === 'string' ? finding.ruleId : 'unknown'
    const where = finding.source === 'test-run' ? ` (${locationLink(finding.affected, context)})` : ''
    lines.push(`  - ${SOURCE_LABELS[finding.source] ?? 'unknown source'} <code>${escapeText(findingRule, 80)}</code>${where}: ${renderMessage(finding.message)}`)
    const callers = Array.isArray(finding.details?.callers) ? finding.details.callers : []
    if (callers.length > 1) {
      const shown = callers.slice(0, 5).map((caller) => `${locationLink(caller?.location, context)} (${caller?.affected ? 'affected' : 'not affected'})`)
      lines.push(`    Callers: ${shown.join(', ')}${callers.length > 5 ? `, and ${callers.length - 5} more` : ''}`)
    }
  }
  if (group.findings.length > MAX_ITEMS_PER_GROUP) lines.push(`  - …and ${group.findings.length - MAX_ITEMS_PER_GROUP} more pieces of evidence`)
  return lines.join('\n')
}

function renderEvidence(evidence) {
  const parts = []
  for (const run of Array.isArray(evidence?.typecheck) ? evidence.typecheck.slice(0, 4) : []) {
    const tool = run?.head?.tool === 'pyright' ? 'pyright' : 'tsc'
    const status = escapeText(run?.head?.status, 20)
    parts.push(run?.head?.status === 'ran'
      ? `type check (${tool}): ${Number(run.reported) || 0} new error(s) reported`
      : `type check (${tool}): ${status}${run?.head?.reason ? ` — ${escapeText(run.head.reason, 160)}` : ''}`)
  }
  const tests = evidence?.tests
  if (tests && typeof tests === 'object') {
    const n = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)
    const runner = ['pytest', 'vitest', 'jest'].includes(tests.runner) ? ` (${tests.runner})` : ''
    parts.push(tests.status === 'ran'
      ? `impacted tests${runner}: ${n(tests.selected)} of ${n(tests.totalTests)} selected, ${n(tests.passed) + n(tests.failed) + n(tests.errors) + n(tests.skipped)} ran, ${n(tests.failed)} failed`
      : `impacted tests${runner}: ${escapeText(tests.status, 20)}${tests.reason ? ` — ${escapeText(tests.reason, 160)}` : ''}`)
    const problems = Array.isArray(tests.environmentErrors) ? tests.environmentErrors.length : 0
    if (problems > 0) parts.push(`${problems} test module(s) could not be collected (see the job log)`)
  }
  return parts
}

/** Build the PR comment body from an untrusted report and trusted workflow context. */
/**
 * Low-severity findings are hidden unless `showLow` is set: on real pull requests they were mostly noise
 * (1 of 13 was a real issue in the benchmark spot-check). Their count is still reported.
 */
export function renderComment(report, context, options = {}) {
  const showLow = options.showLow === true
  const groups = readGroups(report)
  const visible = showLow ? groups : groups.filter((group) => group.severity !== 'low')
  const findingCount = visible.reduce((sum, group) => sum + group.findings.length, 0)
  const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, groups.filter((group) => group.severity === severity)]))
  const stats = report?.stats ?? {}
  const n = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)
  const range = context.baseSha && context.headSha ? ` · <code>${context.baseSha.slice(0, 7)}..${context.headSha.slice(0, 7)}</code>` : ''
  const merged = findingCount > visible.length ? ` (${findingCount} pieces of evidence merged by affected location)` : ''
  const lowCount = showLow ? `${bySeverity.low.length} low` : `${bySeverity.low.length} low hidden`
  const lines = [
    MARKER,
    '### CodeImpact review',
    '',
    `**${bySeverity.high.length} high · ${bySeverity.medium.length} medium · ${lowCount}**${merged} — ${n(stats.changedSymbols)} changed symbols, ${n(stats.impactedSymbols)} impacted, ${n(stats.recommendedTests)} tests recommended${range}`,
  ]
  const evidence = renderEvidence(report?.evidence)
  if (evidence.length > 0) lines.push('', `Evidence: ${evidence.join(' · ')}`)
  if (visible.length === 0) {
    lines.push('', groups.length === 0
      ? 'No findings. That does not mean the change is safe: static analysis can miss dynamic calls.'
      : 'No high- or medium-severity findings. That does not mean the change is safe: static analysis can miss dynamic calls.')
  }
  if (!showLow && bySeverity.low.length > 0) {
    lines.push('', `<sub>${bySeverity.low.length} low-severity finding${bySeverity.low.length === 1 ? ' is' : 's are'} hidden. Set <code>show-low-severity: true</code> on the comment action to include them.</sub>`)
  }

  const headings = { high: '🔴 High', medium: '🟠 Medium', low: '⚪ Low' }
  for (const severity of SEVERITIES) {
    const items = bySeverity[severity]
    if (items.length === 0 || (severity === 'low' && !showLow)) continue
    const body = items.slice(0, SHOWN[severity]).map((group) => renderGroup(group, context))
    if (items.length > SHOWN[severity]) body.push(`- …and ${items.length - SHOWN[severity]} more ${severity}-severity findings in the job summary artifact.`)
    if (severity === 'low') lines.push('', `<details><summary>${headings[severity]} (${items.length})</summary>`, '', ...body, '', '</details>')
    else lines.push('', `#### ${headings[severity]} (${items.length})`, '', ...body)
  }
  lines.push('', '<sub>CodeImpact traces callers of changed code across the repository. Type checks and tests ran in a separate read-only job; this comment was rendered without executing repository code.</sub>')

  let body = lines.join('\n')
  if (body.length > COMMENT_LIMIT) body = `${body.slice(0, COMMENT_LIMIT - 200)}\n\n…comment truncated; see the job summary for the rest.`
  return { body, high: bySeverity.high.length }
}

export function failureComment(context, reason) {
  return [
    MARKER,
    '### CodeImpact review',
    '',
    `⚠️ The analysis did not complete for <code>${(context.headSha ?? '').slice(0, 7)}</code>: ${escapeText(reason, 300)} See the workflow run for details.`,
  ].join('\n')
}

async function github(context, method, path, body) {
  const response = await fetch(`${context.apiUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${context.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'codeimpact-action',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    const error = new Error(`GitHub API ${method} ${path.replace(/\?.*$/, '')} returned ${response.status}`)
    error.status = response.status
    throw error
  }
  return response.status === 204 ? undefined : response.json()
}

/** Create the CodeImpact comment, or update the one this bot posted before. */
export async function upsertComment(context, body) {
  const base = `/repos/${context.repository}/issues`
  for (let page = 1; page <= 10; page += 1) {
    const comments = await github(context, 'GET', `${base}/${context.pullNumber}/comments?per_page=100&page=${page}`)
    const existing = comments.find((comment) => comment?.user?.type === 'Bot' && typeof comment.body === 'string' && comment.body.startsWith(MARKER))
    if (existing) {
      await github(context, 'PATCH', `${base}/comments/${existing.id}`, { body })
      return 'updated'
    }
    if (comments.length < 100) break
  }
  await github(context, 'POST', `${base}/${context.pullNumber}/comments`, { body })
  return 'created'
}

/** Workflow context from the runner and the event payload, which (unlike the artifact) is trusted. */
export function readContext(env = process.env) {
  const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const pull = event.pull_request ?? {}
  return {
    repository: env.GITHUB_REPOSITORY,
    serverUrl: env.GITHUB_SERVER_URL ?? 'https://github.com',
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    token: env.INPUT_GITHUB_TOKEN,
    pullNumber: Number.isInteger(pull.number) ? pull.number : undefined,
    headSha: safeSha(pull.head?.sha),
    baseSha: safeSha(pull.base?.sha),
    fromFork: Boolean(pull.head?.repo && pull.base?.repo && pull.head.repo.full_name !== pull.base.repo.full_name),
  }
}

async function main() {
  const env = process.env
  const context = readContext(env)
  const reportPath = env.INPUT_REPORT_PATH
  let rendered
  if (reportPath && existsSync(reportPath)) {
    let report
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'))
    } catch {
      report = undefined
    }
    if (report && (report.schemaVersion === 1 || report.schemaVersion === 2)) {
      // The analysis ran on the merge base; prefer it for base-side links when it is a well-formed SHA.
      context.baseSha = safeSha(report.target?.baseSha) ?? context.baseSha
      rendered = renderComment(report, context, { showLow: env.INPUT_SHOW_LOW_SEVERITY === 'true' })
    } else {
      rendered = { body: failureComment(context, 'the report artifact was missing or malformed.'), high: 0 }
    }
  } else {
    rendered = { body: failureComment(context, 'no report was produced by the analyze job.'), high: 0 }
  }

  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${rendered.body.replace(MARKER, '')}\n`)
  if (env.INPUT_DRY_RUN === 'true') {
    console.log(rendered.body)
  } else if (!context.pullNumber || !context.repository) {
    console.log('::notice::Not a pull_request event; results were written to the job summary only.')
  } else if (context.fromFork) {
    console.log('::notice::Pull request comes from a fork, where the token cannot comment. Results were written to the job summary.')
  } else {
    try {
      console.log(`CodeImpact comment ${await upsertComment(context, rendered.body)}.`)
    } catch (error) {
      if (error.status === 403 || error.status === 404) console.log(`::warning::Could not comment on the pull request (${error.message}). Results were written to the job summary.`)
      else throw error
    }
  }
  if (env.INPUT_FAIL_ON_HIGH === 'true' && rendered.high > 0) {
    console.log(`::error::CodeImpact found ${rendered.high} high-severity finding(s).`)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.log(`::error::${error.message}`)
    process.exitCode = 1
  })
}
