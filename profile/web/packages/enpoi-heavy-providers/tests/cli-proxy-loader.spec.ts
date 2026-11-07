/**
 * Real Loader composition for the heavy-provider host producer: a test-only
 * cordis.yml mounts the plugin with the launcher's profileContext, mocked
 * external settings/credentials, and a mocked HTTP endpoint. No subprocess,
 * proxy, or paid provider call is involved.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it, vi } from 'vitest'
import * as Heavy from '../src/index.js'
import { INSTALL_HELPER_PATH } from '../src/index.js'
import type { CredentialsSeam, FetchLike, SettingsSeam } from '../src/planner.js'
import type { HeavyProvidersService } from '../src/remote.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
})

function routeStore(): { settings: SettingsSeam; providers: Record<string, Record<string, unknown>> } {
  const providers: Record<string, Record<string, unknown>> = {}
  const settings: SettingsSeam = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers } }],
    mutate: async (_ns, ops) => {
      for (const op of ops) {
        const path = Array.isArray(op.path) ? op.path : []
        if (path[0] !== 'providers' || typeof path[1] !== 'string') continue
        if (op.op === 'unset') delete providers[path[1]]
        if (op.op === 'set' && op.value !== null && typeof op.value === 'object') {
          providers[path[1]] = { ...(op.value as Record<string, unknown>) }
        }
      }
    },
  }
  return { settings, providers }
}

function credentialStore(): CredentialsSeam {
  return { resolve: async () => undefined, set: async () => {}, unset: async () => {} }
}

async function writeLoaderConfig(root: string, extraConfig = ''): Promise<string> {
  const path = join(root, 'cordis.yml')
  await writeFile(path, [
    '- id: heavy-providers',
    '  name: cordis:test-heavy-providers',
    ...extraConfig === '' ? [] : ['  config:', ...extraConfig.split('\n').map(line => `    ${line}`)],
    '',
  ].join('\n'))
  return path
}

it('resolves the installer helper from the plugin module location, not a profile layout', () => {
  expect(existsSync(INSTALL_HELPER_PATH)).toBe(true)
  expect(INSTALL_HELPER_PATH.endsWith('/scripts/cliproxyapi-install.mjs')).toBe(true)
  // src/index.ts and the bundled lib/index.js sit at the same depth, so
  // `../scripts` names the same package directory from either.
  expect(dirname(dirname(INSTALL_HELPER_PATH))).toBe(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
})

it('mounts the plugin through a real Loader and stores the external keyless route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'heavy-loader-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const configPath = await writeLoaderConfig(root)
  const { settings, providers } = routeStore()
  const credentials = credentialStore()
  const calls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url)
    if (url.endsWith('/healthz')) return { ok: true, status: 200, text: async () => '{"status":"ok"}' }
    if (url.endsWith('/v1/models')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'gemini-2.5-pro' }] }) }
    }
    return { ok: false, status: 404, text: async () => 'not found' }
  }
  vi.stubGlobal('fetch', fetchImpl)
  const profile: ProfileContext = {
    name: 'heavy-loader',
    dir: root,
    patchPath: join(root, 'cordis.patch.yml'),
    installAnchor: root,
    cwd: root,
    home: join(root, '.dsh'),
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  const ctx: Context = await boot('heavy-loader', configPath, [], async (host) => {
    host.provide('profileContext', profile)
    host.provide('settings', settings as never)
    host.provide('credentials', credentials as never)
    host.loader.builtins['test-heavy-providers'] = Heavy
  })
  cleanups.push(async () => { await ctx.fiber.dispose() })

  const service = ctx.get('enpoiHeavy') as HeavyProvidersService
  const result = await service.reuse({ id: 'cliproxyapi' })
  expect(result.ok).toBe(true)
  expect(calls).toEqual([
    'http://127.0.0.1:8317/healthz',
    'http://127.0.0.1:8317/v1/models',
  ])
  expect(providers.cliproxyapi).toMatchObject({
    displayName: 'CLIProxyAPI (detected)',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:8317/v1',
    sessionHeader: 'x-session-id',
    catalogAuthority: 'endpoint',
    keyless: true,
    models: [{ id: 'gemini-2.5-pro' }],
  })
  expect(providers.cliproxyapi?.apiKeyEnv).toBeUndefined()
})

it('a real Loader without profileContext does not require one for the CPA helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'heavy-loader-noprofile-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const configPath = await writeLoaderConfig(root)
  const { settings, providers } = routeStore()
  vi.stubEnv('HOME', root)
  const ctx: Context = await boot('heavy-loader-noprofile', configPath, [], async (host) => {
    host.provide('settings', settings as never)
    host.provide('credentials', credentialStore() as never)
    host.loader.builtins['test-heavy-providers'] = Heavy
  })
  cleanups.push(async () => { await ctx.fiber.dispose() })

  expect(ctx.get('profileContext')).toBeUndefined()
  const service = ctx.get('enpoiHeavy') as HeavyProvidersService
  const result = await service.install({ id: 'cliproxyapi' })
  // The helper is module-relative, so the missing running profile root is no
  // longer a reason to refuse; this composition has no subprocess seam, so
  // the runtime probe refuses Node and no job starts.
  expect(result.blocked?.reason).not.toContain('running profile root is unknown')
  expect(result.blocked?.reason).toContain('Node.js')
  expect(providers).toEqual({})
  expect(service.job({ id: 'cliproxyapi' })).toEqual({})
})

it('a relative configured profileDir is refused at mount instead of expanding inconsistently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'heavy-loader-relative-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const configPath = await writeLoaderConfig(root, 'profileDir: relative/profile')
  const { settings } = routeStore()
  // Cordis isolates a failing plugin entry instead of rejecting boot; the
  // failure must leave no service behind rather than mounting with a guessed
  // directory.
  const ctx: Context = await boot('heavy-loader-relative', configPath, [], async (host) => {
    host.provide('settings', settings as never)
    host.provide('credentials', credentialStore() as never)
    host.loader.builtins['test-heavy-providers'] = Heavy
  })
  cleanups.push(async () => { await ctx.fiber.dispose() })
  expect(ctx.get('enpoiHeavy')).toBeUndefined()
})
