/**
 * Capability parity between the two listing readers, and the route write that
 * carries what they disclose.
 *
 * The heavy Add flow reads `/v1/models` before any llm-pi-ai discovery runs;
 * llm-pi-ai's Models page reads the same reply. Both must map one body to the
 * same capabilities, or an Add-created route shows no Effort control until a
 * later refresh replaces its models. `routeProfile` must then write the
 * manifest's compat switches and each model's ladder into the profile.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { discoverModels as piAiDiscoverModels } from '@deepseek-ai/dsh-llm-pi-ai/src/discovery.ts'
import { manifestById } from '../src/manifests.js'
import {
  discoverModels,
  routeProfile,
  useDetectedInstance,
  type FetchLike,
  type HeavyDeps,
  type SettingsSeam,
} from '../src/planner.js'

const scratch: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One endpoint reply in the shipped shapes: verified against a live Meridian listing. */
const LISTING = {
  object: 'list',
  data: [
    {
      id: 'claude-sonnet-5-5',
      object: 'model',
      display_name: 'Claude Sonnet 5.5',
      context_window: 1_000_000,
      capabilities: {
        image_input: { supported: true },
        pdf_input: { supported: true },
        effort: {
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
          xhigh: { supported: true },
          max: { supported: true },
          // Advertised as unavailable: never offered.
          minimal: { supported: false },
          // The block's own marker is not a level.
          supported: true,
        },
        thinking: { supported: true, types: { adaptive: { supported: true } } },
      },
    },
    {
      id: 'plain-model',
      object: 'model',
      context_window: 200_000,
      max_output_tokens: 8192,
    },
  ],
}

/** The capability fields of either reader's rows, named once. */
interface CapabilityRow {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
  reasoningEfforts?: Readonly<Record<string, string>>
}

/** Normalize one reader's row: the planner says `input`, llm-pi-ai says `inputModalities`. */
function capabilityRow(row: {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: readonly string[]
  inputModalities?: readonly string[]
  reasoningEfforts?: Readonly<Record<string, string>>
}): CapabilityRow {
  return {
    id: row.id,
    name: row.name ?? row.id,
    ...row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow },
    ...row.maxTokens === undefined ? {} : { maxTokens: row.maxTokens },
    ...row.input === undefined && row.inputModalities === undefined
      ? {}
      : { inputModalities: row.input ?? row.inputModalities },
    ...row.reasoningEfforts === undefined ? {} : { reasoningEfforts: row.reasoningEfforts },
  }
}

/** A deps bundle with recording settings and an injectable fetch. */
function depsWith(fetch: FetchLike): { deps: HeavyDeps; mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }> } {
  const mutations: Array<{ ns: string; ops: readonly Record<string, unknown>[] }> = []
  const root = mkdtempSync(join(tmpdir(), 'heavy-capability-'))
  scratch.push(root)
  const settings: SettingsSeam = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 3, value: { providers: {} } }],
    mutate: async (ns, ops) => { mutations.push({ ns, ops }) },
  }
  return {
    deps: {
      home: root,
      dshHome: join(root, '.dsh'),
      settings,
      fetchImpl: fetch,
      runStep: async () => ({ exitCode: 0, output: '' }),
    },
    mutations,
  }
}

it('the planner and llm-pi-ai discovery read the same capabilities from one body', async () => {
  const body = JSON.stringify(LISTING)
  const heavyFetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => body })
  const fromPlanner = await discoverModels('http://listing.invalid', undefined, heavyFetch, 'anthropic-messages')

  vi.stubGlobal('fetch', async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
  const fromDiscovery = await piAiDiscoverModels({ baseURL: 'http://listing.invalid', api: 'anthropic-messages' })

  const expected: CapabilityRow[] = [
    {
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      contextWindow: 1_000_000,
      inputModalities: ['text', 'image', 'pdf'],
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    },
    { id: 'plain-model', name: 'plain-model', contextWindow: 200_000, maxTokens: 8192 },
  ]
  expect(fromPlanner.map(capabilityRow)).toEqual(expected)
  expect(fromDiscovery.map(capabilityRow)).toEqual(expected)
})

it('routeProfile writes the manifest compat switches and the disclosed ladder', async () => {
  const manifest = manifestById('meridian')!
  const models = await discoverModels(
    'http://127.0.0.1:3456',
    undefined,
    async () => ({ ok: true, status: 200, text: async () => JSON.stringify(LISTING) }),
    'anthropic-messages',
  )
  const profile = routeProfile(manifest, 'reuse', models)

  expect(profile.compat).toEqual({ forceAdaptiveThinking: true })
  expect(profile.models[0]).toEqual({
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    contextWindow: 1_000_000,
    input: ['text', 'image', 'pdf'],
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  })
  // A listing that discloses no ladder writes none: absent, never an empty dict
  // the route schema would refuse as declared-but-empty.
  expect(profile.models[1]).toEqual({ id: 'plain-model', contextWindow: 200_000, maxTokens: 8192 })
})

it('an Add-created Meridian route carries the compat and the ladder immediately', async () => {
  const fetch: FetchLike = vi.fn(async (url) => {
    if (url.endsWith('/health')) return { ok: true, status: 200, text: async () => '{"status":"ok"}' }
    return { ok: true, status: 200, text: async () => JSON.stringify(LISTING) }
  })
  const { deps, mutations } = depsWith(fetch)
  const outcome = await useDetectedInstance(deps, manifestById('meridian')!)

  const written = mutations[0]!.ops[0] as { path: string[]; value: Record<string, unknown> }
  expect(written.path).toEqual(['providers', 'meridian'])
  expect(written.value.compat).toEqual({ forceAdaptiveThinking: true })
  expect(written.value.models).toEqual([
    {
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      contextWindow: 1_000_000,
      input: ['text', 'image', 'pdf'],
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    },
    { id: 'plain-model', contextWindow: 200_000, maxTokens: 8192 },
  ])
  // The outcome the Add reply carries holds the same capabilities.
  expect(outcome.models[0]?.reasoningEfforts).toEqual({ low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
  expect(outcome.models[0]?.input).toEqual(['text', 'image', 'pdf'])
})
