// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { WatchtowerView } from '../src/client/WatchtowerView.tsx'
import { WhiteboardCard } from '../src/client/WhiteboardCard.tsx'
import {
  parseWhiteboardStore,
  renderWhiteboardBlock,
  resolveWhiteboard,
  whiteboardTokens,
  type ResolvedWhiteboardView,
} from '../src/client/whiteboard-view.ts'

/** The legacy single-board document the settings file carried before per-scope storage. */
const LEGACY_BOARD = {
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
      pinnedAt: 0,
      version: 2,
    },
    {
      id: 'wb-path-1',
      kind: 'path',
      text: 'docs/plan.md',
      pinned: false,
      pinnedAt: 0,
      version: 1,
      stale: true,
    },
  ],
  updatedAt: 1790156496640,
}

const EXPECTED_BLOCK = [
  '### Pinned context (v4)',
  '- 📌 [fact] DeepSeek Harness GUI is running on http://127.0.0.1:3080',
  '- [rule] Always run verification before claiming completion',
  '- [task] Demonstrate whiteboard read, write, pin, and replace operations (Completed)',
  '- [path] docs/plan.md (stale)',
].join('\n')

/** The per-scope store: global + project + two session boards, with a session override. */
const STORE = {
  version: 7,
  docs: {
    global: {
      version: 2,
      updatedAt: 111,
      entries: [{ id: 'wb-fact-1', kind: 'fact', text: 'GLOBAL-FACT', pinned: true, pinnedAt: 1, version: 1 }],
    },
    projects: {
      '/home/adam': {
        version: 1,
        updatedAt: 222,
        entries: [
          { id: 'wb-plan-1', kind: 'path', text: 'PROJECT-PLAN.md', pinned: false, pinnedAt: 0, version: 1 },
          { id: 'wb-rule-1', kind: 'rule', text: 'PROJECT-RULE', pinned: false, pinnedAt: 0, version: 1 },
        ],
      },
    },
    sessions: {
      'session-test-123': {
        version: 1,
        updatedAt: 333,
        entries: [
          { id: 'wb-task-1', kind: 'task', text: 'SESSION-TASK', pinned: false, pinnedAt: 0, version: 1 },
          { id: 'wb-rule-1', kind: 'rule', text: 'SESSION-OVERRIDE', pinned: false, pinnedAt: 0, version: 2 },
        ],
      },
      'session-other': {
        version: 1,
        updatedAt: 444,
        entries: [{ id: 'wb-x', kind: 'fact', text: 'OTHER-ONLY', pinned: false, pinnedAt: 0, version: 1 }],
      },
    },
  },
}

/** The resolved view for `session-test-123` in `/home/adam`. */
function sessionResolved(): ResolvedWhiteboardView {
  return resolveWhiteboard(parseWhiteboardStore(STORE), { sessionId: 'session-test-123', projectId: '/home/adam' })
}

function stubDescribe(whiteboard: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: { ok: true, value: { namespaces: [{ ns: 'enpoi-orchestration', value: { whiteboard } }] } },
    }),
  })))
}

describe('Watchtower Whiteboard card', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders the injected block exactly as the plugin does (pinned first, stale flagged)', () => {
    const resolved = resolveWhiteboard(parseWhiteboardStore(LEGACY_BOARD), {})
    const rendered = renderWhiteboardBlock(resolved)
    expect(rendered).toBe(EXPECTED_BLOCK)
    expect(whiteboardTokens(rendered)).toBe(Math.ceil(Array.from(rendered).length / 4))
  })

  it('normalizes malformed entries away instead of rendering them', () => {
    const store = parseWhiteboardStore({
      version: 3,
      scope: 'nonsense',
      entries: [{ kind: 'fact' }, { kind: 'made-up', text: 'x' }, { kind: 'rule', text: '  keep me  ' }, null],
      updatedAt: 5,
    })
    expect(store.version).toBe(3)
    expect(store.docs.global?.entries).toHaveLength(1)
    expect(store.docs.global?.entries[0]?.text).toBe('keep me')
    expect(store.docs.global?.updatedAt).toBe(5)
  })

  it('migrates a legacy session board into its own session bucket', () => {
    const store = parseWhiteboardStore({
      version: 3,
      scope: 'session',
      sessionId: 's1',
      entries: [{ id: 'a', kind: 'rule', text: 'LEGACY-SESSION', version: 1 }],
      updatedAt: 9,
    })
    expect(store.docs.global).toBeUndefined()
    expect(store.docs.sessions['s1']?.entries[0]?.text).toBe('LEGACY-SESSION')
    expect(resolveWhiteboard(store, { sessionId: 's1' }).entries).toHaveLength(1)
    expect(resolveWhiteboard(store, { sessionId: 'other' }).entries).toHaveLength(0)
  })

  it('resolves global → project → session, overriding by id with per-entry scope', () => {
    const resolved = sessionResolved()
    expect(resolved.version).toBe(7)
    expect(resolved.scope).toBe('session')
    expect(resolved.updatedAt).toBe(333)
    const byId = new Map(resolved.entries.map(entry => [entry.id, entry]))
    expect(byId.get('wb-fact-1')).toMatchObject({ text: 'GLOBAL-FACT', scope: 'global' })
    expect(byId.get('wb-plan-1')).toMatchObject({ text: 'PROJECT-PLAN.md', scope: 'project' })
    expect(byId.get('wb-rule-1')).toMatchObject({ text: 'SESSION-OVERRIDE', version: 2, scope: 'session' })
    expect(byId.get('wb-task-1')).toMatchObject({ text: 'SESSION-TASK', scope: 'session' })
    expect(resolved.entries.map(entry => entry.id)).toEqual(['wb-fact-1', 'wb-plan-1', 'wb-rule-1', 'wb-task-1'])
  })

  it('keeps a session entry invisible to another session', () => {
    const other = resolveWhiteboard(parseWhiteboardStore(STORE), { sessionId: 'session-other', projectId: '/home/adam' })
    expect(other.entries.map(entry => [entry.id, entry.scope])).toEqual([
      ['wb-fact-1', 'global'],
      ['wb-plan-1', 'project'],
      ['wb-rule-1', 'project'],
      ['wb-x', 'session'],
    ])
    const otherBlock = renderWhiteboardBlock(other)
    expect(otherBlock).toContain('OTHER-ONLY')
    expect(otherBlock).not.toContain('SESSION-TASK')
    expect(otherBlock).not.toContain('SESSION-OVERRIDE')

    const unrelated = resolveWhiteboard(parseWhiteboardStore(STORE), { sessionId: 'nowhere' })
    expect(unrelated.entries.map(entry => entry.id)).toEqual(['wb-fact-1'])
    expect(unrelated.scope).toBe('global')
  })

  it('renders the effective version/scope line, the injected block, and per-entry scope badges', () => {
    const resolved = sessionResolved()
    const rendered = renderWhiteboardBlock(resolved)
    const tokens = whiteboardTokens(rendered)
    render(<WhiteboardCard doc={resolved} phase="ready" />)
    expect(screen.getByText('v7')).toBeTruthy()
    expect(screen.getAllByText('session').length).toBe(3)
    expect(screen.getAllByText('global').length).toBe(1)
    expect(screen.getByText('project')).toBeTruthy()
    expect(screen.getAllByTitle('authored by the session board')).toHaveLength(2)
    expect(screen.getAllByTitle('authored by the global board')).toHaveLength(1)
    expect(screen.getByTitle('authored by the project board')).toBeTruthy()
    expect(screen.getByText(`${tokens}/1500 tok`)).toBeTruthy()
    expect(screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === rendered)).toBeTruthy()
    expect(screen.getByText('Entries · 4')).toBeTruthy()
    expect(screen.getByText('SESSION-OVERRIDE')).toBeTruthy()
  })

  it('degrades to the quiet state when nothing resolves for this session', () => {
    const empty = parseWhiteboardStore({ version: 0, scope: 'global', entries: [], updatedAt: 0 })
    const { rerender } = render(<WhiteboardCard doc={resolveWhiteboard(empty, {})} phase="ready" />)
    expect(screen.getByText('no whiteboard entries')).toBeTruthy()
    rerender(<WhiteboardCard doc={null} phase="loading" />)
    expect(screen.getByText('reading the board…')).toBeTruthy()
    rerender(<WhiteboardCard doc={null} phase="error" />)
    expect(screen.getByText('board unavailable')).toBeTruthy()
  })

  it('reads the live store under the Watchtower and shows this session resolution', async () => {
    stubDescribe(STORE)
    render(
      <WatchtowerView
        sessionId="session-test-123"
        useSession={selector => selector({ sessionId: 'session-test-123', cwd: '/home/adam', subagent: null })}
      />,
    )
    const expected = renderWhiteboardBlock(sessionResolved())
    await waitFor(() => {
      expect(screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === expected)).toBeTruthy()
    })
    expect(screen.getByText(`${whiteboardTokens(expected)}/1500 tok`)).toBeTruthy()
    expect(screen.getByText('SESSION-TASK')).toBeTruthy()
  })

  it('shows the quiet whiteboard state for a session nothing resolves into', async () => {
    stubDescribe({
      version: 5,
      docs: { sessions: { 'session-elsewhere': { version: 1, updatedAt: 1, entries: [{ id: 'x', kind: 'fact', text: 'ELSEWHERE', version: 1 }] } } },
    })
    render(
      <WatchtowerView
        sessionId="session-test-123"
        useSession={selector => selector({ sessionId: 'session-test-123', cwd: '/home/adam' })}
      />,
    )
    await waitFor(() => { expect(screen.getByText('no whiteboard entries')).toBeTruthy() })
    expect(screen.queryByText('ELSEWHERE')).toBeNull()
  })
})
