/**
 * Whiteboard card read model — the browser mirror of the profile plugin
 * `enpoi-whiteboard/board` (parseWhiteboardStore, resolveWhiteboard,
 * renderWhiteboardBlock, whiteboardTokens).
 *
 * The owning plugin lives in the dsh profile, outside this workspace, so the
 * pure functions are restated here for the read-only card and pinned by tests
 * against the plugin's exact output. The board is read through the same
 * `settings.describe` path the capabilities panel uses
 * (`enpoi-orchestration.whiteboard`); no host projection or new RPC is added.
 *
 * The stored document is per scope: `{ version, docs: { global?, projects:
 * { <cwd> }, sessions: { <sessionId> } } }`. A legacy single-board document is
 * still read; a legacy `global` board carrying `meta.writtenBySessionId` is
 * that session's board and is read from its session bucket (mirroring the
 * plugin's one-time attribution migration).
 *
 * Two views exist over one store. The plugin injects the *resolved* view for
 * the agent — this session's entries plus the project/global entries it
 * explicitly shares ({@link resolveWhiteboard}). The card's primary surface is
 * deliberately narrower: only this session's own board
 * ({@link resolveSessionWhiteboard}), with the shared rest behind a collapsed
 * disclosure ({@link splitWhiteboard}). One session must never read another
 * session's board as its own whiteboard.
 *
 * @module
 */

/** Where a board applies; the plugin resolves session over project over global. */
export type WhiteboardScope = 'session' | 'project' | 'global'

/** One entry kind. `path` is the only kind the plugin validates on disk. */
export type WhiteboardEntryKind = 'path' | 'rule' | 'fact' | 'task'

/** One normalized entry row, as rendered and listed by the card. */
export interface WhiteboardEntryView {
  readonly id: string
  readonly kind: WhiteboardEntryKind
  readonly text: string
  readonly pinned: boolean
  /** Entry version: 1 at creation, +1 per replace-by-id. */
  readonly version: number
  /** Set when a `path` entry no longer resolves. */
  readonly stale?: boolean
}

/** One scope's stored board. */
export interface WhiteboardBoardView {
  /** Board version: 0 when never written, +1 per write to this board. */
  readonly version: number
  readonly entries: readonly WhiteboardEntryView[]
  /** Epoch ms of the last write to this board. */
  readonly updatedAt: number
}

/** The normalized multi-scope store under `enpoi-orchestration.whiteboard`. */
export interface WhiteboardStoreView {
  /** Store version: 0 when never written, +1 per successful write. */
  readonly version: number
  readonly docs: {
    readonly global?: WhiteboardBoardView
    readonly projects: Readonly<Record<string, WhiteboardBoardView>>
    readonly sessions: Readonly<Record<string, WhiteboardBoardView>>
  }
}

/** The scope facts one session's card resolves the board against. */
export interface WhiteboardScopeFacts {
  /** The session showing the card. */
  readonly sessionId?: string
  /** The session's durable parent session id (direct-child inheritance). */
  readonly parentSessionId?: string
  /** The session's project identity (session cwd). */
  readonly projectId?: string
}

/** One resolved entry, carrying the scope whose board authored it. */
export interface ResolvedWhiteboardEntryView extends WhiteboardEntryView {
  /** The authoring scope: session entries override project and global by id. */
  readonly scope: WhiteboardScope
}

/** The resolved view this session's card shows and the plugin injects. */
export interface ResolvedWhiteboardView {
  /** Store version: bumps once per successful write to any scope. */
  readonly version: number
  /** The most specific scope that contributed an entry; `global` when none did. */
  readonly scope: WhiteboardScope
  readonly entries: readonly ResolvedWhiteboardEntryView[]
  /** Latest `updatedAt` among the contributing boards. */
  readonly updatedAt: number
}

/** Hard rendered budget — the plugin's DEFAULT_BUDGET_TOKENS default. */
export const WHITEBOARD_BUDGET_TOKENS = 1500

/** Header line of the exact block injected through the runtime-context seam. */
export const WHITEBOARD_HEADER = '### Pinned context'

/** Conservative chars-per-token estimate used by the plugin's rendered block. */
const CHARS_PER_TOKEN = 4

const KINDS: readonly WhiteboardEntryKind[] = ['path', 'rule', 'fact', 'task']
const SCOPES: readonly WhiteboardScope[] = ['session', 'project', 'global']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerce one stored entry, mirroring the plugin's normalizeEntry. */
function normalizeEntry(raw: unknown): WhiteboardEntryView | undefined {
  if (!isRecord(raw)) return undefined
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  const kind = KINDS.find(candidate => candidate === raw.kind)
  if (text.length === 0 || kind === undefined) return undefined
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : ''
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version >= 1
    ? Math.floor(raw.version)
    : 1
  return {
    id,
    kind,
    text,
    pinned: raw.pinned === true,
    version,
    ...(raw.stale === true ? { stale: true } : {}),
  }
}

/** Coerce one stored per-scope board, mirroring the plugin's normalizeBoard. */
function parseBoard(raw: unknown): WhiteboardBoardView {
  const source = isRecord(raw) ? raw : {}
  const entries = Array.isArray(source.entries)
    ? source.entries.map(normalizeEntry).filter((entry): entry is WhiteboardEntryView => entry !== undefined)
    : []
  return {
    version: typeof source.version === 'number' && Number.isFinite(source.version) && source.version >= 0
      ? Math.floor(source.version)
      : 0,
    entries,
    updatedAt: typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt) ? source.updatedAt : 0,
  }
}

/**
 * Coerce the `enpoi-orchestration.whiteboard` value into the multi-scope store.
 * A legacy single-board document migrates into the bucket its own scope names
 * (session → `sessions[<id>]`, project → `projects[<cwd>]`; a legacy `global`
 * board carrying `meta.writtenBySessionId` becomes that session's board,
 * leaving `global` absent; otherwise `global`), mirroring the plugin's
 * normalizeStore.
 * @param raw - the settings value, if any.
 * @returns the normalized store.
 */
export function parseWhiteboardStore(raw: unknown): WhiteboardStoreView {
  const source = isRecord(raw) ? raw : {}
  const version = typeof source.version === 'number' && Number.isFinite(source.version) && source.version >= 0
    ? Math.floor(source.version)
    : 0
  if (isRecord(source.docs)) {
    const projects: Record<string, WhiteboardBoardView> = {}
    const sessions: Record<string, WhiteboardBoardView> = {}
    for (const bucket of [['projects', projects], ['sessions', sessions]] as const) {
      const value = source.docs[bucket[0]]
      if (!isRecord(value)) continue
      for (const [key, board] of Object.entries(value)) {
        if (key.length === 0 || !isRecord(board)) continue
        bucket[1][key] = parseBoard(board)
      }
    }
    return {
      version,
      docs: {
        projects,
        sessions,
        ...(isRecord(source.docs.global) ? { global: parseBoard(source.docs.global) } : {}),
      },
    }
  }
  const scope = SCOPES.find(candidate => candidate === source.scope) ?? 'global'
  const board = parseBoard(source)
  const legacyVersion = board.version
  const sessionId = typeof source.sessionId === 'string' && source.sessionId.length > 0 ? source.sessionId : undefined
  const projectId = typeof source.projectId === 'string' && source.projectId.length > 0 ? source.projectId : undefined
  const writtenBySessionId = isRecord(source.meta) && typeof source.meta.writtenBySessionId === 'string'
    ? source.meta.writtenBySessionId.trim()
    : ''
  if (scope === 'session' && sessionId !== undefined) {
    return { version: legacyVersion, docs: { projects: {}, sessions: { [sessionId]: board } } }
  }
  if (scope === 'project' && projectId !== undefined) {
    return { version: legacyVersion, docs: { projects: { [projectId]: board }, sessions: {} } }
  }
  if (scope === 'global' && writtenBySessionId.length > 0) {
    return { version: legacyVersion, docs: { projects: {}, sessions: { [writtenBySessionId]: board } } }
  }
  return { version: legacyVersion, docs: { global: board, projects: {}, sessions: {} } }
}

/**
 * Resolve the store for one session. Global entries come first, then the
 * matching project's, then the parent session's (direct-child inheritance),
 * then the session's own; a later scope overriding an earlier entry with the
 * same id. Each resolved entry reports its authoring scope.
 * @param store - the normalized store.
 * @param facts - the session's scope facts.
 * @returns the resolved view (empty entries when nothing matches).
 */
export function resolveWhiteboard(store: WhiteboardStoreView, facts: WhiteboardScopeFacts): ResolvedWhiteboardView {
  const layers: Array<{ scope: WhiteboardScope; board: WhiteboardBoardView | undefined }> = [
    { scope: 'global', board: store.docs.global },
  ]
  if (facts.projectId !== undefined) layers.push({ scope: 'project', board: store.docs.projects[facts.projectId] })
  if (facts.parentSessionId !== undefined && facts.parentSessionId !== facts.sessionId) {
    layers.push({ scope: 'session', board: store.docs.sessions[facts.parentSessionId] })
  }
  if (facts.sessionId !== undefined) layers.push({ scope: 'session', board: store.docs.sessions[facts.sessionId] })
  const merged = new Map<string, ResolvedWhiteboardEntryView>()
  let scope: WhiteboardScope = 'global'
  let updatedAt = 0
  for (const layer of layers) {
    const board = layer.board
    if (board === undefined || board.entries.length === 0) continue
    scope = layer.scope
    if (board.updatedAt > updatedAt) updatedAt = board.updatedAt
    for (const entry of board.entries) merged.set(entry.id, { ...entry, scope: layer.scope })
  }
  return { version: store.version, scope, entries: [...merged.values()], updatedAt }
}

/**
 * Resolve only this session's own board: the direct parent session's entries
 * (inheritance) then the session's own, later overriding by entry id. This is
 * what the card presents as the session's whiteboard; project/global entries
 * are never part of it, so one session never shows another session's content
 * as its own.
 * @param store - the normalized store.
 * @param facts - the session's scope facts.
 * @returns the session board (empty when the session has none).
 */
export function resolveSessionWhiteboard(store: WhiteboardStoreView, facts: WhiteboardScopeFacts): ResolvedWhiteboardView {
  const merged = new Map<string, ResolvedWhiteboardEntryView>()
  const sessionIds: string[] = []
  if (facts.parentSessionId !== undefined && facts.parentSessionId !== facts.sessionId) {
    sessionIds.push(facts.parentSessionId)
  }
  if (facts.sessionId !== undefined) sessionIds.push(facts.sessionId)
  let updatedAt = 0
  for (const sessionId of sessionIds) {
    const board = store.docs.sessions[sessionId]
    if (board === undefined || board.entries.length === 0) continue
    if (board.updatedAt > updatedAt) updatedAt = board.updatedAt
    for (const entry of board.entries) merged.set(entry.id, { ...entry, scope: 'session' })
  }
  return { version: store.version, scope: 'session', entries: [...merged.values()], updatedAt }
}

/** The card's three views over one store: session board, shared rest, agent view. */
export interface WhiteboardBoardSplit {
  /** This session's own board (own entries plus direct-parent inheritance). */
  readonly session: ResolvedWhiteboardView
  /** Project/global entries the agent also receives (session-overridden ids excluded). */
  readonly shared: ResolvedWhiteboardView
  /** The exact resolved view the plugin injects for this session's agent. */
  readonly agent: ResolvedWhiteboardView
}

/**
 * Split the store into the card's primary view, its collapsed shared
 * disclosure, and the honest agent view. The shared view is the resolved view
 * minus the session half, so an entry the session overrides by id is never
 * presented twice, and its scope names the most specific shared layer.
 * @param store - the normalized store.
 * @param facts - the session's scope facts.
 * @returns the three views (all empty when nothing matches).
 */
export function splitWhiteboard(store: WhiteboardStoreView, facts: WhiteboardScopeFacts): WhiteboardBoardSplit {
  const agent = resolveWhiteboard(store, facts)
  const session = resolveSessionWhiteboard(store, facts)
  const sharedEntries = agent.entries.filter(entry => entry.scope !== 'session')
  const sharedScope: WhiteboardScope = sharedEntries.some(entry => entry.scope === 'project') ? 'project' : 'global'
  const projectUpdatedAt = facts.projectId === undefined ? 0 : store.docs.projects[facts.projectId]?.updatedAt ?? 0
  const globalUpdatedAt = sharedEntries.some(entry => entry.scope === 'global') ? store.docs.global?.updatedAt ?? 0 : 0
  const sharedUpdatedAt = sharedEntries.some(entry => entry.scope === 'project') ? projectUpdatedAt : globalUpdatedAt
  return {
    session,
    shared: { version: store.version, scope: sharedScope, entries: sharedEntries, updatedAt: sharedUpdatedAt },
    agent,
  }
}

/**
 * Render the resolved board exactly as the plugin injects it: pinned first
 * (stable), one line per entry, stale paths flagged.
 * @param doc - the resolved board to render.
 * @returns the block, or `''` when the board holds no entries.
 */
export function renderWhiteboardBlock(doc: ResolvedWhiteboardView): string {
  if (doc.entries.length === 0) return ''
  const lines = doc.entries
    .slice()
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return 0
    })
    .map((entry) => {
      const marker = entry.pinned ? '📌 ' : ''
      const stale = entry.stale === true ? ' (stale)' : ''
      return `- ${marker}[${entry.kind}] ${entry.text}${stale}`
    })
  return `${WHITEBOARD_HEADER} (v${doc.version})\n${lines.join('\n')}`
}

/**
 * Estimate the rendered block's token cost, the plugin's conservative
 * code-points/4 ceiling.
 * @param rendered - the exact injected text.
 * @returns estimated tokens, ceiling-rounded.
 */
export function whiteboardTokens(rendered: string): number {
  return Math.ceil(Array.from(rendered).length / CHARS_PER_TOKEN)
}

let rpcSeq = 0

/** Read the enpoi-orchestration namespace through the live gateway. */
function describeOrchestration(): Promise<{ whiteboard?: unknown } | undefined> {
  rpcSeq += 1
  return fetch('/api/settings.describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      method: 'settings.describe',
      rpcId: `wt-whiteboard-${rpcSeq}`,
      payload: { args: {} },
    }),
  }).then(async (res) => {
    if (!res.ok) return undefined
    const json = await res.json() as {
      result?: { value?: { namespaces?: Array<{ ns?: string; value?: { whiteboard?: unknown } }> } }
    }
    const namespaces = json.result?.value?.namespaces
    return Array.isArray(namespaces) ? namespaces.find(entry => entry.ns === 'enpoi-orchestration')?.value : undefined
  })
}

/**
 * Read the live whiteboard store. Never throws: a missing gateway or an
 * unreachable settings service answers `null`, and the card stays in its quiet
 * state.
 * @returns the normalized store, or `null` when the namespace could not be read.
 */
export async function fetchWhiteboardStore(): Promise<WhiteboardStoreView | null> {
  try {
    const namespace = await describeOrchestration()
    if (namespace === undefined) return null
    return parseWhiteboardStore(namespace.whiteboard)
  } catch {
    return null
  }
}
