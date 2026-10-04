// mcp-mounts.spec.ts — the MCP world model: projection fold, modes, tool-name
// mapping, the default-world/pull computation, the refusal text, and the
// `mcp list` rows (agent view omits switched-off servers until pulled in).

import { describe, it, expect } from 'vitest'
import {
  applyMcpMountsProjection, buildMountRows, isOnDemand,
  mcpDefaultWorldIds, mcpDisabledReason, mcpServerOfToolName, mcpToolDenyReason,
  mcpVisibleIds, mcpWorldOf,
  serverModeOf, serverNameOf, type McpMountsProjectionState,
} from '../src/mcp-mounts'

const EMPTY: McpMountsProjectionState = { mounted: [] }

describe('mcpMounts projection', () => {
  it('folds the complete post-change set and dedupes', () => {
    const next = applyMcpMountsProjection(EMPTY, { type: 'mcp/mounts', data: { mounted: ['a', 'b', 'a'] } } as never)
    expect(next.mounted).toEqual(['a', 'b'])
  })

  it('ignores other events and keeps the same reference', () => {
    const state = { mounted: ['a'] }
    expect(applyMcpMountsProjection(state, { type: 'tool-groups/change', data: { attached: [] } } as never)).toBe(state)
  })
})

describe('server modes', () => {
  it('defaults to always-on and reads on-demand explicitly', () => {
    expect(serverModeOf({})).toBe('always-on')
    expect(serverModeOf({ mode: 'on-demand' })).toBe('on-demand')
    expect(serverModeOf({ mode: 'always-on' })).toBe('always-on')
    expect(isOnDemand({ mode: 'on-demand' })).toBe(true)
    expect(isOnDemand(undefined)).toBe(false)
  })

  it('resolves the mounted namespace', () => {
    expect(serverNameOf('unreal-mcp', {})).toBe('unreal')
    expect(serverNameOf('unreal-mcp', { serverName: 'ue' })).toBe('ue')
    expect(serverNameOf('github', {})).toBe('github')
  })
})

describe('mcpServerOfToolName', () => {
  it('extracts the server segment and ignores other names', () => {
    expect(mcpServerOfToolName('mcp__unreal__spawn_actor')).toBe('unreal')
    expect(mcpServerOfToolName('mcp__github__create_issue')).toBe('github')
    expect(mcpServerOfToolName('bash')).toBeUndefined()
    expect(mcpServerOfToolName('mcp__broken')).toBeUndefined()
  })
})

describe('mcpWorldOf — the default world and explicit pulls', () => {
  const catalog = {
    'always-mcp': { url: 'http://always/mcp' },
    'ondemand-mcp': { url: 'http://ondemand/mcp', mode: 'on-demand' },
    'off-mcp': { url: 'http://off/mcp' },
  }

  it('the default world is the master-on always-on servers only', () => {
    expect([...mcpDefaultWorldIds(catalog, new Set(['always-mcp']))]).toEqual(['always-mcp'])
    // on-demand is never in the default world
    expect([...mcpDefaultWorldIds(catalog, new Set(['ondemand-mcp']))]).toEqual([])
    // switch off = no default world at all
    expect([...mcpDefaultWorldIds(catalog, new Set())]).toEqual([])
  })

  it('a switched-off server is absent by default and enters the world only when pulled', () => {
    const master = new Set(['always-mcp'])
    expect(mcpWorldOf(catalog, master, new Set(), {}).has('off-mcp')).toBe(false)
    // an explicit durable mount pulls it in
    expect(mcpWorldOf(catalog, master, new Set(['off-mcp']), {}).has('off-mcp')).toBe(true)
    // the session switch pulls it in
    expect(mcpWorldOf(catalog, master, new Set(), { 'off-mcp': true }).has('off-mcp')).toBe(true)
    // a durable pull survives the master switch and keeps the server in the world
    expect(mcpWorldOf(catalog, new Set(), new Set(['off-mcp']), {}).has('off-mcp')).toBe(true)
  })

  it('a session-off override removes a server for this session only', () => {
    const master = new Set(['always-mcp', 'ondemand-mcp'])
    expect(mcpWorldOf(catalog, master, new Set(), {}).has('always-mcp')).toBe(true)
    expect(mcpWorldOf(catalog, master, new Set(), { 'always-mcp': false }).has('always-mcp')).toBe(false)
    expect(mcpWorldOf(catalog, master, new Set(), { 'ondemand-mcp': false }).has('ondemand-mcp')).toBe(false)
  })

  it('agent visibility = the world plus switched-on pullable servers', () => {
    const master = new Set(['ondemand-mcp'])
    const world = mcpWorldOf(catalog, master, new Set(), {})
    const visible = mcpVisibleIds(catalog, master, world, {})
    expect(visible.has('ondemand-mcp')).toBe(true) // switched on, pullable
    expect(visible.has('off-mcp')).toBe(false) // switched off: the agent does not see it
    const pulled = mcpWorldOf(catalog, master, new Set(['off-mcp']), {})
    expect(mcpVisibleIds(catalog, master, pulled, {}).has('off-mcp')).toBe(true)
    const off = mcpWorldOf(catalog, master, new Set(), { 'ondemand-mcp': false })
    expect(mcpVisibleIds(catalog, master, off, { 'ondemand-mcp': false }).has('ondemand-mcp')).toBe(false)
  })
})

describe('the disabled/pull refusal text', () => {
  const catalog = {
    'always-mcp': { url: 'http://always/mcp' },
    'ondemand-mcp': { url: 'http://ondemand/mcp', mode: 'on-demand' },
    'off-mcp': { url: 'http://off/mcp', mode: 'on-demand' },
  }
  const master = new Set(['always-mcp', 'ondemand-mcp'])

  it('names the disabled switch and the pull paths', () => {
    const reason = mcpDisabledReason('off-mcp')
    expect(reason).toContain('disabled by the operator')
    expect(reason).toContain('capabilities.mcp.off-mcp')
    expect(reason).toContain('mcp:')
    expect(reason).toContain('mount')
  })

  it('denies a switched-off, unpulled server; a pulled one is callable', () => {
    const world = mcpWorldOf(catalog, master, new Set(), {})
    expect(mcpToolDenyReason(catalog, master, world, 'mcp__off__echo')).toContain('disabled by the operator')
    expect(mcpToolDenyReason(catalog, master, world, 'mcp__ondemand__echo')).toContain('on-demand')
    expect(mcpToolDenyReason(catalog, master, world, 'mcp__always__echo')).toBe('')
    const pulled = mcpWorldOf(catalog, master, new Set(['off-mcp']), {})
    expect(mcpToolDenyReason(catalog, master, pulled, 'mcp__off__echo')).toBe('')
    // Unknown servers stay with the policy ladder.
    expect(mcpToolDenyReason(catalog, master, world, 'mcp__ghost__echo')).toBe('')
  })

  it('names the session scope when a default-world server is switched off for one session', () => {
    const world = mcpWorldOf(catalog, master, new Set(), { 'always-mcp': false })
    expect(mcpToolDenyReason(catalog, master, world, 'mcp__always__echo')).toContain('session scope')
  })
})

describe('buildMountRows', () => {
  const catalog = {
    'unreal-mcp': { url: 'http://127.0.0.1:9999/mcp', mode: 'on-demand' },
    github: { url: 'http://127.0.0.1:9998/mcp' },
    broken: { url: 'http://127.0.0.1:9997/mcp', mode: 'on-demand' },
    'no-url': { mode: 'on-demand' },
    'off-mcp': { url: 'http://127.0.0.1:9996/mcp' },
  }
  const master = new Set(['unreal-mcp', 'github', 'broken', 'no-url'])
  const tools = ['mcp__unreal__spawn_actor', 'mcp__unreal__list_actors', 'mcp__github__create_issue', 'bash']

  it('operator view: mounted, available, disabled, unavailable with reasons and counts', () => {
    const rows = buildMountRows(
      catalog,
      master,
      new Set(['unreal-mcp', 'github', 'broken']),
      new Set(['unreal-mcp', 'github']),
      new Map([['broken', 'connect ECONNREFUSED']]),
      tools,
    )
    expect(rows.map(row => [row.id, row.state])).toEqual([
      ['broken', 'unavailable'],
      ['github', 'mounted'],
      ['no-url', 'unavailable'],
      ['off-mcp', 'disabled'],
      ['unreal-mcp', 'mounted'],
    ])
    expect(rows.find(row => row.id === 'unreal-mcp')).toMatchObject({ mode: 'on-demand', enabled: true, toolCount: 2, reason: '' })
    expect(rows.find(row => row.id === 'github')).toMatchObject({ mode: 'always-on', toolCount: 1 })
    expect(rows.find(row => row.id === 'broken')?.reason).toContain('ECONNREFUSED')
    expect(rows.find(row => row.id === 'broken')?.toolCount).toBe(0)
    expect(rows.find(row => row.id === 'no-url')?.reason).toContain('no url')
    expect(rows.find(row => row.id === 'off-mcp')?.reason).toContain('disabled by the operator')
  })

  it('agent view omits a switched-off server until the session pulls it in', () => {
    const include = new Set(['unreal-mcp', 'github', 'broken', 'no-url'])
    const agentRows = buildMountRows(
      catalog,
      master,
      new Set(['unreal-mcp', 'github', 'broken']),
      new Set(['unreal-mcp', 'github']),
      new Map(),
      tools,
      { include },
    )
    expect(agentRows.some(row => row.id === 'off-mcp')).toBe(false)
    // After the pull it appears as mounted, still marked off-by-default.
    const pulled = new Set(['unreal-mcp', 'github', 'broken', 'off-mcp'])
    const pulledRows = buildMountRows(
      catalog,
      master,
      pulled,
      new Set(['unreal-mcp', 'github', 'off-mcp']),
      new Map(),
      tools,
      { include: new Set([...include, 'off-mcp']) },
    )
    expect(pulledRows.find(row => row.id === 'off-mcp')).toMatchObject({ state: 'mounted', enabled: false })
  })

  it('an explicitly pulled switched-off server is mounted, not disabled', () => {
    const rows = buildMountRows(catalog, master, new Set(['off-mcp']), new Set(['off-mcp']), new Map(), tools)
    expect(rows.find(row => row.id === 'off-mcp')).toMatchObject({ state: 'mounted', enabled: false, toolCount: 0 })
  })

  it('a real connection with zero tools is mounted — 0 tools, not a fake mount', () => {
    const rows = buildMountRows(
      { empty: { url: 'http://127.0.0.1:9995/mcp' } },
      new Set(['empty']),
      new Set(['empty']),
      new Set(['empty']),
      new Map(),
      [],
    )
    expect(rows[0]).toMatchObject({ state: 'mounted', toolCount: 0, reason: '' })
  })

  it('an in-world server with no live fiber is unavailable with its reason', () => {
    const rows = buildMountRows(
      { 'always-mcp': { url: 'http://127.0.0.1:9994/mcp' } },
      new Set(['always-mcp']),
      new Set(['always-mcp']),
      new Set(),
      new Map([['always-mcp', 'initial connection failed']]),
      [],
    )
    expect(rows[0]).toMatchObject({ state: 'unavailable', reason: 'initial connection failed', toolCount: 0 })
  })
})
