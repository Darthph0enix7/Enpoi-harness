// @vitest-environment jsdom
/**
 * Capabilities Control Center — live capability drawer. Every row comes from a
 * live registry (`mcpServers` + `mcpStatus`, `skills.list`, `enpoiRoles.list`,
 * `enpoiCouncil.list`, stored `capabilities.tools` flags) and carries an
 * enable/disable switch that writes `capabilities.<kind>.<id>` optimistically.
 * Catalog authoring stays in Settings → Dynamic. The shared writers
 * (`addMcpServer`, `removeMcpServer`, `toggleCapability`) stay exported for
 * that page and are driven directly here.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { brandT } from './brand-i18n.client.ts'

/** One parsed `settings.mutate` request body. */
interface MutateBody {
  method: string
  payload: {
    args: {
      ns: string
      expectedRevision?: number
      ops: Array<{ op: string; path: string[]; value?: unknown }>
    }
  }
}

/** One JSON response envelope. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** One `settings.describe` answer carrying the enpoi-orchestration namespace. */
function describeResponse(value: unknown, revision: number): Response {
  return jsonResponse({ result: { ok: true, value: { namespaces: [{ ns: 'enpoi-orchestration', revision, value }] } } })
}

/** One `skills.list` answer; the drawer renders exactly these rows. */
function skillsResponse(skills: Array<{ name: string; description?: string; modelInvocable?: boolean }> = []): Response {
  return jsonResponse({ result: { ok: true, value: { skills } } })
}

/** One `enpoiRoles.list` answer. */
function rolesResponse(roles: Array<{ id: string; label?: string; group?: string; spawnable?: boolean }> = []): Response {
  return jsonResponse({ result: { ok: true, value: { roles } } })
}

/** One `enpoiCouncil.list` answer. */
function councilsResponse(councils: Array<{ id: string; label?: string; seats?: unknown[]; enabled?: boolean }> = []): Response {
  return jsonResponse({ result: { ok: true, value: { councils } } })
}

/** Two roles and one council, the registries the drawer reads live. */
const LIVE_ROLES = [
  // The shipped Oracle is tool-only: no spawn affordance, shown once as a tool.
  { id: 'oracle', label: 'The Oracle', group: 'supervision', spawnable: false },
  { id: 'fixer', label: 'Fixer', group: 'specialists', spawnable: true },
]
const LIVE_COUNCILS = [
  { id: 'roundtable', label: 'Architecture Roundtable', seats: [{ id: 'skeptic' }, { id: 'architect' }], enabled: true },
]

/** The request method of one fetch call body. */
function methodOf(init: RequestInit): string {
  return (JSON.parse(String(init.body)) as { method: string }).method
}

/** The settings.mutate bodies a mock served, in call order. */
function mutateBodies(fetchMock: ReturnType<typeof vi.fn>): MutateBody[] {
  return fetchMock.mock.calls
    .map(call => JSON.parse(String((call as [string, RequestInit])[1].body)) as MutateBody)
    .filter(body => body.method === 'settings.mutate')
}

/** Render the tab body with driven framework hooks. */
async function mountBody(options: { blank?: boolean; projectionValues?: Record<string, unknown> } = {}) {
  const mod = await import('../src/client/CapabilitiesBody.tsx')
  const openTab = vi.fn()
  // Stable snapshots: the component derives its skill-candidate chain from the
  // session ids, so a fresh array per render would loop the refresh effect.
  const ids = ['sess-1']
  const state = {
    ids,
    byId: {
      'sess-1': {
        blank: options.blank ?? true,
        ...options.projectionValues === undefined ? {} : { projectionValues: options.projectionValues },
      },
    },
  }
  const props = {
    sessionId: 'sess-1',
    t: brandT,
    useSessions: (selector: (value: typeof state) => unknown) => selector(state),
    useTabInfo: () => ({ tab: { visible: true, actions: { openTab } } }),
  } as unknown as Parameters<typeof mod.CapabilitiesBody>[0]
  render(<mod.CapabilitiesBody {...props} />)
  return { mod, openTab }
}

/** Serve the live registry RPCs with one fixture set for the drawer tests. */
function registryResponse(
  method: string,
  skills: Array<{ name: string; description?: string; modelInvocable?: boolean }>,
  roles: Array<{ id: string; label?: string; group?: string }> = LIVE_ROLES,
  councils: Array<{ id: string; label?: string; seats?: unknown[]; enabled?: boolean }> = LIVE_COUNCILS,
): Response | undefined {
  if (method === 'skills.list') return skillsResponse(skills)
  if (method === 'enpoiRoles.list') return rolesResponse(roles)
  if (method === 'enpoiCouncil.list') return councilsResponse(councils)
  return undefined
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('CapabilitiesBody — live capability rows', () => {
  it('renders a switch per live row and no authoring controls', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({
          mcpServers: {
            'plane-mcp': { serverName: 'plane', transport: 'streamable-http', url: 'http://127.0.0.1:8211/mcp' },
            'custom-mcp': { serverName: 'custom', transport: 'streamable-http', url: 'http://127.0.0.1:8212/mcp' },
            'off-mcp': { serverName: 'off', transport: 'streamable-http', url: 'http://127.0.0.1:8213/mcp' },
          },
          mcpStatus: {
            'plane-mcp': { state: 'online', mounted: true, checkedAt: Date.now() },
            'custom-mcp': { state: 'online', mounted: false, checkedAt: Date.now() },
          },
          capabilities: {
            mcp: { 'plane-mcp': true, 'custom-mcp': true },
            skills: { 'tier1-workflow': false },
            tools: { oracle_review: true, keeper: true },
          },
        }, 4)
      }
      const registry = registryResponse(method, [
        { name: 'tier1-workflow', description: 'Guided planning', modelInvocable: true },
        { name: 'ue-mcp', description: 'Unreal Engine', modelInvocable: false },
      ])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    // Every row name is live: configured MCP servers, catalog skills, roles,
    // councils, and the stored tool flag the registries do not cover.
    expect(await screen.findByText('Plane MCP')).toBeTruthy()
    expect(await screen.findByText('Custom MCP')).toBeTruthy()
    expect(await screen.findByText('Off MCP')).toBeTruthy()
    expect(await screen.findByText('Tier1 Workflow')).toBeTruthy()
    expect(await screen.findByText('UE MCP')).toBeTruthy()
    expect(await screen.findByText('The Oracle')).toBeTruthy()
    expect(await screen.findByText('Fixer')).toBeTruthy()
    expect(await screen.findByText('Architecture Roundtable')).toBeTruthy()
    expect(await screen.findByText('Background Context Keeper')).toBeTruthy()

    // One switch per row: 3 MCP + 2 skills + 1 delegatable role + 1 council
    // + 2 tool flags (oracle_review, keeper).
    expect(screen.getAllByRole('switch')).toHaveLength(9)
    // The skill catalog's user-only entry is tagged.
    expect(screen.getByText('user-only')).toBeTruthy()
    // No authoring surface: no add form, no checkbox, no remove control.
    expect(screen.queryByText('+ Add MCP server')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByLabelText(/^Remove /)).toBeNull()
    expect(screen.queryByLabelText('MCP server id')).toBeNull()
  })

  it('shows the Oracle once, as a tool-only supervision tool with its guard switch', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({ capabilities: { tools: { oracle_review: true, keeper: true } } }, 5)
      }
      if (method === 'settings.mutate') return jsonResponse({ result: { ok: true, value: { revision: 6 } } })
      const registry = registryResponse(method, [])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    // The Oracle renders once: its role row is gone from Subagents (no spawn
    // affordance), so only the delegatable Fixer keeps the role description.
    expect(await screen.findByText('The Oracle')).toBeTruthy()
    expect(screen.queryAllByText('Delegated subagent role')).toHaveLength(1)
    expect(screen.queryByText('Fixer')).not.toBeNull()
    expect(screen.getByText('Senior reviewer — consulted via oracle_review with source-verified verdicts')).toBeTruthy()
    expect(screen.getByText('supervision · tool-only')).toBeTruthy()
    expect(screen.getByText("Keeps the session's state checkpoint and durable claims current")).toBeTruthy()

    // Its switch keeps the enforcement key: capabilities.tools.oracle_review.
    fireEvent.click(screen.getByLabelText('Disable The Oracle'))
    await waitFor(() => {
      expect(mutateBodies(fetchMock)[0]?.payload.args.ops).toEqual([
        { op: 'set', path: ['capabilities', 'tools', 'oracle_review'], value: false },
      ])
    })
  })

  it('lists the supervision tool-only rows on a fresh home and defaults them ON', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ capabilities: {} }, 21)
      if (method === 'settings.mutate') return jsonResponse({ result: { ok: true, value: { revision: 22 } } })
      const registry = registryResponse(method, [])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    // A fresh home strips the stored capabilities section, so the Oracle and
    // the Keeper must still render from the supervision catalog, and an absent
    // flag reads as ON under the tool rule.
    expect(await screen.findByText('The Oracle')).toBeTruthy()
    expect(screen.getByText('Background Context Keeper')).toBeTruthy()
    expect(screen.getByText('supervision · tool-only')).toBeTruthy()
    expect(screen.getByLabelText('Disable The Oracle')).toBeTruthy()
    expect(screen.getByLabelText('Disable Background Context Keeper')).toBeTruthy()

    // Toggling writes the same guard key as any stored tool flag.
    fireEvent.click(screen.getByLabelText('Disable The Oracle'))
    expect(screen.getByLabelText('Enable The Oracle')).toBeTruthy()
    await waitFor(() => {
      expect(mutateBodies(fetchMock)[0]?.payload.args.ops).toEqual([
        { op: 'set', path: ['capabilities', 'tools', 'oracle_review'], value: false },
      ])
    })
  })

  it('renders a stored oracle_review: false as off and toggles it back ON', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({ capabilities: { tools: { oracle_review: false } } }, 31)
      }
      if (method === 'settings.mutate') return jsonResponse({ result: { ok: true, value: { revision: 32 } } })
      const registry = registryResponse(method, [])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    const oracleSwitch = await screen.findByLabelText('Enable The Oracle')
    expect(oracleSwitch).toBeTruthy()
    // The Keeper has no stored flag, so it stays ON.
    expect(screen.getByLabelText('Disable Background Context Keeper')).toBeTruthy()

    fireEvent.click(oracleSwitch)
    await waitFor(() => {
      expect(mutateBodies(fetchMock)[0]?.payload.args.ops).toEqual([
        { op: 'set', path: ['capabilities', 'tools', 'oracle_review'], value: true },
      ])
    })
    expect(screen.getByLabelText('Disable The Oracle')).toBeTruthy()
  })

  it('renders one row when a stored flag and a registry row share an id', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({ capabilities: { tools: { fixer: false, roundtable: true } } }, 41)
      }
      const registry = registryResponse(method, [])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    // The role and council rows win over the stored flags with the same ids;
    // the supervision pair is the only tool-flag rows.
    expect(await screen.findByLabelText('Enable Fixer')).toBeTruthy()
    expect(screen.getAllByLabelText(/Fixer/)).toHaveLength(1)
    expect(screen.getAllByLabelText(/Architecture Roundtable/)).toHaveLength(1)
    expect(screen.getAllByRole('switch')).toHaveLength(4)
  })

  it('lists only the supervision tool-only rows when every other registry is empty', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ capabilities: {} }, 1)
      const registry = registryResponse(method, [], [], [])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    expect(await screen.findByText('No MCP servers configured. Add one in Settings → Dynamic.')).toBeTruthy()
    expect(screen.queryByText('Plane MCP')).toBeNull()
    // Settings-catalog names and ids are not rendered; the shipped supervision
    // entries are the one static set (see the fresh-home spec above).
    expect(screen.queryByText('The Oracle (Supervisor)')).toBeNull()
    expect(screen.queryByText('File Editor')).toBeNull()
    expect(screen.queryByText('Memory Save')).toBeNull()
    expect(screen.getByText('The Oracle')).toBeTruthy()
    expect(screen.getByText('Background Context Keeper')).toBeTruthy()
    expect(screen.getAllByRole('switch')).toHaveLength(2)
  })

  it('renders a freshly discovered skill id with no code change', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ capabilities: {} }, 1)
      const registry = registryResponse(method, [{ name: '__probe-dynamic__', description: 'temporary probe', modelInvocable: true }])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    expect(await screen.findByText('Probe Dynamic')).toBeTruthy()
    expect(screen.getByLabelText('Disable Probe Dynamic')).toBeTruthy()
  })

  it('deep-links the single Manage in Settings control to the Dynamic section', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ mcpServers: {} }, 1)
      const registry = registryResponse(method, [])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mod } = await mountBody()
    await screen.findByText('Manage in Settings')

    const open = vi.fn()
    mod.setOpenSettingsHandler(open)
    fireEvent.click(screen.getByText('Manage in Settings'))
    expect(open).toHaveBeenCalledWith('dynamic')
    expect(open).toHaveBeenCalledTimes(1)
    mod.setOpenSettingsHandler(null)
  })

  it('renders the host mount failure per row and keeps it outranking reachability', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({
          mcpServers: { 'broken-mcp': { serverName: 'broken', url: 'http://127.0.0.1:9999/mcp' } },
          mcpStatus: { 'broken-mcp': { state: 'down', mounted: false, checkedAt: Date.now(), error: 'connect ECONNREFUSED 127.0.0.1:9999' } },
        }, 1)
      }
      const registry = registryResponse(method, [])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    expect(await screen.findByText('mount failed: connect ECONNREFUSED 127.0.0.1:9999')).toBeTruthy()
    expect(document.querySelector('[title="Mount failed — connect ECONNREFUSED 127.0.0.1:9999"]')).not.toBeNull()
  })

  it('flips a skill switch optimistically and persists capabilities.skills.<id>', async () => {
    let settleMutate: (value: Response) => void = () => {}
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({ capabilities: { skills: { 'tier1-workflow': false } } }, 11)
      }
      if (method === 'settings.mutate') {
        return await new Promise<Response>((resolve) => { settleMutate = resolve })
      }
      const registry = registryResponse(method, [{ name: 'tier1-workflow', description: 'Guided planning', modelInvocable: true }])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    fireEvent.click(await screen.findByLabelText('Enable Tier1 Workflow'))
    // 0ms: the row has already flipped while the write is in flight.
    expect(screen.getByLabelText('Disable Tier1 Workflow')).toBeTruthy()

    settleMutate(jsonResponse({ result: { ok: true, value: { revision: 12 } } }))
    await waitFor(() => {
      expect(mutateBodies(fetchMock)[0]?.payload.args.ops).toEqual([
        { op: 'set', path: ['capabilities', 'skills', 'tier1-workflow'], value: true },
      ])
    })
    expect(screen.getByLabelText('Disable Tier1 Workflow')).toBeTruthy()
  })

  it('rolls a rejected toggle back and reports the failure', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({ capabilities: { skills: { 'tier1-workflow': false } } }, 11)
      }
      if (method === 'settings.mutate') {
        return jsonResponse({ result: { ok: false, error: { code: 'denied', message: 'nope' } } })
      }
      const registry = registryResponse(method, [{ name: 'tier1-workflow', description: 'Guided planning', modelInvocable: true }])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    fireEvent.click(await screen.findByLabelText('Enable Tier1 Workflow'))
    expect(await screen.findByLabelText('Enable Tier1 Workflow')).toBeTruthy()
    expect(await screen.findByText(/Could not persist tier1-workflow/)).toBeTruthy()
  })

  it('toggles a role row under the guard key capabilities.tools.<id>', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ capabilities: { tools: { fixer: false } } }, 3)
      if (method === 'settings.mutate') return jsonResponse({ result: { ok: true, value: { revision: 4 } } })
      const registry = registryResponse(method, [])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    fireEvent.click(await screen.findByLabelText('Enable Fixer'))
    await waitFor(() => {
      expect(mutateBodies(fetchMock)[0]?.payload.args.ops).toEqual([
        { op: 'set', path: ['capabilities', 'tools', 'fixer'], value: true },
      ])
    })
  })
})

describe('CapabilitiesBody — shared capability writers', () => {
  it('addMcpServer writes the fenced mcpServers set', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ mcpServers: {} }, 7)
      return jsonResponse({ result: { ok: true, value: { revision: 8 } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../src/client/CapabilitiesBody.tsx')

    const result = await mod.addMcpServer({
      serverName: 'new-mcp',
      url: 'https://mcp.example.com/mcp',
      apiKeyEnv: 'NEW_MCP_TOKEN',
      headers: { 'x-workspace-slug': 'main_base' },
    })

    expect(result).toEqual({ ok: true })
    expect(mutateBodies(fetchMock)[0]?.payload.args).toEqual({
      ns: 'enpoi-orchestration',
      expectedRevision: 7,
      ops: [{
        op: 'set',
        path: ['mcpServers', 'new-mcp'],
        value: {
          serverName: 'new-mcp',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/mcp',
          apiKeyEnv: 'NEW_MCP_TOKEN',
          headers: { 'x-workspace-slug': 'main_base' },
        },
      }],
    })
  })

  it('addMcpServer re-reads and retries a conflicted write with the fresh revision', async () => {
    let revision = 1
    let mutateCount = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ mcpServers: {} }, revision)
      mutateCount += 1
      if (mutateCount === 1) {
        revision = 2
        return jsonResponse({ result: { ok: false, error: { code: 'settings/conflict', message: 'stale', details: {} } } })
      }
      return jsonResponse({ result: { ok: true, value: { revision: 3 } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../src/client/CapabilitiesBody.tsx')

    const result = await mod.addMcpServer({ serverName: 'racy-mcp', url: 'https://racy.example.com/mcp' })

    expect(result).toEqual({ ok: true })
    const mutations = mutateBodies(fetchMock)
    expect(mutations).toHaveLength(2)
    expect(mutations[0]?.payload.args.expectedRevision).toBe(1)
    expect(mutations[1]?.payload.args.expectedRevision).toBe(2)
    expect(mutations[1]?.payload.args.ops[0]?.path).toEqual(['mcpServers', 'racy-mcp'])
  })

  it('addMcpServer rejects invalid input and duplicate ids without writing', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({
          mcpServers: { 'plane-mcp': { serverName: 'plane', url: 'http://127.0.0.1:8211/mcp' } },
        }, 1)
      }
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../src/client/CapabilitiesBody.tsx')

    expect(await mod.addMcpServer({ serverName: '', url: 'https://example.com/mcp' }))
      .toEqual({ ok: false, reason: 'server id is required' })
    expect(await mod.addMcpServer({ serverName: 'ftp-mcp', url: 'ftp://example.com/mcp' }))
      .toEqual({ ok: false, reason: 'url must be an http(s) address' })
    expect(await mod.addMcpServer({ serverName: 'plane-mcp', url: 'https://example.com/mcp' }))
      .toEqual({ ok: false, reason: 'server id "plane-mcp" already exists' })
    expect(mutateBodies(fetchMock)).toHaveLength(0)
  })

  it('removeMcpServer writes a fenced unset and reports a cache miss', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({
          mcpServers: { 'custom-mcp': { serverName: 'custom', transport: 'streamable-http', url: 'http://127.0.0.1:8211/mcp' } },
        }, 4)
      }
      return jsonResponse({ result: { ok: true, value: { revision: 5 } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../src/client/CapabilitiesBody.tsx')

    expect(await mod.removeMcpServer('ghost-mcp'))
      .toEqual({ ok: false, reason: 'no stored mcpServers.ghost-mcp record to remove' })

    await mod.refreshMcpStatus()
    expect(await mod.removeMcpServer('custom-mcp')).toEqual({ ok: true })
    expect(mutateBodies(fetchMock)[0]?.payload.args).toEqual({
      ns: 'enpoi-orchestration',
      expectedRevision: 4,
      ops: [{ op: 'unset', path: ['mcpServers', 'custom-mcp'] }],
    })
  })

  it('toggleCapability writes capabilities.mcp.<id> and refuses protected tools', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({}, 2)
      return jsonResponse({ result: { ok: true, value: { revision: 3 } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const mod = await import('../src/client/CapabilitiesBody.tsx')

    expect(await mod.toggleCapability('mcp', 'plane-mcp', true)).toBe(true)
    expect(mutateBodies(fetchMock)[0]?.payload.args.ops).toEqual([
      { op: 'set', path: ['capabilities', 'mcp', 'plane-mcp'], value: true },
    ])

    expect(await mod.toggleCapability('tool', 'read', false)).toBe(false)
    expect(mutateBodies(fetchMock)).toHaveLength(1)
  })
})

describe('CapabilitiesBody — defaults vs session overrides', () => {
  /** Serve the drawer's registries with one skill and one on-demand MCP server. */
  function scopingFetch() {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({
          mcpServers: { 'plane-mcp': { serverName: 'plane', url: 'http://127.0.0.1:8211/mcp', mode: 'on-demand' } },
          capabilities: { mcp: { 'plane-mcp': true }, skills: {}, tools: {} },
        }, 4)
      }
      const registry = registryResponse(method, [{ name: 'tier1-workflow', description: 'Guided planning' }], [], [])
      if (registry !== undefined) return registry
      if (method === 'settings.mutate') return jsonResponse({ result: { ok: true, value: { revision: 5 } } })
      return jsonResponse({ result: { ok: true, value: { ok: true, reason: '' } } })
    })
  }

  it('labels the blank page as defaults and writes the profile default', async () => {
    const fetchMock = scopingFetch()
    vi.stubGlobal('fetch', fetchMock)
    await mountBody({ blank: true })
    expect(await screen.findByText('Editing defaults')).toBeTruthy()
    expect(screen.getByText(/every future session inherits/)).toBeTruthy()
    expect(screen.queryByText('session')).toBeNull()

    fireEvent.click(screen.getByLabelText('Disable Tier1 Workflow'))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    expect(mutateBodies(fetchMock)[0]!.payload.args.ops).toEqual([
      { op: 'set', path: ['capabilities', 'skills', 'tier1-workflow'], value: false },
    ])
  })

  it('labels a live session, writes an override, and marks the row', async () => {
    const fetchMock = scopingFetch()
    vi.stubGlobal('fetch', fetchMock)
    await mountBody({
      blank: false,
      projectionValues: { capabilityOverrides: { skills: { 'tier1-workflow': false }, tools: {}, mcp: {} } },
    })
    expect(await screen.findByText('This session')).toBeTruthy()
    expect(screen.getByText(/the profile default is untouched/)).toBeTruthy()
    // The overridden row carries the marker and a Reset control.
    expect(screen.getByText('session')).toBeTruthy()
    expect(screen.getByLabelText('Reset Tier1 Workflow to the profile default')).toBeTruthy()
    // The effective value is the override (off), not the default (on).
    expect(screen.getByLabelText('Enable Tier1 Workflow').getAttribute('aria-checked')).toBe('false')

    fireEvent.click(screen.getByLabelText('Enable Tier1 Workflow'))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(call => String(call[0]) === '/api/enpoiCapabilities.setCapabilityOverride')).toBe(true)
    })
    const call = fetchMock.mock.calls.find(candidate => String(candidate[0]) === '/api/enpoiCapabilities.setCapabilityOverride')!
    const body = JSON.parse(String((call[1] as RequestInit).body))
    expect(body.payload.args).toEqual({ sessionId: 'sess-1', kind: 'skills', id: 'tier1-workflow', value: true })
    // No default write happened.
    expect(mutateBodies(fetchMock)).toHaveLength(0)
  })

  it('resets an overridden row to the default', async () => {
    const fetchMock = scopingFetch()
    vi.stubGlobal('fetch', fetchMock)
    await mountBody({
      blank: false,
      projectionValues: { capabilityOverrides: { skills: { 'tier1-workflow': false }, tools: {}, mcp: {} } },
    })
    fireEvent.click(await screen.findByLabelText('Reset Tier1 Workflow to the profile default'))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(call => String(call[0]) === '/api/enpoiCapabilities.setCapabilityOverride')).toBe(true)
    })
    const call = fetchMock.mock.calls.find(candidate => String(candidate[0]) === '/api/enpoiCapabilities.setCapabilityOverride')!
    const body = JSON.parse(String((call[1] as RequestInit).body))
    expect(body.payload.args).toEqual({ sessionId: 'sess-1', kind: 'skills', id: 'tier1-workflow', value: null })
  })

  it('shows an agent MCP mount as a session override and resets by unmounting', async () => {
    const fetchMock = scopingFetch()
    vi.stubGlobal('fetch', fetchMock)
    await mountBody({
      blank: false,
      projectionValues: { mcpMounts: { mounted: ['plane-mcp'] }, capabilityOverrides: { skills: {}, tools: {}, mcp: {} } },
    })
    expect(await screen.findByText('Plane MCP')).toBeTruthy()
    // Mounted on-demand server: enabled + marked as a session mount.
    expect(screen.getByLabelText('Disable Plane MCP').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('mounted').getAttribute('data-capability-mount')).toBe('plane-mcp')
    expect(screen.queryByText('session')).toBeNull()
    expect(screen.getByLabelText('Reset Plane MCP to the profile default')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Reset Plane MCP to the profile default'))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(call => String(call[0]) === '/api/enpoiCapabilities.mcpUnmount')).toBe(true)
    })
    const call = fetchMock.mock.calls.find(candidate => String(candidate[0]) === '/api/enpoiCapabilities.mcpUnmount')!
    const body = JSON.parse(String((call[1] as RequestInit).body))
    expect(body.payload.args).toEqual({ sessionId: 'sess-1', server: 'plane-mcp' })
  })

  it('distinguishes a session mount from a profile default and keeps a session-off override on the plain marker', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({
          mcpServers: {
            'always-mcp': { serverName: 'always', url: 'http://127.0.0.1:8212/mcp' },
            'plane-mcp': { serverName: 'plane', url: 'http://127.0.0.1:8211/mcp', mode: 'on-demand' },
          },
          capabilities: { mcp: { 'always-mcp': true, 'plane-mcp': true }, skills: { 'tier1-workflow': true, 'tier3-workflow': true }, tools: {} },
        }, 4)
      }
      const registry = registryResponse(method, [
        { name: 'tier1-workflow', description: 'Guided planning' },
        { name: 'tier3-workflow', description: 'All-out implementation' },
      ], [], [])
      if (registry !== undefined) return registry
      return jsonResponse({ result: { ok: true, value: { ok: true, reason: '' } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody({
      blank: false,
      projectionValues: {
        mcpMounts: { mounted: ['plane-mcp'] },
        capabilityOverrides: { skills: { 'tier1-workflow': true, 'tier3-workflow': false }, tools: {}, mcp: {} },
      },
    })
    expect(await screen.findByText('Always MCP')).toBeTruthy()
    // Only the session layer's ON rows carry the mount marker: the mounted
    // on-demand server and the session-enabled skill. The always-on default
    // carries nothing; the session-OFF skill keeps the plain session marker.
    const mounted = [...document.querySelectorAll('[data-capability-mount]')]
      .map(node => node.getAttribute('data-capability-mount'))
    expect(mounted.sort()).toEqual(['plane-mcp', 'tier1-workflow'])
    const plain = [...document.querySelectorAll('[data-capability-override]')]
      .map(node => node.getAttribute('data-capability-override'))
    expect(plain).toEqual(['tier3-workflow'])
    expect(screen.getByText('Always MCP')).toBeTruthy()
  })
})
