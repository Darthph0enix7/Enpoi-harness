/** Settings-backed role registry: code defaults, merge, spawn-by-name, unknown ids. */

import { describe, expect, it } from 'vitest'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as tool from '../src/index.ts'
import { callSubagent, setup, text } from './harness.ts'

/** Settings handle serving one `enpoi-orchestration` document through the tool's read seam. */
function settingsHandle(document: Record<string, unknown>): tool.OrchestrationSettingsHandle {
  return { describe: () => [{ ns: 'enpoi-orchestration', value: document }] }
}

/** Spawn one foreground delegation and return the request the provider saw. */
async function captureRequest(
  description: string,
  document: Record<string, unknown> | undefined,
  args: Record<string, unknown> = {},
): Promise<SubagentStartRequest> {
  let seen: SubagentStartRequest | undefined
  const ctx = await setup(
    {
      provider: 'mock',
      ...document !== undefined ? { settingsDocument: document } : {},
    },
    { onStart: (request) => { seen = request } },
  )
  await callSubagent(ctx, { description, prompt: `Task: ${description}`, ...args })
  if (seen === undefined) throw new Error('scripted provider never saw a start request')
  return seen
}

describe('dsh-tool-subagent settings role registry', () => {
  it('resolves the five code-default roles without a settings handle', () => {
    const registry = tool.listRoleRegistry(undefined)
    expect(Object.keys(registry)).toEqual(['librarian', 'fixer', 'explorer', 'designer', 'oracle'])
    expect(registry['librarian']?.persona).toContain('You are the Librarian')
    expect(registry['librarian']?.builtin).toBe(true)
    expect(registry['explorer']?.deny).toEqual(['edit', 'write', 'str_replace_editor'])
  })

  it('keeps built-in personas and tool surfaces when the registry is empty', async () => {
    const request = await captureRequest('Librarian: research the API documentation', undefined)
    expect(request.persona).toContain('You are the Librarian')
    expect(request.toolFilter?.deny).toEqual(expect.arrayContaining(['edit', 'write', 'subagent']))
  })

  it('merges a settings entry over a built-in persona', async () => {
    const request = await captureRequest('Librarian: research the API documentation', {
      roles: { librarian: { persona: 'You are the Archive Keeper.', label: 'Archive' } },
    })
    expect(request.persona).toBe('You are the Archive Keeper.')
    // Fields the entry omits keep their built-in definition.
    expect(request.toolFilter?.deny).toEqual(expect.arrayContaining(['edit', 'write']))
  })

  it('spawns a settings-defined role by name with its persona and allowlist', async () => {
    const request = await captureRequest('Review the parser diff', {
      roles: {
        auditor: {
          label: 'Auditor',
          persona: 'You are the Auditor.',
          group: 'specialists',
          tools: { available: ['read', 'bash'] },
        },
      },
    }, { role: 'auditor' })
    expect(request.persona).toBe('You are the Auditor.')
    expect(request.label).toBe('Auditor: Review the parser diff')
    // The whiteboard keep list is unioned into every explicit allow surface.
    expect(request.toolFilter?.allow).toEqual(['read', 'bash', ...tool.SHARED_CHILD_KEEP])
    expect(request.toolFilter?.deny).toContain('subagent')
    // `tools.available` replaces the built-in role deny extras, never unions them.
    expect(request.toolFilter?.deny).not.toContain('edit')
  })

  it('routes a settings-defined role through personas by name', async () => {
    const request = await captureRequest('Review the parser diff', {
      roles: { auditor: { persona: 'You are the Auditor.' } },
      personas: { auditor: { provider: 'alpha', model: 'fast-model' } },
    }, { role: 'auditor' })
    expect(request.agentOptions).toEqual({ provider: 'alpha', model: 'fast-model' })
  })

  it('resolves a chain-assigned persona route through the live chain links', async () => {
    const request = await captureRequest('Review the parser diff', {
      roles: { auditor: { persona: 'You are the Auditor.' } },
      // A stale model id must never leak: the first enabled link is the route.
      personas: { auditor: { provider: 'stale', model: 'stale-model', chain: 'grp' } },
      chains: {
        grp: {
          links: [
            { provider: 'alpha', model: 'fast-model' },
            { provider: 'other-model', model: 'other-model' },
          ],
        },
      },
    }, { role: 'auditor' })
    expect(request.agentOptions).toEqual({ provider: 'alpha', model: 'fast-model', chain: 'grp' })
  })

  it('falls back to the parent route when a persona chain is missing or disabled', async () => {
    const missing = await captureRequest('Review the parser diff', {
      roles: { auditor: { persona: 'You are the Auditor.' } },
      personas: { auditor: { provider: 'stale', model: 'stale-model', chain: 'gone' } },
    }, { role: 'auditor' })
    expect(missing.agentOptions).toBeUndefined()
    const disabled = await captureRequest('Review the parser diff', {
      roles: { auditor: { persona: 'You are the Auditor.' } },
      personas: { auditor: { provider: 'stale', model: 'stale-model', chain: 'grp' } },
      chains: { grp: { links: [{ provider: 'alpha', model: 'fast-model' }], disabled: true } },
    }, { role: 'auditor' })
    expect(disabled.agentOptions).toBeUndefined()
  })

  it('retires a built-in role with disabled:true and only hides a seat for seat:false', () => {
    const registry = tool.listRoleRegistry(settingsHandle({
      roles: { oracle: { disabled: true }, designer: { seat: false } },
    }))
    expect(registry['oracle']).toBeUndefined()
    expect(registry['librarian']).toBeDefined()
    // seat:false keeps the role spawnable while its Fleet row is hidden.
    expect(registry['designer']).toBeDefined()
    expect(registry['designer']?.seat).toBe(false)
  })

  it('still spawns a role whose seat is hidden', async () => {
    const request = await captureRequest('Design the empty state for the settings page', {
      roles: { designer: { seat: false } },
    })
    expect(request.persona).toContain('Designer')
  })

  it('does not infer a retired built-in role from task text', async () => {
    const request = await captureRequest('Research the SQLite documentation', {
      roles: { librarian: { disabled: true } },
    })
    expect(request.persona).toBeUndefined()
    expect(request.toolFilter?.deny).toContain('subagent')
    expect(request.toolFilter?.deny).not.toContain('edit')
  })

  it('marks the shipped Oracle tool-only while keeping its registry row and seat', () => {
    const registry = tool.listRoleRegistry(undefined)
    // The Oracle row (seat, label, persona) stays: Fleet Routing and the
    // operator surfaces read it. Only generic delegation is closed.
    expect(registry['oracle']).toBeDefined()
    expect(registry['oracle']?.spawnable).toBe(false)
    expect(registry['oracle']?.seat).toBe(true)
    expect(registry['oracle']?.builtin).toBe(true)
    expect(registry['fixer']?.spawnable).toBe(true)
  })

  it('refuses subagent(role=oracle) with the oracle_review pointer', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'Review the parser diff', prompt: 'work', role: 'oracle' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('oracle_review')
    expect(text(result)).toContain('not spawned as a worker')
  })

  it('never infers the tool-only Oracle from delegation text', async () => {
    const request = await captureRequest('Oracle: architecture review', undefined)
    expect(request.persona).toBeUndefined()
    expect(request.label).toBe('Oracle: architecture review')
    expect(request.toolFilter?.deny).toContain('subagent')
    expect(request.toolFilter?.deny).not.toContain('edit')
  })

  it('does not route a text-named tool-only role through its personas route', async () => {
    // A generic delegation that merely mentions the Oracle must not inherit
    // the Oracle seat's model route; the route stays on the oracle_review path.
    const request = await captureRequest('Oracle: architecture review', {
      personas: { oracle: { provider: 'alpha', model: 'fast-model' } },
    })
    expect(request.agentOptions).toBeUndefined()
  })

  it('honours spawnable:false on any role and reports the marker actionably', async () => {
    const ctx = await setup({
      provider: 'mock',
      settingsDocument: { roles: { auditor: { persona: 'You are the Auditor.', spawnable: false } } },
    })
    const result = await callSubagent(ctx, { description: 'Audit the parser diff', prompt: 'work', role: 'auditor' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('spawnable: false')
    // Text inference skips it too: no silent spawn by description.
    const inferred = await captureRequest('Auditor: audit the parser diff', {
      roles: { auditor: { persona: 'You are the Auditor.', spawnable: false } },
    })
    expect(inferred.persona).toBeUndefined()
  })

  it('lets spawnable:true re-enable the Oracle (the marker is reversible data)', async () => {
    const request = await captureRequest('Oracle: architecture review', {
      roles: { oracle: { spawnable: true } },
    })
    expect(request.persona).toContain('You are the Oracle')
    // Re-enabled Oracle keeps its delegation exception in the child filter.
    expect(request.toolFilter?.deny).not.toContain('subagent')
  })

  it('rejects an unknown role argument and lists the configured ids', async () => {
    const ctx = await setup({
      provider: 'mock',
      settingsDocument: { roles: { auditor: { persona: 'You are the Auditor.' } } },
    })
    const result = await callSubagent(ctx, { description: 'do it', prompt: 'work', role: 'ghost' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown subagent role "ghost"')
    expect(text(result)).toContain('librarian')
    expect(text(result)).toContain('auditor')
  })

  it('reads the orchestration document once per delegation', async () => {
    let describes = 0
    let seen: SubagentStartRequest | undefined
    const ctx = await setup(
      {
        provider: 'mock',
        settingsHandle: {
          describe: () => {
            describes += 1
            return [{ ns: 'enpoi-orchestration', value: { roles: { auditor: { persona: 'You are the Auditor.' } } } }]
          },
        },
      },
      { onStart: (request) => { seen = request } },
    )
    await callSubagent(ctx, { description: 'Audit the parser diff', prompt: 'work', role: 'auditor' })
    expect(seen?.persona).toBe('You are the Auditor.')
    expect(describes).toBe(1)
  })

  it('warns once per entry change when the entry has no volatile form', async () => {
    let configurable = true
    let describes = 0
    const warnings: string[] = []
    const ctx = await setup({
      provider: 'mock',
      settingsHandle: {
        describe: () => {
          describes += 1
          return configurable ? [{ ns: 'enpoi-orchestration', value: {} }] : []
        },
      },
    })
    ctx.logger.warn = (message: unknown) => { warnings.push(String(message)) }
    await callSubagent(ctx, { description: 'Audit the parser diff', prompt: 'work' })
    configurable = false
    await callSubagent(ctx, { description: 'Audit the parser diff', prompt: 'work' })
    await callSubagent(ctx, { description: 'Audit the parser diff', prompt: 'work' })
    // Still one describe() per delegation even while falling back to defaults.
    expect(describes).toBe(3)
    const volatileWarnings = warnings.filter(message => message.includes('no volatile form'))
    expect(volatileWarnings).toHaveLength(1)
    expect(volatileWarnings[0]).toContain('tool-subagent: enpoi-orchestration')
  })
})
