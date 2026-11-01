import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { git } from '../git'

/**
 * Environment variables a child process may inherit. Everything else — GITHUB_TOKEN, ACTIONS_*,
 * cloud credentials, npm tokens — is dropped by construction rather than by a deny list.
 */
const ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'ProgramData',
  'LANG', 'LC_ALL', 'TZ', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'PYTHONHOME', 'PYTHONPATH',
]

export function sanitizedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key]
  return { ...env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', PYTHONDONTWRITEBYTECODE: '1', ...extra }
}

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  /** Set when the executable could not be started at all (not installed, not on PATH). */
  spawnError?: string
}

function killTree(pid: number) {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already exited.
    }
  }
}

const OUTPUT_LIMIT = 4_000_000

/** Run a command with a hard time limit and a scrubbed environment. Never throws for non-zero exits. */
export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; /** Only for fixed arguments: needed to start `.cmd` shims on Windows. */ shell?: boolean },
): Promise<CommandResult> {
  const started = performance.now()
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? sanitizedEnv(),
      windowsHide: true,
      shell: options.shell ?? false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, options.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr, timedOut: false, durationMs: Math.round(performance.now() - started), spawnError: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut, durationMs: Math.round(performance.now() - started) })
    })
  })
}

export interface Workspace {
  dir: string
  cleanup: () => void
}

/**
 * Write the tree of `sha` into a fresh temporary directory. A throwaway index is used, so the source
 * repository's index and working tree are never touched. Works for bare caches and normal checkouts.
 */
export async function materialize(repoDir: string, sha: string, label: string): Promise<Workspace> {
  const dir = mkdtempSync(join(tmpdir(), `codeimpact-${label}-`))
  const index = join(dir, '.codeimpact-index')
  const gitDir = (await git(repoDir, ['rev-parse', '--absolute-git-dir'])).toString('utf8').trim()
  const env = { ...process.env, GIT_INDEX_FILE: index }
  await git(repoDir, ['--git-dir', gitDir, '--work-tree', dir, 'read-tree', sha], undefined, env)
  await git(repoDir, ['--git-dir', gitDir, '--work-tree', dir, '-c', 'core.autocrlf=false', 'checkout-index', '--all', '--force'], undefined, env)
  rmSync(index, { force: true })

  // Reuse dependencies the caller already installed (type definitions, test frameworks) without copying them.
  // Absolute target: a relative one would resolve against the link's own location and point at itself.
  const modules = resolve(repoDir, 'node_modules')
  if (existsSync(modules) && !existsSync(join(dir, 'node_modules'))) {
    symlinkSync(modules, join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  return {
    dir,
    cleanup: () => {
      // Remove the link itself first so deleting the copy can never descend into the real node_modules.
      const link = join(dir, 'node_modules')
      try {
        if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
      } catch {
        // No link was created.
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
