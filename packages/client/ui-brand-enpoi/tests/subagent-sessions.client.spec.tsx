// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { SubagentSessionsBody } from '../src/client/SubagentSessionsBody.tsx'
import { mergeRoleRegistry, type RoleRegistryMap } from '../src/client/role-registry.ts'
import { brandT } from './brand-i18n.client.ts'

/** One projection row the tree builder consumes (structural subset of SessionSummary). */
interface Row {
  id: string
  displayTitle: string
  parentId?: string
  origin?: 'subagent'
  running?: boolean
  completed?: boolean
  blank?: boolean
  updatedAt?: number
  projectionValues?: {
    subagent?: { mode: 'one-shot' | 'continuable'; label?: string; seq?: number }
  }
}

/** Arrival phase of the list projection, as SessionListState carries it. */
type Phase = 'pending' | 'ready'

function row(id: string, displayTitle: string, extra: Omit<Row, 'id' | 'displayTitle'> = {}): Row {
  return { id, displayTitle, blank: false, updatedAt: 0, ...extra }
}

function byIdOf(rows: readonly Row[]): Record<string, Row> {
  return Object.fromEntries(rows.map(entry => [entry.id, entry]))
}

/** One catalog child entry, as the host's subagent catalog projects it. */
function childEntry(id: string, mode: 'one-shot' | 'continuable' = 'continuable', label = 'child') {
  return { kind: 'child' as const, id, mode, label, activity: 'inactive' as const, hasChildren: false }
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
  const rerender = (next: { sessionId?: string; rows?: Row[]; phase?: Phase } = {}): void => {
    const useNextSessions = (selector: (state: { byId: Record<string, Row>; phase: Phase; projectionsBySession: unknown }) => unknown) =>
      selector({ byId: byIdOf(next.rows ?? rows), phase: next.phase ?? phase, projectionsBySession: catalogs })
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

  it('caps rows at 50 and reports the full total', () => {
    const children = Array.from({ length: 60 }, (_, index) => row(`c${index}`, `Child ${index}`, { parentId: 'main', origin: 'subagent' }))
    mount([row('main', 'Main Session'), ...children], 'main')

    expect(screen.getByText(/Showing 50 of 61/)).toBeTruthy()
  })

  it('keeps the empty state when the list projection has no sessions', () => {
    mount([])
    expect(screen.getByText('No subagent sessions yet')).toBeTruthy()
  })

  it('shows the empty state while the first list snapshot is still pending', () => {
    mount([], 'child', 'pending')
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
    expect(critic.textContent!.indexOf('Critic')).toBeLessThan(critic.textContent!.indexOf('Debate the migration plan'))

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
    expect(muse.textContent!.indexOf('The Muse')).toBeLessThan(muse.textContent!.indexOf('Draft the set'))

    // A registry role without a label falls back to the title-cased role id.
    const scribe = list().getByText('Scribe').closest('button') as HTMLElement
    expect(scribe.textContent).toContain('Write the notes')

    // A title naming no registry role keeps the metadata fallback.
    const bare = list().getByText('Unlabeled work').closest('button') as HTMLElement
    expect(within(bare).getByText('Subagent')).toBeTruthy()
  })

  it('keeps the lineage on screen when opening a row lands on a pending snapshot', () => {
    const { openSession, refreshSessions, list, rerender } = mount([
      row('main', 'Main Session'),
      row('child', 'Debate the migration plan', { parentId: 'main', origin: 'subagent' }),
    ])

    fireEvent.click(list().getByText('Main Session'))
    expect(openSession).toHaveBeenCalledWith('main')

    // The switched session's list snapshot is momentarily unavailable (pending
    // re-pull); the panel keeps drawing the previous tree instead of blanking.
    rerender({ sessionId: 'main', rows: [], phase: 'pending' })

    expect(list().getByText('Main Session')).toBeTruthy()
    expect(list().getByText('Debate the migration plan')).toBeTruthy()
    // Opening a row and re-rendering never trigger a refresh fetch by themselves.
    expect(refreshSessions).not.toHaveBeenCalled()
  })
})
