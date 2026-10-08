/**
 * Operator overlay for the pre-connection fallback: the document published
 * from `$DSH_HOME/heavy-server-overlay.json` disables providers and overrides
 * their fields before any host reply. Malformed entries and fields degrade to
 * "no override"; the shipped table is never mutated.
 */
import { afterEach, expect, it, vi } from 'vitest'
import {
  applyHeavyOverlay,
  HEAVY_OVERLAY_GLOBAL,
  parseHeavyOverlay,
  readHeavyOverlayGlobal,
} from '../src/heavy-overlay.ts'
import { FALLBACK_HEAVY_PROVIDER_MANIFESTS, fallbackHeavyManifest } from '../src/client/heavy-providers.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('parses a document tolerantly: malformed entries and fields are dropped', () => {
  expect(parseHeavyOverlay(null)).toEqual({ providers: {} })
  expect(parseHeavyOverlay({ providers: 'nope' })).toEqual({ providers: {} })
  const parsed = parseHeavyOverlay({
    providers: {
      freellmapi: { disabled: true, label: '', fallbackModel: 7, installSteps: 'nope', pool: { identities: [] } },
      antigravity: 'not-an-entry',
    },
  })
  expect(parsed.providers.freellmapi).toEqual({ disabled: true })
  expect(parsed.providers.antigravity).toBeUndefined()
})

it('disables a manifest and overrides label, summary, and links', () => {
  const overlay = parseHeavyOverlay({
    providers: {
      freellmapi: { disabled: true },
      antigravity: {
        label: 'Antigravity (operator)',
        summary: 'Operator summary',
        dashboardUrl: 'http://operator.internal:9000',
        docsUrl: null,
      },
    },
  })
  const effective = applyHeavyOverlay(FALLBACK_HEAVY_PROVIDER_MANIFESTS, overlay)
  expect(effective.map(manifest => manifest.id)).toEqual(['antigravity', 'commandcode'])
  const antigravity = effective.find(manifest => manifest.id === 'antigravity')!
  expect(antigravity.label).toBe('Antigravity (operator)')
  expect(antigravity.summary).toBe('Operator summary')
  expect(antigravity.dashboardUrl).toBe('http://operator.internal:9000')
  expect(antigravity.docsUrl).toBeUndefined()
  // The shipped table is never mutated.
  expect(fallbackHeavyManifest('antigravity')?.label).toBe('Antigravity Proxy')
  expect(fallbackHeavyManifest('antigravity')?.docsUrl).toBeDefined()
})

it('replaces install steps on every supported platform variant and keeps refusals', () => {
  const steps = [{ label: 'Operator step', command: 'echo operator' }]
  const overlay = parseHeavyOverlay({ providers: { antigravity: { installSteps: steps } } })
  const antigravity = applyHeavyOverlay(FALLBACK_HEAVY_PROVIDER_MANIFESTS, overlay)
    .find(manifest => manifest.id === 'antigravity')!
  expect(antigravity.local.install.default.steps).toEqual(steps)
  expect(antigravity.local.install.linux?.steps).toEqual(steps)
  expect(antigravity.local.install.darwin?.steps).toEqual(steps)
  // A refused platform keeps its reason instead of running the operator steps.
  expect(antigravity.local.install.win32?.steps).toEqual([])
  expect(antigravity.local.install.win32?.unsupported).toBeDefined()
})

it('sets and removes fallbackModel and pool', () => {
  const overlay = parseHeavyOverlay({
    providers: {
      freellmapi: { fallbackModel: 'operator/model' },
      commandcode: { fallbackModel: null, pool: null },
    },
  })
  const effective = applyHeavyOverlay(FALLBACK_HEAVY_PROVIDER_MANIFESTS, overlay)
  expect(effective.find(manifest => manifest.id === 'freellmapi')?.fallbackModel).toBe('operator/model')
  const commandcode = effective.find(manifest => manifest.id === 'commandcode')!
  expect(commandcode.fallbackModel).toBeUndefined()
  expect(commandcode.pool).toBeUndefined()

  // A pool override replaces the identities whole.
  const replaced = applyHeavyOverlay(FALLBACK_HEAVY_PROVIDER_MANIFESTS, parseHeavyOverlay({
    providers: {
      commandcode: {
        pool: { strategy: 'balanced', identities: [{ id: 'key-9', credentialRef: 'COMMANDCODE_KEY_9', priority: 4 }] },
      },
    },
  })).find(manifest => manifest.id === 'commandcode')!
  expect(replaced.pool).toEqual({
    strategy: 'balanced',
    identities: [{ id: 'key-9', credentialRef: 'COMMANDCODE_KEY_9', priority: 4 }],
  })
})

it('rejects a malformed pool override instead of writing it', () => {
  const overlay = parseHeavyOverlay({
    providers: { commandcode: { pool: { identities: [{ id: 'key-1', credentialRef: 'lower-case' }] } } },
  })
  expect(overlay.providers.commandcode).toBeUndefined()
  const commandcode = applyHeavyOverlay(FALLBACK_HEAVY_PROVIDER_MANIFESTS, overlay)
    .find(manifest => manifest.id === 'commandcode')!
  expect(commandcode.pool?.identities[0]?.credentialRef).toBe('COMMANDCODE_KEY_1')
})

it('retargets reuse and health URLs', () => {
  const overlay = parseHeavyOverlay({
    providers: {
      freellmapi: {
        reuseBaseURL: 'http://operator.internal:9000/v1',
        reuseHealthURL: 'http://operator.internal:9000/ping',
      },
    },
  })
  const freellmapi = applyHeavyOverlay(FALLBACK_HEAVY_PROVIDER_MANIFESTS, overlay)
    .find(manifest => manifest.id === 'freellmapi')!
  expect(freellmapi.reuse.baseURL).toBe('http://operator.internal:9000/v1')
  expect(freellmapi.reuse.health.url).toBe('http://operator.internal:9000/ping')
})

it('returns the table unchanged without an overlay and reads the page global', () => {
  expect(applyHeavyOverlay(FALLBACK_HEAVY_PROVIDER_MANIFESTS, { providers: {} }))
    .toEqual([...FALLBACK_HEAVY_PROVIDER_MANIFESTS])

  vi.stubGlobal(HEAVY_OVERLAY_GLOBAL, { providers: { freellmapi: { disabled: true } } })
  expect(readHeavyOverlayGlobal().providers.freellmapi).toEqual({ disabled: true })
  expect(applyHeavyOverlay(FALLBACK_HEAVY_PROVIDER_MANIFESTS, readHeavyOverlayGlobal()).map(manifest => manifest.id))
    .toEqual(['antigravity', 'commandcode'])
})
