/**
 * enpoi-ui-state — per-session UI state for the web operator surfaces.
 *
 * A Typert Remote service (`enpoiUiState` namespace) that persists the two
 * pieces of per-session UI state the right sidebar owns: the unsent composer
 * draft and the open sidebar surface (tabs). Keeping the store server-side
 * and per-session lets unsent text and open tabs follow the operator across
 * devices.
 *
 * The store is OFF the session log: nothing here is model-visible and no
 * method emits a session event. Records live in the `ui_state` storage domain
 * with the `per-record` layout (one json document per session under the
 * backend root), so one write rewrites one session's document. Reads answer
 * `{ updatedAt: 0 }` for a session with no stored state; invalid input —
 * unsafe session id, malformed draft, oversized payload — is rejected at the
 * Remote boundary.
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

/**
 * The `ui_state` domain: one `per-record` table keyed by session id, so a
 * write lands on that session's document alone. Malformed stored records are
 * moved aside instead of failing the whole open — one session's unreadable
 * UI state must not take the feature down for every session.
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
 * The `enpoiUiState` Remote namespace: `get` and `put` over the shared Typert
 * Gateway. Writes are serialized per service instance, so two concurrent
 * `put` calls for one session merge in arrival order instead of losing the
 * earlier patch's untouched key.
 */
class EnpoiUiStateService extends TypertRemoteService {
  /** The domain form must be mounted before the store can open. */
  static inject = ['storageDomain']

  private table?: KvTable<string, UiStateValue>
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - owning Host Context (Typert binding is installed by the base).
   */
  constructor(ctx: Context) {
    super(ctx, 'enpoiUiState')
  }

  /** Open the `ui_state` domain and keep its table handle for the service lifetime. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(uiStateDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'enpoiUiState.domainClose')
    this.table = domain.table('sessions')
  }

  /**
   * The stored UI state for one session.
   * @param sessionId - session whose UI state is read.
   * @returns the stored value, or `{ updatedAt: 0 }` when nothing is stored.
   */
  @Remote
  async get(sessionId: string): Promise<UiStateValue> {
    const key = requireSessionId(sessionId)
    return this.requireTable().get(key) ?? { updatedAt: 0 }
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
      const table = this.requireTable()
      const next: UiStateValue = { ...table.get(key), updatedAt }
      if (draft !== undefined) next.draft = draft
      if (surface !== undefined) next.surface = surface
      await table.put(key, next)
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
  private requireTable(): KvTable<string, UiStateValue> {
    if (this.table === undefined) {
      throw new Error('enpoiUiState is unavailable: the ui_state domain has not opened')
    }
    return this.table
  }
}

/**
 * Mount the Remote service.
 * @param ctx - profile plugin Context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(EnpoiUiStateService)
}
