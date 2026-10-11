#!/usr/bin/env node
/**
 * Release manifest + consecutive-diff generator for harness-release.yml.
 *
 * Both artifacts are produced from the already-staged, pruned release tree; no
 * build or source access is needed. GZIP only: node's zlib for the manifest,
 * the platform's tar (present on every runner and every device) with `-z` for
 * the diff. No package dependencies.
 *
 * ── Manifest schema: "dsh-release-manifest/1" ──────────────────────────────
 * Gzipped JSON, one line, top-level object:
 *
 *   {
 *     "schema": "dsh-release-manifest/1",
 *     "version": "<release version>",        e.g. "0.1.7-enpoi.2.58"
 *     "platform": "<os>-<arch>",             e.g. "linux-x64"
 *     "entries": [ <entry>, ... ]            sorted by path bytes
 *   }
 *
 * Every shipped path is one entry, paths relative to the tree root with POSIX
 * separators, no leading "./", directories without a trailing slash; the tree
 * root itself is not listed. Entry fields:
 *
 *   path    string        relative path
 *   type    "file" | "symlink" | "dir"
 *   mode    4-digit octal string of the permission bits (st_mode & 0o7777)
 *   size    number        file bytes; symlink target-string byte length; 0 for dirs
 *   sha256  string | null file bytes; sha256 of the target string for symlinks; null for dirs
 *   target  string | null symlink target; null for files and dirs
 *   binary  boolean       true when a regular file has a NUL byte in its first
 *                         8192 bytes; false for symlinks and directories
 *
 * These are the update engine's canonical manifest rules
 * (packages/host/update-engine/src/manifest.ts, `scanTree`): symlinks hash
 * their target string and are never dereferenced, directories carry a null
 * hash and size 0, and modes are POSIX permission bits. `toCanonicalManifest`
 * projects a document onto the engine's manifest map; the cross-check suite in
 * scripts/release-delta.spec.ts proves that projection serializes
 * byte-identically to the engine's own scan of the same tree.
 *
 * Ordering is byte-wise (Buffer.compare over UTF-8 path bytes), so the same
 * tree always produces the same entry order. A sidecar
 * `<manifest>.sha256` in sha256sum format is written next to every artifact
 * so harness-release.yml's SHA256SUMS assembly covers it unchanged.
 *
 * ── Diff artifact layout ────────────────────────────────────────────────────
 * `diff-<platform>-<from>-<to>.tar.gz` contains the new/changed files and
 * symlinks (full bytes), new directories, and a reserved `.dsh-diff/` metadata
 * directory:
 *
 *   .dsh-diff/deleted.txt       paths present in <from>, absent from <to>
 *                               (sorted; one per line)
 *   .dsh-diff/mode-changes.txt  "path<TAB>oldMode<TAB>newMode" for entries whose
 *                               mode changed with identical content (sorted)
 *   .dsh-diff/diff.json         {"schema":"dsh-release-diff/1", from, to,
 *                               platform, counts, sizes}
 *
 * A change is judged by the engine's release-identity rule (`entryEquals`):
 * kind, mode, content hash, and symlink target. A symlink whose target changed
 * is a content change and rides the archive; a mode-only change is recorded in
 * mode-changes.txt because the archive carries no new bytes. Size and the
 * derived binary flag never decide a change.
 *
 * A diff is best-effort: it describes exactly the difference between two
 * manifests. An empty diff (no changes) still produces a valid archive with
 * only the metadata directory.
 *
 * CLI:
 *   node scripts/release-delta.mjs manifest --tree DIR --platform P \
 *     --version V --out FILE.json.gz
 *   node scripts/release-delta.mjs diff --tree DIR --platform P \
 *     --from A --to B --old OLD.json.gz --new NEW.json.gz --out FILE.tar.gz
 *
 * Both commands print a one-line JSON summary to stdout.
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

export const MANIFEST_SCHEMA = 'dsh-release-manifest/1'
export const DIFF_SCHEMA = 'dsh-release-diff/1'

/** Reserved metadata directory inside a diff archive. */
export const DIFF_META_DIR = '.dsh-diff'

/** NUL-byte probe window for binary classification (engine parity). */
export const BINARY_PROBE_BYTES = 8192

const MODE_MASK = 0o7777

function modeString(mode) {
  return (mode & MODE_MASK).toString(8).padStart(4, '0')
}

function pathCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
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

/**
 * Hash a regular file and classify it with the engine's probe: sha256 over
 * every byte, `binary` true when a NUL byte appears in the first
 * {@link BINARY_PROBE_BYTES} bytes.
 * @param {string} file absolute or relative file path
 * @returns {{sha256: string, size: number, binary: boolean}}
 */
function hashFileSync(file) {
  const hash = crypto.createHash('sha256')
  const probe = Buffer.alloc(BINARY_PROBE_BYTES)
  let probeLength = 0
  let size = 0
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(1 << 20)
  try {
    let read = 0
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read))
      size += read
      if (probeLength < BINARY_PROBE_BYTES) {
        const take = Math.min(BINARY_PROBE_BYTES - probeLength, read)
        buf.copy(probe, probeLength, 0, take)
        probeLength += take
      }
    }
  } finally {
    fs.closeSync(fd)
  }
  return { sha256: hash.digest('hex'), size, binary: probe.subarray(0, probeLength).includes(0) }
}

/**
 * Walk a tree and return its manifest entries with the engine's canonical
 * rules (sorted by path bytes). Symlinks hash their target string and are
 * never dereferenced; directories carry `sha256: null`, `size: 0`; regular
 * files hash their bytes and carry the NUL-probe `binary` flag.
 * @param {string} treeRoot absolute or relative tree root
 * @returns {{path: string, type: string, mode: string, size: number, sha256: string | null, target: string | null, binary: boolean}[]}
 */
export function buildManifest(treeRoot) {
  const entries = []
  const walk = (rel) => {
    const dir = rel ? path.join(treeRoot, rel) : treeRoot
    const names = fs.readdirSync(dir)
    names.sort(pathCompare)
    for (const name of names) {
      const relPath = rel ? `${rel}/${name}` : name
      const abs = path.join(treeRoot, relPath)
      const st = fs.lstatSync(abs)
      if (st.isSymbolicLink()) {
        const target = fs.readlinkSync(abs)
        entries.push({
          path: relPath,
          type: 'symlink',
          mode: modeString(st.mode),
          size: Buffer.byteLength(target),
          sha256: crypto.createHash('sha256').update(target).digest('hex'),
          target,
          binary: false,
        })
      } else if (st.isDirectory()) {
        entries.push({ path: relPath, type: 'dir', mode: modeString(st.mode), size: 0, sha256: null, target: null, binary: false })
        walk(relPath)
      } else if (st.isFile()) {
        const hashed = hashFileSync(abs)
        entries.push({
          path: relPath,
          type: 'file',
          mode: modeString(st.mode),
          size: hashed.size,
          sha256: hashed.sha256,
          target: null,
          binary: hashed.binary,
        })
      } else {
        throw new Error(`unsupported entry type at ${relPath}: only files, symlinks and directories may ship`)
      }
    }
  }
  walk('')
  entries.sort((a, b) => pathCompare(a.path, b.path))
  return entries
}

/**
 * Serialize a manifest document (one-line JSON + trailing newline).
 * @param {object[]} entries manifest entries, already sorted
 * @param {string} version release version
 * @param {string} platform os-arch pair
 * @returns {string} JSON text with a trailing newline
 */
export function manifestDocument(entries, version, platform) {
  return `${JSON.stringify({ schema: MANIFEST_SCHEMA, version, platform, entries })}\n`
}

/**
 * Reject a manifest path that could escape its tree root or smuggle control
 * characters (engine parity: `assertSafeRelPath`, plus the updater's
 * diff-extraction rule so the emitter and the apply side agree).
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
 * POSIX permission bits from an octal string or a number (engine parity:
 * `parseMode`); the result is masked with `& 0o7777`.
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

/**
 * Validate one document entry against the engine's manifest rules and return
 * its canonical projection.
 * @param {unknown} entry document entry
 * @param {string} label label used in error messages
 * @returns {{sha256: string | null, size: number, type: string, mode: number, target: string | null, binary: boolean}}
 */
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
 * Validate a manifest document: schema, entry shape, and path safety against
 * traversal. Every read of a manifest goes through this check.
 * @param {unknown} doc parsed document
 * @param {string} source label used in error messages
 * @returns {object} the validated document
 */
export function validateManifestDocument(doc, source = 'manifest') {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${source}: expected a JSON object mapping paths to entries`)
  }
  const record = /** @type {Record<string, unknown>} */ (doc)
  if (record.schema !== MANIFEST_SCHEMA) throw new Error(`${source}: not a ${MANIFEST_SCHEMA} document`)
  if (!Array.isArray(record.entries)) throw new Error(`${source}: entries must be an array`)
  for (const entry of record.entries) {
    const label = entry !== null && typeof entry === 'object' && 'path' in entry ? `${source}:${String(entry.path)}` : source
    canonicalEntry(entry, label)
  }
  return doc
}

/**
 * Project a manifest document onto the update engine's manifest map
 * (`path -> {sha256, size, type, mode, target, binary}`), validating every
 * path and entry first. Serializing the result with the engine's
 * `serializeManifest` is byte-identical to scanning the same tree.
 * @param {object} doc validated or unvalidated manifest document
 * @param {string} source label used in error messages
 * @returns {Record<string, {sha256: string | null, size: number, type: string, mode: number, target: string | null, binary: boolean}>}
 */
export function toCanonicalManifest(doc, source = 'manifest') {
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
 * Compare two entries for release identity with the engine's `entryEquals`
 * rule: kind, mode, content hash, and symlink target. Size and the derived
 * binary flag do not participate.
 * @param {{type: string, mode: number | string, sha256?: string | null, target?: string | null}} left first entry
 * @param {{type: string, mode: number | string, sha256?: string | null, target?: string | null}} right second entry
 * @returns {boolean} true when the entries describe the same shipped path state
 */
export function entriesEqual(left, right) {
  return left.type === right.type
    && modeNumber(left.mode) === modeNumber(right.mode)
    && (left.sha256 ?? null) === (right.sha256 ?? null)
    && (left.target ?? null) === (right.target ?? null)
}

/** sha256sum-format sidecar next to an artifact, so SHA256SUMS picks it up. */
export function writeSha256Sidecar(file) {
  const digest = sha256FileSync(file)
  fs.writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`)
  return digest
}

/**
 * Write `<out>` (gzipped manifest) and its sidecar.
 * @param {{tree: string, platform: string, version: string, out: string}} options manifest inputs
 * @returns {{entries: number, files: number, symlinks: number, dirs: number, jsonBytes: number, gzBytes: number, sha256: string}}
 */
export function writeManifest({ tree, platform, version, out }) {
  const entries = buildManifest(tree)
  const json = manifestDocument(entries, version, platform)
  const jsonBytes = Buffer.byteLength(json)
  const gz = zlib.gzipSync(Buffer.from(json))
  fs.writeFileSync(out, gz)
  const sha256 = writeSha256Sidecar(out)
  const counts = { file: 0, symlink: 0, dir: 0 }
  for (const entry of entries) counts[entry.type] += 1
  return {
    entries: entries.length,
    files: counts.file,
    symlinks: counts.symlink,
    dirs: counts.dir,
    jsonBytes,
    gzBytes: gz.length,
    sha256,
  }
}

/**
 * Read a manifest from a path or Buffer, transparently handling gzip, and
 * validate it (schema, entries, path traversal).
 * @param {string | Buffer} source file path or raw bytes
 * @returns {object} validated manifest document
 */
export function readManifest(source) {
  const raw = Buffer.isBuffer(source) ? source : fs.readFileSync(source)
  const json = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw
  let doc
  try {
    doc = JSON.parse(json.toString('utf8'))
  } catch (error) {
    throw new Error(`manifest: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return validateManifestDocument(doc)
}

/**
 * Compare two manifest documents. A path is `changed` when it is new, its
 * kind/content-hash/symlink-target differ; it lands in `modeChanges` when
 * only its mode changed; a path present in <from>, absent from <to>, is
 * `deleted`. Mirrors the engine's `entryEquals` release-identity rule.
 * @param {object} oldManifest previous manifest document
 * @param {object} newManifest new manifest document
 * @returns {{changed: object[], changedBytes: number, modeChanges: {path: string, oldMode: string, newMode: string}[], deleted: string[]}}
 */
export function computeDiff(oldManifest, newManifest) {
  const oldEntries = new Map(oldManifest.entries.map(entry => [entry.path, entry]))
  const newEntries = new Map(newManifest.entries.map(entry => [entry.path, entry]))
  const changed = []
  const modeChanges = []
  let changedBytes = 0

  for (const [relPath, next] of newEntries) {
    const prev = oldEntries.get(relPath)
    if (prev) {
      if (entriesEqual(prev, next)) continue
      const contentSame = prev.type === next.type
        && (prev.sha256 ?? null) === (next.sha256 ?? null)
        && (prev.target ?? null) === (next.target ?? null)
      if (contentSame) {
        modeChanges.push({ path: relPath, oldMode: prev.mode, newMode: next.mode })
        continue
      }
    }
    changed.push(next)
    if (next.type === 'file') changedBytes += next.size
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

function writeMeta(treeDir, name, content) {
  fs.writeFileSync(path.join(treeDir, DIFF_META_DIR, name), content)
}

/**
 * Write `diff-<platform>-<from>-<to>.tar.gz` (plus sidecar) by packing the
 * changed/new tree entries and the reserved `.dsh-diff/` metadata directory.
 * Entries are hardlinked from `tree` into a scratch directory (copied when the
 * filesystem cannot link) so tar reads the real bytes without touching the
 * staged tree. `--no-recursion` keeps listed directories to their own entry.
 * @param {{tree: string, oldManifest: object, newManifest: object, platform: string, from: string, to: string, out: string}} options diff inputs
 * @returns {{changed: number, changedBytes: number, deleted: number, modeChanges: number, diffBytes: number, sha256: string}}
 */
export function writeDiff({ tree, oldManifest, newManifest, platform, from, to, out }) {
  const { changed, changedBytes, modeChanges, deleted } = computeDiff(oldManifest, newManifest)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-release-diff-'))
  try {
    for (const entry of changed) {
      const dest = path.join(scratch, entry.path)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      if (entry.type === 'file') {
        const src = path.join(tree, entry.path)
        try {
          fs.linkSync(src, dest)
        } catch {
          fs.copyFileSync(src, dest)
          fs.chmodSync(dest, modeNumber(entry.mode))
        }
      } else if (entry.type === 'symlink') {
        fs.symlinkSync(entry.target, dest)
      } else {
        fs.mkdirSync(dest, { recursive: true })
        fs.chmodSync(dest, modeNumber(entry.mode))
      }
    }
    fs.mkdirSync(path.join(scratch, DIFF_META_DIR), { recursive: true })
    writeMeta(scratch, 'deleted.txt', deleted.length ? `${deleted.join('\n')}\n` : '')
    writeMeta(
      scratch,
      'mode-changes.txt',
      modeChanges.length ? `${modeChanges.map(c => `${c.path}\t${c.oldMode}\t${c.newMode}`).join('\n')}\n` : '',
    )
    writeMeta(
      scratch,
      'diff.json',
      `${JSON.stringify({
        schema: DIFF_SCHEMA,
        platform,
        from,
        to,
        changed: changed.length,
        changedBytes,
        deleted: deleted.length,
        modeChanges: modeChanges.length,
      })}\n`,
    )

    const members = [
      ...changed.map(entry => entry.path),
      `${DIFF_META_DIR}/deleted.txt`,
      `${DIFF_META_DIR}/mode-changes.txt`,
      `${DIFF_META_DIR}/diff.json`,
    ].sort(pathCompare)
    const listFile = path.join(scratch, DIFF_META_DIR, 'members.txt')
    fs.writeFileSync(listFile, `${members.join('\n')}\n`)

    const outAbs = path.resolve(out)
    // The -T list path must be absolute: tar opens it relative to the process
    // cwd, not to -C, while the members inside are relative to -C.
    const result = spawnSync(
      'tar',
      ['-C', scratch, '--no-recursion', '-czf', outAbs, '-T', listFile],
      { encoding: 'utf8' },
    )
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`tar failed (${result.status}): ${(result.stderr ?? '').trim()}`)
    const diffBytes = fs.statSync(outAbs).size
    const sha256 = writeSha256Sidecar(outAbs)
    return { changed: changed.length, changedBytes, deleted: deleted.length, modeChanges: modeChanges.length, diffBytes, sha256 }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`)
    args[arg.slice(2)] = value
    i += 1
  }
  return args
}

function requireArg(args, name) {
  if (!args[name]) throw new Error(`missing --${name}`)
  return args[name]
}

function main(argv) {
  const [command, ...rest] = argv
  if (command === 'manifest') {
    const args = parseArgs(rest)
    const stats = writeManifest({
      tree: requireArg(args, 'tree'),
      platform: requireArg(args, 'platform'),
      version: requireArg(args, 'version'),
      out: requireArg(args, 'out'),
    })
    process.stdout.write(`${JSON.stringify({ command, out: args.out, ...stats })}\n`)
    return
  }
  if (command === 'diff') {
    const args = parseArgs(rest)
    const stats = writeDiff({
      tree: requireArg(args, 'tree'),
      platform: requireArg(args, 'platform'),
      from: requireArg(args, 'from'),
      to: requireArg(args, 'to'),
      oldManifest: readManifest(requireArg(args, 'old')),
      newManifest: readManifest(requireArg(args, 'new')),
      out: requireArg(args, 'out'),
    })
    process.stdout.write(`${JSON.stringify({ command, out: args.out, ...stats })}\n`)
    return
  }
  throw new Error('usage: release-delta.mjs manifest|diff --help via source header')
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href
if (invokedPath !== undefined && import.meta.url === invokedPath) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`release-delta: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
