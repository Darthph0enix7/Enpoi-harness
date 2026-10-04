#!/usr/bin/env node
/**
 * dsh-sync-merge.mjs — settings.yaml merge engine for `ds sync` / `ds pull`.
 *
 * The Enpoi Harness dotfiles sync keeps ONE global baseline (repo
 * settings.yaml) plus per-device patches (device-patches/<hostname>.yaml)
 * and a device-local override file (~/.dsh/sync-local.yaml, NEVER synced).
 *
 * Device-specific sections (enpoi-orchestration.mcpServers,
 * enpoi-orchestration.capabilities) never live in the baseline — they are
 * extracted into the device patch on sync and merged back on pull.
 * enpoi-orchestration.mcpStatus is pure runtime state: preserved on pull,
 * stripped on sync, never committed.
 *
 * Commands:
 *   merge   <baseline> <patch> <sync-local> <out>   — pull: baseline + patch + local overrides
 *   strip   <local> <baseline> <sync-local> <out>   — sync: local minus patch minus local overrides
 *   extract <local> <baseline> <sync-local> <out>   — sync: compute device-patches/<hostname>.yaml
 *
 * js-yaml is resolved from the harness install (guaranteed on every device
 * that runs the harness). Falls back to PyYAML via a python3 subprocess if
 * js-yaml cannot be located.
 */

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const HOME = homedir()

/** Sections that are device-specific and never live in the baseline. */
const DEVICE_SECTIONS = ['enpoi-orchestration.mcpServers', 'enpoi-orchestration.capabilities']
/** Runtime state — preserved on pull, stripped on sync, never committed. */
const RUNTIME_KEYS = ['enpoi-orchestration.mcpStatus']

// ── js-yaml resolution ──────────────────────────────────────────────────────

function resolveJsYaml() {
  const candidates = [
    process.env.DSH_REPO ? join(process.env.DSH_REPO, 'node_modules/js-yaml') : null,
    join(HOME, 'deepseek-harness/node_modules/js-yaml'),
    join(HOME, '.dsh/profiles/web/node_modules/js-yaml'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (existsSync(join(p, 'package.json'))) return p
  }
  // Walk up from the dsh binary real path.
  try {
    const bin = join(HOME, '.local/bin/dsh')
    if (existsSync(bin)) {
      const real = execFileSync('readlink', ['-f', bin], { encoding: 'utf8' }).trim()
      let dir = dirname(real)
      while (dir !== '/') {
        const p = join(dir, 'node_modules/js-yaml')
        if (existsSync(join(p, 'package.json'))) return p
        dir = dirname(dir)
      }
    }
  } catch {
    /* fall through */
  }
  return null
}

const jsYamlPath = resolveJsYaml()
let yaml
if (jsYamlPath !== null) {
  const require = createRequire(import.meta.url)
  yaml = require(jsYamlPath)
} else {
  // Fallback: PyYAML via python3 (serverlocal has it; other devices may not).
  yaml = {
    parse: (text) => JSON.parse(execFileSync('python3', ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.stdin.read())))'], { input: text, encoding: 'utf8' }) || 'null'),
    stringify: (obj) => execFileSync('python3', ['-c', 'import sys,yaml,json; print(yaml.safe_dump(json.load(sys.stdin.read()), sort_keys=False, default_flow_style=False))'], { input: JSON.stringify(obj), encoding: 'utf8' }),
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function readYaml(path) {
  if (!existsSync(path)) return {}
  try {
    const parsed = yaml.load(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    console.error(`dsh-sync-merge: cannot parse ${path}: ${error.message}`)
    process.exit(2)
  }
}

function writeYaml(path, obj) {
  writeFileSync(path, yaml.dump(obj))
}

function deepMerge(target, source) {
  if (source === null || source === undefined) return target
  if (typeof source !== 'object' || Array.isArray(source)) return source
  const out = { ...target }
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object' && out[key] !== null && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out
}

function getPath(obj, dotted) {
  let cur = obj
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[part]
  }
  return cur
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

function deletePath(obj, dotted) {
  const parts = dotted.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) return
    cur = cur[parts[i]]
  }
  delete cur[parts[parts.length - 1]]
}

/** Apply a device patch {merge, remove, preserve} onto a target object. */
function applyPatch(target, patch) {
  if (patch?.merge && typeof patch.merge === 'object') {
    for (const [section, value] of Object.entries(patch.merge)) {
      if (typeof value === 'object' && value !== null) {
        const existing = getPath(target, section)
        setPath(target, section, deepMerge(existing ?? {}, value))
      }
    }
  }
  if (patch?.remove && typeof patch.remove === 'object') {
    for (const [section, keys] of Object.entries(patch.remove)) {
      if (!Array.isArray(keys)) continue
      const existing = getPath(target, section)
      if (existing && typeof existing === 'object') {
        for (const key of keys) delete existing[key]
      }
    }
  }
  return target
}

/** Reverse a device patch: remove merged keys, re-add removed keys from base. */
function reversePatch(local, base, patch) {
  const out = structuredClone(local)
  if (patch?.merge && typeof patch.merge === 'object') {
    for (const [section, value] of Object.entries(patch.merge)) {
      if (typeof value !== 'object' || value === null) continue
      const existing = getPath(out, section)
      if (existing && typeof existing === 'object') {
        for (const key of Object.keys(value)) delete existing[key]
      }
    }
  }
  if (patch?.remove && typeof patch.remove === 'object') {
    for (const [section, keys] of Object.entries(patch.remove)) {
      if (!Array.isArray(keys)) continue
      const baseVal = getPath(base, section)
      if (baseVal && typeof baseVal === 'object') {
        const existing = getPath(out, section)
        const target = existing && typeof existing === 'object' ? existing : {}
        for (const key of keys) {
          if (key in baseVal) target[key] = structuredClone(baseVal[key])
        }
        setPath(out, section, target)
      }
    }
  }
  return out
}

/** Compute the device patch from local vs baseline (device sections only). */
function extractPatch(local, base, syncLocal) {
  const patch = {}
  const excluded = new Set(syncLocal?.exclude?.enpoiOrchestration?.mcpServers ?? [])
  const excludedCaps = new Set(syncLocal?.exclude?.enpoiOrchestration?.capabilities ?? [])

  for (const section of DEVICE_SECTIONS) {
    const localVal = getPath(local, section)
    const baseVal = getPath(base, section)
    const isCaps = section.endsWith('capabilities')
    const excludedSet = isCaps ? excludedCaps : excluded
    if (!localVal || typeof localVal !== 'object') continue
    const merge = {}
    const remove = []
    for (const [key, value] of Object.entries(localVal)) {
      if (excludedSet.has(key)) continue
      const baseEntry = baseVal?.[key]
      if (baseEntry === undefined) {
        merge[key] = structuredClone(value)
      } else if (JSON.stringify(baseEntry) !== JSON.stringify(value)) {
        merge[key] = structuredClone(value)
      }
    }
    if (baseVal && typeof baseVal === 'object') {
      for (const key of Object.keys(baseVal)) {
        if (excludedSet.has(key)) continue
        if (!(key in localVal)) remove.push(key)
      }
    }
    if (Object.keys(merge).length > 0) {
      patch.merge ??= {}
      patch.merge[section] = merge
    }
    if (remove.length > 0) {
      patch.remove ??= {}
      patch.remove[section] = remove
    }
  }
  return patch
}

// ── commands ────────────────────────────────────────────────────────────────

function cmdMerge(baselinePath, patchPath, syncLocalPath, outPath) {
  const baseline = readYaml(baselinePath)
  const patch = readYaml(patchPath)
  const syncLocal = readYaml(syncLocalPath)

  // 1. Preserve local runtime state (mcpStatus) before overwriting.
  const local = existsSync(outPath) ? readYaml(outPath) : {}
  const preserved = {}
  for (const key of RUNTIME_KEYS) {
    const v = getPath(local, key)
    if (v !== undefined) preserved[key] = v
  }

  // 2. Baseline + device patch.
  const merged = applyPatch(structuredClone(baseline), patch)

  // 3. sync-local exclusions (delete keys the device doesn't want).
  const excludes = syncLocal?.exclude?.enpoiOrchestration
  if (excludes) {
    for (const [section, keys] of Object.entries(excludes)) {
      if (!Array.isArray(keys)) continue
      const dotted = `enpoi-orchestration.${section}`
      const existing = getPath(merged, dotted)
      if (existing && typeof existing === 'object') {
        for (const key of keys) delete existing[key]
      }
    }
  }

  // 4. sync-local overrides (highest precedence).
  if (syncLocal?.override && typeof syncLocal.override === 'object') {
    for (const [section, value] of Object.entries(syncLocal.override)) {
      if (typeof value === 'object' && value !== null) {
        const existing = getPath(merged, section)
        setPath(merged, section, deepMerge(existing ?? {}, value))
      }
    }
  }

  // 5. Restore preserved runtime state.
  for (const [key, value] of Object.entries(preserved)) {
    setPath(merged, key, value)
  }

  writeYaml(outPath, merged)
  console.log(`merged: ${outPath}`)
}

/** Delete only the LEAF keys an override touches (never whole sections). */
function deleteLeaves(target, override) {
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (target[key] && typeof target[key] === 'object') {
        deleteLeaves(target[key], value)
      }
    } else {
      delete target[key]
    }
  }
}

function cmdStrip(localPath, baselinePath, syncLocalPath, outPath) {
  const local = readYaml(localPath)
  const baseline = readYaml(baselinePath)
  const syncLocal = readYaml(syncLocalPath)

  // 1. Reverse the device patch (computed from local vs baseline).
  const patch = extractPatch(local, baseline, syncLocal)
  let out = reversePatch(local, baseline, patch)

  // 2. Drop device-specific sections entirely (they live in the patch).
  for (const section of DEVICE_SECTIONS) deletePath(out, section)

  // 3. Drop runtime state.
  for (const key of RUNTIME_KEYS) deletePath(out, key)

  // 4. Drop sync-local override LEAVES (device-local values never commit).
  if (syncLocal?.override && typeof syncLocal.override === 'object') {
    for (const [section, value] of Object.entries(syncLocal.override)) {
      if (typeof value !== 'object' || value === null) continue
      const existing = getPath(out, section)
      if (existing && typeof existing === 'object') deleteLeaves(existing, value)
    }
  }

  // 5. Re-add sync-local excluded keys from the current baseline so the
  //    baseline never loses entries a device deliberately excludes.
  const excludes = syncLocal?.exclude?.enpoiOrchestration
  if (excludes) {
    for (const [section, keys] of Object.entries(excludes)) {
      if (!Array.isArray(keys)) continue
      const dotted = `enpoi-orchestration.${section}`
      const baseVal = getPath(baseline, dotted)
      if (baseVal && typeof baseVal === 'object') {
        const existing = getPath(out, dotted)
        const target = existing && typeof existing === 'object' ? existing : {}
        for (const key of keys) {
          if (key in baseVal) target[key] = structuredClone(baseVal[key])
        }
        setPath(out, dotted, target)
      }
    }
  }

  writeYaml(outPath, out)
  console.log(`stripped: ${outPath}`)
}

function cmdExtract(localPath, baselinePath, syncLocalPath, outPath) {
  const local = readYaml(localPath)
  const baseline = readYaml(baselinePath)
  const syncLocal = readYaml(syncLocalPath)
  const patch = extractPatch(local, baseline, syncLocal)
  if (Object.keys(patch).length === 0) {
    console.log('extract: no device-specific deltas')
    return
  }
  writeYaml(outPath, patch)
  console.log(`extracted: ${outPath}`)
}

// ── main ────────────────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2)
switch (cmd) {
  case 'merge':
    if (args.length !== 4) { console.error('usage: merge <baseline> <patch> <sync-local> <out>'); process.exit(1) }
    cmdMerge(...args)
    break
  case 'strip':
    if (args.length !== 4) { console.error('usage: strip <local> <baseline> <sync-local> <out>'); process.exit(1) }
    cmdStrip(...args)
    break
  case 'extract':
    if (args.length !== 4) { console.error('usage: extract <local> <baseline> <sync-local> <out>'); process.exit(1) }
    cmdExtract(...args)
    break
  default:
    console.error('unknown command: ' + cmd)
    process.exit(1)
}