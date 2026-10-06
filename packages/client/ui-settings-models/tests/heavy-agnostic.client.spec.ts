/**
 * SHIPPED-DEFAULT CORRECTNESS: the end user has no server. The heavy manifest
 * table, the heavy templates, and the client sources that ship may name no
 * operator address, hostname, private range, or path. A `service` manifest's
 * URLs stay loopback; a `delivery: 'direct'` manifest names only the
 * documented public vendor host, which by definition is not an operator
 * address. An operator's own endpoints belong in the host's private
 * `$DSH_HOME/heavy-server-overlay.json`, never in this package.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { FALLBACK_HEAVY_PROVIDER_MANIFESTS } from '../src/client/heavy-providers.ts'
import { PROVIDER_TEMPLATES } from '../src/client/provider-templates.ts'

const FORBIDDEN = [
  /100\.122\.163\.25/,
  /enpoi\.vip/i,
  /serverlocal/i,
  /tailscale/i,
  /\/home\/adam\b/,
]

/** Every string reachable from one value, in order. */

it('the shipped manifests and heavy templates name no operator address, hostname, or path', () => {
  const heavyTemplates = PROVIDER_TEMPLATES.filter(template => template.heavy !== undefined)
  expect(heavyTemplates).toHaveLength(FALLBACK_HEAVY_PROVIDER_MANIFESTS.length)
  for (const value of [FALLBACK_HEAVY_PROVIDER_MANIFESTS, heavyTemplates]) {
    const serialized = JSON.stringify(value)
    for (const pattern of FORBIDDEN) {
      expect(serialized, `shipped heavy data must not match ${String(pattern)}`).not.toMatch(pattern)
    }
  }
})

/** The one public vendor host a `delivery: 'direct'` route may name, by route id. */
const PUBLIC_VENDOR_HOSTS: Readonly<Record<string, string>> = { commandcode: 'api.commandcode.ai' }

/** Loopback, link-local, and RFC 1918 hosts no shipped manifest may name. */
const PRIVATE_HOST = new RegExp(
  '^(?:localhost|127(?:\\.\\d{1,3}){3}|10(?:\\.\\d{1,3}){3}|192\\.168(?:\\.\\d{1,3}){2}'
  + '|172\\.(?:1[6-9]|2\\d|3[01])(?:\\.\\d{1,3}){2}|169\\.254(?:\\.\\d{1,3}){2}'
  + '|0\\.0\\.0\\.0|\\[?::1\\]?)$',
  'i',
)

it('every manifest URL names loopback or the documented vendor host, never a private address', () => {
  for (const manifest of FALLBACK_HEAVY_PROVIDER_MANIFESTS) {
    const urls = [
      manifest.reuse.baseURL,
      manifest.reuse.health.url,
      manifest.local.baseURL,
      ...manifest.dashboardUrl === undefined ? [] : [manifest.dashboardUrl],
      ...manifest.local.dashboardUrl === undefined ? [] : [manifest.local.dashboardUrl],
      ...manifest.unsupported === undefined ? [] : [manifest.unsupported.reuseUrl],
    ].filter(url => url !== '')
    expect(urls.length, `${manifest.id} must declare URLs`).toBeGreaterThan(0)
    const vendorHost = manifest.delivery === 'direct' ? PUBLIC_VENDOR_HOSTS[manifest.id] : undefined
    if (manifest.delivery === 'direct') {
      expect(vendorHost, `${manifest.id} declares direct delivery but no public vendor host`).toBeDefined()
    }
    for (const url of urls) {
      const hostname = new URL(url).hostname
      if (vendorHost !== undefined) {
        // The direct vendor endpoint is the one non-loopback address allowed:
        // it must still never be a private/operator host, and it is pinned to
        // the documented public vendor so no other host can slip in. This
        // check stays narrow on purpose — a `service` route keeps the old
        // loopback pin below.
        expect(hostname, `${manifest.id}: ${url}`).not.toMatch(PRIVATE_HOST)
        expect(hostname, `${manifest.id}: ${url}`).toBe(vendorHost)
      } else {
        expect(hostname, `${manifest.id}: ${url}`).toBe('127.0.0.1')
      }
    }
  }
})

it('the client sources that ship carry none of the operator addresses either', () => {
  const client = fileURLToPath(new URL('../src/client', import.meta.url))
  const files = readdirSync(client).filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
  expect(files.length).toBeGreaterThan(0)
  for (const name of files) {
    const text = readFileSync(`${client}/${name}`, 'utf8')
    for (const pattern of FORBIDDEN) {
      expect(text, `${name} must not match ${String(pattern)}`).not.toMatch(pattern)
    }
    // The heavy copy must not claim a server-side mode either.
    if (name === 'locales.ts' || name === 'heavy-providers.ts') {
      expect(text, `${name} must not promise server reuse`).not.toMatch(/reuse on server/i)
    }
  }
})
