import { describe, expect, it } from 'vitest'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { callSubagent, setup } from './harness.ts'

describe('subagent tool one-delivery deny', () => {
  it('denies the child-scoped send_message relay on every spawned child', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({ provider: 'mock' }, {
      onStart: (request) => { seen = request },
    })
    await callSubagent(ctx, { description: 'Do the thing', prompt: 'work' })
    expect(seen?.toolFilter?.deny).toContain('send_message')
  })

  it('keeps the denial when a configured filter already exists', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({ provider: 'mock', toolFilter: { deny: ['bash'] } }, {
      onStart: (request) => { seen = request },
    })
    await callSubagent(ctx, { description: 'Do the thing', prompt: 'work' })
    expect(seen?.toolFilter?.deny).toContain('send_message')
    expect(seen?.toolFilter?.deny).toContain('bash')
  })
})
