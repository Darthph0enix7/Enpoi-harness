import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIntervalPoll } from '../sidebar-patch/src/client/poll-scheduler.ts'

afterEach(() => { vi.useRealTimers() })

describe('editor visibility poll', () => {
  it('runs one immediate tick per start and no ticks while paused', () => {
    vi.useFakeTimers()
    let ticks = 0
    const poll = createIntervalPoll(() => { ticks += 1 }, 1000)
    poll.start()
    expect(ticks).toBe(1)
    expect(poll.active).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(ticks).toBe(6)
    poll.stop()
    expect(poll.active).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(ticks).toBe(6)
    poll.start()
    expect(ticks).toBe(7)
    vi.advanceTimersByTime(1000)
    expect(ticks).toBe(8)
    poll.start() // already active: must not double-tick or double-interval
    expect(ticks).toBe(8)
    vi.advanceTimersByTime(1000)
    expect(ticks).toBe(9)
    poll.stop()
  })
})
