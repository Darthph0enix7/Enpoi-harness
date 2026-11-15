// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { SubagentSessionsBody } from '../src/client/SubagentSessionsBody.tsx'
import { mergeRoleRegistry, type RoleRegistryMap } from '../src/client/role-registry.ts'
import { brandT } from './brand-i18n.client.ts'

/** One projection row the tree builder consumes (structural subset of SessionSummary). */
interface Row {
  id: string
  displayTitle: string
  parentId?: string
  origin?: 'subagent'
  running: boolean
  completed?: boolean
  blank?: boolean
  updatedAt?: number
  projectionValues?: {
    subagent?: { mode: 'one-shot' | 'continuable'; label?: string; seq?: number }
    subagentTiming?: { lastTurnCompleted?: boolean }
  }
}

/** Arrival phase of the list projection, as SessionListState carries it. */
type Phase = 'pending' | 'ready'

type RowExtra = Omit<Row, 'id' | 'displayTitle' | 'running'> & { running?: boolean }

function row(id: string, displayTitle: string, extra: RowExtra = {}): Row {
  return { id, displayTitle, blank: false, running: false, updatedAt: 0, ...extra }
}

function byIdOf(rows: readonly Row[]): Record<string, Row> {
  return Object.fromEntries(rows.map(entry => [entry.id, entry]))
}

/** One catalog child entry, as the host's subagent catalog projects it. */
function childEntry(id: string, mode: 'one-shot' | 'continuable' = 'continuable', label = 'child', createdAt = 1) {
  return { id, mode, label, createdAt, seq: 0 }
}

function mount(
  rows: Row[],
  sessionId = 'child',
  phase: Phase = 'ready',
  catalogs: Record<string, unknown> = {},
  registry: RoleRegistryMap = mergeRoleRegistry(undefined),
) {
  const openSession = vi.fn()
  const openChild = vi.fn()
  const refreshSessions = vi.fn(async () => {})
  const useSessions = (selector: (state: { byId: Record<string, Row>; phase: Phase; projectionsBySession: unknown }) => unknown) =>
    selector({ byId: byIdOf(rows), phase, projectionsBySession: catalogs })
  const useRoleRegistry = (selector: (value: RoleRegistryMap) => unknown) => selector(registry)
  // Presentation props only: the component never reads the standard seats the
  // renderer would bind (session lifecycle, projections, tab info).
  const props = {
    sessionId,
    t: brandT,
    useSessions,
    useRoleRegistry,
    useTabInfo: () => ({}),
    openSession,
    openChild,
    refreshSessions,
  } as unknown as Parameters<typeof SubagentSessionsBody>[0]
  const view = render(<SubagentSessionsBody {...props} />)

  /** Re-render the same instance with new props, as a session switch does. */
  const rerender = (next: {
    sessionId?: string
    rows?: Row[]
    phase?: Phase
    catalogs?: Record<string, unknown>
  } = {}): void => {
    const useNextSessions = (selector: (state: { byId: Record<string, Row>; phase: Phase; projectionsBySession: unknown }) => unknown) =>
      selector({ byId: byIdOf(next.rows ?? rows), phase: next.phase ?? phase, projectionsBySession: next.catalogs ?? catalogs })
    const nextProps = {
      ...props,
      sessionId: next.sessionId ?? sessionId,
      useSessions: useNextSessions,
    } as unknown as Parameters<typeof SubagentSessionsBody>[0]
    view.rerender(<SubagentSessionsBody {...nextProps} />)
  }

  return {
    openSession,
    openChild,
    refreshSessions,
    rerender,
    view,
    list: () => within(screen.getByLabelText('Session lineage')),
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SubagentSessionsBody — lineage tree', () => {
  it('roots at the top-most ancestor and indents descendants, excluding unrelated roots', () => {
    const { list } = mount([
      row('main', 'Main Session'),
      row('child', 'Fixer child', { parentId: 'main', origin: 'subagent', running: true }),
      row('grand', 'Grandchild', { parentId: 'child', origin: 'subagent', completed: true }),
      row('other', 'Another root'),
    ])

    expect(list().getByText('Main Session')).toBeTruthy()
    expect(list().getByText('Fixer child')).toBeTruthy()
    expect(list().getByText('Grandchild')).toBeTruthy()
    expect(screen.queryByText('Another root')).toBeNull()

    // Depth is rendered as extra left padding on the row button.
    const childPad = Number(/-?\d+/.exec((list().getByText('Fixer child').closest('button') as HTMLElement).style.paddingLeft)?.[0])
    const grandPad = Number(/-?\d+/.exec((list().getByText('Grandchild').closest('button') as HTMLElement).style.paddingLeft)?.[0])
    expect(childPad).toBeGreaterThan(0)
    expect(grandPad).toBeGreaterThan(childPad)
  })

  it('highlights the current session and opens the root (main session) in one click', () => {
    const { openSession, list } = mount([
      row('main', 'Main Session'),
      row('child', 'Fixer child', { parentId: 'main', origin: 'subagent' }),
    ])

    expect((list().getByText('Fixer child').closest('button') as HTMLElement).getAttribute('data-current')).toBe('true')
    expect((list().getByText('Main Session').closest('button') as HTMLElement).getAttribute('data-current')).toBeNull()

    fireEvent.click(list().getByText('Main Session'))
    expect(openSession).toHaveBeenCalledWith('main')
  })

  it('opens a catalog child through its durable parent address', () => {
    const catalogs = {
      main: { values: { subagentCatalog: [childEntry('child')] } },
    }
    const { openChild, openSession, list } = mount([
      row('main', 'Main Session'),
      row('child', 'Fixer child', { parentId: 'main', origin: 'subagent' }),
      row('grand', 'Grandchild', { parentId: 'child', origin: 'subagent' }),
    ], 'grand', 'ready', catalogs)

    expect(screen.queryByRole('navigation', { name: 'Session ancestry' })).toBeNull()

    fireEvent.click(list().getByText('Fixer child'))
    expect(openChild).toHaveBeenCalledWith({ parentSessionId: 'main', childSessionId: 'child', mode: 'continuable' })
    expect(openSession).not.toHaveBeenCalled()
  })

  it('selects the parent when a child has no catalog address yet', () => {
    const { openSession, list } = mount([
      row('main', 'Main Session'),
      row('child', 'Fixer child', { parentId: 'main', origin: 'subagent' }),
      row('grand', 'Grandchild', { parentId: 'child', origin: 'subagent' }),
    ], 'grand')

    fireEvent.click(list().getByText('Fixer child'))
    // The parent selection loads its catalog; the child opens when the address arrives.
    expect(openSession).toHaveBeenCalledWith('main')
  })

  it('orders running first, then latest update, and keeps each subtree contiguous', () => {
    const { list } = mount([
      row('main', 'Main Session', { updatedAt: 1 }),
      row('old-running', 'Old running', { parentId: 'main', origin: 'subagent', running: true, updatedAt: 10 }),
      row('newest', 'Newest idle', { parentId: 'main', origin: 'subagent', updatedAt: 40 }),
      row('grand', 'Grandchild', { parentId: 'newest', origin: 'subagent', updatedAt: 30 }),
      row('middle', 'Middle idle', { parentId: 'main', origin: 'subagent', updatedAt: 20 }),
    ], 'main')

    const text = list().getAllByRole('button').map(button => button.textContent ?? '')
    const order = ['Main Session', 'Old running', 'Newest idle', 'Grandchild', 'Middle idle']
    const positions = order.map(value => text.findIndex(entry => entry.includes(value)))
    expect(positions.every(value => value >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  it('uses catalog creation time when a list row has no durable update time', () => {
    const { list } = mount([
      row('main', 'Main Session', { updatedAt: 100 }),
      row('old', 'Catalog child', { parentId: 'main', origin: 'subagent', updatedAt: 0 }),
      row('newer', 'Newer child', { parentId: 'main', origin: 'subagent', updatedAt: 50 }),
    ], 'main', 'ready', { main: { values: { subagentCatalog: [childEntry('old', 'continuable', 'Catalog child', 200)] } } })

    const text = list().getAllByRole('button').map(button => button.textContent ?? '')
    expect(text.findIndex(entry => entry.includes('Catalog child')))
      .toBeLessThan(text.findIndex(entry => entry.includes('Newer child')))
  })

  it('keeps the current row and its ancestors inside the cap', () => {
    const children = Array.from({ length: 60 }, (_, index) => row(`c${index}`, `Child ${index}`, {
      parentId: 'main', origin: 'subagent', updatedAt: index + 1,
    }))
    const { list } = mount([row('main', 'Main Session', { updatedAt: 1 }), ...children], 'c0')

    expect(screen.getByText(/Showing 50 of 61/)).toBeTruthy()
    expect(list().getByText('Main Session')).toBeTruthy()
    expect(list().getByText('Child 0')).toBeTruthy()
    expect(list().getByText('Child 59')).toBeTruthy()
    expect(list().queryByText('Child 5')).toBeNull()
  })

  it('fills an absent parent from one unambiguous catalog claim', () => {
    const { list } = mount([
      row('main', 'Main Session'),
      row('child', 'Child with catalog parent', { origin: 'subagent' }),
    ], 'child', 'ready', {
      main: { values: { subagentCatalog: [childEntry('child', 'continuable', 'Child with catalog parent')] } },
    })

    expect(list().getAllByText('Main').length).toBe(1)
    const child = list().getByText('Child with catalog parent').closest('button') as HTMLElement
    expect(Number(/\d+/.exec(child.style.paddingLeft)?.[0])).toBeGreaterThan(0)
  })

  it('drops cycle-closing catalog edges and keeps one finite root', () => {
    const { list } = mount([
      row('a', 'Cycle child', { parentId: 'x', origin: 'subagent', updatedAt: 1 }),
      row('x', 'Cycle root', { parentId: 'y', origin: 'subagent', updatedAt: 3 }),
      row('y', 'Cycle sibling', { parentId: 'x', origin: 'subagent', updatedAt: 2 }),
    ], 'x')

    expect(list().getAllByRole('button')).toHaveLength(2)
    expect(list().getByText('Cycle root')).toBeTruthy()
    expect(list().getByText('Cycle sibling')).toBeTruthy()
    expect(screen.queryByText('Cycle child')).toBeNull()
    expect(screen.queryByText('Main')).toBeNull()
  })

  it('does not override an authoritative parent that is outside the projection', () => {
    const { list } = mount([
      row('child', 'Child with absent parent', { parentId: 'absent-root', origin: 'subagent' }),
    ], 'child', 'ready', {
      main: { values: { subagentCatalog: [childEntry('child', 'continuable', 'Child with absent parent')] } },
    })

    expect(list().getByText('Subagent')).toBeTruthy()
    expect(screen.queryByText('Main')).toBeNull()
  })

  it('labels a depth-zero subagent as a subagent, never as main', () => {
    const { list } = mount([
      row('orphan', 'Orphan child', { origin: 'subagent' }),
    ], 'orphan')

    expect(list().getByText('Subagent')).toBeTruthy()
    expect(screen.queryByText('Main')).toBeNull()
  })

  it('keeps an authoritative parent when catalogs disagree and uses the latest creation time', () => {
    const { list } = mount([
      row('main', 'Main Session', { updatedAt: 1 }),
      row('child', 'Disputed child', { parentId: 'main', origin: 'subagent', updatedAt: 0 }),
      row('other', 'Other child', { parentId: 'main', origin: 'subagent', updatedAt: 15 }),
    ], 'main', 'ready', {
      'root-a': { values: { subagentCatalog: [
        childEntry('child', 'continuable', 'Disputed child', 10),
        childEntry('child', 'continuable', 'Disputed child', 20),
      ] } },
      'root-b': { values: { subagentCatalog: [childEntry('child', 'continuable', 'Disputed child', 30)] } },
      'root-c': { values: { subagentCatalog: [childEntry('child', 'continuable', 'Disputed child', 40)] } },
    })

    const text = list().getAllByRole('button').map(button => button.textContent ?? '')
    // The competing claims cannot replace the row's authoritative parent; the
    // latest catalog creation time still orders the disputed child.
    expect(text.findIndex(entry => entry.includes('Disputed child')))
      .toBeLessThan(text.findIndex(entry => entry.includes('Other child')))
    expect(text.filter(entry => entry.includes('Disputed child'))).toHaveLength(1)
    expect(list().getAllByText('Main').length).toBe(1)
  })

  it('marks idle children done only with durable completion evidence', () => {
    const { list } = mount([
      row('main', 'Main Session'),
      row('idle', 'Idle child', { parentId: 'main', origin: 'subagent' }),
      row('done', 'Completed child', {
        parentId: 'main', origin: 'subagent',
        projectionValues: { subagentTiming: { lastTurnCompleted: true } },
      }),
    ], 'main')

    expect((list().getByText('Idle child').closest('button') as HTMLElement).querySelector('[data-state="idle"]')).toBeTruthy()
    expect((list().getByText('Completed child').closest('button') as HTMLElement).querySelector('[data-state="done"]')).toBeTruthy()
  })

  it('never renders a forest when the selected session is missing', () => {
    mount([
      row('root-a', 'First root', { updatedAt: 2 }),
      row('root-b', 'Second root', { updatedAt: 1 }),
    ], 'missing')

    expect(screen.queryByText('Main')).toBeNull()
    expect(screen.getByText('No subagent sessions yet')).toBeTruthy()
  })

  it('formats compact ages and advances the clock without list churn', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const now = Date.now()
    const { list } = mount([
      row('main', 'Main Session'),
      row('now', 'Just now', { parentId: 'main', origin: 'subagent', updatedAt: now }),
      row('minutes', 'Minutes', { parentId: 'main', origin: 'subagent', updatedAt: now - 5 * 60_000 }),
      row('hours', 'Hours', { parentId: 'main', origin: 'subagent', updatedAt: now - 2 * 3_600_000 }),
      row('days', 'Days', { parentId: 'main', origin: 'subagent', updatedAt: now - 2 * 86_400_000 }),
    ], 'main')

    for (const label of ['just now', '5m ago', '2h ago', '2d ago']) {
      expect(list().getByText(label)).toBeTruthy()
    }
    act(() => { vi.advanceTimersByTime(30_000) })
  })

  it('labels a non-subagent child as a session', () => {
    const { list } = mount([
      row('main', 'Main Session'),
      row('fork', 'Fork child', { parentId: 'main' }),
    ], 'main')

    expect(list().getByText('Session')).toBeTruthy()
  })

  it('tolerates missing catalog values and unlabeled catalog children', () => {
    const { list } = mount([
      row('main', 'Main Session'),
    ], 'main', 'ready', {
      main: { values: {
        subagentCatalog: [{ id: 'catalog-child', mode: 'one-shot', createdAt: 5, seq: 0 }],
      } },
      empty: { values: {} },
    })

    expect(list().getByText('catalog-child')).toBeTruthy()
  })

  it('opens a deferred child when its parent catalog arrives', () => {
    const { openChild, openSession, list, rerender } = mount([
      row('main', 'Main Session'),
      row('child', 'Fixer child', { parentId: 'main', origin: 'subagent' }),
      row('grand', 'Grandchild', { parentId: 'child', origin: 'subagent' }),
    ], 'grand')

    fireEvent.click(list().getByText('Fixer child'))
    expect(openSession).toHaveBeenCalledWith('main')
    expect(openChild).not.toHaveBeenCalled()

    rerender({ catalogs: { main: { values: { subagentCatalog: [childEntry('child')] } } } })
    expect(openChild).toHaveBeenCalledWith({
      parentSessionId: 'main', childSessionId: 'child', mode: 'continuable',
    })
  })

  it('stops waiting for a deferred child whose catalog never arrives', () => {
    vi.useFakeTimers()
    const { openChild, openSession, list } = mount([
      row('main', 'Main Session'),
      row('child', 'Fixer child', { parentId: 'main', origin: 'subagent' }),
    ], 'child')

    fireEvent.click(list().getByText('Fixer child'))
    expect(openSession).toHaveBeenCalledWith('main')
    act(() => { vi.advanceTimersByTime(2_500) })
    expect(openChild).not.toHaveBeenCalled()
  })

  it('coalesces refresh clicks and exposes the refreshing state', async () => {
    const { refreshSessions } = mount([row('main', 'Main Session')], 'main')
    let settle!: () => void
    const pull = new Promise<void>((resolve) => { settle = resolve })
    refreshSessions.mockImplementation(() => pull)
    const refresh = screen.getByRole('button', { name: 'Refresh session list' })

    fireEvent.click(refresh)
    fireEvent.click(refresh)
    expect(refreshSessions).toHaveBeenCalledOnce()
    expect(refresh.className).toContain('refreshing')

    await act(async () => {
      settle()
      await pull
    })
    expect(refresh.className).not.toContain('refreshing')
  })

  it('keeps the empty state when the list projection has no sessions', () => {
    mount([])
    expect(screen.getByText('No subagent sessions yet')).toBeTruthy()
  })

  it('shows the empty state while the first list snapshot is still pending', () => {
    mount([], 'child', 'pending')
    expect(screen.getByText('No subagent sessions yet')).toBeTruthy()
  })

  it('treats an empty session id as no selected row', () => {
    mount([], '')
    expect(screen.getByText('No subagent sessions yet')).toBeTruthy()
  })
})

describe('SubagentSessionsBody — agent identity rows', () => {
  it('leads a row with the persona from the subagent identity projection', () => {
    const { list } = mount([
      row('main', 'Main Session'),
      row('child', 'Debate the migration plan', {
        parentId: 'main',
        origin: 'subagent',
        projectionValues: { subagent: { mode: 'continuable', label: 'council debater: Critic', seq: 2 } },
      }),
      row('lower', 'Prepare the options', {
        parentId: 'main',
        origin: 'subagent',
        projectionValues: { subagent: { mode: 'continuable', label: 'subagent: skeptic', seq: 3 } },
      }),
      row('bare', 'Unlabeled work', {
        parentId: 'main',
        origin: 'subagent',
        projectionValues: { subagent: { mode: 'continuable', label: 'subagent:', seq: 4 } },
      }),
    ])

    const critic = list().getByText('Critic').closest('button') as HTMLElement
    expect(critic.textContent).toContain('Debate the migration plan')
    // Reading order proves the persona is the primary label and the query secondary.
    expect((critic.textContent ?? '').indexOf('Critic')).toBeLessThan((critic.textContent ?? '').indexOf('Debate the migration plan'))

    // An all-lowercase host label is title-cased for display.
    const skeptic = list().getByText('Skeptic').closest('button') as HTMLElement
    expect(skeptic.textContent).toContain('Prepare the options')

    // A label carrying no persona falls back to the row's metadata role.
    const bare = list().getByText('Unlabeled work').closest('button') as HTMLElement
    expect(within(bare).getByText('Subagent')).toBeTruthy()
  })

  it('labels a row from the registry role id when the host projection has no persona', () => {
    const registry = mergeRoleRegistry({ muse: { label: 'The Muse', group: 'council' }, scribe: {} })
    const { list } = mount([
      row('main', 'Main Session'),
      row('child', 'muse: Draft the set', { parentId: 'main', origin: 'subagent' }),
      row('scribe', 'Scribe: Write the notes', { parentId: 'main', origin: 'subagent' }),
      row('unlabeled', 'Unlabeled work', { parentId: 'main', origin: 'subagent' }),
    ], 'child', 'ready', {}, registry)

    // A registry role with a label leads the row; the query stays secondary.
    const muse = list().getByText('The Muse').closest('button') as HTMLElement
    expect(muse.textContent).toContain('Draft the set')
    expect((muse.textContent ?? '').indexOf('The Muse')).toBeLessThan((muse.textContent ?? '').indexOf('Draft the set'))

    // A registry role without a label falls back to the title-cased role id.
    const scribe = list().getByText('Scribe').closest('button') as HTMLElement
    expect(scribe.textContent).toContain('Write the notes')

    // A title naming no registry role keeps the metadata fallback.
    const bare = list().getByText('Unlabeled work').closest('button') as HTMLElement
    expect(within(bare).getByText('Subagent')).toBeTruthy()
  })

  it('names the role the child actually ran as, not a guess from the task text', () => {
    const { list } = mount([
      row('main', 'Main Session'),
      row('child', 'Compact one-hand watch gesture map', {
        parentId: 'main',
        origin: 'subagent',
        // The descriptor label the host froze at dispatch: the child ran as the
        // Designer, and no later surface may name another specialist.
        projectionValues: { subagent: { mode: 'one-shot', label: 'Designer: Compact one-hand watch gesture map', seq: 5 } },
      }),
    ])

    const child = list().getByText('Designer').closest('button') as HTMLElement
    expect(child.textContent).toContain('Compact one-hand watch gesture map')
    expect(child.textContent).not.toContain('Designer: Compact')
  })

  it('keeps a settled child listed from the parent catalog when the list drops it', () => {
    const { list } = mount(
      [row('main', 'Main Session'), row('current', 'Current child', { parentId: 'main', origin: 'subagent' })],
      'current',
      'ready',
      { main: { values: { subagentCatalog: [childEntry('current', 'continuable', 'Explorer: Map it'), childEntry('gone', 'one-shot', 'Designer: Design watch controls')] } } },
    )

    // The failed child no longer has a live row in the list projection, yet the
    // parent's durable catalog keeps it on the panel with its role intact.
    const failed = list().getByText('Designer').closest('button') as HTMLElement
    expect(failed.textContent).toContain('Design watch controls')
    // No durable completion evidence: the panel shows idle, not invented done.
    expect(failed.querySelector('[data-state="idle"]')).toBeTruthy()
  })

  it('keeps only the same session lineage while its snapshot is pending', () => {
    const { refreshSessions, list, rerender } = mount([
      row('main', 'Main Session'),
      row('child', 'Debate the migration plan', { parentId: 'main', origin: 'subagent' }),
    ], 'child')

    // The selected session's list snapshot is momentarily unavailable (pending
    // re-pull); the panel keeps drawing its own previous tree instead of blanking.
    rerender({ rows: [], phase: 'pending' })

    expect(list().getByText('Main Session')).toBeTruthy()
    expect(list().getByText('Debate the migration plan')).toBeTruthy()
    // Re-rendering never triggers a refresh fetch by itself.
    expect(refreshSessions).not.toHaveBeenCalled()
  })

  it('does not retain a removed session tree after a ready snapshot', () => {
    const { rerender } = mount([
      row('main', 'Main Session'),
      row('child', 'Debate the migration plan', { parentId: 'main', origin: 'subagent' }),
    ], 'main')

    rerender({ rows: [], phase: 'ready' })

    expect(screen.queryByText('Main Session')).toBeNull()
    expect(screen.queryByText('Debate the migration plan')).toBeNull()
    expect(screen.getByText('No subagent sessions yet')).toBeTruthy()
  })

  it('never retains another session root for a newly selected session', () => {
    const { rerender } = mount([
      row('main', 'Main Session'),
      row('child', 'Debate the migration plan', { parentId: 'main', origin: 'subagent' }),
    ], 'child')

    rerender({ sessionId: 'other', rows: [], phase: 'pending' })

    expect(screen.queryByText('Main Session')).toBeNull()
    expect(screen.queryByText('Debate the migration plan')).toBeNull()
    expect(screen.getByText('No subagent sessions yet')).toBeTruthy()
  })
})
