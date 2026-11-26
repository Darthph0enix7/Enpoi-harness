/**
 * enpoi-capabilities — Session-lineage ownership registry for `dsh-compressor` locators.
 *
 * `dsh-compressor` stores original tool outputs in a content-addressed directory
 * (`$DSH_HOME/dsh-compressor/<sha256>`) keyed solely by hash. This module records
 * the originating session and its ancestor chain whenever the compressor emits a
 * `<<compressor:hash>>` locator for an accepted tool execution, persists the
 * bounded registry to `$DSH_HOME/enpoi-capabilities/compressor-ownership.json`
 * so legitimate retrievals survive process restarts, and enforces caller-lineage
 * ownership before `compressor_retrieve` runs with a uniform model-visible
 * refusal that does not disclose whether a hash exists elsewhere.
 *
 * @module dsh-enpoi-capabilities/compressor-ownership
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Tool name registered by `dsh-compressor` for verbatim recovery. */
export const COMPRESSOR_RETRIEVE_TOOL = 'compressor_retrieve'

/** Uniform refusal returned when a locator is missing, unparseable, unknown, or outside the caller's lineage. */
export const COMPRESSOR_RETRIEVE_DENIAL =
  'compressor_retrieve: locator is unavailable to this session (unknown or not emitted in this session lineage).'

/** Event emitted synchronously by `dsh-compressor` right after crushing a tool output. */
const CONTEXT_COMPRESSION_AFTER = 'contextCompression/after'

const LOCATOR_PATTERN = /<<compressor:([0-9a-fA-F]{64})>>/
const LOCATOR_GLOBAL_PATTERN = /<<compressor:([0-9a-fA-F]{64})>>/g
const BARE_HASH_PATTERN = /^[0-9a-fA-F]{64}$/
const CANONICAL_HASH_PATTERN = /^[0-9a-f]{64}$/
const SPILL_STORED_AT = 'Full formatted result stored at:'
const SPILL_RETRIEVE_HINT = /use read with offset\/limit, or grep this path/i

/** Maximum hops walked along `parentSession` links to bound lineage cycles. */
const MAX_LINEAGE_DEPTH = 32

/** Default maximum distinct locator hashes retained in the side file. */
export const MAX_COMPRESSOR_OWNERSHIP_HASHES = 2048

/** Default maximum distinct originating sessions retained per content hash. */
export const MAX_COMPRESSOR_OWNERS_PER_HASH = 16

/** Default maximum `sessionId -> parentSessionId` links retained for cold multi-hop resolution. */
export const MAX_COMPRESSOR_SESSION_PARENTS = 1024

/** Tools `dsh-compressor` never compresses; echoing a locator from these must never grant ownership. */
const COMPRESSOR_EXCLUDED_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'write',
  'edit',
  'websearch',
  'web_search',
  'webfetch',
  'web_fetch',
  'compressor_retrieve',
  'headroom_retrieve',
])

/** Minimal structural slice of a Session read for identity and parent lineage. */
export interface CompressorSessionLike {
  readonly id?: unknown
  readonly header?: {
    readonly id?: unknown
    readonly parentSession?: unknown
  }
}

/** Optional live session lookup used to walk parent links across active agents/sessions. */
export interface LineageLookup {
  sessionById?: (sessionId: string) => CompressorSessionLike | undefined
}

/** One recorded owner of a compressor hash together with its ancestor chain at emission time. */
export interface CompressorLocatorOwner {
  readonly sessionId: string
  readonly lineage: readonly string[]
  readonly recordedAt: number
}

/** Options configuring the bounded ownership store. */
export interface CompressorOwnershipStoreOptions {
  /** Path to the durable JSON side file; defaults to {@link defaultCompressorOwnershipPath}. */
  readonly storePath?: string
  /** Maximum distinct hashes retained (oldest evicted first). */
  readonly maxHashes?: number
  /** Maximum distinct originating sessions retained per hash. */
  readonly maxOwnersPerHash?: number
  /** Maximum `sessionId -> parentSessionId` entries retained. */
  readonly maxSessionParents?: number
  /** Clock source for `recordedAt` timestamps. */
  readonly now?: () => number
}

/** Durable ownership store contract. */
export interface CompressorOwnershipStore {
  /** Observe a session's `parentSession` link so cold descendants can walk multi-hop lineage after restart. */
  observeSession(session: CompressorSessionLike | undefined): void
  /** Record that `session` emitted `hash` via `dsh-compressor`, persisting durably. */
  record(hash: string, session: CompressorSessionLike | undefined, lookup?: LineageLookup): boolean
  /** Return whether `callerSession` (or an ancestor/descendant) is authorized to retrieve `locatorOrHash`. */
  isAllowed(locatorOrHash: unknown, callerSession: CompressorSessionLike | undefined, lookup?: LineageLookup): boolean
}

interface PersistedEntry {
  hash: string
  owners: CompressorLocatorOwner[]
}

interface PersistedOwnershipDocument {
  version: 1
  entries: PersistedEntry[]
  sessionParents: Array<[string, string]>
}

interface PostExecuteCompressionScope {
  readonly session: CompressorSessionLike
  readonly recordedHashes: Set<string>
}

/**
 * Resolve the default side-file path under `$DSH_HOME/enpoi-capabilities/compressor-ownership.json`
 * (falling back to `~/.dsh/enpoi-capabilities/compressor-ownership.json`).
 * @returns the resolved side-file path.
 */
export function defaultCompressorOwnershipPath(): string {
  const envHome = process.env.DSH_HOME?.trim()
  const root = envHome !== undefined && envHome.length > 0 ? envHome : join(homedir(), '.dsh')
  return join(root, 'enpoi-capabilities', 'compressor-ownership.json')
}

/**
 * Extract and lowercase the 64-hex SHA-256 hash from a `<<compressor:hash>>` locator or bare hash.
 * @param locatorOrHash - tool argument value.
 * @returns lowercase 64-hex hash, or `undefined` when unparseable.
 */
export function extractCompressorHash(locatorOrHash: unknown): string | undefined {
  if (typeof locatorOrHash !== 'string' || locatorOrHash.length === 0) return undefined
  const locatorMatch = locatorOrHash.match(LOCATOR_PATTERN)
  const extracted = locatorMatch?.[1] ?? (BARE_HASH_PATTERN.test(locatorOrHash) ? locatorOrHash : undefined)
  return extracted?.toLowerCase()
}

/**
 * Extract all unique lowercase 64-hex hashes referenced by `<<compressor:hash>>` locators in `text`.
 * @param text - flattened tool result text.
 * @returns unique lowercase hashes in appearance order.
 */
export function extractCompressorHashesFromText(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  LOCATOR_GLOBAL_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LOCATOR_GLOBAL_PATTERN.exec(text)) !== null) {
    const hash = match[1]?.toLowerCase()
    if (hash !== undefined && !seen.has(hash)) {
      seen.add(hash)
      out.push(hash)
    }
  }
  return out
}

/**
 * Flatten string or ContentBlock[] tool output text into a single string for locator scanning.
 * @param content - raw tool result or decision content.
 * @returns concatenated text, or `undefined` when no text blocks are present.
 */
export function flattenContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      parts.push(candidate.text)
    }
  }
  return parts.length > 0 ? parts.join('') : undefined
}

/**
 * Return whether `toolName` is excluded from compression by `dsh-compressor`.
 * @param toolName - invoked tool name.
 * @returns `true` for excluded tools.
 */
export function isExcludedCompressorTool(toolName: string | undefined): boolean {
  return toolName !== undefined && COMPRESSOR_EXCLUDED_TOOLS.has(toolName.toLowerCase())
}

/**
 * Return whether `text` already carries an official DSH spill notice.
 * @param text - flattened tool result text.
 * @returns `true` when the text contains a spill notice.
 */
export function isOfficialSpillNoticeText(text: string): boolean {
  return text.includes(SPILL_STORED_AT) && SPILL_RETRIEVE_HINT.test(text)
}

function sessionIdOf(session: CompressorSessionLike | undefined): string | undefined {
  if (session === undefined || session === null || typeof session !== 'object') return undefined
  if (typeof session.header?.id === 'string' && session.header.id !== '') return session.header.id
  if (typeof session.id === 'string' && session.id !== '') return session.id
  return undefined
}

function parentSessionOf(session: CompressorSessionLike | undefined): string | undefined {
  if (session === undefined || session === null || typeof session !== 'object') return undefined
  const parent = session.header?.parentSession
  return typeof parent === 'string' && parent !== '' ? parent : undefined
}

function isValidOwner(value: unknown): value is CompressorLocatorOwner {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record['sessionId'] !== 'string' || record['sessionId'] === '') return false
  if (!Array.isArray(record['lineage']) || record['lineage'].length === 0) return false
  if (!record['lineage'].every(item => typeof item === 'string' && item !== '')) return false
  if (typeof record['recordedAt'] !== 'number' || !Number.isFinite(record['recordedAt'])) return false
  return true
}

function readPersistedState(
  storePath: string,
  maxHashes: number,
  maxOwnersPerHash: number,
  maxSessionParents: number,
): { hashes: Map<string, CompressorLocatorOwner[]>; sessionParents: Map<string, string> } {
  const hashes = new Map<string, CompressorLocatorOwner[]>()
  const sessionParents = new Map<string, string>()
  let raw: string
  try {
    raw = readFileSync(storePath, 'utf8')
  } catch {
    return { hashes, sessionParents }
  }
  let parsed: Partial<PersistedOwnershipDocument>
  try {
    parsed = JSON.parse(raw) as Partial<PersistedOwnershipDocument>
  } catch {
    return { hashes, sessionParents }
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) {
    return { hashes, sessionParents }
  }
  if (Array.isArray(parsed.entries)) {
    for (const entry of parsed.entries) {
      if (entry === null || typeof entry !== 'object') continue
      const candidate = entry as { hash?: unknown; owners?: unknown }
      if (typeof candidate.hash !== 'string') continue
      const hash = candidate.hash.toLowerCase()
      if (!CANONICAL_HASH_PATTERN.test(hash) || !Array.isArray(candidate.owners)) continue
      const validOwners: CompressorLocatorOwner[] = []
      const seenOwners = new Set<string>()
      for (const owner of candidate.owners) {
        if (!isValidOwner(owner) || seenOwners.has(owner.sessionId)) continue
        seenOwners.add(owner.sessionId)
        validOwners.push({
          sessionId: owner.sessionId,
          lineage: [...owner.lineage],
          recordedAt: owner.recordedAt,
        })
      }
      if (validOwners.length > 0) {
        const trimmed = validOwners.slice(-maxOwnersPerHash)
        hashes.delete(hash)
        hashes.set(hash, trimmed)
      }
    }
    while (hashes.size > maxHashes) {
      const oldest = hashes.keys().next().value
      if (oldest === undefined) break
      hashes.delete(oldest)
    }
  }
  if (Array.isArray(parsed.sessionParents)) {
    for (const pair of parsed.sessionParents) {
      if (!Array.isArray(pair) || pair.length !== 2) continue
      const [child, parent] = pair as [unknown, unknown]
      if (typeof child !== 'string' || child === '' || typeof parent !== 'string' || parent === '' || child === parent) {
        continue
      }
      sessionParents.delete(child)
      sessionParents.set(child, parent)
    }
    while (sessionParents.size > maxSessionParents) {
      const oldest = sessionParents.keys().next().value
      if (oldest === undefined) break
      sessionParents.delete(oldest)
    }
  }
  return { hashes, sessionParents }
}

/**
 * Create a bounded, restart-persistent compressor locator ownership store.
 * @param options - storage path, bounds, and clock overrides.
 * @returns the ownership store instance.
 */
export function createCompressorOwnershipStore(
  options: CompressorOwnershipStoreOptions = {},
): CompressorOwnershipStore {
  const storePath = options.storePath ?? defaultCompressorOwnershipPath()
  const maxHashes = Math.max(1, options.maxHashes ?? MAX_COMPRESSOR_OWNERSHIP_HASHES)
  const maxOwnersPerHash = Math.max(1, options.maxOwnersPerHash ?? MAX_COMPRESSOR_OWNERS_PER_HASH)
  const maxSessionParents = Math.max(1, options.maxSessionParents ?? MAX_COMPRESSOR_SESSION_PARENTS)
  const now = options.now ?? (() => Date.now())

  let loaded: { hashes: Map<string, CompressorLocatorOwner[]>; sessionParents: Map<string, string> } | undefined
  let writeSeq = 0

  function state(): { hashes: Map<string, CompressorLocatorOwner[]>; sessionParents: Map<string, string> } {
    loaded ??= readPersistedState(storePath, maxHashes, maxOwnersPerHash, maxSessionParents)
    return loaded
  }

  function persist(current: { hashes: Map<string, CompressorLocatorOwner[]>; sessionParents: Map<string, string> }): void {
    const doc: PersistedOwnershipDocument = {
      version: 1,
      entries: Array.from(current.hashes.entries(), ([hash, owners]) => ({ hash, owners })),
      sessionParents: Array.from(current.sessionParents.entries()),
    }
    const temporary = `${storePath}.tmp.${process.pid}.${++writeSeq}`
    try {
      mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, `${JSON.stringify(doc)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, storePath)
    } catch {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // Best-effort cleanup of failed atomic temp file.
      }
    }
  }

  function setParentLink(
    current: { hashes: Map<string, CompressorLocatorOwner[]>; sessionParents: Map<string, string> },
    childId: string,
    parentId: string,
  ): boolean {
    if (childId === '' || parentId === '' || childId === parentId) return false
    const existing = current.sessionParents.get(childId)
    if (existing === parentId) {
      current.sessionParents.delete(childId)
      current.sessionParents.set(childId, parentId)
      return false
    }
    current.sessionParents.delete(childId)
    current.sessionParents.set(childId, parentId)
    while (current.sessionParents.size > maxSessionParents) {
      const oldest = current.sessionParents.keys().next().value
      if (oldest === undefined) break
      current.sessionParents.delete(oldest)
    }
    return true
  }

  function resolveLineage(
    current: { hashes: Map<string, CompressorLocatorOwner[]>; sessionParents: Map<string, string> },
    session: CompressorSessionLike | undefined,
    lookup?: LineageLookup,
  ): { lineage: string[]; parentChanged: boolean } {
    const startId = sessionIdOf(session)
    if (startId === undefined) return { lineage: [], parentChanged: false }
    const seen = new Set<string>()
    const lineage: string[] = []
    let parentChanged = false
    let currentId: string | undefined = startId
    let currentSession: CompressorSessionLike | undefined = session
    for (let hop = 0; hop <= MAX_LINEAGE_DEPTH && currentId !== undefined; hop += 1) {
      if (seen.has(currentId)) break
      seen.add(currentId)
      lineage.push(currentId)
      const directParent = parentSessionOf(currentSession)
      const lookedUpParent: string | undefined = directParent ?? parentSessionOf(lookup?.sessionById?.(currentId))
      const parentId: string | undefined = lookedUpParent ?? current.sessionParents.get(currentId)
      if (parentId !== undefined && parentId !== currentId) {
        if (lookedUpParent !== undefined && setParentLink(current, currentId, lookedUpParent)) {
          parentChanged = true
        }
        currentId = parentId
        currentSession = lookup?.sessionById?.(parentId)
      } else {
        currentId = undefined
        currentSession = undefined
      }
    }
    return { lineage, parentChanged }
  }

  return {
    observeSession(session) {
      const sid = sessionIdOf(session)
      const parent = parentSessionOf(session)
      if (sid === undefined || parent === undefined || sid === parent) return
      const current = state()
      if (setParentLink(current, sid, parent)) {
        persist(current)
      }
    },

    record(rawHash, session, lookup) {
      const hash = rawHash.toLowerCase()
      if (!CANONICAL_HASH_PATTERN.test(hash)) return false
      const current = state()
      const { lineage } = resolveLineage(current, session, lookup)
      if (lineage.length === 0) return false
      const ownerId = lineage[0]!
      const existingOwners = current.hashes.get(hash) ?? []
      const nextOwners = existingOwners.filter(entry => entry.sessionId !== ownerId)
      nextOwners.push({
        sessionId: ownerId,
        lineage,
        recordedAt: now(),
      })
      while (nextOwners.length > maxOwnersPerHash) {
        nextOwners.shift()
      }
      current.hashes.delete(hash)
      current.hashes.set(hash, nextOwners)
      while (current.hashes.size > maxHashes) {
        const oldest = current.hashes.keys().next().value
        if (oldest === undefined) break
        current.hashes.delete(oldest)
      }
      persist(current)
      return true
    },

    isAllowed(locatorOrHash, callerSession, lookup) {
      const hash = extractCompressorHash(locatorOrHash)
      if (hash === undefined) return false
      const current = state()
      const { lineage: callerLineage, parentChanged } = resolveLineage(current, callerSession, lookup)
      if (parentChanged) persist(current)
      if (callerLineage.length === 0) return false
      const callerId = callerLineage[0]!
      const callerAncestors = new Set(callerLineage)
      const owners = current.hashes.get(hash)
      if (owners === undefined) return false
      return owners.some(owner =>
        owner.sessionId === callerId
        || callerAncestors.has(owner.sessionId)
        || owner.lineage.includes(callerId),
      )
    },
  }
}

/**
 * Evaluate whether a `compressor_retrieve` execution is authorized for its caller session lineage.
 * @param exec - tool execution descriptor.
 * @param store - compressor ownership store.
 * @param lookup - optional live session lookup for multi-hop lineage resolution.
 * @returns uniform refusal reason string when denied, or `undefined` when permitted (or another tool).
 */
export function evaluateCompressorRetrieve(
  exec: { readonly name: string; readonly arguments?: unknown; readonly agent?: unknown },
  store: CompressorOwnershipStore,
  lookup?: LineageLookup,
): string | undefined {
  if (exec.name !== COMPRESSOR_RETRIEVE_TOOL) return undefined
  const args = exec.arguments
  const locator = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? (args as { locator?: unknown }).locator
    : undefined
  return store.isAllowed(locator, sessionOfExec(exec), lookup) ? undefined : COMPRESSOR_RETRIEVE_DENIAL
}

function sessionOfExec(exec: unknown): CompressorSessionLike | undefined {
  if (exec === null || typeof exec !== 'object') return undefined
  const agent = (exec as { agent?: unknown }).agent
  if (agent === null || typeof agent !== 'object') return undefined
  const session = (agent as { session?: unknown }).session
  return session !== null && typeof session === 'object' ? (session as CompressorSessionLike) : undefined
}

/**
 * Install post-execute and `contextCompression/after` listeners that record originating
 * session lineage for every `<<compressor:hash>>` locator emitted by `dsh-compressor`,
 * and observe `session/created` parent links.
 * @param ctx - Cordis plugin context.
 * @param store - compressor ownership store.
 * @param lookup - optional live session lookup for multi-hop lineage resolution.
 * @returns disposer unregistering all installed listeners.
 */
export function installCompressorOwnership(
  ctx: Pick<Context, 'on'>,
  store: CompressorOwnershipStore,
  lookup?: LineageLookup,
): () => void {
  if (typeof ctx.on !== 'function') return () => {}
  const activeScope = new AsyncLocalStorage<PostExecuteCompressionScope>()

  const disposeCreated = ctx.on('session/created', ((session: CompressorSessionLike) => {
    store.observeSession(session)
  }) as (...args: unknown[]) => unknown)

  const disposeAfter = ctx.on(CONTEXT_COMPRESSION_AFTER as never, ((payload: unknown) => {
    const scope = activeScope.getStore()
    if (scope === undefined || payload === null || typeof payload !== 'object') return
    const record = payload as { source?: unknown; messages?: unknown }
    if (record.source !== 'tools/post-execute' || !Array.isArray(record.messages)) return
    for (const msg of record.messages) {
      if (msg === null || typeof msg !== 'object') continue
      const content = (msg as { content?: unknown }).content
      if (typeof content !== 'string') continue
      for (const hash of extractCompressorHashesFromText(content)) {
        if (!scope.recordedHashes.has(hash)) {
          scope.recordedHashes.add(hash)
          store.record(hash, scope.session, lookup)
        }
      }
    }
  }) as never)

  const disposePost = ctx.on('tools/post-execute', (async (
    exec: { name?: string },
    result: { content?: unknown },
    next: () => Promise<{ kind?: string; content?: unknown }>,
  ) => {
    const execSession = sessionOfExec(exec)
    store.observeSession(execSession)
    const beforeText = flattenContentText(result?.content) ?? ''
    const beforeHashes = new Set(extractCompressorHashesFromText(beforeText))
    const excluded = isExcludedCompressorTool(exec?.name)
    const beforeWasSpill = isOfficialSpillNoticeText(beforeText)
    const scope: PostExecuteCompressionScope | undefined = execSession !== undefined
      ? { session: execSession, recordedHashes: new Set<string>() }
      : undefined
    const decision = scope !== undefined
      ? await activeScope.run(scope, next)
      : await next()
    if (
      scope !== undefined
      && !excluded
      && !beforeWasSpill
      && decision !== null
      && typeof decision === 'object'
      && decision.kind === 'accept'
      && decision.content !== undefined
    ) {
      const afterText = flattenContentText(decision.content)
      if (afterText !== undefined) {
        for (const hash of extractCompressorHashesFromText(afterText)) {
          if (!beforeHashes.has(hash) && !scope.recordedHashes.has(hash)) {
            scope.recordedHashes.add(hash)
            store.record(hash, scope.session, lookup)
          }
        }
      }
    }
    return decision
  }) as never, { prepend: true })

  return () => {
    disposePost()
    disposeAfter()
    disposeCreated()
  }
}
