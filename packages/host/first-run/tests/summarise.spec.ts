import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { summariseSystemFacts, SYSTEM_PROFILE_INSTRUCTION, type SummariseLlm } from '../src/summarise.ts'
import type { SystemScanFacts } from '../src/scan.ts'

const FACTS: SystemScanFacts = {
  scannedAt: '2026-09-29T00:00:00.000Z',
  hostname: 'test-host',
  hardware: { cpu: 'Test CPU', threads: 8, memoryGiB: 16 },
  os: { type: 'Linux', release: '6.8', platform: 'linux', arch: 'x64', distribution: 'Test OS' },
  services: { system: 4, user: 0, names: ['a.service'] },
  tooling: [{ name: 'docker', version: '29.1.3' }],
  hosting: { containers: 2, containerNames: ['one', 'two'], listeningPorts: [3000], composeProjects: ['stack'] },
  disk: [{ path: '/', freeGiB: 30, totalGiB: 232 }],
  gpu: null,
}

/** A fake LLM service that replays one fixed chunk list and records the options. */
function fakeLlm(chunks: readonly StreamChunk[]): { llm: SummariseLlm; calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  return {
    calls,
    llm: {
      stream: (options) => {
        calls.push(options)
        return (async function* replay(): AsyncGenerator<StreamChunk> {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }
}

describe('system-profile summariser', () => {
  it('sends the facts on the configured route and returns the assembled text', async () => {
    const { llm, calls } = fakeLlm([
      { type: 'text-delta', index: 0, text: '## Capabilities\n' },
      { type: 'text-delta', index: 0, text: '- hosts containers' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const text = await summariseSystemFacts(llm, FACTS, { provider: 'kilo', model: 'kilo-auto/free', maxTokens: 800 })
    expect(text).toBe('## Capabilities\n- hosts containers')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'kilo', model: 'kilo-auto/free', maxTokens: 800, system: SYSTEM_PROFILE_INSTRUCTION })
    const content = calls[0]?.messages[0]?.content[0]
    expect(content?.type === 'text' ? content.text : '').toContain('"hostname": "test-host"')
    expect(SYSTEM_PROFILE_INSTRUCTION).toContain('Never inventory')
  })

  it('reports a route failure with its reason', async () => {
    const { llm } = fakeLlm([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'quota exhausted', code: 'QUOTA' } } },
    ])
    await expect(summariseSystemFacts(llm, FACTS, { provider: 'kilo', model: 'kilo-auto/free', maxTokens: 800 }))
      .rejects.toThrow('the summariser route failed: quota exhausted')
  })

  it('rejects an empty answer', async () => {
    const { llm } = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])
    await expect(summariseSystemFacts(llm, FACTS, { provider: 'kilo', model: 'kilo-auto/free', maxTokens: 800 }))
      .rejects.toThrow('the summariser returned no text')
  })
})
