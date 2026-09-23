import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import { afterEach, describe, expect, it } from 'vitest'
import { PeerPairingsStore } from '../src/pairings.ts'
import { PeerAskRegistry } from '../src/registry.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface FakeSession {
  readonly id: SessionId
  readonly header: { readonly parentSession?: SessionId }
}

function fakeAgent(id: string, parentSession?: string): Agent {
  const session: FakeSession = {
    id: id as SessionId,
    header: parentSession === undefined ? {} : { parentSession: parentSession as SessionId },
  }
  return { id: id as SessionId, session } as unknown as Agent
}

function harness(sessionIds: readonly string[]): {
  ctx: Context
  registry: PeerAskRegistry
  store: PeerPairingsStore
  agents: Map<SessionId, Agent>
} {
  const root = mkdtempSync(join(tmpdir(), 'peer-registry-'))
  roots.push(root)
  const pairingsPath = join(root, 'pairings.yaml')
  writeFileSync(pairingsPath, [
    'version: 1',
    'device: serverlocal',
    'pairings:',
    ...sessionIds.flatMap(id => [
      `  - alias: alias-${id}`,
      '    peer: laptop',
      '    exposure: answer-only',
      `    sessionId: ${id}`,
    ]),
  ].join('\n'))
  const ctx = new Context()
  contexts.push(ctx)
  const agents = new Map<SessionId, Agent>()
  ctx.provide('agents', {
    get: (id: SessionId) => agents.get(id),
    isOwnedBy: () => false,
  } as never)
  ctx.provide('sessionQuery', {
    observeSession: async (id: SessionId) => {
      const agent = agents.get(id)
      if (agent === undefined) throw new Error(`no session ${String(id)}`)
      return {
        header: (agent.session as unknown as { header: object }).header,
        cursor: -1,
        events: [],
        [Symbol.dispose]: () => {},
      }
    },
  } as never)
  const store = new PeerPairingsStore(pairingsPath, join(root, 'peer-state.json'))
  const registry = new PeerAskRegistry(ctx, store)
  registry.install()
  return { ctx, registry, store, agents }
}

function approvalRequest(agent: Agent): { agent: Agent; toolName: string } {
  return { agent, toolName: 'bash' }
}

describe('ask registry race', () => {
  it('exposes a paired ask and settles it from the peer side', async () => {
    const { ctx, registry, store, agents } = harness(['root'])
    const agent = fakeAgent('root')
    agents.set(agent.id, agent)
    const pending = ctx.waterfall(
      scopeTarget(agent, agent),
      'approval/request',
      approvalRequest(agent),
      () => new Promise<ApprovalOutcome>(() => { /* the local chain parks until a human answers */ }),
    )
    await Promise.resolve()
    await Promise.resolve()
    const asks = registry.pendingFor('root' as SessionId)
    expect(asks).toHaveLength(1)
    const askId = asks[0]!.askId
    const resolved = store.exposed('root' as SessionId)!
    expect(registry.answer(resolved, askId, { kind: 'approval', outcome: 'allowed-once' }))
      .toEqual({ accepted: true, settled: true })
    await expect(pending).resolves.toBe('allowed-once')
    expect(registry.pendingFor('root' as SessionId)).toHaveLength(0)
  })

  it('binds a child ask to the root session a peer follows (D1)', async () => {
    const { ctx, registry, agents } = harness(['root'])
    const rootAgent = fakeAgent('root')
    const childAgent = fakeAgent('child', 'root')
    agents.set(rootAgent.id, rootAgent)
    agents.set(childAgent.id, childAgent)
    const pending = ctx.waterfall(
      scopeTarget(childAgent, childAgent),
      'approval/request',
      approvalRequest(childAgent),
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(registry.pendingFor('root' as SessionId)).toHaveLength(1)
    expect(registry.pendingFor('child' as SessionId)).toHaveLength(0)
    const ask = registry.pendingFor('root' as SessionId)[0]!
    expect(ask).toMatchObject({ kind: 'approval', toolName: 'bash' })
    void pending
  })

  it('loses to a settled local answer with peer/conflict and rejects unknown asks', async () => {
    const { ctx, registry, store, agents } = harness(['root'])
    const agent = fakeAgent('root')
    agents.set(agent.id, agent)
    const gate = Promise.withResolvers<ApprovalOutcome>()
    const pending = ctx.waterfall(
      scopeTarget(agent, agent),
      'approval/request',
      approvalRequest(agent),
      () => gate.promise,
    )
    await Promise.resolve()
    await Promise.resolve()
    const askId = registry.pendingFor('root' as SessionId)[0]!.askId
    const resolved = store.exposed('root' as SessionId)!
    gate.resolve('rejected')
    await expect(pending).resolves.toBe('rejected')
    expect(() => registry.answer(resolved, askId, { kind: 'approval', outcome: 'allowed-once' }))
      .toThrow(RemoteError)
    try {
      registry.answer(resolved, askId, { kind: 'approval', outcome: 'allowed-once' })
    } catch (error) {
      expect((error as RemoteError).code).toBe('peer/conflict')
    }
    expect(() => registry.answer(resolved, 'missing' as never, { kind: 'approval', outcome: 'rejected' }))
      .toThrow(/no pending ask/u)
  })

  it('never exposes an ask for an unpaired session', async () => {
    const { ctx, registry, agents } = harness(['root'])
    const agent = fakeAgent('other')
    agents.set(agent.id, agent)
    const pending = ctx.waterfall(
      scopeTarget(agent, agent),
      'approval/request',
      approvalRequest(agent),
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )
    await expect(pending).resolves.toBe('unavailable')
    expect(registry.pendingFor('other' as SessionId)).toHaveLength(0)
  })

  it('answers a question ask and refuses an outcome a peer may not grant', async () => {
    const { ctx, registry, store, agents } = harness(['root'])
    const agent = fakeAgent('root')
    agents.set(agent.id, agent)
    const gate = Promise.withResolvers<ApprovalOutcome>()
    const pending = ctx.waterfall(
      scopeTarget(agent, agent),
      'user-questions/request',
      { agent, questions: [{ id: 'q1', question: 'proceed?' }] },
      () => gate.promise as never,
    )
    await Promise.resolve()
    await Promise.resolve()
    const askId = registry.pendingFor('root' as SessionId)[0]!.askId
    const resolved = store.exposed('root' as SessionId)!
    expect(() => registry.answer(resolved, askId, { kind: 'question', answer: { answers: 'nope' } as never }))
      .toThrow(RemoteError)
    expect(registry.pendingFor('root' as SessionId)).toHaveLength(1)
    registry.answer(resolved, askId, { kind: 'question', answer: { answers: [{ id: 'q1', selected: ['yes'] }] } })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['yes'] }] })
  })
})
