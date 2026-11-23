/**
 * Owned per-test environment: home, harness home, memory database, XDG roots,
 * temp roots, and every ambient `DSH_WIRE_*` value are saved, isolated, and
 * restored after the caller has drained fire-and-forget diagnostics.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WIRE_PREFIX = 'DSH_WIRE_'
const OWNED_KEYS = [
  'HOME',
  'USERPROFILE',
  'DSH_HOME',
  'DSH_MEMORY_DB',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
] as const

/** One owned environment tree plus the function that restores the caller's ambient values. */
export interface IsolatedTestEnvironment {
  /** Root containing every owned path. */
  readonly root: string
  /** Temporary home used for both `HOME` and `USERPROFILE`. */
  readonly home: string
  /** Temporary `TMPDIR`/`TEMP`/`TMP` root. */
  readonly tmp: string
  /** Default wire log directory under the owned harness home. */
  readonly logs: string
  /** Remove every current `DSH_WIRE_*` value; tests call it before setting their own. */
  clearWireEnvironment(): void
  /** Restore saved ambient values and remove the owned tree. */
  restore(): Promise<void>
}

/**
 * Create one owned environment and clear ambient wire settings.
 * @param prefix - temp-directory prefix identifying the owning spec.
 * @returns the owned paths, a wire-env clearer, and an async restorer.
 */
export async function createIsolatedTestEnvironment(prefix: string): Promise<IsolatedTestEnvironment> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  const logs = join(home, 'logs')
  await mkdir(home, { recursive: true })
  await mkdir(tmp, { recursive: true })

  const saved = new Map<string, string | undefined>()
  const remember = (key: string): void => {
    if (!saved.has(key)) saved.set(key, process.env[key])
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(WIRE_PREFIX)) remember(key)
  }
  for (const key of OWNED_KEYS) remember(key)

  const clearWireEnvironment = (): void => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(WIRE_PREFIX)) Reflect.deleteProperty(process.env, key)
    }
  }

  clearWireEnvironment()
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.DSH_HOME = home
  process.env.DSH_MEMORY_DB = join(root, 'memory.sqlite')
  process.env.XDG_CONFIG_HOME = join(root, 'xdg', 'config')
  process.env.XDG_CACHE_HOME = join(root, 'xdg', 'cache')
  process.env.XDG_DATA_HOME = join(root, 'xdg', 'data')
  process.env.XDG_STATE_HOME = join(root, 'xdg', 'state')
  process.env.TMPDIR = tmp
  process.env.TEMP = tmp
  process.env.TMP = tmp

  return {
    root,
    home,
    tmp,
    logs,
    clearWireEnvironment,
    restore: async (): Promise<void> => {
      // Drop keys this test introduced, then restore the exact ambient set.
      clearWireEnvironment()
      for (const [key, value] of saved) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    },
  }
}
