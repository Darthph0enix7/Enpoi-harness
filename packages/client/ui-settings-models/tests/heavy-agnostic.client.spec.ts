/**
 * SHIPPED-DEFAULT CORRECTNESS: the end user has no server. The heavy manifest
 * table, the heavy templates, and the client sources that ship may name no
 * operator address, hostname, or path; every manifest URL is loopback. An
 * operator's own endpoints belong in the host's private
 * `$DSH_HOME/heavy-server-overlay.json`, never in this package.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { HEAVY_PROVIDER_MANIFESTS } from '../src/client/heavy-providers.ts'
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
  expect(heavyTemplates).toHaveLength(HEAVY_PROVIDER_MANIFESTS.length)
  for (const value of [HEAVY_PROVIDER_MANIFESTS, heavyTemplates]) {
    const serialized = JSON.stringify(value)
    for (const pattern of FORBIDDEN) {
      expect(serialized, `shipped heavy data must not match ${String(pattern)}`).not.toMatch(pattern)
    }
  }
})

it('every manifest URL is loopback', () => {
  for (const manifest of HEAVY_PROVIDER_MANIFESTS) {
    const urls = [
      manifest.reuse.baseURL,
      manifest.reuse.health.url,
      manifest.local.baseURL,
      ...manifest.dashboardUrl === undefined ? [] : [manifest.dashboardUrl],
      ...manifest.local.dashboardUrl === undefined ? [] : [manifest.local.dashboardUrl],
      ...manifest.unsupported === undefined ? [] : [manifest.unsupported.reuseUrl],
    ].filter(url => url !== '')
    expect(urls.length, `${manifest.id} must declare URLs`).toBeGreaterThan(0)
    for (const url of urls) {
      expect(new URL(url).hostname, `${manifest.id}: ${url}`).toBe('127.0.0.1')
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
