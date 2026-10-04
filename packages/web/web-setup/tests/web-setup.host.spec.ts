/**
 * REAL composition: a test-only cordis.yml boots through the Loader with the
 * shipped config editor, and the `webSetup` controller is driven end to end —
 * credential write, profile row surgery against the real patch document,
 * Loader hot mount of a real provider package, status projection, and the
 * pending-restart fallback for a provider package that is not installed.
 *
 * Only external inputs are faked: the credential provider is in-memory and the
 * provider packages are minimal real modules resolved by the Loader.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Hmr from '@deepseek-ai/dsh-hmr'
import * as WebSetup from '../src/index.ts'

/** Counts real mounts of the stub provider packages. */
declare global {
  var __dshWebSetupProbeMounts: number | undefined
  var __dshWebSetupFetchMounts: number | undefined
  var __dshWebSetupDeepseekMounts: number | undefined
  var __dshWebSetupBraveMounts: number | undefined
}

/** A minimal credential provider over an in-memory store. */
function memoryCredentials() {
  const store = new Map<string, string>()
  return {
    store,
    describe: async (ref: string) => store.has(ref)
      ? { configured: true, source: 'store', writable: true }
      : { configured: false, writable: true },
    resolve: async (ref: string) => store.has(ref) ? { value: store.get(ref), source: 'store' } : undefined,
    set: async (ref: string, value: string) => { store.set(ref, value) },
    unset: async (ref: string) => { store.delete(ref) },
  }
}

/**
 * Boot one real profile: config editor, a `web` seam row, a `tool-web` row,
 * the web-setup plugin, and one real provider package on disk.
 */
async function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'web-setup-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'web', name: 'cordis:web' },
    { id: 'tool-web', name: 'cordis:tool-web', config: { search: false, fetch: false } },
    { id: 'web-setup', name: 'cordis:web-setup' },
  ] }]))
  // A real provider package the Loader resolves and mounts on insert.
  const exaDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-web-search-exa')
  mkdirSync(exaDir, { recursive: true })
  writeFileSync(join(exaDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-search-exa', version: '1.0.0', type: 'module', main: 'index.js' }))
  writeFileSync(join(exaDir, 'index.js'), [
    'globalThis.__dshWebSetupProbeMounts = (globalThis.__dshWebSetupProbeMounts ?? 0) + 1',
    "export const name = 'web-search-exa'",
    'export const inject = []',
    'export function apply() {}',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test',
    startedBundles: ['test-bundle'],
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'),
    cwd: home,
    home,
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const credentials = memoryCredentials()
  const TestWeb = {
    Config: z.object({ searchProvider: z.string(), fetchProvider: z.string() }),
    apply: (_ctx: Context, _config: unknown) => {},
  }
  const TestTool = {
    Config: z.object({ search: z.boolean().default(false), fetch: z.boolean().default(false) }),
    apply: (_ctx: Context, _config: unknown) => {},
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    ctx.provide('credentials', credentials)
    Object.assign(ctx.loader.builtins, {
      editor: ConfigEditor,
      web: TestWeb,
      'tool-web': TestTool,
      'web-setup': WebSetup,
    })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Timer)
  const hmr = ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await hmr.await()
  await ctx.hmr.runExclusive(async () => {})
  return { ctx, profile, credentials }
}

it('applies a setup through the real Loader, patch document, and Remote namespace', async () => {
  globalThis.__dshWebSetupProbeMounts = undefined
  const { ctx, profile, credentials } = await fixture()

  expect(await ctx.webSetup.status()).toMatchObject({
    searchProvider: null,
    fetchProvider: null,
    mounted: [],
  })

  const result = await ctx.webSetup.applySetup({
    search: { provider: 'exa', apiKey: 'test-key' },
    toolToggles: { search: true, fetch: false },
  })
  expect(result).toEqual({
    ok: true,
    applied: ['credentials:EXA_API_KEY', 'row:web-search-exa', 'web.searchProvider', 'tool-web.search'],
  })
  expect(credentials.store.get('EXA_API_KEY')).toBe('test-key')
  // The provider package really mounted: its module ran in the Loader.
  expect(globalThis.__dshWebSetupProbeMounts).toBe(1)

  const status = await ctx.webSetup.status()
  expect(status.searchProvider).toBe('exa')
  expect(status.mounted).toEqual([{ kind: 'search', provider: 'exa' }])
  expect(status.credentials.EXA_API_KEY).toEqual({ configured: true, source: 'store', writable: true })

  const tool = ctx.configEditor.entries().find(entry => entry.options.id === 'tool-web')
  expect(tool?.options.config).toMatchObject({ search: true, fetch: false })
  const web = ctx.configEditor.entries().find(entry => entry.options.id === 'web')
  expect(web?.options.config).toMatchObject({ searchProvider: 'exa' })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('web-search-exa')

  // The credential-only and keyless canary branches cross the real service.
  expect(await ctx.webSetup.validateProvider(
    { kind: 'fetch', provider: 'http' },
    new AbortController().signal,
  )).toEqual({ ok: true })

  // Unset through the real document: the row stays mounted, the pointer clears.
  const cleared = await ctx.webSetup.applySetup({
    search: { provider: null },
    toolToggles: { search: false, fetch: false },
  })
  expect(cleared).toEqual({ ok: true, applied: ['web.searchProvider', 'tool-web.search'] })
  const clearedStatus = await ctx.webSetup.status()
  expect(clearedStatus.searchProvider).toBeNull()
  expect(clearedStatus.mounted).toEqual([{ kind: 'search', provider: 'exa' }])
})

it('reports a provider package the profile does not carry as pendingRestart', async () => {
  const { ctx, profile, credentials } = await fixture()
  const before = readFileSync(profile.patchPath, 'utf8')
  const result = await ctx.webSetup.applySetup({
    search: { provider: 'brave', apiKey: 'brave-key' },
    toolToggles: { search: true, fetch: false },
  })
  expect(result.ok).toBe(false)
  expect(result.pendingRestart?.ns).toBe('web-search-brave')
  expect(result.pendingRestart?.message).toContain('@deepseek-ai/dsh-web-search-brave')
  expect(result.applied).toEqual(['credentials:BRAVE_API_KEY'])
  expect(credentials.store.get('BRAVE_API_KEY')).toBe('brave-key')
  // The failed row was rolled back from the durable document.
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect((await ctx.webSetup.status()).searchProvider).toBeNull()
})

/** Writes one minimal real provider package into the profile's node_modules. */
function writeStubProvider(dir: string, name: string, pluginName: string, counter: string): void {
  const packageDir = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }))
  writeFileSync(join(packageDir, 'index.js'), [
    `globalThis.${counter} = (globalThis.${counter} ?? 0) + 1`,
    `export const name = '${pluginName}'`,
    'export const inject = []',
    'export function apply() {}',
    '',
  ].join('\n'))
}

/** One agent-preset group row carrying the nested rows the live profile composes. */
function presetEntry(id: string, presetId: string): Record<string, unknown> {
  return {
    id,
    name: 'cordis:preset',
    config: {
      id: presetId,
      name: presetId,
      plugins: [
        { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
      ],
    },
  }
}

/**
 * Boot a profile shaped like the live `web` profile: the host `tool-web` row
 * shipped by the base bundle and disabled by the web-app layer, three enabled
 * agent presets in the profile document whose `config.plugins` carry the
 * nested `tool-web` rows, a document-owned disabled `web-search-deepseek` row,
 * and a bundle-owned disabled `web-search-brave` row.
 */
async function realProfileFixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'web-setup-live-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([
    { insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'web', name: 'cordis:web', config: { searchProvider: 'exa', fetchProvider: 'http' } },
      { id: 'tool-web', name: 'cordis:tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
      { id: 'web-search-exa', name: '@deepseek-ai/dsh-web-search-exa' },
      { id: 'web-fetch-http', name: '@deepseek-ai/dsh-web-fetch-http' },
      { id: 'web-search-brave', name: '@deepseek-ai/dsh-web-search-brave', disabled: true },
      { id: 'web-setup', name: 'cordis:web-setup' },
    ] },
    { id: 'tool-web', disabled: true },
  ]))
  writeStubProvider(dir, '@deepseek-ai/dsh-web-search-exa', 'web-search-exa', '__dshWebSetupProbeMounts')
  writeStubProvider(dir, '@deepseek-ai/dsh-web-fetch-http', 'web-fetch-http', '__dshWebSetupFetchMounts')
  writeStubProvider(dir, '@deepseek-ai/dsh-web-search-deepseek', 'web-search-deepseek', '__dshWebSetupDeepseekMounts')
  writeStubProvider(dir, '@deepseek-ai/dsh-web-search-brave', 'web-search-brave', '__dshWebSetupBraveMounts')
  writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    presetEntry('preset-orchestrator', 'orchestrator'),
    presetEntry('preset-sysadmin', 'sysadmin'),
    presetEntry('preset-creator', 'creator'),
    { id: 'web-search-deepseek', name: '@deepseek-ai/dsh-web-search-deepseek', disabled: true, config: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test',
    startedBundles: ['test-bundle'],
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'),
    cwd: home,
    home,
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const credentials = memoryCredentials()
  const presets = new Map<string, { plugins: Array<Record<string, unknown>> }>()
  const TestWeb = {
    Config: z.object({ searchProvider: z.string(), fetchProvider: z.string() }),
    apply: (_ctx: Context, _config: unknown) => {},
  }
  const TestTool = {
    Config: z.object({ search: z.boolean().default(false), fetch: z.boolean().default(false) }),
    apply: (_ctx: Context, _config: unknown) => {},
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    ctx.provide('credentials', credentials)
    ctx.provide('agentPresets', {
      register: async (definition: { id: string; plugins: Array<Record<string, unknown>> }) => {
        presets.set(definition.id, definition)
        return () => { presets.delete(definition.id) }
      },
    })
    Object.assign(ctx.loader.builtins, {
      editor: ConfigEditor,
      web: TestWeb,
      'tool-web': TestTool,
      'web-setup': WebSetup,
      preset: AgentPreset,
    })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Timer)
  const hmr = ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await hmr.await()
  await ctx.hmr.runExclusive(async () => {})
  return { ctx, profile, credentials, presets }
}

it('edits the per-preset tool rows when the host tool row is disabled', async () => {
  const { ctx, presets } = await realProfileFixture()
  const hostBefore = ctx.configEditor.entries().find(entry => entry.options.id === 'tool-web')
  expect(hostBefore?.options.disabled).toBe(true)

  const result = await ctx.webSetup.applySetup({ toolToggles: { search: true, fetch: true } })
  expect(result).toEqual({ ok: true, applied: ['tool-web.search'] })

  for (const presetId of ['orchestrator', 'sysadmin', 'creator']) {
    const definition = presets.get(presetId)
    expect(definition).toBeDefined()
    const tool = definition?.plugins.find(plugin => plugin.name === '@deepseek-ai/dsh-tool-web') as { config: Record<string, unknown> } | undefined
    expect(tool?.config).toMatchObject({ search: true, fetch: true, searchTimeoutMs: 60000 })
  }
  const hostAfter = ctx.configEditor.entries().find(entry => entry.options.id === 'tool-web')
  expect(hostAfter?.options.disabled).toBe(true)
  expect((hostAfter?.options.config as Record<string, unknown> | undefined)?.search).toBeUndefined()
})

it('re-enables the document-owned disabled deepseek row through remove and insert', async () => {
  globalThis.__dshWebSetupDeepseekMounts = undefined
  const { ctx, profile } = await realProfileFixture()
  expect(ctx.configEditor.entries().find(entry => entry.options.id === 'web-search-deepseek')?.options.disabled).toBe(true)

  const result = await ctx.webSetup.applySetup({ search: { provider: 'deepseek-official' } })
  expect(result.ok).toBe(true)
  expect(result.applied).toContain('row:web-search-deepseek')
  expect(globalThis.__dshWebSetupDeepseekMounts).toBe(1)
  expect((await ctx.webSetup.status()).mounted).toContainEqual({ kind: 'search', provider: 'deepseek-official' })
  const patch = readFileSync(profile.patchPath, 'utf8')
  expect(patch).toContain('web-search-deepseek')
  expect(patch.includes('disabled: true')).toBe(false)
})

it('reports a disabled row owned by a shipped layer as pendingRestart with the exact field', async () => {
  globalThis.__dshWebSetupBraveMounts = undefined
  const { ctx, profile } = await realProfileFixture()
  const before = readFileSync(profile.patchPath, 'utf8')
  const result = await ctx.webSetup.applySetup({ search: { provider: 'brave' } })
  expect(result.ok).toBe(false)
  expect(result.pendingRestart?.ns).toBe('web-search-brave')
  expect(result.pendingRestart?.message).toContain('disabled: false')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(globalThis.__dshWebSetupBraveMounts).toBeUndefined()
})
