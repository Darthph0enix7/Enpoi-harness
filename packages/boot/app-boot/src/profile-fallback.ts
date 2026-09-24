/**
 * Profile fallback reconciliation after a package manager mutates a profile.
 *
 * `pnpm install` (and any other manager run inside the profile directory)
 * rebuilds the profile's `node_modules` from its lockfile and drops the
 * app-boot-managed fallback links, because those carry packages the profile
 * manifest does not depend on directly (bundle-carried and installation
 * closure packages). An import that needs one of them then fails until the
 * next launcher repair. {@link checkProfileBundleResolution} is the
 * check-and-repair entry point a diagnostic command can call;
 * {@link createProfileFallbackInclude} installs the root include whose failed
 * imports are repaired once per package per process and retried.
 * @module @deepseek-ai/dsh-app-boot/profile-fallback
 */

import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { PROFILE_MODULE_FALLBACK_DIR } from './profile-resolution/legacy-links.ts'
import { barePackageName } from './profile-resolution/resolver.ts'
import {
  auditProfileModuleFallback,
  healIsolatedProfileModuleFallback,
  healProfilesModuleFallback,
  PROFILES_DIR,
  PROFILE_PATCH_FILENAME,
  readProfileManifest,
  resolveBundleDir,
  type Profile,
  type ProfileLayer,
} from './profile.ts'

/** Profile locations shared by the fallback check and the import guard. */
export interface ProfileFallbackLocation {
  /** Diagnostic prefix on profile manifest errors; defaults to `dsh`. */
  binName?: string
  /** Absolute package.json path of the running dsh installation. */
  installAnchor: string
  /** Profile directory whose configured bundles are verified. */
  profileDir: string
  /** Harness home; defaults to `resolveDshHome`. */
  home?: string
}

/** Options for {@link checkProfileBundleResolution}. */
export interface ProfileBundleCheckOptions extends ProfileFallbackLocation {
  /** Whether a first failure heals before the second pass; defaults to true. */
  repair?: boolean
}

/** Result of verifying a profile's configured bundles and their fallback packages. */
export interface ProfileBundleResolution {
  /** Configured bundle packages and carried packages the check examined. */
  checked: number
  /** Entries the repair pass restored. */
  repaired: number
  /** Configured names still unresolved after the check. */
  missing: string[]
}

/** Options for the root-include fallback guard. */
export interface ProfileFallbackGuardOptions extends ProfileFallbackLocation {
  /** Per-process healed-package set; defaults to one process-wide set. */
  healed?: Set<string>
}

/** Package names this process already repaired through the import guard. */
const healedFallbackImports = new Set<string>()

/** Return whether `dir` is a named profile under `$home/profiles`, the launcher-owned layout. */
function isApplicationOwnedProfile(profileDir: string, home: string): boolean {
  return dirname(resolve(profileDir)) !== join(resolve(home), PROFILES_DIR)
}

/** Return whether this profile already carried fallback state worth keeping complete. */
function hasFallbackState(home: string, profileDir: string): boolean {
  return existsSync(join(home, PROFILES_DIR, 'node_modules'))
    || existsSync(join(profileDir, PROFILE_MODULE_FALLBACK_DIR, 'node_modules'))
}

/** Return whether a failed import can be caused by a pruned fallback link. */
function isModuleResolutionFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND'
}

/** Read a thrown value for one diagnostic line. */
function errorText(error: unknown): string {
  /* v8 ignore next -- loader and filesystem rejections are always Error instances */
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the configured bundles with every bundle that resolves from the
 * installation anchor or the profile directory; an unresolved bundle cannot
 * anchor fallback discovery but stays reportable by name.
 */
function readProfileForFallback(
  binName: string, profileDir: string, installAnchor: string,
): { profile: Profile; unresolved: string[] } {
  const manifest = readProfileManifest(binName, profileDir)
  const unresolved: string[] = []
  const layers: ProfileLayer[] = []
  for (const packageName of manifest.dsh?.profile?.bundles ?? []) {
    try {
      const packageDir = resolveBundleDir(binName, packageName, installAnchor, profileDir)
      // Fallback discovery reads only packageName and packageDir; the layer's
      // patch fields stay unread and are placeholders for the Profile type.
      layers.push({ packageName, packageDir, patchPath: join(packageDir, PROFILE_PATCH_FILENAME), patches: [] })
    } catch {
      // A bundle missing from both anchors is a reportable gap, not a fallback target.
      unresolved.push(packageName)
    }
  }
  return {
    profile: {
      name: basename(profileDir),
      dir: profileDir,
      layers,
      patchPath: join(profileDir, PROFILE_PATCH_FILENAME),
      patches: [],
    },
    unresolved,
  }
}

/** Repair one profile's fallback state with the backend that owns its layout. */
async function repairProfileFallback(
  location: Required<ProfileFallbackLocation>,
  profile: Profile,
): Promise<void> {
  if (isApplicationOwnedProfile(location.profileDir, location.home)) {
    healIsolatedProfileModuleFallback({ installAnchor: location.installAnchor, profile })
    return
  }
  await healProfilesModuleFallback({
    installAnchor: location.installAnchor,
    profile,
    home: location.home,
  })
}

/**
 * Verify the configured bundles and the fallback packages the computed
 * generation carries, heal missing state once, and report what remains.
 *
 * A configured bundle must resolve from the installation anchor or the
 * profile directory. When the profile already carries materialized fallback
 * state, every package of the computed generation must also resolve from the
 * profile directory through its own `node_modules` or the shared fallback, so
 * a pruned link is reported by name. A profile with no fallback state — a
 * runtime-resolution install — examines only its bundles and never writes links.
 * @param options - installation anchor, profile directory, Harness home, and whether to repair.
 * @returns the examined count, the entries the repair restored, and the names still unresolved.
 */
export async function checkProfileBundleResolution(
  options: ProfileBundleCheckOptions,
): Promise<ProfileBundleResolution> {
  const { binName = 'dsh', installAnchor, profileDir, home = resolveDshHome(), repair = true } = options
  const evaluate = (): { checked: number; missing: string[] } => {
    const { profile, unresolved } = readProfileForFallback(binName, profileDir, installAnchor)
    let checked = profile.layers.length + unresolved.length
    const missing = new Set(unresolved)
    if (hasFallbackState(home, profileDir)) {
      const audit = auditProfileModuleFallback({ installAnchor, profile, home })
      checked += audit.checked
      for (const name of audit.missing) missing.add(name)
    }
    return { checked, missing: [...missing] }
  }
  const before = evaluate()
  if (!repair || before.missing.length === 0) {
    return { checked: before.checked, repaired: 0, missing: before.missing }
  }
  const profile = readProfileForFallback(binName, profileDir, installAnchor).profile
  await repairProfileFallback({ binName, installAnchor, profileDir, home }, profile)
  const after = evaluate()
  return {
    checked: after.checked,
    repaired: before.missing.filter(name => !after.missing.includes(name)).length,
    missing: after.missing,
  }
}

/**
 * Build the root include class: import failures caused by a missing package
 * repair the profile fallback once per package, then retry the import once;
 * every other failure and every later repeat is rethrown untouched.
 * @param options - profile locations for the repair; omit it for an unguarded include.
 * @param bareModuleBaseUrl - optional installed-host base for bare package names.
 * @returns the include class to register as the `cordis:include` builtin.
 */
export function createProfileFallbackInclude(
  options: ProfileFallbackGuardOptions | undefined,
  bareModuleBaseUrl?: string,
): typeof Include {
  return class ProfileFallbackInclude extends Include {
    private closing = false

    constructor(ctx: Context, config: Include.Config) {
      super(ctx, config)
      // Teardown must never write links into a profile another process is
      // already taking over; disposal flips this before any late import.
      ctx.effect(() => () => { this.closing = true }, 'profile fallback link guard')
    }

    override async import(name: string, getOuterStack?: () => string[]): Promise<unknown> {
      try {
        return await this.load(name, getOuterStack)
      } catch (error) {
        if (options === undefined) throw error
        const {
          binName = 'dsh', installAnchor, profileDir, home = resolveDshHome(), healed = healedFallbackImports,
        } = options
        const bundle = barePackageName(name)
        if (this.closing || bundle === undefined || !isModuleResolutionFailure(error) || healed.has(bundle)) {
          throw error
        }
        const profile = readProfileForFallback(binName, profileDir, installAnchor).profile
        const before = auditProfileModuleFallback({ installAnchor, profile, home }).missing
        // A name outside the fallback generation (a typo or a genuinely
        // uninstalled plugin) is not repaired; only a registered package the
        // profile cannot resolve pays for one repair attempt.
        if (!before.includes(bundle)) throw error
        healed.add(bundle)
        const location = { binName, installAnchor, profileDir, home }
        try {
          await repairProfileFallback(location, profile)
        } catch (repairError) {
          this.ctx.logger.warn(`profile-heal: retry failed: ${errorText(repairError)}`)
          throw repairError
        }
        const after = auditProfileModuleFallback({ installAnchor, profile, home }).missing
        const repaired = before.filter(packageName => !after.includes(packageName)).length
        this.ctx.logger.info(`profile-heal: repaired ${repaired} links; retrying ${bundle}`)
        try {
          return await this.load(name, getOuterStack)
        } catch (retryError) {
          this.ctx.logger.warn(`profile-heal: retry failed: ${errorText(retryError)}`)
          throw retryError
        }
      }
    }

    /** Import through the loader internals, preserving the host-resolved bare-name anchor. */
    private load(name: string, getOuterStack?: () => string[]): unknown {
      if (bareModuleBaseUrl === undefined || name.startsWith('.') || name.startsWith('cordis:')) {
        return super.import(name, getOuterStack)
      }
      const specifier = isAbsolute(name) ? pathToFileURL(name).href : name
      const internal = this.ctx.loader.internal
      /* v8 ignore next -- every Loader service exposes the internal loader */
      if (internal === undefined) return super.import(specifier, getOuterStack)
      return internal.import(specifier, bareModuleBaseUrl, {})
    }
  }
}
