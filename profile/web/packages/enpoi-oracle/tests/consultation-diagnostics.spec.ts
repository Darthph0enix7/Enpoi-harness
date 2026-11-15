import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { createOracleHarness, waitFor } from './harness.ts'

const VERDICT = 'Reviewed thoroughly.\n{"approved":true,"concerns":["minor"],"unverified":[],"blockers":[]}'
const CONCERNS = 'Not ready.\n{"approved":false,"concerns":["race"],"unverified":[],"blockers":[]}'
const harnesses: Array<ReturnType<typeof createOracleHarness>> = []

function harness(
  options: Parameters<typeof createOracleHarness>[0] = {},
  config: Record<string, number> = {},
) {
  const created = createOracleHarness({ humanText: 'build the queue', ...options })
  harnesses.push(created)
  apply(created.ctx as never, { childPollMs: 100, ...config })
  return created
}

afterEach(() => {
  for (const created of harnesses.splice(0)) created.dispose()
})

function background(created: ReturnType<typeof createOracleHarness>, request = 'review in background') {
  return created.tool().execute(
    { request, background: true },
    { agent: created.parent, signal: new AbortController().signal },
  )
}

describe('oracle consultation diagnostics', () => {
  it('settles a resident child from its live log without waiting for it to park', async () => {
    const created = harness()
    await background(created)
    await waitFor(() => created.spawns.length === 1)
    const childId = created.spawns[0]!.childId
    created.setChildLive(childId)

    // No subagent/end edge: a resident child has not parked yet. The asked turn
    // is already closed in its live log.
    created.settleLastSpawn(VERDICT, 'completed', { emitEnd: false })
    await waitFor(() => created.deliveries.length === 1)

    expect(created.deliveries[0]!.kind).toBe('followup')
    expect(created.deliveries[0]!.message.source).toEqual({ kind: 'enpoi-oracle' })
    expect(created.deliveries[0]!.message.content[0]?.text).toContain('APPROVED')
  })

  it('reports a resident child error exactly once with a bounded diagnostic', async () => {
    const created = harness()
    await background(created)
    await waitFor(() => created.spawns.length === 1)
    const childId = created.spawns[0]!.childId
    created.setChildLive(childId)
    created.seedToolResult(childId)

    created.settleLastSpawn('partial report only', 'error', {
      emitEnd: false,
      errorCode: 'PROVIDER_TIMEOUT',
    })
    await waitFor(() => created.deliveries.length === 1)

    const text = created.deliveries[0]!.message.content[0]?.text ?? ''
    expect(created.deliveries[0]!.message.source).toEqual({ kind: 'enpoi-oracle' })
    expect(text).toContain('ended without a usable verdict')
    expect(text).toContain('code: PROVIDER_TIMEOUT')
    expect(text).toContain('recoverability: unknown')
    expect(text).toContain(`turn: ${created.spawns[0]!.messageId}`)
    expect(text).toContain('Inspect its session')
    expect(text).toContain('last successful tool result at event seq 2')
    expect(text).toContain('partial report only')
    expect(text).not.toContain('APPROVED')

    // A duplicate end edge for the same settled child cannot add a second notice.
    created.emitListeners('subagent/end', { id: childId, stopReason: 'error' })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(created.deliveries).toHaveLength(1)
  })

  it('reports a child that ends without the asked turn instead of hanging', async () => {
    const created = harness()
    await background(created)
    await waitFor(() => created.spawns.length === 1)
    created.emitListeners('subagent/end', { id: created.spawns[0]!.childId, stopReason: 'error' })

    await waitFor(() => created.deliveries.length === 1)
    const text = created.deliveries[0]!.message.content[0]?.text ?? ''
    expect(text).toContain('CHILD_ENDED_WITHOUT_TURN')
    expect(text).toContain('persisted state may be stale')
    expect(text).toContain(`turn: ${created.spawns[0]!.messageId}`)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(created.deliveries).toHaveLength(1)
  })

  it('holds a notice for an absent parent and delivers it once on reactivation', async () => {
    const created = harness()
    await background(created)
    await waitFor(() => created.spawns.length === 1)
    created.setParentLive(false)
    created.settleLastSpawn(VERDICT)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(created.deliveries).toHaveLength(0)

    created.setParentLive(true)
    created.emitListeners('agent/created', { agent: created.parent })
    await waitFor(() => created.deliveries.length === 1)
    expect(created.deliveries[0]!.message.content[0]?.text).toContain('APPROVED')

    expect(created.loggerLines.some(line => line.includes('ORACLE_NOTICE_PENDING'))).toBe(true)
    created.emitListeners('agent/created', { agent: created.parent })
    created.emitListeners('agent/status', { agent: created.parent, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(created.deliveries).toHaveLength(1)
  })

  it('delivers a held notice to a new Agent incarnation with the same durable parent id', async () => {
    const created = harness()
    await background(created)
    await waitFor(() => created.spawns.length === 1)
    created.setParentLive(false)
    created.settleLastSpawn(VERDICT)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(created.deliveries).toHaveLength(0)

    // A cold-resumed parent is a new object for the same durable session id.
    created.replaceParent()
    created.setParentLive(true)
    created.emitListeners('agent/created', { agent: created.parent })
    await waitFor(() => created.deliveries.length === 1)
    expect(created.deliveries[0]!.message.content[0]?.text).toContain('APPROVED')
  })

  it('does not blacklist a durable parent id after session disposal', async () => {
    const created = harness()
    await background(created, 'before disposal')
    await waitFor(() => created.spawns.length === 1)
    created.setParentLive(false)
    // Session disposal ends residency; it is not an explicit conversation
    // deletion, so the held notice and the durable id stay usable.
    created.emitListeners('session/disposed', { id: 'parent-1' })
    created.settleLastSpawn(VERDICT)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(created.deliveries).toHaveLength(0)

    created.replaceParent()
    created.setParentLive(true)
    created.emitListeners('agent/created', { agent: created.parent })
    await waitFor(() => created.deliveries.length === 1)

    await background(created, 'after disposal')
    await waitFor(() => created.prompts.length === 1)
    created.settle(created.prompts[0]!.childId, created.prompts[0]!.messageId, CONCERNS)
    await waitFor(() => created.deliveries.length === 2)
    expect(created.deliveries[1]!.message.content[0]?.text).toContain('CONCERNS')
  })

  it('keeps each consultation verdict on its own asked turn', async () => {
    const created = harness()
    await background(created, 'first review')
    await waitFor(() => created.spawns.length === 1)
    created.settleLastSpawn(VERDICT)
    await waitFor(() => created.deliveries.length === 1)

    await background(created, 'second review')
    await waitFor(() => created.prompts.length === 1)
    created.settle(created.prompts[0]!.childId, created.prompts[0]!.messageId, CONCERNS)
    await waitFor(() => created.deliveries.length === 2)

    expect(created.deliveries[0]!.message.content[0]?.text).toContain('APPROVED')
    expect(created.deliveries[1]!.message.content[0]?.text).toContain('CONCERNS')
  })

  it('aligns a blocked ending with core recoverability=no', async () => {
    const created = harness()
    await background(created)
    await waitFor(() => created.spawns.length === 1)
    created.settleLastSpawn('declined the task', 'blocked')
    await waitFor(() => created.deliveries.length === 1)
    const text = created.deliveries[0]!.message.content[0]?.text ?? ''
    expect(text).toContain('code: TURN_BLOCKED')
    expect(text).toContain('recoverability: no (the ending discarded the input)')
  })

  it('emits one timeout diagnostic for a live hung child and never cancels it', async () => {
    const created = harness({}, { backgroundTimeoutMs: 150, childAbsenceGraceMs: 100 })
    await background(created)
    await waitFor(() => created.spawns.length === 1)
    created.setChildLive(created.spawns[0]!.childId)

    await waitFor(() => created.deliveries.length === 1)
    const text = created.deliveries[0]!.message.content[0]?.text ?? ''
    expect(text).toContain('CHILD_TURN_TIMEOUT')
    expect(text).toContain('child was not cancelled')
    expect(text).toContain('recoverable only by inspecting')
    expect(created.interruptions).toHaveLength(0)

    await new Promise(resolve => setTimeout(resolve, 200))
    expect(created.deliveries).toHaveLength(1)
  })

  it('threads childAbsenceGraceMs from plugin config into the watcher', async () => {
    const created = harness({}, { backgroundTimeoutMs: 5_000, childAbsenceGraceMs: 100 })
    await background(created)
    await waitFor(() => created.spawns.length === 1)

    await waitFor(() => created.deliveries.length === 1, 1_000)
    const text = created.deliveries[0]!.message.content[0]?.text ?? ''
    expect(text).toContain('CHILD_TURN_UNREADABLE')
    expect(text).toContain('parked but its persisted log does not carry this turn')
  })

  it('bounds a hung evidence wait with the configured background timeout', async () => {
    const created = harness({}, { backgroundTimeoutMs: 150, childAbsenceGraceMs: 250 })
    const pending = created.tool('request_evidence').execute(
      { target: 'src/core/queue.ts', question: 'how are claims leased?' },
      { agent: created.parent, signal: new AbortController().signal },
    )
    await waitFor(() => created.spawns.length === 1)
    const result = await pending

    expect(result.found).toBe(false)
    expect(String(result.facts)).toContain('did not settle')
    expect(created.drained).toEqual([{
      parentId: 'parent-1',
      childIds: [created.spawns[0]!.childId],
    }])
  })

  it('logs HELD once and recovers the held notice on the next activation', async () => {
    const created = harness()
    created.setDeliveryFailure('always')
    await background(created)
    await waitFor(() => created.spawns.length === 1)
    created.settleLastSpawn(VERDICT)

    await waitFor(() => created.loggerLines.some(line => line.includes('ORACLE_NOTICE_HELD')))
    expect(created.deliveries).toHaveLength(0)
    expect(created.deliveryAttempts()).toBeGreaterThanOrEqual(4)

    created.setDeliveryFailure('none')
    created.emitListeners('agent/created', { agent: created.parent })
    await waitFor(() => created.deliveries.length === 1)
  })

  it('logs UNRESOLVED and clears retry timers when the rail is disposed', async () => {
    const created = harness()
    created.setDeliveryFailure('always')
    await background(created)
    await waitFor(() => created.spawns.length === 1)
    created.settleLastSpawn(VERDICT)
    await waitFor(() => created.deliveryAttempts() >= 1)

    created.dispose()
    const attemptsAtDispose = created.deliveryAttempts()
    expect(created.loggerLines.some(line => line.includes('ORACLE_NOTICE_UNRESOLVED'))).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(created.deliveryAttempts()).toBe(attemptsAtDispose)
  })

  it('returns the recorded failure code in the foreground error result', async () => {
    const created = harness()
    const pending = created.tool().execute(
      { request: 'review this' },
      { agent: created.parent, signal: new AbortController().signal },
    )
    await waitFor(() => created.spawns.length === 1)
    created.settleLastSpawn('partial', 'error', { errorCode: 'PROVIDER_TIMEOUT' })
    const result = await pending

    expect(result.rejected).toBe(true)
    expect(String(result.blockers)).toContain('ORACLE_MODEL_ERROR')
    expect(String(result.blockers)).toContain('PROVIDER_TIMEOUT')
    expect(created.deliveries).toHaveLength(0)
  })
})
