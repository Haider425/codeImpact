import { spawn } from 'node:child_process'
import type { DemoRepository, Language, Revision, SourceFile } from '../src/analysis/types'
import { AnalysisError } from './errors'

export interface IngestLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxChangedFiles: number
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxFiles: 5000,
  maxFileBytes: 512_000,
  maxTotalBytes: 60_000_000,
  // GitHub's pull-request files endpoint caps at 3,000 files; treat anything larger as unsupported.
  maxChangedFiles: 3000,
}

const EXCLUDED_DIRECTORIES = /(^|\/)(node_modules|dist|build|out|coverage|\.git|\.venv|venv|env|__pycache__|site-packages|vendor|third_party|\.next|\.tox|\.nox|\.mypy_cache|\.pytest_cache|migrations)\//
const GENERATED_FILES = /(\.min\.[jt]s$|\.d\.ts$|_pb2(_grpc)?\.pyi?$|\.generated\.tsx?$|\.gen\.tsx?$)/

export function languageFor(path: string): Language | undefined {
  if (EXCLUDED_DIRECTORIES.test(path) || GENERATED_FILES.test(path)) return undefined
  if (path.endsWith('.py')) return 'python'
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript'
  return undefined
}

export function git(cwd: string, args: string[], input?: Buffer | string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(err).toString('utf8').trim().slice(0, 400)}`))
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

export async function resolveCommit(cwd: string, ref: string) {
  try {
    return (await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])).toString('utf8').trim()
  } catch {
    throw new AnalysisError('commit_not_found', `Commit ${ref} is not available in the repository.`, false)
  }
}

export async function mergeBase(cwd: string, base: string, head: string) {
  return (await git(cwd, ['merge-base', base, head])).toString('utf8').trim()
}

export interface SkippedFile { path: string; reason: string }

interface TreeEntry { object: string; size: number; path: string; language: Language }

async function listTree(cwd: string, sha: string) {
  const output = (await git(cwd, ['ls-tree', '-r', '-l', '-z', sha])).toString('utf8')
  const entries: TreeEntry[] = []
  const skipped: SkippedFile[] = []
  for (const record of output.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    const [, type, object, size] = record.slice(0, tab).split(/\s+/)
    const path = record.slice(tab + 1)
    if (type !== 'blob') continue
    const language = languageFor(path)
    if (!language) continue
    entries.push({ object, size: Number(size), path, language })
  }
  return { entries, skipped }
}

/** Read many blobs with one `git cat-file --batch` process instead of one `git show` per file. */
async function readBlobs(cwd: string, objects: string[]) {
  const contents = new Map<string, string>()
  if (objects.length === 0) return contents
  const output = await git(cwd, ['cat-file', '--batch'], `${objects.join('\n')}\n`)
  let offset = 0
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset)
    const header = output.subarray(offset, newline).toString('utf8')
    const [object, type, size] = header.split(' ')
    if (type === 'missing') {
      offset = newline + 1
      continue
    }
    const length = Number(size)
    const start = newline + 1
    contents.set(object, output.subarray(start, start + length).toString('utf8'))
    offset = start + length + 1
  }
  return contents
}

export async function loadRevision(cwd: string, sha: string, limits: IngestLimits = DEFAULT_LIMITS) {
  const { entries, skipped } = await listTree(cwd, sha)
  const accepted = entries.filter((entry) => {
    if (entry.size > limits.maxFileBytes) {
      skipped.push({ path: entry.path, reason: `larger than ${Math.round(limits.maxFileBytes / 1000)} kB` })
      return false
    }
    return true
  })
  if (accepted.length > limits.maxFiles) {
    throw new AnalysisError(
      'repository_too_large',
      `This revision has ${accepted.length} supported source files; the analysis limit is ${limits.maxFiles}.`,
      false,
    )
  }
  const totalBytes = accepted.reduce((sum, entry) => sum + entry.size, 0)
  if (totalBytes > limits.maxTotalBytes) {
    throw new AnalysisError(
      'repository_too_large',
      `Supported source totals ${(totalBytes / 1e6).toFixed(1)} MB; the analysis limit is ${(limits.maxTotalBytes / 1e6).toFixed(0)} MB.`,
      false,
    )
  }
  const blobs = await readBlobs(cwd, [...new Set(accepted.map((entry) => entry.object))])
  const files: SourceFile[] = accepted
    .filter((entry) => {
      const source = blobs.get(entry.object)
      if (source === undefined) skipped.push({ path: entry.path, reason: 'blob missing from local object store' })
      else if (source.includes('\0')) skipped.push({ path: entry.path, reason: 'binary content' })
      else return true
      return false
    })
    .map((entry) => ({ path: entry.path, language: entry.language, source: blobs.get(entry.object)! }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const revision: Revision = { sha, files }
  return { revision, skipped }
}

export interface ChangedFile { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; previousPath?: string }

export async function changedFiles(cwd: string, base: string, head: string): Promise<ChangedFile[]> {
  const output = (await git(cwd, ['diff', '--name-status', '-z', '-M', base, head])).toString('utf8').split('\0')
  const files: ChangedFile[] = []
  for (let index = 0; index < output.length; index += 1) {
    const code = output[index]
    if (!code) continue
    if (code.startsWith('R')) {
      files.push({ status: 'renamed', previousPath: output[index + 1], path: output[index + 2] })
      index += 2
    } else {
      const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
      files.push({ status, path: output[index + 1] })
      index += 1
    }
  }
  return files
}

export interface LoadedRepository {
  repository: DemoRepository
  changed: ChangedFile[]
  limitations: string[]
}

export async function loadRepositoryRevisions(
  cwd: string,
  meta: Omit<DemoRepository, 'base' | 'head'>,
  baseSha: string,
  headSha: string,
  limits: IngestLimits = DEFAULT_LIMITS,
): Promise<LoadedRepository> {
  const changed = await changedFiles(cwd, baseSha, headSha)
  if (changed.length > limits.maxChangedFiles) {
    throw new AnalysisError('pull_request_too_large', `The change touches ${changed.length} files; the limit is ${limits.maxChangedFiles}.`, false)
  }
  const [base, head] = await Promise.all([loadRevision(cwd, baseSha, limits), loadRevision(cwd, headSha, limits)])
  const limitations: string[] = []
  const skipped = [...new Map([...base.skipped, ...head.skipped].map((item) => [item.path, item])).values()]
  if (skipped.length > 0) {
    const sample = skipped.slice(0, 3).map((item) => `${item.path} (${item.reason})`).join(', ')
    limitations.push(`${skipped.length} source file${skipped.length === 1 ? ' was' : 's were'} skipped: ${sample}${skipped.length > 3 ? ', …' : ''}.`)
  }
  const unsupported = changed.filter((file) => !languageFor(file.path))
  if (unsupported.length > 0) {
    limitations.push(`${unsupported.length} changed file${unsupported.length === 1 ? ' is' : 's are'} outside the supported Python/TypeScript scope and ${unsupported.length === 1 ? 'was' : 'were'} not analyzed.`)
  }
  return { repository: { ...meta, base: base.revision, head: head.revision }, changed, limitations }
}
