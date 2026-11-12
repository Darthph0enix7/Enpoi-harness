/**
 * `agent/request-error` attribution: the payload names the route whose request
 * actually failed and that route's retry policy. A starting route the runtime
 * filters out of the attempt order must not name or price the failure, and a
 * route that vanished before dispatch must not borrow another route's budget.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, ModelChainResolver, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter } from './mock-adapter.ts'

type MockScript = ConstructorParameters<typeof MockAdapter>[0]

/** Mock adapter with its own route policy and a fixed context window per model. */
class RoutedAdapter extends MockAdapter {
  constructor(
    script: MockScript,
    private readonly policy: ResolvedRetryPolicy,
    private readonly contextWindow?: number,
  ) {
    super(script)
  }

  override providerRetryPolicy(): ResolvedRetryPolicy {
    return this.policy
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.contextWindow === undefined
        ? {}
        : { context: { contextWindow: this.contextWindow, source: 'configured' as const } },
    })
  }
}

async function harness(routes: readonly { providers: readonly string[]; adapter: MockAdapter }[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  for (const route of routes) ctx.llm.registerAdapter([...route.providers], route.adapter)
  return ctx
}

function fail(message: string, code: string): () => never {
  return () => {
    throw new LlmError(message, code)
  }
}

function send(agent: Agent): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
}

interface SeenFailure {
  provider: string
  model: string
  retryPolicy: ResolvedRetryPolicy | undefined
}

/** A failure code the runtime itself never absorbs, so the consumer owns the outcome. */
const CONSUMER_ONLY = 'MIDDLEWARE_FAILURE'

const policyA = resolveRetryPolicy({ mode: 'normal', maxRetries: 0, retryableCodes: ['ALPHA_ONLY'] }, 'test.alpha')
const policyB = resolveRetryPolicy({ mode: 'always' }, 'test.beta')

describe('agent/request-error failure attribution', () => {
  it('names the link that actually failed when the starting route is filtered out', async () => {
    const alpha = new RoutedAdapter([], policyA, 1)
    const beta = new RoutedAdapter([fail('beta is down', CONSUMER_ONLY)], policyB)
    const ctx = await harness([
      { providers: ['alpha'], adapter: alpha },
      { providers: ['beta'], adapter: beta },
    ])
    ctx.provide('modelChains', {
      resolve: (id: string) => id === 'fallback'
        ? {
          id,
          links: [
            { provider: 'alpha', model: 'alpha' },
            { provider: 'beta', model: 'beta' },
          ],
        }
        : undefined,
    } satisfies ModelChainResolver)
    const agent = await ctx.agentLoop.create(SessionId('request-error-actual-link'), {
      provider: 'alpha',
      model: 'alpha',
      chain: 'fallback',
    })
    const seen: SeenFailure[] = []
    ctx.on('agent/request-error', async ({ provider, model, retryPolicy }) => {
      seen.push({ provider, model, retryPolicy })
    })

    send(agent)
    await agent.whenIdle()

    // The context prefilter removed the proposed route before any request ran.
    expect(alpha.requests).toHaveLength(0)
    expect(beta.requests.map(request => request.model)).toEqual(['beta'])
    expect(seen).toEqual([{ provider: 'beta', model: 'beta', retryPolicy: policyB }])
  })

  it('reports a vanished actual route without borrowing the starting route policy', async () => {
    const alpha = new RoutedAdapter([], policyA, 1)
    const ctx = await harness([{ providers: ['alpha'], adapter: alpha }])
    ctx.provide('modelChains', {
      resolve: (id: string) => id === 'fallback'
        ? {
          id,
          links: [
            { provider: 'alpha', model: 'alpha' },
            { provider: 'ghost', model: 'ghost-model' },
          ],
        }
        : undefined,
    } satisfies ModelChainResolver)
    const agent = await ctx.agentLoop.create(SessionId('request-error-removed-link'), {
      provider: 'alpha',
      model: 'alpha',
      chain: 'fallback',
    })
    const seen: SeenFailure[] = []
    ctx.on('agent/request-error', async ({ provider, model, retryPolicy }) => {
      seen.push({ provider, model, retryPolicy })
    })

    send(agent)
    await agent.whenIdle()

    expect(alpha.requests).toHaveLength(0)
    // The ghost route has no registration and therefore no policy to offer.
    expect(seen).toEqual([{ provider: 'ghost', model: 'ghost-model', retryPolicy: undefined }])
  })

  it('keeps a single-route failure on its proposed route and policy', async () => {
    const adapter = new MockAdapter([fail('provider is down', CONSUMER_ONLY)])
    const ctx = await harness([{ providers: ['mock'], adapter }])
    const agent = await ctx.agentLoop.create(SessionId('request-error-single-route'), {
      provider: 'mock',
      model: 'mock',
    })
    const seen: SeenFailure[] = []
    ctx.on('agent/request-error', async ({ provider, model, retryPolicy }) => {
      seen.push({ provider, model, retryPolicy })
    })

    send(agent)
    await agent.whenIdle()

    expect(seen).toEqual([{
      provider: 'mock',
      model: 'mock',
      retryPolicy: ctx.llm.providerRetryPolicy('mock'),
    }])
  })

  it('keeps the proposed route and prepared policy when a failure names no route', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness([{ providers: ['mock'], adapter }])
    ctx.on('llm/stream', async function* () {
      yield {
        type: 'finish' as const,
        reason: {
          kind: 'error' as const,
          failure: { message: 'opaque failure', code: CONSUMER_ONLY },
        },
      }
    })
    const agent = await ctx.agentLoop.create(SessionId('request-error-unrouted'), {
      provider: 'mock',
      model: 'mock',
    })
    const seen: SeenFailure[] = []
    ctx.on('agent/request-error', async ({ provider, model, retryPolicy }) => {
      seen.push({ provider, model, retryPolicy })
    })

    send(agent)
    await agent.whenIdle()

    expect(seen).toEqual([{
      provider: 'mock',
      model: 'mock',
      retryPolicy: ctx.llm.providerRetryPolicy('mock'),
    }])
  })

  it('keeps an unrouted failure honest when no prepared call exists', async () => {
    const ctx = await harness([])
    ctx.on('llm/stream', async function* () {
      yield {
        type: 'finish' as const,
        reason: {
          kind: 'error' as const,
          failure: { message: 'opaque failure', code: CONSUMER_ONLY },
        },
      }
    })
    const agent = await ctx.agentLoop.create(SessionId('request-error-unprepared'), {
      provider: 'listener',
      model: 'virtual',
    })
    const seen: SeenFailure[] = []
    ctx.on('agent/request-error', async ({ provider, model, retryPolicy }) => {
      seen.push({ provider, model, retryPolicy })
    })

    send(agent)
    await agent.whenIdle()

    expect(seen).toEqual([{ provider: 'listener', model: 'virtual', retryPolicy: undefined }])
  })

  it('falls back to the proposed model when a failure names only its provider', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness([{ providers: ['mock'], adapter }])
    ctx.on('llm/stream', async function* () {
      yield {
        type: 'finish' as const,
        reason: {
          kind: 'error' as const,
          failure: { message: 'provider-only failure', code: CONSUMER_ONLY, provider: 'mock' },
        },
      }
    })
    const agent = await ctx.agentLoop.create(SessionId('request-error-provider-only'), {
      provider: 'mock',
      model: 'mock',
    })
    const seen: SeenFailure[] = []
    ctx.on('agent/request-error', async ({ provider, model, retryPolicy }) => {
      seen.push({ provider, model, retryPolicy })
    })

    send(agent)
    await agent.whenIdle()

    expect(seen).toEqual([{
      provider: 'mock',
      model: 'mock',
      retryPolicy: ctx.llm.providerRetryPolicy('mock'),
    }])
  })
})
