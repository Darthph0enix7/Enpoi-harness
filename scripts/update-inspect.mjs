#!/usr/bin/env node
/**
 * Read-only update inspection for `ds update --dry-run`.
 *
 * Given the channel's newest published release, this reports exactly what a
 * dry run can know without downloading or applying anything:
 *
 *   - the ladder rung an apply would choose (1 consecutive diff, 2 diff chain
 *     of at most three hops, 3 full tarball) and the expected download bytes
 *     (diff-chain artifact sizes vs the full tarball);
 *   - changed files between the installed version's release manifest and the
 *     target release manifest (count + bounded list + raw changed bytes);
 *   - deletions that would be applied (present in the baseline manifest,
 *     absent from the target manifest, unmodified locally, not pinned);
 *   - the local installed tree classified against the installed version's
 *     baseline manifest: locally modified, mode-only, missing, untracked
 *     (with installer-generated state called out separately);
 *   - pin/tombstone files that a preserving apply would respect, when present.
 *
 * Nothing is written to disk: manifests are decompressed in memory, sizes are
 * probed with HEAD/one-byte range requests. Every conclusion names its source
 * and degrades honestly ("baseline manifest unavailable") instead of guessing.
 *
 * The module is self-contained (node builtins only) because the installer may
 * stream it from the channel URL into `node --input-type=module -`; it cannot
 * rely on sibling files being present next to a stdin script.
 *
 * Release metadata comes from the GitHub API when reachable (one call gives
 * every recent release with asset names and sizes); otherwise the module
 * degrades to probing the known asset names of the target release. The token
 * (if any) is read from GH_TOKEN/GITHUB_TOKEN in the environment, never argv.
 *
 * CLI:
 *   node scripts/update-inspect.mjs --platform linux-x64 --repo OWNER/REPO \
 *     --base-url https://github.com/OWNER/REPO --api-url https://api.github.com \
 *     --tag v<version> --from <installed version> --tree <installed tree> \
 *     --home <$DSH_HOME> --channel stable [--limit 40] [--json]
 *
 * Exit status is 0 when a report was produced (including "unavailable"
 * findings) and 1 only when the invocation itself is invalid.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

export const INSPECTION_SCHEMA = 'dsh-update-inspection/1'
const MANIFEST_SCHEMA = 'dsh-release-manifest/1'
const DEFAULT_LIMIT = 40
const MAX_LIMIT = 10000
const MAX_MANIFEST_BYTES = 128 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20000
const LADDER_MAX_HOPS = 6

/** Installer-written state inside a version tree that is not a shipped path. */
const INSTALLER_STATE_PATHS = new Set(['.dsh-install-complete', '.dsh-scan-index'])
const SCAN_INDEX_NAME = '.dsh-scan-index'
const SCAN_INDEX_SCHEMA = 'dsh-scan-index/1'

function isScanIndexPath(relPath) {
  return relPath === SCAN_INDEX_NAME || relPath.startsWith(`${SCAN_INDEX_NAME}.`)
}

/**
 * Read the engine's scan index for a tree, with the same trust anchor the
 * engine uses (the index file's own mtimeNs; future timestamps invalidate).
 * Returns null for a missing/corrupt/future index — classification then
 * falls back to hashing, exactly as before the index existed.
 */
function readScanIndex(treeDir) {
  try {
    const indexPath = path.join(treeDir, SCAN_INDEX_NAME)
    const stats = fs.lstatSync(indexPath, { bigint: true })
    if (!stats.isFile()) return null
    const writtenAtNs = stats.mtimeNs
    if (writtenAtNs > BigInt(Date.now()) * 1000000n + 5000000000n) return null
    const doc = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    if (doc === null || typeof doc !== 'object' || doc.schema !== SCAN_INDEX_SCHEMA) return null
    if (doc.entries === null || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) return null
    return { writtenAtNs, entries: doc.entries }
  } catch {
    return null
  }
}

/**
 * The engine's trust rule (AMD-02/06): the current stat must equal the entry
 * (times included) and both times must be strictly older than the index file.
 */
function trustedIndexHash(index, relPath, identity) {
  if (index === null) return undefined
  const tuple = index.entries[relPath]
  if (!Array.isArray(tuple) || tuple.length !== 10) return undefined
  const [typeCode, size, mtimeNs, ctimeNs, ino, dev, mode, , , sha256] = tuple
  if (typeCode !== 0 || typeof sha256 !== 'string') return undefined
  if (size !== identity.size || mode !== identity.mode) return undefined
  if (typeof mtimeNs !== 'string' || typeof ctimeNs !== 'string' || typeof ino !== 'string' || typeof dev !== 'string') return undefined
  if (identity.mtimeNs !== mtimeNs || identity.ctimeNs !== ctimeNs) return undefined
  if (!(BigInt(mtimeNs) < index.writtenAtNs && BigInt(ctimeNs) < index.writtenAtNs)) return undefined
  if (ino !== '0' && identity.ino !== '0' && ino !== identity.ino) return undefined
  if (dev !== '0' && identity.dev !== '0' && dev !== identity.dev) return undefined
  return sha256
}

// ── helpers ─────────────────────────────────────────────────────────────────

function pathCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return 'unknown'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)
  return `${shown} ${units[unit]}`
}

function percent(part, whole) {
  if (!whole || part === null || part === undefined) return 'n/a'
  return `${((part / whole) * 100).toFixed(1)}%`
}

function authHeaders(token, extra = {}) {
  const headers = { 'User-Agent': 'dsh-update-inspect', ...extra }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function tokenFromEnv() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
}

function bounded(list, limit) {
  return list.length > limit ? list.slice(0, limit) : list
}

const MODE_MASK = 0o7777

/**
 * Reject a manifest path that could escape its tree root or smuggle control
 * characters (release-delta/update-delta parity rule).
 * @param {unknown} relPath relative path using '/' separators
 */
function assertSafeManifestPath(relPath) {
  if (typeof relPath !== 'string') throw new Error(`unsafe manifest path: ${JSON.stringify(relPath)}`)
  const segments = relPath.split('/')
  if (
    relPath === ''
    || relPath.startsWith('/')
    || relPath.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(relPath)
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe manifest path: ${JSON.stringify(relPath)}`)
  }
}

function parseMode(value, label) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value & MODE_MASK
  if (typeof value === 'string') {
    const parsed = /^0[0-7]+$/u.test(value) ? Number.parseInt(value, 8) : Number.parseInt(value, 10)
    if (Number.isInteger(parsed) && parsed >= 0) return parsed & MODE_MASK
  }
  throw new Error(`${label}: mode must be a POSIX mode number or string`)
}

/**
 * Validate every entry of a manifest document with the release-manifest rules
 * (schema, entry fields, path safety) before a single value is used. A
 * corrupted or hostile manifest is refused here, not downstream.
 */
function validateManifestDoc(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('manifest must be a JSON object')
  if (doc.schema !== MANIFEST_SCHEMA) throw new Error(`not a ${MANIFEST_SCHEMA} document`)
  if (!Array.isArray(doc.entries)) throw new Error('manifest entries must be an array')
  for (const entry of doc.entries) {
    const label = entry !== null && typeof entry === 'object' && 'path' in entry ? `manifest:${String(entry.path)}` : 'manifest'
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label}: entry must be an object`)
    assertSafeManifestPath(entry.path)
    if (entry.type !== 'file' && entry.type !== 'symlink' && entry.type !== 'dir') throw new Error(`${label}: unknown type ${JSON.stringify(entry.type)}`)
    if (entry.sha256 !== null && typeof entry.sha256 !== 'string') throw new Error(`${label}: sha256 must be a string or null`)
    if (typeof entry.size !== 'number' || !Number.isInteger(entry.size) || entry.size < 0) throw new Error(`${label}: size must be a non-negative integer`)
    parseMode(entry.mode, label)
    const target = entry.target ?? null
    if (target !== null && typeof target !== 'string') throw new Error(`${label}: target must be a string or null`)
    if (entry.type === 'symlink' && typeof target !== 'string') throw new Error(`${label}: symlink entry requires a target string`)
    const binary = entry.binary ?? false
    if (typeof binary !== 'boolean') throw new Error(`${label}: binary must be a boolean`)
  }
  return doc
}

/** Read a gzipped-or-plain manifest Buffer and validate it. */
export function parseManifestBuffer(raw) {
  const json = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw
  const doc = JSON.parse(json.toString('utf8'))
  return validateManifestDoc(doc)
}

/** sha256 of a file as lowercase hex, streaming in 1 MiB chunks. */
export function sha256FileSync(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(1 << 20)
  try {
    let read = 0
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

// ── local tree ──────────────────────────────────────────────────────────────

/** Lstat-only tree index: no file content is read. */
export function statTree(treeDir) {
  const tree = new Map()
  // The engine's scan index (doc 97 §3) turns the classification below from a
  // content-hash walk into a stat walk: trusted entries carry their hash.
  const index = readScanIndex(treeDir)
  const walk = (rel) => {
    const dir = rel ? path.join(treeDir, rel) : treeDir
    for (const name of fs.readdirSync(dir).sort(pathCompare)) {
      const relPath = rel ? `${rel}/${name}` : name
      const abs = path.join(treeDir, relPath)
      const st = fs.lstatSync(abs, { bigint: true })
      const mode = (st.mode & 0o7777n).toString(8).padStart(4, '0')
      if (st.isSymbolicLink()) {
        tree.set(relPath, {
          type: 'symlink',
          mode,
          target: fs.readlinkSync(abs),
        })
      } else if (st.isDirectory()) {
        tree.set(relPath, { type: 'dir', mode })
        walk(relPath)
      } else if (st.isFile()) {
        const identity = {
          size: Number(st.size),
          mtimeNs: st.mtimeNs.toString(),
          ctimeNs: st.ctimeNs.toString(),
          ino: st.ino.toString(),
          dev: st.dev.toString(),
          mode: Number(st.mode & 0o7777n),
        }
        const entry = { type: 'file', mode, size: identity.size }
        const trusted = trustedIndexHash(index, relPath, identity)
        if (trusted !== undefined) entry.sha256 = trusted
        tree.set(relPath, entry)
      }
    }
  }
  walk('')
  return tree
}

/**
 * Classify the installed tree against the installed version's baseline
 * manifest. Files are hashed only when their size matches the manifest (a
 * different size is already a modification). Untracked = present locally and
 * absent from the manifest; installer-written state is separated.
 * @returns {{modified: object[], missing: string[], modeOnly: object[], untracked: string[], installerState: string[]}}
 */
export function classifyLocal(treeDir, tree, baselineEntries, options = {}) {
  const hashFile = options.hash ?? sha256FileSync
  const baseline = new Map(baselineEntries.map(entry => [entry.path, entry]))
  const modified = []
  const missing = []
  const modeOnly = []
  const untracked = []
  const installerState = []

  for (const [relPath, base] of baseline) {
    const local = tree.get(relPath)
    if (!local) {
      missing.push(relPath)
      continue
    }
    if (local.type !== base.type) {
      modified.push({ path: relPath, reason: `type ${base.type} -> ${local.type}` })
      continue
    }
    if (base.type === 'file') {
      // A trusted index hash needs no read; otherwise size-then-hash exactly
      // as before the index existed.
      let actualSha256 = local.sha256
      if (actualSha256 === undefined) {
        if (local.size !== base.size) {
          modified.push({ path: relPath, reason: 'content (size differs)' })
          continue
        }
        actualSha256 = hashFile(path.join(treeDir, relPath))
      }
      if (actualSha256 !== base.sha256) {
        modified.push({ path: relPath, reason: 'content' })
        continue
      }
    } else if (base.type === 'symlink' && local.target !== base.target) {
      modified.push({ path: relPath, reason: `target ${base.target} -> ${local.target}` })
      continue
    }
    if (local.mode !== base.mode) {
      modeOnly.push({ path: relPath, oldMode: base.mode, newMode: local.mode })
    }
  }

  for (const [relPath, local] of tree) {
    if (baseline.has(relPath)) continue
    if (INSTALLER_STATE_PATHS.has(relPath) || isScanIndexPath(relPath)) {
      installerState.push(relPath)
      continue
    }
    untracked.push(local.type === 'dir' ? `${relPath}/` : relPath)
  }

  modified.sort((a, b) => pathCompare(a.path, b.path))
  missing.sort(pathCompare)
  modeOnly.sort((a, b) => pathCompare(a.path, b.path))
  untracked.sort(pathCompare)
  installerState.sort(pathCompare)
  return { modified, missing, modeOnly, untracked, installerState }
}

/**
 * Manifest comparison, mirroring the release diff generator in
 * scripts/release-delta.mjs (kept in sync by scripts/update-inspect.spec.ts).
 * @returns {{changed: object[], changedBytes: number, modeChanges: object[], deleted: string[]}}
 */
export function compareManifests(baseline, target) {
  const oldEntries = new Map(baseline.map(entry => [entry.path, entry]))
  const newEntries = new Map(target.map(entry => [entry.path, entry]))
  const changed = []
  const modeChanges = []
  let changedBytes = 0
  for (const [relPath, next] of newEntries) {
    const prev = oldEntries.get(relPath)
    if (!prev || prev.type !== next.type) {
      changed.push(next)
      if (next.type === 'file') changedBytes += next.size
      continue
    }
    if (next.type === 'file') {
      if (prev.sha256 !== next.sha256) {
        changed.push(next)
        changedBytes += next.size
        continue
      }
    } else if (next.type === 'symlink' && prev.target !== next.target) {
      changed.push(next)
      continue
    }
    if (prev.mode !== next.mode) modeChanges.push({ path: relPath, oldMode: prev.mode, newMode: next.mode })
  }
  const deleted = []
  for (const relPath of oldEntries.keys()) {
    if (!newEntries.has(relPath)) deleted.push(relPath)
  }
  deleted.sort(pathCompare)
  modeChanges.sort((a, b) => pathCompare(a.path, b.path))
  changed.sort((a, b) => pathCompare(a.path, b.path))
  return { changed, changedBytes, modeChanges, deleted }
}

// ── ladder ──────────────────────────────────────────────────────────────────

export function manifestAsset(platform, version) {
  return `manifest-${platform}-${version}.json.gz`
}

export function diffAsset(platform, from, to) {
  return `diff-${platform}-${from}-${to}.tar.gz`
}

export function fullAsset(version, platform) {
  return `dsh-harness-${version}-${platform}.tar.gz`
}

function assetSize(release, name) {
  const size = release?.assets?.get(name)
  return typeof size === 'number' ? size : null
}

/**
 * Choose the apply ladder rung for `from` -> `to` from the release index
 * (newest first). rung 1: the newest release carries a diff straight from the
 * installed version; rung 2: a chain of at most three consecutive diffs, each
 * read from its own (immutable) release; rung 3: the full tarball. A partial
 * or missing chain is never assumed -- it degrades to rung 3 with a reason.
 * @returns {{rung: number, kind: string, chain: string[], chainTags: string[], downloadBytes: number|null, full: {name: string|null, bytes: number|null}, reason: string}}
 */
export function planLadder({ releases, platform, from, to, maxHops }) {
  const hopCap = Number.isInteger(maxHops) && maxHops > 0 ? maxHops : LADDER_MAX_HOPS
  const targetIndex = releases.findIndex(release => release.version === to)
  const target = targetIndex === -1 ? null : releases[targetIndex]
  const fullName = target ? fullAsset(to, platform) : null
  const fullBytes = assetSize(target, fullName)
  const full = { name: fullName, bytes: fullBytes }

  if (from && from === to) {
    return { rung: 0, kind: 'up-to-date', chain: [], chainTags: [], downloadBytes: 0, full, reason: 'the installed version is the newest release' }
  }
  if (!target) {
    return { rung: 3, kind: 'full-tarball', chain: [], chainTags: [], downloadBytes: fullBytes, full, reason: `release metadata for ${to} is unavailable` }
  }
  // A direct diff asset on the target release encodes its own hop, so rung 1
  // is provable without any older release metadata (the probe fallback knows
  // only the target release).
  if (from) {
    const directName = diffAsset(platform, from, to)
    const directSize = assetSize(target, directName)
    if (directSize !== null) {
      return {
        rung: 1,
        kind: 'consecutive-diff',
        chain: [directName],
        chainTags: [to],
        downloadBytes: directSize,
        full,
        reason: 'a diff from the installed version exists',
      }
    }
  }
  const chain = []
  // Each chain asset lives on its own (newer) release, so the apply path needs
  // the carrying release per hop; chainTags runs parallel to chain.
  const chainTags = []
  let bytes = 0
  for (let i = targetIndex; i < releases.length && chain.length < hopCap; i += 1) {
    const newer = releases[i]
    const older = releases[i + 1]
    if (!older) break
    const name = diffAsset(platform, older.version, newer.version)
    const size = assetSize(newer, name)
    if (size === null) {
      return {
        rung: 3,
        kind: 'full-tarball',
        chain: [],
        chainTags: [],
        downloadBytes: fullBytes,
        full,
        reason: chain.length
          ? `diff chain breaks at ${name} (asset missing); full tarball is the safe rung`
          : `no consecutive diff ${name} on release ${newer.tag}; full tarball is the safe rung`,
      }
    }
    chain.push(name)
    chainTags.push(newer.version)
    bytes += size
    if (older.version === from) {
      return {
        rung: chain.length === 1 ? 1 : 2,
        kind: chain.length === 1 ? 'consecutive-diff' : 'diff-chain',
        chain,
        chainTags,
        downloadBytes: bytes,
        full,
        reason: chain.length === 1 ? 'a diff from the installed version exists' : `${chain.length} consecutive diffs apply in order`,
      }
    }
  }
  const reason = from
    ? `no diff chain reaches installed ${from} within ${hopCap} hops; full tarball is the safe rung`
    : 'no installed release version recorded; full tarball is the safe rung'
  return { rung: 3, kind: 'full-tarball', chain: [], chainTags: [], downloadBytes: fullBytes, full, reason }
}

// ── pins / tombstones ───────────────────────────────────────────────────────

/** Simple glob matcher: `**` crosses directories, `*`/`?` do not cross `/`. */
export function globToRegExp(glob) {
  let source = '^'
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*'
        i += 1
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      source += `\\${ch}`
    } else {
      source += ch
    }
  }
  return new RegExp(`${source}$`)
}

/**
 * Read a pin/tombstone list file. Both documented shapes parse: YAML list
 * rows (`- path/glob`) and plain one-per-line lists; `#` comments and an
 * optional `paths:` key are ignored.
 */
export function readPathList(file) {
  if (!file || !fs.existsSync(file)) return { path: file ?? null, present: false, entries: [] }
  const entries = []
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('#') || line === 'paths:') continue
    if (line.startsWith('- ')) line = line.slice(2).trim()
    line = line.replace(/^['"]|['"]$/g, '')
    if (line) entries.push(line)
  }
  return { path: file, present: true, entries }
}

function matchPathList(entries, paths) {
  const patterns = entries.map(entry => ({ entry, regexp: globToRegExp(entry) }))
  const matched = new Set()
  for (const relPath of paths) {
    for (const { entry, regexp } of patterns) {
      if (regexp.test(relPath)) matched.add(entry)
    }
  }
  return [...matched].sort(pathCompare)
}

// ── report ──────────────────────────────────────────────────────────────────

/**
 * Build the inspection report from already-fetched inputs. Pure with respect
 * to the filesystem (reads only), so it is safe to call from tests.
 */
export function buildReport({
  channel,
  platform,
  tag,
  toVersion,
  fromVersion,
  treeDir,
  targetManifest,
  targetManifestNote,
  baselineManifest,
  baselineAsset,
  baselineNote,
  releases,
  pinsPath,
  tombstonePaths = [],
  limit = DEFAULT_LIMIT,
  maxHops,
  treeExists = true,
}) {
  const notes = []
  const ladder = planLadder({ releases, platform, from: fromVersion, to: toVersion, maxHops })

  let changed = null
  if (targetManifest && baselineManifest) {
    changed = compareManifests(baselineManifest.entries, targetManifest.entries)
  } else if (!targetManifest) {
    notes.push(targetManifestNote ?? 'target manifest unavailable')
  } else {
    notes.push(baselineNote ?? 'baseline manifest unavailable')
  }

  let local = null
  if (baselineManifest && treeExists) {
    const tree = statTree(treeDir)
    local = classifyLocal(treeDir, tree, baselineManifest.entries)
  }

  const pins = readPathList(pinsPath)
  const tombstones = tombstonePaths
    .map(file => readPathList(file))
    .find(list => list.present) ?? { path: tombstonePaths[0] ?? null, present: false, entries: [] }

  const touchedPaths = changed ? [...changed.changed.map(entry => entry.path), ...changed.deleted] : []
  const pinsMatched = changed ? matchPathList(pins.entries, touchedPaths) : []
  const tombstonesMatched = changed ? matchPathList(tombstones.entries, touchedPaths) : []
  const pinnedDeletions = changed ? matchPathList(pins.entries, changed.deleted) : []
  const pinnedDeletionSet = new Set(pinnedDeletions)

  // A deletion is applied only when the path is present in the baseline
  // manifest, absent from the target manifest, unmodified locally, and not
  // pinned (design matrix §3.4). The first two hold by construction here.
  let deletions = null
  if (changed) {
    const applicable = []
    const kept = []
    if (local) {
      const modifiedSet = new Set(local.modified.map(item => item.path))
      for (const relPath of changed.deleted) {
        if (modifiedSet.has(relPath)) kept.push({ path: relPath, reason: 'locally modified' })
        else if (pinnedDeletionSet.has(relPath)) kept.push({ path: relPath, reason: 'pinned' })
        else applicable.push(relPath)
      }
    }
    deletions = {
      candidates: changed.deleted.length,
      sample: bounded(changed.deleted, limit),
      applicable: local ? applicable.length : null,
      applicableSample: bounded(applicable, limit),
      kept: local ? kept.length : null,
      keptSample: bounded(kept, limit),
      available: local !== null,
    }
  }

  const targetRelease = releases.find(release => release.version === toVersion) ?? null

  return {
    schema: INSPECTION_SCHEMA,
    channel: channel ?? null,
    platform,
    target: {
      tag: tag ?? (toVersion ? `v${toVersion}` : null),
      version: toVersion ?? null,
      assetCount: targetRelease ? targetRelease.assets.size : null,
    },
    installed: {
      version: fromVersion ?? null,
      tree: treeDir ?? null,
      treeExists,
    },
    ladder: {
      rung: ladder.rung,
      kind: ladder.kind,
      chain: ladder.chain,
      chainTags: ladder.chainTags,
      downloadBytes: ladder.downloadBytes,
      fullTarball: ladder.full,
      reason: ladder.reason,
    },
    changed: changed
      ? {
          available: true,
          count: changed.changed.length,
          bytes: changed.changedBytes,
          sample: bounded(changed.changed, limit).map(entry => ({ path: entry.path, type: entry.type, size: entry.size ?? null })),
          modeChanges: changed.modeChanges.length,
        }
      : { available: false, count: null, bytes: null, sample: [], modeChanges: null },
    deletions: deletions ?? { candidates: null, sample: [], applicable: null, applicableSample: [], kept: null, keptSample: [], available: false },
    localChanges: local
      ? {
          available: true,
          modified: bounded(local.modified, limit),
          missing: bounded(local.missing, limit),
          modeOnly: bounded(local.modeOnly, limit),
          untracked: bounded(local.untracked, limit),
          installerState: local.installerState,
          counts: {
            modified: local.modified.length,
            missing: local.missing.length,
            modeOnly: local.modeOnly.length,
            untracked: local.untracked.length,
            installerState: local.installerState.length,
          },
        }
      : {
          available: false,
          modified: [],
          missing: [],
          modeOnly: [],
          untracked: [],
          installerState: [],
          counts: { modified: null, missing: null, modeOnly: null, untracked: null, installerState: null },
          note: baselineNote ?? (treeExists ? 'baseline manifest unavailable' : `installed tree missing: ${treeDir}`),
        },
    baseline: {
      available: baselineManifest !== null,
      asset: baselineManifest ? baselineAsset : null,
      note: baselineManifest ? null : (baselineNote ?? 'baseline manifest unavailable'),
    },
    pins: { ...pins, matched: pinsMatched },
    tombstones: { ...tombstones, matched: tombstonesMatched },
    notes,
  }
}

function sampleLines(items, render) {
  return items.map(item => `      ${render(item)}`)
}

/** Human-readable or JSON rendering of a report. */
export function formatReport(report, { json = false } = {}) {
  if (json) return `${JSON.stringify(report)}\n`
  const lines = []
  lines.push('  inspection: read-only manifest inspection (nothing is written)')
  lines.push(`  target:     ${report.target.tag ?? '(unknown release)'} on the ${report.channel ?? 'stable'} channel`)
  lines.push(
    `  installed:  ${report.installed.version ?? '(unknown)'} (tree ${report.installed.tree ?? '(unknown)'}${report.installed.treeExists ? '' : '; MISSING'})`,
  )
  const ladder = report.ladder
  const fullName = ladder.fullTarball.name ?? '(full tarball name unknown)'
  const dl = formatBytes(ladder.downloadBytes)
  const full = formatBytes(ladder.fullTarball.bytes)
  if (ladder.rung === 0) {
    lines.push(`  ladder:     rung 0 — already up to date (${ladder.reason})`)
  } else if (ladder.rung === 3) {
    lines.push(`  ladder:     rung 3 — full tarball ${fullName} (${full})`)
  } else {
    lines.push(`  ladder:     rung ${ladder.rung} — ${ladder.kind}: ${ladder.chain.join(' + ')} (${dl} vs full ${full}, ${percent(ladder.downloadBytes, ladder.fullTarball.bytes)})`)
  }
  lines.push(`              reason: ${ladder.reason}`)
  if (report.changed.available) {
    lines.push(
      `  changed:    ${report.changed.count} path(s), raw ${formatBytes(report.changed.bytes)}${report.changed.modeChanges ? `, ${report.changed.modeChanges} mode-only change(s)` : ''}`,
    )
    lines.push(...sampleLines(report.changed.sample, entry => `${entry.path}${entry.size === null ? '' : ` (${formatBytes(entry.size)})`}`))
  } else {
    lines.push('  changed:    unavailable (a manifest is missing; see notes)')
  }
  if (report.deletions.candidates === null) {
    lines.push('  deletions:  unavailable (baseline manifest missing)')
  } else {
    lines.push(
      `  deletions:  ${report.deletions.candidates} candidate(s); ${report.deletions.available ? `${report.deletions.applicable} would be deleted, ${report.deletions.kept} kept (locally modified)` : 'applicability unknown (local classification unavailable)'}`,
    )
    lines.push(...sampleLines(report.deletions.applicableSample, relPath => `- would delete: ${relPath}`))
    lines.push(...sampleLines(report.deletions.keptSample, item => `- kept: ${item.path} (${item.reason})`))
  }
  if (report.localChanges.available) {
    const counts = report.localChanges.counts
    lines.push(
      `  local:      ${counts.modified} modified, ${counts.modeOnly} mode-only, ${counts.missing} missing, ${counts.untracked} untracked (+${counts.installerState} installer state)`,
    )
    lines.push(...sampleLines(report.localChanges.modified, item => `~ ${item.path} (${item.reason})`))
    lines.push(...sampleLines(report.localChanges.modeOnly, item => `m ${item.path} (${item.oldMode} -> ${item.newMode})`))
    lines.push(...sampleLines(report.localChanges.missing, relPath => `! missing: ${relPath}`))
    lines.push(...sampleLines(report.localChanges.untracked, relPath => `+ untracked: ${relPath}`))
  } else {
    lines.push(`  local:      not classified (${report.localChanges.note})`)
  }
  lines.push(
    `  baseline:   ${report.baseline.available ? report.baseline.asset : 'unavailable'}${report.baseline.note ? ` (${report.baseline.note})` : ''}`,
  )
  lines.push(
    `  pins:       ${report.pins.present ? `${report.pins.entries.length} entry(ies) at ${report.pins.path}; ${report.pins.matched.length} would be respected` : `none (no file at ${report.pins.path ?? '(unset)'})`}`,
  )
  lines.push(
    `  tombstones: ${report.tombstones.present ? `${report.tombstones.entries.length} entry(ies) at ${report.tombstones.path}; ${report.tombstones.matched.length} would be respected` : `none (no file at ${report.tombstones.path ?? '(unset)'})`}`,
  )
  for (const note of report.notes) lines.push(`  note:       ${note}`)
  return `${lines.join('\n')}\n`
}

// ── network (CLI only) ──────────────────────────────────────────────────────

async function fetchBuffer(url, token, { method = 'GET' } = {}) {
  const response = await fetch(url, {
    method,
    headers: authHeaders(token),
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} for ${url}`)
    error.status = response.status
    throw error
  }
  if (method === 'HEAD') return Buffer.alloc(0)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_MANIFEST_BYTES) throw new Error(`refusing a ${declared}-byte download from ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function probeSize(url, token) {
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      headers: authHeaders(token),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (head.ok) {
      const length = Number(head.headers.get('content-length') ?? 0)
      if (length > 0) return length
    }
  } catch {
    // fall through to the ranged probe
  }
  try {
    const ranged = await fetch(url, {
      headers: authHeaders(token, { Range: 'bytes=0-0' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (ranged.ok || ranged.status === 206) {
      const range = ranged.headers.get('content-range')
      const match = range ? /\/(\d+)$/.exec(range) : null
      if (match) return Number(match[1])
      const length = Number(ranged.headers.get('content-length') ?? 0)
      if (ranged.status === 200 && length > 0) return length
    }
  } catch {
    // unavailable
  }
  return null
}

function normalizeReleases(json, baseUrl) {
  return json
    .filter(release => release && release.draft !== true && release.prerelease !== true)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .map(release => {
      const assets = new Map()
      const urls = new Map()
      for (const asset of release.assets ?? []) {
        assets.set(asset.name, typeof asset.size === 'number' ? asset.size : null)
        if (asset.browser_download_url) urls.set(asset.name, asset.browser_download_url)
      }
      return {
        tag: release.tag_name,
        version: String(release.tag_name ?? '').replace(/^v/, ''),
        assets,
        urls,
        createdAt: release.created_at ?? null,
        base: baseUrl,
      }
    })
}

/** All published releases with asset names/sizes from the API; null when unreachable. */
export async function fetchReleases({ apiUrl, repo, token }) {
  try {
    const raw = await fetchBuffer(`${apiUrl}/repos/${repo}/releases?per_page=30`, token, { method: 'GET' })
    const json = JSON.parse(raw.toString('utf8'))
    if (!Array.isArray(json)) throw new Error('release listing is not an array')
    return normalizeReleases(json, null)
  } catch {
    return null
  }
}

/** Minimal index for one release when the API is unavailable: probe known names. */
async function probeRelease({ tag, baseUrl, platform, fromVersion, token }) {
  const version = tag.replace(/^v/, '')
  const names = [fullAsset(version, platform), manifestAsset(platform, version)]
  if (fromVersion) names.push(diffAsset(platform, fromVersion, version))
  const assets = new Map()
  const urls = new Map()
  for (const name of names) {
    const url = `${baseUrl}/releases/download/${tag}/${name}`
    const size = await probeSize(url, token)
    if (size !== null) {
      assets.set(name, size)
      urls.set(name, url)
    }
  }
  return { tag, version, assets, urls, createdAt: null, base: baseUrl }
}

function assetUrl(release, name, tag, baseUrl) {
  return release?.urls?.get(name) ?? `${baseUrl}/releases/download/${tag}/${name}`
}

/**
 * Fetch a release asset through the shared cache directory when one is given:
 * `manifest-<platform>-<version>.json.gz` recurs on every update (it is the
 * FROM or TO manifest of the next one), and the sidecar checksum guards
 * reuse. A cached file whose checksum no longer matches is refetched once.
 */
async function fetchAsset(release, name, tag, baseUrl, token, cacheDir) {
  const url = assetUrl(release, name, tag, baseUrl)
  if (!cacheDir) return fetchBuffer(url, token)
  const file = path.join(cacheDir, name)
  const sidecar = `${file}.sha256`
  const expected = await (async () => {
    try {
      const digest = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/u)[0]?.toLowerCase() ?? ''
      return /^[0-9a-f]{64}$/u.test(digest) ? digest : ''
    } catch {
      return ''
    }
  })()
  if (fs.existsSync(file) && expected !== '') {
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (actual === expected) return fs.readFileSync(file)
    fs.rmSync(file, { force: true })
    fs.rmSync(sidecar, { force: true })
  }
  const buffer = await fetchBuffer(url, token)
  try {
    fs.mkdirSync(cacheDir, { recursive: true })
    const digest = createHash('sha256').update(buffer).digest('hex')
    fs.writeFileSync(`${file}.tmp-${process.pid}`, buffer)
    fs.renameSync(`${file}.tmp-${process.pid}`, file)
    fs.writeFileSync(sidecar, `${digest}  ${name}\n`)
  } catch {
    // A read-only cache must never fail the inspection.
  }
  return buffer
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') {
      args.json = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    // --tombstones repeats: the tombstone file's location is not yet fixed by
    // the design (the path lands with the preservation phase), so the caller
    // may name several candidate paths and the first present one wins.
    if (arg === '--tombstones') (args.tombstones ??= []).push(value)
    else args[arg.slice(2)] = value
    i += 1
  }
  return args
}

/** Full CLI flow: discover, fetch, classify, report. */
export async function inspectChannelUpdate(options) {
  const {
    platform,
    repo,
    baseUrl,
    apiUrl,
    tag,
    fromVersion,
    treeDir,
    pinsPath,
    tombstonePaths,
    channel,
    limit,
    maxHops,
    cacheDir,
  } = options
  const token = tokenFromEnv()
  const version = tag.replace(/^v/, '')
  let releases = await fetchReleases({ apiUrl, repo, token })
  if (!releases || !releases.some(release => release.tag === tag)) {
    const probed = await probeRelease({ tag, baseUrl, platform, fromVersion, token })
    releases = releases ? [probed, ...releases] : [probed]
  }
  const target = releases.find(release => release.tag === tag)

  let targetManifest = null
  let targetManifestNote = null
  const targetManifestName = manifestAsset(platform, version)
  try {
    targetManifest = parseManifestBuffer(await fetchAsset(target, targetManifestName, tag, baseUrl, token, cacheDir))
  } catch (error) {
    targetManifestNote = `target manifest ${targetManifestName} unavailable (${error.message}); the release predates manifest emission`
  }

  let baselineManifest = null
  let baselineAsset = null
  let baselineNote = null
  if (fromVersion) {
    const baselineTag = `v${fromVersion}`
    const baselineRelease = releases.find(release => release.tag === baselineTag) ?? null
    baselineAsset = manifestAsset(platform, fromVersion)
    try {
      baselineManifest = parseManifestBuffer(await fetchAsset(baselineRelease, baselineAsset, baselineTag, baseUrl, token, cacheDir))
    } catch (error) {
      baselineManifest = null
      baselineNote = `baseline manifest ${baselineAsset}@${baselineTag} unavailable (${error.message})`
    }
  } else {
    baselineNote = 'no installed release version recorded; local classification is unavailable'
  }

  const treeExists = Boolean(treeDir) && fs.existsSync(treeDir)
  return buildReport({
    channel,
    platform,
    tag,
    toVersion: version,
    fromVersion: fromVersion ?? null,
    treeDir,
    targetManifest,
    targetManifestNote,
    baselineManifest,
    baselineAsset,
    baselineNote,
    releases,
    pinsPath,
    tombstonePaths,
    limit,
    maxHops,
    treeExists,
  })
}

async function main(argv) {
  const args = parseArgs(argv)
  const hopsRaw = Number.parseInt(args['max-hops'] ?? process.env.DSH_MAX_HOPS ?? '', 10)
  const maxHops = Number.isInteger(hopsRaw) && hopsRaw > 0 ? hopsRaw : undefined
  const limitRaw = Number.parseInt(args.limit ?? `${DEFAULT_LIMIT}`, 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIMIT) : DEFAULT_LIMIT
  const report = await inspectChannelUpdate({
    platform: args.platform ?? `${process.platform}-${process.arch}`,
    repo: args.repo ?? '',
    baseUrl: args['base-url'] ?? '',
    apiUrl: args['api-url'] ?? 'https://api.github.com',
    tag: args.tag ?? '',
    fromVersion: args.from ?? '',
    treeDir: args.tree ?? '',
    pinsPath: args.pins ?? '',
    tombstonePaths: Array.isArray(args.tombstones) ? args.tombstones : [],
    channel: args.channel ?? null,
    limit,
    maxHops,
    cacheDir: args['cache-dir'] ?? process.env.DSH_MANIFEST_CACHE ?? null,
  })
  process.stdout.write(formatReport(report, { json: args.json === true }))
  return 0
}

// The installer streams this module into `node --input-type=module -` when no
// local copy exists; a stdin module's import.meta.url never matches argv[1],
// so that invocation sets DSH_UPDATE_INSPECT_MAIN=1 to select main().
const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href
const isMain = (invokedPath !== undefined && import.meta.url === invokedPath) || process.env.DSH_UPDATE_INSPECT_MAIN === '1'
if (isMain) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      process.stderr.write(`update-inspect: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
