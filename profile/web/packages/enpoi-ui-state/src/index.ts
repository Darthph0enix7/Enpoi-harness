/**
 * enpoi-ui-state — UI state for the web operator surfaces.
 *
 * A Typert Remote service (`enpoiUiState` namespace) that persists the two
 * pieces of per-session UI state the right sidebar owns — the unsent composer
 * draft and the open sidebar surface (tabs) — plus one host-wide layout record
 * holding the frame's column widths. Keeping the session state server-side
 * and per-session lets unsent text and open tabs follow the operator across
 * devices; the layout record is per host, not per session, because the panel
 * width is the operator's preference for this harness rather than a fact of
 * any conversation. localStorage remains the browser's first-paint cache, and
 * because it is per origin (a tailnet address, its DNS name, a tunnel URL) the
 * host record is what makes a resize survive a changed entry URL.
 *
 * The store is OFF the session log: nothing here is model-visible and no
 * method emits a session event. Records live in the `ui_state` storage domain
 * with the `per-record` layout (one json document per record key under the
 * backend root), so one write rewrites one record's document. Reads answer
 * `{ updatedAt: 0 }` for a record with no stored state; invalid input —
 * unsafe session id, malformed draft, oversized payload, out-of-range width —
 * is rejected at the Remote boundary.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainTableSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod/v4'

/** Cordis plugin name. */
export const name = 'enpoi-ui-state'

/** Nothing is injected into the plugin function; the Service declares its own injections. */
export const inject: string[] = []

/** Longest accepted session id. */
const MAX_SESSION_ID_CHARS = 200
/** Longest accepted draft text (characters). */
const MAX_DRAFT_TEXT_CHARS = 100_000
/** Longest accepted serialized surface (JSON characters). */
const MAX_SURFACE_JSON_CHARS = 64_000
/** Record keys become path segments in the per-record json backend. */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/
/** Key of the single host-wide layout record in its table. */
export const LAYOUT_KEY = 'layout'
/** Widest accepted width member in px; a frame wider than this does not exist. */
const MAX_WIDTH_PX = 20_000

/** One client's unsent composer text, timestamped by that client. */
export interface UiStateDraft {
  /** Unsent composer text. */
  text: string
  /** Client clock (milliseconds) of the last change; stored as given, never compared. */
  updatedAt: number
  /** Client instance that typed the text. */
  clientId: string
}

/** One session's stored UI state. */
export interface UiStateValue {
  /** Unsent composer draft, when one is stored. */
  draft?: UiStateDraft
  /** Right-sidebar surface descriptor (open tabs), as the client defines it. */
  surface?: unknown
  /** Server clock (milliseconds) of the last accepted write; 0 when nothing is stored. */
  updatedAt: number
}

/** One `put` patch; each present key replaces its stored counterpart wholesale. */
export interface UiStatePatch {
  /** Replacement draft; absent leaves the stored draft untouched. */
  draft?: UiStateDraft
  /** Replacement surface; absent leaves the stored surface untouched. */
  surface?: unknown
}

/** The right panel's width as the client stores it: dragged px plus the frame ratio it was dragged at. */
export interface LayoutRightbarWidths {
  /** Width in px on the frame it was dragged on. */
  px: number
  /** {@link px} divided by that frame's width; another frame scales by this. */
  ratio: number
}

/** One host's column width preferences; the operator's harness owns this record, sessions do not. */
export interface LayoutWidths {
  /** Sidebar width preference in px; 0 collapses to the icon rail. */
  sidebar: number
  /** Right panel width preference; absent while the panel follows the shipped default. */
  rightbar?: LayoutRightbarWidths
  /** Server clock (milliseconds) of the last accepted write; 0 when nothing is stored. */
  updatedAt: number
}

/** Durable record schema for one session's document. */
const uiStateRecordSchema = z.object({
  draft: z.object({
    text: z.string(),
    updatedAt: z.number(),
    clientId: z.string(),
  }).optional(),
  surface: z.unknown().optional(),
  updatedAt: z.number(),
})

/** Durable record schema for the single layout document. */
const layoutRecordSchema = z.object({
  sidebar: z.number(),
  rightbar: z.object({ px: z.number(), ratio: z.number() }).optional(),
  updatedAt: z.number(),
})

/**
 * The `ui_state` domain: one `per-record` table keyed by session id plus the
 * single-key `layout` table, so a write lands on one record's document alone.
 * Malformed stored records are moved aside instead of failing the whole open —
 * one session's unreadable UI state must not take the feature down for every
 * session.
 */
const uiStateDomainSpec = defineDomain({
  name: 'ui_state',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    // The profile resolves the root `zod` (3.25.76, whose `zod/v4` is the 4.0
    // preview) while dsh-storage-domain's declarations come from its nested
    // zod 4.4.3. The schema is runtime-compatible with both; the cast lands
    // only the type-level skew of the duplicated zod copies.
    sessions: domainTable<string, UiStateValue>(
      uiStateRecordSchema as unknown as DomainTableSpec<string, UiStateValue>['valueSchema'],
    ),
    layout: domainTable<string, LayoutWidths>(
      layoutRecordSchema as unknown as DomainTableSpec<string, LayoutWidths>['valueSchema'],
    ),
  },
})

/**
 * Validate one incoming session id before it names a record.
 * @param value - raw `sessionId` argument from the Remote envelope.
 * @returns the validated session id.
 * @throws TypeError for a non-string, empty, path-separator-bearing, or
 *   non-path-safe id; RangeError beyond {@link MAX_SESSION_ID_CHARS}.
 */
function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError('enpoiUiState: sessionId must be a non-empty string')
  }
  if (value.length > MAX_SESSION_ID_CHARS) {
    throw new RangeError(`enpoiUiState: sessionId must be at most ${MAX_SESSION_ID_CHARS} characters`)
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new TypeError('enpoiUiState: sessionId must not contain path separators')
  }
  if (!SESSION_ID_RE.test(value)) {
    throw new TypeError('enpoiUiState: sessionId must match [a-zA-Z0-9_-]+ (it becomes a per-record document name)')
  }
  return value
}

/**
 * Validate one incoming draft payload.
 * @param value - raw `patch.draft` argument.
 * @returns the validated draft, with exactly the stored fields.
 * @throws TypeError for a malformed draft; RangeError for oversized text.
 */
function requireDraft(value: unknown): UiStateDraft {
  if (!isRecord(value)) {
    throw new TypeError('enpoiUiState: patch.draft must be an object')
  }
  const { text, updatedAt, clientId } = value
  if (typeof text !== 'string') {
    throw new TypeError('enpoiUiState: patch.draft.text must be a string')
  }
  if (text.length > MAX_DRAFT_TEXT_CHARS) {
    throw new RangeError(`enpoiUiState: patch.draft.text must be at most ${MAX_DRAFT_TEXT_CHARS} characters`)
  }
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
    throw new TypeError('enpoiUiState: patch.draft.updatedAt must be a finite number')
  }
  if (typeof clientId !== 'string' || clientId === '') {
    throw new TypeError('enpoiUiState: patch.draft.clientId must be a non-empty string')
  }
  return { text, updatedAt, clientId }
}

/**
 * Validate one incoming surface payload against the size bound.
 * @param value - raw `patch.surface` argument (already a JSON value from the envelope).
 * @returns the value unchanged.
 * @throws TypeError when the value is not JSON-serializable; RangeError when
 *   its serialized form exceeds {@link MAX_SURFACE_JSON_CHARS} characters.
 */
function requireSurface(value: unknown): unknown {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new TypeError(`enpoiUiState: patch.surface is not JSON-serializable: ${String(error)}`)
  }
  if (serialized === undefined) {
    throw new TypeError('enpoiUiState: patch.surface must be a JSON value')
  }
  if (serialized.length > MAX_SURFACE_JSON_CHARS) {
    throw new RangeError(`enpoiUiState: patch.surface must serialize to at most ${MAX_SURFACE_JSON_CHARS} characters`)
  }
  return value
}

/**
 * Whether one value is a non-array object.
 * @param value - candidate value.
 * @returns true for a plain object candidate usable as a patch.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one incoming frame width in px.
 * @param value - raw width member.
 * @param field - wire path used in the thrown message.
 * @param options - whether 0 is meaningful (a collapsed sidebar).
 * @returns the rounded width.
 * @throws TypeError for a non-number; RangeError outside 0–{@link MAX_WIDTH_PX}.
 */
function requireWidth(value: unknown, field: string, options: { readonly zero: boolean }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`enpoiUiState: ${field} must be a finite number`)
  }
  if (value < 0 || (!options.zero && value === 0) || value > MAX_WIDTH_PX) {
    const lower = options.zero ? 'a non-negative' : 'a positive'
    throw new RangeError(`enpoiUiState: ${field} must be ${lower} width at most ${MAX_WIDTH_PX}px`)
  }
  return Math.round(value)
}

/**
 * Validate one incoming layout record: the widths only, never the server stamp.
 * @param value - raw `putLayout` argument.
 * @returns the validated widths, with exactly the stored fields.
 * @throws TypeError for a malformed record; RangeError for out-of-range widths.
 */
export function requireLayoutWidths(value: unknown): Omit<LayoutWidths, 'updatedAt'> {
  if (!isRecord(value)) {
    throw new TypeError('enpoiUiState: layout widths must be an object')
  }
  const sidebar = requireWidth(value.sidebar, 'layout.sidebar', { zero: true })
  const rightbar = value.rightbar
  if (rightbar === undefined) return { sidebar }
  if (!isRecord(rightbar)) {
    throw new TypeError('enpoiUiState: layout.rightbar must be an object')
  }
  const px = requireWidth(rightbar.px, 'layout.rightbar.px', { zero: false })
  const ratio = rightbar.ratio
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new RangeError('enpoiUiState: layout.rightbar.ratio must be a finite fraction above 0 and at most 1')
  }
  return { sidebar, rightbar: { px, ratio } }
}

/**
 * The `enpoiUiState` Remote namespace: `get`/`put` for one session's UI state
 * and `getLayout`/`putLayout` for the host-wide column widths, over the shared
 * Typert Gateway. Writes are serialized per service instance, so two
 * concurrent calls for one record apply in arrival order instead of losing the
 * earlier call's untouched key.
 */
export class EnpoiUiStateService extends TypertRemoteService {
  /** The domain form must be mounted before the store can open. */
  static inject = ['storageDomain']

  private sessions?: KvTable<string, UiStateValue>
  private layout?: KvTable<string, LayoutWidths>
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - owning Host Context (Typert binding is installed by the base).
   */
  constructor(ctx: Context) {
    super(ctx, 'enpoiUiState')
  }

  /** Open the `ui_state` domain and keep its table handles for the service lifetime. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(uiStateDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'enpoiUiState.domainClose')
    this.sessions = domain.table('sessions')
    this.layout = domain.table('layout')
  }

  /**
   * The stored UI state for one session.
   * @param sessionId - session whose UI state is read.
   * @returns the stored value, or `{ updatedAt: 0 }` when nothing is stored.
   */
  @Remote
  async get(sessionId: string): Promise<UiStateValue> {
    const key = requireSessionId(sessionId)
    return this.requireTable(this.sessions).get(key) ?? { updatedAt: 0 }
  }

  /**
   * Shallow-merge one patch into a session's stored UI state and persist it.
   * `draft` and `surface` merge independently; the server stamps `updatedAt`
   * with its own clock and stores the caller's `draft.updatedAt` as given.
   * @param sessionId - session whose UI state is patched.
   * @param patch - present `draft`/`surface` keys replace their stored counterparts.
   * @returns the new server `updatedAt` after the write is durable.
   */
  @Remote
  async put(sessionId: string, patch: UiStatePatch): Promise<{ ok: true; updatedAt: number }> {
    const key = requireSessionId(sessionId)
    if (!isRecord(patch)) {
      throw new TypeError('enpoiUiState: patch must be an object with a draft or surface key')
    }
    const hasDraft = patch.draft !== undefined
    const hasSurface = patch.surface !== undefined
    const draft = hasDraft ? requireDraft(patch.draft) : undefined
    const surface = hasSurface ? requireSurface(patch.surface) : undefined
    const updatedAt = Date.now()
    await this.enqueue(async () => {
      const table = this.requireTable(this.sessions)
      const next: UiStateValue = { ...table.get(key), updatedAt }
      if (draft !== undefined) next.draft = draft
      if (surface !== undefined) next.surface = surface
      await table.put(key, next)
    })
    return { ok: true, updatedAt }
  }

  /**
   * The host's column width preferences.
   * @returns the stored record, or `{ sidebar: 0, updatedAt: 0 }` when nothing is stored.
   */
  @Remote
  async getLayout(): Promise<LayoutWidths> {
    return this.requireTable(this.layout).get(LAYOUT_KEY) ?? { sidebar: 0, updatedAt: 0 }
  }

  /**
   * Replace the host's column width preferences.
   * @param widths - the widths to store; the server stamps `updatedAt`.
   * @returns the new server `updatedAt` after the write is durable.
   */
  @Remote
  async putLayout(widths: LayoutWidths): Promise<{ ok: true; updatedAt: number }> {
    const next = requireLayoutWidths(widths)
    const updatedAt = Date.now()
    await this.enqueue(async () => {
      await this.requireTable(this.layout).put(LAYOUT_KEY, { ...next, updatedAt })
    })
    return { ok: true, updatedAt }
  }

  /** Serialize writes so a concurrent read-modify-write cannot drop an earlier patch. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** The opened domain table; a call before init resolves is a protocol violation. */
  private requireTable<T>(table: KvTable<string, T> | undefined): KvTable<string, T> {
    if (table === undefined) {
      throw new Error('enpoiUiState is unavailable: the ui_state domain has not opened')
    }
    return table
  }
}

/**
 * Mount the Remote service.
 * @param ctx - profile plugin Context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(EnpoiUiStateService)
}
