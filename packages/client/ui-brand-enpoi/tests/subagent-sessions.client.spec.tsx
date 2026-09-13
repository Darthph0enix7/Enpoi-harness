// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { SubagentSessionsBody } from '../src/client/SubagentSessionsBody.tsx'

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
}

function row(id: string, displayTitle: string, extra: Omit<Row, 'id' | 'displayTitle'> = {}): Row {
  return { id, displayTitle, blank: false, updatedAt: 0, ...extra }
}

function mount(rows: Row[], sessionId = 'child') {
  const openSession = vi.fn()
  const byId = Object.fromEntries(rows.map(entry => [entry.id, entry]))
  const useSessions = (selector: (state: { byId: Record<string, Row> }) => unknown) => selector({ byId })
  // Presentation props only: the component never reads the standard seats the
  // renderer would bind (session lifecycle, projections, tab info).
  const props = {
    sessionId,
    useSessions,
    useTabInfo: () => ({}),
    openSession,
    refreshSessions: async () => {},
  } as unknown as Parameters<typeof SubagentSessionsBody>[0]
  const view = render(<SubagentSessionsBody {...props} />)
  return { openSession, view, list: () => within(screen.getByLabelText('Session lineage')) }
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

  it('shows the root → current ancestor strip and jumps up a level from it', () => {
    const { openSession } = mount([
      row('main', 'Main Session'),
      row('child', 'Fixer child', { parentId: 'main', origin: 'subagent' }),
      row('grand', 'Grandchild', { parentId: 'child', origin: 'subagent' }),
    ], 'grand')

    const nav = within(screen.getByRole('navigation', { name: 'Session ancestry' }))
    expect(nav.getByText('Main Session')).toBeTruthy()
    expect(nav.getByText('Fixer child')).toBeTruthy()
    expect(nav.getByText('Grandchild').getAttribute('aria-current')).toBe('page')

    fireEvent.click(nav.getByText('Main Session'))
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
})
