// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { WatchtowerView } from '../src/client/WatchtowerView.tsx'
import { TheMarkTaskCard } from '../src/client/TheMarkTaskCard.tsx'
import { TheMarkTaskCardAdapter } from '../src/client/TheMarkTaskCardAdapter.tsx'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { brandT } from './brand-i18n.client.ts'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'

describe('Enpoi Harness UI — Watchtower & TheMarkTaskCard', () => {
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
      <WatchtowerView t={brandT}
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
      <WatchtowerView t={brandT}
        sessionId="session-test-123"
        useSession={selector => selector({ displayTitle: 'Fresh', sessionId: 'session-test-123' })}
        useProjection={<T,>(): T => undefined as T}
      />,
    )
    expect(screen.getByText(/keeper idle/i)).toBeTruthy()
  })

  it('TheMarkTaskCard freezes calligraphy on interrupt/park (UI-4)', () => {
    const { rerender } = render(
      <TheMarkTaskCard t={brandT}
        taskId="task-1"
        persona="Fixer"
        title="Refactor auth module"
        status="running"
        currentTool="ast_grep_search"
      />,
    )

    expect(screen.getByText(/Executing: ast_grep_search/i)).toBeTruthy()

    rerender(
      <TheMarkTaskCard t={brandT}
        taskId="task-1"
        persona="Fixer"
        title="Refactor auth module"
        status="interrupted"
      />,
    )

    expect(screen.getByText(/\[Interrupted at: ast_grep_search\]/i)).toBeTruthy()
  })

  it('TheMarkTaskCard renders model pill, sub-tools activity timeline, expandable output, and calls onOpenSession', () => {
    const onOpen = vi.fn()
    render(
      <TheMarkTaskCard t={brandT}
        taskId="task-2"
        persona="📚 Librarian"
        title="Research WebSockets vs SSE"
        model="antigravity/gemini-3.7-flash-tiered"
        status="settled"
        durationMs={2400}
        childSessionId="session-child-abc-123"
        subTools={['web_search', 'read']}
        outputSummary="WebSockets provide full-duplex communication over a single TCP connection."
        onOpenSession={onOpen}
      />,
    )

    expect(screen.getByText('Librarian')).toBeTruthy()
    expect(screen.getByText('Research WebSockets vs SSE')).toBeTruthy()
    expect(screen.getByText('gemini-3.7-flash-tiered')).toBeTruthy()
    expect(screen.getByText('⏱️ 2.4s')).toBeTruthy()

    // Click header to expand
    fireEvent.click(screen.getByText('Research WebSockets vs SSE'))

    expect(screen.getByText(/Tools Executed \(2\)/i)).toBeTruthy()
    expect(screen.getByText('web_search')).toBeTruthy()
    expect(screen.getByText('read')).toBeTruthy()

    expect(screen.getByText('Output & Findings')).toBeTruthy()
    expect(screen.getByText(/WebSockets provide full-duplex/i)).toBeTruthy()

    const openBtn = screen.getByText(/Open Subagent Session/i)
    fireEvent.click(openBtn)
    expect(onOpen).toHaveBeenCalledWith('session-child-abc-123')
  })

  it('TheMarkTaskCardAdapter adapts subagent tool calls into custom in-chat card with sub-tools', () => {
    const openSession = vi.fn()
    const mockBlock: ToolResultNode = {
      kind: 'tool-result',
      callId: 'call-sub-1',
      callTime: 1000,
      time: 2500,
      isError: false,
      call: {
        name: 'subagent',
        argsRaw: JSON.stringify({
          description: 'Explore codebase architecture',
          prompt: 'You are the Explorer. Map the repository directory structure.',
        }),
      },
      subCalls: [
        {
          kind: 'tool-result',
          callId: 'call-sub-child-1',
          callTime: 1100,
          time: 1500,
          isError: false,
          call: { name: 'grep', argsRaw: '{"pattern":"class"}' },
          content: [],
          subCalls: [],
          seq: 10,
        },
      ],
      content: [{ type: 'text', text: 'Started subagent session-child-999\nRepository mapped successfully.' }],
      seq: 12,
    }

    render(
      <TheMarkTaskCardAdapter t={brandT}
        callId="call-sub-1"
        toolName="subagent"
        phase="result"
        useDisclosure={useDisclosure}
        block={mockBlock}
        openFile={vi.fn()}
        loadImage={vi.fn(() => Promise.resolve('blob:test')) as unknown as Parameters<typeof TheMarkTaskCardAdapter>[0]['loadImage']}
        openSession={openSession}
      />,
    )

    expect(screen.getByText('Explorer')).toBeTruthy()
    expect(screen.getByText('Explore codebase architecture')).toBeTruthy()

    // Expand
    fireEvent.click(screen.getByText('Explore codebase architecture'))
    expect(screen.getByText('grep')).toBeTruthy()
    expect(screen.getByText(/Repository mapped successfully/i)).toBeTruthy()

    const openBtn = screen.getByText(/Open Subagent Session/i)
    fireEvent.click(openBtn)
    expect(openSession).toHaveBeenCalledWith('session-child-999')
  })
})
