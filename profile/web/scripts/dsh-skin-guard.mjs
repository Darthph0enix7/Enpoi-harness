#!/usr/bin/env node
/**
 * Skin guard — keeps the Enpoi Harness on its liquid-glass skin.
 *
 * Why this exists: @linxin666/dsh-client-ui-skin-center persists "stock look"
 * as `active: null` in ~/.dsh/skin-center-active.json and offers no
 * configurable default skin, so any runtime write of an explicit null (the
 * UI's stock/default selection, or its fallback when a catalog refresh
 * momentarily misses the active skin) permanently reverts the theme. This
 * guard restores the configured skin ONLY when the selection is null — a
 * deliberate switch to a different skin is never overridden.
 *
 * Wired as: dsh-skin-guard.path (watches the state file) + ExecStartPre on
 * dsh-web.service (covers boot).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const SKIN = process.env.DSH_GUARD_SKIN ?? 'summer-liquid-glass'
const STATE = join(homedir(), '.dsh', 'skin-center-active.json')

function main() {
  let doc
  try {
    doc = JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    // No state file yet: nothing to guard (a fresh install seeds its own default).
    return
  }
  if (typeof doc !== 'object' || doc === null) return
  if (doc.active !== null && doc.active !== undefined) return   // explicit choice → leave it
  doc.active = SKIN
  doc.initialized = true
  const tmp = `${STATE}.guard-${process.pid}`
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  renameSync(tmp, STATE)
  console.log(`[skin-guard] restored active skin to ${SKIN}`)
}

main()
