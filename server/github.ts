import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AnalysisError } from './errors'
import { git } from './git'

export interface PullRequestRef { owner: string; repo: string; number: number }

const NAME = /^[A-Za-z0-9_.-]+$/

/** Accepts `owner/repo#123`, `owner/repo/pull/123`, or a github.com pull-request URL. */
export function parsePullRequestRef(input: string): PullRequestRef | undefined {
  const value = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\?.*$/, '')
  const match = value.match(/^([^/\s#]+)\/([^/\s#]+)(?:#|\/pulls?\/)(\d+)(?:[/#].*)?$/)
  if (!match || !NAME.test(match[1]) || !NAME.test(match[2])) return undefined
  const number = Number(match[3])
  return Number.isSafeInteger(number) && number > 0 ? { owner: match[1], repo: match[2], number } : undefined
}

export interface PullRequestInfo {
  number: number
  title: string
  author: string
  state: string
  baseRef: string
  baseSha: string
  headRef: string
  headSha: string
  changedFiles: number
  url: string
  updatedAt: string
}

export interface RepositoryInfo { id: number; owner: string; name: string; defaultBranch: string; private: boolean; sizeKb: number }

interface GitHubPull {
  number: number
  title: string
  state: string
  html_url: string
  updated_at: string
  changed_files?: number
  user: { login: string } | null
  base: { ref: string; sha: string }
  head: { ref: string; sha: string }
}

function toPullRequest(pull: GitHubPull): PullRequestInfo {
  return {
    number: pull.number,
    title: pull.title,
    author: pull.user?.login ?? 'unknown',
    state: pull.state,
    baseRef: pull.base.ref,
    baseSha: pull.base.sha,
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    changedFiles: pull.changed_files ?? 0,
    url: pull.html_url,
    updatedAt: pull.updated_at,
  }
}

export class GitHubClient {
  private readonly token?: string
  private readonly fetchImpl: typeof fetch

  constructor(token?: string, fetchImpl: typeof fetch = fetch) {
    this.token = token
    this.fetchImpl = fetchImpl
  }

  private async request<T>(path: string): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`https://api.github.com${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'CodeImpact',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      throw new AnalysisError('github_unreachable', 'GitHub could not be reached.', true)
    }
    if (response.ok) return response.json() as Promise<T>
    if (response.status === 404) {
      throw new AnalysisError('not_found', 'The repository or pull request does not exist or is not accessible with the configured credentials.', false)
    }
    if (response.status === 401) throw new AnalysisError('github_unauthorized', 'The configured GitHub token was rejected.', false)
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      const when = reset ? ` Resets at ${new Date(reset * 1000).toISOString()}.` : ''
      throw new AnalysisError('github_rate_limited', `GitHub API rate limit reached.${when}${this.token ? '' : ' Set GITHUB_TOKEN to raise the limit.'}`, true)
    }
    throw new AnalysisError('github_error', `GitHub returned HTTP ${response.status}.`, response.status >= 500)
  }

  async repository(owner: string, repo: string): Promise<RepositoryInfo> {
    const data = await this.request<{ id: number; name: string; owner: { login: string }; default_branch: string; private: boolean; size: number }>(`/repos/${owner}/${repo}`)
    return { id: data.id, owner: data.owner.login, name: data.name, defaultBranch: data.default_branch, private: data.private, sizeKb: data.size }
  }

  async pullRequest(owner: string, repo: string, number: number) {
    return toPullRequest(await this.request<GitHubPull>(`/repos/${owner}/${repo}/pulls/${number}`))
  }

  async pullRequests(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open') {
    const pulls = await this.request<GitHubPull[]>(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=30&sort=updated&direction=desc`)
    return pulls.map(toPullRequest)
  }

  /** The commit GitHub's "Files changed" tab diffs against (three-dot comparison). */
  async mergeBase(owner: string, repo: string, base: string, head: string) {
    const data = await this.request<{ merge_base_commit: { sha: string } }>(`/repos/${owner}/${repo}/compare/${base}...${head}?per_page=1`)
    return data.merge_base_commit.sha
  }

  /**
   * Fetch exactly the two commits we need, shallowly, into a per-repository bare cache.
   * No working tree is checked out and nothing from the repository is executed.
   */
  async fetchCommits(cacheRoot: string, owner: string, repo: string, pullNumber: number, shas: string[]) {
    const directory = join(cacheRoot, 'repos', `${owner}__${repo}.git`)
    if (!existsSync(join(directory, 'HEAD'))) {
      mkdirSync(directory, { recursive: true })
      await git(directory, ['init', '--bare', '--quiet'])
    }
    const missing: string[] = []
    for (const sha of shas) {
      try {
        await git(directory, ['cat-file', '-e', `${sha}^{commit}`])
      } catch {
        missing.push(sha)
      }
    }
    if (missing.length === 0) return directory

    const auth = this.token
      ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`]
      : []
    const url = `https://github.com/${owner}/${repo}.git`
    try {
      await git(directory, [...auth, 'fetch', '--quiet', '--no-tags', '--depth=1', url, ...missing, `+refs/pull/${pullNumber}/head:refs/pull/${pullNumber}`])
    } catch (error) {
      // Never surface the raw git error: it can echo the remote URL and headers.
      console.error(JSON.stringify({ level: 'error', msg: 'git fetch failed', owner, repo, error: String(error).replace(/Authorization: Basic \S+/g, 'Authorization: [redacted]') }))
      throw new AnalysisError('fetch_failed', 'The pull-request commits could not be fetched from GitHub.', true)
    }
    return directory
  }
}
