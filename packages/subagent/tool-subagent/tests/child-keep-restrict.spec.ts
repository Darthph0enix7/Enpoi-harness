import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { applyChildComposition } from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { callSubagent, fakeAgent, setup, TEST_KEEP_TOOLS } from './harness.ts'

/**
 * Mint the scoped creation context the child joins, mirroring the in-process
 * spawn path, so `applyChildComposition` runs its real `tools.restrict()`.
 */
async function mintChildScope(ctx: Context, name: string): Promise<{ childCtx: Context; child: Agent }> {
  const child = { id: name as SessionId } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, child) },
    { inject: ['tools', 'systemPrompt'] }))
  return { childCtx: scope.ctx, child }
}

describe('shared keep list against the child tool restriction', () => {
  it('drops unmounted keep names with one warning and applies the composed filter cleanly', async () => {
    // The headless composition mounts no whiteboard and no compressor: the
    // keep union must degrade to the live registry instead of composing a
    // filter that `tools.restrict()` refuses as unknown global tools.
    const warnings: string[] = []
    let seen: SubagentStartRequest | undefined
    const ctx = await setup(
      { provider: 'mock', withoutKeepTools: true },
      { onStart: (request) => { seen = request } },
    )
    ctx.logger.warn = (message: unknown) => { warnings.push(String(message)) }
    const result = await callSubagent(ctx, { description: 'Fixer: patch the parser bug', prompt: 'work' })
    expect(result.isError).toBe(false)
    const filter = seen?.toolFilter
    expect(filter).toBeDefined()
    for (const name of TEST_KEEP_TOOLS) {
      expect(filter?.allow ?? []).not.toContain(name)
      expect(warnings.filter(message => message.includes(`"${name}"`))).toHaveLength(1)
    }
    expect(warnings[0]).toContain('child keep list names')
    // The exact application the spawn performs (`child-agent.ts`: the child's
    // scoped `tools.restrict(composition.toolFilter)`), which threw
    // `names unknown global tools "whiteboard_read", ...` before the audit.
    const { childCtx, child } = await mintChildScope(ctx, 'unmounted-fixer-child')
    expect(() => applyChildComposition(childCtx, fakeAgent('parent'), { toolFilter: filter! })).not.toThrow()
    expect(ctx.tools.schemas(child).map(row => row.name).sort())
      .toEqual(['bash', 'edit', 'grep', 'read', 'write'])
  })

  it('unions every mounted keep name into the child surface without warnings', async () => {
    const warnings: string[] = []
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({ provider: 'mock' }, { onStart: (request) => { seen = request } })
    ctx.logger.warn = (message: unknown) => { warnings.push(String(message)) }
    await callSubagent(ctx, { description: 'Fixer: patch the parser bug', prompt: 'work' })
    const filter = seen!.toolFilter!
    for (const name of TEST_KEEP_TOOLS) {
      expect(filter.allow).toContain(name)
      expect(warnings.filter(message => message.includes(`"${name}"`))).toHaveLength(0)
    }
    const { childCtx, child } = await mintChildScope(ctx, 'mounted-fixer-child')
    applyChildComposition(childCtx, fakeAgent('parent'), { toolFilter: filter })
    const names = ctx.tools.schemas(child).map(row => row.name)
    for (const name of TEST_KEEP_TOOLS) expect(names).toContain(name)
  })

  it('keeps operator deny precedence over the mounted keep union', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup(
      { provider: 'mock', toolFilter: { deny: ['whiteboard_read'] } },
      { onStart: (request) => { seen = request } },
    )
    await callSubagent(ctx, { description: 'Fixer: patch the parser bug', prompt: 'work' })
    const filter = seen!.toolFilter!
    expect(filter.allow).toContain('whiteboard_read')
    expect(filter.deny).toContain('whiteboard_read')
    const { childCtx, child } = await mintChildScope(ctx, 'denied-fixer-child')
    applyChildComposition(childCtx, fakeAgent('parent'), { toolFilter: filter })
    const names = ctx.tools.schemas(child).map(row => row.name)
    expect(names).not.toContain('whiteboard_read')
    expect(names).toContain('whiteboard_write')
  })

  it('audits the keep union on a code-authored configured allow list too', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup(
      { provider: 'mock', withoutKeepTools: true, toolFilter: { allow: ['read'] } },
      { onStart: (request) => { seen = request } },
    )
    const result = await callSubagent(ctx, { description: 'Map the delegation surface', prompt: 'work', role: 'explorer' })
    expect(result.isError).toBe(false)
    expect(seen?.toolFilter?.allow).toEqual(['read'])
    const { childCtx, child } = await mintChildScope(ctx, 'configured-explorer-child')
    expect(() => applyChildComposition(childCtx, fakeAgent('parent'), { toolFilter: seen!.toolFilter! })).not.toThrow()
    expect(ctx.tools.schemas(child).map(row => row.name)).toEqual(['read'])
  })
})
