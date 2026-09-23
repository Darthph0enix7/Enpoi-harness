// @vitest-environment jsdom
/**
 * Capabilities Control Center — read-only status drawer. Rows render
 * enabled/disabled/mounted state chips with no switches, no add form, and no
 * per-row remove control; the one management link opens Settings → Dynamic.
 * The shared writers (`addMcpServer`, `removeMcpServer`, `toggleCapability`)
 * stay exported for the Settings → Dynamic page and are driven directly here.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

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

/** One empty skills.list answer (the tab primes the live catalog). */
function skillsResponse(): Response {
  return jsonResponse({ result: { ok: true, value: { skills: [] } } })
}

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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('CapabilitiesBody — read-only status', () => {
  it('renders state chips and no authoring controls', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({
          mcpServers: {
            'custom-mcp': { serverName: 'custom', transport: 'streamable-http', url: 'http://127.0.0.1:8211/mcp' },
            'off-mcp': { serverName: 'off', transport: 'streamable-http', url: 'http://127.0.0.1:8212/mcp' },
          },
          mcpStatus: {
            'plane-mcp': { state: 'online', mounted: true, checkedAt: Date.now() },
            'custom-mcp': { state: 'online', mounted: false, checkedAt: Date.now() },
          },
          capabilities: { mcp: { 'plane-mcp': true, 'custom-mcp': true } },
        }, 4)
      }
      if (method === 'skills.list') return skillsResponse()
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    expect(await screen.findByText('Plane MCP')).toBeTruthy()
    expect(await screen.findByText('Custom MCP')).toBeTruthy()
    // Plane is enabled by its mounted heartbeat; custom is toggled on but not mounted.
    expect(screen.getAllByText('Mounted').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Enabled').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Disabled').length).toBeGreaterThan(0)
    // No authoring surface: no add form, no checkboxes, no remove control.
    expect(screen.queryByText('+ Add MCP server')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByLabelText(/^Remove /)).toBeNull()
    expect(screen.queryByLabelText('MCP server id')).toBeNull()
  })

  it('deep-links the single Manage in Settings control to the Dynamic section', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ mcpServers: {} }, 1)
      if (method === 'skills.list') return skillsResponse()
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { mod } = await mountBody()
    await screen.findByText('Plane MCP')

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
      if (method === 'skills.list') return skillsResponse()
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    expect(await screen.findByText('mount failed: connect ECONNREFUSED 127.0.0.1:9999')).toBeTruthy()
    expect(document.querySelector('[title="Mount failed — connect ECONNREFUSED 127.0.0.1:9999"]')).not.toBeNull()
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
