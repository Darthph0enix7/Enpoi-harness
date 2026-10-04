/**
 * enpoi-whiteboard — orchestrator-authored pinned context (doc 66 §3c,
 * doc 67 §B).
 *
 * The board lives in the shared settings namespace `enpoi-orchestration` under
 * `whiteboard` (hot-swappable + cross-device via settings sync), is authored
 * only through the five tools (`whiteboard_read`, `whiteboard_write`,
 * `whiteboard_pin`, `whiteboard_unpin`, `whiteboard_forget`), and is injected
 * through the runtime-context seam (`systemPrompt.context()`, a trailing
 * replace-in-place snapshot) — never the system prompt itself, so the frozen
 * prefix keeps its cache.
 *
 * Boards are stored per scope and resolved per session: global → project
 * (matching the session cwd) → parent session (direct-child inheritance) →
 * session (matching the session id), later scopes overriding earlier ones by
 * entry id. The injected block and every read render the resolved view, so a
 * session-scoped entry never leaks into another session; a legacy single-board
 * document stays readable and migrates into the bucket its own scope names —
 * a legacy `global` board attributed with `meta.writtenBySessionId` migrates
 * into that session's bucket and leaves `global` empty, so every other session
 * resolves empty. The Watchtower card renders only the session half of the
 * resolved view; project/global entries stay behind a collapsed disclosure.
 *
 * Guarantees: a rendered resolved board over the hard budget REFUSES the write
 * (never silently trims); `path` entries are validated on write and flagged
 * `stale` — never deleted; `whiteboard_forget` returns the entry it removed.
 * Session buckets are bounded by a one-sweep-per-activation GC that keeps the
 * newest {@link DEFAULT_MAX_SESSION_BOARDS} boards.
 *
 * @module dsh-enpoi-whiteboard
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_MAX_SESSION_BOARDS,
  WHITEBOARD_CONTEXT_NAME,
  WHITEBOARD_CONTEXT_ORDER,
  applyStoreWrites,
  checkBudget,
  estimateTokens,
  findEntryTarget,
  isWhiteboardScope,
  lintPaths,
  migrateLegacyStore,
  normalizeStore,
  readBoard,
  removeStoreEntry,
  renderWhiteboard,
  resolveBoard,
  setStorePinned,
  sweepSessionBoards,
  versionLine,
  writeBoard,
  type BoardScopeFacts,
  type ResolvedBoard,
  type WhiteboardEntry,
  type WhiteboardStore,
  type WhiteboardTarget,
  type WhiteboardWriteRequest,
} from './board'

/** Cordis plugin name. */
export const name = 'enpoi-whiteboard'

/** The board's storage namespace is a shared service; tools are the write path. */
export const inject = ['tools']

/** Mark a schema subtree live-editable; the pre-0.1.7 vendored schemastery build predates `.volatile()`. */
function live<T extends object>(schema: T): T {
  return (schema as T & { volatile?: () => T }).volatile?.() ?? schema
}

/** Read one effective Config field (Volatile ref on 0.1.7+, plain value before it). */
function value<T>(field: T | Volatile<T> | undefined): T | undefined {
  return typeof (field as Volatile<T> | undefined)?.get === 'function'
    ? (field as Volatile<T>).get()
    : field as T | undefined
}

/** Live-editable whiteboard bounds. */
export interface Config {
  /** Hard rendered-token budget (doc 67 §B); writes over it are refused. */
  budgetTokens?: Volatile<number>
  /** Bounded GC: how many session boards to keep across activations. */
  maxSessionBoards?: Volatile<number>
}

export const Config = Schema.object({
  budgetTokens: live(Schema.number().default(DEFAULT_BUDGET_TOKENS)),
  maxSessionBoards: live(Schema.number().default(DEFAULT_MAX_SESSION_BOARDS)),
})

/** Defaulted plain config handed to the tool/GC closures. */
export interface ResolvedWhiteboardConfig {
  budgetTokens: number
  maxSessionBoards: number
}

/** Shared settings namespace (owned by enpoi-capabilities). */
const ORCH_NS = 'enpoi-orchestration'

/** The structural slice of the settings service this plugin uses. */
interface SettingsLike extends SettingsDocumentReader {
  describe?: () => Array<{ ns: string; revision?: number; value?: unknown }>
  mutate?: (
    ns: string,
    ops: Array<{ op: 'set'; path: string[]; value: unknown }>,
    expectedRevision?: number,
  ) => Promise<unknown>
}

/** The structural slice of the tool-execution identity this plugin uses. */
interface ToolExecLike {
  agent?: {
    session?: {
      id?: string
      header?: { cwd?: string; parentSession?: string }
    }
  }
}

/** The structural slice of `systemPrompt` this plugin uses. */
interface SystemPromptLike {
  context?: (contribution: {
    name: string
    order: number
    text: string | ((assembly: { agent?: ToolExecLike['agent'] }) => string)
  }) => () => void
}

function settingsOf(ctx: Context): SettingsLike | undefined {
  try {
    return ctx.get('settings') as SettingsLike | undefined
  } catch {
    return undefined
  }
}

/** One-time-per-process notice that a legacy board is being read in memory. */
let legacyReadLogged = false

/**
 * Read the current multi-scope store. Never throws: a missing settings service
 * or a malformed value answers the empty store, so the plugin can never break a
 * turn (doc 66 invariant 1). A legacy single-board document is migrated in
 * memory — a `meta.writtenBySessionId` global board lands in that session's
 * bucket — and rewritten in the new shape by the next write or by the one-time
 * settings migration.
 * @param ctx - owning plugin context.
 * @returns the normalized store.
 */
export function readWhiteboardStore(ctx: Context): WhiteboardStore {
  try {
    const doc = readOrchestrationDocument(settingsOf(ctx))
    const migration = migrateLegacyStore(doc?.whiteboard)
    if (migration.migrated && !legacyReadLogged) {
      legacyReadLogged = true
      const destination = migration.attributedTo === undefined ? 'global' : `session ${migration.attributedTo}`
      process.stderr.write(`[enpoi-whiteboard] legacy board read (${migration.entries} entries) — migrated in memory into ${destination}\n`)
    }
    return migration.store
  } catch {
    return normalizeStore(undefined)
  }
}

/**
 * Read the board resolved for one assembly's scope facts (global → project →
 * parent session → session).
 * @param ctx - owning plugin context.
 * @param facts - the reader's scope facts; omitted resolves global only.
 * @returns the resolved view.
 */
export function readWhiteboard(ctx: Context, facts: BoardScopeFacts = {}): ResolvedBoard {
  return resolveBoard(readWhiteboardStore(ctx), facts)
}

/** The cwd a tool call resolves `path` entries against. */
function toolCwd(exec: ToolExecLike | undefined): string {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/** The scope facts one agent contributes (a tool-call session or an assembly). */
function agentFacts(agent: ToolExecLike['agent']): BoardScopeFacts {
  const facts: BoardScopeFacts = {}
  const session = agent?.session
  const id = session?.id
  if (typeof id === 'string' && id.length > 0) facts.sessionId = id
  const parent = session?.header?.parentSession
  if (typeof parent === 'string' && parent.length > 0) facts.parentSessionId = parent
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) facts.projectId = cwd
  return facts
}

/** The scope facts one tool call contributes. */
function sessionFacts(exec: ToolExecLike | undefined): BoardScopeFacts {
  return agentFacts(exec?.agent)
}

/** The refusal every board mutation returns to a delegated child session. */
const CHILD_AUTHORING_REFUSAL = 'the whiteboard is authored by the main session; children read it'

/** Whether one tool execution is a delegated child (a session with a durable parent). */
function isChildSession(exec: ToolExecLike | undefined): boolean {
  return sessionFacts(exec).parentSessionId !== undefined
}

/** Resolve one entry's path text against a cwd (absolute entries pass through). */
function resolveEntryPath(entry: WhiteboardEntry, cwd: string): string {
  return isAbsolute(entry.text) ? entry.text : resolve(cwd, entry.text)
}

/** The board with its path entries linted against the calling session's cwd. */
function linted<T extends { entries: readonly WhiteboardEntry[] }>(doc: T, exec: ToolExecLike | undefined): T {
  const cwd = toolCwd(exec)
  return lintPaths(doc, (entry) => resolveEntryPath(entry, cwd), existsSync, Date.now()).doc
}

/** A write refusal surfaced to the model verbatim. */
function refusal(message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, reason: 'refused', message, ...extra }
}

/** The result of one fenced store commit. */
type CommitResult =
  | { ok: true; store: WhiteboardStore }
  | { ok: false; message: string; tokens?: number; budget?: number }

/**
 * Read-modify-write the store under the namespace revision fence: a concurrent
 * writer (another tool call, or the operator's settings surface) is re-read and
 * the transition replayed, so a write is never silently clobbered. The candidate
 * is budget-checked as the resolved view of `checkFacts` — the audience the
 * write targets (or the writer's own session for a global write).
 * @param ctx - owning plugin context.
 * @param config - resolved plugin config.
 * @param checkFacts - the scope facts the budget check resolves against.
 * @param build - pure transition from the current store to the candidate.
 * @returns the committed store, or a refusal message.
 */
async function commitStore(
  ctx: Context,
  config: ResolvedWhiteboardConfig,
  checkFacts: BoardScopeFacts,
  build: (store: WhiteboardStore, now: number) => { ok: true; store: WhiteboardStore } | { ok: false; message: string },
): Promise<CommitResult> {
  const settings = settingsOf(ctx)
  if (settings?.mutate === undefined) return { ok: false, message: 'settings service unavailable — board not written' }
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = Date.now()
    const current = readWhiteboardStore(ctx)
    const built = build(current, now)
    if (!built.ok) return { ok: false, message: built.message }
    const next: WhiteboardStore = { ...built.store, version: current.version + 1 }
    const check = checkBudget(resolveBoard(next, checkFacts), config.budgetTokens)
    if (!check.ok) {
      return {
        ok: false,
        message: `Over budget: the resolved board renders ${check.tokens} tokens (budget ${check.budget}). Nothing was written.`,
        tokens: check.tokens,
        budget: check.budget,
      }
    }
    const revision = settings.describe?.().find((entry) => entry.ns === ORCH_NS)?.revision
    try {
      await settings.mutate(ORCH_NS, [{ op: 'set', path: ['whiteboard'], value: next }], revision)
      return { ok: true, store: next }
    } catch (error) {
      lastError = error
      if ((error as { code?: string })?.code === 'SETTINGS_CONFLICT' && attempt < 2) continue
      return { ok: false, message: `board write failed: ${String(error)}` }
    }
  }
  return { ok: false, message: `board write failed after retries: ${String(lastError)}` }
}

/**
 * Result fields every whiteboard tool may return (the `boardView` shape plus the
 * optional `note`). Declared once so a tool output schema cannot drift from the
 * real result — `whiteboard_pin`/`whiteboard_unpin` shipped without `scope` and
 * the harness rejected their (correct) output as invalid.
 */
const BOARD_RESULT_PROPERTIES = {
  ok: { type: 'boolean' as const },
  reason: { type: 'string' as const },
  message: { type: 'string' as const },
  version: { type: 'number' as const },
  scope: { type: 'string' as const },
  tokens: { type: 'number' as const },
  budget: { type: 'number' as const },
  entries: { type: 'array' as const, items: { type: 'object' as const, additionalProperties: true } },
  stale: { type: 'array' as const, items: { type: 'string' as const } },
  rendered: { type: 'string' as const },
  versionLine: { type: 'string' as const },
  note: { type: 'string' as const },
}

/** The resolved view plus numbers for one tool result. */
function boardView(resolved: ResolvedBoard, budgetTokens: number): Record<string, unknown> {
  const rendered = renderWhiteboard(resolved)
  const entries = resolved.entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    pinned: entry.pinned,
    version: entry.version,
    scope: entry.scope,
    ...(entry.stale === true ? { stale: true } : {}),
  }))
  const stale = resolved.entries.filter((entry) => entry.stale === true).map((entry) => entry.id)
  return {
    ok: true,
    version: resolved.version,
    scope: resolved.scope,
    tokens: estimateTokens(rendered),
    budget: budgetTokens,
    entries,
    stale,
    rendered,
    versionLine: versionLine(resolved),
  }
}

/** The write target plus the facts its budget check resolves. */
type WriteTarget = { target: WhiteboardTarget; checkFacts: BoardScopeFacts }

/**
 * Resolve one write's storage target. `scope` is explicit or defaults to the
 * caller's own session; explicit `sessionId`/`projectId` override the calling
 * session's identity. The budget check resolves the audience a write targets:
 * a project write checks global + that project, a session write checks the
 * writer's whole resolved view (its own session defaults here), and a global
 * write checks the writer's view — the best available approximation.
 * @param exec - the tool execution identity.
 * @param args - the tool arguments.
 * @returns the target and check facts, or an error message.
 */
function writeTargetFor(exec: ToolExecLike | undefined, args: Record<string, unknown>): WriteTarget | { error: string } {
  const own = sessionFacts(exec)
  const scope = isWhiteboardScope(args.scope) ? args.scope : 'session'
  if (scope === 'global') return { target: { scope: 'global' }, checkFacts: own }
  if (scope === 'project') {
    const explicit = typeof args.projectId === 'string' && args.projectId.length > 0 ? args.projectId : undefined
    const projectId = explicit ?? toolCwd(exec)
    return { target: { scope: 'project', projectId }, checkFacts: { projectId } }
  }
  const explicit = typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : undefined
  const sessionId = explicit ?? own.sessionId
  if (sessionId === undefined) return { error: 'scope "session" requires a session id and this execution has none' }
  return {
    target: { scope: 'session', sessionId },
    checkFacts: sessionId === own.sessionId ? own : { sessionId },
  }
}

/** Stable key for one storage bucket (groups replace requests by authoring board). */
function targetKey(target: WhiteboardTarget): string {
  if (target.scope === 'global') return 'global'
  if (target.scope === 'project') return `project:${target.projectId}`
  return `session:${target.sessionId}`
}

/**
 * Plan one write's storage targets. Append writes, and any write with an
 * explicit `scope`, use the explicit/default target. A replace under the
 * default session scope mirrors pin/unpin's authoring-board targeting: each
 * entry's `replaceId` is replaced where it actually lives (own session →
 * parent session → project → global), so replacing a project or global entry
 * never fails on a session lookup.
 * @param store - the store the transition runs against.
 * @param fallback - the explicit/default target.
 * @param facts - the caller's scope facts.
 * @param requests - the requested entries.
 * @param mode - `append` (default) or `replace` by id.
 * @param explicitScope - whether the caller named a scope.
 * @returns the target groups, or a refusal message.
 */
function planWriteTargets(
  store: WhiteboardStore,
  fallback: WhiteboardTarget,
  facts: BoardScopeFacts,
  requests: readonly WhiteboardWriteRequest[],
  mode: 'append' | 'replace',
  explicitScope: boolean,
): { ok: true; groups: Array<{ target: WhiteboardTarget; requests: WhiteboardWriteRequest[] }> } | { ok: false; message: string } {
  if (mode !== 'replace' || explicitScope) return { ok: true, groups: [{ target: fallback, requests: [...requests] }] }
  const groups: Array<{ target: WhiteboardTarget; requests: WhiteboardWriteRequest[] }> = []
  const byKey = new Map<string, number>()
  for (const request of requests) {
    const id = request.replaceId ?? request.id
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, message: 'mode "replace" requires each entry to carry the id it replaces' }
    }
    const target = findEntryTarget(store, facts, id) ?? fallback
    const key = targetKey(target)
    const at = byKey.get(key)
    if (at === undefined) {
      byKey.set(key, groups.length)
      groups.push({ target, requests: [request] })
    } else groups[at]!.requests.push(request)
  }
  return { ok: true, groups }
}

/** The five board tools (doc 67 §B). */
function registerTools(ctx: Context, config: ResolvedWhiteboardConfig): void {
  const tools = (ctx as unknown as { tools?: { register?: (definition: unknown) => void } }).tools
  if (tools?.register === undefined) {
    process.stderr.write('[enpoi-whiteboard] no tools service — board tools not mounted\n')
    return
  }

  tools.register({
    name: 'whiteboard_read',
    description: [
      'Read the pinned context board resolved for this session: global entries, then this project\'s, then this session\'s (a direct child also inherits its parent session\'s), later scopes overriding earlier ones by entry id.',
      'Every entry reports the scope that authored it. Returns the exact injected block, its token cost, and stale path flags.',
    ].join(' '),
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...BOARD_RESULT_PROPERTIES,
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' },
                pinned: { type: 'boolean' }, version: { type: 'number' }, scope: { type: 'string' },
                stale: { type: 'boolean' },
              },
              required: ['id', 'kind', 'text', 'pinned', 'version', 'scope'],
            },
          },
          stale: { type: 'array', items: { type: 'string' } },
          rendered: { type: 'string' },
          versionLine: { type: 'string' },
        },
        required: ['ok', 'version', 'scope', 'tokens', 'budget', 'entries', 'stale', 'rendered', 'versionLine'],
      },
      render: (_args, value) => [{ type: 'text', text: renderWhiteboardResult(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args: unknown, exec: ToolExecLike) {
      return boardView(linted(readWhiteboard(ctx, sessionFacts(exec)), exec), config.budgetTokens)
    },
  })

  tools.register({
    name: 'whiteboard_write',
    description: [
      'Author the pinned context board for one scope. scope defaults to session (your own session); project stores under your session cwd (or projectId) and applies to that project; global applies to every session.',
      'Append entries, or replace entries by id (every replace bumps the entry version). A replace under the default session scope replaces the entry in the scope that authored it, so a project/global entry is replaced there.',
      'Kinds: path (project-relative path — validated on write, flagged stale when missing, never deleted), rule, fact, task.',
      'The resolved block has a HARD token budget; an over-budget write is refused and nothing changes.',
      'Keep only core context the orchestrator must not have to repeat: current docs, invariants, task state.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['append', 'replace'], description: 'append (default) adds entries; replace overwrites the entry named by replaceId' },
        scope: { type: 'string', enum: ['session', 'project', 'global'], description: 'Where entries land (default: session — the calling session)' },
        sessionId: { type: 'string', description: 'Session id when scope=session (default: the calling session)' },
        projectId: { type: 'string', description: 'Project cwd when scope=project (default: the calling session cwd)' },
        entries: {
          type: 'array',
          description: 'Entries to write',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Stable id; required for append-with-known-id, and the old id for replace' },
              kind: { type: 'string', enum: ['path', 'rule', 'fact', 'task'] },
              text: { type: 'string', description: 'One compact line' },
              pinned: { type: 'boolean', description: 'Pinned entries sort first and are never compacted' },
            },
            required: ['kind', 'text'],
          },
        },
      },
      required: ['entries'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ...BOARD_RESULT_PROPERTIES },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderWriteResult(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolExecLike) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL)
      const mode = args.mode === 'replace' ? 'replace' as const : 'append' as const
      const rawEntries: unknown = args.entries
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) return refusal('entries must be a non-empty array')
      const requests: WhiteboardWriteRequest[] = []
      for (const raw of rawEntries) {
        const row = raw as Record<string, unknown>
        const kind = row.kind
        if (kind !== 'path' && kind !== 'rule' && kind !== 'fact' && kind !== 'task') {
          return refusal(`entries[].kind must be one of path|rule|fact|task (got ${JSON.stringify(kind)})`)
        }
        requests.push({
          kind,
          text: typeof row.text === 'string' ? row.text : '',
          ...(typeof row.id === 'string' ? { id: row.id } : {}),
          ...(mode === 'replace' && typeof row.id === 'string' ? { replaceId: row.id } : {}),
          ...(row.pinned === true ? { pinned: true } : {}),
        })
      }
      const target = writeTargetFor(exec, args)
      if ('error' in target) return refusal(target.error)
      const explicitScope = isWhiteboardScope(args.scope)
      const facts = sessionFacts(exec)
      const committed = await commitStore(ctx, config, target.checkFacts, (store, now) => {
        const plan = planWriteTargets(store, target.target, facts, requests, mode, explicitScope)
        if (!plan.ok) return plan
        let next = store
        for (const group of plan.groups) {
          const applied = applyStoreWrites(next, group.target, group.requests, mode, now)
          if (!applied.ok) return applied
          const board = readBoard(applied.store, group.target)
          next = board === undefined
            ? applied.store
            : writeBoard(applied.store, group.target, linted(board, exec))
        }
        return { ok: true, store: next }
      })
      if (!committed.ok) return refusal(committed.message, committed.tokens === undefined ? {} : { tokens: committed.tokens, budget: committed.budget })
      const resolved = resolveBoard(committed.store, facts)
      const stale = resolved.entries.filter((entry) => entry.stale === true).map((entry) => entry.id)
      return {
        ...boardView(linted(resolved, exec), config.budgetTokens),
        note: stale.length > 0 ? `${stale.length} path entry(ies) flagged stale (missing on disk) — prune or repoint them` : 'written',
      }
    },
  })

  tools.register({
    name: 'whiteboard_pin',
    description: 'Pin a whiteboard entry in the scope that authored it (pinned entries sort first and are never compacted). Pinning never rewrites the entry text.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Entry id from whiteboard_read' } },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ...BOARD_RESULT_PROPERTIES },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderWriteResult(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolExecLike) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL)
      const id = typeof args.id === 'string' ? args.id : ''
      if (id.length === 0) return refusal('id is required')
      const facts = sessionFacts(exec)
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id)
        if (target === undefined) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` }
        return setStorePinned(store, target, id, true, now)
      })
      if (!committed.ok) return refusal(committed.message, committed.tokens === undefined ? {} : { tokens: committed.tokens, budget: committed.budget })
      return { ...boardView(linted(resolveBoard(committed.store, facts), exec), config.budgetTokens), note: `pinned ${id}` }
    },
  })

  tools.register({
    name: 'whiteboard_unpin',
    description: 'Unpin a whiteboard entry in the scope that authored it. Unpinning never deletes the entry; the operator prunes explicitly.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Entry id from whiteboard_read' } },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ...BOARD_RESULT_PROPERTIES },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderWriteResult(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolExecLike) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL)
      const id = typeof args.id === 'string' ? args.id : ''
      if (id.length === 0) return refusal('id is required')
      const facts = sessionFacts(exec)
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id)
        if (target === undefined) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` }
        return setStorePinned(store, target, id, false, now)
      })
      if (!committed.ok) return refusal(committed.message, committed.tokens === undefined ? {} : { tokens: committed.tokens, budget: committed.budget })
      return { ...boardView(linted(resolveBoard(committed.store, facts), exec), config.budgetTokens), note: `unpinned ${id}` }
    },
  })

  tools.register({
    name: 'whiteboard_forget',
    description: 'Delete one whiteboard entry in the scope that authored it (own session, then parent session, then project, then global). The removed entry — including its text — is returned, so nothing is ever dropped silently.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Entry id from whiteboard_read' } },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...BOARD_RESULT_PROPERTIES,
          removed: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' },
              pinned: { type: 'boolean' }, version: { type: 'number' }, scope: { type: 'string' },
            },
            required: ['id', 'kind', 'text', 'pinned', 'version', 'scope'],
          },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderForgetResult(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args: Record<string, unknown>, exec: ToolExecLike) {
      if (isChildSession(exec)) return refusal(CHILD_AUTHORING_REFUSAL)
      const id = typeof args.id === 'string' ? args.id : ''
      if (id.length === 0) return refusal('id is required')
      const facts = sessionFacts(exec)
      let removed: Record<string, unknown> | undefined
      const committed = await commitStore(ctx, config, facts, (store, now) => {
        const target = findEntryTarget(store, facts, id)
        if (target === undefined) return { ok: false, message: `no entry with id "${id}" in this session's resolved board` }
        const result = removeStoreEntry(store, target, id, now)
        if (!result.ok) return result
        removed = {
          id: result.removed.id,
          kind: result.removed.kind,
          text: result.removed.text,
          pinned: result.removed.pinned,
          version: result.removed.version,
          scope: target.scope,
        }
        return { ok: true, store: result.store }
      })
      if (!committed.ok) return refusal(committed.message, committed.tokens === undefined ? {} : { tokens: committed.tokens, budget: committed.budget })
      const view = boardView(linted(resolveBoard(committed.store, facts), exec), config.budgetTokens)
      return removed === undefined
        ? { ...view, note: `forgot ${id}` }
        : { ...view, removed, note: `forgot ${id}: ${String(removed.text)}` }
    },
  })
}

/** Model-facing render for a successful board read. */
function renderWhiteboardResult(value: Record<string, unknown>): string {
  const entries = Array.isArray(value.entries) ? value.entries as Array<Record<string, unknown>> : []
  if (entries.length === 0) return `Whiteboard v${String(value.version)} resolves to no entries for this session (0/${String(value.budget)} tokens).`
  const lines = entries.map((entry) => `• ${entry.pinned === true ? '📌 ' : ''}[${String(entry.kind)}] ${String(entry.text)}${entry.stale === true ? ' (stale)' : ''} — ${String(entry.id)} v${String(entry.version)} · ${String(entry.scope)}`)
  return [...lines, `— v${String(value.version)} · ${String(value.scope)} · ${String(value.tokens)}/${String(value.budget)} tokens`].join('\n')
}

/** Model-facing render for a board mutation (or its refusal). */
function renderWriteResult(value: Record<string, unknown>): string {
  if (value.ok !== true) return String(value.message ?? 'Whiteboard write refused.')
  const stale = Array.isArray(value.stale) ? value.stale as string[] : []
  const head = `Whiteboard v${String(value.version)} (${String(value.scope)}) — ${stale.length} stale path flag(s).`
  const rendered = typeof value.rendered === 'string' && value.rendered.length > 0 ? value.rendered : '(empty)'
  return `${head}\n${rendered}`
}

/** Model-facing render for a forgotten entry — the removed text is always reported. */
function renderForgetResult(value: Record<string, unknown>): string {
  if (value.ok !== true) return String(value.message ?? 'Whiteboard forget refused.')
  const raw = value.removed
  const removed = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
  const head = removed === undefined
    ? 'Whiteboard entry forgotten.'
    : `Forgot [${String(removed.kind)}] ${String(removed.text)} — ${String(removed.id)} (${String(removed.scope)}).`
  const rendered = typeof value.rendered === 'string' && value.rendered.length > 0 ? value.rendered : '(empty)'
  return `${head}\n${rendered}`
}

/** Delay before the activation sweep, so the settings service has mounted. */
const SESSION_SWEEP_DELAY_MS = 2_000

/**
 * Bounded GC: keep only the newest `maxSessionBoards` session buckets. The
 * harness has no session-delete event a plugin can hook (delete disposes the
 * live session and removes its log), so the trigger is one sweep per plugin
 * activation — every profile restart prunes what accumulated. Best-effort: a
 * missing settings service or a conflict leaves the store untouched; one line
 * reports what was dropped.
 * @param ctx - owning plugin context.
 * @param config - resolved plugin config.
 */
async function sweepSessionBoardsNow(ctx: Context, config: ResolvedWhiteboardConfig): Promise<void> {
  const pending = sweepSessionBoards(readWhiteboardStore(ctx), config.maxSessionBoards)
  if (pending.dropped.length === 0) return
  let dropped: string[] = []
  const committed = await commitStore(ctx, config, {}, (current) => {
    const next = sweepSessionBoards(current, config.maxSessionBoards)
    dropped = next.dropped
    return { ok: true, store: next.store }
  })
  if (!committed.ok) {
    process.stderr.write(`[enpoi-whiteboard] session-board GC skipped: ${committed.message}\n`)
    return
  }
  if (dropped.length > 0) {
    process.stderr.write(`[enpoi-whiteboard] session-board GC dropped ${dropped.length} board(s) over the ${config.maxSessionBoards} limit: ${dropped.join(', ')}\n`)
  }
}

/**
 * Schedule the one-time-per-activation bounded GC.
 * @param ctx - owning plugin context.
 * @param config - resolved plugin config.
 */
function scheduleSessionSweep(ctx: Context, config: ResolvedWhiteboardConfig): void {
  const timer = setTimeout(() => {
    void sweepSessionBoardsNow(ctx, config).catch((error: unknown) => {
      process.stderr.write(`[enpoi-whiteboard] session-board GC failed: ${String(error)}\n`)
    })
  }, SESSION_SWEEP_DELAY_MS)
  timer.unref()
  ctx.effect(() => () => { clearTimeout(timer) }, 'enpoi-whiteboard: session-board GC')
}

/**
 * Install the runtime-context contribution. The contribution renders the board
 * resolved for each assembling agent (session → project → global), so every
 * agent sees exactly the entries that apply to it — a session-scoped entry
 * never leaks into another session, and a global entry applies everywhere.
 */
function installInjection(ctx: Context): void {
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
  if (systemPrompt?.context === undefined) {
    process.stderr.write('[enpoi-whiteboard] no systemPrompt service — runtime-context injection skipped\n')
    return
  }
  const dispose = systemPrompt.context({
    name: WHITEBOARD_CONTEXT_NAME,
    order: WHITEBOARD_CONTEXT_ORDER,
    text: (assembly) => {
      try {
        const resolved = resolveBoard(readWhiteboardStore(ctx), agentFacts(assembly?.agent))
        return renderWhiteboard(resolved)
      } catch {
        return ''
      }
    },
  })
  ctx.effect(() => dispose, 'enpoi-whiteboard: runtime-context injection')
}

export function apply(ctx: Context, config: Config = {}): void {
  const budgetTokens = value(config.budgetTokens)
  const maxSessionBoards = value(config.maxSessionBoards)
  const resolved: ResolvedWhiteboardConfig = {
    budgetTokens: typeof budgetTokens === 'number' && Number.isFinite(budgetTokens) && budgetTokens > 0
      ? Math.floor(budgetTokens)
      : DEFAULT_BUDGET_TOKENS,
    maxSessionBoards: typeof maxSessionBoards === 'number' && Number.isFinite(maxSessionBoards) && maxSessionBoards >= 1
      ? Math.floor(maxSessionBoards)
      : DEFAULT_MAX_SESSION_BOARDS,
  }
  registerTools(ctx, resolved)
  installInjection(ctx)
  scheduleSessionSweep(ctx, resolved)
  process.stderr.write(`[enpoi-whiteboard] mounted (budget ${resolved.budgetTokens} tokens, ${resolved.maxSessionBoards} session boards max; per-scope board resolved lazily per assembly; runtime-context seam)\n`)
}
