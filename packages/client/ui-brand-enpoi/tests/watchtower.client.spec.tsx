// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { WatchtowerView } from '../src/client/WatchtowerView.tsx'
import { TheMarkTaskCard } from '../src/client/TheMarkTaskCard.tsx'

describe('Enpoi Harness UI — Watchtower (minimal, projected-only)', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the keeper brief sections from live projection data only (UI-1, zero hardcoding)', () => {
    const mockProjections: Record<string, unknown> = {
      livingBrief: {
        asOfSeq: 42,
        freshness: 'live',
        prose: {
          text: [
            '🎯 ACTIVE GOAL & CORE TRAJECTORY:',
            '- Ship the Phase 5 minimal Watchtower.',
            '',
            '📚 DOCUMENTATION & SPECIFICATIONS:',
            '- ~/dsh-migration/39-phase5-ui-experience-plan.md',
            '',
            '🏛 ARCHITECTURAL INVARIANTS:',
            '- Sandbox: workspace-write; approvals ask.',
            '- Skills load explicitly.',
            '',
            '🚫 REJECTED APPROACHES:',
            '- No docked headers over composer.',
            '',
            '⚡ BLOCKERS:',
            '- None open.',
          ].join('\n'),
        },
        filesTouched: ['/home/adam/plan.md'],
      },
      oracleScorecard: { status: 'approved' },
      councilState: { status: 'consensus' },
      memoryLedger: { committedCount: 43 },
    }

    render(
      <WatchtowerView
        sessionId="session-test-123"
        useSession={selector => selector({ displayTitle: 'Test Session', sessionId: 'session-test-123' })}
        useProjection={<T,>(key: string): T => mockProjections[key] as T}
      />,
    )

    expect(screen.getByText('Ship the Phase 5 minimal Watchtower.')).toBeTruthy()
    expect(screen.getByText('~/dsh-migration/39-phase5-ui-experience-plan.md')).toBeTruthy()
    expect(screen.getByText('Sandbox: workspace-write; approvals ask.')).toBeTruthy()
    expect(screen.getByText('No docked headers over composer.')).toBeTruthy()
    expect(screen.getByText('None open.')).toBeTruthy()
    expect(screen.getByText('43')).toBeTruthy()
  })

  it('shows the idle keeper empty state when no brief exists — never invented copy', () => {
    render(
      <WatchtowerView
        sessionId="session-test-123"
        useSession={selector => selector({ displayTitle: 'Fresh', sessionId: 'session-test-123' })}
        useProjection={<T,>(): T => undefined as T}
      />,
    )
    expect(screen.getByText(/keeper idle/i)).toBeTruthy()
  })

  it('TheMarkTaskCard freezes calligraphy on interrupt/park (UI-4)', () => {
    const { rerender } = render(
      <TheMarkTaskCard
        taskId="task-1"
        persona="Fixer"
        title="Refactor auth module"
        status="running"
        currentTool="ast_grep_search"
      />,
    )

    expect(screen.getByText(/Running: ast_grep_search/i)).toBeTruthy()

    rerender(
      <TheMarkTaskCard
        taskId="task-1"
        persona="Fixer"
        title="Refactor auth module"
        status="interrupted"
      />,
    )

    expect(screen.getByText(/\[Interrupted at: ast_grep_search\]/i)).toBeTruthy()
  })
})
