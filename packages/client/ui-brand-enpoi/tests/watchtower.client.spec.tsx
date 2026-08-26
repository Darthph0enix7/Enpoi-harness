// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { WatchtowerView } from '../src/client/WatchtowerView.tsx'
import { WatchtowerDock } from '../src/client/WatchtowerDock.tsx'
import { TheMarkTaskCard } from '../src/client/TheMarkTaskCard.tsx'
import { FleetPersonaModelPicker } from '../src/client/FleetPersonaModelPicker.tsx'

describe('Enpoi Harness UI - Phase 5 Component Tests', () => {
  afterEach(() => {
    cleanup()
  })

  it('WatchtowerView renders reactive projection data (UI-1)', () => {
    const mockProjections: Record<string, unknown> = {
      livingBrief: {
        goal: 'Implement Phase 5 UI Experience Layer',
        asOfSeq: 42,
        freshness: 'live',
        prose: {
          text: '🎯 ACTIVE GOAL & CORE TRAJECTORY:\n- Build Watchtower canvas and fleet model routing.\n\n📚 SPECIFICATIONS & DOCUMENTATION MAP:\n- ~/dsh-migration/39-phase5-ui-experience-plan.md — UI plan\n\n🏛️ ARCHITECTURAL INVARIANTS & CONCRETE DECISIONS:\n- Zero client-side session log parsing.\n\n🚫 REJECTED APPROACHES & EDGE CASES:\n- Banned raw child stream noise in parent.\n\n⚡ ACTIVE BLOCKERS & OPEN THREADS:\n- None.',
        },
        filesTouched: ['/home/adam/plan.md'],
      },
      oracleScorecard: { status: 'approved' },
      councilState: { status: 'consensus', consensusRatio: 0.98 },
      memoryLedger: { committedCount: 43 },
    }

    const projectionHook = <T,>(key: string): T => mockProjections[key] as T
    render(
      <WatchtowerView
        sessionId="session-test-123"
        useSession={selector => selector({ displayTitle: 'Test Session', sessionId: 'session-test-123' })}
        useProjection={projectionHook}
      />,
    )

    expect(screen.getByText(/The Watchtower/i)).toBeTruthy()
    expect(screen.getByText(/● LIVE/i)).toBeTruthy()
    expect(screen.getByText(/Build Watchtower canvas and fleet model routing/i)).toBeTruthy()
    expect(screen.getByText(/39-phase5-ui-experience-plan/i)).toBeTruthy()
    expect(screen.getByText(/43 Facts/i)).toBeTruthy()
  })

  it('WatchtowerDock renders ambient status and triggers emergency halt (UI-2)', () => {
    const mockProjections: Record<string, unknown> = {
      livingBrief: { goal: 'Active Milestone 5 Goal' },
      oracleScorecard: { status: 'ready' },
      councilState: { status: 'ready' },
    }

    const projectionHook = <T,>(key: string): T => mockProjections[key] as T
    render(
      <WatchtowerDock
        sessionId="session-test-123"
        useSession={selector => selector({ displayTitle: 'Test Session', sessionId: 'session-test-123' })}
        useProjection={projectionHook}
      />,
    )

    expect(screen.getByText(/Active Milestone 5 Goal/i)).toBeTruthy()
    expect(screen.getByText(/🛡️ Oracle Ready/i)).toBeTruthy()
    expect(screen.getByText(/🏛️ Council Ready/i)).toBeTruthy()

    const haltBtn = screen.getByRole('button', { name: /Halt/i })
    expect(haltBtn).toBeTruthy()
    fireEvent.click(haltBtn)
    expect(screen.getByText(/🛑 Halting.../i)).toBeTruthy()
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

    // Transition to interrupted: calligraphy must freeze the last active tool
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

  it('FleetPersonaModelPicker toggles popover and triggers selection', () => {
    const onSelect = vi.fn()
    render(
      <FleetPersonaModelPicker
        persona="The Oracle"
        currentModel="antigravity/gemini-3.7-flash-tiered"
        onSelectModel={onSelect}
      />,
    )

    const trigger = screen.getByTitle(/Select model for The Oracle/i)
    expect(trigger.textContent).toContain('Gemini 3.7 Flash')

    fireEvent.click(trigger)
    expect(screen.getByPlaceholderText(/Search models/i)).toBeTruthy()

    const deepseekOption = screen.getByText('DeepSeek V4 Flash')
    fireEvent.click(deepseekOption)
    expect(onSelect).toHaveBeenCalledWith('deepseek', 'deepseek-v4-flash')
  })
})
