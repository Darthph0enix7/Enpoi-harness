#!/usr/bin/env node
/**
 * Generate provider-presets for the Enpoi Harness Add-Provider catalog.
 *
 * Sources:
 *  - models.dev mirror from the opencode cache. Resolution order:
 *    `--models-cache <file>` > `DSH_MODELS_CACHE` > `~/.cache/opencode/models.json`
 *  - pi-ai bundled catalog (baseUrl for providers whose models.dev api is null),
 *    located through the workspace's node_modules rather than a versioned
 *    pnpm-store path.
 *
 * Output: `src/client/provider-presets.ts` inside this package. Override with
 * `--out <path>`; a target without a `.ts` extension is written as plain JSON
 * (no generated header is possible there; the source metadata goes to stdout).
 * Shape per provider:
 *   { id, name, env: string[], protocol, baseURL, doc?, keyless?, popular? }
 *   protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
 *   keyless: true for routes whose free tier serves anonymous requests
 *   popular: 1-based position in the Add-Provider picker's Popular group
 *
 * The shipped keyless/popular verdicts are INPUTS of this generator
 * ({@link KEYLESS_PRESET_IDS} / {@link POPULAR_PRESET_IDS}) baked into the
 * generated rows, so the client derives its sets from data instead of a
 * runtime hardcode.
 *
 * Usage:
 *   node packages/client/ui-settings-models/scripts/gen-provider-presets.mjs \
 *     [--models-cache <models.json>] [--out <provider-presets.ts>]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..', '..')
const SCRIPT_LABEL = 'packages/client/ui-settings-models/scripts/gen-provider-presets.mjs'
const PI_AI_PACKAGE = '@earendil-works/pi-ai'

// ── 0. Inputs ────────────────────────────────────────────────────────────────

/** Parse `--models-cache <file>` / `--out <file>`; anything else fails loud. */
function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--models-cache' || flag === '--out') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`missing value for ${flag}`)
      if (flag === '--models-cache') parsed.modelsCache = resolve(value)
      else parsed.out = resolve(value)
      index += 1
    } else if (flag === '--help' || flag === '-h') {
      console.log(`usage: node ${SCRIPT_LABEL} [--models-cache <models.json>] [--out <provider-presets.ts>]`)
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  return parsed
}

const options = parseArgs(process.argv.slice(2))
const MODELS_CACHE = options.modelsCache
  ?? process.env.DSH_MODELS_CACHE
  ?? join(homedir(), '.cache', 'opencode', 'models.json')
const OUT = options.out ?? join(PACKAGE_ROOT, 'src', 'client', 'provider-presets.ts')

/** Collapse a path under the home directory to `~/…` for the generated header. */
function displayPath(path) {
  const home = homedir()
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

/** Standard node_modules walk-up from `fromDir`; returns the package dir. */
function findPackageDir(fromDir, packageName) {
  for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...packageName.split('/'))
    const manifest = join(candidate, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name === packageName) return candidate
      } catch {
        // A malformed manifest is not a resolvable install; keep walking.
      }
    }
    if (dir === dirname(dir)) return undefined
  }
}

/** Locate the pi-ai install version-agnostically: walk-ups, then pnpm store. */
function resolvePiAiCatalog() {
  const anchors = [
    [HERE, 'this package'],
    [join(REPO_ROOT, 'packages', 'llm', 'llm-pi-ai'), 'packages/llm/llm-pi-ai'],
    [REPO_ROOT, 'repo root'],
  ]
  for (const [anchor, source] of anchors) {
    const root = findPackageDir(anchor, PI_AI_PACKAGE)
    if (root !== undefined) return { root, source }
  }
  const store = join(REPO_ROOT, 'node_modules', '.pnpm')
  if (existsSync(store)) {
    const candidates = readdirSync(store)
      .filter(name => name.startsWith('@earendil-works+pi-ai@'))
      .sort()
      .reverse()
    for (const name of candidates) {
      const root = join(store, name, 'node_modules', '@earendil-works', 'pi-ai')
      if (existsSync(join(root, 'package.json'))) return { root, source: `pnpm store ${name}` }
    }
  }
  throw new Error(
    `cannot locate ${PI_AI_PACKAGE}: run pnpm install, or point this generator at a checkout that has it`,
  )
}

const piAi = resolvePiAiCatalog()
const piAiVersion = JSON.parse(readFileSync(join(piAi.root, 'package.json'), 'utf8')).version
const piAiDataDir = join(piAi.root, 'dist', 'providers', 'data')
if (!existsSync(piAiDataDir)) {
  throw new Error(`${PI_AI_PACKAGE}@${piAiVersion} has no bundled catalog at ${piAiDataDir}`)
}

if (!existsSync(MODELS_CACHE)) {
  throw new Error(
    `models.dev cache not found at ${MODELS_CACHE} (pass --models-cache <file> or set DSH_MODELS_CACHE)`,
  )
}

// ── 1. Load models.dev mirror ────────────────────────────────────────────────
const modelsDev = JSON.parse(readFileSync(MODELS_CACHE, 'utf8'))
const capturedAt = statSync(MODELS_CACHE).mtime.toISOString()
const providerIds = Object.keys(modelsDev)
console.log(`models.dev providers: ${providerIds.length} (${displayPath(MODELS_CACHE)}, captured ${capturedAt})`)
console.log(`pi-ai catalog: ${PI_AI_PACKAGE}@${piAiVersion} via ${piAi.source}`)

// ── 2. Build pi-ai baseUrl index (providerId -> baseUrl) ─────────────────────
const piBaseUrl = new Map()
for (const file of readdirSync(piAiDataDir).filter(f => f.endsWith('.json'))) {
  const data = JSON.parse(readFileSync(join(piAiDataDir, file), 'utf8'))
  for (const [apiGroup, models] of Object.entries(data)) {
    for (const [modelId, meta] of Object.entries(models)) {
      const provider = meta.provider
      if (typeof provider === 'string' && typeof meta.baseUrl === 'string' && !piBaseUrl.has(provider)) {
        piBaseUrl.set(provider, meta.baseUrl)
      }
    }
  }
}
console.log(`pi-ai baseUrl index: ${piBaseUrl.size} providers`)

// ── 3. npm -> DSH protocol mapping ───────────────────────────────────────────
function protocolOf(npm) {
  if (!npm) return 'openai-completions'
  if (npm.includes('anthropic')) return 'anthropic-messages'
  if (npm === '@ai-sdk/openai') return 'openai-responses'
  return 'openai-completions'
}

// ── 4. Shipped catalog verdicts ──────────────────────────────────────────────
// Shipped defaults, frozen as generator inputs. The client derives its
// KEYLESS_PROVIDERS / POPULAR_PROVIDERS sets from the generated rows and an
// operator settings override can change either per provider.
/** Routes whose free tier serves anonymous requests with no credential. */
const KEYLESS_PRESET_IDS = new Set(['kilo', 'ollama', 'lmstudio', 'llama-cpp', 'vllm', 'localai'])
/** Popular group order in the Add-Provider picker (1-based rank = position). */
const POPULAR_PRESET_IDS = ['opencode', 'opencode-go', 'anthropic', 'github-copilot', 'openai', 'google', 'openrouter', 'vercel']

// ── 5. Build presets ─────────────────────────────────────────────────────────
const presets = []
for (const id of providerIds) {
  const p = modelsDev[id]
  if (!p || typeof p !== 'object') continue
  const name = typeof p.name === 'string' ? p.name : id
  const env = Array.isArray(p.env) ? p.env.filter(e => typeof e === 'string') : []
  const doc = typeof p.doc === 'string' ? p.doc : undefined

  // baseURL: models.dev api string (with ${VAR} substitution) > pi-ai baseUrl > ''
  let baseURL = ''
  if (typeof p.api === 'string' && p.api.length > 0) {
    baseURL = p.api.replace(/\$\{([A-Z0-9_]+)\}/g, (_, v) => `{env:${v}}`)
  } else {
    baseURL = piBaseUrl.get(id) ?? ''
  }

  const popularRank = POPULAR_PRESET_IDS.indexOf(id) + 1
  presets.push({
    id,
    name,
    env,
    protocol: protocolOf(p.npm),
    baseURL,
    ...(doc ? { doc } : {}),
    ...(KEYLESS_PRESET_IDS.has(id) ? { keyless: true } : {}),
    ...(popularRank > 0 ? { popular: popularRank } : {}),
  })
}

presets.sort((a, b) => a.name.localeCompare(b.name))
console.log(`presets generated: ${presets.length}`)

// ── 6. Write ─────────────────────────────────────────────────────────────────
/**
 * Format one value in the generated module's style: double-quoted JSON is
 * rewritten to single-quoted keys/strings with trailing commas, matching the
 * committed artifact byte-for-byte for an unchanged cache. A string carrying a
 * single quote or backslash falls back to JSON quoting so the output stays
 * valid TypeScript.
 */
function formatValue(value, depth) {
  const pad = '  '.repeat(depth)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map(item => `${'  '.repeat(depth + 1)}${formatValue(item, depth + 1)},`)
    return `[\n${items.join('\n')}\n${pad}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, member]) =>
      `${'  '.repeat(depth + 1)}'${key}': ${formatValue(member, depth + 1)},`)
    return `{\n${entries.join('\n')}\n${pad}}`
  }
  if (typeof value === 'string' && !value.includes("'") && !value.includes('\\')) return `'${value}'`
  return JSON.stringify(value)
}

const rendered = formatValue(presets, 0)
if (OUT.endsWith('.ts')) {
  const header = [
    `// Generated by ${SCRIPT_LABEL}`,
    `// Source: models.dev cache ${displayPath(MODELS_CACHE)} (captured ${capturedAt})`,
    `// pi-ai baseUrl catalog: ${PI_AI_PACKAGE}@${piAiVersion} via ${piAi.source}`,
    `// Regenerate with: node ${SCRIPT_LABEL}`,
  ].join('\n')
  writeFileSync(OUT, `${header}\nexport default ${rendered} as const\n`)
} else {
  writeFileSync(OUT, `${JSON.stringify(presets, null, 2)}\n`)
}
console.log(`written: ${displayPath(OUT)} (${(rendered.length / 1024).toFixed(1)} KB)`)

// Sample
console.log('\nSample:')
for (const p of presets.slice(0, 5)) console.log(JSON.stringify(p))
