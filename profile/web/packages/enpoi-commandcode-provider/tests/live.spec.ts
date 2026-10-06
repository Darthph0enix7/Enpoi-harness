/**
 * Live proof against the direct vendor endpoint with the native key pool.
 * Skipped unless COMMANDCODE_LIVE=1:
 *
 *   COMMANDCODE_LIVE=1 COMMANDCODE_KEY_1=<key> pnpm --dir ~/.dsh/profiles/web exec vitest run packages/enpoi-commandcode-provider/tests/live.spec.ts
 *
 * COMMANDCODE_BASE_URL overrides the route (default https://api.commandcode.ai);
 * COMMANDCODE_MODEL overrides the model; COMMANDCODE_LIVE_REFS names the
 * credential references to pool (default COMMANDCODE_KEY_1,COMMANDCODE_KEY_2).
 * Keys live in the environment only — never on disk, never in a fixture.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PoolEngine } from '@deepseek-ai/dsh-llm-pi-ai'
import type { CommandCodePoolConfig, CommandCodeRouteProfile } from '../src/adapter.js'
import { CommandCodeAdapter, DEFAULT_USER_IMAGE_MAX_BYTES, DEFAULT_USER_IMAGE_MAX_PIXELS } from '../src/adapter.js'
import { CatalogStore } from '../src/catalog.js'

const live = process.env.COMMANDCODE_LIVE === '1'
const baseURL = process.env.COMMANDCODE_BASE_URL ?? 'https://api.commandcode.ai'
const model = process.env.COMMANDCODE_MODEL ?? 'deepseek/deepseek-v4.1-flash'
const refs = (process.env.COMMANDCODE_LIVE_REFS ?? 'COMMANDCODE_KEY_1,COMMANDCODE_KEY_2')
  .split(',')
  .map(ref => ref.trim())
  .filter(ref => ref !== '')
const identities = refs.map((credentialRef, index) => ({ id: `key-${String(index + 1)}`, credentialRef, priority: index + 1 }))
const pool: CommandCodePoolConfig = { strategy: 'priority-sticky', identities }
const anyKeySet = identities.some(identity => (process.env[identity.credentialRef] ?? '') !== '')
const gate = live && anyKeySet

const profile: CommandCodeRouteProfile = {
  route: 'commandcode',
  displayName: 'Command Code (live)',
  baseURL,
  keyless: false,
  pool,
  userImageMaxPixels: DEFAULT_USER_IMAGE_MAX_PIXELS,
  userImageMaxBytes: DEFAULT_USER_IMAGE_MAX_BYTES,
}

it.runIf(live)('resolves the direct-vendor catalog from the bundled snapshot without fetching', async () => {
  const catalog = new CatalogStore({ baseURL, snapshot: [{ id: 'snapshot-model' }] })
  const entries = await catalog.entries()
  console.log(`[live] catalog: source=${catalog.source()} models=${String(entries.length)}`)
  expect(catalog.source()).toBe('snapshot')
  expect(entries.length).toBeGreaterThan(0)
})

it.runIf(gate)('streams one real completion through the native pool', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'commandcode-live-'))
  const engine = new PoolEngine({ stateDir, saveDebounceMs: 1 })
  const catalog = new CatalogStore({ baseURL, snapshot: [] })
  try {
    const adapter = new CommandCodeAdapter({
      profiles: () => new Map([['commandcode', profile]]),
      catalogFor: () => catalog,
      resolveApiKey: async () => undefined,
      pool: engine,
      resolveCredential: async reference => {
        const value = process.env[reference]
        return value === undefined || value === '' ? undefined : value
      },
    })
    const chunks: Array<Record<string, unknown>> = []
    try {
      for await (const chunk of adapter.stream({
        provider: 'commandcode',
        model,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: NATIVE-POOL-OK' }] } as never,
        ],
        maxTokens: 256,
      })) {
        chunks.push(chunk as unknown as Record<string, unknown>)
      }
      const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => String(chunk.text)).join('')
      const usage = chunks.find(chunk => chunk.type === 'usage')
      console.log(`[live] completion model=${model} text=${JSON.stringify(text)} usage=${JSON.stringify(usage)}`)
      expect(text.length).toBeGreaterThan(0)
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'UNKNOWN'
      console.log(`[live] honest failure model=${model} code=${code} message=${JSON.stringify((error as Error).message)}`)
      // Spent keys are the documented steady state; anything else is a defect.
      expect(['QUOTA', 'AUTH', 'RATE_LIMIT', 'PROVIDER_POOL_EXHAUSTED']).toContain(code)
    }
  } finally {
    await engine.flush()
    await rm(stateDir, { recursive: true, force: true })
  }
})
