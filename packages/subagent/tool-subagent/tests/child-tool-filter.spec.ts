import { describe, expect, it } from 'vitest'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as tool from '../src/index.ts'
import { ROLE_CHILD_ALLOW, SHARED_CHILD_KEEP } from '../src/index.ts'
import { callSubagent, setup, TEST_REGISTERED_TOOLS, text } from './harness.ts'

// The always-denied worker surface, pinned verbatim as the model-visible
// contract. Deny-only: `tools.restrict()` skips names it does not know, so
// upstream additions stay available unless this list names them. The
// background job controls (`job_output`, `job_list`, `job_kill`) are
// deliberately NOT denied (D1, doc 86): a child collects its own promoted
// jobs. The harness-authoring trio and `review_run` are denied because the
// seat guard and the reviewer gate refuse them to every delegated worker.
const SHARED_DENY = [
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'roundtable',
  'chorus',
  'oracle_review',
  'create_goal',
  'get_goal',
  'update_goal',
  'exit_plan_mode',
  'plan_mode',
  'goal',
  'ralph',
  'workflow',
  'ask_user_question',
  // Operator default: sub-agents keep their OWN todo list and their OWN
  // memory writes (isolated sessions), so these are not denied.
  'send_message',
  'interrupt_agent',
  'list_agents',
  'plugin_manager',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'review_run',
]

// Operator default: every sub-agent may run bash, use skills, search/write
// memory and keep its own todo list — explorers keep only the mutation veto,
// while the research librarian authors its claims. The librarian is the second
// delegating child (the deep dial fans out to leaf readers), so the generic
// subagent survives its shared floor, like the Oracle's.
const SHARED_DENY_DELEGATING = SHARED_DENY.filter(name => name !== 'subagent')

/** The explorer's built-in deny extras; every other shipped role is allowlisted. */
const EXPLORER_EXTRAS = ['edit', 'write', 'str_replace_editor']

/**
 * The built-in allowlist after the spawn path's live-registry audit. The test
 * composition registers only {@link TEST_REGISTERED_TOOLS} plus this plugin's
 * own `subagent` tool, so every other built-in name is dropped with a warning.
 */
function auditedBuiltin(role: 'librarian' | 'fixer' | 'designer' | 'oracle'): string[] {
  const known = new Set<string>([...TEST_REGISTERED_TOOLS, 'subagent'])
  return ROLE_CHILD_ALLOW[role]!.filter(name => known.has(name))
}

/**
 * Spawn one foreground delegation and return the request the provider saw.
 * `inferRole: true` opts out of {@link callSubagent}'s harness default so the
 * tool resolves the role from text; a per-role catalog test asserts the catalog
 * the resolved role composes.
 */
async function captureRequest(
  description: string,
  toolConfig: Omit<Parameters<typeof setup>[0], 'provider'> = {},
  mockConfig: Parameters<typeof setup>[1] = {},
): Promise<SubagentStartRequest> {
  let seen: SubagentStartRequest | undefined
  const ctx = await setup(
    { provider: 'mock', ...toolConfig },
    { ...mockConfig, onStart: (request) => { seen = request } },
  )
  await callSubagent(ctx, { description, prompt: `Task: ${description}`, inferRole: true })
  if (seen === undefined) throw new Error('scripted provider never saw a start request')
  return seen
}

describe('dsh-tool-subagent per-child tool filter', () => {
  it.each([
    ['explorer (named)', 'Explorer: map the delegation surface'],
    ['explorer (review signal)', 'Review the parser diff'],
    ['explorer (audit signal)', 'Audit the migration plan'],
  ])('denies the shared worker set plus %s mutations at spawn', async (_role, description) => {
    const request = await captureRequest(description)
    // The explorer is deny-only: its surface is the shared floor plus the
    // mutation veto, with no allowlist to widen it.
    expect(request.toolFilter).toEqual({ deny: [...SHARED_DENY, ...EXPLORER_EXTRAS] })
  })

  it.each([
    ['fixer', 'Fixer: patch the parser bug'],
    ['designer', 'Designer: restyle the settings page'],
  ])('scopes the %s to its built-in allowlist plus the shared floor', async (role, description) => {
    const request = await captureRequest(description)
    expect(request.toolFilter?.allow).toEqual([
      ...auditedBuiltin(role as 'fixer' | 'designer'),
      ...SHARED_CHILD_KEEP,
    ])
    expect(request.toolFilter?.deny).toEqual(SHARED_DENY)
  })

  it('refuses a role-less description that resolves no registry role', async () => {
    const ctx = await setup({ provider: 'mock' })
    const result = await callSubagent(ctx, { description: 'Do the thing', prompt: 'work', inferRole: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a role')
    expect(text(result)).toContain('enpoi-orchestration.roles')
  })

  it('composes the librarian built-in allowlist (server permissions parity) with the shared floor', async () => {
    const request = await captureRequest('Librarian: research the API documentation')
    // The built-in allowlist is audited against the live registry, so the test
    // composition keeps only the registered names; the whiteboard keep list is
    // unioned into every explicit allow surface and de-duplicated.
    expect(request.toolFilter?.allow).toEqual([...new Set([...auditedBuiltin('librarian'), ...SHARED_CHILD_KEEP])])
    expect(request.toolFilter?.deny).toEqual(SHARED_DENY_DELEGATING)
  })

  it('drops built-in allowlist names the deployment does not register and still spawns', async () => {
    // A fresh install without the wizard keeps `web_search` unregistered; the
    // librarian must still spawn (dropped with a warning) instead of aborting
    // on `tools.restrict()`'s unknown-allow check.
    const warnings: string[] = []
    let seen: SubagentStartRequest | undefined
    const ctx = await setup(
      { provider: 'mock' },
      { onStart: (request) => { seen = request } },
    )
    ctx.logger.warn = (message: unknown) => { warnings.push(String(message)) }
    const result = await callSubagent(ctx, {
      description: 'Librarian: research the API documentation',
      prompt: 'work',
      inferRole: true,
    })
    expect(result.isError).toBe(false)
    expect(seen?.toolFilter?.allow).toEqual([...new Set([...auditedBuiltin('librarian'), ...SHARED_CHILD_KEEP])])
    expect(warnings.filter(message => message.includes('"web_search"'))).toHaveLength(1)
    expect(warnings[0]).toContain('role "librarian"')
  })

  it('composes the Oracle built-in allowlist when spawnable re-enables it', async () => {
    const request = await captureRequest('Oracle: architecture review', {
      settingsDocument: { roles: { oracle: { spawnable: true } } },
    })
    expect(request.toolFilter?.allow).toEqual([...new Set([...auditedBuiltin('oracle'), ...SHARED_CHILD_KEEP])])
    expect(request.toolFilter?.deny).toEqual(SHARED_DENY_DELEGATING)
  })

  it('keeps the generic subagent for the librarian research fan-out and denies it to other workers', async () => {
    const librarian = await captureRequest('Librarian: research the API documentation')
    expect(librarian.toolFilter?.allow).toContain('subagent')
    expect(librarian.toolFilter?.deny).not.toContain('subagent')
    // Only the generic delegation tool survives; the provider-specific
    // variants stay on the shared floor.
    expect(librarian.toolFilter?.deny).toEqual(expect.arrayContaining(['subagent_fork', 'subagent_codex', 'subagent_claude_code']))
    const fixer = await captureRequest('Fixer: patch the parser bug')
    expect(fixer.toolFilter?.deny).toContain('subagent')
  })

  it('pins the built-in allowlists to the server surfaces they encode', () => {
    expect(ROLE_CHILD_ALLOW.librarian).toEqual([
      'bash', 'custom_research-fetch', 'custom_research-verify', 'edit', 'glob', 'grep',
      'memory_save', 'memory_search', 'read', 'read_image', 'skill', 'subagent',
      'todo_write', 'web_fetch', 'web_search', 'whiteboard_read', 'write',
    ])
    expect(ROLE_CHILD_ALLOW.oracle).toEqual([
      'bash', 'edit', 'glob', 'grep', 'memory_confirm', 'memory_rescind', 'memory_save',
      'memory_search', 'read', 'read_image', 'request_evidence', 'skill', 'subagent',
      'todo_write', 'web_search', 'whiteboard_read', 'write',
    ])
  })

  it('merges an existing configured deny list first and de-duplicates the union', async () => {
    const request = await captureRequest('Explorer: map the delegation surface', {
      toolFilter: { deny: ['bash', 'send_message', 'dangerous'] },
    })
    const deny = request.toolFilter?.deny ?? []
    expect(deny.slice(0, 3)).toEqual(['bash', 'send_message', 'dangerous'])
    expect(deny).toEqual([
      'bash',
      'send_message',
      'dangerous',
      ...SHARED_DENY.filter(name => name !== 'send_message'),
      ...EXPLORER_EXTRAS.filter(name => name !== 'bash'),
    ])
    expect(new Set(deny).size).toBe(deny.length)
  })

  it('keeps the whiteboard in every role surface and never names it in a deny map', async () => {
    // Structural: the pinned board is available to every delegated child
    // (allowlisted and deny-only alike), so no built-in role deny map may
    // strip it.
    for (const description of [
      'Fixer: patch the parser bug',
      'Librarian: research the API documentation',
      'Explorer: map the delegation surface',
      'Oracle: architecture review',
    ]) {
      const request = await captureRequest(description)
      for (const tool of SHARED_CHILD_KEEP) {
        expect(request.toolFilter?.deny ?? []).not.toContain(tool)
      }
    }
  })

  it('preserves a configured allow list while composing the deny policy', async () => {
    // The explorer is deny-only: the configured allow list passes through and
    // the composed deny list appends the shared floor plus the role extras.
    const request = await captureRequest('Explorer: map the delegation surface', {
      toolFilter: { allow: ['read'], deny: ['dangerous'] },
    })
    expect(request.toolFilter?.allow).toEqual(['read', ...SHARED_CHILD_KEEP])
    expect(request.toolFilter?.deny).toEqual(['dangerous', ...SHARED_DENY, ...EXPLORER_EXTRAS])
  })

  it('lets the permissions allowlist win over the registry tools.available', async () => {
    // Layer precedence (doc 61 WP-S6): Permissions → availability is the hard
    // gate; the Dynamic → Roles surface is the fallback; the shared anti-leak
    // floor is always unioned in, and the whiteboard keep list survives it.
    const request = await captureRequest('Fixer: patch the parser bug', {
      settingsDocument: {
        roles: { fixer: { tools: { available: ['read', 'grep'] } } },
        permissions: { agents: { fixer: { available: ['read'] } } },
      },
    })
    expect(request.toolFilter?.allow).toEqual(['read', ...SHARED_CHILD_KEEP])
    expect(request.toolFilter?.allow).not.toContain('grep')
    expect(request.toolFilter?.deny).toEqual(expect.arrayContaining(['roundtable', 'ask_user_question']))
  })

  it('falls back to the registry tools.available when permissions sets no allowlist', async () => {
    const request = await captureRequest('Fixer: patch the parser bug', {
      settingsDocument: { roles: { fixer: { tools: { available: ['read', 'grep'] } } } },
    })
    // Whiteboard keep list unioned in; the registry surface order is kept.
    expect(request.toolFilter?.allow).toEqual(['read', 'grep', ...SHARED_CHILD_KEEP])
    expect(request.toolFilter?.deny).toEqual(expect.arrayContaining(['roundtable', 'ask_user_question']))
  })

  it('merges extendBuiltins role edits into the built-in allowlist', async () => {
    const warnings: string[] = []
    let seen: SubagentStartRequest | undefined
    const ctx = await setup(
      {
        provider: 'mock',
        settingsDocument: {
          extendBuiltins: { roles: { librarian: { add: ['custom_probe'], remove: ['subagent'] } } },
        },
      },
      { onStart: (request) => { seen = request } },
    )
    ctx.logger.warn = (message: unknown) => { warnings.push(String(message)) }
    const result = await callSubagent(ctx, {
      description: 'Librarian: research the API documentation',
      prompt: 'work',
      inferRole: true,
    })
    expect(result.isError).toBe(false)
    // The removal applies to the built-in list; the addition is registry-audited
    // like every built-in entry, so an unknown name warns and drops.
    expect(seen?.toolFilter?.allow).toEqual([
      ...new Set([...auditedBuiltin('librarian').filter(name => name !== 'subagent'), ...SHARED_CHILD_KEEP]),
    ])
    expect(seen?.toolFilter?.allow).not.toContain('subagent')
    expect(warnings.some(message => message.includes('"custom_probe"') && message.includes('role "librarian"'))).toBe(true)
  })

  it('merges extendBuiltins shared deny edits into the shared floor', async () => {
    const request = await captureRequest('Explorer: map the delegation surface', {
      settingsDocument: {
        extendBuiltins: { roles: {}, sharedDeny: { remove: ['roundtable'] } },
      },
    })
    const deny = request.toolFilter?.deny ?? []
    expect(deny).not.toContain('roundtable')
    expect(deny).toEqual([
      ...SHARED_DENY.filter(name => name !== 'roundtable'),
      ...EXPLORER_EXTRAS,
    ])
  })

  it('appends extendBuiltins shared deny additions after the compiled floor', async () => {
    const request = await captureRequest('Explorer: map the delegation surface', {
      settingsDocument: {
        extendBuiltins: { sharedDeny: { add: ['dangerous_probe'] } },
      },
    })
    expect(request.toolFilter?.deny).toEqual([...SHARED_DENY, 'dangerous_probe', ...EXPLORER_EXTRAS])
  })

  it('applies extendBuiltins sharedKeep edits to the keep union', async () => {
    const request = await captureRequest('Explorer: map the delegation surface', {
      toolFilter: { allow: ['read'] },
      settingsDocument: {
        extendBuiltins: { sharedKeep: { remove: ['whiteboard_pin'] } },
      },
    })
    expect(request.toolFilter?.allow).toEqual(['read', 'whiteboard_read', 'whiteboard_write', 'whiteboard_unpin', 'compressor_retrieve'])
  })

  it('audits extendBuiltins sharedKeep additions against the live registry', async () => {
    // An operator addition naming an unregistered tool would abort the spawn on
    // `tools.restrict()`'s unknown-allow check; the audit drops it with a
    // warning like every other profile-provided keep name.
    const warnings: string[] = []
    let seen: SubagentStartRequest | undefined
    const ctx = await setup(
      {
        provider: 'mock',
        toolFilter: { allow: ['read'] },
        settingsDocument: {
          extendBuiltins: { sharedKeep: { add: ['custom_board'] } },
        },
      },
      { onStart: (request) => { seen = request } },
    )
    ctx.logger.warn = (message: unknown) => { warnings.push(String(message)) }
    const result = await callSubagent(ctx, { role: 'explorer', description: 'Explorer: map the delegation surface', prompt: 'work' })
    expect(result.isError).toBe(false)
    expect(seen?.toolFilter?.allow).toEqual(['read', ...SHARED_CHILD_KEEP])
    expect(seen?.toolFilter?.allow).not.toContain('custom_board')
    expect(warnings.filter(message => message.includes('"custom_board"'))).toHaveLength(1)
    expect(warnings[0]).toContain('child keep list')
  })

  it('drops keep names the deployment does not register and still spawns', () => {
    // The headless/base composition mounts no whiteboard or compressor: the
    // keep list must degrade to the live registry instead of aborting the
    // spawn, and the role's own audited surface is unaffected.
    const warnings: string[] = []
    const registry = tool.listRoleRegistry(undefined)
    const audit = {
      isKnown: (name: string): boolean => (TEST_REGISTERED_TOOLS as readonly string[]).includes(name) || name === 'subagent',
      warn: (message: string): void => { warnings.push(message) },
    }
    const unmounted = {
      isKnown: (name: string): boolean =>
        name !== 'whiteboard_read' && name !== 'whiteboard_write' && name !== 'whiteboard_pin'
        && name !== 'whiteboard_unpin' && name !== 'compressor_retrieve'
        && audit.isKnown(name),
      warn: audit.warn,
    }
    const fixer = tool.childToolFilter(undefined, undefined, 'fixer', registry['fixer']!, unmounted)
    expect(fixer.allow).toEqual(auditedBuiltin('fixer'))
    for (const name of SHARED_CHILD_KEEP) {
      expect(warnings.filter(message => message.includes(`"${name}"`))).toHaveLength(1)
    }
    expect(warnings[0]).toContain('child keep list')
  })

  it('lets a stored allowlist replace the built-in list and its extendBuiltins edit', async () => {
    const request = await captureRequest('Fixer: patch the parser bug', {
      settingsDocument: {
        roles: { fixer: { tools: { available: ['read', 'grep'] } } },
        extendBuiltins: { roles: { fixer: { add: ['write'], remove: ['read'] } } },
      },
    })
    // The explicit layer wins wholesale: the extension edits the built-in
    // surface it would have replaced, not the operator's stored list.
    expect(request.toolFilter?.allow).toEqual(['read', 'grep', ...SHARED_CHILD_KEEP])
  })

  it('drops stale names from the registry availability list with a warning and still spawns', async () => {
    // A stored list outlives tool renames: `todo_read`/`web_fetch` are not in
    // this deployment's live registry, and an allow name tools.restrict() does
    // not know would abort the child's spawn. The audit drops them instead.
    const warnings: string[] = []
    let seen: SubagentStartRequest | undefined
    const ctx = await setup(
      {
        provider: 'mock',
        settingsDocument: {
          roles: { librarian: { tools: { available: ['read', 'todo_read', 'web_fetch'] } } },
        },
      },
      { onStart: (request) => { seen = request } },
    )
    ctx.logger.warn = (message: unknown) => { warnings.push(String(message)) }
    const result = await callSubagent(ctx, {
      description: 'Librarian: research the API documentation',
      prompt: 'work',
      inferRole: true,
    })
    expect(result.isError).toBe(false)
    expect(seen?.toolFilter?.allow).toEqual(['read', ...SHARED_CHILD_KEEP])
    expect(warnings.filter(message => message.includes('"todo_read"'))).toHaveLength(1)
    expect(warnings.filter(message => message.includes('"web_fetch"'))).toHaveLength(1)
    expect(warnings[0]).toContain('role "librarian"')
  })

  it('drops stale names from the permissions allowlist with a warning and still spawns', async () => {
    const warnings: string[] = []
    let seen: SubagentStartRequest | undefined
    const ctx = await setup(
      {
        provider: 'mock',
        settingsDocument: {
          roles: { fixer: { tools: { available: ['grep'] } } },
          permissions: { agents: { fixer: { available: ['read', 'web_fetch'] } } },
        },
      },
      { onStart: (request) => { seen = request } },
    )
    ctx.logger.warn = (message: unknown) => { warnings.push(String(message)) }
    const result = await callSubagent(ctx, { description: 'Fixer: patch the parser bug', prompt: 'work' })
    expect(result.isError).toBe(false)
    expect(seen?.toolFilter?.allow).toEqual(['read', ...SHARED_CHILD_KEEP])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"web_fetch"')
    expect(warnings[0]).toContain('role "fixer"')
  })

  it('leaves a code-authored unknown name for tools.restrict() to reject', async () => {
    // The strict contract is unchanged for code-authored filters: config.toolFilter
    // is build-time data, so the audit never drops its names — the real child
    // composition still throws in tools.restrict() for an unknown allow name.
    const request = await captureRequest('Explorer: map the delegation surface', {
      toolFilter: { allow: ['read', 'not_a_registered_tool'] },
    })
    expect(request.toolFilter?.allow).toContain('not_a_registered_tool')
  })

  it('composes the shared floor for every role regardless of provider capability', () => {
    // Composition is provider-independent by construction: `childToolFilter`
    // has no provider input, so a capability-less provider can only ever be
    // offered the worker floor — never the parent's full surface.
    const registry = tool.listRoleRegistry(undefined)
    const audit = {
      isKnown: (name: string): boolean => (TEST_REGISTERED_TOOLS as readonly string[]).includes(name) || name === 'subagent',
      warn: (): void => {},
    }
    const explorer = tool.childToolFilter(undefined, undefined, 'explorer', registry['explorer']!, audit)
    expect(explorer.allow).toBeUndefined()
    expect(explorer.deny).toEqual([...SHARED_DENY, ...EXPLORER_EXTRAS])
    const fixer = tool.childToolFilter(undefined, undefined, 'fixer', registry['fixer']!, audit)
    expect(fixer.allow).toEqual([...auditedBuiltin('fixer'), ...SHARED_CHILD_KEEP])
    expect(fixer.deny).toEqual(SHARED_DENY)
  })

  it('refuses a capability-less provider loudly instead of running it with the parent surface', async () => {
    // The composed floor reaches `ctx.subagents.start`, whose capability check
    // refuses a provider that cannot apply a filter; the tool never falls back
    // to an unfiltered child.
    const ctx = await setup(
      { provider: 'mock', toolFilter: { deny: ['dangerous'] } },
      { capabilities: { toolFilter: false } },
    )
    const result = await callSubagent(ctx, { description: 'Do the thing', prompt: 'work', role: 'explorer' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support the "toolFilter" capability')
  })

  it('refuses a filter-less provider even when no filter is configured', async () => {
    const ctx = await setup({ provider: 'mock' }, { capabilities: { toolFilter: false } })
    const result = await callSubagent(ctx, { description: 'Do the thing', prompt: 'work', role: 'explorer' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support the "toolFilter" capability')
  })
})
