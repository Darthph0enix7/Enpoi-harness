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
function rolesResponse(roles: Array<{ id: string; label?: string; group?: string }> = []): Response {
  return jsonResponse({ result: { ok: true, value: { roles } } })
}

/** One `enpoiCouncil.list` answer. */
function councilsResponse(councils: Array<{ id: string; label?: string; seats?: unknown[]; enabled?: boolean }> = []): Response {
  return jsonResponse({ result: { ok: true, value: { councils } } })
}

/** Two roles and one council, the registries the drawer reads live. */
const LIVE_ROLES = [
  { id: 'oracle', label: 'The Oracle', group: 'supervision' },
  { id: 'fixer', label: 'Fixer', group: 'specialists' },
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
async function mountBody() {
  const mod = await import('../src/client/CapabilitiesBody.tsx')
  const openTab = vi.fn()
  // Stable snapshots: the component derives its skill-candidate chain from the
  // session ids, so a fresh array per render would loop the refresh effect.
  const ids = ['sess-1']
  const props = {
    sessionId: 'sess-1',
    useSessions: (selector: (state: { ids: string[] }) => unknown) => selector({ ids }),
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
            tools: { keeper: true },
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
    expect(await screen.findByText('Keeper')).toBeTruthy()

    // One switch per row: 3 MCP + 2 skills + 2 roles + 1 council + 1 tool flag.
    expect(screen.getAllByRole('switch')).toHaveLength(9)
    // The skill catalog's user-only entry is tagged.
    expect(screen.getByText('user-only')).toBeTruthy()
    // No authoring surface: no add form, no checkbox, no remove control.
    expect(screen.queryByText('+ Add MCP server')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByLabelText(/^Remove /)).toBeNull()
    expect(screen.queryByLabelText('MCP server id')).toBeNull()
  })

  it('shows no hardcoded capability ids when every registry is empty', async () => {
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
    expect(screen.queryByText('The Oracle (Supervisor)')).toBeNull()
    expect(screen.queryByText('File Editor')).toBeNull()
    expect(screen.queryByText('Memory Save')).toBeNull()
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
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
