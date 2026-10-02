// Targeted reproduction for incident family D146A48
//   agent "<id>": agent/disposed listener threw:
//     TypeError: Cannot read properties of undefined (reading 'catch')
//
// The throwing listener is file-reference-local's `agent/disposed` handler
// (`disposePrompt(agent)` -> `fiber.dispose().catch(...)`). The production
// agent lives in a machine scope (agent-loop `machine.scope.dispose()`), which
// is disposed BEFORE the registry detaches the agent and emits
// `agent/disposed`. Disposing that scope already runs the injected fiber's
// disposer, so the second `fiber.dispose()` call returns `undefined`
// (vendor/cordis fiber disposer: `if (!runner.epoch) return ... undefined`)
// and `.catch` throws.
import { mkdtemp, rm as rmDir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import LocalFileReferenceService from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rmDir(root, { recursive: true, force: true })))
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  return ctx
}

describe('file-reference-local agent disposal ordering', () => {
  it('does not throw when the agent scope is disposed before the registry detach', async () => {
    const ctx = await harness()
    const root = await mkdtemp(join(tmpdir(), 'dsh-file-reference-dispose-order-'))
    roots.push(root)
    await writeFile(join(root, 'README.md'), 'readme')

    // The real agent's ctx belongs to its machine scope; emulate that with a
    // child fiber so the production teardown order can be replayed.
    let agentCtx: Context | undefined
    await ctx.plugin((inner: Context) => { agentCtx = inner })
    if (agentCtx === undefined) throw new Error('scope context not captured')

    const session = ctx.sessions.create(SessionId('dispose-order'), { meta: { cwd: root } })
    const agent = {
      id: session.id,
      options: {},
      session,
      status: 'idle',
      acceptsNextStep: false,
      ctx: agentCtx,
      followup() {},
      steer() {},
      inject() {},
      send() {},
      updateInbox() { return 'not-found' as const },
      cancel() {},
      whenIdle: () => Promise.resolve(),
    } as unknown as Agent

    const detach = await ctx.agents.register(agent)
    await ctx.plugin(LocalFileReferenceService)

    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn

    // Production order: agent-loop disposes `machine.scope` first...
    await agentCtx.fiber.dispose()
    // ...then the registry detaches the agent, firing agent/disposed.
    detach()
    await Promise.resolve()

    expect(warnings).toEqual([])
  })
})
