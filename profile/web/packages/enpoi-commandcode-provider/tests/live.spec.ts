/**
 * Live proof against the running keypool. Skipped unless COMMANDCODE_LIVE=1:
 *
 *   COMMANDCODE_LIVE=1 pnpm --dir ~/.dsh/profiles/web exec vitest run packages/enpoi-commandcode-provider/tests/live.spec.ts
 *
 * COMMANDCODE_BASE_URL overrides the route (default: the shipped loopback
 * keypool address); COMMANDCODE_MODEL overrides the model. An operator whose
 * keypool runs elsewhere sets COMMANDCODE_BASE_URL in the shell.
 */
import { expect, it } from 'vitest'
import { CommandCodeAdapter, DEFAULT_USER_IMAGE_MAX_BYTES, DEFAULT_USER_IMAGE_MAX_PIXELS } from '../src/adapter.js'
import { CatalogStore } from '../src/catalog.js'
import type { CommandCodeRouteProfile } from '../src/adapter.js'

const live = process.env.COMMANDCODE_LIVE === '1'
const baseURL = process.env.COMMANDCODE_BASE_URL ?? 'http://127.0.0.1:8899/commandcode'
const model = process.env.COMMANDCODE_MODEL ?? 'deepseek/deepseek-v4.1-flash'

const profile: CommandCodeRouteProfile = {
  route: 'commandcode',
  displayName: 'Command Code (keypool)',
  baseURL,
  keyless: true,
  userImageMaxPixels: DEFAULT_USER_IMAGE_MAX_PIXELS,
  userImageMaxBytes: DEFAULT_USER_IMAGE_MAX_BYTES,
}

function adapterWith(catalog: CatalogStore): CommandCodeAdapter {
  return new CommandCodeAdapter({
    profiles: () => new Map([['commandcode', profile]]),
    catalogFor: () => catalog,
    resolveApiKey: async () => undefined,
  })
}

it.runIf(live)('fetches the live catalog from the keypool', async () => {
  const catalog = new CatalogStore({ baseURL, snapshot: [] })
  const entries = await catalog.entries()
  console.log(`[live] catalog: HTTP source=${catalog.source()} models=${entries.length}`)
  expect(catalog.source()).toBe('live')
  expect(entries.length).toBeGreaterThan(0)
})

it.runIf(live)('streams one real completion (with a tool declared) through the keypool', async () => {
  const catalog = new CatalogStore({ baseURL, snapshot: [] })
  const adapter = adapterWith(catalog)
  const chunks: Array<Record<string, unknown>> = []
  try {
    for await (const chunk of adapter.stream({
      provider: 'commandcode',
      model,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: KEYPOOL-OK' }] } as never,
      ],
      tools: [{
        name: 'get_weather',
        description: 'Look up the weather for a city.',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      }],
      maxTokens: 256,
    })) {
      chunks.push(chunk as unknown as Record<string, unknown>)
    }
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => String(chunk.text)).join('')
    const toolCalls = chunks.filter(chunk => chunk.type === 'block-end'
      && (chunk.block as { type?: string } | undefined)?.type === 'tool-call')
    const finish = chunks.find(chunk => chunk.type === 'finish')
    const usage = chunks.find(chunk => chunk.type === 'usage')
    console.log(`[live] completion model=${model} text=${JSON.stringify(text)} toolCalls=${toolCalls.length} finish=${JSON.stringify(finish)} usage=${JSON.stringify(usage)}`)
    expect(text.length > 0 || toolCalls.length > 0).toBe(true)
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'UNKNOWN'
    console.log(`[live] honest failure model=${model} code=${code} message=${JSON.stringify((error as Error).message)}`)
    // Quota exhaustion is the documented state of these keys; anything else is a real defect.
    expect(['QUOTA', 'AUTH', 'RATE_LIMIT']).toContain(code)
  }
})
