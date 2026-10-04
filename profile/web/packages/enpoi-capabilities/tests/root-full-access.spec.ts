/**
 * Root Full-access seam (the corrected model, 2026-09-28).
 *
 * A MAIN/root session with approval prompts disabled + the danger-full-access
 * sandbox resolves every ask-policy call as ALLOWED — the mode is the
 * operator's standing consent: no card, no denial, an audit line. A normal-mode
 * root still returns the ask (the human card), and a delegated child — even
 * under a Full-access root — still goes through the parent forwarder
 * (forwarding.spec.ts covers the applied parent judgement itself).
 */

import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import { FULL_ACCESS_ASK_REASON } from '../src/policy'

interface FakeEvent {
  type?: string
  data?: Record<string, unknown>
}

/** Fake ctx capturing the listeners `apply` registers. */
function harness() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const ctx = {
    on: (name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, handler)
      return () => {}
    },
    effect: (callback: () => unknown) => {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') (dispose as () => void)() }
    },
    inject: () => {},
    provide: () => {},
    get: () => undefined,
    tools: { guard: () => () => {}, schemas: () => [] },
    setTimeout: () => 0,
    setInterval: () => 0,
    logger: { debug: () => {} },
  }
  apply(ctx as any, {} as any)
  const handler = handlers.get('tools/pre-execute')
  if (handler === undefined) throw new Error('tools/pre-execute listener was not registered')
  return {
    call: (exec: Record<string, unknown>, next: () => Promise<{ kind: string }>) => handler(exec, next),
  }
}

/** A session whose log pins the sandbox mode and the approval policy. */
function agentWith(events: FakeEvent[], header?: Record<string, unknown>) {
  return {
    id: 'root-1',
    session: {
      header,
      seq: events.length,
      eventAt: (index: number) => events[index],
    },
  }
}

const FULL_ACCESS_EVENTS: FakeEvent[] = [
  { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
  { type: 'approval/policy', data: { policy: 'never', source: 'user' } },
]

describe('root session in Full access (approval never + danger-full-access)', () => {
  it('resolves a python3 ask as ALLOWED with the mode named, zero cards, and an audit line', async () => {
    const audit = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { call } = harness()
      // The downstream registry layer returns its usual `ask`; Full access must
      // convert it to an allow instead of a card.
      const next = vi.fn(async () => ({ kind: 'ask' }))
      const decision = await call(
        { name: 'bash', arguments: { command: `python3 -c 'print(1)'` }, agent: agentWith(FULL_ACCESS_EVENTS), callId: 'call-1' },
        next,
      )
      expect(decision).toEqual({ kind: 'allow', reason: FULL_ACCESS_ASK_REASON })
      expect(next).toHaveBeenCalledTimes(1)
      const lines = audit.mock.calls.map(args => String(args[0]))
      expect(lines.some(line => line.includes('audit:') && line.includes('Full access mode') && line.includes('bash'))).toBe(true)
    } finally {
      audit.mockRestore()
    }
  })

  it('resolves an unconfigured tool ask as ALLOWED (some_unknown_mutation)', async () => {
    // cordis_inspect_list used to be the unknown-tool fixture; it now ships an
    // explicit allow row (operator decision 2026-10-02), so the Full-access
    // conversion needs a genuinely unknown name to keep testing the ask path.
    const { call } = harness()
    const decision = await call(
      { name: 'some_unknown_mutation', arguments: {}, agent: agentWith(FULL_ACCESS_EVENTS) },
      async () => ({ kind: 'allow' }),
    )
    expect(decision).toEqual({ kind: 'allow', reason: FULL_ACCESS_ASK_REASON })
  })
})

describe('root session in a normal mode', () => {
  it('returns the ask (the human card), never the Full-access allow', async () => {
    const { call } = harness()
    const decision = await call(
      {
        name: 'bash',
        arguments: { command: `python3 -c 'print(1)'` },
        agent: agentWith([
          { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
          { type: 'approval/policy', data: { policy: 'ask', source: 'user' } },
        ]),
      },
      async () => ({ kind: 'allow' }),
    )
    expect(decision.kind).toBe('ask')
    if (decision.kind === 'ask') expect(decision.reason).toContain('python3')
  })
})

describe('delegated child under a Full-access root', () => {
  it('never borrows the root Full-access allow: the ask goes to the parent forwarder', async () => {
    const { call } = harness()
    const decision = await call(
      {
        name: 'bash',
        arguments: { command: `python3 -c 'print(1)'` },
        agent: agentWith(FULL_ACCESS_EVENTS, {
          id: 'child-1',
          parentSession: 'root-1',
          delegationDepth: 1,
          cwd: '/ws',
        }),
      },
      async () => ({ kind: 'allow' }),
    )
    // No live root in this unit harness: the forwarder fail-closes. The point
    // is that the child did NOT take the root's Full-access allow path.
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('failed closed')
    expect(decision).not.toEqual({ kind: 'allow', reason: FULL_ACCESS_ASK_REASON })
  })
})
