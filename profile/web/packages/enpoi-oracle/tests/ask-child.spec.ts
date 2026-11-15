import { describe, expect, it } from 'vitest'
import {
  askChild,
  ChildTurnTimeoutError,
  ChildTurnUnavailableError,
  textOfContent,
  waitForChildMessageTurn,
} from '../src/ask-child.ts'
import { createOracleHarness, waitFor } from './harness.ts'

const VERDICT = 'Reviewed.\n{"approved":true,"concerns":[],"unverified":[],"blockers":[]}'

describe('ask-child report extraction', () => {
  it('keeps text blocks and drops reasoning and tool calls', () => {
    expect(textOfContent([
      { type: 'reasoning', text: 'private' },
      { type: 'text', text: 'answer' },
    ])).toBe('answer')
    expect(textOfContent([{ type: 'tool-call', callId: 'c', name: 'noop', argsRaw: '{}' }])).toBe('')
    expect(textOfContent(undefined)).toBe('')
  })
})

describe('waitForChildMessageTurn', () => {
  it('settles a parked turn on the asked message id', async () => {
    const harness = createOracleHarness()
    const childId = 'child-1'
    const messageId = 'msg-1'
    const pending = waitForChildMessageTurn(harness.ctx as never, childId as never, messageId as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
      pollMs: 20,
    })
    // The child log has no matching prompt yet: the wait keeps going.
    await new Promise(resolve => setTimeout(resolve, 30))
    harness.seedPrompt(childId, messageId, 'review this')
    harness.settle(childId, messageId, VERDICT)
    const result = await pending
    expect(result.messageId).toBe(messageId)
    expect(result.text).toBe(VERDICT)
    expect(result.stopReason).toBe('completed')
  })


  it('settles a resident child from its live log without waiting for it to park', async () => {
    const harness = createOracleHarness()
    harness.setChildLive('child-1')
    harness.seedPrompt('child-1', 'msg-1', 'review this')
    harness.settle('child-1', 'msg-1', VERDICT, 'completed', { emitEnd: false })

    const result = await waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
      pollMs: 20,
    })
    expect(result.text).toBe(VERDICT)
    expect(result.stopReason).toBe('completed')
  })

  it('needs only the live child when sessionPersistence is unavailable', async () => {
    const harness = createOracleHarness()
    delete harness.ctx.sessionPersistence
    harness.setChildLive('child-1')
    harness.seedPrompt('child-1', 'msg-1', 'review this')
    harness.settle('child-1', 'msg-1', VERDICT, 'completed', { emitEnd: false })

    const result = await waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
      pollMs: 20,
    })
    expect(result.text).toBe(VERDICT)
  })

  it('never reports a later turn when the asked turn is still open', async () => {
    const harness = createOracleHarness()
    harness.setChildLive('child-1')
    harness.seedPrompt('child-1', 'msg-1', 'first review')
    harness.seedPrompt('child-1', 'msg-2', 'second review')
    harness.settle('child-1', 'msg-2', 'VERDICT FOR THE SECOND TURN', 'completed', { emitEnd: false })

    const error = await waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 80,
      pollMs: 10,
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ChildTurnTimeoutError)
  })

  it('keeps scanning past a synthetic user message inside the asked turn', async () => {
    const harness = createOracleHarness()
    harness.seedPrompt('child-1', 'msg-1', 'review this')
    harness.seedSyntheticUser('child-1', 'injected context')
    harness.settle('child-1', 'msg-1', VERDICT)

    const result = await waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
      pollMs: 20,
    })
    expect(result.text).toBe(VERDICT)
  })

  it('keeps scanning past a human steering message inside the asked turn', async () => {
    const harness = createOracleHarness()
    harness.seedPrompt('child-1', 'msg-1', 'review this')
    harness.seedSteeringUser('child-1', 'also check the retry path')
    harness.settle('child-1', 'msg-1', VERDICT)

    const result = await waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
      pollMs: 20,
    })
    expect(result.text).toBe(VERDICT)
  })

  it('reports a child that ended before the asked turn was recorded', async () => {
    const harness = createOracleHarness()
    harness.seedPrompt('child-1', 'msg-1', 'review this')
    const pending = waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
      pollMs: 20,
    })
    harness.emitListeners('subagent/end', { id: 'child-1', stopReason: 'error' })

    const error = await pending.catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ChildTurnUnavailableError)
    expect((error as ChildTurnUnavailableError).reason).toBe('ended')
    expect((error as ChildTurnUnavailableError).messageId).toBe('msg-1')
  })

  it('reports an unreadable parked child after the bounded absence grace', async () => {
    const harness = createOracleHarness()
    harness.seedPrompt('child-1', 'msg-1', 'review this')
    const error = await waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
      pollMs: 10,
      absenceGraceMs: 40,
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ChildTurnUnavailableError)
    expect((error as ChildTurnUnavailableError).reason).toBe('unreadable-parked')
  })

  it('returns the recorded failure code and last successful tool result', async () => {
    const harness = createOracleHarness()
    harness.setChildLive('child-1')
    harness.seedPrompt('child-1', 'msg-1', 'review this')
    harness.seedToolResult('child-1')
    harness.settle('child-1', 'msg-1', 'partial', 'error', { emitEnd: false, errorCode: 'PROVIDER_TIMEOUT' })

    const result = await waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
      pollMs: 20,
    })
    expect(result.stopReason).toBe('error')
    expect(result.failureCode).toBe('PROVIDER_TIMEOUT')
    expect(Number(result.lastSuccessfulOperationSeq)).toBe(2)
  })

  it('keeps waiting when the log does not carry the asked message', async () => {
    const harness = createOracleHarness()
    const pending = waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 60,
      pollMs: 10,
    })
    await expect(pending).rejects.toBeInstanceOf(ChildTurnTimeoutError)
  })

  it('maps the child turn end onto the C9 stop reasons', async () => {
    const harness = createOracleHarness()
    const pending = waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 2_000,
      pollMs: 20,
    })
    harness.seedPrompt('child-1', 'msg-1', 'review this')
    harness.settle('child-1', 'msg-1', 'partial', 'error')
    const result = await pending
    expect(result.stopReason).toBe('error')
    expect(result.error).toBe('provider exploded')
  })

  it('raises ChildTurnTimeoutError naming the child and message', async () => {
    const harness = createOracleHarness()
    const error = await waitForChildMessageTurn(harness.ctx as never, 'child-9' as never, 'msg-9' as never, {
      signal: new AbortController().signal,
      deadline: Date.now() + 40,
      pollMs: 10,
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ChildTurnTimeoutError)
    expect((error as ChildTurnTimeoutError).childId).toBe('child-9')
    expect((error as ChildTurnTimeoutError).messageId).toBe('msg-9')
  })

  it('raises the caller abort reason without cancelling the child', async () => {
    const harness = createOracleHarness()
    const controller = new AbortController()
    const pending = waitForChildMessageTurn(harness.ctx as never, 'child-1' as never, 'msg-1' as never, {
      signal: controller.signal,
      deadline: Date.now() + 10_000,
      pollMs: 20,
    })
    controller.abort(new Error('cancelled by caller'))
    await expect(pending).rejects.toThrow('cancelled by caller')
  })
})

describe('askChild', () => {
  it('delivers the prompt through the host adapter and returns the settled turn', async () => {
    const harness = createOracleHarness()
    const pending = askChild(
      harness.ctx as never,
      harness.parent as never,
      'child-1' as never,
      [{ type: 'text', text: 'review this' }],
      { signal: new AbortController().signal, deadline: Date.now() + 2_000, pollMs: 20 },
    )
    await waitFor(() => harness.prompts.length === 1)
    expect(harness.prompts[0]!.childId).toBe('child-1')
    expect(harness.prompts[0]!.content).toBe('review this')
    expect(harness.prompts[0]!.source).toEqual({ kind: 'user' })
    harness.settle('child-1', harness.prompts[0]!.messageId, VERDICT)
    const result = await pending
    expect(result.text).toBe(VERDICT)
  })
})
