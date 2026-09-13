/**
 * enpoi: the browser terminal registry — one PTY-backed terminal per
 * (session, terminal id), reachable from both the right sidebar's terminal
 * page and the bottom dock. The registry lives in the plugin's apply closure,
 * not a mounted component, so switching rail pages, collapsing the panel, or
 * moving between sessions never tears a shell down; only an explicit close,
 * the host's disconnect grace, or plugin unload does.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  ENPOI_TERMINAL_API_PATH,
  ENPOI_TERMINAL_WS_PATH,
  TERMINAL_WS_UNKNOWN_KEY,
} from '@deepseek-ai/dsh-host-enpoi-terminal/shared'
import type {
  TerminalApiResponse,
  TerminalClientFrame,
  TerminalOpenValue,
  TerminalServerFrame,
} from '@deepseek-ai/dsh-host-enpoi-terminal/shared'

/** Which surface a terminal belongs to. */
export type TerminalPlace = 'panel' | 'bottom'

/** Lifecycle of one terminal, mirrored from the host stream. */
export type TerminalStatus = 'connecting' | 'running' | 'exited' | 'error'

/** One terminal tab. */
export interface TerminalTabState {
  readonly id: string
  readonly title: string
  readonly place: TerminalPlace
  readonly status: TerminalStatus
  readonly exitCode: number | null
  readonly error: string | undefined
}

/** One conversation's terminals and which one each surface shows. */
export interface TerminalSessionState {
  readonly tabs: readonly TerminalTabState[]
  readonly active: Readonly<Record<TerminalPlace, string | undefined>>
}

/** The bottom dock's global presentation. */
export interface TerminalDockState {
  readonly open: boolean
  /** Rendered height in px while open. */
  readonly height: number
}

/** Everything the terminal surfaces read. */
export interface TerminalRegistryState {
  /** Per-conversation terminals; entries are immutable, replaced wholesale. */
  bySession: Readonly<Record<string, TerminalSessionState>>
  dock: TerminalDockState
}

/** Persistence key: dock presentation only; tab lists are process-local. */
const STORAGE_KEY = 'dsh.client.enpoi.terminal'

/** Default dock height before any drag. */
export const DOCK_HEIGHT_DEFAULT = 260

/** Narrowest and tallest the dock drag may leave. */
export const DOCK_HEIGHT_MIN = 120
export const DOCK_HEIGHT_MAX_RATIO = 0.7

/** Bounded client-side replay transcript per terminal. */
const TRANSCRIPT_LIMIT = 512 * 1024

/** Reconnect attempts after a socket drops on a live terminal. */
const MAX_RECONNECTS = 3

/**
 * Clamp a dock height into its range.
 * @param px - requested height.
 * @param viewportHeight - current viewport height.
 * @returns the clamped height.
 */
export function clampDockHeight(px: number, viewportHeight: number): number {
  return Math.min(Math.round(viewportHeight * DOCK_HEIGHT_MAX_RATIO), Math.max(DOCK_HEIGHT_MIN, Math.round(px)))
}

/** One API call against the fenced host route. */
async function call<T>(method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${ENPOI_TERMINAL_API_PATH}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json() as TerminalApiResponse<T>
  if (body.ok !== true) throw new Error(body.error.message)
  return body.value
}

/** Socket URL for one terminal key on this origin. */
function socketUrl(key: string): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${ENPOI_TERMINAL_WS_PATH}?key=${encodeURIComponent(key)}`
}

/** Status updates a connection reports back to the registry. */
interface ConnectionUpdate {
  readonly status: TerminalStatus
  readonly exitCode?: number | null
  readonly error?: string
}

/** One terminal's transport: the host process, its socket, and its transcript. */
class TerminalConnection {
  private socket: WebSocket | undefined
  private transcript = ''
  private readonly listeners = new Set<(data: string) => void>()
  private exited = false
  private closed = false
  private reconnects = 0

  /**
   * @param key - `${sessionId}:${id}` host key.
   * @param sessionId - owning conversation.
   * @param cwd - the session's working directory when known.
   * @param onUpdate - status sink.
   */
  constructor(
    private readonly key: string,
    private readonly sessionId: string,
    private readonly cwd: string | undefined,
    private readonly onUpdate: (update: ConnectionUpdate) => void,
  ) {}

  /** Open the host process (reusing a live one) and attach the socket. */
  async start(): Promise<void> {
    try {
      await call<TerminalOpenValue>('open', {
        key: this.key,
        sessionId: this.sessionId,
        ...this.cwd === undefined ? {} : { cwd: this.cwd },
        cols: 80,
        rows: 24,
      })
    } catch (error) {
      this.onUpdate({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      return
    }
    this.connect()
  }

  private connect(): void {
    if (this.closed || this.exited) return
    let socket: WebSocket
    try {
      socket = new WebSocket(socketUrl(this.key))
    } catch (error) {
      this.onUpdate({ status: 'error', error: error instanceof Error ? error.message : String(error) })
      return
    }
    this.socket = socket
    socket.onopen = () => {
      this.reconnects = 0
      this.onUpdate({ status: 'running' })
      // The view's first fit may have run before the socket opened.
      this.send({ t: 'resize', cols: this.cols, rows: this.rows })
    }
    socket.onmessage = (event: MessageEvent<string>) => {
      const frame = this.parse(event.data)
      if (frame === undefined) return
      switch (frame.t) {
        case 'data':
          this.emit(frame.data)
          break
        case 'exit':
          this.exited = true
          this.onUpdate({ status: 'exited', exitCode: frame.exitCode })
          break
        case 'error':
          this.onUpdate({ status: 'error', error: frame.message })
          break
      }
    }
    socket.onclose = (event: CloseEvent) => {
      this.socket = undefined
      if (this.closed || this.exited) return
      if (event.code === TERMINAL_WS_UNKNOWN_KEY) {
        this.onUpdate({ status: 'error', error: 'the host no longer knows this terminal' })
        return
      }
      if (this.reconnects >= MAX_RECONNECTS) {
        this.onUpdate({ status: 'error', error: 'the terminal connection dropped' })
        return
      }
      this.reconnects += 1
      setTimeout(() => { this.connect() }, 600 * this.reconnects)
    }
    socket.onerror = () => {
      // The close handler owns the outcome.
    }
  }

  private cols = 80
  private rows = 24

  /** Parse one server frame; malformed frames are dropped. */
  private parse(raw: string): TerminalServerFrame | undefined {
    try {
      const value = JSON.parse(raw) as TerminalServerFrame
      return typeof value === 'object' && value !== null && typeof value.t === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }

  private emit(data: string): void {
    this.transcript += data
    if (this.transcript.length > TRANSCRIPT_LIMIT) {
      this.transcript = this.transcript.slice(this.transcript.length - TRANSCRIPT_LIMIT)
    }
    for (const listener of [...this.listeners]) listener(data)
  }

  private send(frame: TerminalClientFrame): void {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(frame))
  }

  /**
   * Subscribe to live output.
   * @param listener - output sink.
   * @returns unsubscribe.
   */
  subscribe(listener: (data: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Everything received so far, for a fresh terminal instance. */
  read(): string {
    return this.transcript
  }

  /**
   * Send input.
   * @param data - keystrokes or pasted text.
   */
  write(data: string): void {
    this.send({ t: 'input', data })
  }

  /**
   * Tell the PTY its grid changed.
   * @param cols - columns.
   * @param rows - rows.
   */
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.send({ t: 'resize', cols, rows })
  }

  /** Kill the process and detach for good. */
  kill(): void {
    this.closed = true
    this.send({ t: 'kill' })
    const socket = this.socket
    if (socket !== undefined) {
      try { socket.close() } catch { /* already closing */ }
    }
    this.socket = undefined
    void call('close', { key: this.key }).catch(() => { /* the host may already have reaped it */ })
  }
}

/** The registry the plugin's registers share. */
export class TerminalRegistry {
  /** The observable state; components read it through the inject hook. */
  readonly state: SnapshotStore<TerminalRegistryState>
  private readonly connections = new Map<string, TerminalConnection>()
  private counter = 0

  constructor() {
    this.state = createSnapshotStore<TerminalRegistryState>(
      { bySession: {}, dock: { open: false, height: DOCK_HEIGHT_DEFAULT } },
      { persist: { name: STORAGE_KEY } },
    )
    const stored = this.state.getSnapshot()
    // A reload has no live PTYs: keep the dock's presentation and drop stale tabs.
    this.state.set({
      bySession: {},
      dock: {
        open: stored.dock?.open === true,
        height: typeof stored.dock?.height === 'number' && Number.isFinite(stored.dock.height)
          ? clampDockHeight(stored.dock.height, window.innerHeight)
          : DOCK_HEIGHT_DEFAULT,
      },
    })
  }

  /**
   * Spawn one terminal and make it the active tab of its surface.
   * @param sessionId - owning conversation.
   * @param place - which surface hosts it.
   * @param cwd - the session's working directory when known.
   */
  open(sessionId: string, place: TerminalPlace, cwd: string | undefined): void {
    this.counter += 1
    const id = `t${this.counter}`
    const key = `${sessionId}:${id}`
    const session = this.session(sessionId)
    const next: TerminalTabState = {
      id,
      title: `Terminal ${session.tabs.filter(tab => tab.place === place).length + 1}`,
      place,
      status: 'connecting',
      exitCode: null,
      error: undefined,
    }
    this.setSession(sessionId, {
      tabs: [...session.tabs, next],
      active: { ...session.active, [place]: id },
    })
    const connection = new TerminalConnection(key, sessionId, cwd, (update) => {
      this.patchTab(sessionId, id, update)
    })
    this.connections.set(key, connection)
    void connection.start()
  }

  /**
   * Kill one terminal and drop its tab.
   * @param sessionId - owning conversation.
   * @param id - terminal id.
   */
  close(sessionId: string, id: string): void {
    const key = `${sessionId}:${id}`
    this.connections.get(key)?.kill()
    this.connections.delete(key)
    const session = this.session(sessionId)
    const tabs = session.tabs.filter(tab => tab.id !== id)
    const place = session.tabs.find(tab => tab.id === id)?.place
    const active = { ...session.active }
    if (place !== undefined && active[place] === id) {
      active[place] = tabs.filter(tab => tab.place === place).at(-1)?.id
    }
    this.setSession(sessionId, { tabs, active })
  }

  /**
   * Focus one terminal tab.
   * @param sessionId - owning conversation.
   * @param place - which surface.
   * @param id - terminal id.
   */
  activate(sessionId: string, place: TerminalPlace, id: string): void {
    const session = this.session(sessionId)
    this.setSession(sessionId, { ...session, active: { ...session.active, [place]: id } })
  }

  /**
   * Write input to one terminal.
   * @param sessionId - owning conversation.
   * @param id - terminal id.
   * @param data - keystrokes or pasted text.
   */
  write(sessionId: string, id: string, data: string): void {
    this.connections.get(`${sessionId}:${id}`)?.write(data)
  }

  /**
   * Report one terminal's new grid.
   * @param sessionId - owning conversation.
   * @param id - terminal id.
   * @param cols - columns.
   * @param rows - rows.
   */
  resize(sessionId: string, id: string, cols: number, rows: number): void {
    this.connections.get(`${sessionId}:${id}`)?.resize(cols, rows)
  }

  /**
   * Subscribe to one terminal's live output.
   * @param sessionId - owning conversation.
   * @param id - terminal id.
   * @param listener - output sink.
   * @returns unsubscribe.
   */
  subscribe(sessionId: string, id: string, listener: (data: string) => void): () => void {
    const connection = this.connections.get(`${sessionId}:${id}`)
    if (connection === undefined) return () => {}
    return connection.subscribe(listener)
  }

  /**
   * Everything one terminal received so far.
   * @param sessionId - owning conversation.
   * @param id - terminal id.
   * @returns the transcript; empty for a terminal this browser did not open.
   */
  read(sessionId: string, id: string): string {
    return this.connections.get(`${sessionId}:${id}`)?.read() ?? ''
  }

  /** Flip the bottom dock open or closed. */
  toggleDock(): void {
    const dock = this.state.getSnapshot().dock
    this.state.update((draft) => { draft.dock = { ...dock, open: !dock.open } })
  }

  /**
   * Record the dock's height after a drag.
   * @param px - dragged height.
   */
  setDockHeight(px: number): void {
    const dock = this.state.getSnapshot().dock
    this.state.update((draft) => { draft.dock = { ...dock, height: clampDockHeight(px, window.innerHeight) } })
  }

  /** Kill every terminal this browser opened; the plugin is unloading. */
  dispose(): void {
    for (const connection of this.connections.values()) connection.kill()
    this.connections.clear()
  }

  private session(sessionId: string): TerminalSessionState {
    return this.state.getSnapshot().bySession[sessionId]
      ?? { tabs: [], active: { panel: undefined, bottom: undefined } }
  }

  private setSession(sessionId: string, session: TerminalSessionState): void {
    this.state.update((draft) => {
      draft.bySession = { ...draft.bySession, [sessionId]: session }
    })
  }

  private patchTab(sessionId: string, id: string, update: ConnectionUpdate): void {
    const session = this.state.getSnapshot().bySession[sessionId]
    if (session === undefined) return
    const tabs = session.tabs.map((tab): TerminalTabState => tab.id === id
      ? {
        ...tab,
        status: update.status,
        exitCode: update.exitCode === undefined ? tab.exitCode : update.exitCode,
        error: update.error,
      }
      : tab)
    this.setSession(sessionId, { ...session, tabs })
  }
}
