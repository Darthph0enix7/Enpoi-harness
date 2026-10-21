/** Settings-backed role registry: code defaults, merge, spawn-by-name, unknown ids. */

import { describe, expect, it } from 'vitest'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as tool from '../src/index.ts'
import { callSubagent, setup, text } from './harness.ts'

/** Settings handle serving one `enpoi-orchestration` document through the tool's read seam. */
function settingsHandle(document: Record<string, unknown>): tool.OrchestrationSettingsHandle {
  return { describe: () => [{ ns: 'enpoi-orchestration', value: document }] }
}

/**
 * Spawn one foreground delegation and return the request the provider saw.
 * The role is explicit: the tool never resolves it from the task text, so the
 * id decides the persona, tool surface, and model route.
 */
async function captureRequest(
  description: string,
  document: Record<string, unknown> | undefined,
  role: string,
): Promise<SubagentStartRequest> {
  let seen: SubagentStartRequest | undefined
  const ctx = await setup(
    {
      provider: 'mock',
      ...document !== undefined ? { settingsDocument: document } : {},
    },
    { onStart: (request) => { seen = request } },
  )
  await callSubagent(ctx, { description, prompt: `Task: ${description}`, role })
  if (seen === undefined) throw new Error('scripted provider never saw a start request')
  return seen
}

describe('dsh-tool-subagent settings role registry', () => {
  it('advertises role as required in the model-facing schema', async () => {
    const ctx = await setup({ provider: 'mock' })
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'subagent')
    const parameters = schema?.parameters as
      | { required?: readonly string[]; properties?: Record<string, { description?: string }> }
      | undefined
    expect(parameters?.required).toContain('role')
    expect(parameters?.properties).toHaveProperty('role')
    // The text must leave no escape hatch: REQUIRED, never inferred, no
    // omission path that would have the tool choose the role.
    const roleDescription = parameters?.properties?.role?.description ?? ''
    expect(roleDescription).toContain('REQUIRED')
    expect(roleDescription).toContain('never infers')
    expect(roleDescription).not.toContain('Omit')
    expect(schema?.description).toContain('never infers `role`')
    expect(schema?.description).not.toContain('Omit `role`')
  })

  it('resolves the five code-default roles without a settings handle', () => {
    const registry = tool.listRoleRegistry(undefined)
    expect(Object.keys(registry)).toEqual(['librarian', 'fixer', 'explorer', 'designer', 'oracle'])
    expect(registry['librarian']?.persona).toContain('You are the Librarian')
    expect(registry['librarian']?.builtin).toBe(true)
    expect(registry['explorer']?.deny).toEqual(['edit', 'write', 'str_replace_editor'])
    // The research librarian's built-in allowlist is its whole surface, so the
    // registry carries no deny extras for it; `subagent` survives via
    // childToolFilter's delegating exception.
    expect(registry['librarian']?.deny).toEqual([])
  })

  it('keeps built-in personas and tool surfaces when the registry is empty', async () => {
    const request = await captureRequest('Librarian: research the API documentation', undefined, 'librarian')
    expect(request.persona).toContain('You are the Librarian')
    // The librarian carries its built-in allowlist (the server's live surface);
    // the generic mutating editor is never part of it.
    expect(request.toolFilter?.allow).toBeDefined()
    expect(request.toolFilter?.allow).not.toContain('str_replace_editor')
    expect(request.toolFilter?.deny).not.toContain('subagent')
  })

  it('merges a settings entry over a built-in persona', async () => {
    const request = await captureRequest('Librarian: research the API documentation', {
      roles: { librarian: { persona: 'You are the Archive Keeper.', label: 'Archive' } },
    }, 'librarian')
    expect(request.persona).toBe('You are the Archive Keeper.')
    // Fields the entry omits keep their built-in definition (the allowlist).
    expect(request.toolFilter?.allow).toBeDefined()
    expect(request.toolFilter?.allow).not.toContain('str_replace_editor')
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
    }, 'auditor')
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
    }, 'auditor')
    expect(request.agentOptions).toEqual({ provider: 'alpha', model: 'fast-model' })
  })

  it('carries the delegation budget clause on a foreground child start prompt', async () => {
    const request = await captureRequest('Fix the parser bug', {}, 'fixer')
    const promptText = request.prompt
      .map(part => part.type === 'text' ? part.text : '')
      .join('')
    expect(promptText).toContain('20 tool calls is a ceiling for exploration')
    expect(promptText).toContain('Stop as soon as the answer is complete')
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
    }, 'auditor')
    expect(request.agentOptions).toEqual({ provider: 'alpha', model: 'fast-model', chain: 'grp' })
  })

  it('falls back to the parent route when a persona chain is missing or disabled', async () => {
    const missing = await captureRequest('Review the parser diff', {
      roles: { auditor: { persona: 'You are the Auditor.' } },
      personas: { auditor: { provider: 'stale', model: 'stale-model', chain: 'gone' } },
    }, 'auditor')
    expect(missing.agentOptions).toBeUndefined()
    const disabled = await captureRequest('Review the parser diff', {
      roles: { auditor: { persona: 'You are the Auditor.' } },
      personas: { auditor: { provider: 'stale', model: 'stale-model', chain: 'grp' } },
      chains: { grp: { links: [{ provider: 'alpha', model: 'fast-model' }], disabled: true } },
    }, 'auditor')
    expect(disabled.agentOptions).toBeUndefined()
  })

  it('routes a cleared seat (null) like an absent one instead of crashing the dispatch', async () => {
    const cleared = await captureRequest('Review the parser diff', {
      roles: { auditor: { persona: 'You are the Auditor.' } },
      // The stored document materializes cleared seats as explicit nulls.
      personas: { auditor: null, fixer: null },
    }, 'auditor')
    expect(cleared.agentOptions).toBeUndefined()
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
    }, 'designer')
    expect(request.persona).toContain('Designer')
  })

  it('refuses a role-less task whose signal role is retired, listing the live roster', async () => {
    const ctx = await setup({
      provider: 'mock',
      settingsDocument: { roles: { librarian: { disabled: true } } },
    })
    const result = await callSubagent(ctx, { description: 'Research the SQLite documentation', prompt: 'work', inferRole: true })
    // The retired librarian is neither a suggestion nor a roster entry: the
    // signal names no live role, so no child starts and the live roster answers.
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires an explicit `role`')
    expect(text(result)).not.toContain('the task reads like "librarian"')
    expect(text(result)).toContain('fixer')
    expect(text(result)).not.toContain('librarian')
  })

  it('refuses a role-less delegation that resolves no registry role with a neutral roster', async () => {
    // No settings document: the refusal must not advertise an enpoi settings
    // surface the composition does not have.
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'Do the thing', prompt: 'work', inferRole: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires an explicit `role`')
    expect(text(result)).not.toContain('the task reads like')
    expect(text(result)).toContain('librarian')
    expect(text(result)).toContain('fixer')
    expect(text(result)).not.toContain('enpoi-orchestration.roles')
    expect(text(result)).not.toContain('Settings → Dynamic → Roles')
  })

  it('names how to define a role only when the orchestration document is readable', async () => {
    const ctx = await setup({ provider: 'mock', settingsDocument: {} })
    const result = await callSubagent(ctx, { description: 'Do the thing', prompt: 'work', inferRole: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires an explicit `role`')
    expect(text(result)).toContain('enpoi-orchestration.roles')
  })

  it('refuses a role-less delegation and repeats the task-text role as a suggestion', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'Research the SQLite documentation', prompt: 'work', inferRole: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires an explicit `role`')
    expect(text(result)).toContain('the task reads like "librarian"')
    expect(text(result)).toContain('available roles: librarian')
  })

  it('detects the broadened task-type suggestions for shipped roles only', () => {
    const registry = tool.listRoleRegistry(undefined)
    expect(tool.detectSubagentRole(registry, 'Research the SQLite docs')).toBe('librarian')
    expect(tool.detectSubagentRole(registry, 'Document the settings API')).toBe('librarian')
    expect(tool.detectSubagentRole(registry, 'Map the parser structure')).toBe('explorer')
    expect(tool.detectSubagentRole(registry, 'Review the delegation diff')).toBe('explorer')
    expect(tool.detectSubagentRole(registry, 'Audit the migration plan')).toBe('explorer')
    expect(tool.detectSubagentRole(registry, 'Verify the retry behavior')).toBe('explorer')
    expect(tool.detectSubagentRole(registry, 'Compare the two routes')).toBe('explorer')
    expect(tool.detectSubagentRole(registry, 'Design the settings page')).toBe('designer')
    expect(tool.detectSubagentRole(registry, 'Improve the UI polish')).toBe('designer')
    expect(tool.detectSubagentRole(registry, 'Implement the parser change')).toBe('fixer')
    expect(tool.detectSubagentRole(registry, 'Fix the crash')).toBe('fixer')
    expect(tool.detectSubagentRole(registry, 'Refactor the loader')).toBe('fixer')
    expect(tool.detectSubagentRole(registry, 'Do the thing')).toBeUndefined()
    // A retired role is never suggested even when its signal word is present.
    const retired = tool.listRoleRegistry(settingsHandle({ roles: { explorer: { disabled: true } } }))
    expect(tool.detectSubagentRole(retired, 'Review the delegation diff')).toBeUndefined()
  })

  it('does not adopt a stray persona key for a role with no configured route', async () => {
    // The persona scan keys on the delegated role only (doc: no stray-word
    // matching), so a task text that happens to name another role's id must
    // not pull in that role's model route.
    const request = await captureRequest('Review the fixer output', {
      roles: { auditor: { persona: 'You are the Auditor.' } },
      personas: { fixer: { provider: 'alpha', model: 'fast-model' } },
    }, 'auditor')
    expect(request.agentOptions).toBeUndefined()
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

  it('keeps the tool-only Oracle closed when the task text names it', async () => {
    const request = await captureRequest('Oracle: architecture review', undefined, 'explorer')
    // The explicit role wins: naming the tool-only Oracle in the task text is
    // not a role selection, and the Oracle identity stays closed.
    expect(request.persona).toContain('You are the Explorer')
    expect(request.persona).not.toContain('You are the Oracle')
    expect(request.label).toBe('Explorer: Oracle: architecture review')
    expect(request.toolFilter?.deny).toContain('subagent')
    expect(request.toolFilter?.deny).toContain('edit')
  })

  it('does not route an explicit role through a text-named role\'s persona route', async () => {
    // A delegation whose task text merely mentions the Oracle must not inherit
    // the Oracle seat's model route; the route stays on the oracle_review path.
    const request = await captureRequest('Oracle: architecture review', {
      personas: { oracle: { provider: 'alpha', model: 'fast-model' } },
    }, 'explorer')
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
    // The marker only gates spawning by that id: it does not affect another
    // explicit role, which keeps its own persona and surface.
    const sibling = await captureRequest('Auditor: audit the parser diff', {
      roles: { auditor: { persona: 'You are the Auditor.', spawnable: false } },
    }, 'explorer')
    expect(sibling.persona).toContain('You are the Explorer')
    expect(sibling.persona).not.toContain('You are the Auditor')
  })

  it('lets spawnable:true re-enable the Oracle (the marker is reversible data)', async () => {
    const request = await captureRequest('Oracle: architecture review', {
      roles: { oracle: { spawnable: true } },
    }, 'oracle')
    expect(request.persona).toContain('You are the Oracle')
    // The re-enabled Oracle keeps its built-in allowlist and its delegation
    // exception in the child filter.
    expect(request.toolFilter?.allow).toContain('subagent')
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
