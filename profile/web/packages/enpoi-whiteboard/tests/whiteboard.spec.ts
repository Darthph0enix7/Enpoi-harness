import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_BUDGET_TOKENS,
  WHITEBOARD_CONTEXT_NAME,
  WHITEBOARD_CONTEXT_ORDER,
  applyStoreWrites,
  applyWrites,
  checkBudget,
  estimateTokens,
  findEntryTarget,
  lintPaths,
  migrateLegacyStore,
  normalizeDoc,
  normalizeStore,
  removeEntry,
  removeStoreEntry,
  renderWhiteboard,
  resolveBoard,
  setPinned,
  sweepSessionBoards,
  type WhiteboardBoard,
  type WhiteboardDoc,
  type WhiteboardStore,
} from '../src/board'
import { apply as applyWhiteboard, readWhiteboard, readWhiteboardStore } from '../src/index'

/** In-memory settings service with revision fencing (conflict on a stale writer). */
function makeSettings(initialBoard?: unknown) {
  let board = initialBoard
  let revision = 1
  const mutate = vi.fn(async (_ns: string, ops: Array<{ path: string[]; value: unknown }>, expected?: number) => {
    if (expected !== undefined && expected !== revision) {
      throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
    }
    for (const op of ops) if (op.path.join('.') === 'whiteboard') board = op.value
    revision += 1
  })
  return {
    mutate,
    get board() { return board },
    set board(next: unknown) { board = next },
    get: (ns: string) => (ns === 'enpoi-orchestration' ? { whiteboard: board } : undefined),
    describe: () => [{ ns: 'enpoi-orchestration', revision }],
  }
}

/** Fake ctx capturing registered tool definitions. */
function makeCtx(settings: ReturnType<typeof makeSettings>) {
  const definitions = new Map<string, { name: string; execute: (args: unknown, exec?: unknown) => Promise<Record<string, unknown>>; output?: { schema: unknown } }>()
  const ctx = {
    get: (name: string) => (name === 'settings' ? settings : undefined),
    tools: { register: (definition: { name: string }) => { definitions.set(definition.name, definition as never) } },
    effect: (factory: () => unknown) => factory(),
    on: () => () => {},
  }
  return { ctx, definitions }
}

const sessionExec = { agent: { session: { id: 'sess-1', header: { cwd: '/tmp/opencode/heart-home' } } } }
const otherExec = { agent: { session: { id: 'sess-2', header: { cwd: '/tmp/opencode/heart-home' } } } }
/** A delegated child: durable parent lineage, so the board is read-only. */
const childExec = { agent: { session: { id: 'sess-child', header: { cwd: '/p', parentSession: 'sess-1' } } } }

/** A store with one entry in every layer; the session overrides by id. */
function layeredStore(): WhiteboardStore {
  return normalizeStore({
    version: 9,
    docs: {
      global: {
        version: 2,
        updatedAt: 100,
        entries: [
          { id: 'g1', kind: 'fact', text: 'global one', version: 1 },
          { id: 'g2', kind: 'fact', text: 'global two', version: 1 },
        ],
      },
      projects: {
        '/p': { version: 1, updatedAt: 200, entries: [{ id: 'p1', kind: 'rule', text: 'project one', version: 1 }] },
      },
      sessions: {
        'sess-1': {
          version: 1,
          updatedAt: 300,
          entries: [
            { id: 's1', kind: 'task', text: 'session one', version: 1 },
            { id: 'p1', kind: 'rule', text: 'session override of p1', version: 2 },
          ],
        },
      },
    },
  })
}

describe('enpoi-whiteboard board vocabulary', () => {
  it('normalizes a malformed stored value into the empty board and store', () => {
    expect(normalizeDoc(undefined)).toMatchObject({ version: 0, entries: [] })
    expect(normalizeDoc({ version: 'x', entries: [{ kind: 'bogus', text: 'x' }, { kind: 'rule', text: '' }] })).toMatchObject({ version: 0, entries: [] })
    const store = normalizeStore({ version: 'x', docs: { projects: null, sessions: 'nope' } })
    expect(store).toMatchObject({ version: 0, docs: { projects: {}, sessions: {} } })
    expect(store.docs.global).toBeUndefined()
  })

  it('migrates a legacy single board into the bucket its own scope names', () => {
    const global = normalizeStore({
      version: 4,
      scope: 'global',
      updatedAt: 11,
      entries: [{ id: 'g', kind: 'fact', text: 'global fact', version: 1 }],
    })
    expect(global.version).toBe(4)
    expect(global.docs.global?.entries[0]).toMatchObject({ id: 'g' })
    expect(global.docs.sessions).toEqual({})

    const session = normalizeStore({
      version: 2,
      scope: 'session',
      sessionId: 'sess-9',
      updatedAt: 12,
      entries: [{ id: 's', kind: 'rule', text: 'session rule', version: 1 }],
    })
    expect(session.docs.sessions['sess-9']?.entries[0]).toMatchObject({ id: 's' })
    expect(session.docs.global).toBeUndefined()

    const project = normalizeStore({
      version: 1,
      scope: 'project',
      projectId: '/p',
      updatedAt: 13,
      entries: [{ id: 'p', kind: 'rule', text: 'project rule', version: 1 }],
    })
    expect(project.docs.projects['/p']?.entries[0]).toMatchObject({ id: 'p' })

    // The new shape round-trips through the normalizer unchanged.
    const round = normalizeStore(JSON.parse(JSON.stringify(layeredStore())) as unknown)
    expect(round).toEqual(layeredStore())
  })

  it('migrates the real legacy global board into its writing session and leaves global empty', () => {
    const legacy = {
      version: 4,
      scope: 'global',
      entries: [
        {
          id: 'wb-fact-1',
          kind: 'fact',
          text: 'DeepSeek Harness GUI is running on http://127.0.0.1:3080',
          pinned: true,
          pinnedAt: 1790156322892,
          version: 1,
        },
        {
          id: 'wb-rule-1',
          kind: 'rule',
          text: 'Always run verification before claiming completion',
          pinned: false,
          pinnedAt: 0,
          version: 1,
        },
        {
          id: 'wb-task-1',
          kind: 'task',
          text: 'Demonstrate whiteboard read, write, pin, and replace operations (Completed)',
          pinned: false,
          pinnedAt: 1790156333464,
          version: 2,
        },
      ],
      updatedAt: 1790156496640,
    }
    const sessionId = 'session-297eded4-4cd1-4d61-aacc-3190bb44b09e'
    const first = migrateLegacyStore(legacy, sessionId)
    expect(first.migrated).toBe(true)
    expect(first.attributedTo).toBe(sessionId)
    expect(first.entries).toBe(3)
    expect(first.store.version).toBe(4)
    expect(first.store.docs.global).toBeUndefined()
    expect(first.store.docs.sessions[sessionId]?.entries.map((entry) => entry.id))
      .toEqual(['wb-fact-1', 'wb-rule-1', 'wb-task-1'])
    expect(first.store.docs.sessions[sessionId]?.updatedAt).toBe(1790156496640)

    // The three legacy entries resolve only in the attributed session.
    expect(resolveBoard(first.store, { sessionId }).entries).toHaveLength(3)
    expect(resolveBoard(first.store, { sessionId: 'session-other' }).entries).toHaveLength(0)
    expect(renderWhiteboard(resolveBoard(first.store, { sessionId: 'session-other' }))).toBe('')

    // Deterministic + idempotent: the migrated value is a fixed point.
    const second = migrateLegacyStore(JSON.parse(JSON.stringify(first.store)) as unknown, sessionId)
    expect(second.migrated).toBe(false)
    expect(second.store).toEqual(first.store)

    // The general rule needs no external hint: `meta.writtenBySessionId` alone suffices.
    const stamped = migrateLegacyStore({ ...legacy, meta: { writtenBySessionId: sessionId } })
    expect(stamped.attributedTo).toBe(sessionId)
    expect(stamped.store).toEqual(first.store)
    // Reads apply the same attribution without the migration call.
    expect(normalizeStore({ ...legacy, meta: { writtenBySessionId: sessionId } })).toEqual(first.store)
    // A legacy global without attribution keeps the old global behavior.
    expect(migrateLegacyStore(legacy).store.docs.global?.entries).toHaveLength(3)
  })

  it('removes one entry by id and returns it in full', () => {
    const board = normalizeStore({
      version: 2,
      scope: 'session',
      sessionId: 's',
      entries: [
        { id: 'a', kind: 'rule', text: 'keep', version: 1 },
        { id: 'b', kind: 'fact', text: 'drop me', pinned: true, pinnedAt: 5, version: 3 },
      ],
    }).docs.sessions['s']!
    const removal = removeEntry(board, 'b', 99)
    expect(removal.ok).toBe(true)
    if (!removal.ok) throw new Error('unreachable')
    expect(removal.removed).toMatchObject({ id: 'b', kind: 'fact', text: 'drop me', pinned: true, version: 3 })
    expect(removal.board.entries.map((entry) => entry.id)).toEqual(['a'])
    expect(removal.board.updatedAt).toBe(99)
    expect(removeEntry(board, 'missing', 99).ok).toBe(false)
  })

  it('sweeps session boards to the newest limit and reports what it dropped', () => {
    const store = normalizeStore({
      version: 1,
      docs: {
        sessions: {
          oldest: { version: 1, updatedAt: 10, entries: [{ id: 'a', kind: 'fact', text: 'oldest', version: 1 }] },
          middle: { version: 1, updatedAt: 20, entries: [{ id: 'b', kind: 'fact', text: 'middle', version: 1 }] },
          newest: { version: 1, updatedAt: 30, entries: [{ id: 'c', kind: 'fact', text: 'newest', version: 1 }] },
        },
      },
    })
    const swept = sweepSessionBoards(store, 2)
    expect(swept.dropped).toEqual(['oldest'])
    expect(Object.keys(swept.store.docs.sessions).sort()).toEqual(['middle', 'newest'])
    // A fixed point at or under the limit, and other buckets untouched.
    expect(sweepSessionBoards(store, 3).dropped).toEqual([])
    expect(swept.store.docs.projects).toEqual({})
  })

  it('renders pinned first, marks stale, and carries the board version', () => {
    const doc: WhiteboardBoard = {
      version: 4,
      updatedAt: 0,
      entries: [
        { id: 'a', kind: 'fact', text: 'plain', pinned: false, pinnedAt: 0, version: 1 },
        { id: 'b', kind: 'path', text: 'docs/x.md', pinned: true, pinnedAt: 1, version: 3, stale: true },
      ],
    }
    const rendered = renderWhiteboard(doc)
    expect(rendered.startsWith('### Pinned context (v4)')).toBe(true)
    expect(rendered.indexOf('docs/x.md')).toBeLessThan(rendered.indexOf('plain'))
    expect(rendered).toContain('📌 [path] docs/x.md (stale)')
  })

  it('measures the budget in code points and refuses exactly over the limit', () => {
    const budget = 10
    const doc = normalizeDoc({
      version: 1,
      entries: [{ id: 'a', kind: 'rule', text: 'x'.repeat(200), version: 1 }],
    })
    const check = checkBudget(doc, budget)
    expect(check.ok).toBe(false)
    expect(check.tokens).toBeGreaterThan(check.budget)
    // Multibyte text counts as code points, not UTF-16 units.
    expect(estimateTokens('🎯🎯🎯🎯')).toBe(1)
  })

  it('append rejects a duplicate id; replace bumps the entry version', () => {
    const base = normalizeStore({ version: 1, scope: 'global', entries: [{ id: 'a', kind: 'rule', text: 'one', version: 1 }] }).docs.global!
    const duplicate = applyWrites(base, [{ id: 'a', kind: 'rule', text: 'two' }], 'append', 5)
    expect(duplicate.ok).toBe(false)
    const replaced = applyWrites(base, [{ replaceId: 'a', kind: 'rule', text: 'two' }], 'replace', 5)
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) throw new Error('unreachable')
    expect(replaced.board.entries[0]).toMatchObject({ text: 'two', version: 2 })
  })

  it('lint flags missing paths and never deletes them', () => {
    const board = normalizeStore({
      version: 2,
      scope: 'global',
      entries: [
        { id: 'a', kind: 'path', text: 'missing.md', version: 1 },
        { id: 'b', kind: 'rule', text: 'keep', version: 1 },
      ],
    }).docs.global!
    const { doc: linted, stale } = lintPaths(board, (entry) => `/root/${entry.text}`, (path) => path === '/root/keep.md', 99)
    expect(stale).toEqual(['a'])
    expect(linted.entries).toHaveLength(2)
    expect(linted.entries[0]).toMatchObject({ id: 'a', stale: true, lastValidatedAt: 99 })
    expect(linted.entries[1]!.stale).toBeUndefined()
  })

  it('pin/unpin toggles the flag without touching text or entry version', () => {
    const board = normalizeStore({ version: 1, scope: 'global', entries: [{ id: 'a', kind: 'rule', text: 'one', version: 3 }] }).docs.global!
    const pinned = setPinned(board, 'a', true, 7)
    expect(pinned.ok).toBe(true)
    if (!pinned.ok) throw new Error('unreachable')
    expect(pinned.board.entries[0]).toMatchObject({ pinned: true, pinnedAt: 7, version: 3, text: 'one' })
    const unpinned = setPinned(pinned.board, 'a', false, 8)
    expect(unpinned.ok).toBe(true)
    if (!unpinned.ok) throw new Error('unreachable')
    expect(unpinned.board.entries[0]).toMatchObject({ pinned: false, pinnedAt: 7, version: 3 })
  })

  it('resolves global → project → session, overriding by id with per-entry provenance', () => {
    const resolved = resolveBoard(layeredStore(), { sessionId: 'sess-1', projectId: '/p' })
    expect(resolved.version).toBe(9)
    expect(resolved.scope).toBe('session')
    expect(resolved.updatedAt).toBe(300)
    const byId = new Map(resolved.entries.map((entry) => [entry.id, entry]))
    expect(byId.get('g2')).toMatchObject({ text: 'global two', scope: 'global' })
    expect(byId.get('g1')).toMatchObject({ text: 'global one', scope: 'global' })
    expect(byId.get('p1')).toMatchObject({ text: 'session override of p1', scope: 'session', version: 2 })
    expect(byId.get('s1')).toMatchObject({ text: 'session one', scope: 'session' })
    // Stable merge order: global first, later contributions appended.
    expect(resolved.entries.map((entry) => entry.id)).toEqual(['g1', 'g2', 'p1', 's1'])
  })

  it('resolves an unrelated session without the session-scoped entries', () => {
    const store = layeredStore()
    const other = resolveBoard(store, { sessionId: 'sess-2', projectId: '/p' })
    expect(other.scope).toBe('project')
    expect(other.entries.map((entry) => entry.id)).toEqual(['g1', 'g2', 'p1'])
    expect(other.entries.find((entry) => entry.id === 'p1')).toMatchObject({ text: 'project one', scope: 'project' })
    // A session with no matching project and no parent resolves global only.
    const bare = resolveBoard(store, { sessionId: 'nowhere' })
    expect(bare.entries.map((entry) => [entry.id, entry.scope])).toEqual([['g1', 'global'], ['g2', 'global']])
    expect(bare.scope).toBe('global')
  })

  it('lets a direct child inherit its parent session board', () => {
    const store = normalizeStore({
      version: 1,
      docs: { sessions: { parent: { version: 1, updatedAt: 5, entries: [{ id: 'p', kind: 'rule', text: 'parent rule', version: 1 }] } } },
    })
    const child = resolveBoard(store, { sessionId: 'child', parentSessionId: 'parent' })
    expect(child.entries).toEqual([expect.objectContaining({ id: 'p', scope: 'session' })])
    const childWithOwn = resolveBoard(normalizeStore({
      version: 2,
      docs: {
        sessions: {
          parent: { version: 1, updatedAt: 5, entries: [{ id: 'p', kind: 'rule', text: 'parent rule', version: 1 }] },
          child: { version: 1, updatedAt: 6, entries: [{ id: 'c', kind: 'rule', text: 'child rule', version: 1 }] },
        },
      },
    }), { sessionId: 'child', parentSessionId: 'parent' })
    expect(childWithOwn.entries.map((entry) => entry.id)).toEqual(['p', 'c'])
  })

  it('findEntryTarget prefers the most specific board that holds the id', () => {
    const store = layeredStore()
    const facts = { sessionId: 'sess-1', projectId: '/p' }
    expect(findEntryTarget(store, facts, 's1')).toEqual({ scope: 'session', sessionId: 'sess-1' })
    expect(findEntryTarget(store, facts, 'p1')).toEqual({ scope: 'session', sessionId: 'sess-1' })
    expect(findEntryTarget(store, { sessionId: 'sess-2', projectId: '/p' }, 'p1')).toEqual({ scope: 'project', projectId: '/p' })
    expect(findEntryTarget(store, { sessionId: 'sess-2' }, 'g1')).toEqual({ scope: 'global' })
    expect(findEntryTarget(store, { sessionId: 'sess-2' }, 'nope')).toBeUndefined()
  })

  it('applies a store write to one bucket and bumps that board and the store version', () => {
    const store = layeredStore()
    const applied = applyStoreWrites(store, { scope: 'session', sessionId: 'sess-1' }, [{ id: 'new', kind: 'fact', text: 'added' }], 'append', 42)
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('unreachable')
    const board = applied.store.docs.sessions['sess-1']!
    expect(board.version).toBe(2)
    expect(board.updatedAt).toBe(42)
    expect(board.entries.map((entry) => entry.id)).toEqual(['s1', 'p1', 'new'])
    // Other buckets are untouched copies.
    expect(applied.store.docs.global?.entries).toHaveLength(2)
    expect(applied.store.docs.projects['/p']?.version).toBe(1)
  })
})

/** Minimal JSON-Schema check for the declared tool output contracts. */
function assertSchema(schema: unknown, value: unknown, path: string): void {
  const node = schema as {
    type?: string
    properties?: Record<string, unknown>
    additionalProperties?: boolean
    required?: string[]
    items?: unknown
  } | undefined
  if (node === undefined) throw new Error(`${path}: missing schema`)
  if (node.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected object`)
    const record = value as Record<string, unknown>
    for (const [key, entry] of Object.entries(record)) {
      const property = node.properties?.[key]
      if (property === undefined) {
        if (node.additionalProperties === false) throw new Error(`${path}.${key} is not a declared property`)
        continue
      }
      assertSchema(property, entry, `${path}.${key}`)
    }
    for (const key of node.required ?? []) {
      if (!(key in record)) throw new Error(`${path}.${key} is required`)
    }
    return
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path}: expected array`)
    for (const entry of value) assertSchema(node.items, entry, path)
    return
  }
  if (node.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path}: expected boolean`)
  if (node.type === 'number' && typeof value !== 'number') throw new Error(`${path}: expected number`)
  if (node.type === 'string' && typeof value !== 'string') throw new Error(`${path}: expected string`)
}

describe('enpoi-whiteboard tools', () => {
  it('defaults writes to the calling session and migrates a legacy doc on the way', async () => {
    const settings = makeSettings({
      version: 4,
      scope: 'global',
      updatedAt: 11,
      entries: [{ id: 'legacy', kind: 'fact', text: 'legacy global fact', version: 1 }],
    })
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})

    const write = await definitions.get('whiteboard_write')!.execute({
      entries: [{ id: 'rule-1', kind: 'rule', text: 'Never restart the service without asking.', pinned: true }],
    }, sessionExec)
    expect(write.ok).toBe(true)
    expect(write.version).toBe(5)
    expect(write.scope).toBe('session')
    const stored = settings.board as WhiteboardStore
    expect(stored.version).toBe(5)
    expect(Object.keys(stored.docs.sessions)).toEqual(['sess-1'])
    expect(stored.docs.sessions['sess-1']?.entries[0]).toMatchObject({ id: 'rule-1', pinned: true, version: 1 })
    // The legacy doc lives on in the migrated global bucket.
    expect(stored.docs.global?.entries[0]).toMatchObject({ id: 'legacy' })
    expect(stored.docs.projects).toEqual({})
  })

  it('honors explicit project and global scopes', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const write = definitions.get('whiteboard_write')!

    const global = await write.execute({ scope: 'global', entries: [{ id: 'g', kind: 'fact', text: 'everywhere' }] }, sessionExec)
    expect(global.scope).toBe('global')
    expect((settings.board as WhiteboardStore).docs.global?.entries[0]).toMatchObject({ id: 'g' })

    const project = await write.execute({
      scope: 'project',
      projectId: '/proj',
      entries: [{ id: 'p', kind: 'rule', text: 'this project only' }],
    }, sessionExec)
    expect(project.ok).toBe(true)
    // The result is the caller's resolved view; the entry landed in the project bucket.
    expect(project.scope).toBe('global')
    expect((settings.board as WhiteboardStore).docs.projects['/proj']?.entries[0]).toMatchObject({ id: 'p' })

    // A session inside that project resolves both layers.
    const inProject = { agent: { session: { id: 'sess-3', header: { cwd: '/proj' } } } }
    const projectRead = await definitions.get('whiteboard_read')!.execute({}, inProject)
    expect(projectRead.scope).toBe('project')
    expect((projectRead.entries as Array<Record<string, unknown>>).map((entry) => entry.id)).toEqual(['g', 'p'])

    // Default project scope is the calling session's cwd.
    await write.execute({ projectId: undefined, scope: 'project', entries: [{ id: 'p2', kind: 'rule', text: 'cwd project' }] }, sessionExec)
    expect((settings.board as WhiteboardStore).docs.projects['/tmp/opencode/heart-home']?.entries[0]).toMatchObject({ id: 'p2' })
  })

  it('reads the resolved view and keeps a session entry invisible to another session', async () => {
    const settings = makeSettings(layeredStore())
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})

    const mine = await definitions.get('whiteboard_read')!.execute({}, sessionExec)
    expect(mine.ok).toBe(true)
    expect(mine.scope).toBe('session')
    expect((mine.entries as Array<Record<string, unknown>>).map((entry) => entry.id)).toEqual(['g1', 'g2', 's1', 'p1'])
    expect((mine.entries as Array<Record<string, unknown>>).find((entry) => entry.id === 'p1'))
      .toMatchObject({ text: 'session override of p1', scope: 'session' })
    expect(String(mine.rendered)).toContain('session one')

    // The same project, a different session: the session entry is invisible.
    const theirs = await definitions.get('whiteboard_read')!.execute({}, otherExec)
    expect((theirs.entries as Array<Record<string, unknown>>).map((entry) => entry.id)).toEqual(['g1', 'g2'])
    expect(String(theirs.rendered)).toContain('global one')
    expect(String(theirs.rendered)).not.toContain('session one')
  })

  it('refuses a write over the resolved budget and writes nothing', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    // 50 tokens = 200 rendered characters.
    applyWhiteboard(ctx as never, { budgetTokens: 50 })
    const write = definitions.get('whiteboard_write')!

    const global = await write.execute({
      scope: 'global',
      entries: [{ id: 'g', kind: 'fact', text: 'G'.repeat(90) }],
    }, sessionExec)
    expect(global.ok).toBe(true)
    const before = JSON.stringify(settings.board)

    const session = await write.execute({
      entries: [{ id: 's', kind: 'fact', text: 'S'.repeat(90) }],
    }, sessionExec)
    expect(session.ok).toBe(false)
    expect(String(session.message)).toContain('Over budget')
    expect(Number(session.tokens)).toBeGreaterThan(50)
    expect(JSON.stringify(settings.board)).toBe(before)
  })

  it('forgets one entry in its authoring scope and returns the removed text', async () => {
    const settings = makeSettings(layeredStore())
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})

    const global = await definitions.get('whiteboard_forget')!.execute({ id: 'g1' }, sessionExec)
    expect(global.ok).toBe(true)
    expect(global.removed).toMatchObject({ id: 'g1', kind: 'fact', text: 'global one', scope: 'global', version: 1 })
    expect(String(global.note)).toContain('global one')
    expect((settings.board as WhiteboardStore).docs.global?.entries.map((entry) => entry.id)).toEqual(['g2'])

    const session = await definitions.get('whiteboard_forget')!.execute({ id: 's1' }, sessionExec)
    expect(session.removed).toMatchObject({ id: 's1', text: 'session one', scope: 'session' })
    expect((settings.board as WhiteboardStore).docs.sessions['sess-1']?.entries.map((entry) => entry.id)).toEqual(['p1'])

    // The project board is untouched by a session forget of the entry that overrides it.
    expect((settings.board as WhiteboardStore).docs.projects['/p']?.entries).toHaveLength(1)

    const missing = await definitions.get('whiteboard_forget')!.execute({ id: 'nope' }, sessionExec)
    expect(missing.ok).toBe(false)
    expect(String(missing.message)).toContain('resolved board')
  })

  it('replaces an entry under the default session scope wherever it is authored', async () => {
    const settings = makeSettings(layeredStore())
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const inProject = { agent: { session: { id: 'sess-3', header: { cwd: '/p' } } } }

    // `g1` lives in the global bucket and `p1` in the project bucket for sess-2.
    const global = await definitions.get('whiteboard_write')!.execute({
      mode: 'replace',
      entries: [{ id: 'g1', kind: 'fact', text: 'global one rewritten' }],
    }, otherExec)
    expect(global.ok).toBe(true)
    expect((settings.board as WhiteboardStore).docs.global?.entries.find((entry) => entry.id === 'g1'))
      .toMatchObject({ text: 'global one rewritten', version: 2 })

    const project = await definitions.get('whiteboard_write')!.execute({
      mode: 'replace',
      entries: [{ id: 'p1', kind: 'rule', text: 'project one rewritten' }],
    }, inProject)
    expect(project.ok).toBe(true)
    const stored = settings.board as WhiteboardStore
    expect(stored.docs.projects['/p']?.entries.find((entry) => entry.id === 'p1'))
      .toMatchObject({ text: 'project one rewritten', version: 2 })
    // The session override of p1 stays exactly as authored.
    expect(stored.docs.sessions['sess-1']?.entries.find((entry) => entry.id === 'p1'))
      .toMatchObject({ text: 'session override of p1', version: 2 })

    const missing = await definitions.get('whiteboard_write')!.execute({
      mode: 'replace',
      entries: [{ id: 'nope', kind: 'fact', text: 'x' }],
    }, otherExec)
    expect(missing.ok).toBe(false)
    expect(String(missing.message)).toContain('no entry with id "nope" to replace')
  })

  it('declares output schemas that accept every tool result', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})

    const write = await definitions.get('whiteboard_write')!.execute({ entries: [{ id: 'r1', kind: 'rule', text: 'Rule' }] }, sessionExec)
    const read = await definitions.get('whiteboard_read')!.execute({}, sessionExec)
    const pin = await definitions.get('whiteboard_pin')!.execute({ id: 'r1' }, sessionExec)
    const unpin = await definitions.get('whiteboard_unpin')!.execute({ id: 'r1' }, sessionExec)
    const forget = await definitions.get('whiteboard_forget')!.execute({ id: 'r1' }, sessionExec)

    const results: [string, Record<string, unknown>][] = [
      ['whiteboard_write', write], ['whiteboard_read', read], ['whiteboard_pin', pin], ['whiteboard_unpin', unpin], ['whiteboard_forget', forget],
    ]
    for (const [name, value] of results) {
      const definition = definitions.get(name)
      expect(definition, name).toBeDefined()
      expect(() => { assertSchema(definition!.output?.schema, value, name) }, name).not.toThrow()
    }
  })

  it('flags a missing path entry as stale instead of deleting it', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})

    const result = await definitions.get('whiteboard_write')!.execute({
      entries: [{ id: 'p1', kind: 'path', text: 'definitely-not-a-real-file-9f3a.md' }],
    }, sessionExec)
    expect(result.ok).toBe(true)
    expect(result.stale).toEqual(['p1'])
    const stored = (settings.board as WhiteboardStore).docs.sessions['sess-1']!.entries.find((entry) => entry.id === 'p1')
    expect(stored).toMatchObject({ stale: true, kind: 'path' })
  })

  it('pins and unpins each entry in its own scope', async () => {
    const settings = makeSettings(layeredStore())
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})

    const pinnedGlobal = await definitions.get('whiteboard_pin')!.execute({ id: 'g1' }, sessionExec)
    expect(pinnedGlobal.ok).toBe(true)
    let stored = settings.board as WhiteboardStore
    expect(stored.docs.global?.entries.find((entry) => entry.id === 'g1')?.pinned).toBe(true)
    expect(stored.docs.sessions['sess-1']?.entries.find((entry) => entry.id === 's1')?.pinned).toBe(false)

    const pinnedSession = await definitions.get('whiteboard_pin')!.execute({ id: 's1' }, sessionExec)
    expect(pinnedSession.ok).toBe(true)
    stored = settings.board as WhiteboardStore
    expect(stored.docs.sessions['sess-1']?.entries.find((entry) => entry.id === 's1')?.pinned).toBe(true)
    expect(stored.docs.projects['/p']?.entries.find((entry) => entry.id === 'p1')?.pinned).toBe(false)

    const unpinned = await definitions.get('whiteboard_unpin')!.execute({ id: 'g1' }, sessionExec)
    expect(unpinned.ok).toBe(true)
    stored = settings.board as WhiteboardStore
    expect(stored.docs.global?.entries.find((entry) => entry.id === 'g1')?.pinned).toBe(false)

    const missing = await definitions.get('whiteboard_pin')!.execute({ id: 'nope' }, sessionExec)
    expect(missing.ok).toBe(false)
    expect(String(missing.message)).toContain('resolved board')
  })

  it('keeps a delegated child read-only: reads resolve, every mutation is refused', async () => {
    const settings = makeSettings(layeredStore())
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const before = JSON.stringify(settings.board)

    // Reads still resolve the child's inherited view (parent board included).
    const read = await definitions.get('whiteboard_read')!.execute({}, childExec)
    expect(read.ok).toBe(true)
    expect((read.entries as Array<Record<string, unknown>>).map((entry) => entry.id)).toEqual(['g1', 'g2', 'p1', 's1'])

    // All four mutations are refused with the same clear message.
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['whiteboard_write', await definitions.get('whiteboard_write')!.execute({ entries: [{ id: 'c', kind: 'rule', text: 'child authored' }] }, childExec)],
      ['whiteboard_pin', await definitions.get('whiteboard_pin')!.execute({ id: 's1' }, childExec)],
      ['whiteboard_unpin', await definitions.get('whiteboard_unpin')!.execute({ id: 'g1' }, childExec)],
      ['whiteboard_forget', await definitions.get('whiteboard_forget')!.execute({ id: 'g1' }, childExec)],
    ]
    for (const [name, result] of attempts) {
      expect(result.ok, name).toBe(false)
      expect(result.reason, name).toBe('refused')
      expect(String(result.message), name).toContain('the whiteboard is authored by the main session; children read it')
    }
    expect(JSON.stringify(settings.board)).toBe(before)

    // A main session (no parentSession) keeps full access.
    const main = await definitions.get('whiteboard_write')!.execute({ entries: [{ id: 'm', kind: 'rule', text: 'main authored' }] }, sessionExec)
    expect(main.ok).toBe(true)
    expect((settings.board as WhiteboardStore).docs.sessions['sess-1']?.entries.some((entry) => entry.id === 'm')).toBe(true)
  })

  it('refuses a session write when the execution carries no session id', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const result = await definitions.get('whiteboard_write')!.execute({ entries: [{ id: 'a', kind: 'rule', text: 'x' }] }, {})
    expect(result.ok).toBe(false)
    expect(String(result.message)).toContain('requires a session id')
    expect(settings.board).toBeUndefined()
  })

  it('replays the write across a settings revision conflict (no silent clobber)', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    // First mutate call throws a conflict once, then succeeds on the retry.
    settings.mutate.mockImplementationOnce(async () => {
      throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
    })
    const result = await definitions.get('whiteboard_write')!.execute({ entries: [{ id: 'a', kind: 'rule', text: 'retry me' }] }, sessionExec)
    expect(result.ok).toBe(true)
    expect(settings.mutate).toHaveBeenCalledTimes(2)
  })
})

describe('enpoi-whiteboard context injection (real system-prompt seam)', () => {
  /** Boot the real Context + SystemPrompt seam with a settings stub. */
  async function boot(initial: unknown, budgetTokens = DEFAULT_BUDGET_TOKENS) {
    const { Context } = await import('@deepseek-ai/cordis')
    const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
    const { renderContextSnapshot } = await import('@deepseek-ai/dsh-system-prompt')
    const ctx = new Context() as unknown as {
      plugin: (plugin: unknown, config?: unknown) => Promise<unknown>
      provide: (name: string, value: unknown) => void
      systemPrompt: { assemble: (input: unknown) => Promise<unknown> }
      get: (name: string) => unknown
    }
    const settings = makeSettings(initial)
    ctx.provide('settings', settings)
    await ctx.plugin(SystemPrompt, {})
    applyWhiteboard(ctx as never, { budgetTokens })
    return { ctx, settings, renderContextSnapshot }
  }

  it('migrates a legacy session board and injects it into its own session and direct child only', async () => {
    const { ctx, renderContextSnapshot } = await boot({
      version: 3,
      scope: 'session',
      sessionId: 'parent-session',
      entries: [{ id: 'a', kind: 'path', text: 'docs/67-heart-implementation-plan.md', pinned: true, pinnedAt: 1, version: 2 }],
    })

    const parent = { session: { id: 'parent-session', header: { cwd: '/home/user' } } }
    const parentSnapshot = renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: parent, agent: parent })) as string
    expect(parentSnapshot).toContain('### Pinned context (v3)')
    expect(parentSnapshot).toContain('docs/67-heart-implementation-plan.md')

    // A direct child (durable parentSession lineage) inherits the parent board.
    const child = { session: { id: 'child-session', header: { cwd: '/home/user', parentSession: 'parent-session' } } }
    const childSnapshot = renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: child, agent: child })) as string
    expect(childSnapshot).toContain('### Pinned context (v3)')

    // An unrelated session renders nothing (a session board never leaks).
    const unrelated = { session: { id: 'other-session', header: { cwd: '/home/user' } } }
    const otherSnapshot = renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: unrelated, agent: unrelated })) as string
    expect(otherSnapshot).not.toContain('Pinned context')

    // The contribution sits after the keeper's state checkpoint (130).
    expect(WHITEBOARD_CONTEXT_ORDER).toBeGreaterThan(130)
    expect(WHITEBOARD_CONTEXT_NAME).toBe('whiteboard')
  })

  it('injects each session its own resolved view (global applies everywhere, sessions stay private)', async () => {
    const { ctx, renderContextSnapshot } = await boot(normalizeStore({
      version: 7,
      docs: {
        global: { version: 1, updatedAt: 1, entries: [{ id: 'g', kind: 'fact', text: 'GLOBAL-FACT', version: 1 }] },
        sessions: {
          'session-a': { version: 1, updatedAt: 2, entries: [{ id: 'a', kind: 'rule', text: 'A-ONLY', version: 1 }] },
          'session-b': { version: 1, updatedAt: 3, entries: [{ id: 'b', kind: 'task', text: 'B-ONLY', version: 1 }] },
        },
      },
    }))

    const assemble = async (id: string): Promise<string> => {
      const agent = { session: { id, header: { cwd: '/home/user' } } }
      return renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: agent, agent })) as string
    }

    const a = await assemble('session-a')
    expect(a).toContain('GLOBAL-FACT')
    expect(a).toContain('A-ONLY')
    expect(a).not.toContain('B-ONLY')
    expect(a).toContain('(v7)')

    const b = await assemble('session-b')
    expect(b).toContain('GLOBAL-FACT')
    expect(b).toContain('B-ONLY')
    expect(b).not.toContain('A-ONLY')

    const c = await assemble('session-c')
    expect(c).toContain('GLOBAL-FACT')
    expect(c).not.toContain('A-ONLY')
    expect(c).not.toContain('B-ONLY')
  })
})

describe('enpoi-whiteboard settings fallback', () => {
  it('reads the empty board when settings are unavailable', () => {
    const ctx = { get: () => undefined }
    expect(readWhiteboard(ctx as never)).toMatchObject({ version: 0, entries: [] })
    expect(readWhiteboardStore(ctx as never)).toEqual({ version: 0, docs: { projects: {}, sessions: {} } })
  })
})
