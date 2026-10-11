/**
 * Wallpaper-Engine default guard — the skin center's WE bridge ships off.
 *
 * Operator policy: the `skin-wallpaper` feature (the Wallpaper Engine bridge in
 * `@linxin666/dsh-client-ui-skin-center`) must be OFF unless a user explicitly
 * turns it on, and the profile must not carry WE binaries or installer
 * machinery. On the 0.1.7 settings engine the `installSection` / `settings.get`
 * namespace seam the plugin registers through is gone, and `skin-wallpaper` is
 * not a profile entry id, so the fresh-settings row can never persist: the
 * package's own defaults (host schema + client fallback) are the source of
 * truth. This spec pins all of it:
 *
 * 1. the fresh seed still declares `skin-wallpaper.enabled: false`;
 * 2. the committed pnpm patch flips the host schema default and the client
 *    fallback to false, and only the absent-value fallbacks change;
 * 3. the patch is registered in `pnpm-workspace.yaml` and hashed into
 *    `pnpm-lock.yaml`, so installs on every device apply it;
 * 4. the published package carries no executable payload (no WE binary, no
 *    install script, no `bin` entry) — the bridge only reads a local library.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH_REL = 'patches/@linxin666__dsh-client-ui-skin-center@0.3.21.patch'
const PATCH_TEXT = readFileSync(join(PROFILE, PATCH_REL), 'utf8')
const PACKAGE_DIR = join(PROFILE, 'node_modules/@linxin666/dsh-client-ui-skin-center')

/** The exact hunks the committed patch must carry; context lines pin the installed build. */
const HOST_BEFORE = '-\tenabled: z.boolean().default(true),'
const HOST_AFTER = '+\tenabled: z.boolean().default(false),'
const CLIENT_FIELD_BEFORE = '-\t\t\tenabledValue = true;'
const CLIENT_FIELD_AFTER = '+\t\t\tenabledValue = false;'
const CLIENT_FALLBACK_BEFORE = '-\t\t\t\tthis.enabledValue = typeof value.enabled === "boolean" ? value.enabled : true;'
const CLIENT_FALLBACK_AFTER = '+\t\t\t\tthis.enabledValue = typeof value.enabled === "boolean" ? value.enabled : false;'

function patchBinary(): string | undefined {
  const probe = spawnSync('patch', ['--version'], { encoding: 'utf8' })
  return probe.status === 0 ? 'patch' : undefined
}

describe('skin-wallpaper defaults', () => {
  it('seeds skin-wallpaper.enabled false for a fresh install', () => {
    const doc = load(readFileSync(join(PROFILE, 'fresh-settings.yaml'), 'utf8')) as Record<string, unknown>
    expect(doc['skin-wallpaper']).toEqual({ enabled: false })
  })

  it('flips exactly the absent-value defaults to false in the committed patch', () => {
    for (const hunk of [
      HOST_BEFORE, HOST_AFTER,
      CLIENT_FIELD_BEFORE, CLIENT_FIELD_AFTER,
      CLIENT_FALLBACK_BEFORE, CLIENT_FALLBACK_AFTER,
    ]) expect(PATCH_TEXT).toContain(hunk)
    // Exactly the three absent-value defaults change; no explicit value is rewritten.
    expect(PATCH_TEXT.match(/^\+.*enabled/gmu) ?? []).toHaveLength(3)
    expect(PATCH_TEXT.match(/^-.*enabled/gmu) ?? []).toHaveLength(3)
  })

  it('registers the patch for installs and lockfile reconciliation', () => {
    expect(readFileSync(join(PROFILE, 'pnpm-workspace.yaml'), 'utf8')).toContain(
      `'@linxin666/dsh-client-ui-skin-center@0.3.21': ${PATCH_REL}`,
    )
    expect(readFileSync(join(PROFILE, 'pnpm-lock.yaml'), 'utf8')).toContain(
      "'@linxin666/dsh-client-ui-skin-center@0.3.21(patch_hash=",
    )
  })

  it('applies to the installed skin-center copy and leaves the flipped defaults effective', () => {
    if (!existsSync(PACKAGE_DIR)) return
    const patch = patchBinary()
    if (patch === undefined) return
    const tmp = mkdtempSync(join(tmpdir(), 'skin-center-patch-'))
    try {
      const pkg = join(tmp, 'pkg')
      cpSync(PACKAGE_DIR, pkg, { recursive: true, dereference: true })
      const run = (extra: readonly string[]) => spawnSync(patch, ['-p1', '--batch', '--forward', '--silent', ...extra], {
        cwd: pkg, input: PATCH_TEXT, encoding: 'utf8',
      })
      if (run(['--dry-run']).status === 0) {
        const applied = run([])
        expect(applied.status, applied.stderr).toBe(0)
      } else {
        // An already-patched install (pnpm applied it) answers the reverse dry-run.
        const reverse = run(['--dry-run', '-R'])
        expect(reverse.status, reverse.stderr).toBe(0)
      }
      expect(readFileSync(join(pkg, 'lib/index.js'), 'utf8')).toContain(HOST_AFTER.slice(1))
      expect(readFileSync(join(pkg, 'lib/client.js'), 'utf8')).toContain(CLIENT_FIELD_AFTER.slice(1))
      expect(readFileSync(join(pkg, 'lib/client.js'), 'utf8')).toContain(CLIENT_FALLBACK_AFTER.slice(1))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('ships no executable payload or install script in the skin center', () => {
    if (!existsSync(PACKAGE_DIR)) return
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.bin).toBeUndefined()
    expect(manifest.optionalDependencies).toBeUndefined()
    const scripts = (manifest.scripts ?? {}) as Record<string, string>
    for (const lifecycle of ['preinstall', 'install', 'postinstall']) expect(scripts[lifecycle]).toBeUndefined()
    const binaries = (readdirSync(PACKAGE_DIR, { recursive: true }) as string[])
      .filter(entry => /\.(?:exe|dll|so|dylib|node|msi|dmg)$/i.test(entry))
    expect(binaries).toEqual([])
  })
})
