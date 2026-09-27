import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { applyChildComposition, resolveChildAgentOptions } from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

function groupedParentAgent(): Agent {
  const parent = parentAgent()
  return { ...parent, options: { ...parent.options, chain: 'stable' } }
}

describe('child Agent options', () => {
  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('passes an explicitly requested child group through and never inherits the parent group', () => {
    expect(resolveChildAgentOptions(groupedParentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      chain: 'child-group',
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      chain: 'child-group',
      maxTokens: 512,
      subagentDepth: 1,
    })
    expect(resolveChildAgentOptions(groupedParentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

describe('child composition persona shadow', () => {
  it('shadows the parent preset suffix so a persona-carrying child never carries the parent doctrine', async () => {
    const ctx = new Context()
    const parentKey = { id: 'parent-preset' }
    const childKey = { id: 'child-session' }
    const scopes: Array<ReturnType<typeof createScope>> = []
    try {
      await ctx.plugin(SystemPrompt)
      // Same accepted shape as `agent-preset-registry/tests/mount.spec.ts`: an object plugin with
      // `inject` and an `apply` taking the injected context, no cast.
      await ctx.plugin({ inject: ['systemPrompt'], async apply(pluginCtx: Context): Promise<void> {
        // Stand-in for a parent preset that splits a shared base (prefix) from a doctrine tail (suffix).
        const parent = createScope(pluginCtx, parentKey)
        scopes.push(parent)
        parent.ctx.systemPrompt.section({
          name: 'deployment:persona-prefix',
          order: parent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          text: 'PARENT PERSONA',
        })
        parent.ctx.systemPrompt.section({
          name: 'deployment:persona-suffix',
          order: parent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
          text: 'PARENT PRESET DOCTRINE',
        })
        const child = createScope(pluginCtx, childKey, { parent: parentKey })
        scopes.push(child)
        applyChildComposition(child.ctx, {} as Agent, { persona: 'You are Fixer.' })
      } })
      const childRendered = renderPrompt(await ctx.systemPrompt.assemble({ scope: childKey }))
      expect(childRendered).toContain('You are Fixer.')
      expect(childRendered).not.toContain('PARENT PRESET DOCTRINE')
      expect(childRendered).not.toContain('PARENT PERSONA')
      const parentRendered = renderPrompt(await ctx.systemPrompt.assemble({ scope: parentKey }))
      expect(parentRendered).toContain('PARENT PRESET DOCTRINE')
    } finally {
      for (const scope of scopes) await scope.dispose()
      await ctx.fiber.dispose()
    }
  })
})
