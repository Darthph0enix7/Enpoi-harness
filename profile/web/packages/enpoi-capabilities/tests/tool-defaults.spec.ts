/**
 * Tool-defaults sandbox proof (operator decision 2026-10-02).
 *
 * Drives the REAL `tools/pre-execute` listener through `apply()` with a fake
 * Cordis ctx (the root-full-access.spec.ts harness) and a normal-mode root
 * session (approval 'ask', workspace-write sandbox). The proof the operator
 * asked for: the integrated tools resolve ALLOW and reach `next()` with NO
 * approval card, while the sensitive set still asks, and the seat table still
 * denies plugin_manager / cordis_inspect_* on orchestrator and sysadmin.
 */

import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'

interface FakeEvent {
  type?: string
  data?: Record<string, unknown>
}

/** Fake ctx capturing the listeners `apply` registers (same as root-full-access.spec.ts). */
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

/** A normal-mode root session pinned to one main-agent seat. */
function agentFor(seat: string, events: FakeEvent[] = NORMAL_MODE_EVENTS) {
  return {
    id: `${seat}-1`,
    session: {
      header: { agentPreset: seat },
      seq: events.length,
      eventAt: (index: number) => events[index],
    },
  }
}

const NORMAL_MODE_EVENTS: FakeEvent[] = [
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'approval/policy', data: { policy: 'ask', source: 'user' } },
]

const MAIN_SEATS = ['orchestrator', 'sysadmin', 'creator'] as const

/** Tools whose shipped row is allow and that no seat table restricts. */
const INTEGRATED_ALLOW = [
  'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'ralph', 'workflow', 'tool_groups',
] as const

/** Tools the seat table restricts to the creator seat. */
const CREATOR_ONLY = ['plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query'] as const

describe('newly allowed integrated tools reach next() with no approval card', () => {
  for (const seat of MAIN_SEATS) {
    it(`allows the integrated set on the ${seat} seat without a card`, async () => {
      const { call } = harness()
      for (const tool of INTEGRATED_ALLOW) {
        const next = vi.fn(async () => ({ kind: 'allow' }))
        const decision = await call({ name: tool, arguments: {}, agent: agentFor(seat), callId: `call-${tool}` }, next)
        expect(decision, `${tool} on ${seat}`).toEqual({ kind: 'allow' })
        expect(next, `${tool} on ${seat} never reached next()`).toHaveBeenCalledTimes(1)
      }
    })
  }

  it('allows plugin_manager and cordis_inspect_* on the creator seat without a card', async () => {
    const { call } = harness()
    for (const tool of CREATOR_ONLY) {
      const next = vi.fn(async () => ({ kind: 'allow' }))
      const decision = await call({ name: tool, arguments: {}, agent: agentFor('creator'), callId: `call-${tool}` }, next)
      expect(decision, tool).toEqual({ kind: 'allow' })
      expect(next, `${tool} never reached next()`).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps the seat guard final on orchestrator and sysadmin (deny, naming the seat)', async () => {
    const { call } = harness()
    for (const seat of ['orchestrator', 'sysadmin'] as const) {
      for (const tool of CREATOR_ONLY) {
        const next = vi.fn(async () => ({ kind: 'allow' }))
        const decision = await call({ name: tool, arguments: {}, agent: agentFor(seat), callId: `call-${tool}` }, next)
        expect(decision.kind, `${tool} on ${seat}`).toBe('deny')
        if (decision.kind === 'deny') {
          expect(decision.reason).toContain('restricted to the creator seat')
          expect(decision.reason).toContain(seat)
        }
        expect(next, `${tool} on ${seat} must not reach next()`).not.toHaveBeenCalled()
      }
    }
  })
})

describe('the sensitive set still asks or denies as decided', () => {
  it('bash danger verbs still ask (card), benign commands still run', async () => {
    const { call } = harness()
    const danger = await call(
      { name: 'bash', arguments: { command: 'rm -rf /tmp/x' }, agent: agentFor('orchestrator'), callId: 'bash-rm' },
      async () => ({ kind: 'allow' }),
    )
    expect(danger.kind).toBe('ask')
    const benign = await call(
      { name: 'bash', arguments: { command: 'git status' }, agent: agentFor('orchestrator'), callId: 'bash-git' },
      async () => ({ kind: 'allow' }),
    )
    expect(benign.kind).toBe('allow')
  })

  it('ships explicit ask rows for the remaining sensitive tools', async () => {
    const { call } = harness()
    for (const tool of ['str_replace_editor', 'interrupt_agent', 'job_kill', 'council_register']) {
      const next = vi.fn(async () => ({ kind: 'allow' }))
      const decision = await call({ name: tool, arguments: {}, agent: agentFor('orchestrator'), callId: `call-${tool}` }, next)
      expect(decision.kind, tool).toBe('ask')
      expect(next, `${tool} must not reach next()`).not.toHaveBeenCalled()
    }
  })

  it('an unconfigured future tool still asks through defaults.unknownTools', async () => {
    const { call } = harness()
    const decision = await call({ name: 'brand_new_tool', arguments: {}, agent: agentFor('orchestrator') }, async () => ({ kind: 'allow' }))
    expect(decision.kind).toBe('ask')
  })
})
