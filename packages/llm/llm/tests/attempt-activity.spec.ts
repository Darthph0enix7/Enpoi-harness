import { afterEach, describe, expect, it, vi } from 'vitest'
import { onAttemptActivity, reportAttemptActivity } from '@deepseek-ai/dsh-llm'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('attempt activity', () => {
  it('delivers every pulse to each listener registered on one attempt signal', () => {
    const signal = new AbortController().signal
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = onAttemptActivity(signal, first)
    const disposeSecond = onAttemptActivity(signal, second)

    reportAttemptActivity(signal)
    reportAttemptActivity(signal)

    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
    disposeFirst()
    disposeSecond()
  })

  it('ignores a pulse with no signal, an aborted attempt, or no listener', () => {
    const listener = vi.fn()
    const disposeMissing = onAttemptActivity(undefined, listener)
    const aborted = new AbortController()
    aborted.abort(new Error('caller cancelled'))
    const disposeAborted = onAttemptActivity(aborted.signal, listener)

    reportAttemptActivity(undefined)
    reportAttemptActivity(aborted.signal)
    reportAttemptActivity(new AbortController().signal)

    expect(listener).not.toHaveBeenCalled()
    disposeMissing()
    disposeAborted()
  })

  it('ignores a pulse after the attempt aborted', () => {
    const controller = new AbortController()
    const listener = vi.fn()
    const dispose = onAttemptActivity(controller.signal, listener)

    controller.abort(new Error('caller cancelled'))
    reportAttemptActivity(controller.signal)

    expect(listener).not.toHaveBeenCalled()
    dispose()
  })

  it('removes a listener once and tolerates repeated or duplicate disposal', () => {
    const signal = new AbortController().signal
    const listener = vi.fn()
    const dispose = onAttemptActivity(signal, listener)
    const duplicate = onAttemptActivity(signal, listener)

    dispose()
    dispose()
    duplicate()
    reportAttemptActivity(signal)

    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps a sibling listener after one registration disposes', () => {
    const signal = new AbortController().signal
    const kept = vi.fn()
    const removed = vi.fn()
    const disposeKept = onAttemptActivity(signal, kept)
    const disposeRemoved = onAttemptActivity(signal, removed)

    disposeRemoved()
    reportAttemptActivity(signal)

    expect(removed).not.toHaveBeenCalled()
    expect(kept).toHaveBeenCalledTimes(1)
    disposeKept()
  })

  it('contains a throwing stderr diagnostic so a pulse never propagates it', () => {
    const signal = new AbortController().signal
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('EPIPE')
    })
    const listener = vi.fn(() => { throw new Error('observer failed') })
    const dispose = onAttemptActivity(signal, listener)

    expect(() => { reportAttemptActivity(signal) }).not.toThrow()
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('contains a throwing listener and reports it without starving the others', () => {
    const signal = new AbortController().signal
    const lines: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk))
      return true
    })
    const failed = vi.fn(() => { throw new Error('observer failed') })
    const threwProse = vi.fn(() => { throw 'observer prose' })
    const after = vi.fn()
    const disposers = [
      onAttemptActivity(signal, failed),
      onAttemptActivity(signal, threwProse),
      onAttemptActivity(signal, after),
    ]

    reportAttemptActivity(signal)

    expect(failed).toHaveBeenCalledTimes(1)
    expect(threwProse).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    expect(lines.join('')).toContain('[llm] attempt activity listener failed: observer failed')
    expect(lines.join('')).toContain('[llm] attempt activity listener failed: observer prose')
    for (const dispose of disposers) dispose()
  })
})
