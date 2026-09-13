import { describe, expect, it } from 'vitest'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { callSubagent, setup, text } from './harness.ts'

// The always-denied worker surface, pinned verbatim as the model-visible
// contract. Deny-only: `tools.restrict()` skips names it does not know, so
// upstream additions stay available unless this list names them.
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
  'job_output',
  'job_list',
  'job_kill',
  'ask_user_question',
  'todo_write',
  'memory_save',
  'memory_rescind',
  'memory_confirm',
  'send_message',
  'interrupt_agent',
  'list_agents',
]

const ROLE_EXTRAS = {
  explorer: ['bash', 'edit', 'write', 'skill', 'web_search', 'web_fetch', 'memory_search'],
  librarian: ['bash', 'edit', 'write', 'skill', 'memory_search'],
  fixer: ['skill', 'web_search', 'web_fetch', 'memory_search'],
  designer: ['skill', 'web_search', 'web_fetch', 'memory_search'],
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
    ['explorer', 'Explorer: map the delegation surface', ROLE_EXTRAS.explorer],
    ['librarian', 'Librarian: research the API documentation', ROLE_EXTRAS.librarian],
    ['fixer', 'Fixer: patch the parser bug', ROLE_EXTRAS.fixer],
    ['designer', 'Designer: restyle the settings page', ROLE_EXTRAS.designer],
    // `oracle` has a persona but no dedicated tool policy: shared set only.
    ['oracle', 'Oracle: architecture review', []],
    // No role inferred: shared set only.
    ['unknown', 'Do the thing', []],
  ])('denies the shared worker set plus %s extras at spawn', async (_role, description, extras) => {
    const request = await captureRequest(description)
    expect(request.toolFilter).toEqual({ deny: [...SHARED_DENY, ...extras] })
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

  it('preserves a configured allow list while composing the deny policy', async () => {
    const request = await captureRequest('Do the thing', {
      toolFilter: { allow: ['read'], deny: ['dangerous'] },
    })
    expect(request.toolFilter).toEqual({ allow: ['read'], deny: ['dangerous', ...SHARED_DENY] })
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
