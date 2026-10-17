// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ToolCallCommonProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { TheMarkTaskCardAdapter, type TheMarkTaskCardAdapterProps } from '../src/client/TheMarkTaskCardAdapter.tsx'
import { TheMarkTaskCard } from '../src/client/TheMarkTaskCard.tsx'
import { brandT } from './brand-i18n.client.ts'

afterEach(cleanup)

const IMAGE_LOADER = Object.assign(async (): Promise<string> => '', { peek: () => undefined })

/** Minimal settled subagent result whose rendered card is the subject. */
function result(overrides: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 10,
    time: 1_000,
    callId: 'call_1',
    call: { name: 'subagent', argsRaw: '{"description":"research the thing"}' },
    callTime: 500,
    content: [{ type: 'text', text: 'started subagent child-1' }],
    isError: false,
    subCalls: [],
    ...overrides,
  }
}

/** Adapter props for one block; unused framework seats get inert stubs. */
function adapterProps(block: ToolResultNode | StartedToolCall): TheMarkTaskCardAdapterProps {
  const common: ToolCallCommonProps = {
    toolName: 'subagent',
    callId: block.callId,
    useDisclosure: () => ({ expanded: false, setExpanded: () => {}, toggle: () => {} }),
    openFile: () => {},
    loadImage: IMAGE_LOADER,
  }
  return 'kind' in block
    ? { ...common, t: brandT, phase: 'result', block }
    : { ...common, t: brandT, phase: 'start', block }
}

describe('TheMarkTaskCard status truth', () => {
  it('renders a settled success without any interruption marker', () => {
    const { container } = render(<TheMarkTaskCardAdapter {...adapterProps(result())} />)
    expect(screen.queryByText(/interrupted/i)).toBeNull()
    expect(container.querySelector('[data-mark-task-card]')).not.toBeNull()
    expect(container.querySelector('[title="Completed"]')).not.toBeNull()
    expect(container.querySelector('[title="Interrupted"]')).toBeNull()
  })

  it('maps a synthetically interrupted tool result to the interrupted status', () => {
    const interrupted = result({
      isError: true,
      error: { name: 'Interrupted', code: 'interrupted' },
      content: [],
    })
    const { container } = render(<TheMarkTaskCardAdapter {...adapterProps(interrupted)} />)
    expect(container.querySelector('[title="Interrupted"]')).not.toBeNull()
    expect(container.querySelector('[title="Failed"]')).toBeNull()
  })

  it('still maps a real failure to failed, not interrupted', () => {
    const failed = result({ isError: true, error: { name: 'Error', code: 'E_BOOM' } })
    const { container } = render(<TheMarkTaskCardAdapter {...adapterProps(failed)} />)
    expect(container.querySelector('[title="Failed"]')).not.toBeNull()
    expect(container.querySelector('[title="Interrupted"]')).toBeNull()
  })

  it('shows the live strip while the call is running', () => {
    const running: StartedToolCall = {
      phase: 'start',
      callId: 'call_1',
      name: 'subagent',
      turn: 1,
      step: 1,
      time: 1_000,
      argsRaw: '{"description":"research the thing"}',
      subCalls: [],
    }
    render(<TheMarkTaskCardAdapter {...adapterProps(running)} />)
    expect(screen.getByText('Executing: subagent')).not.toBeNull()
    expect(screen.queryByText(/interrupted/i)).toBeNull()
  })
})

describe('TheMarkTaskCard calligraphy strip', () => {
  const base = {
    taskId: 'call_1',
    persona: 'Librarian',
    title: 'research the thing',
    t: brandT,
  } as const

  it('freezes the latched tool only for a genuine interruption', () => {
    const { rerender } = render(
      <TheMarkTaskCard {...base} status="running" currentTool="subagent" />,
    )
    expect(screen.getByText('Executing: subagent')).not.toBeNull()
    rerender(<TheMarkTaskCard {...base} status="interrupted" />)
    expect(screen.getByText('[Interrupted at: subagent]')).not.toBeNull()
  })

  it('drops the strip when the call settles (no false interruption)', () => {
    const { rerender, container } = render(
      <TheMarkTaskCard {...base} status="running" currentTool="subagent" />,
    )
    expect(container.textContent).toContain('Executing: subagent')
    rerender(<TheMarkTaskCard {...base} status="settled" />)
    expect(container.textContent).not.toContain('Executing: subagent')
    expect(screen.queryByText(/interrupted/i)).toBeNull()
  })
})
