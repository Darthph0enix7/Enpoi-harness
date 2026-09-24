/**
 * Profile fallback reconciliation of `dsh-app-boot`: the boot-time bundle
 * check and its repair, plus the root-include guard that heals a pruned
 * fallback link once and retries the import.
 */

import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  checkProfileBundleResolution,
  healIsolatedProfileModuleFallback,
  healProfilesModuleFallback,
  mountRootInclude,
  PROFILE_PATCH_FILENAME,
  PROFILES_DIR,
  readProfileManifest,
  reconcileProfilePatches,
  resolveBundleDir,
  type Profile,
  type ProfileLayer,
} from '../src/index.ts'
import { auditProfileModuleFallback } from '../src/profile.ts'

const NAME = 'dsh-test-bin'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-fallback-'))
  tempRoots.push(dir)
  return dir
}

/** Write one package directory with a manifest and an importable ESM entry. */
function writePackage(dir: string, manifest: Record<string, unknown>, code?: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    version: '0.0.0', type: 'module', main: './index.js', ...manifest,
  }))
  writeFileSync(join(dir, 'index.js'), code ?? `export const packageName = ${JSON.stringify(manifest.name)}\n`)
}

/** Stage an installation app whose bundles and nested bundle dependencies exist on disk. */
function stageInstallation(
  appName: string,
  bundles: Record<string, { patch?: string; deps?: Record<string, unknown> }>,
): string {
  const appDir = join(tmp(), 'app')
  const appDeps: Record<string, string> = {}
  for (const [name, spec] of Object.entries(bundles)) {
    appDeps[name] = '1.0.0'
    const bundleDir = join(appDir, 'node_modules', name)
    writePackage(bundleDir, { name, dependencies: spec.deps ?? {} })
    if (spec.patch !== undefined) writeFileSync(join(bundleDir, 'cordis.patch.yml'), spec.patch)
    for (const dep of Object.keys(spec.deps ?? {})) {
      writePackage(join(bundleDir, 'node_modules', dep), { name: dep })
    }
  }
  writePackage(appDir, { name: appName, dependencies: appDeps })
  return join(appDir, 'package.json')
}

/** Stage a named profile directory with an empty root config and a bundle list. */
function stageProfile(home: string, name: string, bundles: readonly string[]): string {
  const dir = join(home, PROFILES_DIR, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`, private: true, dsh: { profile: { bundles } },
  }))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  return dir
}

/** Load a profile for the heal helpers; every listed bundle must resolve. */
function loadForHeal(profileDir: string, installAnchor: string): Profile {
  const manifest = readProfileManifest(NAME, profileDir)
  const layers: ProfileLayer[] = (manifest.dsh?.profile?.bundles ?? []).map((packageName) => {
    const packageDir = resolveBundleDir(NAME, packageName, installAnchor, profileDir)
    return { packageName, packageDir, patchPath: join(packageDir, 'cordis.patch.yml'), patches: [] }
  })
  return {
    name: basename(profileDir),
    dir: profileDir,
    layers,
    patchPath: join(profileDir, PROFILE_PATCH_FILENAME),
    patches: [],
  }
}

describe('checkProfileBundleResolution', () => {
  it('reports a pruned fallback link, restores it, and the package imports again', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n', deps: { 'carried-a': {} } } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    const link = join(home, PROFILES_DIR, 'node_modules', 'carried-a')
    unlinkSync(link)

    const report = await checkProfileBundleResolution({ installAnchor, profileDir, home })

    expect(report).toEqual({ checked: 4, repaired: 1, missing: [] })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(createRequire(join(profileDir, 'package.json')).resolve('carried-a')).toBeTruthy()
  })

  it('repairs a profile-owned bundle projection pruned by the manager', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', {})
    const profileDir = stageProfile(home, 'scratch', ['local-bundle'])
    writePackage(join(profileDir, 'node_modules', 'local-bundle'), { name: 'local-bundle', dependencies: { 'carried-local': '1.0.0' } })
    writePackage(join(profileDir, 'node_modules', 'local-bundle', 'node_modules', 'carried-local'), { name: 'carried-local' })
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    const projection = join(profileDir, 'node_modules', 'carried-local')
    expect(lstatSync(projection).isSymbolicLink()).toBe(true)
    unlinkSync(projection)

    const report = await checkProfileBundleResolution({ installAnchor, profileDir, home })

    expect(report).toEqual({ checked: 3, repaired: 1, missing: [] })
    expect(lstatSync(projection).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(profileDir, '.dsh-module-fallback', 'node_modules', 'carried-local')).isSymbolicLink()).toBe(true)
  })

  it('leaves a healthy profile untouched and reports no gap', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n', deps: { 'carried-b': {} } } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    const link = join(home, PROFILES_DIR, 'node_modules', 'carried-b')
    const before = { ino: statSync(link).ino, target: readlinkSync(link) }

    const report = await checkProfileBundleResolution({ installAnchor, profileDir, home })

    expect(report).toEqual({ checked: 4, repaired: 0, missing: [] })
    expect({ ino: statSync(link).ino, target: readlinkSync(link) }).toEqual(before)
  })

  it('reports a configured bundle that no anchor resolves without inventing a target', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n' } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a', 'ghost-bundle'])

    const report = await checkProfileBundleResolution({ installAnchor, profileDir, home })

    expect(report.missing).toEqual(['ghost-bundle'])
    expect(report.repaired).toBe(0)
  })

  it('reports the gap without repairing when repair is disabled', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n', deps: { 'carried-c': {} } } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    const link = join(home, PROFILES_DIR, 'node_modules', 'carried-c')
    unlinkSync(link)

    const report = await checkProfileBundleResolution({ installAnchor, profileDir, home, repair: false })

    expect(report).toEqual({ checked: 4, repaired: 0, missing: ['carried-c'] })
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
  })

  it('repairs an application-owned profile through its own fallback directory', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('desktop-app', { 'bundle-i': { patch: '[]\n', deps: { 'carried-i': {} } } })
    const profileDir = stageProfile(tmp(), 'desktop-profile', ['bundle-i'])
    healIsolatedProfileModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor) })
    const projection = join(profileDir, 'node_modules', 'carried-i')
    unlinkSync(projection)

    const report = await checkProfileBundleResolution({ installAnchor, profileDir, home })

    expect(report).toEqual({ checked: 4, repaired: 1, missing: [] })
    expect(lstatSync(projection).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(profileDir, 'node_modules', 'bundle-i')).isSymbolicLink()).toBe(true)
  })

  it('reports a foreign or misdirected owned projection instead of claiming it current', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('desktop-app', { 'bundle-i': { patch: '[]\n', deps: { 'carried-j': {} } } })
    const profileDir = stageProfile(tmp(), 'desktop-profile', ['bundle-i'])
    healIsolatedProfileModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor) })
    const projection = join(profileDir, 'node_modules', 'carried-j')
    unlinkSync(projection)
    mkdirSync(projection)

    const report = await checkProfileBundleResolution({ installAnchor, profileDir, home })

    expect(report.missing).toContain('carried-j')
    expect(report.repaired).toBe(0)

    rmSync(projection, { recursive: true })
    symlinkSync(join(profileDir, 'elsewhere'), projection)
    const misdirected = await checkProfileBundleResolution({ installAnchor, profileDir, home })
    expect(misdirected.missing).toContain('carried-j')
  })

  it('treats a manifest without a bundle list as nothing to check', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', {})
    const profileDir = join(home, PROFILES_DIR, 'scratch')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-scratch', private: true }))

    const report = await checkProfileBundleResolution({ installAnchor, profileDir, home })

    expect(report).toEqual({ checked: 0, repaired: 0, missing: [] })
  })

  it('audits installation entries without a loaded profile', async () => {
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n', deps: { 'carried-d': {} } } })

    const audit = auditProfileModuleFallback({ installAnchor, home: tmp() })

    expect(audit.checked).toBe(3)
    expect(audit.missing).toEqual(['dsh-app', 'bundle-a', 'carried-d'])
  })
})

/** Mount a guarded root include on a real Loader and return the include tree. */
async function mountGuardedInclude(
  home: string, installAnchor: string, profileDir: string,
): Promise<{ ctx: Context; importPackage: (name: string) => Promise<Record<string, unknown>>; logs: string[] }> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.provide('profileContext', {
    name: basename(profileDir),
    dir: profileDir,
    patchPath: join(profileDir, PROFILE_PATCH_FILENAME),
    installAnchor,
    cwd: profileDir,
    home,
    startedBundles: Object.keys(readProfileManifest(NAME, profileDir).dependencies ?? {}),
    overlays: [],
    telemetryDisabledEnv: undefined,
  })
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: ({ args }) => { logs.push(args.map(String).join(' ')) } })
  const entry = await mountRootInclude(ctx, join(profileDir, 'cordis.yml'))
  await ctx.loader.await()
  const include = entry!.subtree as unknown as { import(name: string): Promise<Record<string, unknown>> }
  return { ctx, importPackage: name => include.import(name), logs }
}

describe('root include fallback guard', () => {
  it('repairs a pruned link once, retries the import, and never loops', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n', deps: { 'carried-guard': {} } } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    const link = join(home, PROFILES_DIR, 'node_modules', 'carried-guard')
    unlinkSync(link)
    const { ctx, importPackage, logs } = await mountGuardedInclude(home, installAnchor, profileDir)
    try {
      const exports = await importPackage('carried-guard')
      expect(exports['packageName']).toBe('carried-guard')
      expect(logs).toContain('profile-heal: repaired 1 links; retrying carried-guard')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)

      unlinkSync(link)
      await expect(importPackage('carried-guard/extra.mjs')).rejects.toThrow()
      expect(logs.filter(line => line.startsWith('profile-heal:'))).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('repairs a pruned link when a configuration reload imports the row', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n', deps: { 'carried-reload': {} } } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    writeFileSync(join(
      dirname(installAnchor), 'node_modules', 'bundle-a', 'node_modules', 'carried-reload', 'index.js',
    ), 'export const name = "carried-reload"\nexport function apply() {}\n')
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    const link = join(home, PROFILES_DIR, 'node_modules', 'carried-reload')
    unlinkSync(link)
    const { ctx, logs } = await mountGuardedInclude(home, installAnchor, profileDir)
    try {
      await reconcileProfilePatches(ctx, [{ insert: [{ id: 'reload-row', name: 'carried-reload' }] }], NAME)
      const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'reload-row')
      expect(row?.fiber).toBeDefined()
      expect(logs).toContain('profile-heal: repaired 1 links; retrying carried-reload')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves a failing import for a different reason alone', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', {
      'bundle-a': { patch: '[]\n', deps: { 'broken-guard': {} } },
    })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    writeFileSync(join(
      dirname(installAnchor), 'node_modules', 'bundle-a', 'node_modules', 'broken-guard', 'index.js',
    ), 'throw new Error("boom")\n')
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    const { ctx, importPackage, logs } = await mountGuardedInclude(home, installAnchor, profileDir)
    try {
      await expect(importPackage('broken-guard')).rejects.toThrow('boom')
      await expect(importPackage('./missing.mjs')).rejects.toThrow()
      await expect(importPackage('@scope/absent-typo')).rejects.toThrow()
      expect(logs.filter(line => line.startsWith('profile-heal:'))).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a failed retry after a successful repair', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', {
      'bundle-a': { patch: '[]\n', deps: { 'carried-retry': {} } },
    })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    writeFileSync(join(
      dirname(installAnchor), 'node_modules', 'bundle-a', 'node_modules', 'carried-retry', 'index.js',
    ), 'throw new Error("retry-boom")\n')
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    unlinkSync(join(home, PROFILES_DIR, 'node_modules', 'carried-retry'))
    const { ctx, importPackage, logs } = await mountGuardedInclude(home, installAnchor, profileDir)
    try {
      await expect(importPackage('carried-retry')).rejects.toThrow('retry-boom')
      expect(logs).toContain('profile-heal: repaired 1 links; retrying carried-retry')
      expect(logs.some(line => line.startsWith('profile-heal: retry failed: retry-boom'))).toBe(true)

      unlinkSync(join(home, PROFILES_DIR, 'node_modules', 'carried-retry'))
      await expect(importPackage('carried-retry')).rejects.toThrow()
      expect(logs.filter(line => line.startsWith('profile-heal:'))).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not heal during teardown', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n', deps: { 'carried-teardown': {} } } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    const link = join(home, PROFILES_DIR, 'node_modules', 'carried-teardown')
    const { ctx, importPackage, logs } = await mountGuardedInclude(home, installAnchor, profileDir)
    await ctx.fiber.dispose()
    unlinkSync(link)

    await expect(importPackage('carried-teardown')).rejects.toThrow()

    expect(logs.filter(line => line.startsWith('profile-heal:'))).toHaveLength(0)
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
  })

  it('reports a failed repair instead of hiding it', async () => {
    const home = tmp()
    mkdirSync(join(home, PROFILES_DIR), { recursive: true })
    writeFileSync(join(home, PROFILES_DIR, 'node_modules'), 'not a directory\n')
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n', deps: { 'carried-fail': {} } } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    const { ctx, importPackage, logs } = await mountGuardedInclude(home, installAnchor, profileDir)
    try {
      await expect(importPackage('carried-fail')).rejects.toThrow()
      expect(logs.some(line => line.startsWith('profile-heal: retry failed:'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('boot profile fallback check', () => {
  it('repairs a pruned fallback link before rows mount and logs the summary', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n', deps: { 'carried-boot': {} } } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    const link = join(home, PROFILES_DIR, 'node_modules', 'carried-boot')
    unlinkSync(link)
    const logs: string[] = []
    const ctx = await boot(NAME, join(profileDir, 'cordis.yml'), undefined, (host) => {
      host.provide('profileContext', {
        name: 'scratch',
        dir: profileDir,
        patchPath: join(profileDir, PROFILE_PATCH_FILENAME),
        installAnchor,
        cwd: profileDir,
        home,
        startedBundles: ['bundle-a'],
        overlays: [],
        telemetryDisabledEnv: undefined,
      })
      host.logger.exporter({ levels: { default: 3 }, export: ({ args }) => { logs.push(args.map(String).join(' ')) } })
    })
    try {
      expect(logs).toContain('profile bundles: 4 resolvable, 1 repaired, 0 missing')
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('warns once for a configured bundle no anchor resolves', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n' } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a', 'ghost-boot'])
    const logs: Array<{ args: unknown[]; type: string }> = []
    const ctx = await boot(NAME, join(profileDir, 'cordis.yml'), undefined, (host) => {
      host.provide('profileContext', {
        name: 'scratch',
        dir: profileDir,
        patchPath: join(profileDir, PROFILE_PATCH_FILENAME),
        installAnchor,
        cwd: profileDir,
        home,
        startedBundles: ['bundle-a'],
        overlays: [],
        telemetryDisabledEnv: undefined,
      })
      host.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push({ args: message.args, type: message.type }) } })
    })
    try {
      expect(logs).toContainEqual({ args: ['profile bundle missing: ghost-boot'], type: 'warn' })
      expect(logs.filter(message => message.type === 'warn')).toHaveLength(1)
      expect(logs.some(message => message.type === 'info'
        && String(message.args[0]).startsWith('profile bundles: ')
        && String(message.args[0]).endsWith('1 missing'))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a clean profile at debug without a warning', async () => {
    const home = tmp()
    const installAnchor = stageInstallation('dsh-app', { 'bundle-a': { patch: '[]\n', deps: { 'carried-clean': {} } } })
    const profileDir = stageProfile(home, 'scratch', ['bundle-a'])
    await healProfilesModuleFallback({ installAnchor, profile: loadForHeal(profileDir, installAnchor), home })
    const logs: Array<{ args: unknown[]; type: string }> = []
    const ctx = await boot(NAME, join(profileDir, 'cordis.yml'), undefined, (host) => {
      host.provide('profileContext', {
        name: 'scratch',
        dir: profileDir,
        patchPath: join(profileDir, PROFILE_PATCH_FILENAME),
        installAnchor,
        cwd: profileDir,
        home,
        startedBundles: ['bundle-a'],
        overlays: [],
        telemetryDisabledEnv: undefined,
      })
      host.logger.exporter({ levels: { default: 3 }, export: (message) => { logs.push({ args: message.args, type: message.type }) } })
    })
    try {
      const summary = logs.filter(message => String(message.args[0]).startsWith('profile bundles:'))
      expect(summary).toEqual([{ args: ['profile bundles: 4 resolvable, 0 repaired, 0 missing'], type: 'debug' }])
      expect(logs.some(message => message.type === 'warn')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
