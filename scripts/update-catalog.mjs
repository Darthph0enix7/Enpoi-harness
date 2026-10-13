#!/usr/bin/env node
/**
 * Per-channel update catalog generator (docs/plan/ui-update-manifest.md P1).
 *
 * Builds or updates `catalog/<channel>.json` — the small advisory document the
 * host update-check plugin fetches to learn about newer releases. Everything
 * comes from the local git repository (tags, subjects, tag dates); the script
 * never touches the network.
 *
 * Catalog contract (schemaVersion 1):
 *   { schemaVersion: 1, channel, generatedAt,
 *     releases: [ { version, commit, releasedAt, notes: [commit subject, …] } ] }
 * `version` is the release tag without the leading `v`, `commit` is the short
 * 7-character prefix, `releasedAt` is the tag date in ISO 8601 UTC, and `notes`
 * is one line per non-merge commit subject between the previous release tag and
 * this one. Releases are newest first and the catalog keeps the last 40.
 *
 * Idempotency: with `--in <catalog.json>` the named tag is upserted — prepended
 * when new, recomputed in place when it already exists — so re-running for the
 * same tag replaces that entry instead of duplicating or reordering it.
 * Without `--tag` the catalog is rebuilt from every release tag in the
 * repository, which is the hand-run path (`node scripts/update-catalog.mjs
 * --channel stable --out /tmp/cat.json`).
 *
 * CLI:
 *   node scripts/update-catalog.mjs --channel stable|beta [--tag v<version>]
 *     [--in <existing-catalog.json>] [--out <catalog.json>] [--repo <path>]
 *
 * `--out` omitted prints the catalog to stdout. Exit status is 0 on success and
 * 1 only when the invocation or a git query is invalid; a malformed `--in`
 * catalog is reported on stderr and treated as absent (the catalog is advisory
 * and must not block a release).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Emitted catalog schema version. */
export const CATALOG_SCHEMA_VERSION = 1

/** Release tags kept in the catalog (newest first). */
export const CATALOG_KEEP = 40

/** Release tag names this generator accepts (e.g. `v0.1.7-enpoi.2.81`). */
const RELEASE_TAG_PATTERN = /^v\d+\./

/**
 * An entry built with no preceding release tag reads at most this many commit
 * subjects, so the first catalog for a long-lived repository stays small.
 */
const FIRST_RELEASE_NOTE_LIMIT = 50

/** Commit subjects that are noise in a changelog. */
const SUBJECT_NOISE = [/^\[skip ci\]/i, /^merge\b/i]

function failure(message) {
  return new Error(message)
}

/** Run one git command in `repo` and return trimmed stdout. */
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** Run one git command, returning null instead of throwing. */
function tryGit(repo, args) {
  try {
    return git(repo, args)
  } catch {
    return null
  }
}

/** Normalize one date string to ISO 8601 UTC, or null when unparseable. */
function isoUtc(value) {
  if (typeof value !== 'string' || value === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** Whether `tag` exists as a ref in `repo`. */
function tagExists(repo, tag) {
  return tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]) !== null
}

/** Subjects that survive the noise filter. */
function cleanSubjects(lines) {
  const subjects = []
  for (const line of lines) {
    const subject = line.trim()
    if (subject === '') continue
    if (SUBJECT_NOISE.some(pattern => pattern.test(subject))) continue
    subjects.push(subject)
  }
  return subjects
}

/**
 * One entry per commit subject in `range`, in git order (newest first).
 *
 * @param repo - repository root.
 * @param range - a git range (`prev..tag`) or a single tag for a first release.
 * @param limit - optional maximum subject count.
 * @returns the filtered subject lines.
 */
export function collectNotes(repo, range, limit = null) {
  const args = ['log', '--no-merges', '--format=%s']
  if (limit !== null) args.push(`-n${limit}`)
  args.push(range)
  const output = tryGit(repo, args)
  if (output === null) return []
  return cleanSubjects(output.split('\n'))
}

/**
 * Every release tag in `repo`, oldest first.
 *
 * Tags that do not match the release naming pattern (`v<digits>.…`, e.g.
 * `v0.1.7-enpoi.2.81`) are ignored, as are tags whose commit is missing.
 *
 * @param repo - repository root.
 * @returns `{ tag, releasedAt }` rows sorted by tag date, then version order.
 */
export function listReleaseTags(repo) {
  const output = git(repo, ['for-each-ref', 'refs/tags', '--format=%(refname:short)%1f%(creatordate:iso-strict)'])
  const rows = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [tag = '', date = ''] = line.split('\x1f')
    if (!RELEASE_TAG_PATTERN.test(tag)) continue
    rows.push({ tag, releasedAt: isoUtc(date) ?? new Date(0).toISOString() })
  }
  rows.sort((left, right) => {
    const byDate = Date.parse(left.releasedAt) - Date.parse(right.releasedAt)
    if (byDate !== 0) return byDate
    return compareVersionText(left.tag.replace(/^v/, ''), right.tag.replace(/^v/, ''))
  })
  return rows
}

/** Numeric-aware comparison of two version texts (ties broken lexically). */
function compareVersionText(left, right) {
  const leftTokens = left.split(/[.+_-]/)
  const rightTokens = right.split(/[.+_-]/)
  for (let index = 0; index < Math.max(leftTokens.length, rightTokens.length); index++) {
    const a = leftTokens[index]
    const b = rightTokens[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric && a !== b) return Number(a) - Number(b)
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** The previous release tag: a catalog neighbor when possible, else the nearest reachable tag. */
function previousTagFor(repo, tag, candidates) {
  for (const candidate of candidates) {
    if (candidate !== tag && tagExists(repo, candidate)) return candidate
  }
  const described = tryGit(repo, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`])
  if (described !== null && described !== '' && described !== tag) return described
  return null
}

/** One release entry for `tag`, with notes since `previousTag`. */
function entryFor(repo, tag, previousTag) {
  const commit = tryGit(repo, ['rev-parse', '--short=7', `${tag}^{commit}`])
  if (commit === null) throw failure(`tag ${tag} does not resolve to a commit`)
  const tagDate = tryGit(repo, ['for-each-ref', `refs/tags/${tag}`, '--format=%(creatordate:iso-strict)'])
  const commitDate = tryGit(repo, ['log', '-1', '--format=%cI', tag])
  const releasedAt = isoUtc(tagDate) ?? isoUtc(commitDate) ?? new Date(0).toISOString()
  const notes = previousTag === null
    ? collectNotes(repo, tag, FIRST_RELEASE_NOTE_LIMIT)
    : collectNotes(repo, `${previousTag}..${tag}`)
  return { version: tag.replace(/^v/, ''), commit, releasedAt, notes }
}

/** A candidate older-release tag from existing catalog entries, newest first. */
function olderTagCandidates(entries, startIndex) {
  const candidates = []
  for (let index = startIndex; index < entries.length; index++) candidates.push(`v${entries[index].version}`)
  return candidates
}

/** Upsert one tag into `entries` (mutates and returns the array). */
function upsertEntry(repo, tag, entries) {
  const version = tag.replace(/^v/, '')
  const index = entries.findIndex(entry => entry.version === version)
  const previousTag = previousTagFor(repo, tag, olderTagCandidates(entries, index === -1 ? 0 : index + 1))
  const entry = entryFor(repo, tag, previousTag)
  if (index === -1) entries.unshift(entry)
  else entries[index] = entry
  return entries
}

/** Rebuild every release entry from the repository tags, newest first. */
function rebuildFromTags(repo) {
  const tags = listReleaseTags(repo)
  const entries = []
  for (let index = 0; index < tags.length; index++) {
    const row = tags[index]
    const previousTag = index === 0 ? null : tags[index - 1].tag
    entries.push(entryFor(repo, row.tag, previousTag))
  }
  return entries.reverse()
}

/** Whether one parsed JSON value looks like a catalog entry. */
function isEntry(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (typeof value.version !== 'string' || value.version === '') return false
  if (typeof value.commit !== 'string') return false
  if (typeof value.releasedAt !== 'string') return false
  if (!Array.isArray(value.notes) || !value.notes.every(note => typeof note === 'string')) return false
  return true
}

/**
 * Parse an existing catalog document or entry list; `null` when not usable.
 *
 * @param value - parsed JSON value, raw text, or an entry array.
 * @returns the valid release entries, or null when the input is malformed.
 */
export function parseExistingCatalog(value) {
  let document = value
  if (typeof value === 'string') {
    try {
      document = JSON.parse(value)
    } catch {
      return null
    }
  }
  const releases = Array.isArray(document)
    ? document
    : typeof document === 'object' && document !== null
      ? document.releases
      : undefined
  if (!Array.isArray(releases)) return null
  return releases.filter(isEntry)
}

/**
 * Read and parse an existing catalog file; `null` when missing or malformed.
 *
 * @param file - catalog path.
 * @returns the entry list, or null.
 */
export function loadExistingCatalog(file) {
  if (!existsSync(file)) return null
  try {
    return parseExistingCatalog(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Build the catalog document for one channel.
 *
 * @param options - build inputs.
 * @param options.repo - repository root (default cwd).
 * @param options.channel - `stable` or `beta`.
 * @param options.tag - release tag to upsert; when omitted, rebuild all tags.
 * @param options.existing - parsed existing entries, or a catalog document.
 * @param options.now - clock returning the `generatedAt` timestamp.
 * @returns the catalog document, newest first, capped at {@link CATALOG_KEEP}.
 */
export function buildCatalog(options) {
  const repo = options.repo ?? process.cwd()
  const channel = options.channel
  if (channel !== 'stable' && channel !== 'beta') {
    throw failure(`--channel must be stable or beta, got ${JSON.stringify(channel)}`)
  }
  const keep = Number.isInteger(options.keep) && options.keep > 0 ? options.keep : CATALOG_KEEP
  const entries = parseExistingCatalog(options.existing ?? null) ?? []
  let releases
  if (typeof options.tag === 'string' && options.tag !== '') {
    if (!RELEASE_TAG_PATTERN.test(options.tag)) {
      throw failure(`--tag ${JSON.stringify(options.tag)} is not a release tag (expected v<version>)`)
    }
    releases = upsertEntry(repo, options.tag, [...entries])
  } else {
    releases = rebuildFromTags(repo)
  }
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    channel,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    releases: releases.slice(0, keep),
  }
}

/** Parse the CLI argument list into an options record. */
function parseArgs(argv) {
  const options = { repo: process.cwd(), channel: null, tag: null, in: null, out: null }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case '--help':
      case '-h':
        return { help: true }
      case '--repo':
      case '--channel':
      case '--tag':
      case '--in':
      case '--out': {
        const value = argv[++index]
        if (value === undefined) throw failure(`${arg} needs a value`)
        options[arg.slice(2)] = value
        break
      }
      default:
        throw failure(`unknown argument ${JSON.stringify(arg)} (see --help)`)
    }
  }
  return options
}

const USAGE = `Usage: node scripts/update-catalog.mjs --channel stable|beta [options]

  --channel <stable|beta>  catalog channel (required)
  --tag <vVERSION>         release tag to upsert; omit to rebuild every tag
  --in <catalog.json>      existing catalog to prepend into (or update in place)
  --out <catalog.json>     output path; omit to print to stdout
  --repo <path>            repository root (default: cwd)
`

/** CLI entry point; returns the process exit code. */
export function main(argv) {
  const options = parseArgs(argv)
  if (options.help === true) {
    process.stdout.write(USAGE)
    return 0
  }
  const existing = options.in === null ? null : loadExistingCatalog(options.in)
  if (options.in !== null && existing === null) {
    process.stderr.write(`update-catalog: ${options.in} is missing or malformed; starting from an empty catalog\n`)
  }
  const catalog = buildCatalog({
    repo: options.repo,
    channel: options.channel ?? '',
    tag: options.tag,
    existing,
  })
  const text = `${JSON.stringify(catalog, null, 2)}\n`
  if (options.out === null) {
    process.stdout.write(text)
  } else {
    mkdirSync(dirname(options.out), { recursive: true })
    writeFileSync(options.out, text)
  }
  return 0
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href
if (invokedPath !== undefined && import.meta.url === invokedPath) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`update-catalog: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
