/**
 * LIVE detection proof (opt-in): `DSH_HEAVY_LIVE=1` probes the real local
 * FreeLLMAPI instance on 127.0.0.1:3002 through the same detection the UI
 * uses, with a scratch home — live profile settings are never touched.
 * Without the env var this file self-skips, so the default suite stays
 * hermetic.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { manifestById } from '../src/manifests.js'
import { detectInstance, useDetectedInstance, type HeavyDeps } from '../src/planner.js'

const live = process.env.DSH_HEAVY_LIVE === '1'
const scratch = process.env.DSH_HEAVY_SCRATCH ?? join(process.cwd(), '.scratch', 'heavy-live')

it.skipIf(!live)('detects the running local FreeLLMAPI and writes a loopback route from it', async () => {
  mkdirSync(scratch, { recursive: true })
  const mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }> = []
  const deps: HeavyDeps = {
    home: scratch,
    dshHome: join(scratch, '.dsh'),
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }],
      mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
    },
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    runStep: async () => ({ exitCode: 0, output: 'detection runs no steps' }),
  }
  const manifest = manifestById('freellmapi')!

  const detection = await detectInstance(deps, manifest)
  console.log('[live-detect] detected:', JSON.stringify({
    ok: detection.ok,
    endpoint: detection.baseURL,
    port: detection.port,
    url: detection.url,
    status: detection.health.status,
  }))
  expect(detection.ok).toBe(true)
  expect(detection.port).toBe(3002)
  expect(detection.baseURL).toBe('http://127.0.0.1:3002/v1')

  const outcome = await useDetectedInstance(deps, manifest)
  const route = mutations[0]?.ops[0]?.value
  writeFileSync(join(scratch, 'freellmapi-route.json'), JSON.stringify(route, null, 2), 'utf8')
  console.log('[live-detect] discovered models:', String(outcome.models.length))
  console.log('[live-detect] route:', JSON.stringify(route))

  expect(outcome.health.ok).toBe(true)
  expect(mutations).toHaveLength(1)
  expect((route as { baseURL?: string }).baseURL).toBe('http://127.0.0.1:3002/v1')
})
