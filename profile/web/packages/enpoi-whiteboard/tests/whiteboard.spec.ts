import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BUDGET_TOKENS,
  WHITEBOARD_CONTEXT_NAME,
  WHITEBOARD_CONTEXT_ORDER,
  applyStoreWrites,
  applyWrites,
  checkBudget,
  classifyPathText,
  estimateTokens,
  findEntryTarget,
  lintPaths,
  migrateLegacyStore,
  normalizeDoc,
  normalizeEntry,
  normalizeStore,
  readBoard,
  removeEntry,
  removeStoreEntry,
  renderWhiteboard,
  resolveBoard,
  setPinned,
  sweepSessionBoards,
  type WhiteboardBoard,
  type WhiteboardDoc,
  type WhiteboardEntry,
  type WhiteboardStore,
  writeBoard,
} from '../src/board'
import { apply as applyWhiteboard, readWhiteboard, readWhiteboardStore, resolvedBoard } from '../src/index'

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

/** Production-shaped settings: describe() carries { ns, value, revision }; get() must not be needed. */
function makeDescriptorSettings(initialBoard?: unknown) {
  let board = initialBoard
  let revision = 1
  let describeCalls = 0
  const get = vi.fn((_ns: string): unknown => {
    throw new Error('descriptor settings must not read through get()')
  })
  const mutate = vi.fn(async (_ns: string, ops: Array<{ path: string[]; value: unknown }>, expected?: number) => {
    if (expected !== undefined && expected !== revision) {
      throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
    }
    for (const op of ops) if (op.path.join('.') === 'whiteboard') board = op.value
    revision += 1
  })
  return {
    mutate,
    get,
    get board() { return board },
    set board(next: unknown) { board = next },
    describe: () => {
      describeCalls += 1
      return [{ ns: 'enpoi-orchestration', value: { whiteboard: board }, revision }]
    },
    get describeCalls() { return describeCalls },
  }
}

/** Fake ctx capturing registered tool definitions. */
function makeCtx(settings: object) {
  const definitions = new Map<string, {
    name: string
    execute: (args: unknown, exec?: unknown) => Promise<Record<string, unknown>>
    output?: {
      schema: unknown
      render?: (args: unknown, value: Record<string, unknown>) => Array<{ type: string; text: string }>
    }
  }>()
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

  it('keeps __proto__/constructor bucket ids as own data and never reads Object.prototype', () => {
    const empty = normalizeStore(undefined)
    expect(JSON.stringify(empty)).toBe('{"version":0,"docs":{"projects":{},"sessions":{}}}')
    expect(readBoard(empty, { scope: 'session', sessionId: '__proto__' })).toBeUndefined()
    expect(readBoard(empty, { scope: 'session', sessionId: 'constructor' })).toBeUndefined()
    expect(readBoard(empty, { scope: 'project', projectId: '__proto__' })).toBeUndefined()
    expect(resolveBoard(empty, { projectId: '__proto__', sessionId: 'constructor', parentSessionId: 'constructor' }).entries).toEqual([])
    expect(findEntryTarget(empty, { sessionId: '__proto__', projectId: 'constructor' }, 'toString')).toBeUndefined()

    const sessionBoard: WhiteboardBoard = {
      version: 1,
      updatedAt: 1,
      entries: [{ id: '__proto__', kind: 'fact', text: 'proto', pinned: false, pinnedAt: 0, version: 1 }],
    }
    const projectBoard: WhiteboardBoard = {
      version: 1,
      updatedAt: 2,
      entries: [{ id: 'constructor', kind: 'fact', text: 'ctor', pinned: false, pinnedAt: 0, version: 1 }],
    }
    const written = writeBoard(
      writeBoard(empty, { scope: 'session', sessionId: '__proto__' }, sessionBoard),
      { scope: 'project', projectId: 'constructor' },
      projectBoard,
    )
    expect(readBoard(written, { scope: 'session', sessionId: '__proto__' })?.entries[0]?.id).toBe('__proto__')
    expect(readBoard(written, { scope: 'project', projectId: 'constructor' })?.entries[0]?.id).toBe('constructor')
    expect(resolveBoard(written, { sessionId: '__proto__', projectId: 'constructor' }).entries.map((entry) => entry.id))
      .toEqual(['constructor', '__proto__'])
    expect(findEntryTarget(written, { sessionId: '__proto__', projectId: 'constructor' }, '__proto__'))
      .toEqual({ scope: 'session', sessionId: '__proto__' })
    expect(findEntryTarget(written, { sessionId: '__proto__', projectId: 'constructor' }, 'constructor'))
      .toEqual({ scope: 'project', projectId: 'constructor' })

    const serialized = JSON.stringify(written)
    expect(serialized).toContain('"__proto__"')
    expect(serialized).toContain('"constructor"')
    expect(JSON.stringify(JSON.parse(serialized))).toBe(serialized)
    const parsed = normalizeStore(JSON.parse(serialized))
    expect(parsed.docs.sessions['__proto__']?.entries[0]?.id).toBe('__proto__')
    expect(parsed.docs.projects['constructor']?.entries[0]?.id).toBe('constructor')
    expect(Object.hasOwn(parsed.docs.sessions, '__proto__')).toBe(true)
    expect(Object.hasOwn(parsed.docs.projects, 'constructor')).toBe(true)
    expect(Object.getPrototypeOf(parsed.docs.sessions)).toBeNull()
    expect(Object.getPrototypeOf(parsed.docs.projects)).toBeNull()
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, 'entries')).toBe(false)
  })

  it('sweeps __proto__/constructor session ids without prototype leakage', () => {
    let store = normalizeStore(undefined)
    store = writeBoard(store, { scope: 'session', sessionId: '__proto__' }, {
      version: 1,
      updatedAt: 10,
      entries: [{ id: 'p', kind: 'fact', text: 'p', pinned: false, pinnedAt: 0, version: 1 }],
    })
    store = writeBoard(store, { scope: 'session', sessionId: 'constructor' }, {
      version: 1,
      updatedAt: 20,
      entries: [{ id: 'c', kind: 'fact', text: 'c', pinned: false, pinnedAt: 0, version: 1 }],
    })
    const swept = sweepSessionBoards(store, 1)
    expect(swept.dropped).toEqual(['__proto__'])
    expect(Object.keys(swept.store.docs.sessions)).toEqual(['constructor'])
    expect(Object.hasOwn(swept.store.docs.sessions, 'constructor')).toBe(true)
    expect(Object.hasOwn(swept.store.docs.sessions, '__proto__')).toBe(false)
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it('renders pinned first, marks stale, and keeps the injected block version-free', () => {
    const doc: WhiteboardBoard = {
      version: 4,
      updatedAt: 0,
      entries: [
        { id: 'a', kind: 'fact', text: 'plain', pinned: false, pinnedAt: 0, version: 1 },
        { id: 'b', kind: 'path', text: 'docs/x.md', pinned: true, pinnedAt: 1, version: 3, stale: true },
      ],
    }
    const rendered = renderWhiteboard(doc)
    expect(rendered.startsWith('### Pinned context\n')).toBe(true)
    // A store version is bookkeeping, not injected content: version-only writes
    // must not churn the request context.
    expect(rendered).not.toContain('(v4)')
    expect(rendered.indexOf('docs/x.md')).toBeLessThan(rendered.indexOf('plain'))
    expect(rendered).toContain('📌 [path] docs/x.md (stale)')
    // The version still renders in the freshness line for spawns/read results.
    expect(renderWhiteboard({ ...doc, version: 5 })).toBe(rendered)
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

  it('classifies exactly one filesystem path and treats prose, lists, URLs, globs, and foreign absolutes as unknown', () => {
    expect(classifyPathText('docs/plan.md')).toEqual({ kind: 'path', path: 'docs/plan.md' })
    expect(classifyPathText('"docs/my plan.md"')).toEqual({ kind: 'path', path: 'docs/my plan.md' })
    expect(classifyPathText("'docs/my plan.md'")).toEqual({ kind: 'path', path: 'docs/my plan.md' })
    expect(classifyPathText('`docs/my plan.md`')).toEqual({ kind: 'path', path: 'docs/my plan.md' })
    expect(classifyPathText('/home/adam/docs/plan.md')).toEqual({ kind: 'path', path: '/home/adam/docs/plan.md', absolute: 'posix' })
    expect(classifyPathText('C:\\Users\\Adam\\plan.md')).toEqual({ kind: 'path', path: 'C:\\Users\\Adam\\plan.md', absolute: 'windows' })
    expect(classifyPathText('\\\\server\\share\\plan.md')).toMatchObject({ kind: 'path', absolute: 'windows' })
    expect(classifyPathText('docs/my plan.md')).toEqual({ kind: 'unknown', reason: 'multiple' })
    expect(classifyPathText('path plan-docs /home/a.md /home/b.md')).toEqual({ kind: 'unknown', reason: 'multiple' })
    expect(classifyPathText('see docs/a.md')).toEqual({ kind: 'unknown', reason: 'multiple' })
    expect(classifyPathText('docs/a.md\n/home/b.md')).toEqual({ kind: 'unknown', reason: 'multiline' })
    expect(classifyPathText('docs/*.md')).toEqual({ kind: 'unknown', reason: 'glob' })
    expect(classifyPathText('docs/plan[1].md')).toEqual({ kind: 'unknown', reason: 'glob' })
    expect(classifyPathText('"docs/plan[1].md"')).toMatchObject({ kind: 'path', path: 'docs/plan[1].md' })
    expect(classifyPathText('"/tmp/{x}/a.md"')).toMatchObject({ kind: 'path', path: '/tmp/{x}/a.md', absolute: 'posix' })
    expect(classifyPathText('"path?.md"')).toMatchObject({ kind: 'path', path: 'path?.md' })
    expect(classifyPathText('https://example.com/plan.md')).toEqual({ kind: 'unknown', reason: 'url' })
    expect(classifyPathText('a plain sentence')).toEqual({ kind: 'unknown', reason: 'multiple' })
    expect(classifyPathText('plan-docs')).toEqual({ kind: 'unknown', reason: 'prose' })
    expect(classifyPathText('"my notes"')).toEqual({ kind: 'unknown', reason: 'prose' })
    expect(classifyPathText('"my notes.md"')).toMatchObject({ kind: 'path', path: 'my notes.md' })
    expect(classifyPathText('')).toEqual({ kind: 'unknown', reason: 'empty' })
  })

  it('lints only exact single paths and reports mixed/foreign entries as unknown, not stale', () => {
    const board: WhiteboardBoard = {
      version: 1,
      updatedAt: 1,
      entries: [
        { id: 'posix', kind: 'path', text: '/repo/docs/plan.md', pinned: false, pinnedAt: 0, version: 1 },
        { id: 'prose', kind: 'path', text: 'path plan-docs /repo/docs/a.md /repo/docs/b.md', pinned: false, pinnedAt: 0, version: 1, stale: true, lastValidatedAt: 77 },
        { id: 'missing', kind: 'path', text: 'missing.md', pinned: false, pinnedAt: 0, version: 1 },
        { id: 'win', kind: 'path', text: 'C:\\Users\\Adam\\plan.md', pinned: false, pinnedAt: 0, version: 1, lastValidatedAt: 77 },
        { id: 'rule', kind: 'rule', text: 'not a path', pinned: false, pinnedAt: 0, version: 1 },
      ],
    }
    const { doc: linted, stale, unknown } = lintPaths(board, (_entry, path) => path, (path) => path === '/repo/docs/plan.md', 42)
    expect(stale).toEqual(['missing'])
    expect(unknown).toEqual(['prose', 'win'])
    expect(linted.entries.find((entry) => entry.id === 'prose')!.stale).toBeUndefined()
    expect(linted.entries.find((entry) => entry.id === 'prose')!.lastValidatedAt).toBeUndefined()
    expect(linted.entries.find((entry) => entry.id === 'missing')).toMatchObject({ stale: true, lastValidatedAt: 42 })
    expect(linted.entries.find((entry) => entry.id === 'win')!.stale).toBeUndefined()
    expect(linted.entries.find((entry) => entry.id === 'win')!.lastValidatedAt).toBeUndefined()
    expect(linted.entries.find((entry) => entry.id === 'rule')!.stale).toBeUndefined()
    // A Win32 host checks the Windows absolute path and treats the POSIX one as foreign.
    const win = lintPaths(board, (_entry, path) => path === 'C:\\Users\\Adam\\plan.md' ? '/present' : path, () => true, 43, 'windows')
    expect(win.stale).toEqual([])
    expect(win.unknown).toEqual(['posix', 'prose'])
  })

  it('drops a legacy false stale flag on normalize and preserves real path stale flags', () => {
    const prose = normalizeEntry({ id: 'plan-docs', kind: 'path', text: 'path plan-docs /a.md /b.md', stale: true, lastValidatedAt: 77, version: 2 })
    expect(prose).toMatchObject({ id: 'plan-docs', kind: 'path', text: 'path plan-docs /a.md /b.md' })
    expect(prose!.stale).toBeUndefined()
    expect(prose!.lastValidatedAt).toBeUndefined()
    const missing = normalizeEntry({ id: 'm', kind: 'path', text: 'definitely-missing.md', stale: true, version: 1 })
    expect(missing!.stale).toBe(true)
    // Non-path kinds never carry a stale flag from stored data.
    expect(normalizeEntry({ id: 'r', kind: 'rule', text: 'prose', stale: true, version: 1 })!.stale).toBeUndefined()
  })

  it('refuses new path text that is not exactly one path while preserving legacy values on pin-only edits', () => {
    const base = normalizeStore({ version: 1, scope: 'global', entries: [{ id: 'a', kind: 'rule', text: 'one', version: 1 }] }).docs.global!
    const prose = applyWrites(base, [{ id: 'p', kind: 'path', text: 'path plan-docs /a.md /b.md' }], 'append', 1)
    expect(prose.ok).toBe(false)
    if (prose.ok) throw new Error('unreachable')
    expect(prose.message).toContain('exactly one filesystem path')
    const glob = applyWrites(base, [{ id: 'g', kind: 'path', text: 'docs/*.md' }], 'append', 1)
    expect(glob.ok).toBe(false)
    const quoted = applyWrites(base, [{ id: 'q', kind: 'path', text: '"docs/my plan.md"' }], 'append', 1)
    expect(quoted.ok).toBe(true)
    if (!quoted.ok) throw new Error('unreachable')
    expect(quoted.changedIds).toEqual(['q'])
    // Existing mixed prose/path text is not re-judged when only the pin changes.
    const legacy: WhiteboardBoard = {
      ...base,
      entries: [{ id: 'legacy', kind: 'path', text: 'path plan-docs /a.md /b.md', pinned: false, pinnedAt: 0, version: 1 }],
    }
    const pin = applyWrites(legacy, [{ replaceId: 'legacy', kind: 'path', text: 'path plan-docs /a.md /b.md', pinned: true }], 'replace', 2)
    expect(pin.ok).toBe(true)
    if (!pin.ok) throw new Error('unreachable')
    expect(pin.changedIds).toEqual(['legacy'])
    expect(pin.board.entries[0]).toMatchObject({ pinned: true, version: 2, text: 'path plan-docs /a.md /b.md' })
  })

  it('treats an identical append or replace as a deterministic no-op', () => {
    const base = normalizeStore({ version: 1, scope: 'global', entries: [{ id: 'a', kind: 'rule', text: 'one', version: 2 }] }).docs.global!
    const append = applyWrites(base, [{ id: 'a', kind: 'rule', text: ' one ' }], 'append', 5)
    expect(append.ok).toBe(true)
    if (!append.ok) throw new Error('unreachable')
    expect(append.changedIds).toEqual([])
    expect(append.board.entries[0]).toMatchObject({ text: 'one', version: 2 })
    const replace = applyWrites(base, [{ replaceId: 'a', kind: 'rule', text: 'one', pinned: false }], 'replace', 6)
    expect(replace.ok).toBe(true)
    if (!replace.ok) throw new Error('unreachable')
    expect(replace.changedIds).toEqual([])
    expect(replace.board.entries[0]!.version).toBe(2)
    const edit = applyWrites(base, [{ replaceId: 'a', kind: 'rule', text: 'two' }], 'replace', 7)
    expect(edit.ok).toBe(true)
    if (!edit.ok) throw new Error('unreachable')
    expect(edit.changedIds).toEqual(['a'])
    expect(edit.board.entries[0]!.version).toBe(3)
    const duplicateDifferent = applyWrites(base, [{ id: 'a', kind: 'rule', text: 'two' }], 'append', 8)
    expect(duplicateDifferent.ok).toBe(false)
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

  it('checks a default project and a global write against the caller full resolved view', async () => {
    const long = 'x'.repeat(300)
    const settings = makeSettings(normalizeStore({
      version: 1,
      docs: {
        projects: {
          '/tmp/opencode/heart-home': { version: 1, updatedAt: 1, entries: [{ id: 'proj', kind: 'fact', text: long, version: 1 }] },
        },
        sessions: {
          'sess-1': { version: 1, updatedAt: 1, entries: [{ id: 'sess', kind: 'fact', text: long, version: 1 }] },
        },
      },
    }))
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, { budgetTokens: 100 })
    const before = JSON.stringify(settings.board)
    const write = definitions.get('whiteboard_write')!
    const project = await write.execute({
      scope: 'project',
      entries: [{ id: 'new-project', kind: 'fact', text: 'tiny addition' }],
    }, sessionExec)
    expect(project.ok).toBe(false)
    expect(String(project.message)).toContain('Over budget')
    expect(settings.mutate).not.toHaveBeenCalled()
    expect(JSON.stringify(settings.board)).toBe(before)
    const global = await write.execute({
      scope: 'global',
      entries: [{ id: 'new-global', kind: 'fact', text: 'tiny addition' }],
    }, sessionExec)
    expect(global.ok).toBe(false)
    expect(String(global.message)).toContain('Over budget')
    expect(settings.mutate).not.toHaveBeenCalled()
    expect(JSON.stringify(settings.board)).toBe(before)
  })

  it('checks an explicit foreign project on its own view and reports checked vs caller tokens', async () => {
    const settings = makeSettings(normalizeStore({
      version: 1,
      docs: {
        sessions: {
          'sess-1': { version: 1, updatedAt: 1, entries: [{ id: 'caller', kind: 'fact', text: 'c'.repeat(400), version: 1 }] },
        },
        projects: {
          '/foreign': { version: 1, updatedAt: 1, entries: [{ id: 'foreign', kind: 'fact', text: 'small', version: 1 }] },
        },
      },
    }))
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, { budgetTokens: 100 })
    const write = await definitions.get('whiteboard_write')!.execute({
      scope: 'project',
      projectId: '/foreign',
      entries: [{ id: 'new', kind: 'fact', text: 'foreign addition' }],
    }, sessionExec)
    expect(write.ok).toBe(true)
    expect(write.checkedFacts).toMatchObject({ projectId: '/foreign' })
    expect(write.checkedScope).toBe('project')
    expect(write.scope).toBe('session')
    expect(Number(write.tokens)).toBeLessThanOrEqual(100)
    expect(Number(write.callerTokens)).toBeGreaterThan(100)
    expect(write.tokens).not.toBe(write.callerTokens)
    const rendered = definitions.get('whiteboard_write')!.output!.render!({}, write).map((part) => part.text).join('\n')
    expect(rendered).toContain(`read session ${String(write.callerTokens)} tok`)
    expect(rendered).toContain(`checked project ${String(write.tokens)}/100 tok`)
    expect(settings.mutate).toHaveBeenCalledTimes(1)
    expect((settings.board as WhiteboardStore).docs.projects['/foreign']?.entries.map((entry) => entry.id))
      .toEqual(['foreign', 'new'])
  })

  it('returns a short write receipt instead of the full board', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const write = await definitions.get('whiteboard_write')!.execute({
      entries: [{ id: 'r1', kind: 'rule', text: 'Keep the receipt short' }],
    }, sessionExec)
    expect(write.ok).toBe(true)
    expect(write.op).toBe('append')
    expect(write.changedIds).toEqual(['r1'])
    expect(write.changedTotal).toBe(1)
    expect(write.entries).toBeUndefined()
    expect(write.rendered).toBeUndefined()
    expect(write.versionLine).toBeUndefined()
    expect(write.tokens).toBeGreaterThan(0)
    expect(write.budget).toBe(DEFAULT_BUDGET_TOKENS)
    const rendered = definitions.get('whiteboard_write')!.output!.render!({}, write).map((part) => part.text).join('\n')
    expect(rendered).toContain('append: r1')
    expect(rendered).not.toContain('Keep the receipt short')
    expect(Array.from(rendered).length).toBeLessThanOrEqual(600)
    // The read tool remains the full view.
    const read = await definitions.get('whiteboard_read')!.execute({}, sessionExec)
    expect((read.entries as Array<Record<string, unknown>>).map((entry) => entry.id)).toEqual(['r1'])
    expect(String(read.rendered)).toContain('Keep the receipt short')
    expect(read.unknown).toEqual([])
  })

  it('keeps read rendered/tokens on the stored view while live lint reports a deleted path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-stored-'))
    try {
      mkdirSync(join(root, 'docs'), { recursive: true })
      const file = join(root, 'docs', 'plan.md')
      writeFileSync(file, 'present')
      const exec = { agent: { session: { id: 'sess-stored', header: { cwd: root } } } }
      const settings = makeSettings()
      const { ctx, definitions } = makeCtx(settings)
      applyWhiteboard(ctx as never, {})
      await definitions.get('whiteboard_write')!.execute({
        entries: [{ id: 'p', kind: 'path', text: 'docs/plan.md' }],
      }, exec)
      const read = definitions.get('whiteboard_read')!
      const first = await read.execute({}, exec)
      expect(first.stale).toEqual([])
      expect(Number(first.tokens)).toBeGreaterThan(0)
      const firstRendered = String(first.rendered)
      const firstTokens = Number(first.tokens)
      rmSync(file)
      const second = await read.execute({}, exec)
      expect(second.rendered).toBe(firstRendered)
      expect(second.tokens).toBe(firstTokens)
      expect((second.entries as Array<Record<string, unknown>>).find((entry) => entry.id === 'p'))
        .toMatchObject({ stale: true })
      expect(second.stale).toEqual(['p'])
      // The exact injected block is the stored resolved view, not the live lint view.
      const stored = resolvedBoard(settings, { sessionId: 'sess-stored', projectId: root })
      expect(renderWhiteboard(stored)).toBe(firstRendered)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps receipt checked tokens on the stored view when live lint adds a stale marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-receipt-'))
    try {
      mkdirSync(join(root, 'docs'), { recursive: true })
      const file = join(root, 'docs', 'plan.md')
      writeFileSync(file, 'present')
      const exec = { agent: { session: { id: 'sess-receipt', header: { cwd: root } } } }
      const settings = makeSettings()
      const { ctx, definitions } = makeCtx(settings)
      applyWhiteboard(ctx as never, {})
      const write = definitions.get('whiteboard_write')!
      const first = await write.execute({
        entries: [{ id: 'p', kind: 'path', text: 'docs/plan.md' }],
      }, exec)
      expect(first.ok).toBe(true)
      expect(first.stale).toEqual([])
      const firstTokens = Number(first.tokens)
      rmSync(file)
      const noop = await write.execute({
        mode: 'replace',
        entries: [{ id: 'p', kind: 'path', text: 'docs/plan.md' }],
      }, exec)
      expect(noop.ok).toBe(true)
      expect(noop.op).toBe('unchanged')
      expect(noop.tokens).toBe(firstTokens)
      expect(noop.stale).toEqual(['p'])
      expect((settings.board as WhiteboardStore).docs.sessions['sess-receipt']?.entries[0]?.stale).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('makes an identical replace a no-op: no store write, version bump, or injection change', async () => {
    const settings = makeSettings(normalizeStore({
      version: 3,
      docs: {
        sessions: {
          'sess-1': { version: 1, updatedAt: 1, entries: [{ id: 'a', kind: 'fact', text: 'stable fact', version: 1 }] },
        },
      },
    }))
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const before = JSON.stringify(settings.board)
    const mutateCalls = settings.mutate.mock.calls.length
    const write = definitions.get('whiteboard_write')!
    const noop = await write.execute({ mode: 'replace', entries: [{ id: 'a', kind: 'fact', text: 'stable fact' }] }, sessionExec)
    expect(noop.ok).toBe(true)
    expect(noop.op).toBe('unchanged')
    expect(noop.changedIds).toEqual([])
    expect(noop.version).toBe(3)
    expect(JSON.stringify(settings.board)).toBe(before)
    expect(settings.mutate.mock.calls.length).toBe(mutateCalls)
    // A real edit commits one new store version.
    const edit = await write.execute({ mode: 'replace', entries: [{ id: 'a', kind: 'fact', text: 'edited fact' }] }, sessionExec)
    expect(edit.ok).toBe(true)
    expect(edit.op).toBe('replace')
    expect(edit.changedIds).toEqual(['a'])
    expect(edit.version).toBe(4)
    expect(settings.mutate.mock.calls.length).toBe(mutateCalls + 1)
  })

  it('treats a repeated append with identical content as a no-op', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const write = definitions.get('whiteboard_write')!
    const first = await write.execute({ entries: [{ id: 'same', kind: 'rule', text: 'same body' }] }, sessionExec)
    expect(first.ok).toBe(true)
    expect(first.op).toBe('append')
    const second = await write.execute({ entries: [{ id: 'same', kind: 'rule', text: 'same body' }] }, sessionExec)
    expect(second.ok).toBe(true)
    expect(second.op).toBe('unchanged')
    expect(second.version).toBe(first.version)
    expect(settings.mutate).toHaveBeenCalledTimes(1)
  })

  it('bounds the changed-id list in a large write receipt', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const entries = Array.from({ length: 12 }, (_, index) => ({ id: `e${index}`, kind: 'fact', text: `fact ${index}` }))
    const write = await definitions.get('whiteboard_write')!.execute({ entries }, sessionExec)
    expect(write.ok).toBe(true)
    expect((write.changedIds as string[]).length).toBeLessThanOrEqual(8)
    expect(write.changedTotal).toBe(12)
    const rendered = definitions.get('whiteboard_write')!.output!.render!({}, write).map((part) => part.text).join('\n')
    expect(rendered).toContain('append: e0')
    expect(rendered).toContain('(+4 more)')
    expect(Array.from(rendered).length).toBeLessThanOrEqual(600)
  })

  it('bounds stale and unverified ids in the write receipt while read reports all', async () => {
    const staleEntries = Array.from({ length: 12 }, (_, index) => ({
      id: `stale-${index}`, kind: 'path' as const, text: `missing-${index}.md`, version: 1,
    }))
    const proseEntries = Array.from({ length: 12 }, (_, index) => ({
      id: `prose-${index}`, kind: 'path' as const, text: `path plan-${index} /a.md /b.md`, version: 1,
    }))
    const settings = makeSettings(normalizeStore({
      version: 1,
      docs: {
        sessions: {
          'sess-1': { version: 1, updatedAt: 1, entries: [...staleEntries, ...proseEntries] },
        },
      },
    }))
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const write = await definitions.get('whiteboard_write')!.execute({
      entries: [{ id: 'new', kind: 'fact', text: 'one more fact' }],
    }, sessionExec)
    expect(write.ok).toBe(true)
    expect((write.stale as string[]).length).toBeLessThanOrEqual(8)
    expect(write.staleTotal).toBe(12)
    expect((write.unknown as string[]).length).toBeLessThanOrEqual(8)
    expect(write.unknownTotal).toBe(12)
    const rendered = definitions.get('whiteboard_write')!.output!.render!({}, write).map((part) => part.text).join('\n')
    expect(Array.from(rendered).length).toBeLessThanOrEqual(600)
    expect(rendered).toContain('stale 12')
    expect(rendered).toContain('unverified path 12')
    const read = await definitions.get('whiteboard_read')!.execute({}, sessionExec)
    expect((read.stale as string[]).length).toBe(12)
    expect((read.unknown as string[]).length).toBe(12)
    expect((read.entries as Array<Record<string, unknown>>).length).toBe(25)
    const readText = definitions.get('whiteboard_read')!.output!.render!({}, read).map((part) => part.text).join('\n')
    expect(readText).toContain('Unverified path entries (not stale)')
  })

  it('validates quoted spaced paths on disk and never labels prose or a foreign absolute stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-'))
    try {
      mkdirSync(join(root, 'docs with space'), { recursive: true })
      writeFileSync(join(root, 'docs with space', 'plan.md'), 'present')
      const exec = { agent: { session: { id: 'sess-fs', header: { cwd: root } } } }
      const settings = makeSettings(normalizeStore({
        version: 1,
        docs: {
          sessions: {
            'sess-fs': {
              version: 1,
              updatedAt: 1,
              entries: [
                { id: 'prose', kind: 'path', text: 'see docs with space/plan.md for context', version: 1 },
                { id: 'win', kind: 'path', text: 'C:\\Users\\Adam\\plan.md', version: 1 },
              ],
            },
          },
        },
      }))
      const { ctx, definitions } = makeCtx(settings)
      applyWhiteboard(ctx as never, {})
      const write = definitions.get('whiteboard_write')!
      const result = await write.execute({
        entries: [
          { id: 'quoted', kind: 'path', text: '"docs with space/plan.md"' },
          { id: 'single', kind: 'path', text: "'docs with space/plan.md'" },
          { id: 'absolute', kind: 'path', text: `"${join(root, 'docs with space', 'plan.md')}"` },
        ],
      }, exec)
      expect(result.ok).toBe(true)
      expect(result.stale).toEqual([])
      expect((result.unknown as string[]).sort()).toEqual(['prose', 'win'])
      const stored = (settings.board as WhiteboardStore).docs.sessions['sess-fs']!
      for (const id of ['quoted', 'single', 'absolute']) {
        expect(stored.entries.find((entry) => entry.id === id)!.stale, id).toBeUndefined()
      }
      expect(stored.entries.find((entry) => entry.id === 'prose')!.text).toBe('see docs with space/plan.md for context')
      expect(stored.entries.find((entry) => entry.id === 'prose')!.stale).toBeUndefined()
      expect(stored.entries.find((entry) => entry.id === 'win')!.stale).toBeUndefined()
      // A new unquoted path containing prose spaces is refused, not stored as a false path.
      const before = JSON.stringify(settings.board)
      const bad = await write.execute({ entries: [{ id: 'bad', kind: 'path', text: 'docs with space/plan.md' }] }, exec)
      expect(bad.ok).toBe(false)
      expect(String(bad.message)).toContain('exactly one filesystem path')
      expect(JSON.stringify(settings.board)).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats quoted glob metacharacters as literal paths and refuses unquoted globs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-meta-'))
    try {
      mkdirSync(join(root, 'docs'), { recursive: true })
      mkdirSync(join(root, '{x}'), { recursive: true })
      writeFileSync(join(root, 'docs', 'plan[1].md'), 'present')
      writeFileSync(join(root, 'path?.md'), 'present')
      writeFileSync(join(root, '{x}', 'a.md'), 'present')
      const exec = { agent: { session: { id: 'sess-meta', header: { cwd: root } } } }
      const settings = makeSettings()
      const { ctx, definitions } = makeCtx(settings)
      applyWhiteboard(ctx as never, {})
      const write = definitions.get('whiteboard_write')!
      const result = await write.execute({
        entries: [
          { id: 'bracket', kind: 'path', text: '"docs/plan[1].md"' },
          { id: 'brace', kind: 'path', text: `"${join(root, '{x}', 'a.md')}"` },
          { id: 'question', kind: 'path', text: '"path?.md"' },
          { id: 'missing', kind: 'path', text: '"docs/missing[1].md"' },
        ],
      }, exec)
      expect(result.ok).toBe(true)
      expect(result.stale).toEqual(['missing'])
      expect(result.unknown).toEqual([])
      const stored = (settings.board as WhiteboardStore).docs.sessions['sess-meta']!
      expect(stored.entries.find((entry) => entry.id === 'bracket')!.stale).toBeUndefined()
      expect(stored.entries.find((entry) => entry.id === 'brace')!.stale).toBeUndefined()
      expect(stored.entries.find((entry) => entry.id === 'question')!.stale).toBeUndefined()
      expect(stored.entries.find((entry) => entry.id === 'missing')).toMatchObject({ stale: true })
      const glob = await write.execute({ entries: [{ id: 'glob', kind: 'path', text: 'docs/*.md' }] }, exec)
      expect(glob.ok).toBe(false)
      expect(String(glob.message)).toContain('exactly one filesystem path')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lints a project path against the project cwd and keeps it scoped to that project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wb-scope-'))
    try {
      mkdirSync(join(root, 'docs'), { recursive: true })
      writeFileSync(join(root, 'docs', 'plan.md'), 'present')
      const settings = makeSettings()
      const { ctx, definitions } = makeCtx(settings)
      applyWhiteboard(ctx as never, {})
      const write = await definitions.get('whiteboard_write')!.execute({
        scope: 'project',
        projectId: root,
        entries: [{ id: 'project-path', kind: 'path', text: 'docs/plan.md' }],
      }, sessionExec)
      expect(write.ok).toBe(true)
      expect(write.stale).toEqual([])
      expect((settings.board as WhiteboardStore).docs.projects[root]?.entries[0]?.id).toBe('project-path')
      expect((settings.board as WhiteboardStore).docs.projects[root]?.entries[0]?.stale).toBeUndefined()
      const inProject = { agent: { session: { id: 'sess-in-project', header: { cwd: root } } } }
      const read = await definitions.get('whiteboard_read')!.execute({}, inProject)
      expect(read.stale).toEqual([])
      expect((read.entries as Array<Record<string, unknown>>).find((entry) => entry.id === 'project-path'))
        .toMatchObject({ kind: 'path', scope: 'project' })
      const elsewhere = { agent: { session: { id: 'sess-elsewhere', header: { cwd: '/tmp/opencode/elsewhere' } } } }
      const other = await definitions.get('whiteboard_read')!.execute({}, elsewhere)
      expect((other.entries as Array<Record<string, unknown>>).map((entry) => entry.id)).not.toContain('project-path')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts unicode as whole code points and keeps an over-budget refusal bounded', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, { budgetTokens: 12 })
    const write = definitions.get('whiteboard_write')!
    const result = await write.execute({ entries: [{ id: 'u1', kind: 'fact', text: '🎯'.repeat(10) }] }, sessionExec)
    expect(result.ok).toBe(true)
    const resolved = resolvedBoard(settings, { sessionId: 'sess-1', projectId: '/tmp/opencode/heart-home' })
    expect(result.tokens).toBe(estimateTokens(renderWhiteboard(resolved)))
    expect(result.budget).toBe(12)
    expect(result.rendered).toBeUndefined()
    const rendered = definitions.get('whiteboard_write')!.output!.render!({}, result).map((part) => part.text).join('\n')
    expect(Array.from(rendered).length).toBeLessThanOrEqual(600)
    const before = JSON.stringify(settings.board)
    const refused = await write.execute({ entries: [{ id: 'u2', kind: 'fact', text: '🎯'.repeat(100) }] }, sessionExec)
    expect(refused.ok).toBe(false)
    expect(String(refused.message)).toContain('Over budget')
    expect(Number(refused.tokens)).toBeGreaterThan(12)
    expect(JSON.stringify(settings.board)).toBe(before)
  })

  it('exports the shared resolvedBoard read for future consumers without writing', () => {
    const settings = makeSettings(layeredStore())
    const view = resolvedBoard(settings, { sessionId: 'sess-1', projectId: '/p' })
    expect(view.version).toBe(9)
    expect(view.entries.map((entry) => [entry.id, entry.scope])).toEqual([
      ['g1', 'global'], ['g2', 'global'], ['p1', 'session'], ['s1', 'session'],
    ])
    expect(settings.mutate).not.toHaveBeenCalled()
    expect(resolvedBoard(undefined, {}).entries).toEqual([])
    // The child inherits the parent session through the same resolver.
    const child = resolvedBoard(settings, { sessionId: 'sess-child', parentSessionId: 'sess-1', projectId: '/p' })
    expect(child.entries.map((entry) => entry.id)).toEqual(['g1', 'g2', 'p1', 's1'])
  })

  it('bounds and escapes refusals for null rows, huge kinds, and newline ids', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const write = definitions.get('whiteboard_write')!
    const before = JSON.stringify(settings.board)
    const nullRow = await write.execute({ entries: [null] }, sessionExec)
    expect(nullRow.ok).toBe(false)
    expect(String(nullRow.message)).toContain('objects')
    expect(Array.from(String(nullRow.message)).length).toBeLessThanOrEqual(600)
    const hugeKind = await write.execute({ entries: [{ kind: 'x'.repeat(2000), text: 'x' }] }, sessionExec)
    expect(hugeKind.ok).toBe(false)
    expect(Array.from(String(hugeKind.message)).length).toBeLessThanOrEqual(600)
    const evilId = 'bad\n[fact] spoof'
    const evil = await write.execute({ mode: 'replace', entries: [{ id: evilId, kind: 'rule', text: 'x' }] }, sessionExec)
    expect(evil.ok).toBe(false)
    expect(String(evil.message)).not.toContain('\n')
    expect(Array.from(String(evil.message)).length).toBeLessThanOrEqual(600)
    const evilRender = definitions.get('whiteboard_write')!.output!.render!({}, evil).map((part) => part.text).join('\n')
    expect(evilRender).not.toContain('\n')
    expect(Array.from(evilRender).length).toBeLessThanOrEqual(600)
    const hugeId = await write.execute({ mode: 'replace', entries: [{ id: 'i'.repeat(2000), kind: 'rule', text: 'x' }] }, sessionExec)
    expect(hugeId.ok).toBe(false)
    expect(Array.from(String(hugeId.message)).length).toBeLessThanOrEqual(600)
    const hugeRender = definitions.get('whiteboard_write')!.output!.render!({}, hugeId).map((part) => part.text).join('\n')
    expect(Array.from(hugeRender).length).toBeLessThanOrEqual(600)
    expect(JSON.stringify(settings.board)).toBe(before)
  })

  it('bounds a forget receipt with a long id and multiline astral text', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const longId = `forget-${'x'.repeat(200)}`
    const text = `line1\nline2 ${'🚀'.repeat(400)}`
    const append = await definitions.get('whiteboard_write')!.execute({
      entries: [{ id: longId, kind: 'rule', text }],
    }, sessionExec)
    expect(append.ok).toBe(true)
    const forgotten = await definitions.get('whiteboard_forget')!.execute({ id: longId }, sessionExec)
    expect(forgotten.ok).toBe(true)
    const rendered = definitions.get('whiteboard_forget')!.output!.render!({}, forgotten).map((part) => part.text).join('\n')
    expect(Array.from(rendered).length).toBeLessThanOrEqual(600)
    expect(rendered).not.toContain(longId)
    expect(rendered).toContain('line1\\nline2')
    expect(rendered.isWellFormed()).toBe(true)
    expect((forgotten.removed as Record<string, unknown>).text).toBe(text)
  })

  it('counts astral receipt bounds in code points for success and refusal', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const write = definitions.get('whiteboard_write')!
    const id = '🚀'.repeat(40)
    const success = await write.execute({ entries: [{ id, kind: 'fact', text: 'astral' }] }, sessionExec)
    expect(success.ok).toBe(true)
    expect(success.changedIds).toEqual([id])
    const successRender = definitions.get('whiteboard_write')!.output!.render!({}, success).map((part) => part.text).join('\n')
    expect(Array.from(successRender).length).toBeLessThanOrEqual(600)
    expect(successRender.isWellFormed()).toBe(true)
    const bad = await write.execute({ entries: [{ kind: '🚀'.repeat(500), text: 'x' }] }, sessionExec)
    expect(bad.ok).toBe(false)
    const badRender = definitions.get('whiteboard_write')!.output!.render!({}, bad).map((part) => part.text).join('\n')
    expect(Array.from(badRender).length).toBeLessThanOrEqual(600)
    expect(badRender.isWellFormed()).toBe(true)
  })

  it('reads production describe values without get and fences conflict retries to the same snapshot', async () => {
    const settings = makeDescriptorSettings(normalizeStore({
      version: 1,
      docs: {
        global: { version: 1, updatedAt: 1, entries: [{ id: 'old', kind: 'fact', text: 'keep', version: 1 }] },
      },
    }))
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const write = definitions.get('whiteboard_write')!
    const first = await write.execute({
      scope: 'global',
      entries: [{ id: 'first', kind: 'fact', text: 'first' }],
    }, sessionExec)
    expect(first.ok).toBe(true)
    expect(settings.get).not.toHaveBeenCalled()
    expect(settings.mutate).toHaveBeenCalledTimes(1)
    expect(settings.mutate.mock.calls[0]![2]).toBe(1)
    expect(settings.describeCalls).toBe(1)
    expect((settings.board as WhiteboardStore).docs.global?.entries.map((entry) => entry.id)).toEqual(['old', 'first'])

    settings.mutate.mockImplementationOnce(async () => {
      throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
    })
    const retry = await write.execute({
      scope: 'global',
      entries: [{ id: 'second', kind: 'fact', text: 'second' }],
    }, sessionExec)
    expect(retry.ok).toBe(true)
    expect(settings.get).not.toHaveBeenCalled()
    expect(settings.mutate).toHaveBeenCalledTimes(3)
    expect(settings.mutate.mock.calls[1]![2]).toBe(2)
    expect(settings.mutate.mock.calls[2]![2]).toBe(2)
    expect(settings.describeCalls).toBe(3)
    expect((settings.board as WhiteboardStore).docs.global?.entries.map((entry) => entry.id))
      .toEqual(['old', 'first', 'second'])
  })

  it('refuses a mutation when the settings read throws and preserves the old board', async () => {
    const settings = makeSettings(normalizeStore({
      version: 2,
      docs: {
        global: { version: 1, updatedAt: 1, entries: [{ id: 'old', kind: 'fact', text: 'keep me', version: 1 }] },
      },
    }))
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const write = definitions.get('whiteboard_write')!
    const before = JSON.stringify(settings.board)
    const originalGet = settings.get
    settings.get = () => { throw new Error('transient read failure') }
    const failed = await write.execute({ scope: 'global', entries: [{ id: 'new', kind: 'fact', text: 'new fact' }] }, sessionExec)
    expect(failed.ok).toBe(false)
    expect(String(failed.message)).toContain('board read failed')
    expect(settings.mutate).not.toHaveBeenCalled()
    expect(JSON.stringify(settings.board)).toBe(before)
    settings.get = originalGet
    const recovered = await write.execute({ scope: 'global', entries: [{ id: 'new', kind: 'fact', text: 'new fact' }] }, sessionExec)
    expect(recovered.ok).toBe(true)
    expect((settings.board as WhiteboardStore).docs.global?.entries.map((entry) => entry.id)).toEqual(['old', 'new'])
  })

  it('refuses a malformed board read and allows a genuine first write', async () => {
    const settings = makeSettings(normalizeStore({
      version: 1,
      docs: {
        global: { version: 1, updatedAt: 1, entries: [{ id: 'old', kind: 'fact', text: 'keep', version: 1 }] },
      },
    }))
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const write = definitions.get('whiteboard_write')!
    const before = JSON.stringify(settings.board)
    const originalGet = settings.get
    settings.get = () => ({ whiteboard: 'poison' })
    const failed = await write.execute({ entries: [{ id: 'new', kind: 'fact', text: 'x' }] }, sessionExec)
    expect(failed.ok).toBe(false)
    expect(String(failed.message)).toContain('malformed')
    expect(settings.mutate).not.toHaveBeenCalled()
    expect(JSON.stringify(settings.board)).toBe(before)
    settings.get = originalGet

    const fresh = makeSettings()
    const originalFreshGet = fresh.get
    fresh.get = () => undefined
    const first = makeCtx(fresh)
    applyWhiteboard(first.ctx as never, {})
    const created = await first.definitions.get('whiteboard_write')!.execute({
      entries: [{ id: 'first', kind: 'fact', text: 'first write' }],
    }, sessionExec)
    expect(created.ok).toBe(true)
    expect(fresh.mutate).toHaveBeenCalledTimes(1)
    fresh.get = originalFreshGet
  })

  it('treats model-supplied __proto__/constructor targets as ordinary ids', async () => {
    const settings = makeSettings()
    expect(resolvedBoard(settings, { projectId: '__proto__' }).entries).toEqual([])
    expect(resolvedBoard(settings, {
      sessionId: 'constructor',
      parentSessionId: '__proto__',
      projectId: 'constructor',
    }).entries).toEqual([])
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const write = definitions.get('whiteboard_write')!
    const session = await write.execute({
      scope: 'session',
      sessionId: '__proto__',
      entries: [{ id: '__proto__', kind: 'fact', text: 'session proto' }],
    }, sessionExec)
    expect(session.ok).toBe(true)
    const project = await write.execute({
      scope: 'project',
      projectId: 'constructor',
      entries: [{ id: 'constructor', kind: 'fact', text: 'project ctor' }],
    }, sessionExec)
    expect(project.ok).toBe(true)
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    const protoExec = { agent: { session: { id: '__proto__', header: { cwd: '/tmp/opencode/heart-home' } } } }
    const sessionRead = await definitions.get('whiteboard_read')!.execute({}, protoExec)
    expect((sessionRead.entries as Array<Record<string, unknown>>).map((entry) => entry.id)).toContain('__proto__')
    const ctorExec = { agent: { session: { id: 'sess-ctor', header: { cwd: 'constructor' } } } }
    const projectRead = await definitions.get('whiteboard_read')!.execute({}, ctorExec)
    expect((projectRead.entries as Array<Record<string, unknown>>).find((entry) => entry.id === 'constructor'))
      .toMatchObject({ scope: 'project' })
    const parsed = JSON.parse(JSON.stringify(settings.board)) as {
      docs: { sessions: Record<string, unknown>; projects: Record<string, unknown> }
    }
    expect(Object.hasOwn(parsed.docs.sessions, '__proto__')).toBe(true)
    expect(Object.hasOwn(parsed.docs.projects, 'constructor')).toBe(true)
    expect(normalizeStore(parsed).docs.sessions['__proto__']?.entries[0]?.id).toBe('__proto__')
    expect(normalizeStore(parsed).docs.projects['constructor']?.entries[0]?.id).toBe('constructor')
  })

  it('forgets one entry in its authoring scope and returns the removed text', async () => {
    const settings = makeSettings(layeredStore())
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})

    const global = await definitions.get('whiteboard_forget')!.execute({ id: 'g1' }, sessionExec)
    expect(global.ok).toBe(true)
    expect(global.entries).toBeUndefined()
    expect(global.rendered).toBeUndefined()
    expect(global.removed).toMatchObject({ id: 'g1', kind: 'fact', text: 'global one', scope: 'global', version: 1 })
    expect(String(global.note)).toContain('g1')
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
    expect(pinnedGlobal.entries).toBeUndefined()
    expect(pinnedGlobal.rendered).toBeUndefined()
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

  it('refuses a session write when a root execution carries no session id', async () => {
    const settings = makeSettings()
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})
    const result = await definitions.get('whiteboard_write')!.execute(
      { entries: [{ id: 'a', kind: 'rule', text: 'x' }] },
      { agent: { session: { header: { cwd: '/tmp/opencode/heart-home' } } } },
    )
    expect(result.ok).toBe(false)
    expect(String(result.message)).toContain('requires a session id')
    expect(settings.board).toBeUndefined()
  })

  it('allows a user fork to author, blocks subagent and orphan subagent headers, and fails closed when headerless', async () => {
    const settings = makeSettings(layeredStore())
    const { ctx, definitions } = makeCtx(settings)
    applyWhiteboard(ctx as never, {})

    // User fork (parentSession + isSeeded: true, no origin, delegationDepth absent or 0) may author.
    for (const forkExec of [
      { agent: { session: { id: 'fork-live', header: { cwd: '/p', parentSession: 'sess-1', isSeeded: true } } } },
      { agent: { session: { id: 'fork-restored', header: { cwd: '/p', parentSession: 'sess-1', isSeeded: true, delegationDepth: 0 } } } },
    ]) {
      const read = await definitions.get('whiteboard_read')!.execute({}, forkExec)
      expect(read.ok).toBe(true)
      expect((read.entries as Array<Record<string, unknown>>).map((entry) => entry.id)).toContain('s1')

      const written = await definitions.get('whiteboard_write')!.execute({
        entries: [{ id: 'fork-note', kind: 'fact', text: 'fork authored' }],
      }, forkExec)
      expect(written.ok).toBe(true)
      expect((await definitions.get('whiteboard_pin')!.execute({ id: 'fork-note' }, forkExec)).ok).toBe(true)
      expect((await definitions.get('whiteboard_unpin')!.execute({ id: 'fork-note' }, forkExec)).ok).toBe(true)
      expect((await definitions.get('whiteboard_forget')!.execute({ id: 'fork-note' }, forkExec)).ok).toBe(true)
    }

    // Subagents (with parent) and orphan subagents (origin 'subagent' or delegationDepth > 0 without parent) are blocked.
    const beforeBlocked = JSON.stringify(settings.board)
    for (const blockedExec of [
      { agent: { session: { id: 'sub-1', header: { cwd: '/p', parentSession: 'sess-1', origin: 'subagent', delegationDepth: 1 } } } },
      { agent: { session: { id: 'sub-seeded', header: { cwd: '/p', parentSession: 'sess-1', isSeeded: true, origin: 'subagent', delegationDepth: 1 } } } },
      { agent: { session: { id: 'orphan-origin', header: { cwd: '/p', origin: 'subagent' } } } },
      { agent: { session: { id: 'orphan-depth', header: { cwd: '/p', delegationDepth: 1 } } } },
      { agent: { session: { id: 'orphan-empty-parent', header: { cwd: '/p', parentSession: '', origin: 'subagent', delegationDepth: 1 } } } },
    ]) {
      for (const [tool, args] of [
        ['whiteboard_write', { scope: 'global', entries: [{ id: 'x', kind: 'rule', text: 'blocked' }] }],
        ['whiteboard_pin', { id: 'g1' }],
        ['whiteboard_unpin', { id: 'g1' }],
        ['whiteboard_forget', { id: 'g1' }],
      ] as const) {
        const result = await definitions.get(tool)!.execute(args, blockedExec)
        expect(result.ok, `${tool} ${JSON.stringify(blockedExec)}`).toBe(false)
        expect(result.reason, tool).toBe('refused')
        expect(String(result.message), tool).toContain('the whiteboard is authored by the main session; children read it')
      }
    }

    // Headerless executions fail closed across all mutating tools (including global scope).
    for (const headerlessExec of [
      {},
      { agent: { session: { id: 'sess-1' } } },
    ]) {
      for (const [tool, args] of [
        ['whiteboard_write', { entries: [{ id: 'x', kind: 'rule', text: 'no header' }] }],
        ['whiteboard_write', { scope: 'global', entries: [{ id: 'x', kind: 'rule', text: 'no header global' }] }],
        ['whiteboard_pin', { id: 'g1' }],
        ['whiteboard_unpin', { id: 'g1' }],
        ['whiteboard_forget', { id: 'g1' }],
      ] as const) {
        const result = await definitions.get(tool)!.execute(args, headerlessExec)
        expect(result.ok, `${tool} ${JSON.stringify(headerlessExec)}`).toBe(false)
        expect(result.reason, tool).toBe('refused')
      }
    }
    expect(JSON.stringify(settings.board)).toBe(beforeBlocked)
  })

  it('matches enpoi-memory classifySessionAuthority across every header shape (parity)', async () => {
    const { classifySessionAuthority: wbClassify } = await import('../src/session-authority')
    const { classifySessionAuthority: memClassify, isDelegatedSession } = await import('../../enpoi-memory/src/session-authority')
    const cases: Array<{ header: Record<string, unknown> | undefined; expectedKind: 'missing' | 'root' | 'delegated' }> = [
      { header: undefined, expectedKind: 'missing' },
      { header: { id: 'root-1', isSeeded: false }, expectedKind: 'root' },
      { header: { id: 'root-2', isSeeded: false, delegationDepth: 0 }, expectedKind: 'root' },
      { header: { id: 'seeded-root', isSeeded: true }, expectedKind: 'root' },
      { header: { id: 'fork-live', parentSession: 'origin-1', isSeeded: true }, expectedKind: 'root' },
      { header: { id: 'fork-restored', parentSession: 'origin-1', isSeeded: true, delegationDepth: 0 }, expectedKind: 'root' },
      { header: { id: 'child-1', parentSession: 'root-1', origin: 'subagent', delegationDepth: 1 }, expectedKind: 'delegated' },
      { header: { id: 'child-seeded', parentSession: 'root-1', isSeeded: true, origin: 'subagent', delegationDepth: 1 }, expectedKind: 'delegated' },
      { header: { id: 'ambig-unseeded', parentSession: 'root-1', isSeeded: false, delegationDepth: 0 }, expectedKind: 'delegated' },
      { header: { id: 'bare-parent', parentSession: 'root-1' }, expectedKind: 'delegated' },
      { header: { id: 'orphan-origin', origin: 'subagent' }, expectedKind: 'delegated' },
      { header: { id: 'orphan-depth', delegationDepth: 2 }, expectedKind: 'delegated' },
      { header: { id: 'empty-parent', parentSession: '' }, expectedKind: 'delegated' },
      { header: { id: 'fork-empty-parent', parentSession: '', isSeeded: true }, expectedKind: 'delegated' },
      { header: { id: 'bad-depth', delegationDepth: -1 }, expectedKind: 'delegated' },
      { header: { id: 'bad-origin', origin: 'external' }, expectedKind: 'delegated' },
      { header: { id: 'bad-seeded', isSeeded: 'yes' }, expectedKind: 'delegated' },
    ]
    for (const { header, expectedKind } of cases) {
      const wb = wbClassify(header)
      const mem = memClassify(header)
      expect(wb).toEqual(mem)
      expect(wb.kind, JSON.stringify(header)).toBe(expectedKind)
      expect(isDelegatedSession(header), JSON.stringify(header)).toBe(expectedKind !== 'root')
    }
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
    expect(parentSnapshot).toContain('### Pinned context\n')
    expect(parentSnapshot).not.toContain('### Pinned context (v')
    expect(parentSnapshot).toContain('docs/67-heart-implementation-plan.md')

    // A direct child (durable parentSession lineage) inherits the parent board.
    const child = { session: { id: 'child-session', header: { cwd: '/home/user', parentSession: 'parent-session' } } }
    const childSnapshot = renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: child, agent: child })) as string
    expect(childSnapshot).toContain('### Pinned context\n')
    expect(childSnapshot).not.toContain('### Pinned context (v')

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
    expect(a).not.toContain('(v7)')

    const b = await assemble('session-b')
    expect(b).toContain('GLOBAL-FACT')
    expect(b).toContain('B-ONLY')
    expect(b).not.toContain('A-ONLY')

    const c = await assemble('session-c')
    expect(c).toContain('GLOBAL-FACT')
    expect(c).not.toContain('A-ONLY')
    expect(c).not.toContain('B-ONLY')
  })

  it('keeps the injected block unchanged on a version-only write and updates it on a semantic edit', async () => {
    const store = normalizeStore({
      version: 7,
      docs: {
        sessions: {
          'session-a': { version: 1, updatedAt: 1, entries: [{ id: 'a', kind: 'fact', text: 'stable fact', version: 1 }] },
        },
      },
    })
    const { ctx, settings, renderContextSnapshot } = await boot(store)
    const agent = { session: { id: 'session-a', header: { cwd: '/home/user' } } }
    const block = (snapshot: string): string => {
      const at = snapshot.indexOf('### Pinned context')
      return at === -1 ? '' : snapshot.slice(at)
    }
    const first = block(renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: agent, agent })) as string)
    expect(first).toContain('stable fact')
    expect(first).not.toContain('(v7)')

    // Another writer bumps only the store version: this session's injected block is identical.
    settings.board = { ...store, version: 8 }
    const second = block(renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: agent, agent })) as string)
    expect(second).toBe(first)

    // A semantic edit does reach the injected block.
    settings.board = normalizeStore({
      version: 9,
      docs: {
        sessions: {
          'session-a': { version: 2, updatedAt: 2, entries: [{ id: 'a', kind: 'fact', text: 'edited fact', version: 2 }] },
        },
      },
    })
    const third = block(renderContextSnapshot(await ctx.systemPrompt.assemble({ scope: agent, agent })) as string)
    expect(third).not.toBe(first)
    expect(third).toContain('edited fact')
  })
})

describe('enpoi-whiteboard settings fallback', () => {
  it('reads the empty board when settings are unavailable', () => {
    const ctx = { get: () => undefined }
    expect(readWhiteboard(ctx as never)).toMatchObject({ version: 0, entries: [] })
    expect(readWhiteboardStore(ctx as never)).toEqual({ version: 0, docs: { projects: {}, sessions: {} } })
  })
})
