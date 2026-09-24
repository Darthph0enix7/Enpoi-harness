import { describe, expect, it } from 'vitest'
import { FORK_OWNED_SESSION_EVENT_TYPES, SessionSeq, adoptSessionEvent, forkOwnedEventType } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

describe('fork event namespace tolerance', () => {
  it('restores a namespaced fork-owned type to its original name and leaves others alone', () => {
    for (const type of FORK_OWNED_SESSION_EVENT_TYPES) {
      expect(forkOwnedEventType(`plugin:${type}`)).toBe(type)
      expect(forkOwnedEventType(type)).toBe(type)
    }
    expect(forkOwnedEventType('plugin:external/future')).toBe('plugin:external/future')
    expect(forkOwnedEventType('plugin:user/message')).toBe('plugin:user/message')
    expect(forkOwnedEventType('user/message')).toBe('user/message')
  })

  it('adopts a namespaced fork record under its original name', () => {
    const event = adoptSessionEvent({
      type: 'plugin:revert/state',
      seq: SessionSeq(3),
      time: 4,
      data: { fromSeq: 2, cause: 'revert' },
      ignorable: true,
    } as unknown as SessionEvent)
    expect(event.type).toBe('revert/state')
  })
})
