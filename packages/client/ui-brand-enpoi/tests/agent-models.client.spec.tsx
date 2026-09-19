// @vitest-environment jsdom
/**
 * Agent Models tab: the seat list is derived from the settings-backed role
 * registry plus persona-assigned roles, so a user-defined registry role grows
 * the fleet, `seat: false` hides one, and a persona-only row survives.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AgentModelsBody } from '../src/client/AgentModelsBody.tsx'
import { mergeRoleRegistry, type RoleRegistryMap } from '../src/client/role-registry.ts'
import type { PersonaMap } from '../src/client/persona-store.ts'

function mount(registry: RoleRegistryMap, personas: PersonaMap = {}): void {
  const props = {
    sessionId: 'session-1',
    useTabInfo: () => ({ tab: { actions: { openTab: vi.fn() } } }),
    usePersonaAssignments: (selector: (value: PersonaMap) => unknown) => selector(personas),
    useRoleRegistry: (selector: (value: RoleRegistryMap) => unknown) => selector(registry),
    resolveDirectory: () => null,
    assignPersona: vi.fn(),
    clearPersona: vi.fn(),
  } as unknown as Parameters<typeof AgentModelsBody>[0]
  render(<AgentModelsBody {...props} />)
}

afterEach(() => {
  cleanup()
})

describe('AgentModelsBody — dynamic fleet', () => {
  it('groups the shipped registry seats by their registry group', () => {
    mount(mergeRoleRegistry(undefined))

    expect(screen.getByText('BACKGROUND & SUPERVISION')).toBeTruthy()
    expect(screen.getByText('SPECIALIST WORKERS')).toBeTruthy()
    expect(screen.getByText('The Oracle')).toBeTruthy()
    expect(screen.getByText('Designer')).toBeTruthy()
    expect(screen.queryByText('COUNCIL')).toBeNull()
    expect(screen.getByText('5 seats')).toBeTruthy()
  })

  it('grows with a user-defined registry role, hides seat:false, and keeps persona-only rows', () => {
    const registry = mergeRoleRegistry({
      muse: { label: 'The Muse', group: 'council', seat: true },
      ghost: { label: 'Ghost', group: 'specialists', seat: false },
    })
    mount(registry, { keeper: null, 'my-role': null })

    expect(screen.getByText('COUNCIL')).toBeTruthy()
    expect(screen.getByText('The Muse')).toBeTruthy()
    // seat: false hides the seat while the role itself stays registered.
    expect(screen.queryByText('Ghost')).toBeNull()
    // Persona-assigned ids with no registry entry keep their shipped rows.
    expect(screen.getByText('Context Keeper')).toBeTruthy()
    // An unknown persona-assigned id is title-cased into a seat.
    expect(screen.getByText('My Role')).toBeTruthy()
    expect(screen.getByText('8 seats')).toBeTruthy()
  })
})
