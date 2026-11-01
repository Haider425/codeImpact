import { analyzeRepository } from '../src/analysis/engine'
import type { ReviewFinding } from '../src/analysis/types'
import { loadConfig } from './config'
import { AnalysisError } from './errors'
import { loadRepositoryRevisions } from './git'
import { GitHubClient, parsePullRequestRef } from './github'

/** `npm run review -- owner/repo#123 [--json]` — review one pull request from the terminal. */
const args = process.argv.slice(2)
const ref = parsePullRequestRef(args.find((arg) => !arg.startsWith('--')) ?? '')
if (!ref) {
  console.error('Usage: npm run review -- <owner/repo#number | github.com pull-request URL> [--json]')
  process.exit(2)
}

const config = loadConfig()
const github = new GitHubClient(config.githubToken)

try {
  const pull = await github.pullRequest(ref.owner, ref.repo, ref.number)
  const base = await github.mergeBase(ref.owner, ref.repo, pull.baseSha, pull.headSha)
  const cwd = await github.fetchCommits(config.dataDir, ref.owner, ref.repo, ref.number, [base, pull.headSha])
  const loaded = await loadRepositoryRevisions(cwd, {
    owner: ref.owner,
    name: ref.repo,
    pullRequest: { number: pull.number, title: pull.title, author: pull.author, baseRef: pull.baseRef, headRef: pull.headRef },
  }, base, pull.headSha)
  const result = await analyzeRepository(loaded.repository, { wasmBasePath: config.wasmBasePath, maxDepth: config.maxDepth, limitations: loaded.limitations })

  if (args.includes('--json')) {
    console.log(JSON.stringify({ pullRequest: pull, review: result.review, stats: result.stats }, null, 2))
  } else {
    const where = (location: ReviewFinding['changed']) => `${location.path}:${location.line}${location.revision === 'base' ? ' (base)' : ''}`
    console.log(`${ref.owner}/${ref.repo}#${pull.number}  ${pull.title}`)
    console.log(`${base.slice(0, 7)}..${pull.headSha.slice(0, 7)} · ${result.stats.changedSymbols} changed symbols · ${result.stats.impactedSymbols} impacted · ${result.stats.recommendedTests} tests recommended · ${result.stats.durationMs} ms\n`)
    if (result.review.length === 0) console.log('No contract findings. That does not mean the change is safe; see the impact report.')
    for (const finding of result.review) {
      console.log(`[${finding.severity.toUpperCase()}] ${finding.ruleId} (${finding.source}, ${finding.confidence})`)
      console.log(`  ${finding.message.replaceAll('`', '')}`)
      console.log(`  changed:  ${where(finding.changed)}`)
      console.log(`  affected: ${where(finding.affected)}\n`)
    }
  }
} catch (error) {
  console.error(error instanceof AnalysisError ? `${error.code}: ${error.message}` : error)
  process.exit(1)
}
