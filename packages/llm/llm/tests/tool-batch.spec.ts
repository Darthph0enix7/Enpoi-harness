import { describe, expect, it } from 'vitest'
import { placeToolBatchExtras } from '../src/tool-batch.ts'
import type { ToolBatchEntry } from '../src/tool-batch.ts'

interface WireMessage {
  readonly role: 'assistant' | 'tool' | 'user'
  readonly id: string
}

const message = (role: WireMessage['role'], id: string): ToolBatchEntry<WireMessage, string> => ({
  kind: 'message',
  message: { role, id },
})
const extra = (value: string): ToolBatchEntry<WireMessage, string> => ({ kind: 'extra', extra: value })

const options = {
  isToolResult: (entry: WireMessage) => entry.role === 'tool',
  renderExtras: (extras: readonly string[]): WireMessage => ({ role: 'user', id: `extras:${extras.join(',')}` }),
}

describe('placeToolBatchExtras', () => {
  it('moves every extra after the batch last result, never between results', () => {
    expect(placeToolBatchExtras([
      message('user', 'ask'),
      message('assistant', 'calls'),
      message('tool', 'a'),
      extra('image-a'),
      message('tool', 'b'),
      extra('image-b'),
      message('user', 'next'),
    ], options)).toEqual([
      { role: 'user', id: 'ask' },
      { role: 'assistant', id: 'calls' },
      { role: 'tool', id: 'a' },
      { role: 'tool', id: 'b' },
      { role: 'user', id: 'extras:image-a,image-b' },
      { role: 'user', id: 'next' },
    ])
  })

  it('flushes at the end when the batch is the final run', () => {
    expect(placeToolBatchExtras([
      message('assistant', 'calls'),
      message('tool', 'a'),
      extra('image-a'),
      message('tool', 'b'),
      extra('image-b'),
    ], options).map(entry => entry.id)).toEqual(['calls', 'a', 'b', 'extras:image-a,image-b'])
  })

  it('keeps separate batches separate and preserves extras without a batch', () => {
    expect(placeToolBatchExtras([
      extra('orphan'),
      message('user', 'ask'),
      message('assistant', 'calls-1'),
      message('tool', 'a'),
      extra('image-a'),
      message('assistant', 'calls-2'),
      message('tool', 'b'),
      extra('image-b'),
    ], options)).toEqual([
      { role: 'user', id: 'extras:orphan' },
      { role: 'user', id: 'ask' },
      { role: 'assistant', id: 'calls-1' },
      { role: 'tool', id: 'a' },
      { role: 'user', id: 'extras:image-a' },
      { role: 'assistant', id: 'calls-2' },
      { role: 'tool', id: 'b' },
      { role: 'user', id: 'extras:image-b' },
    ])
  })

  it('leaves a batch with no extras untouched', () => {
    expect(placeToolBatchExtras([
      message('assistant', 'calls'),
      message('tool', 'a'),
      message('tool', 'b'),
    ], options).map(entry => entry.id)).toEqual(['calls', 'a', 'b'])
  })
})
