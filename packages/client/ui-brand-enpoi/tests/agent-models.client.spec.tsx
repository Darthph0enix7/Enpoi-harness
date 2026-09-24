// @vitest-environment jsdom
/**
 * Agent Models tab: the seat list is derived from the settings-backed role
 * registry plus persona-assigned roles, so a user-defined registry role grows
 * the fleet, `seat: false` hides one, and a persona-only row survives.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { AgentModelsBody } from '../src/client/AgentModelsBody.tsx'
import { mergeRoleRegistry, type FleetCouncil, type RoleRegistryMap } from '../src/client/role-registry.ts'
import type { PersonaMap } from '../src/client/persona-store.ts'

/** One live model directory face over a single-provider catalog. */
function directoryFace() {
  return {
    available: true,
    directory: createSnapshotStore<ModelDirectoryState>({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      routable: true,
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
      }],
      failures: [],
      status: 'ready',
      error: null,
    }),
    load: vi.fn(),
  }
}

function mount(
  registry: RoleRegistryMap,
  personas: PersonaMap = {},
  face: ReturnType<typeof directoryFace> | null = null,
  t: (key: string, params?: Record<string, unknown>) => string = key => key,
  councils: readonly FleetCouncil[] = [],
): void {
  const props = {
    sessionId: 'session-1',
    useTabInfo: () => ({ tab: { actions: { openTab: vi.fn() } } }),
    usePersonaAssignments: (selector: (value: PersonaMap) => unknown) => selector(personas),
    useRoleRegistry: (selector: (value: RoleRegistryMap) => unknown) => selector(registry),
    useCouncilRegistry: (selector: (value: readonly FleetCouncil[]) => unknown) => selector(councils),
    resolveDirectory: () => face,
    ensureCouncils: vi.fn(),
    assignPersona: vi.fn(),
    clearPersona: vi.fn(),
    t,
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

  it('renders one group per live council under its own label, arbiters shared', () => {
    const councils: FleetCouncil[] = [
      {
        id: 'roundtable',
        label: 'Architecture Roundtable',
        seats: [
          { id: 'skeptic', label: 'Skeptic' },
          { id: 'architect', label: 'Architect' },
          { id: 'pragmatist', label: 'Pragmatist' },
        ],
        arbiters: ['referee', 'chair'],
      },
      {
        id: 'chorus',
        label: 'Idea Chorus',
        seats: [
          { id: 'visionary', label: 'Visionary' },
          { id: 'experiencer', label: 'Experiencer' },
          { id: 'integrator', label: 'Integrator' },
        ],
        arbiters: ['referee', 'chair'],
      },
    ]
    mount(mergeRoleRegistry(undefined), { referee: null, chair: null }, null, undefined, councils)

    expect(screen.getByText('Architecture Roundtable')).toBeTruthy()
    expect(screen.getByText('Idea Chorus')).toBeTruthy()
    expect(screen.getByText('COUNCIL')).toBeTruthy()
    expect(screen.getByText('Skeptic')).toBeTruthy()
    expect(screen.getByText('Integrator')).toBeTruthy()
    // Arbiters serve both councils but render once each, in the shared group.
    expect(screen.getAllByText('Referee')).toHaveLength(1)
    expect(screen.getAllByText('Chair')).toHaveLength(1)
    // 5 registry seats + 6 council seats + 2 arbiters.
    expect(screen.getByText('13 seats')).toBeTruthy()
  })

  it('renders a seat two councils list once and skips a council with zero seats', () => {
    const councils: FleetCouncil[] = [
      { id: 'alpha', label: 'Alpha Council', seats: [{ id: 'shared-seat', label: 'Shared Seat' }] },
      { id: 'beta', label: 'Beta Council', seats: [{ id: 'shared-seat', label: 'Shared Seat' }] },
      { id: 'empty', label: 'Empty Council', seats: [], arbiters: [] },
    ]
    mount(mergeRoleRegistry(undefined), { 'stray-seat': null }, directoryFace(), undefined, councils)

    expect(screen.getAllByText('Shared Seat')).toHaveLength(1)
    // The duplicate row is still a real assignment row with its picker.
    expect(screen.getAllByRole('button', { name: 'Inherit' }).length).toBeGreaterThan(0)
    expect(screen.queryByText('Empty Council')).toBeNull()
    // A persona-only seat no council or registry claims lands in Ungrouped.
    expect(screen.getByText('UNGROUPED')).toBeTruthy()
    expect(screen.getByText('Stray Seat')).toBeTruthy()
  })

  it('renders the embedded picker through the injected model translator, not raw keys', async () => {
    const CHAINS = {
      stable: {
        label: 'Stable',
        links: [
          { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
          { provider: 'opencode-go', model: 'mimo-v2.5' },
        ],
      },
    }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { method: string }
      if (body.method === 'enpoiRoles.list') {
        return new Response(JSON.stringify({ result: { ok: true, value: { roles: [] } } }), { status: 200 })
      }
      return new Response(JSON.stringify({
        result: { value: { namespaces: [{ ns: 'enpoi-orchestration', value: { chains: CHAINS } }] } },
      }), { status: 200 })
    }))
    const translations: Record<string, string> = {
      'trigger.fallback': 'Select model',
      'menu.aria': 'Model and reasoning effort',
      'group.groups': 'Groups',
      'group.model': '{count} model',
      'group.models': '{count} models',
      'effort.providerDefault': 'Default',
    }
    const t = vi.fn((key: string, params?: Record<string, unknown>) => {
      const template = translations[key] ?? key
      return params === undefined
        ? template
        : template.replace(/\{(\w+)\}/g, (_match, name: string) => name in params ? String(params[name]) : _match)
    })
    try {
      mount(mergeRoleRegistry(undefined), {}, directoryFace(), t)
      // Unassigned seats show the override placeholder; the first row's picker
      // is the embedded ModelSelect under test.
      fireEvent.click(screen.getAllByRole('button', { name: 'Inherit' })[0]!)

      // The Groups title and the per-chain "n models" subtitle come from the
      // model namespace the composition binds, never from the raw key.
      expect(await screen.findByText('Groups')).toBeTruthy()
      expect(await screen.findByText('Stable')).toBeTruthy()
      await waitFor(() => { expect(screen.getByText('2 models')).toBeTruthy() })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
