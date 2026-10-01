// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import type { GroupKey, NodeKey, RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  buildChatVirtualItems, chatPendingInputKey, chatVirtualItemKey,
  CHAT_VIRTUALIZATION_THRESHOLD, estimateChatVirtualHeight, openTurnProcessTail,
  type ChatVirtualTailNode,
} from '../src/client/chat/chat-virtual-items.ts'

const nodeEntry = (key: string, groupPart?: string): RenderEntry => ({
  kind: 'node', key: key as NodeKey, ...(groupPart === undefined ? {} : { groupPart }),
})

const groupEntry = (key: string): RenderEntry => ({ kind: 'group', key: key as GroupKey })

const submission = (requestId: string, placement: PendingSubmission['placement'] = 'transcript'): PendingSubmission =>
  ({ requestId, placement, text: requestId } as unknown as PendingSubmission)

const steering = (id: string): InboxState['next-step'][number] =>
  ({ id, source: { kind: 'user' } } as unknown as InboxState['next-step'][number])

describe('chat virtual items', () => {
  it('keeps the durable order and appends trailing pending bubbles', () => {
    const items = buildChatVirtualItems(
      [nodeEntry('a'), groupEntry('g'), nodeEntry('b', 'reasoning')],
      [submission('s1'), steering('i1')],
      false,
    )
    expect(items.map(item => item.kind)).toEqual(['entry', 'entry', 'entry', 'pending', 'pending'])
    expect(items.map(chatVirtualItemKey)).toEqual([
      '["node","a",null]', '["group","g"]', '["node","b","reasoning"]', 'pending\u0000s1', 'steering\u0000i1',
    ])
  })

  it('inserts only the first transcript echo before an open process tail', () => {
    const items = buildChatVirtualItems(
      [nodeEntry('a'), nodeEntry('tail')],
      [submission('s1'), submission('s2', 'queued'), submission('s3')],
      true,
    )
    expect(items.map(item => item.kind)).toEqual(['entry', 'pending', 'entry', 'pending', 'pending'])
    expect(items[1] === undefined ? undefined : chatVirtualItemKey(items[1])).toBe('pending\u0000s1')
    expect(items.at(-2) === undefined ? undefined : chatVirtualItemKey(items.at(-2)!)).toBe('pending\u0000s2')
  })

  it('does not insert without an open process tail or without a transcript echo', () => {
    const withoutEcho = buildChatVirtualItems([nodeEntry('a')], [submission('s1', 'queued')], true)
    expect(withoutEcho.map(item => item.kind)).toEqual(['entry', 'pending'])
    const withoutTail = buildChatVirtualItems([nodeEntry('a')], [submission('s1')], false)
    expect(withoutTail.map(item => item.kind)).toEqual(['entry', 'pending'])
  })

  it('keys pending inputs independently of durable entries', () => {
    expect(chatPendingInputKey(submission('s1'))).toBe('pending\u0000s1')
    expect(chatPendingInputKey(steering('i1'))).toBe('steering\u0000i1')
  })

  it('estimates group rows above node rows and tolerates missing items', () => {
    expect(estimateChatVirtualHeight(undefined)).toBe(96)
    expect(estimateChatVirtualHeight(buildChatVirtualItems([groupEntry('g')], [], false)[0]))
      .toBeGreaterThan(estimateChatVirtualHeight(buildChatVirtualItems([nodeEntry('a')], [], false)[0]))
  })

  it('virtualizes only above the entry threshold', () => {
    const entries = Array.from({ length: CHAT_VIRTUALIZATION_THRESHOLD + 1 }, (_, index) => nodeEntry(`n${String(index)}`))
    expect(buildChatVirtualItems(entries, [], false).length).toBeGreaterThan(CHAT_VIRTUALIZATION_THRESHOLD)
  })

  it('detects an open Turn-process tail that still awaits its first input', () => {
    const nodes = new Map<string, ChatVirtualTailNode>([['tail', {
      kind: 'turn-process', location: { kind: 'turn', turn: { turn: 4, status: 'open' } },
    }]])
    const store = { get: (key: string) => nodes.get(key) }
    expect(openTurnProcessTail([nodeEntry('tail')], store, undefined)).toBe(true)
    expect(openTurnProcessTail([nodeEntry('tail')], store, 4)).toBe(false)
    expect(openTurnProcessTail([nodeEntry('other')], store, undefined)).toBe(false)
    expect(openTurnProcessTail([groupEntry('g')], store, undefined)).toBe(false)
  })
})
