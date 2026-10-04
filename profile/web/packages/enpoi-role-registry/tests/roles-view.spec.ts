import { describe, expect, it } from 'vitest'
import { effectiveRoleRows } from '../src/roles-view.ts'

/**
 * The effective-role RPC projection: the host role tables merged with the
 * settings override layer, so the Dynamic → Roles panel can show built-in
 * personas without duplicating their text in the client.
 */

/** A Settings handle stub: one namespace document, no service machinery. */
function settingsHandle(document: unknown) {
  return { get: (ns: string) => (ns === 'enpoi-orchestration' ? document : undefined) }
}

describe('enpoiRoles effectiveRoleRows', () => {
  it('serves the built-in role tables when no settings document exists', () => {
    const { roles } = effectiveRoleRows(settingsHandle(undefined))
    const fixer = roles.find(role => role.id === 'fixer')
    expect(fixer).toBeDefined()
    expect(fixer?.builtin).toBe(true)
    expect(fixer?.seat).toBe(true)
    expect(fixer?.persona).toContain('Fixer')
    expect(fixer?.spawnable).toBe(true)
    const oracle = roles.find(role => role.id === 'oracle')
    expect(oracle).toBeDefined()
    // The shipped Oracle is tool-only: listed for its seat, never delegated.
    expect(oracle?.spawnable).toBe(false)
    expect(oracle?.seat).toBe(true)
  })

  it('overlays settings persona/label and adds a user-defined role', () => {
    const { roles } = effectiveRoleRows(settingsHandle({
      roles: {
        fixer: { persona: 'You are a bespoke fixer.', label: 'Bespoke Fixer' },
        'my-role': { persona: 'You are mine.', group: 'custom' },
      },
    }))
    const fixer = roles.find(role => role.id === 'fixer')
    expect(fixer?.persona).toBe('You are a bespoke fixer.')
    expect(fixer?.label).toBe('Bespoke Fixer')
    const custom = roles.find(role => role.id === 'my-role')
    expect(custom?.persona).toBe('You are mine.')
    expect(custom?.builtin).toBe(false)
  })

  it('omits retired roles and answers rows sorted by id', () => {
    const { roles } = effectiveRoleRows(settingsHandle({ roles: { fixer: { disabled: true } } }))
    expect(roles.some(role => role.id === 'fixer')).toBe(false)
    expect([...roles].map(role => role.id)).toEqual(roles.map(role => role.id).sort())
  })
})
