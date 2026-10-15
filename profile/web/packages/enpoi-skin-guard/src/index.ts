/**
 * Enpoi Skin Guard — enforces the frozen liquid-glass skin on every platform.
 *
 * `@linxin666/dsh-client-ui-skin-center` persists its selection in
 * `$DSH_HOME/skin-center-active.json` and writes `active: null` when its
 * catalog refresh momentarily misses the active skin (or the stock selection
 * is chosen), which reverts the theme to stock. This plugin runs inside the
 * harness web process and rewrites only a null selection back to the
 * configured skin; a deliberate switch to another skin is never overridden.
 * The operator's systemd `dsh-skin-guard.path` unit, where installed, stays
 * belt-and-braces; both are idempotent. Every failure path is swallowed so the
 * guard can never crash boot.
 *
 * @module dsh-enpoi-skin-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const name = 'enpoi-skin-guard'

/** No injected services: the guard only touches the state file and the clock. */
export const inject: string[] = []

/** Guard policy. */
export interface Config {
  /** Skin id restored when the state file's selection is null. */
  skin?: string
  /** Fallback poll cadence in milliseconds; watcher events are debounced faster. */
  pollMs?: number
}

/** The frozen skin; the env var mirrors `dsh-skin-guard.mjs`. */
const DEFAULT_SKIN = process.env.DSH_GUARD_SKIN ?? 'summer-liquid-glass'
const DEFAULT_POLL_MS = 30_000
/** Boot re-check: the skin center can write its selection shortly after mount. */
const RECHECK_DELAY_MS = 5_000
/** Watcher debounce: one state write may surface as several fs events. */
const DEBOUNCE_MS = 250

/** Schemastery validator for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  skin: Schema.string().default(DEFAULT_SKIN),
  pollMs: Schema.natural().default(DEFAULT_POLL_MS),
})

/**
 * The skin-center state file under the harness home.
 *
 * @returns `$DSH_HOME/skin-center-active.json`, falling back to `~/.dsh`.
 */
export function defaultStatePath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skin-center-active.json')
}

/**
 * Restore the configured skin when the state file's selection is null.
 *
 * Policy (mirrors `dsh-skin-guard.mjs`): a missing, unreadable, or unparseable
 * file is a no-op — a fresh install seeds its own default. A parsed document
 * that is not a plain object (an array included) is a no-op. A selection that is neither `null` nor
 * `undefined` is an explicit choice and is never overridden, including a
 * different skin. Otherwise `active` is set to `skin`, `initialized` to
 * `true`, every other key is preserved verbatim, and the file is replaced
 * atomically (same-directory temp file + rename).
 *
 * @param statePath - Absolute path of `skin-center-active.json`.
 * @param skin - Skin id written into `active` when the selection is null.
 * @returns `true` when the file was rewritten; `false` on every no-op or failure.
 */
export function restoreIfNull(statePath: string, skin: string): boolean {
  let doc: unknown
  try {
    doc = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    // Missing or unparseable state: nothing to guard.
    return false
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return false
  const record = doc as Record<string, unknown>
  if (record.active !== null && record.active !== undefined) return false
  record.active = skin
  record.initialized = true
  try {
    const tmp = `${statePath}.guard-${process.pid}`
    mkdirSync(dirname(statePath), { recursive: true })
    // 'w' (not 'wx'): a stale artifact left by a crashed predecessor with the same pid is overwritten, never blocking the restore.
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    renameSync(tmp, statePath)
  } catch (error) {
    console.warn(`[enpoi-skin-guard] restore write failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  console.log(`[enpoi-skin-guard] restored active skin to ${skin}`)
  return true
}

/**
 * Mount the guard in the harness process.
 *
 * Runs {@link restoreIfNull} once at mount, again after a short delay, on
 * debounced directory-watch events for the state file, and on a periodic
 * unref'd poll as fallback. A `dispose` listener clears the timers and closes
 * the watcher.
 *
 * @param ctx - Plugin context; the `dispose` listener releases guard resources.
 * @param config - {@link Config}; schema defaults apply when omitted.
 * @returns Nothing; no failure path throws.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const skin = config.skin ?? DEFAULT_SKIN
  const pollMs = config.pollMs ?? DEFAULT_POLL_MS
  const statePath = defaultStatePath()
  const stateDir = dirname(statePath)
  const stateName = basename(statePath)

  console.log(`[enpoi-skin-guard] mounted (state=${statePath}, skin=${skin})`)

  // Mount pass: covers boot, before any watcher or poll fires.
  restoreIfNull(statePath, skin)

  // Delayed re-check: the skin center can write its own selection after the
  // watch is up but before the user interacts; one extra pass bounds that gap.
  const recheck = setTimeout(() => restoreIfNull(statePath, skin), RECHECK_DELAY_MS)
  recheck.unref()

  // Directory watch: the state file may not exist yet, and writers replace it
  // via rename — watching the directory survives both. `filename === null`
  // (platform without filename reporting) re-checks unconditionally.
  let watcher: FSWatcher | undefined
  let debounce: NodeJS.Timeout | undefined
  try {
    watcher = watch(stateDir, { persistent: false }, (_event, filename) => {
      if (filename !== null && filename !== stateName) return
      if (debounce !== undefined) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = undefined
        restoreIfNull(statePath, skin)
      }, DEBOUNCE_MS)
      debounce.unref()
    })
    watcher.on('error', (error) => {
      // Watcher failure is non-fatal: the poll below keeps enforcing.
      console.warn(`[enpoi-skin-guard] watcher error: ${error.message}`)
    })
  } catch (error) {
    // The state directory can be absent at mount; the poll still restores.
    console.warn(`[enpoi-skin-guard] watch unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Poll fallback: bounds the stock-revert window wherever fs.watch is
  // unreliable (network filesystems, some editors' rename patterns).
  const poll = setInterval(() => restoreIfNull(statePath, skin), pollMs)
  poll.unref()

  ctx.on('dispose', () => {
    clearTimeout(recheck)
    if (debounce !== undefined) clearTimeout(debounce)
    clearInterval(poll)
    watcher?.close()
  })
}
