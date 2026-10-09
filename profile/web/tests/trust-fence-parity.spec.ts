/**
 * Trust-fence parity: the sidebar host's fence must decide exactly like the
 * canonical /api gateway fence it re-exports from
 * @deepseek-ai/dsh-client-connection. The table covers loopback (IPv4, IPv6,
 * localhost), LAN authorities through `trustedHosts`, and the two
 * DNS-rebinding shapes a browser can produce (foreign Host, foreign Origin).
 */
import { describe, expect, it } from 'vitest'
import {
  isLoopbackHostname as canonicalLoopback,
  isTrustedApiRequest as canonicalTrust,
} from '@deepseek-ai/dsh-client-connection/src/index.ts'
import {
  isLoopbackHostname as sidebarLoopback,
  isTrustedApiRequest as sidebarTrust,
} from '../sidebar-patch/src/trust-fence.ts'

const LAN = '192.168.188.95'

interface Case {
  readonly name: string
  readonly headers: Record<string, string>
  readonly trustedHosts?: readonly string[]
  readonly trusted: boolean
}

const CASES: readonly Case[] = [
  { name: 'localhost authority', headers: { host: 'localhost:4096' }, trusted: true },
  { name: 'IPv4 loopback authority', headers: { host: '127.0.0.1:3080' }, trusted: true },
  { name: '127/8 is all loopback', headers: { host: '127.8.9.10' }, trusted: true },
  { name: 'IPv6 loopback authority', headers: { host: '[::1]:4096' }, trusted: true },
  {
    name: 'LAN authority matching a port-less trusted entry',
    headers: { host: `${LAN}:3080` },
    trustedHosts: [LAN],
    trusted: true,
  },
  {
    name: 'LAN authority on a different port than its exact trusted entry',
    headers: { host: `${LAN}:9999` },
    trustedHosts: [`${LAN}:3080`],
    trusted: false,
  },
  {
    name: 'LAN authority with no trusted entry',
    headers: { host: `${LAN}:3080` },
    trusted: false,
  },
  { name: 'foreign Host is a rebinding attempt', headers: { host: 'evil.example' }, trusted: false },
  {
    name: 'foreign Host with its own Origin stays refused',
    headers: { host: 'evil.example', origin: 'http://evil.example' },
    trusted: false,
  },
  {
    name: 'loopback Host with cross-site marker is refused',
    headers: { host: '127.0.0.1:4096', 'sec-fetch-site': 'cross-site' },
    trusted: false,
  },
  {
    name: 'loopback Host with a foreign Origin is refused',
    headers: { host: '127.0.0.1:4096', origin: 'http://evil.example' },
    trusted: false,
  },
  {
    name: 'loopback Host with its own Origin passes',
    headers: { host: '127.0.0.1:4096', origin: 'http://127.0.0.1:4096' },
    trusted: true,
  },
  {
    name: 'IPv4-mapped IPv6 loopback is not the loopback authority',
    headers: { host: '[::ffff:7f00:1]' },
    trusted: false,
  },
  { name: 'missing Host is refused', headers: {}, trusted: false },
]

describe('sidebar trust fence parity', () => {
  it('classifies loopback hostnames exactly like the canonical predicate', () => {
    for (const hostname of ['localhost', '[::1]', '127.0.0.1', '127.8.9.10', '192.168.188.95', 'evil.example', '[::ffff:7f00:1]']) {
      expect(sidebarLoopback(hostname), hostname).toBe(canonicalLoopback(hostname))
    }
  })

  it.each(CASES)('$name', ({ headers, trustedHosts = [], trusted }) => {
    const canonical = canonicalTrust({ headers }, trustedHosts)
    const sidebar = sidebarTrust({ headers }, trustedHosts)
    expect(sidebar, 'sidebar and canonical fences must agree').toBe(canonical)
    expect(canonical).toBe(trusted)
  })
})
