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

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { HeavyJobManager } from './jobs.js'
import { manifestProblems } from './manifests.js'
import { substitute, type CredentialsSeam, type FetchLike, type ModelDiscoverySeam, type SettingsSeam, type StepOutcome } from './planner.js'
import { HeavyProvidersService } from './remote.js'
import type { HeavyStep } from './manifests.js'

/** Cordis plugin name. */
export const name = 'enpoi-heavy-providers'

/** Optional-only seam reads: every capability is probed via `ctx.get`. */
export const inject: string[] = []

/**
 * Run one declared step through the subprocess seam. Bash executes the
 * declared command verbatim; the runner itself carries no per-provider logic.
 * @param ctx - plugin context holding the subprocess service.
 * @param step - the manifest step.
 * @param home - `{home}`/`{config}` placeholder base.
 * @param dshHome - `{dshHome}` placeholder base (the real `$DSH_HOME`).
 * @returns the exit code and bounded output tail.
 */
async function runStep(ctx: Context, step: HeavyStep, home: string, dshHome: string): Promise<StepOutcome> {
  const subprocess = ctx.get('subprocess') as SubprocessRuntime | undefined
  if (subprocess === undefined) throw new Error('subprocess seam absent — cannot run install steps')
  try {
    const handle = subprocess.spawn({
      argv: ['/bin/bash', '-lc', substitute(step.command, home, dshHome)],
      cwd: step.cwd === undefined ? home : substitute(step.cwd, home, dshHome),
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
 */
export function apply(ctx: Context): void {
  const logger = ctx.logger('enpoi-heavy-providers')
  const home = process.env.HOME ?? homedir()
  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(home, '.dsh')
  const problems = manifestProblems()
  if (problems.length > 0) {
    for (const problem of problems) logger.warn(`[enpoi-heavy-providers] ${problem}`)
  }
  const jobs = new HeavyJobManager({
    dir: join(dshHome, 'cache', 'heavy-jobs'),
    run: step => runStep(ctx, step, home, dshHome),
  })
  new HeavyProvidersService(ctx, {
    deps: () => ({
      home,
      dshHome,
      settings: ctx.get('settings') as SettingsSeam | undefined,
      credentials: ctx.get('credentials') as CredentialsSeam | undefined,
      llm: ctx.get('llm') as ModelDiscoverySeam | undefined,
      fetchImpl: globalThis.fetch as unknown as FetchLike,
      runStep: step => runStep(ctx, step, home, dshHome),
    }),
    jobs,
    log: line => logger.info(`[enpoi-heavy-providers] ${line}`),
  })
}
