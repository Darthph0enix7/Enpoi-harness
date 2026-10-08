/**
 * Catalog-overlay resolution tests.
 *
 * The shipped `catalog-overlays.json` is the deployment's correction for the
 * stale pi-ai 0.85.1 opencode-go catalog: it drops the two ids upstream
 * removed, adds the eleven ids the installed catalog lacks, and pins the
 * `deepseek-v4-pro` display name upstream still spells "… (New)". These tests
 * exercise the merge the sync performs each pass — live listing first, overlay
 * last — because that ordering is what makes a removal survive an endpoint
 * that still advertises the id.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCatalogOverlay,
  catalogOverlaysPath,
  loadCatalogOverlays,
  mergeConfiguredModels,
} from '../src/index.ts'

/** The eleven ids the installed pi-ai 0.85.1 catalog lacks, from models.dev. */
const ADDED = [
  'claude-haiku-5-5',
  'deepseek-v4.1-flash',
  'gpt-6-luna',
  'grok-4.5',
  'grok-4.7',
  'longcat-2.5-preview-free',
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'space-bunny',
  'space-bunny-free',
  'step-5-preview-free',
]

/** The two ids upstream removed but the endpoint and the stored list still carry. */
const REMOVED = ['glm-5.1', 'omen-alpha']

const directories: string[] = []

afterEach(() => {
  Reflect.deleteProperty(process.env, 'DSH_CATALOG_OVERLAYS')
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Write one overlay document to a throwaway path and return it. */
function overlayFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-overlays-'))
  directories.push(directory)
  const path = join(directory, 'catalog-overlays.json')
  writeFileSync(path, content, 'utf8')
  return path
}

describe('shipped catalog overlays', () => {
  it('ships an opencode-go overlay that removes the two stale ids and upserts the eleven missing ones', () => {
    const document = loadCatalogOverlays()
    expect(Object.keys(document.routes ?? {})).toEqual(['opencode-go'])
    const overlay = document.routes?.['opencode-go']
    expect(overlay?.remove).toEqual(REMOVED)
    const upsertIds = (overlay?.upsert ?? []).map(entry => entry.id)
    expect(new Set(upsertIds)).toEqual(new Set([...ADDED, 'deepseek-v4-pro']))
    // The name fix is a pin, not an accident of ordering: it is the only
    // upsert entry with no capacity fields, and it spells the id's own name.
    const nameFix = (overlay?.upsert ?? []).find(entry => entry.id === 'deepseek-v4-pro')
    expect(nameFix).toEqual({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' })
  })

  it('resolves the merged route to the eleven added ids, without the two removed ones, at models.dev capacities', () => {
    // The live listing still advertises both removed ids and ten of the
    // eleven additions; `space-bunny-free` is served by no endpoint, so only
    // the overlay can add it.
    const live = [...REMOVED, ...ADDED.filter(id => id !== 'space-bunny-free')].map(id => ({ id }))
    const stale = [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (New)', contextWindow: 1000000, maxTokens: 384000 },
      { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 202752, maxTokens: 32768 },
      { id: 'omen-alpha', name: 'Omen Alpha' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, maxTokens: 384000 },
    ]
    const merged = mergeConfiguredModels('opencode-go', stale, live, undefined).models
    // The endpoint still advertises the removals, so only the overlay can drop them.
    expect(merged.map(entry => entry.id)).toContain('glm-5.1')

    const applied = applyCatalogOverlay(merged, loadCatalogOverlays().routes?.['opencode-go'])
    const byId = new Map(applied.map(entry => [String(entry.id), entry]))
    expect(applied).toHaveLength(new Set(applied.map(entry => entry.id)).size)
    for (const id of ADDED) expect(byId.has(id), id).toBe(true)
    for (const id of REMOVED) expect(byId.has(id), id).toBe(false)

    // llm-pi-ai resolves a configured entry's own capacities over the
    // installed catalog and the route defaults, so these records are the
    // capacities the picker reports.
    const capacities: Record<string, [number, number]> = {
      'claude-haiku-5-5': [1_000_000, 128_000],
      'deepseek-v4.1-flash': [1_000_000, 384_000],
      'gpt-6-luna': [1_050_000, 128_000],
      'grok-4.5': [500_000, 500_000],
      'grok-4.7': [500_000, 500_000],
      'longcat-2.5-preview-free': [1_000_000, 131_072],
      'mimo-v2.6-flash': [1_048_576, 131_072],
      'mimo-v2.6-pro': [1_048_576, 131_072],
      'space-bunny': [1_048_576, 524_288],
      'space-bunny-free': [1_048_576, 524_288],
      'step-5-preview-free': [1_000_000, 65_536],
    }
    for (const [id, [contextWindow, maxTokens]] of Object.entries(capacities)) {
      expect(byId.get(id), id).toMatchObject({ contextWindow, maxTokens })
    }
    // Image-capable where models.dev says so, and priced for the catalogue rules.
    expect(byId.get('deepseek-v4.1-flash')).toMatchObject({
      name: 'DeepSeek V4.1 Flash',
      input: ['text', 'image'],
      reasoning: true,
      tools: true,
      cost: { input: 0.15, output: 0.6 },
    })
    expect(byId.get('grok-4.5')).toMatchObject({ input: ['text', 'image'], cost: { input: 2, output: 6 } })
    // The overlay record is maintained truth; the merge's "nothing described
    // this model" marker must not survive it.
    expect(byId.get('space-bunny-free')?.unverified).toBeUndefined()
    expect(byId.get('deepseek-v4-pro')?.name).toBe('DeepSeek V4 Pro')
    // A route model the overlay does not name keeps its merged record.
    expect(byId.get('deepseek-v4-flash')).toMatchObject({ name: 'DeepSeek V4 Flash', maxTokens: 384_000 })
  })

  it('leaves routes the document does not name untouched', () => {
    const other = [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }]
    expect(applyCatalogOverlay(other, undefined)).toBe(other)
    const document = loadCatalogOverlays()
    expect(document.routes?.['deepseek']).toBeUndefined()
    // An overlay naming only ids absent from the route is a no-op on membership.
    const noMatch = applyCatalogOverlay(other, { remove: ['absent-id'], upsert: [{ id: 'other-route-model' }] })
    expect(noMatch.map(entry => entry.id)).toEqual(['deepseek-chat', 'other-route-model'])
  })
})

describe('catalog overlay loading', () => {
  it('reads no overlays from an absent file', () => {
    expect(loadCatalogOverlays(join(tmpdir(), 'dsh-no-such-overlays.json'))).toEqual({})
  })

  it('rejects a malformed document loudly, naming the file', () => {
    const notAnObject = overlayFile('[]')
    expect(() => loadCatalogOverlays(notAnObject)).toThrow(/document must be an object/)
    const noId = overlayFile('{"routes":{"opencode-go":{"upsert":[{"name":"no id"}]}}}')
    expect(() => loadCatalogOverlays(noId)).toThrow(/upsert entry without a model id/)
    const badRemove = overlayFile('{"routes":{"opencode-go":{"remove":[7]}}}')
    expect(() => loadCatalogOverlays(badRemove)).toThrow(/remove entry that is not a model id/)
    const notAList = overlayFile('{"routes":{"opencode-go":{"remove":"glm-5.1"}}}')
    expect(() => loadCatalogOverlays(notAList)).toThrow(/not a list of model ids/)
  })

  it('honors the DSH_CATALOG_OVERLAYS override and resolves the bundled path by default', () => {
    const path = overlayFile('{"routes":{}}')
    process.env.DSH_CATALOG_OVERLAYS = path
    expect(loadCatalogOverlays()).toEqual({ routes: {} })
    Reflect.deleteProperty(process.env, 'DSH_CATALOG_OVERLAYS')
    expect(catalogOverlaysPath()).toMatch(/catalog-overlays\.json$/)
  })
})
