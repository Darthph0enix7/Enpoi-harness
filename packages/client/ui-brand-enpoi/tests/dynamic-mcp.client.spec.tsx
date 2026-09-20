// @vitest-environment jsdom
/**
 * McpPanel catalog editing: add reuses the shared `addMcpServer` writer (same
 * fenced `mcpServers.<id>` set), remove reuses `removeMcpServer` (fenced
 * unset), the enable toggle reuses `toggleCapability` on
 * `capabilities.mcp.<id>`, and an inline edit writes the whole record.
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

/** One successful `settings.mutate` envelope. */
function mutateOk(): Response {
  return jsonResponse({ result: { ok: true, value: { revision: 99 } } })
}

/** The settings.mutate bodies a mock served, in call order. */
function mutateBodies(fetchMock: ReturnType<typeof vi.fn>): MutateBody[] {
  return fetchMock.mock.calls
    .map(call => JSON.parse(String((call as [string, RequestInit])[1].body)) as MutateBody)
    .filter(body => body.method === 'settings.mutate')
}

/** Catalog state the driven gateway serves and mutates. */
interface PanelState {
  servers: Record<string, unknown>
  status: Record<string, unknown>
  caps: Record<string, boolean>
}

/** Mount the panel with a driven, stateful gateway. */
async function mountPanel(initial: Partial<PanelState>) {
  const state: PanelState = {
    servers: { ...(initial.servers ?? {}) },
    status: initial.status ?? {},
    caps: initial.caps ?? {},
  }
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    type MutateOp = { op: string; path: string[]; value?: unknown }
    const body = JSON.parse(String(init.body)) as {
      method: string
      payload?: { args?: { ops?: MutateOp[] } }
    }
    if (body.method === 'settings.describe') {
      return describeResponse({ mcpServers: { ...state.servers }, mcpStatus: state.status, capabilities: { mcp: { ...state.caps } } }, 3)
    }
    if (body.method === 'settings.mutate') {
      for (const op of body.payload?.args?.ops ?? []) {
        const key = op.path[0] === 'mcpServers' ? op.path[1] : undefined
        if (key === undefined) continue
        if (op.op === 'set') state.servers[key] = op.value
        else {
          state.servers = Object.fromEntries(
            Object.entries(state.servers).filter(([candidate]) => candidate !== key),
          )
        }
      }
      return mutateOk()
    }
    throw new Error(`unexpected method ${body.method}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const mod = await import('../src/client/dynamic/McpPanel.tsx')
  render(<mod.McpPanel />)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('McpPanel', () => {
  it('add reuses the shared fenced addMcpServer writer', async () => {
    const fetchMock = await mountPanel({})
    fireEvent.click(await screen.findByRole('button', { name: '+ Add MCP server' }))
    fireEvent.change(screen.getByLabelText('MCP server id'), { target: { value: 'plane' } })
    fireEvent.change(screen.getByLabelText('MCP server URL'), { target: { value: 'https://plane.example/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    const body = mutateBodies(fetchMock)[0]!
    expect(body.payload.args.ns).toBe('enpoi-orchestration')
    expect(body.payload.args.expectedRevision).toBe(3)
    expect(body.payload.args.ops).toEqual([{
      op: 'set',
      path: ['mcpServers', 'plane'],
      value: { serverName: 'plane', transport: 'streamable-http', url: 'https://plane.example/mcp' },
    }])
  })

  it('remove reuses the shared fenced removeMcpServer writer', async () => {
    const fetchMock = await mountPanel({
      servers: { plane: { serverName: 'plane', transport: 'streamable-http', url: 'https://plane.example/mcp' } },
      caps: { plane: true },
    })
    fireEvent.click(await screen.findByLabelText('Remove plane'))
    fireEvent.click(screen.getByLabelText('Confirm remove plane'))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    const body = mutateBodies(fetchMock)[0]!
    expect(body.payload.args.expectedRevision).toBe(3)
    expect(body.payload.args.ops).toEqual([{ op: 'unset', path: ['mcpServers', 'plane'] }])
  })

  it('enable toggle writes the capabilities.mcp path', async () => {
    const fetchMock = await mountPanel({})
    fireEvent.click(await screen.findByLabelText('Enable Plane MCP'))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    expect(mutateBodies(fetchMock)[0]!.payload.args.ops).toEqual([
      { op: 'set', path: ['capabilities', 'mcp', 'plane-mcp'], value: true },
    ])
  })

  it('renders the mount failure reported by the host heartbeat', async () => {
    await mountPanel({
      servers: { plane: { serverName: 'plane', url: 'https://plane.example/mcp' } },
      status: { plane: { state: 'down', mounted: false, checkedAt: Date.now(), error: 'connection refused' } },
      caps: { plane: true },
    })
    expect(await screen.findByText(/mount failed: connection refused/)).toBeTruthy()
  })

  it('inline edit writes the whole server record fenced', async () => {
    const fetchMock = await mountPanel({
      servers: { plane: { serverName: 'plane', transport: 'streamable-http', url: 'https://old.example/mcp' } },
      caps: { plane: true },
    })
    fireEvent.click(await screen.findByLabelText('Edit plane'))
    fireEvent.change(screen.getByLabelText('plane url'), { target: { value: 'https://new.example/mcp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save server' }))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    const body = mutateBodies(fetchMock)[0]!
    expect(body.payload.args.expectedRevision).toBe(3)
    expect(body.payload.args.ops).toEqual([{
      op: 'set',
      path: ['mcpServers', 'plane'],
      value: { serverName: 'plane', transport: 'streamable-http', url: 'https://new.example/mcp' },
    }])
  })
})
