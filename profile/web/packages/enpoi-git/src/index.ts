/**
 * enpoi-git — repository awareness for the right-sidebar Git tab.
 *
 * Typert Remote service (`enpoiGit` namespace) exposing the working tree the
 * Git tab reads: status counts, branch list, recent commits, changed-file
 * list, and bounded unified diffs. Every method guards a cwd that is not a
 * repository (or cannot be read) by answering the empty value — a missing
 * repository is a UI state, never a 500 (the old sidebar's fixed bug).
 *
 * Commands run through `execFile` with explicit argv (never a shell) and a
 * hard timeout / buffer bound; pathspecs always follow `--`, so a file name
 * can never be read as an option. The diff is bounded to ~200 KB.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const name = 'enpoi-git'

/** Optional-only diagnostics: nothing else in the host plugin is injected. */
export const inject: string[] = []

/** Unified-diff response bound (truncated flag reports the cut). */
const DIFF_MAX_BYTES = 200 * 1024
/** git invocation bound: a hung repository must not pin the remote. */
const GIT_TIMEOUT_MS = 10_000
/** Raw stdout bound before parsing (log output is small; diffs are cut after). */
const GIT_MAX_BUFFER = 8 * 1024 * 1024
/** Default and maximum commit rows. */
const LOG_DEFAULT_LIMIT = 20
const LOG_MAX_LIMIT = 100

/** File diagnostics — the Cordis logger only buffers (no console sink). */
function diag(line: string): void {
  try {
    const home = process.env.DSH_HOME ?? process.env.HOME ?? '/tmp'
    const dir = join(home.endsWith('.dsh') ? home : join(home, '.dsh'), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'enpoi-git.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // diagnostics must never break the remote
  }
}

/** One git command outcome; failures answer `ok: false` instead of throwing. */
interface GitRun {
  ok: boolean
  stdout: string
}

/**
 * Run one git command in `cwd` without a shell.
 * @param cwd - repository working directory (validated by the caller).
 * @param args - exact argv after `git`.
 * @returns stdout on success; `ok: false` for any failure (exit code, timeout, missing git).
 */
async function runGit(cwd: string, args: readonly string[]): Promise<GitRun> {
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile('git', [...args], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      }, (error, stdout, stderr) => {
        // The callback separates the error from its output; carry stdout on the
        // failure so `--no-index`'s exit code 1 still yields the diff.
        if (error !== null) reject(Object.assign(error, { stdout, stderr }))
        else resolve({ stdout, stderr })
      })
    })
    return { ok: true, stdout }
  } catch (error) {
    // Differences are a successful answer for `--no-index`; keep its stdout.
    const failure = error as { code?: number | string; stdout?: string }
    if (failure.stdout !== undefined && failure.stdout !== '') {
      return { ok: true, stdout: failure.stdout }
    }
    return { ok: false, stdout: '' }
  }
}

/**
 * Whether one path can serve as a repository cwd.
 * @param cwd - candidate working directory from the client.
 * @returns true for a non-empty absolute path.
 */
function validCwd(cwd: unknown): cwd is string {
  return typeof cwd === 'string' && cwd !== '' && isAbsolute(cwd)
}

/** Status counts and branch facts for one repository. */
export interface GitStatusValue {
  repo: boolean
  branch: string
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
}

/** One working-tree change row. */
export interface GitChange {
  path: string
  /** Two-character porcelain code (`M `, ` M`, `??`, `R `, ...). */
  code: string
  staged: boolean
  untracked: boolean
}

/** One commit row. */
export interface GitLogEntry {
  sha: string
  subject: string
  author: string
  date: string
}

/** Branch list; current first. */
export interface GitBranchesValue {
  current: string
  names: string[]
}

/** Bounded unified diff. */
export interface GitDiffValue {
  text: string
  truncated: boolean
}

/** Empty status for a non-repository (or unreadable) cwd. */
function emptyStatus(): GitStatusValue {
  return { repo: false, branch: '', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 }
}

/**
 * Parse one `git status --porcelain=v1 -z` stream into change rows.
 * Rename/copy records carry a second NUL field (the origin path), which is
 * consumed without emitting a row of its own.
 * @param stdout - raw porcelain stream.
 * @returns one row per changed path.
 */
function parseChanges(stdout: string): GitChange[] {
  const fields = stdout.split('\0')
  const rows: GitChange[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? ''
    if (field.length < 3) continue
    const code = field.slice(0, 2)
    const path = field.slice(3)
    if (path === '') continue
    rows.push({
      path,
      code,
      staged: code[0] !== ' ' && code[0] !== '?',
      untracked: code === '??',
    })
    if (code[0] === 'R' || code[0] === 'C') index += 1
  }
  return rows
}

/** Head branch name, or the abbreviated detached sha. */
async function currentBranch(cwd: string): Promise<string> {
  const symbolic = await runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (symbolic.ok && symbolic.stdout.trim() !== '') return symbolic.stdout.trim()
  const sha = await runGit(cwd, ['rev-parse', '--short', 'HEAD'])
  return sha.ok ? sha.stdout.trim() : ''
}

/** Ahead/behind relative to the upstream; 0/0 when no upstream is configured. */
async function aheadBehind(cwd: string): Promise<{ ahead: number; behind: number }> {
  const counts = await runGit(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
  if (!counts.ok) return { ahead: 0, behind: 0 }
  const [behind, ahead] = counts.stdout.trim().split(/\s+/)
  return { ahead: Number(ahead ?? 0) || 0, behind: Number(behind ?? 0) || 0 }
}

/**
 * The Git remote namespace owner: `enpoiGit.status`, `.branches`, `.log`,
 * `.changes`, and `.diff` over the shared Typert Gateway.
 */
class EnpoiGitService extends TypertRemoteService {
  /**
   * @param ctx - owning Host Context (Typert binding is installed by the base).
   */
  constructor(ctx: Context) {
    super(ctx, 'enpoiGit')
  }

  /**
   * Working-tree counts plus branch/upstream position.
   * @param cwd - repository working directory.
   * @returns the status value; `repo: false` when `cwd` is not a repository.
   */
  @Remote
  async status(cwd: string): Promise<GitStatusValue> {
    if (!validCwd(cwd)) return emptyStatus()
    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok || inside.stdout.trim() !== 'true') return emptyStatus()
    const listed = await runGit(cwd, ['status', '--porcelain=v1', '-z', '-uall'])
    if (!listed.ok) return { ...emptyStatus(), repo: true, branch: await currentBranch(cwd) }
    const changes = parseChanges(listed.stdout)
    const position = await aheadBehind(cwd)
    return {
      repo: true,
      branch: await currentBranch(cwd),
      ahead: position.ahead,
      behind: position.behind,
      staged: changes.filter(change => change.staged).length,
      unstaged: changes.filter(change => !change.untracked && change.code[1] !== ' ').length,
      untracked: changes.filter(change => change.untracked).length,
    }
  }

  /**
   * Local head branches, current first then by name.
   * @param cwd - repository working directory.
   * @returns the branch list; empty current/names outside a repository.
   */
  @Remote
  async branches(cwd: string): Promise<GitBranchesValue> {
    if (!validCwd(cwd)) return { current: '', names: [] }
    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok || inside.stdout.trim() !== 'true') return { current: '', names: [] }
    const current = await currentBranch(cwd)
    const refs = await runGit(cwd, ['for-each-ref', 'refs/heads', '--format=%(refname:short)'])
    if (!refs.ok) return { current, names: current === '' ? [] : [current] }
    const names = refs.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    names.sort((left, right) => left.localeCompare(right))
    const ordered = current !== '' ? [current, ...names.filter(name => name !== current)] : names
    return { current, names: ordered }
  }

  /**
   * Recent commits, newest first.
   * @param cwd - repository working directory.
   * @param limit - requested row count (default 20, capped at 100).
   * @returns the commit rows; empty outside a repository.
   */
  @Remote
  async log(cwd: string, limit: number): Promise<{ entries: GitLogEntry[] }> {
    if (!validCwd(cwd)) return { entries: [] }
    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok || inside.stdout.trim() !== 'true') return { entries: [] }
    const requested = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : LOG_DEFAULT_LIMIT
    const bounded = Math.min(Math.max(requested, 1), LOG_MAX_LIMIT)
    const log = await runGit(cwd, [
      'log', `-n${bounded}`, '--no-color', '--pretty=format:%H%x1f%s%x1f%an%x1f%aI%x1e',
    ])
    if (!log.ok) return { entries: [] }
    const entries: GitLogEntry[] = []
    for (const record of log.stdout.split('\x1e')) {
      const trimmed = record.replace(/^\n/, '')
      if (trimmed === '') continue
      const [sha = '', subject = '', author = '', date = ''] = trimmed.split('\x1f')
      if (sha === '') continue
      entries.push({ sha, subject, author, date })
    }
    return { entries }
  }

  /**
   * Changed files in the working tree (staged, unstaged, and untracked).
   * @param cwd - repository working directory.
   * @returns one row per changed path; empty outside a repository.
   */
  @Remote
  async changes(cwd: string): Promise<{ files: GitChange[] }> {
    if (!validCwd(cwd)) return { files: [] }
    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok || inside.stdout.trim() !== 'true') return { files: [] }
    const listed = await runGit(cwd, ['status', '--porcelain=v1', '-z', '-uall'])
    if (!listed.ok) return { files: [] }
    return { files: parseChanges(listed.stdout) }
  }

  /**
   * Unified diff for the working tree, or for one path when given.
   * Tracked paths diff against HEAD (staged + unstaged); an untracked path
   * diffs against the empty file so new content is still readable.
   * @param cwd - repository working directory.
   * @param path - optional repository-relative path.
   * @returns the bounded diff text; empty outside a repository.
   */
  @Remote
  async diff(cwd: string, path: string): Promise<GitDiffValue> {
    if (!validCwd(cwd)) return { text: '', truncated: false }
    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok || inside.stdout.trim() !== 'true') return { text: '', truncated: false }
    const target = typeof path === 'string' && path !== '' ? path : undefined
    let result: GitRun
    if (target === undefined) {
      result = await runGit(cwd, ['diff', 'HEAD', '--no-color', '--'])
    } else {
      result = await runGit(cwd, ['diff', 'HEAD', '--no-color', '--', target])
      if (result.ok && result.stdout.trim() === '') {
        // Untracked (or extension-less) path: show it against the empty file.
        result = await runGit(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', target])
      }
    }
    if (!result.ok) return { text: '', truncated: false }
    const bytes = Buffer.from(result.stdout, 'utf8')
    if (bytes.byteLength <= DIFF_MAX_BYTES) return { text: result.stdout, truncated: false }
    return { text: bytes.subarray(0, DIFF_MAX_BYTES).toString('utf8'), truncated: true }
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(EnpoiGitService)
  diag('enpoiGit remote mounted (enpoiGit.status/branches/log/changes/diff)')
}
