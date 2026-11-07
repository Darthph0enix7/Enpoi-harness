/**
 * enpoi-heavy-providers — the HEAVY provider class for the Enpoi Harness web
 * profile (recon: `~/dsh-migration/evidence/heavy-providers/`).
 *
 * Heavy providers are listed in Add Provider but install nothing by default.
 * Adding one either uses an instance detection found running on this device
 * (zero install) or starts a polled local install job; the route and
 * credential are written only after the probe/install succeeds. Removal runs
 * the manifest teardown plus route/credential/pool-state/cache/chain cleanup.
 * Everything fail-soft: an absent subprocess or settings seam degrades one
 * operation, never the boot. Operator-specific endpoints live in the private
 * `$DSH_HOME/heavy-server-overlay.json`, never in the shipped manifests.
 *
 * @module dsh-enpoi-heavy-providers
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
// Type-only: the webserver event map for the page-bootstrap injection below.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { HeavyJobManager } from './jobs.js'
import { HEAVY_ENV, manifestProblems } from './manifests.js'
import { overlayInjectionRow, substitute, type CredentialsSeam, type FetchLike, type ModelDiscoverySeam, type SettingsSeam, type StepOutcome } from './planner.js'
import { HeavyProvidersService } from './remote.js'
import type { HeavyStep } from './manifests.js'

/** The profile helper's public surface, loaded from the running profile at runtime. */
type CliProxyHelper = typeof import('../scripts/cliproxyapi-install.mjs')

/**
 * Absolute path of this package's installer helper. Resolved from the plugin's
 * own module location, so it works from `src/` during tests and from the
 * bundled `lib/index.js` (both are one directory below the package root). The
 * web profile's `packages/` workspace layout is never assumed.
 */
export const INSTALL_HELPER_PATH = fileURLToPath(new URL('../scripts/cliproxyapi-install.mjs', import.meta.url))

/** One loaded helper module and the on-disk stamp it was imported from. */
interface CachedCliProxyHelper {
  stamp: string
  promise: Promise<CliProxyHelper>
}

/** Loaded helper promises, keyed by the helper's absolute path. */
const cliProxyHelpers = new Map<string, CachedCliProxyHelper>()

/** Cordis plugin name. */
export const name = 'enpoi-heavy-providers'

/** Optional-only seam reads: every capability is probed via `ctx.get`. */
export const inject: string[] = []

/** The only heavy provider whose host helper verifies a receipt and seeds a client key. */
const CLIPROXYAPI_ID = 'cliproxyapi'

/** Plugin configuration. */
export interface Config {
  /**
   * Explicit running profile root, for a launcher that cannot supply
   * `profileContext`. Relative manifest paths use this directory; no profile
   * layout is guessed when both this and the launcher value are absent.
   */
  profileDir?: string
}

/** Schemastery validator for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  profileDir: Schema.string(),
})

/**
 * The running profile root used to expand manifest paths. Only launcher-owned
 * `profileContext.dir` or an explicit plugin Config value is trusted; without
 * one, `{profileDir}` steps are refused instead of guessing a bundle layout.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @returns the absolute profile root, or undefined when no trusted value exists.
 */
function profileDirectory(ctx: Context, config: Config): string | undefined {
  const profile = ctx.get('profileContext') as { dir?: unknown } | undefined
  if (typeof profile?.dir === 'string' && profile.dir.trim() !== '') return profile.dir
  const configured = config.profileDir?.trim()
  if (configured === undefined || configured === '') return undefined
  // A relative value means different directories to statSync and to the shell
  // step (whose cwd is the user home), so it is refused instead of silently
  // expanding to the wrong place.
  if (!isAbsolute(configured)) {
    throw new Error(
      `enpoi-heavy-providers: config.profileDir must be an absolute path (got ${JSON.stringify(configured)});`
      + ' a relative value cannot be resolved consistently for the running profile.',
    )
  }
  return configured
}

/** Whether one step needs a running profile root substitution. */
function needsProfileDir(step: HeavyStep): boolean {
  return step.command.includes('{profileDir}')
    || step.command.includes('$DSH_HEAVY_PROFILE_DIR')
    || step.cwd?.includes('{profileDir}') === true
}

/**
 * Load the installer helper from the running profile, not from a copy bundled
 * into this plugin: the manifest executes that same file, so receipt checks
 * and service teardown always use one installer revision. The import URL is
 * stamped by the file's metadata so a replaced helper is re-imported without
 * restarting the host.
 * @param profileDir - running profile root.
 * @returns the helper module, cached for the current file stamp.
 */
async function loadCliProxyHelper(): Promise<CliProxyHelper> {
  const script = INSTALL_HELPER_PATH
  const info = statSync(script)
  const stamp = `${String(info.mtimeMs)}:${String(info.size)}:${String(info.ino)}`
  const cached = cliProxyHelpers.get(script)
  if (cached !== undefined && cached.stamp === stamp) return await cached.promise
  const pending: Promise<CliProxyHelper> = import(`${pathToFileURL(script).href}?stamp=${encodeURIComponent(stamp)}`)
  cliProxyHelpers.set(script, { stamp, promise: pending })
  try {
    return await pending
  } catch (error) {
    const current = cliProxyHelpers.get(script)
    if (current?.stamp === stamp) cliProxyHelpers.delete(script)
    throw error
  }
}

/** A plain JSON object from an owned installer file. */
function readOwnedRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** Lowercase SHA-256 hex for one stable owner token. */
function ownerTokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Whether the helper's own status proves the receipt no longer describes this
 * install: a config edited away from the receipt port, or config/bootstrap
 * files missing (`credentialsPresent === false`), must not read as a verified
 * install. Fields an older helper does not report stay undefined and are not
 * treated as failures.
 * @param status - the helper status view.
 * @returns true when ownership must be refused.
 */
export function installStatusRejectsOwnership(status: { portMismatch?: boolean; credentialsPresent?: boolean }): boolean {
  return status.portMismatch === true || status.credentialsPresent === false
}

/**
 * Read the CLIProxyAPI installer's verified ownership proof. The helper status
 * proves the receipt paths and binary/unit hashes; this host additionally
 * proves the private bootstrap owner token matches the receipt without reading
 * or returning the inference key. The credential itself never crosses this
 * callback.
 * @param dshHome - DSH home directory the installer writes under.
 * @returns the opaque install id when ownership is verified, else undefined.
 */
async function cliproxyapiReceipt(dshHome: string): Promise<string | undefined> {
  try {
    const helper = await loadCliProxyHelper()
    const status = await helper.statusCliProxyApi({ dshHome })
    if (status.installed !== true || status.binaryMatches !== true || status.unitMatches !== true) return undefined
    // The helper's own state proof is part of ownership: a config edited away
    // from the receipt port, or deleted credentials, must not read as a
    // verified install the harness may route to or tear down.
    if (installStatusRejectsOwnership(status)) return undefined
    if (status.installId === undefined || status.installId === '') return undefined
    const layout = helper.resolveCliProxyLayout({ dshHome })
    const receipt = readOwnedRecord(layout.receiptPath)
    const bootstrap = readOwnedRecord(layout.bootstrapPath)
    if (receipt === undefined || bootstrap === undefined) return undefined
    if (receipt.version !== helper.RECEIPT_VERSION || bootstrap.version !== helper.RECEIPT_VERSION) return undefined
    if (receipt.installId !== status.installId || bootstrap.installId !== receipt.installId) return undefined
    const expectedPaths: Readonly<Record<string, string>> = {
      root: layout.root,
      binaryPath: layout.binaryPath,
      configPath: layout.configPath,
      authDir: layout.authDir,
      bootstrapPath: layout.bootstrapPath,
      unitPath: layout.unitPath,
      serviceLabel: layout.serviceLabel,
      serviceKind: layout.serviceKind,
    }
    for (const [field, expected] of Object.entries(expectedPaths)) {
      if (receipt[field] !== expected) return undefined
    }
    const ownerToken = bootstrap.ownerToken
    const ownerTokenSha256 = receipt.ownerTokenSha256
    if (typeof ownerToken !== 'string' || !/^[a-f0-9]{64}$/u.test(ownerToken)) return undefined
    if (typeof ownerTokenSha256 !== 'string' || ownerTokenDigest(ownerToken) !== ownerTokenSha256) return undefined
    return status.installId
  } catch {
    return undefined
  }
}

/**
 * Read the installer-seeded client credential after a successful install. The
 * helper verifies the receipt and private owner token before returning it.
 * @param dshHome - DSH home directory the installer writes under.
 * @returns the inference key, or undefined when the owned state cannot prove it.
 */
async function cliproxyapiCredential(dshHome: string): Promise<string | undefined> {
  try {
    const helper = await loadCliProxyHelper()
    return await helper.readOwnedInferenceCredential(dshHome)
  } catch {
    return undefined
  }
}

/**
 * Secretless install paths for the dashboard hint: where the generated
 * bootstrap/management key lives. Never returns the key itself.
 * @param dshHome - DSH home directory the installer writes under.
 * @returns the paths, or undefined when the helper cannot resolve them.
 */
async function cliproxyapiInstallPaths(dshHome: string): Promise<{ bootstrapPath: string; managementKeyPath: string } | undefined> {
  try {
    const helper = await loadCliProxyHelper()
    const layout = helper.resolveCliProxyLayout({ dshHome })
    return { bootstrapPath: layout.bootstrapPath, managementKeyPath: layout.bootstrapPath }
  } catch {
    return undefined
  }
}

/**
 * Ask the installer helper's own port preflight when the helper exposes one.
 * A helper without the capability answers undefined (the runtime preflight
 * still applies); a refusal or a thrown check blocks the install before a job
 * exists.
 * @param dshHome - DSH home directory the installer writes under.
 * @returns the helper verdict, when it has one.
 */
async function cliproxyapiInstallPreflight(dshHome: string): Promise<{ ok: boolean; reason?: string } | undefined> {
  try {
    const helper = await loadCliProxyHelper()
    const candidate = (helper as unknown as Record<string, unknown>).preflightCliProxyApi
    if (typeof candidate !== 'function') return undefined
    const result: unknown = await (candidate as (options: { dshHome: string }) => unknown)({ dshHome })
    if (result === null || typeof result !== 'object') return { ok: true }
    const record = result as { ok?: unknown; reason?: unknown; error?: { message?: unknown } | undefined }
    if (record.ok !== false) return { ok: true }
    const reason = typeof record.reason === 'string' && record.reason !== ''
      ? record.reason
      : typeof record.error?.message === 'string' && record.error.message !== ''
        ? record.error.message
        : 'the CLIProxyAPI installer port preflight refused the install'
    return { ok: false, reason }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run one declared step through the subprocess seam. Bash executes the
 * declared command verbatim; the runner itself carries no per-provider logic.
 * @param ctx - plugin context holding the subprocess service.
 * @param step - the manifest step.
 * @param home - `{home}`/`{config}` placeholder base.
 * @param dshHome - `{dshHome}` placeholder base (the launcher-owned DSH home).
 * @param profileDir - `{profileDir}` placeholder base (the running profile root).
 * @returns the exit code and bounded output tail.
 * @throws before spawning when the step needs a profile root and none was supplied.
 */
async function runStep(ctx: Context, step: HeavyStep, home: string, dshHome: string, profileDir: string | undefined): Promise<StepOutcome> {
  if (profileDir === undefined && needsProfileDir(step)) {
    throw new Error(
      `Cannot run heavy-provider step "${step.label}": the running profile root is unknown.`
      + ' Start this profile through the dsh launcher so it supplies profileContext.dir,'
      + ' or set the enpoi-heavy-providers profileDir config explicitly;'
      + ' the command containing "{profileDir}" was not executed.',
    )
  }
  const subprocess = ctx.get('subprocess') as SubprocessRuntime | undefined
  if (subprocess === undefined) throw new Error('subprocess seam absent — cannot run install steps')
  try {
    const handle = subprocess.spawn({
      argv: ['/bin/bash', '-lc', substitute(step.command, home, dshHome, profileDir)],
      cwd: step.cwd === undefined ? home : substitute(step.cwd, home, dshHome, profileDir),
      // Host paths travel in the environment, never in the command text:
      // quoting a path is not enough when it can contain `$`, a backtick, or
      // a quote. Steps reference these as "$DSH_HEAVY_*".
      env: {
        [HEAVY_ENV.home]: home,
        [HEAVY_ENV.dshHome]: dshHome,
        [HEAVY_ENV.profileDir]: profileDir ?? '',
        [HEAVY_ENV.helper]: INSTALL_HELPER_PATH,
      },
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 65_536 },
        stderr: { maxBytes: 65_536 },
      },
      graceMs: 10_000,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return { exitCode: outcome.exitCode, output: `${stdout}${stderr}`.slice(-16_384) }
  } catch (error) {
    // The declared steps are POSIX shell; a host without /bin/bash (plain
    // Windows) must report that fact instead of a raw spawn error.
    throw new Error(
      `could not start (${error instanceof Error ? error.message : String(error)}).`
      + ' Heavy-provider install steps run as POSIX shell with /bin/bash — on Windows install Git Bash,'
      + ' or run the service manually and add it with "Use a detected instance".',
    )
  }
}

/**
 * Mount the heavy-provider service. A malformed manifest table is logged and
 * still served (the UI can display the problems); it never blocks the boot.
 * @param ctx - owning context.
 * @param config - plugin configuration; `profileDir` is only a fallback when
 *   the launcher did not supply `profileContext.dir`.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const logger = ctx.logger('enpoi-heavy-providers')
  // OS home placeholder bases come from the account, never a shell override.
  const home = homedir()
  // The launcher owns the managed install directory; DSH_HOME is not a second
  // authority once profileContext is present.
  const profile = ctx.get('profileContext') as { home?: unknown } | undefined
  const dshHome = typeof profile?.home === 'string' && profile.home !== ''
    ? profile.home
    : join(home, '.dsh')
  const profileDir = profileDirectory(ctx, config)
  const problems = manifestProblems()
  if (problems.length > 0) {
    for (const problem of problems) logger.warn(`[enpoi-heavy-providers] ${problem}`)
  }
  const jobs = new HeavyJobManager({
    dir: join(dshHome, 'cache', 'heavy-jobs'),
    run: step => runStep(ctx, step, home, dshHome, profileDir),
  })
  // The client's compiled fallback honors the same operator overlay the host
  // table uses: publish it as a page bootstrap global so the pre-connection
  // listing is operator-controllable before the first `enpoiHeavy.manifests`
  // reply. A profile without a webserver never emits this event.
  ctx.on('webserver/index-inject', (table) => {
    const row = overlayInjectionRow(dshHome)
    if (row !== undefined) table.push(row)
  })
  new HeavyProvidersService(ctx, {
    deps: () => ({
      home,
      dshHome,
      settings: ctx.get('settings') as SettingsSeam | undefined,
      credentials: ctx.get('credentials') as CredentialsSeam | undefined,
      llm: ctx.get('llm') as ModelDiscoverySeam | undefined,
      jobs,
      profileDir,
      // Only the local CLIProxyAPI install owns a receipt and a seeded key;
      // every other provider (and every detected instance) stays untrusted.
      installHelperPath: INSTALL_HELPER_PATH,
      readInstallReceipt: async id => id === CLIPROXYAPI_ID ? cliproxyapiReceipt(dshHome) : undefined,
      readInstallCredential: async id => id === CLIPROXYAPI_ID ? cliproxyapiCredential(dshHome) : undefined,
      readInstallPaths: async id => id === CLIPROXYAPI_ID ? cliproxyapiInstallPaths(dshHome) : undefined,
      installPreflight: async id => id === CLIPROXYAPI_ID ? cliproxyapiInstallPreflight(dshHome) : undefined,
      fetchImpl: globalThis.fetch as unknown as FetchLike,
      runStep: step => runStep(ctx, step, home, dshHome, profileDir),
    }),
    jobs,
    log: line => logger.info(`[enpoi-heavy-providers] ${line}`),
  })
}
