/**
 * Browser-safe, zero-dependency loopback classification shared by the `/api`
 * Host fence and the package's `ctx.connection` state. The predicate is
 * published from the package's Host entry for host-side plugins that fence
 * their own browser routes (`dsh-better-sidebar`); client plugins consume the
 * derived state through Cordis.
 */

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a hostname is a Tailscale-bypass authority (WireGuard is the auth).
 * Mirrors the Host's `isTailscaleBypass` in `browser-auth.ts` so the browser
 * mirror's privileged-surface check stays in sync with the Host fence.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for .ts.net, serverlocal*, or 100.64/10 CGNAT.
 */
export function isTailscaleHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/]$/, '').toLowerCase()
  if (host.endsWith('.ts.net')) return true
  if (host === 'serverlocal' || host.startsWith('serverlocal.')) return true
  if (host.startsWith('100.')) {
    const octets = host.split('.').map(Number)
    const second = octets[1]
    if (octets.length === 4 && octets[0] === 100 && typeof second === 'number' && Number.isInteger(second) && second >= 64 && second <= 127) {
      return true
    }
  }
  return false
}

/**
 * Whether the privileged settings surface is reachable without a browser cookie:
 * loopback or Tailscale. The Host's `BrowserAuth` bypasses the same set, so the
 * mirror must treat it as `host` persistence or it never calls `settings.describe`
 * over Tailscale (the tailnet regression).
 * @param hostname - WHATWG URL hostname.
 * @returns true when the Host will serve `settings.describe` without a cookie.
 */
export function isPrivilegedHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname) || isTailscaleHostname(hostname)
}
