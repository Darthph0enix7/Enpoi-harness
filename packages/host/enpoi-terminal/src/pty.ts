/**
 * enpoi: fork-only PTY table for the browser terminal surfaces. One node-pty
 * process per `${sessionId}:${tabId}` key; processes survive socket
 * disconnects (panel switches, rail navigation, a reload within the grace
 * window) and reconnect to the same process by key. Every process is killed
 * on explicit close, on the disconnect grace expiring, or when the plugin
 * unloads, so no shell outlives its tab.
 */
import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import type { IPty } from 'node-pty'
import type { WebSocket } from 'ws'
import type { TerminalClientFrame, TerminalServerFrame } from './shared.ts'

/** Bounded replay transcript kept per terminal (bytes; the head is dropped). */
const TRANSCRIPT_LIMIT = 512 * 1024

/** Concurrent terminals allowed per conversation by default. */
export const DEFAULT_MAX_PER_SESSION = 8

/** How long a process outlives its last socket before it is killed. */
export const DEFAULT_DISCONNECT_GRACE_MS = 90_000

/** Machine-routable host failure; the API route maps `status` onto the response. */
export class TerminalHostError extends Error {
  /**
   * @param code - stable code the browser can branch on.
   * @param message - human-readable detail.
   * @param status - HTTP status for an API route refusal.
   */
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'TerminalHostError'
  }
}

/**
 * Restore the executable bit pnpm strips from node-pty's prebuilt spawn-helper
 * (without it every spawn fails). Idempotent; a resolution or chmod failure
 * stays silent because the terminal surfaces its own spawn error.
 */
export function ensureSpawnHelper(): void {
  if (process.platform === 'win32') return
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('node-pty')
    const packageRoot = dirname(dirname(entry))
    const candidates = [
      join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(packageRoot, 'build', 'Release', 'spawn-helper'),
    ]
    for (const helper of candidates) {
      if (existsSync(helper)) chmodSync(helper, 0o755)
    }
  } catch {
    // Resolution or chmod failure: the terminal surfaces its own spawn error.
  }
}

/** node-pty loaded lazily so a broken install degrades one terminal, not the plugin. */
type NodePtyModule = typeof import('node-pty')

let nodePtyModule: NodePtyModule | undefined

/**
 * Resolve node-pty once per process.
 * @returns the module, or `undefined` when the install is broken.
 */
function loadNodePty(): NodePtyModule | undefined {
  if (nodePtyModule !== undefined) return nodePtyModule
  try {
    const require = createRequire(import.meta.url)
    nodePtyModule = require('node-pty') as NodePtyModule
    return nodePtyModule
  } catch {
    return undefined
  }
}

/** One live or recently exited terminal process. */
interface TerminalEntry {
  readonly key: string
  readonly sessionId: string
  readonly cwd: string
  readonly shell: string
  readonly pty: IPty
  /** Output accumulated since spawn (bounded; the head is dropped). */
  transcript: string
  dropped: boolean
  exited: boolean
  exitCode: number | null
  exitSignal: number | null
  /** Attached sockets; the process lives while at least one is open. */
  readonly sockets: Set<WebSocket>
  /** Pending disconnect-grace kill, if any. */
  closeTimer: ReturnType<typeof setTimeout> | undefined
  /** Pending removal of an exited entry nobody reconnected to. */
  reapTimer: ReturnType<typeof setTimeout> | undefined
}

/** Registry construction inputs. */
export interface TerminalRegistryOptions {
  /** Login shell; defaults to `$SHELL` then `/bin/bash` (`powershell.exe` on Windows). */
  readonly shell?: string
  /** Concurrent processes per conversation. */
  readonly maxPerSession?: number
  /** How long a process outlives its last attached socket. */
  readonly graceMs?: number
}

/** Input for one open/reuse. */
export interface TerminalOpenInput {
  readonly key: string
  readonly sessionId: string
  readonly cwd?: string
  readonly cols?: number
  readonly rows?: number
}

/** One open's outcome. */
export interface TerminalOpenResult {
  readonly key: string
  readonly pid: number
  readonly cwd: string
  readonly shell: string
  /** False when a live process already backed the key. */
  readonly spawned: boolean
}

/** Default shell for the running platform. */
function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'powershell.exe'
  return process.env.SHELL ?? '/bin/bash'
}

/** Clamp the client's grid into a range a PTY accepts. */
function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** The terminal process table. */
export class TerminalRegistry {
  private readonly entries = new Map<string, TerminalEntry>()
  private readonly shell: string
  private readonly maxPerSession: number
  private readonly graceMs: number
  private disposed = false

  /** @param options - shell, per-conversation cap, and disconnect grace. */
  constructor(options: TerminalRegistryOptions = {}) {
    this.shell = options.shell ?? defaultShell()
    this.maxPerSession = options.maxPerSession ?? DEFAULT_MAX_PER_SESSION
    this.graceMs = options.graceMs ?? DEFAULT_DISCONNECT_GRACE_MS
  }

  /**
   * Open or reuse the terminal behind one key.
   * @param input - key, conversation, working directory, and grid.
   * @returns the live process facts.
   * @throws {TerminalHostError} when the session cap is reached or the spawn fails.
   */
  open(input: TerminalOpenInput): TerminalOpenResult {
    if (this.disposed) throw new TerminalHostError('disposed', 'the terminal host is shutting down', 503)
    const existing = this.entries.get(input.key)
    if (existing !== undefined && !existing.exited) {
      this.cancelTimers(existing)
      this.touch(existing, input)
      return { key: existing.key, pid: existing.pty.pid, cwd: existing.cwd, shell: existing.shell, spawned: false }
    }
    if (existing !== undefined) this.discard(existing)
    const sessionCount = [...this.entries.values()].filter(entry => entry.sessionId === input.sessionId).length
    if (sessionCount >= this.maxPerSession) {
      throw new TerminalHostError('session-limit', `at most ${this.maxPerSession} terminals may run in one session`, 429)
    }
    const nodePty = loadNodePty()
    if (nodePty === undefined) {
      throw new TerminalHostError('pty-unavailable', 'the node-pty native module is not installed', 503)
    }
    const cwd = this.resolveCwd(input.cwd)
    const cols = clamp(input.cols, 2, 500, 80)
    const rows = clamp(input.rows, 1, 300, 24)
    let pty: IPty
    try {
      pty = nodePty.spawn(this.shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
      })
    } catch (error) {
      throw new TerminalHostError('spawn-failed', error instanceof Error ? error.message : String(error), 500)
    }
    const entry: TerminalEntry = {
      key: input.key,
      sessionId: input.sessionId,
      cwd,
      shell: this.shell,
      pty,
      transcript: '',
      dropped: false,
      exited: false,
      exitCode: null,
      exitSignal: null,
      sockets: new Set(),
      closeTimer: undefined,
      reapTimer: undefined,
    }
    entry.pty.onData((data: string) => { this.append(entry, data) })
    entry.pty.onExit(({ exitCode, signal }) => { this.finish(entry, exitCode, signal ?? null) })
    this.entries.set(input.key, entry)
    return { key: entry.key, pid: entry.pty.pid, cwd: entry.cwd, shell: entry.shell, spawned: true }
  }

  /**
   * Attach one socket: cancel any pending grace kill and replay the transcript.
   * @param key - terminal key.
   * @param socket - accepted socket.
   * @returns false when no entry backs the key.
   */
  attach(key: string, socket: WebSocket): boolean {
    const entry = this.entries.get(key)
    if (entry === undefined) return false
    this.cancelTimers(entry)
    entry.sockets.add(socket)
    if (entry.transcript.length > 0) {
      this.sendFrame(socket, { t: 'data', data: entry.transcript, replay: true })
    }
    if (entry.exited) {
      this.sendFrame(socket, { t: 'exit', exitCode: entry.exitCode, signal: entry.exitSignal })
      socket.close(1000, 'exited')
    }
    return true
  }

  /**
   * Detach one socket; the last detach starts the disconnect grace.
   * @param key - terminal key.
   * @param socket - closing socket.
   */
  detach(key: string, socket: WebSocket): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    entry.sockets.delete(socket)
    if (entry.exited) {
      this.scheduleReap(entry)
      return
    }
    if (entry.sockets.size === 0 && entry.closeTimer === undefined) {
      entry.closeTimer = setTimeout(() => { this.close(key, 'disconnected') }, this.graceMs)
      entry.closeTimer.unref?.()
    }
  }

  /**
   * Apply one browser frame to a live terminal.
   * @param key - terminal key.
   * @param frame - input, resize, or kill.
   * @returns false when no live entry backs the key.
   */
  frame(key: string, frame: TerminalClientFrame): boolean {
    const entry = this.entries.get(key)
    if (entry === undefined || entry.exited) return false
    switch (frame.t) {
      case 'input':
        if (frame.data.length > 0) entry.pty.write(frame.data)
        return true
      case 'resize':
        entry.pty.resize(clamp(frame.cols, 2, 500, 80), clamp(frame.rows, 1, 300, 24))
        return true
      case 'kill':
        this.close(key, 'client-kill')
        return true
    }
  }

  /**
   * Kill one terminal and forget it.
   * @param key - terminal key.
   * @param reason - kill reason, for the socket close frame.
   */
  close(key: string, reason: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.discard(entry)
    for (const socket of entry.sockets) {
      try { socket.close(1000, reason.slice(0, 120)) } catch { /* the socket may already be gone */ }
    }
  }

  /**
   * Live and recently exited keys.
   * @param sessionId - restrict to one conversation when present.
   * @returns the keys.
   */
  list(sessionId?: string): string[] {
    return [...this.entries.values()]
      .filter(entry => sessionId === undefined || entry.sessionId === sessionId)
      .map(entry => entry.key)
  }

  /** Kill every process; the plugin is unloading. */
  dispose(): void {
    this.disposed = true
    for (const entry of [...this.entries.values()]) this.discard(entry)
  }

  /** Re-clamp a reused entry's grid and directory to the caller's facts. */
  private touch(entry: TerminalEntry, input: TerminalOpenInput): void {
    if (input.cols !== undefined || input.rows !== undefined) {
      entry.pty.resize(clamp(input.cols, 2, 500, 80), clamp(input.rows, 1, 300, 24))
    }
  }

  /** Resolve the requested directory to an absolute existing one, else the process cwd. */
  private resolveCwd(requested: string | undefined): string {
    if (requested !== undefined && isAbsolute(requested)) {
      try {
        if (statSync(requested).isDirectory()) return requested
      } catch {
        // Missing path: fall through to the process directory.
      }
    }
    return process.cwd()
  }

  /** Append output to the bounded transcript and fan it out. */
  private append(entry: TerminalEntry, data: string): void {
    entry.transcript += data
    if (entry.transcript.length > TRANSCRIPT_LIMIT) {
      entry.transcript = entry.transcript.slice(entry.transcript.length - TRANSCRIPT_LIMIT)
      entry.dropped = true
    }
    for (const socket of entry.sockets) this.sendFrame(socket, { t: 'data', data })
  }

  /** Mark a process exited, tell its sockets, and reap it when nobody stays. */
  private finish(entry: TerminalEntry, exitCode: number | null, signal: number | null): void {
    entry.exited = true
    entry.exitCode = exitCode
    entry.exitSignal = signal
    for (const socket of entry.sockets) {
      this.sendFrame(socket, { t: 'exit', exitCode, signal })
      socket.close(1000, 'exited')
    }
    entry.sockets.clear()
    this.scheduleReap(entry)
  }

  /** Remove an exited entry once the grace expires unless a socket reattaches. */
  private scheduleReap(entry: TerminalEntry): void {
    if (entry.sockets.size > 0 || entry.reapTimer !== undefined) return
    entry.reapTimer = setTimeout(() => {
      if (entry.sockets.size === 0) this.close(entry.key, 'exited')
    }, this.graceMs)
    entry.reapTimer.unref?.()
  }

  /** Kill and forget one entry, cancelling its timers. */
  private discard(entry: TerminalEntry): void {
    this.cancelTimers(entry)
    this.entries.delete(entry.key)
    if (!entry.exited) {
      try { entry.pty.kill() } catch { /* the process may already be gone */ }
    }
  }

  private cancelTimers(entry: TerminalEntry): void {
    if (entry.closeTimer !== undefined) { clearTimeout(entry.closeTimer); entry.closeTimer = undefined }
    if (entry.reapTimer !== undefined) { clearTimeout(entry.reapTimer); entry.reapTimer = undefined }
  }

  private sendFrame(socket: WebSocket, frame: TerminalServerFrame): void {
    try { socket.send(JSON.stringify(frame)) } catch { /* a dead socket drops its frame */ }
  }
}
