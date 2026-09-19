// @vitest-environment jsdom
/**
 * MCP server authoring in the Capabilities Control Center: catalog rows can be
 * added and removed through revision-fenced `settings.mutate` calls, the add
 * row shows optimistically before the write settles, mount failures from the
 * host heartbeat render per row, and invalid input never reaches the wire.
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

/** Open the add form and fill the four fields. */
function fillAddForm(fields: { id: string; url: string; apiKeyEnv?: string; headers?: string }): void {
  fireEvent.click(screen.getByText('+ Add MCP server'))
  fireEvent.change(screen.getByLabelText('MCP server id'), { target: { value: fields.id } })
  fireEvent.change(screen.getByLabelText('MCP server URL'), { target: { value: fields.url } })
  if (fields.apiKeyEnv !== undefined) {
    fireEvent.change(screen.getByLabelText('MCP server API key env'), { target: { value: fields.apiKeyEnv } })
  }
  if (fields.headers !== undefined) {
    fireEvent.change(screen.getByLabelText('MCP server headers JSON'), { target: { value: fields.headers } })
  }
  fireEvent.click(screen.getByText('Add server'))
}

describe('CapabilitiesBody — MCP server authoring', () => {
  it('adds a server optimistically and writes it with the revision fence', async () => {
    const mutations: MutateBody[] = []
    let releaseMutate: ((res: Response) => void) | undefined
    const mutateGate = new Promise<Response>((resolve) => { releaseMutate = resolve })
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ mcpServers: {} }, 7)
      if (method === 'skills.list') return skillsResponse()
      mutations.push(JSON.parse(String(init.body)) as MutateBody)
      return mutateGate
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    fillAddForm({
      id: 'new-mcp',
      url: 'https://mcp.example.com/mcp',
      apiKeyEnv: 'NEW_MCP_TOKEN',
      headers: '{"x-workspace-slug":"main_base"}',
    })

    // 0ms optimistic row: the catalog row exists before the write settles.
    expect(await screen.findByText('New-mcp MCP')).toBeTruthy()

    releaseMutate?.(jsonResponse({ result: { ok: true, value: { revision: 8 } } }))
    await waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]?.payload.args).toEqual({
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

  it('rolls the optimistic row back and surfaces the failure when the write is rejected', async () => {
    let releaseMutate: ((res: Response) => void) | undefined
    const mutateGate = new Promise<Response>((resolve) => { releaseMutate = resolve })
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ mcpServers: {} }, 1)
      if (method === 'skills.list') return skillsResponse()
      return mutateGate
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    fillAddForm({ id: 'rejected-mcp', url: 'https://rejected.example.com/mcp' })
    expect(await screen.findByText('Rejected-mcp MCP')).toBeTruthy()

    releaseMutate?.(jsonResponse({ result: { ok: false, error: { code: 'settings/rejected', message: 'read-only provider' } } }))
    expect(await screen.findByText('settings write was rejected')).toBeTruthy()
    await waitFor(() => { expect(screen.queryByText('Rejected-mcp MCP')).toBeNull() })
  })

  it('re-reads the namespace and retries a conflicted write with the fresh revision', async () => {
    let revision = 1
    let mutateCount = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') return describeResponse({ mcpServers: {} }, revision)
      if (method === 'skills.list') return skillsResponse()
      mutateCount += 1
      if (mutateCount === 1) {
        revision = 2
        return jsonResponse({ result: { ok: false, error: { code: 'settings/conflict', message: 'stale', details: {} } } })
      }
      return jsonResponse({ result: { ok: true, value: { revision: 3 } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    fillAddForm({ id: 'racy-mcp', url: 'https://racy.example.com/mcp' })
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(2) })
    const mutations = mutateBodies(fetchMock)
    expect(mutations[0]?.payload.args.expectedRevision).toBe(1)
    expect(mutations[1]?.payload.args.expectedRevision).toBe(2)
    expect(mutations[1]?.payload.args.ops[0]?.path).toEqual(['mcpServers', 'racy-mcp'])
  })

  it('removes a catalog server through a fenced unset only after confirmation', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({
          mcpServers: { 'custom-mcp': { serverName: 'custom', transport: 'streamable-http', url: 'http://127.0.0.1:8211/mcp', apiKeyEnv: 'CUSTOM_MCP_TOKEN' } },
          mcpStatus: { 'custom-mcp': { state: 'online', mounted: true, checkedAt: Date.now() } },
        }, 4)
      }
      if (method === 'skills.list') return skillsResponse()
      return jsonResponse({ result: { ok: true, value: { revision: 5 } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()

    fireEvent.click(await screen.findByLabelText('Remove Custom MCP'))
    // First click only arms the confirm step — nothing is written yet.
    expect(mutateBodies(fetchMock)).toHaveLength(0)
    fireEvent.click(screen.getByText('Remove'))

    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    expect(mutateBodies(fetchMock)[0]?.payload.args).toEqual({
      ns: 'enpoi-orchestration',
      expectedRevision: 4,
      ops: [{ op: 'unset', path: ['mcpServers', 'custom-mcp'] }],
    })
    await waitFor(() => { expect(screen.queryByText('Custom MCP')).toBeNull() })
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
    await waitFor(() => {
      expect(document.querySelector('[title="Mount failed — connect ECONNREFUSED 127.0.0.1:9999"]')).not.toBeNull()
    })
  })

  it('rejects an invalid url, a malformed headers payload, and a duplicate id without writing', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const method = methodOf(init)
      if (method === 'settings.describe') {
        return describeResponse({
          mcpServers: { 'plane-mcp': { serverName: 'plane', url: 'http://127.0.0.1:8211/mcp' } },
        }, 1)
      }
      if (method === 'skills.list') return skillsResponse()
      return jsonResponse({ result: { ok: true, value: {} } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await mountBody()
    await screen.findByText('Plane MCP')

    fillAddForm({ id: 'ftp-mcp', url: 'ftp://example.com/mcp' })
    expect(await screen.findByText('url must be an http(s) address')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('MCP server URL'), { target: { value: 'https://example.com/mcp' } })
    fireEvent.change(screen.getByLabelText('MCP server headers JSON'), { target: { value: 'not json' } })
    fireEvent.click(screen.getByText('Add server'))
    expect(await screen.findByText(/headers must be a JSON object|Unexpected token/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('MCP server headers JSON'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('MCP server id'), { target: { value: 'plane-mcp' } })
    fireEvent.click(screen.getByText('Add server'))
    expect(await screen.findByText('server id "plane-mcp" already exists')).toBeTruthy()

    expect(mutateBodies(fetchMock)).toHaveLength(0)
  })
})
