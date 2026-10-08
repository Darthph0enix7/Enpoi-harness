/**
 * Resolve the one-line release identity printed by `dsh --version`.
 *
 * A managed install reports the release recorded by the installer
 * (`harness/install-state.json`, falling back to the `harness/current` target)
 * because the package version alone cannot distinguish rolling builds. A
 * source checkout reports the package version marked as such, with the
 * repository's short commit when git is available.
 * @module @deepseek-ai/dsh/version-identity
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Installed-release fields read from `harness/install-state.json`. */
interface InstalledRelease {
  version?: string | undefined
  commit?: string | undefined
  channel?: string | undefined
}

/** Inputs for {@link resolveDshVersionLine}. */
export interface DshVersionLineOptions {
  /** Version carried by the running CLI package; the fallback when no release identity is available. */
  packageVersion: string
  /** Running CLI module URL; tests point it inside a fixture tree, production uses this module. */
  moduleUrl?: string | URL
  /** Resolved harness home; defaults to `resolveDshHome()`. */
  home?: string
}

/** Commit spelling in version lines, matching `git rev-parse --short=7`. */
const SHORT_COMMIT_LENGTH = 7

/** Timeout for the optional git lookup; a slow repository drops the commit rather than delaying `--version`. */
const GIT_TIMEOUT_MS = 2_000

/** A non-empty string field, or undefined for absent, blank, and non-string values. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Canonicalize `path`, tolerating absence so a fixture path still compares by spelling. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // `--version` must not fail on filesystem surprises; an unresolved path is still usable for comparison.
    return path
  }
}

/** Whether the running CLI module lives under the managed harness tree of `home`. */
function isManagedInstall(moduleFile: string, home: string): boolean {
  const harnessRoot = realpathOrSelf(join(home, 'harness'))
  const moduleDirectory = realpathOrSelf(dirname(moduleFile))
  return moduleDirectory === harnessRoot || moduleDirectory.startsWith(`${harnessRoot}${sep}`)
}

/** Read the installer's release record; a missing or malformed file yields no fields. */
function readInstallState(home: string): InstalledRelease {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(home, 'harness', 'install-state.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    return {
      version: stringField(record.version),
      commit: stringField(record.commit),
      channel: stringField(record.channel),
    }
  } catch {
    // Without the record, identity falls back to the current target and then the package version.
    return {}
  }
}

/** Read the version-named target of `harness/current`, or undefined when the symlink is absent. */
function readCurrentTarget(home: string): string | undefined {
  try {
    const target = readlinkSync(join(home, 'harness', 'current'))
    return target.trim().length > 0 ? basename(target) : undefined
  } catch {
    // A missing or non-symlink `current` only drops the version fallback.
    return undefined
  }
}

/** Resolve the repository's short commit for `directory`, or undefined outside a repository or without git. */
function gitShortCommit(directory: string): string | undefined {
  const result = spawnSync('git', ['-C', directory, 'rev-parse', `--short=${SHORT_COMMIT_LENGTH}`, 'HEAD'], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.error !== undefined || result.status !== 0) return undefined
  const commit = result.stdout.trim()
  return commit.length > 0 ? commit : undefined
}

/**
 * Describe the running dsh build in one line.
 * @param options - package version, running module URL, and resolved harness home.
 * @returns the installed release identity, or the package version marked as a source checkout.
 */
export function resolveDshVersionLine(options: DshVersionLineOptions): string {
  const home = options.home ?? resolveDshHome()
  const moduleFile = fileURLToPath(options.moduleUrl ?? import.meta.url)
  if (!isManagedInstall(moduleFile, home)) {
    const commit = gitShortCommit(dirname(moduleFile))
    return commit === undefined
      ? `${options.packageVersion} (source checkout)`
      : `${options.packageVersion} (source checkout, commit ${commit})`
  }
  const release = readInstallState(home)
  const version = release.version ?? readCurrentTarget(home) ?? options.packageVersion
  const qualifiers = [
    ...release.channel === undefined ? [] : [release.channel],
    ...release.commit === undefined ? [] : [`commit ${release.commit.slice(0, SHORT_COMMIT_LENGTH)}`],
  ]
  return qualifiers.length === 0 ? `${version} (installed)` : `${version} (${qualifiers.join(', ')})`
}
