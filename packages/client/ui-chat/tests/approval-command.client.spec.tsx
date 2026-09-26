// @vitest-environment jsdom
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApprovalCommand, commandOf, programOf } from '../src/client/chat/ApprovalCommand.tsx'

function props(
  nodes: readonly unknown[],
  callId = 'call-1',
): PropsRuntime<'conversation.approval.detail'> {
  const snapshot = {
    nodes: { values: () => nodes },
  } as unknown as ChatSnapshot
  const useChat = ((selector: (value: ChatSnapshot) => unknown) => selector(snapshot)) as UseChat
  return { callId, useChat } as PropsRuntime<'conversation.approval.detail'>
}

describe('commandOf', () => {
  it('accepts only a string command from valid JSON arguments', () => {
    expect(commandOf(undefined)).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{}' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{"command":42}' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{"command":"pnpm test"}' })).toBe('pnpm test')
  })
})

describe('programOf', () => {
  it('accepts only a non-empty string code from object arguments', () => {
    expect(programOf(undefined)).toBeUndefined()
    expect(programOf({ callId: 'c1', argsRaw: '{' })).toBeUndefined()
    expect(programOf({ callId: 'c1', argsRaw: '[]' })).toBeUndefined()
    expect(programOf({ callId: 'c1', argsRaw: '{}' })).toBeUndefined()
    expect(programOf({ callId: 'c1', argsRaw: '{"code":""}' })).toBeUndefined()
    expect(programOf({ callId: 'c1', argsRaw: '{"code":42}' })).toBeUndefined()
  })

  it('returns the program, its description, and sorted deduplicated referenced tools', () => {
    const source = 'const a = await tools.read({ path: "a" })\nconst b = await tools["bash"]({ command: "ls" })\nawait tools.read({ path: "b" })'
    expect(programOf({ callId: 'c1', argsRaw: JSON.stringify({ code: source, description: '  Summarize files  ' }) }))
      .toEqual({ description: 'Summarize files', source, tools: ['bash', 'read'] })
    expect(programOf({ callId: 'c1', argsRaw: JSON.stringify({ code: 'return 1' }) }))
      .toEqual({ description: '', source: 'return 1', tools: [] })
  })
})

describe('ApprovalCommand', () => {
  it('renders the running correlated Tool command', () => {
    render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: { phase: 'start', callId: 'other', argsRaw: '{"command":"wrong"}' } } },
      { kind: 'tool-call', data: { root: { phase: 'start', callId: 'call-1', argsRaw: '{"command":"pnpm test"}' } } },
    ] as never)} />)

    expect(screen.getByText('pnpm test')).toBeTruthy()
  })

  it('renders the correlated run_code program and the tools it references', () => {
    const argsRaw = JSON.stringify({ code: 'await tools.bash({ command: "ls" })', description: 'List files' })
    render(<ApprovalCommand {...props([
      { kind: 'tool-call', data: { root: { phase: 'start', callId: 'call-1', argsRaw } } },
    ] as never)} />)

    expect(screen.getByText('List files')).toBeTruthy()
    expect(screen.getByText('await tools.bash({ command: "ls" })')).toBeTruthy()
    expect(screen.getByText('Tools referenced in the program:')).toBeTruthy()
    expect(screen.getByText('bash')).toBeTruthy()
  })

  it('omits absent, uncorrelated, preparing, and settled Tool calls', () => {
    const { container, rerender } = render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: undefined } },
      { kind: 'tool-call', data: { root: { phase: 'start', callId: 'other', argsRaw: '{}' } } },
      { kind: 'tool-call', data: { root: { phase: 'preparing', callId: 'call-1', name: 'bash' } } },
      {
        kind: 'tool-call',
        data: { root: { kind: 'tool-result', callId: 'call-1', argsRaw: '{"command":"ignored"}' } },
      },
    ] as never)} />)
    expect(container.textContent).toBe('')

    rerender(<ApprovalCommand {...props([
      { kind: 'tool-call', data: { root: { phase: 'start', callId: 'call-1', argsRaw: '{}' } } },
    ] as never)} />)
    expect(container.textContent).toBe('')
  })
})
