// @vitest-environment jsdom
/**
 * The effective-registry store behind the Dynamic → Roles baselines: it reads
 * the host's `enpoiRoles.list` RPC and fails open to the settings-layer
 * display when the RPC is missing or malformed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** One JSON response envelope. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('effective role store', () => {
  it('parses host rows with persona/label/group/allowlist and drops id-less rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      result: {
        ok: true,
        value: {
          roles: [
            { id: 'fixer', label: 'Fixer', persona: 'You fix things.', group: 'specialists', seat: true, builtin: true, available: ['read', 'bash'] },
            { persona: 'no id here' },
          ],
        },
      },
    })))
    const mod = await import('../src/client/role-effective.ts')
    await mod.refreshEffectiveRoles()
    expect(mod.effectiveRolesUnavailable()).toBe(false)
    expect(mod.getEffectiveRoles().fixer).toEqual({
      id: 'fixer', label: 'Fixer', persona: 'You fix things.', group: 'specialists', seat: true, builtin: true, available: ['read', 'bash'],
    })
    expect(Object.keys(mod.getEffectiveRoles())).toEqual(['fixer'])
  })

  it('fails open and keeps the settings-layer display when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const mod = await import('../src/client/role-effective.ts')
    await mod.refreshEffectiveRoles()
    expect(mod.getEffectiveRoles()).toEqual({})
    expect(mod.effectiveRolesUnavailable()).toBe(true)
  })

  it('reports a gateway rejection as unavailable rather than empty-looking', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ result: { ok: false, error: { code: 'internal', message: 'nope' } } })))
    const mod = await import('../src/client/role-effective.ts')
    await mod.refreshEffectiveRoles()
    expect(mod.effectiveRolesUnavailable()).toBe(true)
  })
})
