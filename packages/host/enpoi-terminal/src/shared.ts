/**
 * enpoi: fork-only terminal host half — route paths and wire payloads shared
 * verbatim by the host routes (`./index.ts`) and the browser terminal module
 * in `@deepseek-ai/dsh-client-ui-brand-enpoi`. Browser-safe: constants and
 * types only, no Node imports.
 */

/** POST route prefix; each wire call is `<path>/<method>`. */
export const ENPOI_TERMINAL_API_PATH = '/enpoi-terminal/api'

/** WebSocket upgrade path; one socket per terminal key. */
export const ENPOI_TERMINAL_WS_PATH = '/enpoi-terminal/ws'

/** Wire call names carried after {@link ENPOI_TERMINAL_API_PATH}. */
export type TerminalApiMethod = 'open' | 'close' | 'list'

/** Body of `open`: the client-minted key, the session cwd, and the initial grid. */
export interface TerminalOpenPayload {
  /** `${sessionId}:${tabId}` — the registry key, also used by the socket. */
  readonly key: string
  /** Owning conversation, for the per-session process cap. */
  readonly sessionId: string
  /** Initial working directory; must be an absolute existing directory. */
  readonly cwd?: string
  readonly cols?: number
  readonly rows?: number
}

/** Answer of `open`; a live key reuses its existing process. */
export interface TerminalOpenValue {
  readonly key: string
  readonly pid: number
  readonly cwd: string
  readonly shell: string
  /** False when a live process already backed the key. */
  readonly spawned: boolean
}

/** Body of `close` and of the socket's kill frame. */
export interface TerminalClosePayload {
  readonly key: string
}

/** Answer of `list`. */
export interface TerminalListValue {
  readonly keys: readonly string[]
}

/** Successful API envelope. */
export interface TerminalApiOk<T> {
  readonly ok: true
  readonly value: T
}

/** Failed API envelope; `code` is machine-routable. */
export interface TerminalApiFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

/** One API response. */
export type TerminalApiResponse<T> = TerminalApiOk<T> | TerminalApiFailure

/** Frames the socket sends to the browser. */
export type TerminalServerFrame =
  /** Transcribed output; `replay` marks history for a fresh attachment. */
  | { readonly t: 'data'; readonly data: string; readonly replay?: true }
  /** The top-level process exited; the socket closes after this frame. */
  | { readonly t: 'exit'; readonly exitCode: number | null; readonly signal: number | null }
  /** The key is unknown or the process could not start. */
  | { readonly t: 'error'; readonly message: string }

/** Frames the browser sends to the socket. */
export type TerminalClientFrame =
  | { readonly t: 'input'; readonly data: string }
  | { readonly t: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly t: 'kill' }

/** Socket close code for an unknown key. */
export const TERMINAL_WS_UNKNOWN_KEY = 4404
