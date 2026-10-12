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
 * Scan index: on by default (doc 97 §3). `--no-index` or DSH_SCAN_INDEX=0
 * forces full content scans (the escape hatch).
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
import { isatty } from 'node:tty'
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
 * sha256 of a UTF-8 string.
 * @param text - Input text.
 * @returns Lowercase hex digest.
 */
export function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/**
 * Cheap layout probe: read the first member name and stop the tar stream
 * (SIGTERM once the first line is in hand), so a release-sized archive is not
 * scanned twice just to learn its top-level layout.
 */
function probeBasePrefixed(archivePath) {
  return new Promise((resolve) => {
    const child = spawn('tar', [archivePath.endsWith('.gz') ? '-tzf' : '-tf', archivePath])
    let first = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try {
        child.kill('SIGTERM')
      } catch {
        // already gone
      }
      resolve(value)
    }
    child.stdout?.on('data', chunk => {
      if (first === '') {
        first = chunk.toString().split('\n')[0] ?? ''
        if (first !== '') finish(first)
      }
    })
    child.once('error', () => finish(''))
    child.once('close', () => finish(first))
  })
}

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
  let tty = options.progressTty === true
  if (!tty) {
    try {
      tty = isatty(fd)
    } catch {
      tty = false
    }
  }
  const write = (text) => {
    try {
      fs.writeSync(fd, text)
    } catch {
      // A closed or unwritable progress fd must never fail an update.
    }
  }
  const width = () => {
    const columns = process.stdout.columns ?? process.stderr.columns ?? 100
    return Math.max(24, Math.min(500, columns)) - 1
  }
  const clip = (text) => {
    if (text.length <= width()) return text
    return `${text.slice(0, Math.max(1, width() - 1))}…`
  }
  let tickActive = false
  let lastPlainTickAt = 0
  const writer = (line) => {
    if (tickActive) {
      write('\r\u001b[K')
      tickActive = false
    }
    write(`${line}\n`)
  }
  // A tick is a single rewriting frame on a TTY; on a non-TTY (logs) it is
  // throttled to one plain line every 5 s so the operator gets the shape
  // without line spam.
  writer.tick = (line) => {
    if (tty) {
      write(`\r\u001b[K${clip(line)}`)
      tickActive = true
      return
    }
    const now = Date.now()
    if (now - lastPlainTickAt < 5000) return
    lastPlainTickAt = now
    write(`${line}\n`)
  }
  writer.finish = () => {
    if (tickActive) {
      write('\r\u001b[K')
      tickActive = false
    }
  }
  writer.tty = tty
  return writer
}

// ── merge base materialization ──────────────────────────────────────────────
// A release base archive holds the whole installed tree (node_modules and
// all). Extracting it in full on every delta update is minutes of silent I/O
// for bytes the plan will almost never read. The engine consumes base bytes
// only for: (a) merge candidates — release changed the path AND the local copy
// diverges from the installed release; (b) supplement candidates — release
// content unchanged but the mode changed or the local copy is missing, where
// the local bytes cannot serve. Only those members are extracted; everything
// else is never materialized. A missing member degrades exactly like today's
// no-base path (keep-local + shipped sidecar), never a wrong merge.

/**
 * Base members the plan can need, derived from the three manifests before the
 * plan exists: file merges (release changed, local diverged) plus supplement
 * restores (release content unchanged, mode-only or locally missing).
 * `package.json` is always included as the layout sentinel.
 * @param previous - Installed release manifest.
 * @param next - Target release manifest.
 * @param local - Local tree manifest.
 * @returns Sorted relative paths (always including `package.json` when known).
 */
export function baseCandidates(previous, next, local) {
  const candidates = []
  for (const [relPath, shipped] of Object.entries(next)) {
    if (shipped.type !== 'file') continue
    const prev = previous[relPath]
    const localEntry = local[relPath]
    if (prev !== undefined && prev.type === 'file') {
      if (!contentEqual(prev, shipped)) {
        // Release changed it: base bytes are needed only when the local copy
        // also diverges from the installed release (both-changed merge).
        if (localEntry !== undefined && localEntry.type === 'file' && !contentEqual(localEntry, prev)) candidates.push(relPath)
      } else {
        // Release content unchanged: supplement reads base only for mode-only
        // changes and locally missing files.
        const modeOnly = (prev.mode ?? 0) !== (shipped.mode ?? 0)
        const locallyMissing = localEntry === undefined
        if (modeOnly || locallyMissing) candidates.push(relPath)
      }
    }
  }
  if (previous['package.json']?.type === 'file' || next['package.json']?.type === 'file') candidates.push('package.json')
  return [...new Set(candidates)].sort()
}

function baseMarkerPath(baseDir) {
  return path.join(baseDir, '.dsh-base-manifest.json')
}

function readBaseMarker(baseDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(baseMarkerPath(baseDir), 'utf8'))
    return doc !== null && typeof doc === 'object' ? doc : null
  } catch {
    return null
  }
}

function writeBaseMarker(baseDir, marker) {
  const file = baseMarkerPath(baseDir)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

function wipeBaseDir(baseDir) {
  for (const entry of fs.readdirSync(baseDir)) {
    fs.rmSync(path.join(baseDir, entry), { recursive: true, force: true })
  }
}

/** A safe archive member name (contains no traversal or control characters). */
function assertSafeBaseMember(name) {
  if (name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error(`unsafe base archive member: ${JSON.stringify(name)}`)
  }
  const segments = name.split('/')
  if (segments.some(segment => segment === '..')) throw new Error(`unsafe base archive member: ${JSON.stringify(name)}`)
}

/**
 * Parse `tar -tv` long-format output into member names and sizes.
 * @param output - Listing text.
 * @returns Members in listing order.
 */
export function parseBaseListing(output) {
  const members = []
  // GNU long format: `perm user/group size YYYY-MM-DD HH:MM name`;
  // bsdtar prints the owner and group as separate columns and its own time
  // (month-day forms on some versions). The date anchor keeps the owner
  // count tolerant while the size stays the numeric field before it.
  const tail = '(?:\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}|\\S+\\s+\\d+\\s+\\d{2}:\\d{2}|\\S+\\s+\\d+\\s+\\d{4})'
  const pattern = new RegExp(`^(\\S+)\\s+(?:\\S+\\s+){1,2}(\\d+)\\s+${tail}\\s+(.+)$`, 'u')
  for (const raw of output.split('\n')) {
    if (raw.trim() === '') continue
    const match = pattern.exec(raw)
    if (match === null) continue
    const perm = match[1] ?? ''
    const size = Number.parseInt(match[2] ?? '0', 10)
    const rest = match[3] ?? ''
    const name = rest.split(' -> ')[0] ?? ''
    if (name === '') continue
    assertSafeBaseMember(name)
    members.push({ name, size, directory: perm.startsWith('d') })
  }
  return members
}

/**
 * Strip a single top-level directory (or `./`) and return the relative path,
 * or null when the member cannot map to a tree path.
 * @param name - Member name.
 * @param layout - Detected layout.
 * @returns Relative path or null for directory entries.
 */
export function memberRelPath(name, layout) {
  let rel = name
  if (rel.endsWith('/')) rel = rel.slice(0, -1)
  if (layout.prefixed) {
    const slash = rel.indexOf('/')
    if (slash === -1) return null
    rel = rel.slice(slash + 1)
  }
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (rel === '' || rel === '.') return null
  return rel
}

function detectBaseLayout(members) {
  const names = members.map(member => member.name).filter(name => !name.endsWith('/') || true)
  if (names.length === 0) return { prefixed: false }
  let prefix = null
  for (const name of names) {
    const first = name.replace(/^\.\//u, '').split('/')[0] ?? ''
    if (first === '' || first === '.') return { prefixed: false }
    if (prefix === null) prefix = first
    else if (prefix !== first) return { prefixed: false }
  }
  return { prefixed: true, prefix }
}

/**
 * Verify the materialized candidate files against the installed release
 * hashes. Mismatching files are removed (their path degrades to the no-base
 * behavior) and reported.
 */
function verifyMaterialized(baseDir, expected, previous) {
  const missing = []
  let present = 0
  let bytes = 0
  for (const item of expected) {
    const file = joinRel(baseDir, item.rel)
    let stats = null
    try {
      stats = fs.lstatSync(file)
    } catch {
      stats = null
    }
    if (stats === null || !stats.isFile()) {
      missing.push(item.rel)
      continue
    }
    const expectedSha = previous[item.rel]?.sha256 ?? null
    if (expectedSha !== null && sha256FileSync(file) !== expectedSha) {
      fs.rmSync(file, { force: true })
      missing.push(item.rel)
      continue
    }
    present += 1
    bytes += stats.size
  }
  return { present, bytes, missing }
}

/**
 * Extract members (or the whole archive) with a ticked heartbeat. Plain
 * progress lines every `tickMs`; the tar child is killed on failure.
 */
async function runBaseExtract(options) {
  const { archivePath, baseDir, tickMs, emit } = options
  const args = ['-x', '-f', archivePath, '-C', baseDir]
  if (archivePath.endsWith('.gz')) args.splice(1, 0, '-z')
  if (options.prefixed) args.push('--strip-components=1')
  args.push('-v')
  let listFile = null
  if (options.members !== undefined) {
    listFile = `${baseDir}.members-${process.pid}.txt`
    fs.writeFileSync(listFile, `${options.members.join('\n')}\n`)
    args.push('-T', listFile)
  }
  const startedAt = Date.now()
  let files = 0
  let output = ''
  const child = spawn('tar', args)
  const ticker = setInterval(() => {
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    if (options.expectedBytes !== undefined && options.candidateRels !== undefined) {
      let written = 0
      for (const rel of options.candidateRels) {
        try {
          written += fs.statSync(joinRel(baseDir, rel)).size
        } catch {
          // not extracted yet
        }
      }
      emit?.(`${options.label} ${formatBytes(written)} / ${formatBytes(options.expectedBytes)} (${elapsed}s)`)
    } else {
      emit?.(`${options.label} ${files.toLocaleString('en-US')} file(s) (${elapsed}s)`)
    }
  }, tickMs)
  child.stdout?.on('data', chunk => {
    output += chunk.toString()
    // Each -v line is one extracted member; keep the count cheap.
    files = output.split('\n').length - 1
  })
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += chunk.toString() })
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    if (code !== 0) throw new Error(`tar failed (${code}): ${stderr.trim() || 'no stderr'}`)
  } finally {
    clearInterval(ticker)
    if (listFile !== null) fs.rmSync(listFile, { force: true })
  }
  return files
}

/**
 * Materialize the merge base for one installed version. Selective extraction
 * into the keyed, reusable work directory; above `cap` candidates (or when
 * member listing/extraction fails) a full extraction into a transient sibling
 * runs instead, and the caller removes it afterwards.
 * @param options - Archive, work dir, manifests, cap and progress.
 * @returns Materialization result (mode, counts, missing paths, timing).
 */
export async function materializeBase(options) {
  const baseDir = options.baseDir
  const emit = typeof options.progress === 'function' ? options.progress : null
  const cap = options.cap ?? 2000
  const tickMs = options.tickMs ?? 3000
  const result = {
    mode: 'none',
    candidates: 0,
    members: 0,
    extracted: 0,
    missing: [],
    bytes: 0,
    expectedBytes: 0,
    ms: 0,
    reused: false,
    dir: baseDir,
  }
  fs.mkdirSync(baseDir, { recursive: true })
  const archivePath = options.archivePath
  if (archivePath === undefined || archivePath === '' || !fs.existsSync(archivePath)) return result
  const startedAt = Date.now()
  const candidates = [...(options.candidates ?? baseCandidates(options.previous, options.next, options.local))].sort()
  result.candidates = candidates.length
  const archiveSha = options.archiveSha ?? sha256FileSync(archivePath)

  // Full fallback: too many candidates to bother with, or unusable metadata.
  if (candidates.length > cap) {
    const fullDir = `${baseDir}.full-${process.pid}`
    fs.rmSync(fullDir, { recursive: true, force: true })
    fs.mkdirSync(fullDir, { recursive: true })
    emit?.(`merge base: ${candidates.length} candidate(s) exceed the cap ${cap}; extracting the full archive…`)
    // A cheap first-member probe gives the layout without a full listing.
    const firstMember = await probeBasePrefixed(archivePath)
    const firstSegment = (firstMember.trim().replace(/^\.\//u, '').split('/')[0] ?? '')
    const prefixed = firstSegment !== '' && firstSegment !== '.'
    await runBaseExtract({ archivePath, baseDir: fullDir, prefixed, tickMs, emit, label: 'merge base: extracting' })
    result.mode = 'full'
    result.dir = fullDir
    result.ms = Date.now() - startedAt
    emit?.(`merge base: full archive materialized at ${fullDir} in ${result.ms}ms`)
    return result
  }

  // Reuse check: a matching marker plus verified files skips extraction.
  const fingerprint = sha256Text(`${archiveSha}\n${candidates.join('\n')}`)
  const marker = readBaseMarker(baseDir)
  if (marker !== null && marker.fingerprint === fingerprint) {
    const expected = candidates
      .filter(rel => !(marker.missing ?? []).includes(rel))
      .map(rel => ({ rel }))
    const verified = verifyMaterialized(baseDir, expected, options.previous)
    if (verified.missing.length === 0) {
      result.mode = 'selective'
      result.reused = true
      result.extracted = verified.present
      result.bytes = verified.bytes
      result.expectedBytes = verified.bytes
      result.missing = [...(marker.missing ?? [])].sort()
      result.members = expected.length
      result.ms = Date.now() - startedAt
      emit?.(`merge base: reusing the materialized base (${verified.present} file(s), ${formatBytes(verified.bytes)})`)
      return result
    }
    // A previously materialized file is gone or corrupted: rebuild cleanly.
    wipeBaseDir(baseDir)
  }

  // Selective path: list members, map the candidates, extract only those.
  let listing = []
  try {
    const listed = spawnSync('tar', [archivePath.endsWith('.gz') ? '-tvzf' : '-tvf', archivePath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    if (listed.error) throw listed.error
    if (listed.status !== 0) throw new Error(`tar listing failed (${listed.status})`)
    listing = parseBaseListing(listed.stdout ?? '')
  } catch (error) {
    emit?.(`merge base: member listing failed (${error instanceof Error ? error.message : String(error)}); extracting the full archive…`)
    const fullDir = `${baseDir}.full-${process.pid}`
    fs.rmSync(fullDir, { recursive: true, force: true })
    fs.mkdirSync(fullDir, { recursive: true })
    await runBaseExtract({ archivePath, baseDir: fullDir, prefixed: false, tickMs, emit, label: 'merge base: extracting' })
    result.mode = 'full'
    result.dir = fullDir
    result.ms = Date.now() - startedAt
    return result
  }
  const layout = detectBaseLayout(listing)
  const membersByRel = new Map()
  for (const member of listing) {
    const rel = memberRelPath(member.name, layout)
    if (rel === null) continue
    membersByRel.set(rel, member)
  }
  const expected = []
  const missing = []
  let expectedBytes = 0
  for (const rel of candidates) {
    const member = membersByRel.get(rel)
    if (member === undefined) {
      missing.push(rel)
      continue
    }
    expected.push({ rel, member: member.name, size: member.size })
    expectedBytes += member.size
  }
  result.expectedBytes = expectedBytes
  result.members = expected.length
  if (expected.length === 0) {
    writeBaseMarker(baseDir, { schema: 'dsh-update-base/1', archive: path.basename(archivePath), archiveSha256: archiveSha, fingerprint, layout: layout.prefixed ? 'prefixed' : 'flat', members: 0, missing, extractedAt: new Date().toISOString() })
    result.mode = 'selective'
    result.missing = missing.sort()
    result.ms = Date.now() - startedAt
    return result
  }
  for (const entry of fs.readdirSync(baseDir)) {
    if (entry === '.dsh-base-manifest.json') continue
    fs.rmSync(path.join(baseDir, entry), { recursive: true, force: true })
  }
  emit?.(`merge base: extracting ${formatBytes(expectedBytes)} from ${path.basename(archivePath)} (${expected.length} of ${candidates.length} member(s))…`)
  await runBaseExtract({
    archivePath,
    baseDir,
    prefixed: layout.prefixed,
    members: expected.map(item => item.member),
    expectedBytes,
    candidateRels: expected.map(item => item.rel),
    tickMs,
    emit,
    label: 'merge base: extracting',
  })
  const verified = verifyMaterialized(baseDir, expected, options.previous)
  result.mode = 'selective'
  result.extracted = verified.present
  result.bytes = verified.bytes
  result.missing = [...new Set([...missing, ...verified.missing])].sort()
  writeBaseMarker(baseDir, {
    schema: 'dsh-update-base/1',
    archive: path.basename(archivePath),
    archiveSha256: archiveSha,
    fingerprint,
    layout: layout.prefixed ? 'prefixed' : 'flat',
    members: expected.length,
    missing: result.missing,
    extractedAt: new Date().toISOString(),
  })
  result.ms = Date.now() - startedAt
  emit?.(`merge base: extracted ${result.extracted} file(s), ${formatBytes(result.bytes)} in ${result.ms}ms${result.missing.length > 0 ? ` (${result.missing.length} missing; they keep local bytes with shipped sidecars)` : ''}`)
  return result
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
  const tmpArchive = `${outPath}.tmp-${process.pid}`
  const listShipped = `${outPath}.shipped-${process.pid}.txt`
  const listPreserved = `${outPath}.preserved-${process.pid}.txt`
  const omitted = []
  let estimateBytes = 0
  for (const action of plan.actions) {
    if (action.shipped?.type === 'file' && action.shipped.sha256 !== null) estimateBytes += action.shipped.size ?? 0
  }
  emit?.(`merge base: retaining the pristine merge base for ${options.toVersion ?? 'the installed version'} (≈ ${formatBytes(estimateBytes)})…`)
  try {
    // Build the archive straight from the verified staging tree and the
    // release view with member lists — no hardlink scratch tree. Hardlinking
    // bumped the staged inodes' ctime, which invalidated the scan index that
    // was just written (the next update would distrust every file).
    const shipped = []
    const preserved = []
    for (const action of plan.actions) {
      const shippedEntry = action.shipped
      if (shippedEntry === null || shippedEntry === undefined) continue
      if (shippedEntry.type === 'dir') continue
      if (shippedEntry.type === 'symlink') {
        // Symlinks are recreated in the scratch fallback; the direct-tar path
        // archives the staged symlink itself (same target, verified).
        shipped.push(action.path)
        continue
      }
      if (action.outcome.disposition === 'shipped') {
        shipped.push(action.path)
        continue
      }
      const viewSource = joinRel(releaseRoot, action.path)
      let stats = null
      try { stats = fs.lstatSync(viewSource) } catch { stats = null }
      if (stats !== null && stats.isFile() && sha256FileSync(viewSource) === shippedEntry.sha256) {
        preserved.push(action.path)
        continue
      }
      omitted.push(action.path)
    }
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
    try {
      const files = shipped.length + preserved.length
      await runTarWrite(tmpArchive, stagingRoot, shipped, releaseRoot, preserved)
      if (files === 0) {
        // Nothing to archive: still produce a valid empty tar.
        const empty = spawnSync('tar', ['-cf', tmpArchive, '--files-from', '/dev/null'], { encoding: 'utf8' })
        if (empty.status !== 0) throw new Error(`tar failed (${empty.status}): ${(empty.stderr ?? '').trim()}`)
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.renameSync(tmpArchive, outPath)
      const digest = sha256FileSync(outPath)
      fs.writeFileSync(`${outPath}.sha256`, `${digest}  ${path.basename(outPath)}\n`)
      const bytes = fs.statSync(outPath).size
      emit?.(`merge base: retained ${formatBytes(bytes)} at ${outPath}`)
      return { path: outPath, bytes, files, omitted }
    } finally {
      clearInterval(ticker)
    }
  } finally {
    fs.rmSync(tmpArchive, { force: true })
    fs.rmSync(listShipped, { force: true })
    fs.rmSync(listPreserved, { force: true })
  }
}

/** Create the archive from two member lists (create + append; no scratch tree). */
async function runTarWrite(outFile, stagingRoot, shipped, releaseRoot, preserved) {
  const writeList = (file, paths) => {
    fs.writeFileSync(file, paths.length === 0 ? '' : `${paths.join('\n')}\n`)
  }
  const run = (args) => new Promise((resolve, reject) => {
    let stderr = ''
    const child = spawn('tar', args)
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) reject(new Error(`tar failed (${code}): ${stderr.trim()}`))
      else resolve(undefined)
    })
  })
  const listShipped = `${outFile}.shipped-list.txt`
  const listPreserved = `${outFile}.preserved-list.txt`
  try {
    if (shipped.length > 0) {
      writeList(listShipped, shipped)
      await run(['-cf', outFile, '-C', stagingRoot, '-T', listShipped])
    } else {
      await run(['-cf', outFile, '--files-from', '/dev/null'])
    }
    if (preserved.length > 0) {
      writeList(listPreserved, preserved)
      await run(['-rf', outFile, '-C', releaseRoot, '-T', listPreserved])
    }
  } finally {
    fs.rmSync(listShipped, { force: true })
    fs.rmSync(listPreserved, { force: true })
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
  }

  const progress = resolveProgressWriter(options)
  // The one full-content walk of the update: emit ticks so the shell never
  // sits silent while a large local tree is hashed, and record its stats.
  let localScanFiles = 0
  let localScanBytes = 0
  const scanStartedAt = Date.now()
  const useIndex = options.useIndex ?? process.env.DSH_SCAN_INDEX !== '0'
  let scanIndexState = 'disabled'
  let scanTrusted = 0
  let scanHashed = 0
  const localStats = new Map()
  const local = await engine.scanTree(options.localRoot, {
    useIndex,
    collectStats: localStats,
    ...(progress === null ? {} : {
      onProgress: (tick) => {
        localScanFiles = tick.files
        localScanBytes = tick.bytes
        const text = `scan: hashing the installed tree — ${tick.files.toLocaleString('en-US')} files, ${formatBytes(tick.bytes)} read`
        if (typeof progress.tick === 'function') progress.tick(text)
        else progress(text)
      },
    }),
    onIndex: (info) => {
      scanIndexState = info.state
      scanTrusted = info.trusted
      scanHashed = info.hashed
    },
  })
  const localScanCompletedAt = Date.now()
  const localScanMs = localScanCompletedAt - scanStartedAt

  // Materialize only the base members the plan can read (§ merge base). Runs
  // after the local scan (candidates need it) and before the release-view
  // supplement (which resolves some paths against the base).
  let baseInfo = null
  if (typeof options.baseArchivePath === 'string' && options.baseArchivePath !== '') {
    baseInfo = await materializeBase({
      archivePath: options.baseArchivePath,
      baseDir: options.baseRoot,
      previous,
      next,
      local,
      ...(options.archiveSha === undefined ? {} : { archiveSha: options.archiveSha }),
      ...(options.candidateCap === undefined ? {} : { cap: options.candidateCap }),
      ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
      toVersion: options.toVersion,
      fromVersion: options.fromVersion ?? null,
      ...(progress === null ? {} : { progress }),
    })
    if (baseInfo.mode === 'full') transport.base = 'full-temporary'
    if (baseInfo.missing.length > 0) transport.baseMissing = baseInfo.missing.length
  }

  if (archives.length > 0) {
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
  const snapshotPaths = typeof engine.mutationTouchedPaths === 'function' ? engine.mutationTouchedPaths(plan).length : plan.actions.length
  const phaseAt = {}
  const stamp = (name) => {
    if (phaseAt[name] === undefined) phaseAt[name] = Date.now()
  }
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
        const tick = typeof progress.tick === 'function' ? progress.tick : progress
        if (update.phase === 'starting') {
          progress(`apply: working — snapshot ${snapshotPaths} guarded path(s), then seed the staging tree…`)
          return
        }
        if (update.phase === 'snapshot') {
          if (update.processed === 0) stamp('snapshotStart')
          if (update.processed >= update.total) stamp('snapshotEnd')
          const text = `apply: snapshot ${update.processed}/${update.total} guarded paths — ${formatBytes(update.bytesWritten)} read`
          // Phase start and completion are permanent lines; only in-flight
          // ticks rewrite (TTY) or throttle (logs).
          if (update.processed === 0 || update.processed >= update.total) progress(text)
          else tick(text)
          return
        }
        if (update.phase === 'seeding') {
          if (update.processed === 0) stamp('seedStart')
          if (update.processed >= update.total) stamp('seedEnd')
          const text = `apply: seeding ${update.processed}/${update.total} entries — ${formatBytes(update.bytesWritten)} linked`
          if (update.processed === 0 || update.processed >= update.total) progress(text)
          else tick(text)
          return
        }
        if (update.phase === 'verifying') {
          if (update.processed === 0) {
            stamp('verifyStart')
            progress(`verify: checking the staged tree against ${options.toVersion}…`)
          } else {
            tick(`verify: re-reading ${update.processed} file(s) not carried by hardlink seeds — ${formatBytes(update.bytesWritten)}`)
          }
          return
        }
        if (update.phase === 'applying' && update.processed >= update.total) stamp('applyEnd')
        const text = formatApplyProgress(plan, update.processed, update.bytesWritten)
        if (update.processed >= update.total) progress(text)
        else tick(text)
      },
    }),
    ...(options.progressEveryActions === undefined ? {} : { progressEveryActions: options.progressEveryActions }),
    ...(options.progressEveryBytes === undefined ? {} : { progressEveryBytes: options.progressEveryBytes }),
    ...(options.progressEverySteps === undefined ? {} : { progressEverySteps: options.progressEverySteps }),
    ...(options.progressEveryMs === undefined ? {} : { progressEveryMs: options.progressEveryMs }),
    localManifest: local,
    localScanCompletedAt,
    useIndex,
    localStats,
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
  const phaseEnd = Date.now()
  const phases = {
    seedMs: phaseAt.seedStart !== undefined && phaseAt.seedEnd !== undefined ? phaseAt.seedEnd - phaseAt.seedStart : null,
    applyMs: phaseAt.seedEnd !== undefined && phaseAt.applyEnd !== undefined ? phaseAt.applyEnd - phaseAt.seedEnd : null,
    verifyMs: phaseAt.verifyStart !== undefined ? phaseEnd - phaseAt.verifyStart : null,
  }
  // A full-fallback extraction is transient: it is large and never reused.
  if (baseInfo !== null && baseInfo.mode === 'full' && baseInfo.dir !== options.baseRoot) {
    fs.rmSync(baseInfo.dir, { recursive: true, force: true })
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
    stats: {
      localScan: {
        files: localScanFiles,
        bytes: localScanBytes,
        ms: localScanMs,
        trusted: scanTrusted,
        hashed: scanHashed,
        index: scanIndexState,
      },
      snapshotPaths,
      base: baseInfo,
      phases,
    },
  }
  return { status: applied.status, exitCode, result, plan, transport, view }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { diff: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    if (arg === '--no-index') {
      args['no-index'] = true
      continue
    }
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
       [--base-mode <retained|cache|empty>] [--base-archive <archive>]
       [--base-archive-sha <hex>] [--base-candidate-cap <n>] [--base-tick-ms <ms>]
       [--persist-base <archive.tar>]
       [--progress-fd <n>] [--progress-tty 1] [--progress-every-actions <n>]
       [--progress-every-bytes <n>] [--progress-every-steps <n>]
       [--progress-every-ms <n>] [--no-index] [--out <result.json>]

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
  if (command === 'refresh-index') {
    // Post-update index refresh (install.sh, after staging discard/prune):
    // hardlink churn bumps shared inode ctimes, so the tree that will be
    // scanned next needs its index restamped.
    const args = parseArgs(rest)
    const engine = await import(pathToFileURL(requireArg(args, 'engine')).href)
    const tree = requireArg(args, 'tree')
    if (typeof engine.refreshScanIndex !== 'function') {
      process.stdout.write('scan index: refresh unavailable in this engine\n')
      return 0
    }
    const startedAt = Date.now()
    const refreshed = await engine.refreshScanIndex(tree)
    const ms = Date.now() - startedAt
    process.stdout.write(refreshed === null
      ? 'scan index: no index to refresh\n'
      : `scan index: refreshed ${refreshed.entries} entries (${refreshed.carried} carried, ${refreshed.rehashed} rehashed) in ${ms}ms\n`)
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
    ...(args['progress-tty'] === '1' ? { progressTty: true } : {}),
    ...(args['progress-every-actions'] === undefined ? {} : { progressEveryActions: Number.parseInt(args['progress-every-actions'], 10) }),
    ...(args['progress-every-bytes'] === undefined ? {} : { progressEveryBytes: Number.parseInt(args['progress-every-bytes'], 10) }),
    ...(args['progress-every-steps'] === undefined ? {} : { progressEverySteps: Number.parseInt(args['progress-every-steps'], 10) }),
    ...(args['progress-every-ms'] === undefined ? {} : { progressEveryMs: Number.parseInt(args['progress-every-ms'], 10) }),
    ...(args['base-archive'] === undefined ? {} : { baseArchivePath: args['base-archive'] }),
    ...(args['base-archive-sha'] === undefined ? {} : { archiveSha: args['base-archive-sha'] }),
    ...(args['base-candidate-cap'] === undefined ? {} : { candidateCap: Number.parseInt(args['base-candidate-cap'], 10) }),
    ...(args['base-tick-ms'] === undefined ? {} : { tickMs: Number.parseInt(args['base-tick-ms'], 10) }),
    ...(args['no-index'] === true ? { useIndex: false } : {}),
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
