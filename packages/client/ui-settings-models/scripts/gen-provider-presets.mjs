#!/usr/bin/env node
/**
 * Generate provider-presets.json for the Enpoi Harness Add-Provider catalog.
 *
 * Sources:
 *  - ~/.cache/opencode/models.json  (models.dev mirror, 211 providers)
 *  - pi-ai bundled catalog          (baseUrl for providers whose models.dev api is null)
 *
 * Output: packages/client/ui-settings-models/src/client/provider-presets.json
 * Shape per provider:
 *   { id, name, env: string[], protocol, baseURL, doc? }
 *   protocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MODELS_CACHE = '/home/adam/.cache/opencode/models.json'
const PI_AI_DIRS = [
  '/home/adam/deepseek-harness/node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_@modelcontextprotocol+sdk@1.29.0_zod@4.4.3__ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/providers/data',
  '/home/adam/deepseek-harness/node_modules/.pnpm/@earendil-works+pi-ai@0.84.2_@modelcontextprotocol+sdk@1.29.0_zod@4.4.3__ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/providers/data',
  '/home/adam/deepseek-harness/node_modules/.pnpm/@earendil-works+pi-ai@0.84.2_/node_modules/@earendil-works/pi-ai/dist/providers/data',
  '/home/adam/deepseek-harness/node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_/node_modules/@earendil-works/pi-ai/dist/providers/data',
]
const OUT = '/home/adam/deepseek-harness/packages/client/ui-settings-models/src/client/provider-presets.json'

// ── 1. Load models.dev mirror ────────────────────────────────────────────────
const modelsDev = JSON.parse(readFileSync(MODELS_CACHE, 'utf8'))
const providerIds = Object.keys(modelsDev)
console.log(`models.dev providers: ${providerIds.length}`)

// ── 2. Build pi-ai baseUrl index (providerId -> baseUrl) ─────────────────────
const piBaseUrl = new Map()
for (const dir of PI_AI_DIRS) {
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    for (const [apiGroup, models] of Object.entries(data)) {
      for (const [modelId, meta] of Object.entries(models)) {
        const provider = meta.provider
        if (typeof provider === 'string' && typeof meta.baseUrl === 'string' && !piBaseUrl.has(provider)) {
          piBaseUrl.set(provider, meta.baseUrl)
        }
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

// ── 4. Build presets ─────────────────────────────────────────────────────────
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
    baseURL = p.api
    // Substitute ${ENV_VAR} from the provider's env list (first match)
    baseURL = baseURL.replace(/\$\{([A-Z0-9_]+)\}/g, (_, v) => {
      if (env.includes(v)) return `{env:${v}}`
      return `{env:${v}}`
    })
  } else {
    baseURL = piBaseUrl.get(id) ?? ''
  }

  presets.push({
    id,
    name,
    env,
    protocol: protocolOf(p.npm),
    baseURL,
    ...(doc ? { doc } : {}),
  })
}

presets.sort((a, b) => a.name.localeCompare(b.name))
console.log(`presets generated: ${presets.length}`)

// ── 5. Write ─────────────────────────────────────────────────────────────────
const out = JSON.stringify(presets, null, 2)
writeFileSync(OUT, out + '\n')
console.log(`written: ${OUT} (${(out.length / 1024).toFixed(1)} KB)`)

// Sample
console.log('\nSample:')
for (const p of presets.slice(0, 5)) console.log(JSON.stringify(p))