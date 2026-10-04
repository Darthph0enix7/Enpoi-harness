/**
 * SHIPPED-DEFAULT CORRECTNESS: the end user has no server, so the shipped
 * manifest table may name no operator address, hostname, or path — every
 * manifest URL is loopback, and every enpoi plugin's shipped `src/` tree
 * carries none of our addresses and no absolute `/home/<user>` literal
 * (cache paths are derived per OS at runtime). An operator's own endpoints
 * belong in the private `$DSH_HOME/heavy-server-overlay.json`, never in a
 * package.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { HEAVY_MANIFESTS } from '../src/manifests.js'

const FORBIDDEN = [
  /100\.122\.163\.25/,
  /enpoi\.vip/i,
  /serverlocal/i,
  /tailscale/i,
  /\/home\/[A-Za-z0-9._-]+/,
]

const PACKAGES_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Every TypeScript file under every shipped enpoi profile plugin's `src/`. */
function shippedSources(): string[] {
  const files: string[] = []
  for (const entry of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('enpoi-')) continue
    const src = join(PACKAGES_ROOT, entry.name, 'src')
    let entries: string[]
    try {
      entries = readdirSync(src, { recursive: true }) as string[]
    } catch {
      continue
    }
    for (const name of entries) {
      if (name.endsWith('.ts')) files.push(join(src, name))
    }
  }
  return files
}

/** Every string reachable from one value, in order. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(strings)
  }
  return []
}

it('the shipped manifest table names no operator address, hostname, or path', () => {
  const serialized = JSON.stringify(HEAVY_MANIFESTS)
  for (const pattern of FORBIDDEN) {
    expect(serialized, `shipped manifests must not match ${String(pattern)}`).not.toMatch(pattern)
  }
})

it('every manifest URL is loopback', () => {
  for (const manifest of HEAVY_MANIFESTS) {
    const urls = [
      manifest.reuse.baseURL,
      manifest.reuse.health.url,
      manifest.local.baseURL,
      ...manifest.dashboardUrl === undefined ? [] : [manifest.dashboardUrl],
      ...manifest.local.dashboardUrl === undefined ? [] : [manifest.local.dashboardUrl],
      ...manifest.unsupported === undefined ? [] : [manifest.unsupported.reuseUrl],
    ].filter(url => url !== '')
    for (const url of urls) {
      expect(new URL(url).hostname, `${manifest.id}: ${url}`).toBe('127.0.0.1')
    }
  }
})

it('every shipped enpoi plugin source carries none of the operator addresses or /home/ literals', () => {
  const files = shippedSources()
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of FORBIDDEN) {
      expect(text, `${file} must not match ${String(pattern)}`).not.toMatch(pattern)
    }
  }
})

// The sweep is only worth its failures: strings() and the /home/ pattern must
// reject what they claim to, or the assertions above prove nothing.
it('the sweep itself rejects a planted /home/ literal', () => {
  const planted = '/home/somebody/.cache/opencode/models.json'
  const matched = FORBIDDEN.some(pattern => pattern.test(planted))
  expect(matched).toBe(true)
  expect(strings({ nested: ['ok', planted] })).toContain(planted)
})
