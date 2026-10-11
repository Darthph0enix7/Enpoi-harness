#!/usr/bin/env node
/**
 * Apply-side orchestration for the P3 delta update path (design doc 95, §2.2
 * ladder, §2.3 staged apply, §3 matrix).
 *
 * The updater (scripts/install.sh) owns transport, prefixes, and the atomic
 * switch; this module owns the filesystem work between a downloaded artifact
 * and a verified staging directory:
 *
 *   1. validate the installed version's release manifest and the target
 *      release manifest (`dsh-release-manifest/1` envelope, engine canonical
 *      projection);
 *   2. assemble the release view: extract the consecutive diff chain
 *      (rungs 1-2) into a scratch directory with member-name validation, or
 *      use an already-extracted full release tree (rung 3); supplement the
 *      view with pristine local bytes for paths whose release bytes the diff
 *      cannot carry (mode-only changes, integrity restores);
 *   3. run the preservation engine from the shipped tree: `buildPlan` over
 *      (previous manifest, next manifest, local scan, pristine base, release
 *      view, pins, tombstones) and `applyPlan` into the staging directory;
 *   4. write the structured result (engine report included) for the updater,
 *      and — when asked — retain a pristine base archive for the newly
 *      installed version (copied from a downloaded full release, or
 *      synthesized from the verified staging tree with preserved paths filled
 *      from the release view and unknowable paths omitted) so the next update
 *      keeps a true 3-way merge base.
 *
 * The engine bundle is imported dynamically from the installed tree; this
 * module itself is dependency-free because the updater may stream it from the
 * channel URL into `node --input-type=module -`, where no sibling file exists.
 * The manifest validation below mirrors scripts/release-delta.mjs; the spec
 * suite proves both project the same document to the same engine manifest.
 *
 * Progress: opt-in only. `--progress-fd <n>` (or an injected callback) emits
 * plain `apply:` / `verify:` / `merge base:` lines to an inherited descriptor;
 * without it the module stays silent and every result byte is unchanged. The
 * engine's own progress callback is likewise opt-in.
 *
 * Path safety: diff archives are listed with `tar -tzf` and every member name
 * is validated (absolute paths, `..`, backslashes, control characters, and
 * unknown `.dsh-diff/` metadata members are rejected) before extraction, and
 * the extracted tree is walked afterwards (control characters, hardlinks,
 * special files rejected). The engine covers tree traversal for every manifest
 * path it reads.
 *
 * CLI (exit codes mirror the engine plus 2 = input/assembly failure):
 *   node scripts/update-delta.mjs apply --engine <bundle.js> --local <dir>
 *     --base <dir> --release <dir> --previous <manifest> --next <manifest>
 *     --staging <dir> --journal <file> --to-version <v> [--from-version <v>]
 *     [--diff <archive.tar.gz>]... [--backup <dir>] [--pins <file>]
 *     [--tombstones <file>] [--stop-after-actions <n>] [--timestamp <iso>]
 *     [--platform <os-arch>] [--out <result.json>]
 */

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

export const MANIFEST_SCHEMA = 'dsh-release-manifest/1'
export const DIFF_SCHEMA = 'dsh-release-diff/1'

/** Reserved metadata directory inside a diff archive (release-delta layout). */
export const DIFF_META_DIR = '.dsh-diff'

/** Metadata members a diff archive may carry; anything else is rejected. */
export const DIFF_META_MEMBERS = Object.freeze([
  `${DIFF_META_DIR}/deleted.txt`,
  `${DIFF_META_DIR}/mode-changes.txt`,
  `${DIFF_META_DIR}/diff.json`,
])

const VIEW_MARKER = `${DIFF_META_DIR}/view.json`
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MODE_MASK = 0o7777

// ── manifest documents (mirror of release-delta.mjs; kept in sync by spec) ──

function modeString(mode) {
  return (mode & MODE_MASK).toString(8).padStart(4, '0')
}

function pathCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * Reject a manifest path that could escape its tree root or smuggle control
 * characters (release-delta parity, including the control-character rule).
 * @param {unknown} relPath relative path using '/' separators
 */
export function assertSafeRelPath(relPath) {
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

/**
 * POSIX permission bits from an octal string or a number (release-delta
 * parity). Value is masked with `& 0o7777`.
 * @param {unknown} value mode value
 * @param {string} label label used in error messages
 * @returns {number} masked permission bits
 */
export function modeNumber(value, label = 'mode') {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value & MODE_MASK
  if (typeof value === 'string') {
    const parsed = /^0[0-7]+$/u.test(value) ? Number.parseInt(value, 8) : Number.parseInt(value, 10)
    if (Number.isInteger(parsed) && parsed >= 0) return parsed & MODE_MASK
  }
  throw new Error(`${label}: mode must be a POSIX mode number or string`)
}

function canonicalEntry(entry, label) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${label}: entry must be an object`)
  }
  const record = /** @type {Record<string, unknown>} */ (entry)
  assertSafeRelPath(record.path)
  const type = record.type
  if (type !== 'file' && type !== 'symlink' && type !== 'dir') {
    throw new Error(`${label}: unknown type ${JSON.stringify(type)}`)
  }
  const sha256 = record.sha256
  if (sha256 !== null && typeof sha256 !== 'string') {
    throw new Error(`${label}: sha256 must be a string or null`)
  }
  const size = record.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw new Error(`${label}: size must be a non-negative integer`)
  }
  const mode = modeNumber(record.mode, label)
  const target = record.target ?? null
  if (target !== null && typeof target !== 'string') {
    throw new Error(`${label}: target must be a string or null`)
  }
  if (type === 'symlink' && typeof target !== 'string') {
    throw new Error(`${label}: symlink entry requires a target string`)
  }
  const binary = record.binary ?? false
  if (typeof binary !== 'boolean') {
    throw new Error(`${label}: binary must be a boolean`)
  }
  return { sha256: sha256 ?? null, size, type, mode, target, binary }
}

/**
 * Project a manifest document onto the engine's manifest map
 * (`path -> {sha256, size, type, mode, target, binary}`), validating every
 * path and entry first. release-delta.mjs `toCanonicalManifest` parity; the
 * spec proves both produce the same engine manifest.
 * @param {object} doc parsed manifest document
 * @param {string} source label used in error messages
 * @returns {Record<string, {sha256: string | null, size: number, type: string, mode: number, target: string | null, binary: boolean}>}
 */
export function canonicalManifest(doc, source = 'manifest') {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${source}: expected a JSON object mapping paths to entries`)
  }
  const record = /** @type {Record<string, unknown>} */ (doc)
  if (record.schema !== MANIFEST_SCHEMA) throw new Error(`${source}: not a ${MANIFEST_SCHEMA} document`)
  if (!Array.isArray(record.entries)) throw new Error(`${source}: entries must be an array`)
  const manifest = {}
  for (const entry of record.entries) {
    const label = entry !== null && typeof entry === 'object' && 'path' in entry ? `${source}:${String(entry.path)}` : source
    const projected = canonicalEntry(entry, label)
    manifest[String(entry.path)] = projected
  }
  return manifest
}

/**
 * Read and validate a manifest from a path or Buffer, transparently handling
 * gzip.
 * @param {string | Buffer} source file path or raw bytes
 * @returns {object} validated manifest document
 */
export function readManifestDocument(source) {
  const raw = Buffer.isBuffer(source) ? source : fs.readFileSync(source)
  const json = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw
  let doc
  try {
    doc = JSON.parse(json.toString('utf8'))
  } catch (error) {
    throw new Error(`manifest: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  canonicalManifest(doc, 'manifest')
  return doc
}

// ── tree helpers ────────────────────────────────────────────────────────────

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

function joinRel(root, relPath) {
  return path.join(root, ...relPath.split('/'))
}

/**
 * Content identity of an entry, ignoring mode: kind, content hash, and symlink
 * target (the engine's release-identity rule minus mode).
 * @param {object} left first entry
 * @param {object} right second entry
 * @returns {boolean} true when the entries describe the same content
 */
export function contentEqual(left, right) {
  return left.type === right.type
    && (left.sha256 ?? null) === (right.sha256 ?? null)
    && (left.target ?? null) === (right.target ?? null)
}

function lstatEntry(root, relPath) {
  let stats
  try {
    stats = fs.lstatSync(joinRel(root, relPath))
  } catch {
    return null
  }
  if (stats.isSymbolicLink()) {
    return { type: 'symlink', sha256: crypto.createHash('sha256').update(fs.readlinkSync(joinRel(root, relPath))).digest('hex'), target: fs.readlinkSync(joinRel(root, relPath)), mode: modeString(stats.mode) }
  }
  if (stats.isDirectory()) return { type: 'dir', sha256: null, target: null, mode: modeString(stats.mode) }
  if (stats.isFile()) return { type: 'file', sha256: sha256FileSync(joinRel(root, relPath)), target: null, mode: modeString(stats.mode) }
  return null
}

// ── diff archive validation and extraction ──────────────────────────────────

/**
 * Validate one archive member name against the diff layout. Rejects absolute
 * paths, `..` segments, backslashes, control characters (newlines included),
 * and any `.dsh-diff/` member other than the three reserved metadata files.
 * @param {string} name member name as listed by tar
 * @returns {string} normalized name (trailing slash removed)
 */
export function validateArchiveMember(name) {
  if (typeof name !== 'string' || name === '') throw new Error(`unsafe archive member: ${JSON.stringify(name)}`)
  if (/[\u0000-\u001f\u007f]/u.test(name)) throw new Error(`archive member carries control characters: ${JSON.stringify(name)}`)
  if (name.startsWith('/') || name.startsWith('./') || name.includes('\\')) {
    throw new Error(`unsafe archive member: ${JSON.stringify(name)}`)
  }
  const normalized = name.endsWith('/') ? name.slice(0, -1) : name
  const segments = normalized.split('/')
  if (normalized === '' || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`unsafe archive member: ${JSON.stringify(name)}`)
  }
  if (normalized === DIFF_META_DIR || normalized.startsWith(`${DIFF_META_DIR}/`)) {
    if (!DIFF_META_MEMBERS.includes(normalized)) throw new Error(`unexpected diff metadata member: ${JSON.stringify(name)}`)
  }
  return normalized
}

/**
 * List archive member names, rejecting any unsafe name.
 * @param {string} archive archive path
 * @returns {string[]} validated member names
 */
export function listArchiveMembers(archive) {
  const stats = fs.statSync(archive)
  if (!stats.isFile() || stats.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`diff archive rejected (size ${stats.size}): ${archive}`)
  }
  const result = spawnSync('tar', ['-tzf', archive], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tar listing failed (${result.status}) for ${archive}: ${String(result.stderr ?? '').trim()}`)
  const names = []
  for (const line of result.stdout.toString('utf8').split('\n')) {
    if (line === '') continue
    names.push(validateArchiveMember(line))
  }
  return names
}

function readDiffMeta(viewDir, name) {
  const file = path.join(viewDir, DIFF_META_DIR, name)
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, 'utf8')
}

/**
 * Extract one diff archive into the view directory and validate its
 * `diff.json` metadata against the expected hop.
 * @param {{archive: string, viewDir: string, from?: string|null, to?: string|null, platform?: string|null}} options extraction inputs
 */
export function extractDiffArchive(options) {
  const { archive, viewDir } = options
  listArchiveMembers(archive)
  const result = spawnSync('tar', ['-xzf', archive, '-C', viewDir], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tar extraction failed (${result.status}) for ${archive}: ${String(result.stderr ?? '').trim()}`)
  const meta = readDiffMeta(viewDir, 'diff.json')
  if (meta === null) throw new Error(`diff archive carries no ${DIFF_META_DIR}/diff.json: ${archive}`)
  let doc
  try {
    doc = JSON.parse(meta)
  } catch (error) {
    throw new Error(`diff archive metadata is invalid JSON (${archive}): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (doc?.schema !== DIFF_SCHEMA) throw new Error(`diff archive metadata is not a ${DIFF_SCHEMA} document: ${archive}`)
  if (options.to !== undefined && options.to !== null && String(doc.to) !== options.to) {
    throw new Error(`diff archive ${archive} targets ${String(doc.to)} but ${options.to} was expected`)
  }
  if (options.from !== undefined && options.from !== null && String(doc.from) !== options.from) {
    throw new Error(`diff archive ${archive} starts at ${String(doc.from)} but ${options.from} was expected`)
  }
  if (options.platform !== undefined && options.platform !== null && String(doc.platform) !== options.platform) {
    throw new Error(`diff archive ${archive} was built for ${String(doc.platform)} but ${options.platform} was expected`)
  }
  return doc
}

/**
 * Walk an extracted view and reject anything the pre-extraction listing could
 * not prove safe: control characters surfacing in names, hardlinked regular
 * files, and special files. Containment is structural (the walk starts at the
 * view root).
 * @param {string} viewDir extracted view root
 * @returns {number} number of regular one-link files seen
 */
export function verifyExtractedTree(viewDir) {
  let files = 0
  const walk = (rel) => {
    const dir = rel === '' ? viewDir : path.join(viewDir, ...rel.split('/'))
    for (const name of fs.readdirSync(dir).sort(pathCompare)) {
      const relPath = rel === '' ? name : `${rel}/${name}`
      assertSafeRelPath(relPath)
      const stats = fs.lstatSync(path.join(dir, name))
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) {
        walk(relPath)
        continue
      }
      if (!stats.isFile()) throw new Error(`extracted view carries an unsupported entry: ${relPath}`)
      if (stats.nlink > 1) throw new Error(`extracted view carries a hardlinked file: ${relPath}`)
      files += 1
    }
  }
  walk('')
  return files
}

/**
 * Assemble the release view from a chain of consecutive diff archives.
 * Archives are applied in the given order (oldest hop first); each archive's
 * metadata is checked against its hop. A completed view is marked so an
 * interrupted apply can resume without re-extracting.
 * @param {{archives: string[], viewDir: string, from: string, to: string, platform?: string|null}} options chain inputs
 * @returns {{assembled: boolean, members: number, hops: number}}
 */
export function extractDiffChain(options) {
  const { archives, viewDir } = options
  const marker = path.join(viewDir, VIEW_MARKER)
  if (fs.existsSync(marker)) {
    try {
      const saved = JSON.parse(fs.readFileSync(marker, 'utf8'))
      const names = archives.map(archive => path.basename(archive))
      if (saved?.schema === 'dsh-delta-view/1' && saved.to === options.to && saved.from === options.from
        && Array.isArray(saved.archives) && JSON.stringify(saved.archives) === JSON.stringify(names)) {
        return { assembled: false, members: typeof saved.members === 'number' ? saved.members : 0, hops: names.length }
      }
    } catch {
      // fall through to a full rebuild
    }
  }
  fs.rmSync(viewDir, { recursive: true, force: true })
  fs.mkdirSync(viewDir, { recursive: true })
  let members = 0
  let previousTo = null
  for (let index = 0; index < archives.length; index += 1) {
    const archive = archives[index]
    const doc = extractDiffArchive({
      archive,
      viewDir,
      from: index === 0 ? options.from : null,
      to: index === archives.length - 1 ? options.to : null,
      platform: options.platform ?? null,
    })
    // Chain continuity: each hop starts where the previous hop ended.
    if (previousTo !== null && String(doc.from) !== previousTo) {
      throw new Error(`diff chain is not consecutive: ${archive} starts at ${String(doc.from)} after ${previousTo}`)
    }
    previousTo = String(doc.to)
    members += listArchiveMembers(archive).length
    fs.rmSync(path.join(viewDir, DIFF_META_DIR), { recursive: true, force: true })
  }
  verifyExtractedTree(viewDir)
  fs.mkdirSync(path.join(viewDir, DIFF_META_DIR), { recursive: true })
  fs.writeFileSync(marker, `${JSON.stringify({
    schema: 'dsh-delta-view/1',
    from: options.from,
    to: options.to,
    archives: archives.map(archive => path.basename(archive)),
    members,
  })}\n`)
  return { assembled: true, members, hops: archives.length }
}

// ── release view supplementation ────────────────────────────────────────────

/**
 * Ensure the release view can serve every byte the plan can ask for. A diff
 * archive carries changed content only; the engine additionally reads release
 * bytes for mode-only changes and for integrity restores of paths whose
 * content did not change in the release. Those bytes are taken from the
 * pristine base tree (a verified cached full-release extraction) when it has
 * them, and from the local tree only when the local content is byte-identical
 * to the shipped entry. Paths that cannot be resolved are left absent: the
 * engine then refuses the pass rather than applying incomplete bytes, and the
 * updater falls back to the full tarball.
 * @param {{viewDir: string, previous: object, next: object, localRoot: string, baseRoot: string}} options view inputs
 * @returns {{supplemented: string[], unresolved: string[]}}
 */
export function supplementReleaseView(options) {
  const { viewDir, previous, next, localRoot, baseRoot } = options
  const supplemented = []
  const unresolved = []
  for (const [relPath, shipped] of Object.entries(next)) {
    if (shipped.type !== 'file') continue
    // lstat, not existsSync: a dead symlink from a corrupt archive must count
    // as occupied so a copy never writes through it.
    let occupied = null
    try {
      occupied = fs.lstatSync(joinRel(viewDir, relPath))
    } catch {
      occupied = null
    }
    if (occupied !== null) continue
    const prev = previous[relPath]
    if (prev === undefined) continue
    const modeOnly = prev.type === 'file' && contentEqual(prev, shipped) && modeString(prev.mode) !== modeString(shipped.mode)
    let restore = false
    if (!modeOnly && prev.type === 'file' && contentEqual(prev, shipped)) {
      const local = lstatEntry(localRoot, relPath)
      restore = local === null
    }
    if (!modeOnly && !restore) continue
    const fromLocal = lstatEntry(localRoot, relPath)
    let source = null
    if (fromLocal !== null && fromLocal.type === 'file' && fromLocal.sha256 === shipped.sha256) {
      source = joinRel(localRoot, relPath)
    } else {
      const fromBase = lstatEntry(baseRoot, relPath)
      if (fromBase !== null && fromBase.type === 'file' && fromBase.sha256 === shipped.sha256) {
        source = joinRel(baseRoot, relPath)
      }
    }
    if (source === null) {
      unresolved.push(relPath)
      continue
    }
    const destination = joinRel(viewDir, relPath)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    try {
      fs.linkSync(source, destination)
    } catch {
      fs.rmSync(destination, { force: true })
      fs.copyFileSync(source, destination)
    }
    supplemented.push(relPath)
  }
  return { supplemented, unresolved }
}

// ── progress ────────────────────────────────────────────────────────────────

/**
 * Human byte size for progress lines.
 * @param bytes - byte count
 * @returns short human form (e.g. "1.1 GiB")
 */
export function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = Number(bytes) || 0
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)
  return `${shown} ${units[unit]}`
}

/**
 * One 'applying' progress line: counts of the kinds completed so far plus the
 * bytes written. Kinds with zero completions are omitted.
 * @param plan - engine plan (actions in apply order)
 * @param processed - actions completed
 * @param bytesWritten - bytes written so far
 * @returns progress line
 */
export function formatApplyProgress(plan, processed, bytesWritten) {
  const tally = {}
  const upto = Math.min(processed, plan.actions.length)
  for (let index = 0; index < upto; index += 1) {
    const kind = plan.actions[index].kind
    tally[kind] = (tally[kind] ?? 0) + 1
  }
  const labels = {
    replace: 'replaced',
    add: 'added',
    restore: 'restored',
    merge: 'merged',
    'keep-local': 'kept-local',
    'keep-local-sidecar': 'kept-local',
    'keep-untracked': 'untracked',
    delete: 'deleted',
    tombstone: 'tombstoned',
    'pin-skip': 'pinned',
  }
  const parts = []
  for (const [kind, label] of Object.entries(labels)) {
    if ((tally[kind] ?? 0) > 0) parts.push(`${label} ${tally[kind]}`)
  }
  return `apply: ${processed}/${plan.actions.length} actions — ${formatBytes(bytesWritten)} written${parts.length > 0 ? ` — ${parts.join(', ')}` : ''}`
}

/**
 * Resolve the progress writer: an injected function wins; otherwise the
 * module writes plain lines to `--progress-fd` (or DSH_UPDATE_PROGRESS_FD)
 * when it is a valid descriptor >= 3. Every write is best-effort.
 * @param options - pipeline options
 * @returns writer, or null when progress is off
 */
function resolveProgressWriter(options) {
  if (typeof options.progress === 'function') return options.progress
  const raw = options.progressFd ?? process.env.DSH_UPDATE_PROGRESS_FD
  if (raw === undefined || raw === null || raw === '') return null
  const fd = Number.parseInt(String(raw), 10)
  if (!Number.isInteger(fd) || fd < 3) return null
  return line => {
    try {
      fs.writeSync(fd, `${line}\n`)
    } catch {
      // A closed or unwritable progress fd must never fail an update.
    }
  }
}

// ── retained pristine base archive ──────────────────────────────────────────

/**
 * Build a pristine base archive for a freshly verified version from an
 * applied plan. The archive carries exactly the release's shipped bytes: paths
 * whose staged content is the shipped content are hardlinked straight from the
 * verified staging tree; preserved paths (keep-local, merged, pinned,
 * tombstoned) take their shipped bytes from the release view when the release
 * changed the path, and are omitted when those bytes are unknowable locally
 * (an unchanged preserved path). Omitted paths degrade to the engine's
 * keep-local + sidecar fallback on the next update, never to a wrong merge
 * base, and no untracked/user path ever enters the archive.
 * @param {{plan: object, stagingRoot: string, releaseRoot: string, outPath: string}} options synthesis inputs
 * @returns {{path: string, bytes: number, files: number, omitted: string[]}}
 */
export async function synthesizePristineArchive(options) {
  const { plan, stagingRoot, releaseRoot, outPath } = options
  const emit = typeof options.progress === 'function' ? options.progress : null
  const scratch = `${outPath}.tree-${process.pid}`
  const tmpArchive = `${outPath}.tmp-${process.pid}`
  fs.rmSync(scratch, { recursive: true, force: true })
  fs.mkdirSync(scratch, { recursive: true })
  const omitted = []
  let files = 0
  let estimateBytes = 0
  for (const action of plan.actions) {
    if (action.shipped?.type === 'file' && action.shipped.sha256 !== null) estimateBytes += action.shipped.size ?? 0
  }
  emit?.(`merge base: retaining the pristine merge base for ${options.toVersion ?? 'the installed version'} (≈ ${formatBytes(estimateBytes)})…`)
  try {
    for (const action of plan.actions) {
      const shipped = action.shipped
      if (shipped === null || shipped === undefined) continue
      const destination = joinRel(scratch, action.path)
      if (shipped.type === 'dir') {
        fs.mkdirSync(destination, { recursive: true })
        try { fs.chmodSync(destination, shipped.mode) } catch { /* best effort mode */ }
        continue
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      if (shipped.type === 'symlink') {
        fs.symlinkSync(shipped.target ?? '', destination)
        continue
      }
      if (action.outcome.disposition === 'shipped') {
        const source = joinRel(stagingRoot, action.path)
        try {
          fs.linkSync(source, destination)
        } catch {
          fs.copyFileSync(source, destination)
        }
        files += 1
        continue
      }
      let stats = null
      const viewSource = joinRel(releaseRoot, action.path)
      try { stats = fs.lstatSync(viewSource) } catch { stats = null }
      if (stats !== null && stats.isFile() && sha256FileSync(viewSource) === shipped.sha256) {
        try {
          fs.linkSync(viewSource, destination)
        } catch {
          fs.copyFileSync(viewSource, destination)
        }
        files += 1
        continue
      }
      omitted.push(action.path)
    }
    // Long-running on real trees: the ticker keeps the phase visibly alive
    // while tar writes the archive (plain lines, no frames).
    const startedAt = Date.now()
    const ticker = setInterval(() => {
      let written = 0
      try {
        written = fs.statSync(tmpArchive).size
      } catch {
        written = 0
      }
      emit?.(`merge base: writing ${path.basename(outPath)} — ${formatBytes(written)} (${Math.round((Date.now() - startedAt) / 1000)}s)`)
    }, 5000)
    let tarStderr = ''
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-cf', tmpArchive, '-C', scratch, '.'])
        child.stderr?.on('data', chunk => { tarStderr += chunk.toString() })
        child.once('error', reject)
        child.once('close', resolve)
      })
      if (code !== 0) throw new Error(`tar failed (${code}): ${tarStderr.trim()}`)
    } finally {
      clearInterval(ticker)
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.renameSync(tmpArchive, outPath)
    const digest = sha256FileSync(outPath)
    fs.writeFileSync(`${outPath}.sha256`, `${digest}  ${path.basename(outPath)}\n`)
    const bytes = fs.statSync(outPath).size
    emit?.(`merge base: retained ${formatBytes(bytes)} at ${outPath}`)
    return { path: outPath, bytes, files, omitted }
  } finally {
    fs.rmSync(tmpArchive, { force: true })
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

// ── apply pipeline ──────────────────────────────────────────────────────────

/**
 * Run the full apply pipeline: manifests in, staging out.
 * @param {object} options pipeline inputs (CLI-shaped)
 * @returns {Promise<{status: string, exitCode: number, result: object, plan: object, transport: object}>}
 */
export async function runApplyPipeline(options) {
  const engine = await import(pathToFileURL(options.enginePath).href)
  for (const name of ['buildPlan', 'applyPlan', 'scanTree', 'loadPins', 'loadTombstones']) {
    if (typeof engine[name] !== 'function') throw new Error(`engine bundle does not export ${name}: ${options.enginePath}`)
  }
  const previousDoc = readManifestDocument(options.previousPath)
  const nextDoc = readManifestDocument(options.nextPath)
  const previous = canonicalManifest(previousDoc, 'previous')
  const next = canonicalManifest(nextDoc, 'next')

  const archives = options.diffArchives ?? []
  const transport = { mode: archives.length > 0 ? 'delta' : 'full', archives: archives.map(archive => path.basename(archive)), hops: archives.length, base: options.baseMode ?? 'unknown' }
  let view = null
  if (archives.length > 0) {
    view = extractDiffChain({
      archives,
      viewDir: options.releaseRoot,
      from: options.fromVersion ?? '',
      to: options.toVersion,
      platform: options.platform ?? null,
    })
    const supplemented = supplementReleaseView({
      viewDir: options.releaseRoot,
      previous,
      next,
      localRoot: options.localRoot,
      baseRoot: options.baseRoot,
    })
    transport.supplemented = supplemented.supplemented.length
    transport.unresolved = supplemented.unresolved.length
  }

  const progress = resolveProgressWriter(options)
  const local = await engine.scanTree(options.localRoot)
  const pins = options.pinsPath ? await engine.loadPins(options.pinsPath) : []
  const tombstones = options.tombstonesPath ? await engine.loadTombstones(options.tombstonesPath) : []
  const plan = await engine.buildPlan({
    fromVersion: options.fromVersion ?? null,
    toVersion: options.toVersion,
    previous,
    next,
    local,
    localRoot: options.localRoot,
    baseRoot: options.baseRoot,
    releaseRoot: options.releaseRoot,
    pins,
    tombstones,
  })
  progress?.(`apply: plan ${plan.actions.length} actions (switch ${plan.switchDecision})${plan.conflicts.length > 0 ? ` — ${plan.conflicts.length} conflict(s)` : ''}`)
  const applied = await engine.applyPlan({
    plan,
    localRoot: options.localRoot,
    baseRoot: options.baseRoot,
    releaseRoot: options.releaseRoot,
    stagingRoot: options.stagingRoot,
    journalPath: options.journalPath,
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
    ...(options.backupDir === undefined ? {} : { backupDir: options.backupDir }),
    ...(options.stopAfterActions === undefined ? {} : { stopAfterActions: options.stopAfterActions }),
    ...(progress === null ? {} : {
      progress: update => {
        if (update.phase === 'starting') {
          progress('apply: seeding the staging tree from the installed version…')
          return
        }
        if (update.phase === 'verifying') {
          progress(`verify: checking the staged tree against ${options.toVersion}…`)
          return
        }
        progress(formatApplyProgress(plan, update.processed, update.bytesWritten))
      },
    }),
    ...(options.progressEveryActions === undefined ? {} : { progressEveryActions: options.progressEveryActions }),
    ...(options.progressEveryBytes === undefined ? {} : { progressEveryBytes: options.progressEveryBytes }),
  })
  if (progress !== null) {
    const verification = applied.verification
    progress(
      `apply: ${applied.status}`
      + (verification === null
        ? ''
        : ` — verification ${verification.ok ? 'ok' : 'failed'} (${verification.manifestChecked + verification.preservedChecked} paths checked)`),
    )
  }
  const exitCode = applied.status === 'aborted'
    ? 3
    : applied.status === 'rollback-required'
      ? 4
      : applied.status === 'failed'
        ? 1
        : 0
  let baseArchive = null
  let baseArchiveError = null
  if (options.persistBasePath !== undefined && exitCode === 0) {
    try {
      baseArchive = await synthesizePristineArchive({
        plan,
        stagingRoot: options.stagingRoot,
        releaseRoot: options.releaseRoot,
        outPath: options.persistBasePath,
        toVersion: options.toVersion,
        ...(progress === null ? {} : { progress }),
      })
    } catch (error) {
      // Never fail the update over a missing base: the next update degrades to
      // keep-local + sidecar exactly as it would without this lane.
      baseArchiveError = error instanceof Error ? error.message : String(error)
      process.stderr.write(`update-delta: merge base not retained (${baseArchiveError})\n`)
    }
  }
  const result = {
    schema: 'dsh-update-apply/1',
    fromVersion: options.fromVersion ?? null,
    toVersion: options.toVersion,
    status: applied.status,
    exitCode,
    detail: applied.detail,
    transport,
    plan: {
      actions: plan.actions.length,
      counts: plan.counts,
      conflicts: plan.conflicts.length,
      switchDecision: plan.switchDecision,
      fingerprint: plan.fingerprint,
    },
    report: applied.report,
    verification: applied.verification,
    liveTreeIntact: applied.liveTreeIntact,
    bytesWritten: applied.bytesWritten,
    wroteActions: applied.wroteActions,
    resumed: applied.resumed,
    backupDir: applied.backupDir,
    stagingRoot: applied.stagingRoot,
    journalPath: applied.journalPath,
    baseArchive,
    baseArchiveError,
  }
  return { status: applied.status, exitCode, result, plan, transport, view }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { diff: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    if (arg === '--diff') args.diff.push(value)
    else args[arg.slice(2)] = value
    i += 1
  }
  return args
}

function requireArg(args, name) {
  if (!args[name]) throw new Error(`missing --${name}`)
  return args[name]
}

const USAGE = `usage: update-delta.mjs apply --engine <bundle.js> --local <dir> --base <dir>
       --release <dir> --previous <manifest> --next <manifest> --staging <dir>
       --journal <file> --to-version <v> [--from-version <v>] [--diff <archive>]...
       [--backup <dir>] [--pins <file>] [--tombstones <file>]
       [--stop-after-actions <n>] [--timestamp <iso>] [--platform <os-arch>]
       [--base-mode <retained|cache|empty>] [--persist-base <archive.tar>]
       [--progress-fd <n>] [--progress-every-actions <n>]
       [--progress-every-bytes <n>] [--out <result.json>]

Progress lines (plain stderr-style text) go to <n> when a descriptor >= 3 is
open; without it nothing is emitted and behavior is unchanged.`

/**
 * Run the CLI.
 * @param {string[]} argv arguments after the program name
 * @returns {Promise<number>} process exit code
 */
export async function main(argv) {
  const [command, ...rest] = argv
  if (command === '--help' || command === '-h' || command === undefined) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (command !== 'apply') throw new Error(`unknown command: ${command}`)
  const args = parseArgs(rest)
  const stopAfter = args['stop-after-actions']
  const options = {
    enginePath: requireArg(args, 'engine'),
    localRoot: requireArg(args, 'local'),
    baseRoot: requireArg(args, 'base'),
    releaseRoot: requireArg(args, 'release'),
    previousPath: requireArg(args, 'previous'),
    nextPath: requireArg(args, 'next'),
    stagingRoot: requireArg(args, 'staging'),
    journalPath: requireArg(args, 'journal'),
    toVersion: requireArg(args, 'to-version'),
    fromVersion: args['from-version'],
    diffArchives: args.diff,
    platform: args.platform,
    baseMode: args['base-mode'],
    ...(args.backup === undefined ? {} : { backupDir: args.backup }),
    ...(args.pins === undefined ? {} : { pinsPath: args.pins }),
    ...(args.tombstones === undefined ? {} : { tombstonesPath: args.tombstones }),
    ...(args.timestamp === undefined ? {} : { timestamp: args.timestamp }),
    ...(stopAfter === undefined ? {} : { stopAfterActions: Number.parseInt(stopAfter, 10) }),
    ...(args['persist-base'] === undefined ? {} : { persistBasePath: args['persist-base'] }),
    ...(args['progress-fd'] === undefined ? {} : { progressFd: Number.parseInt(args['progress-fd'], 10) }),
    ...(args['progress-every-actions'] === undefined ? {} : { progressEveryActions: Number.parseInt(args['progress-every-actions'], 10) }),
    ...(args['progress-every-bytes'] === undefined ? {} : { progressEveryBytes: Number.parseInt(args['progress-every-bytes'], 10) }),
  }
  const outcome = await runApplyPipeline(options)
  if (args.out !== undefined) fs.writeFileSync(args.out, `${JSON.stringify(outcome.result, null, 2)}\n`)
  process.stdout.write(outcome.result.report.human)
  return outcome.exitCode
}

// The updater streams this module into `node --input-type=module -` when no
// local copy exists; a stdin module's import.meta.url never matches argv[1],
// so that invocation sets DSH_UPDATE_DELTA_MAIN=1 to select main().
const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href
const isMain = (invokedPath !== undefined && import.meta.url === invokedPath) || process.env.DSH_UPDATE_DELTA_MAIN === '1'
if (isMain) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(error => {
      process.stderr.write(`update-delta: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(2)
    })
}
