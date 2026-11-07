/**
 * Regenerate the committed CLIProxyAPI metadata baseline snapshot.
 *
 * The baseline is a sanitized projection of the raw upstream registry
 * (`internal/registry/models/models.json`) at a pinned tag. It keeps only the
 * allowlisted capability fields the provider sync may disclose; descriptions,
 * prompts, native capabilities, config, and every other upstream field are
 * dropped.
 *
 * Metadata-only: this script fetches the raw registry document, never a proxy
 * management endpoint, and has no auth/header surface. Downloads are bounded
 * by `fetchRegistryDocument` (time + bytes).
 *
 * Usage (from the repository root):
 *
 *   node profile/web/packages/enpoi-provider-sync/scripts/update-cliproxyapi-metadata.mjs
 *   node ... --input /tmp/CLIProxyAPI/internal/registry/models/models.json
 *   node ... --check
 *
 * `--check` writes nothing and exits non-zero when the committed snapshot
 * drifts from the pinned source. Pass `--fetched-at <ISO-8601>` for a
 * reproducible write; `--check` reuses the committed timestamp unless one is
 * supplied. `--url` / `--version` / `--output` override the pinned defaults.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_REGISTRY_SNAPSHOT_FILE,
  BUNDLED_REGISTRY_SOURCE_PATH,
  BUNDLED_REGISTRY_SOURCE_SHA256,
  BUNDLED_REGISTRY_SOURCE_URL,
  BUNDLED_REGISTRY_SOURCE_VERSION,
  createRegistryMetadataSnapshot,
  fetchRegistryDocument,
  serializeRegistryMetadataSnapshot,
} from '../src/registry-metadata.ts'

const here = dirname(fileURLToPath(import.meta.url))
const defaultOutput = join(here, '..', BUNDLED_REGISTRY_SNAPSHOT_FILE)
const MAX_INPUT_BYTES = 2 * 1024 * 1024

const args = process.argv.slice(2)

/** Read `--name value`, or `undefined`. */
function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      'Usage: node scripts/update-cliproxyapi-metadata.mjs [options]',
      '',
      `  --input <path>       Read a local raw models.json instead of fetching`,
      `  --url <url>          Raw registry URL (default ${BUNDLED_REGISTRY_SOURCE_URL})`,
      `  --version <label>    Source version/tag (default ${BUNDLED_REGISTRY_SOURCE_VERSION})`,
      '  --fetched-at <ISO>   Snapshot timestamp (default: now, or the committed value for --check)',
      '  --output <path>      Snapshot path (default: the committed baseline)',
      '  --check              Compare instead of write; exit 1 on drift',
    ].join('\n'),
  )
  process.exit(0)
}

const input = option('--input')
const url = option('--url') ?? BUNDLED_REGISTRY_SOURCE_URL
const version = option('--version') ?? BUNDLED_REGISTRY_SOURCE_VERSION
const output = resolve(option('--output') ?? defaultOutput)
const check = args.includes('--check')

/** The committed timestamp, so `--check` is stable without --fetched-at. */
function committedFetchedAt() {
  try {
    const snapshot = JSON.parse(readFileSync(output, 'utf8'))
    return typeof snapshot?.source?.fetchedAt === 'string' ? snapshot.source.fetchedAt : undefined
  } catch {
    return undefined
  }
}

const fetchedAt = option('--fetched-at') ?? (check ? committedFetchedAt() : new Date().toISOString())

/** A source URL safe for attribution: no credentials, query, or fragment. */
function attributedUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    console.error('source URL is invalid')
    process.exit(1)
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    console.error('source URL must not carry credentials')
    process.exit(1)
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
}

/** Load the raw registry document and its exact raw-byte SHA-256. */
async function loadDocument() {
  if (input !== undefined) {
    const path = resolve(input)
    let bytes
    try {
      const size = statSync(path).size
      if (size > MAX_INPUT_BYTES) {
        console.error(`input ${path}: ${size} bytes exceeds the ${MAX_INPUT_BYTES}-byte limit`)
        process.exit(1)
      }
      bytes = readFileSync(path)
    } catch (error) {
      console.error(`input ${path}: unreadable — ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
    let document
    try {
      document = JSON.parse(bytes.toString('utf8'))
    } catch {
      console.error(`input ${path}: not valid JSON`)
      process.exit(1)
    }
    return { document, sha256: createHash('sha256').update(bytes).digest('hex'), url: attributedUrl(url) }
  }

  const fetched = await fetchRegistryDocument({ url, timeoutMs: 15_000, maxBytes: MAX_INPUT_BYTES })
  if (!fetched.ok) {
    console.error(`fetch ${fetched.url || '[invalid source]'}: ${fetched.diagnostic.message}`)
    process.exit(1)
  }
  return { document: fetched.document, sha256: fetched.sha256, url: fetched.url }
}

const loaded = await loadDocument()
const expectedHash = version === BUNDLED_REGISTRY_SOURCE_VERSION ? BUNDLED_REGISTRY_SOURCE_SHA256 : null
if (expectedHash !== null && loaded.sha256 !== expectedHash) {
  console.error(
    `source hash mismatch for pinned ${version}: expected ${expectedHash}, got ${loaded.sha256}`,
  )
  process.exit(1)
}

let snapshot
try {
  snapshot = createRegistryMetadataSnapshot(loaded.document, {
    sourceUrl: loaded.url,
    sourceVersion: version,
    sourcePath: BUNDLED_REGISTRY_SOURCE_PATH,
    sourceSha256: loaded.sha256,
    fetchedAt,
  })
} catch (error) {
  console.error(`registry snapshot refused: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const next = serializeRegistryMetadataSnapshot(snapshot)
const modelCount = Object.values(snapshot.channels).reduce((total, models) => total + models.length, 0)
const channelCount = Object.keys(snapshot.channels).length

if (check) {
  let current = ''
  try {
    current = readFileSync(output, 'utf8')
  } catch {
    // Missing snapshot is drift.
  }
  if (current !== next) {
    console.error(`metadata snapshot drift: ${output} does not match ${version} (${channelCount} channels, ${modelCount} models)`)
    process.exit(1)
  }
  console.log(`metadata snapshot up to date: ${version} (${channelCount} channels, ${modelCount} models, sha256 ${loaded.sha256})`)
} else {
  writeFileSync(output, next)
  console.log(`wrote ${output}: ${version} (${channelCount} channels, ${modelCount} models, sha256 ${loaded.sha256})`)
}
