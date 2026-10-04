import { describe, expect, it } from 'vitest'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { SHARED_CHILD_KEEP } from '../src/index.ts'
import { callSubagent, setup, text } from './harness.ts'

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

const ROLE_EXTRAS = {
  explorer: ['edit', 'write', 'str_replace_editor'],
  librarian: ['str_replace_editor'],
  fixer: [],
  designer: [],
}

/** Spawn one foreground delegation and return the request the provider saw. */
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
  await callSubagent(ctx, { description, prompt: `Task: ${description}` })
  if (seen === undefined) throw new Error('scripted provider never saw a start request')
  return seen
}

describe('dsh-tool-subagent per-child tool filter', () => {
  it.each([
    ['explorer', 'Explorer: map the delegation surface', ROLE_EXTRAS.explorer, SHARED_DENY],
    ['librarian', 'Librarian: research the API documentation', ROLE_EXTRAS.librarian, SHARED_DENY_DELEGATING],
    ['fixer', 'Fixer: patch the parser bug', ROLE_EXTRAS.fixer, SHARED_DENY],
    ['designer', 'Designer: restyle the settings page', ROLE_EXTRAS.designer, SHARED_DENY],
    // The Oracle is tool-only: a description naming it is NOT a role selection,
    // so the generic delegation keeps the full shared deny set.
    ['none (tool-only Oracle)', 'Oracle: architecture review', [], SHARED_DENY],
    // No role inferred: shared set only.
    ['unknown', 'Do the thing', [], SHARED_DENY],
  ])('denies the shared worker set plus %s extras at spawn', async (_role, description, extras, shared) => {
    const request = await captureRequest(description)
    expect(request.toolFilter).toEqual({ deny: [...shared, ...extras] })
  })

  it('keeps the generic subagent for the librarian research fan-out and denies it to other workers', async () => {
    const librarian = await captureRequest('Librarian: research the API documentation')
    const deny = librarian.toolFilter?.deny ?? []
    expect(deny).not.toContain('subagent')
    // Only the generic delegation tool survives; the provider-specific
    // variants stay on the shared floor.
    expect(deny).toEqual(expect.arrayContaining(['subagent_fork', 'subagent_codex', 'subagent_claude_code']))
    const fixer = await captureRequest('Fixer: patch the parser bug')
    expect(fixer.toolFilter?.deny).toContain('subagent')
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
      ...ROLE_EXTRAS.explorer.filter(name => name !== 'bash'),
    ])
    expect(new Set(deny).size).toBe(deny.length)
  })

  it('keeps the whiteboard in every deny-only surface and never names it in a deny map', async () => {
    // Structural: the pinned board is available to every delegated child, so
    // no built-in role deny map may strip it.
    for (const description of ['Fixer: patch the parser bug', 'Explorer: map the delegation surface', 'Oracle: architecture review']) {
      const request = await captureRequest(description)
      for (const tool of SHARED_CHILD_KEEP) {
        expect(request.toolFilter?.deny ?? []).not.toContain(tool)
      }
    }
  })

  it('preserves a configured allow list while composing the deny policy', async () => {
    const request = await captureRequest('Do the thing', {
      toolFilter: { allow: ['read'], deny: ['dangerous'] },
    })
    expect(request.toolFilter?.allow).toEqual(['read', ...SHARED_CHILD_KEEP])
    expect(request.toolFilter?.deny).toEqual(['dangerous', ...SHARED_DENY])
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
    const result = await callSubagent(ctx, { description: 'Librarian: research the API documentation', prompt: 'work' })
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
    const request = await captureRequest('Do the thing', {
      toolFilter: { allow: ['read', 'not_a_registered_tool'] },
    })
    expect(request.toolFilter?.allow).toContain('not_a_registered_tool')
  })

  it('passes the configured filter through unchanged when the provider cannot apply one', async () => {
    // The capability-less provider runtime rejects the unmodified filter rather
    // than silently applying a partial worker surface.
    const ctx = await setup(
      { provider: 'mock', toolFilter: { deny: ['dangerous'] } },
      { capabilities: { toolFilter: false } },
    )
    const result = await callSubagent(ctx, { description: 'Do the thing', prompt: 'work' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not support the "toolFilter" capability')
  })

  it('emits no filter for a capability-less provider without a configured filter', async () => {
    const request = await captureRequest('Do the thing', {}, { capabilities: { toolFilter: false } })
    expect(request.toolFilter).toBeUndefined()
  })
})
