import { describe, it, expect } from 'vitest'
import {
  mcpToolNames, registeredToolNames, removeMcpServerFenced, MCP_TOOL_PREFIX,
  type McpCatalogSettings, type SettingsPathOp,
} from '../src/mcp-tools'

/** The live catalog + policy shape one fenced removal writes into. */
interface Tree {
  mcpServers: Record<string, { serverName?: string }>
  permissions: {
    tools: Record<string, 'allow' | 'ask' | 'deny'>
    agents: Record<string, { tools: Record<string, 'allow' | 'ask' | 'deny'> }>
  }
}

/** A settings double that applies fenced unset ops and can lose one race. */
function fakeSettings(tree: Tree, options: { failFirst?: boolean } = {}) {
  let revision = 5
  let attempts = 0
  const settings: McpCatalogSettings = {
    get: () => tree as unknown as { mcpServers?: Record<string, { serverName?: string }> },
    // The descriptor carries the resolved document: `removeMcpServerFenced`
    // reads the catalog + policy rows from `descriptor.value`, not `get()`.
    describe: () => [{ ns: 'enpoi-orchestration', revision, value: tree }],
    mutate: async (_ns: string, ops: SettingsPathOp[], expected?: number) => {
      attempts += 1
      if (options.failFirst === true && attempts === 1) {
        revision += 1 // another writer won the race
        throw Object.assign(new Error('stale revision'), { code: 'SETTINGS_CONFLICT' })
      }
      if (expected !== revision) throw Object.assign(new Error('stale revision'), { code: 'SETTINGS_CONFLICT' })
      for (const op of ops) {
        let node = tree as unknown as Record<string, unknown>
        for (const key of op.path.slice(0, -1)) node = node[key] as Record<string, unknown>
        if (op.op === 'unset') delete node[op.path[op.path.length - 1] as string]
      }
      revision += 1
    },
  }
  return { settings, attempts: () => attempts, revision: () => revision }
}

describe('enpoi-capabilities MCP tool projection', () => {
  it('keeps only mcp__ public names, sorted for a stable answer', () => {
    const names = [
      'bash',
      'mcp__plane__list_projects',
      'read',
      'mcp__plane__create_issue',
      'mcp__other__search',
    ]
    expect(mcpToolNames(names)).toEqual([
      'mcp__other__search',
      'mcp__plane__create_issue',
      'mcp__plane__list_projects',
    ])
  })

  it('answers an empty list when no MCP server is mounted', () => {
    expect(mcpToolNames(['bash', 'read', 'subagent'])).toEqual([])
    expect(mcpToolNames([])).toEqual([])
  })

  it('drops non-string entries instead of leaking them into the client', () => {
    expect(mcpToolNames([42 as unknown as string, null as unknown as string, 'mcp__srv__t']))
      .toEqual(['mcp__srv__t'])
  })

  it('projects EVERY live tool name, deduped and sorted (the dynamic row source)', () => {
    expect(registeredToolNames(['whiteboard_write', 'bash', 'whiteboard_read', 'bash', 'mcp__plane__x']))
      .toEqual(['bash', 'mcp__plane__x', 'whiteboard_read', 'whiteboard_write'])
    expect(registeredToolNames(['', 'read'])).toEqual(['read'])
    expect(registeredToolNames([])).toEqual([])
    expect(registeredToolNames([42 as unknown as string, null as unknown as string, 'read'])).toEqual(['read'])
  })

  it('names the exact registration prefix the resolver wildcard ladder keys on', () => {
    expect(MCP_TOOL_PREFIX).toBe('mcp__')
    // The server wildcard the policy ladder checks is `mcp__<server>__*`.
    expect(mcpToolNames(['mcp__plane__list_projects'])[0]?.startsWith(`${MCP_TOOL_PREFIX}plane__`)).toBe(true)
  })

  it('removes the catalog entry and every policy row it owned in one fenced write', async () => {
    const tree: Tree = {
      mcpServers: { 'plane-mcp': { serverName: 'plane' }, 'a__b-mcp': {} },
      permissions: {
        tools: {
          'mcp__plane__*': 'ask',
          'mcp__plane__create_page': 'ask',
          'mcp__a__b__*': 'ask',
          'mcp__plane2__*': 'allow',
        },
        agents: { orchestrator: { tools: { 'mcp__plane__*': 'allow', 'mcp__a__b__*': 'deny' } } },
      },
    }
    const fake = fakeSettings(tree)
    const outcome = await removeMcpServerFenced(fake.settings, 'plane-mcp')
    expect(outcome).toEqual({ removed: true, rows: 3 }) // catalog unset + 3 matching rows
    expect(fake.attempts()).toBe(1)                     // ONE fenced write, rows and entry together
    expect(tree.mcpServers['plane-mcp']).toBeUndefined()
    expect(tree.mcpServers['a__b-mcp']).toEqual({})     // the __-id server's own rows survive
    expect(tree.permissions.tools).toEqual({ 'mcp__a__b__*': 'ask', 'mcp__plane2__*': 'allow' })
    expect(tree.permissions.agents.orchestrator.tools).toEqual({ 'mcp__a__b__*': 'deny' })
  })

  it('retries once on a revision conflict, and never writes for an absent server', async () => {
    const tree: Tree = {
      mcpServers: { 'plane-mcp': { serverName: 'plane' } },
      permissions: { tools: { 'mcp__plane__*': 'ask' }, agents: {} },
    }
    const fake = fakeSettings(tree, { failFirst: true })
    expect(await removeMcpServerFenced(fake.settings, 'plane-mcp')).toEqual({ removed: true, rows: 1 })
    expect(fake.attempts()).toBe(2)
    expect(tree.permissions.tools).toEqual({})
    // Already gone / never existed: no-op, no extra write.
    const before = fake.attempts()
    expect(await removeMcpServerFenced(fake.settings, 'ghost')).toEqual({ removed: false, rows: 0 })
    expect(await removeMcpServerFenced(fake.settings, 'plane-mcp')).toEqual({ removed: false, rows: 0 })
    expect(fake.attempts()).toBe(before)
    // Unavailable settings service: no-op.
    expect(await removeMcpServerFenced(undefined, 'plane-mcp')).toEqual({ removed: false, rows: 0 })
  })
})
