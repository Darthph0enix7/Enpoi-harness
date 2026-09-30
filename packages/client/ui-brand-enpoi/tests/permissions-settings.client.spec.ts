/**
 * Doc 55 permission-policy pure helpers (permissions-model.ts) — the model
 * layer behind the Permissions Settings section and the Capabilities strip.
 * Same-package test: imports internals directly via the relative source path.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildAgentList,
  buildAgentSubjects,
  buildPermissionToolRows,
  builtRoleAvailability,
  countPermissionRules,
  cyclePolicy,
  describePermissionsView,
  effectivePolicy,
  fetchMcpToolNames,
  fetchRegisteredToolNames,
  grantScopeHint,
  groupMcpToolNames,
  isAggregateRow,
  persistRowPolicyOps,
  provenanceFor,
  roleRowChecked,
  roleSurfaceFor,
  rowPolicyOps,
  rowPolicyState,
  rowTargets,
  setPermissionPath,
  shippedPolicyFor,
  toolGrantApplies,
  unsetPermissionPath,
  type PermissionToolRow,
  type PermissionsConfig,
} from '../src/client/permissions-model.ts'
import { mergeRoleRegistry } from '../src/client/role-registry.ts'

describe('cyclePolicy', () => {
  it('advances allow → ask → deny → inherit and restarts the cycle', () => {
    expect(cyclePolicy(undefined)).toBe('allow')
    expect(cyclePolicy('allow')).toBe('ask')
    expect(cyclePolicy('ask')).toBe('deny')
    expect(cyclePolicy('deny')).toBeUndefined()
  })
})

describe('buildAgentList', () => {
  it('merges user-added agents after the roster order, extras sorted, duplicates dropped', () => {
    expect(buildAgentList(['oracle', 'keeper'], ['zeta', 'oracle', 'alpha']))
      .toEqual(['oracle', 'keeper', 'alpha', 'zeta'])
  })

  it('skips empty names and tolerates an empty roster', () => {
    expect(buildAgentList([], ['', 'muse'])).toEqual(['muse'])
  })
})

describe('buildAgentSubjects', () => {
  it('leads with the main agents (flagged), then registry roles, deduping the roster and permission extras', () => {
    const registry = mergeRoleRegistry({ muse: { label: 'The Muse' } })
    const subjects = buildAgentSubjects(registry, ['oracle', 'keeper', 'fixer'], ['zeta', 'muse'])
    // The main agents lead in a fixed order and carry the rail-top flag.
    expect(subjects.filter(subject => subject.main === true).map(subject => subject.id))
      .toEqual(['orchestrator', 'sysadmin', 'creator'])
    expect(subjects.slice(0, 6).map(subject => subject.id))
      .toEqual(['orchestrator', 'sysadmin', 'creator', 'oracle', 'fixer', 'explorer'])
    expect(subjects.find(subject => subject.id === 'muse')?.label).toBe('The Muse')
    // Roster and permission-only names keep their id as the label.
    expect(subjects.find(subject => subject.id === 'keeper')?.label).toBe('keeper')
    expect(subjects.map(subject => subject.id)).toContain('zeta')
    expect(subjects.filter(subject => subject.id === 'oracle')).toHaveLength(1)
  })

  it('labels a main agent from the registry when one names it', () => {
    const subjects = buildAgentSubjects(mergeRoleRegistry({ orchestrator: { label: 'Conductor' } }), [], [])
    expect(subjects.find(subject => subject.id === 'orchestrator')).toMatchObject({ label: 'Conductor', main: true })
  })
})

describe('registry role surfaces', () => {
  it('falls back to a registry role tools.available and reports unknown roles as no surface', () => {
    const registry = mergeRoleRegistry({ muse: { tools: { available: ['read', 'bash'] } } })
    expect(builtRoleAvailability('muse', 'bash', registry)).toBe(true)
    expect(builtRoleAvailability('muse', 'web_search', registry)).toBe(false)
    expect(builtRoleAvailability('ghost', 'bash', registry)).toBeUndefined()
    // The registry entry (Dynamic → Roles) is the fallback surface and wins
    // over the shipped table for the same id; the Permissions allowlist is
    // read by the caller before this fallback (doc 61 WP-S6).
    const narrowed = mergeRoleRegistry({ oracle: { tools: { available: [] } } })
    expect(builtRoleAvailability('oracle', 'subagent', narrowed)).toBe(false)
    expect(builtRoleAvailability('oracle', 'read', narrowed)).toBe(false)
    // Without a registry the shipped behavior is unchanged.
    expect(builtRoleAvailability('fixer', 'edit')).toBe(true)
    expect(builtRoleAvailability('ghost', 'edit')).toBeUndefined()
  })

  it('roleSurfaceFor resolves a registry-only role surface and unions the kept whiteboard tools', () => {
    expect(roleSurfaceFor('muse', mergeRoleRegistry({ muse: { tools: { available: ['read'] } } })))
      .toEqual(['read', 'whiteboard_read', 'whiteboard_write', 'whiteboard_pin', 'whiteboard_unpin'])
    expect(roleSurfaceFor('muse')).toBeUndefined()
    expect(roleSurfaceFor(undefined)).toBeUndefined()
    // The child-keep list is a floor, not an override: the role still keeps them.
    expect(builtRoleAvailability('oracle', 'whiteboard_write', mergeRoleRegistry({ oracle: { tools: { available: [] } } }))).toBe(true)
  })

  it('reads the whiteboard family row checked for the operator agents, children keep only the host keep floor', () => {
    const family = buildPermissionToolRows(undefined)
      .find(row => row.id === 'whiteboard_*')!
    for (const agent of ['orchestrator', 'sysadmin', 'creator']) {
      // The operators author the board: the full curated family is theirs.
      expect(roleSurfaceFor(agent)).toContain('whiteboard_forget')
      expect(roleRowChecked(family, roleSurfaceFor(agent)!)).toBe(true)
    }
    // A child mirrors the subagent runtime's keep list: the four pinned tools,
    // never `whiteboard_forget` (`SHARED_CHILD_KEEP` in tool-subagent).
    for (const agent of ['fixer', 'oracle', 'librarian']) {
      const child = roleSurfaceFor(agent)!
      expect(child).toEqual(expect.arrayContaining([
        'whiteboard_read', 'whiteboard_write', 'whiteboard_pin', 'whiteboard_unpin',
      ]))
      expect(child).not.toContain('whiteboard_forget')
    }
  })
})

describe('grantScopeHint', () => {
  it('reads a global grant as all-agents, keeping the asking agent as audit only', () => {
    expect(grantScopeHint({ id: 'g1', tool: 'bash', agent: 'fixer', global: true }))
      .toBe('all agents · allow always · requested by fixer')
    expect(grantScopeHint({ id: 'g2', tool: 'bash', global: true }))
      .toBe('all agents · allow always')
  })

  it('reads a grant without `global` as agent-scoped', () => {
    expect(grantScopeHint({ id: 'g3', tool: 'bash', agent: 'fixer' })).toBe('agent: fixer · allow always')
    // Legacy host grants carry neither flag: still all agents.
    expect(grantScopeHint({ id: 'g4', tool: 'bash' })).toBe('all agents · allow always')
  })
})

describe('countPermissionRules', () => {
  it('counts global and per-agent tool rules, grants separately', () => {
    const perms: PermissionsConfig = {
      tools: { bash: 'ask' },
      agents: { fixer: { tools: { edit: 'allow' } }, oracle: {} },
      grants: { g1: { id: 'g1', tool: 'bash' }, g2: { id: 'g2', tool: 'edit' } },
    }
    expect(countPermissionRules(perms)).toEqual({ rules: 2, grants: 2 })
  })

  it('reports zero for an unconfigured policy', () => {
    expect(countPermissionRules(undefined)).toEqual({ rules: 0, grants: 0 })
  })
})

describe('shippedPolicyFor', () => {
  it('names the shipped code defaults: reads and web allow, bash and str_replace_editor ask', () => {
    expect(shippedPolicyFor('read')).toBe('allow')
    expect(shippedPolicyFor('web_search')).toBe('allow')
    expect(shippedPolicyFor('job_kill')).toBe('allow')
    expect(shippedPolicyFor('bash')).toBe('ask')
    expect(shippedPolicyFor('str_replace_editor')).toBe('ask')
    expect(shippedPolicyFor('designer')).toBeUndefined()
  })

  it('ships the whole whiteboard family allowed as one permanent policy', () => {
    for (const tool of ['whiteboard_read', 'whiteboard_write', 'whiteboard_pin', 'whiteboard_unpin', 'whiteboard_forget']) {
      expect(shippedPolicyFor(tool)).toBe('allow')
    }
  })
})

describe('buildPermissionToolRows', () => {
  it('derives rows from the live registry: core order, family folding, MCP groups, derived master last', () => {
    const rows = buildPermissionToolRows(
      { plane: { serverName: 'plane' } },
      ['mcp__plane__list_projects', 'mcp__plane__create_issue'],
      ['bash', 'whiteboard_read', 'whiteboard_write', 'mcp__plane__list_projects', 'mcp__plane__create_issue'],
    )
    const ids = rows.map(row => row.id)
    expect(ids.filter(id => id === 'bash')).toHaveLength(1)
    expect(ids).toContain('str_replace_editor')
    expect(ids[ids.length - 1]).toBe('mcp__*')
    // The server row is the derived wildcard the resolver honors, with its
    // live tools as members — never a standalone persisted key.
    expect(rows.find(row => row.id === 'mcp__plane__*')).toMatchObject({
      name: 'plane (MCP)',
      kind: 'mcp-group',
      members: ['mcp__plane__create_issue', 'mcp__plane__list_projects'],
    })
    expect(ids).not.toContain('mcp__plane*')
    expect(rows.find(row => row.id === 'mcp__plane__list_projects')).toMatchObject({ kind: 'tool' })
    // The master is a derived aggregate over every concrete MCP name.
    expect(rows.find(row => row.id === 'mcp__*')).toMatchObject({
      name: 'All MCP tools',
      kind: 'mcp-master',
      members: ['mcp__plane__create_issue', 'mcp__plane__list_projects'],
    })
    // The whiteboard folds into ONE family row; its members are not separate rows.
    expect(rows.find(row => row.id === 'whiteboard_*')).toMatchObject({
      name: 'Whiteboard',
      kind: 'family',
      members: ['whiteboard_forget', 'whiteboard_pin', 'whiteboard_read', 'whiteboard_unpin', 'whiteboard_write'],
    })
    expect(ids).not.toContain('whiteboard_write')
  })

  it('appends a tool the curated list does not name (presence follows the registry)', () => {
    const rows = buildPermissionToolRows(undefined, [], ['brand_new_tool', 'mcp__ghost__x'])
    expect(rows.find(row => row.id === 'brand_new_tool')).toMatchObject({ name: 'Brand New Tool', kind: 'tool' })
    // An MCP name whose server left the catalog still gets a group from the `__` segment.
    expect(rows.find(row => row.id === 'mcp__ghost__*')).toMatchObject({ kind: 'mcp-group', members: ['mcp__ghost__x'] })
  })

  it('drops a catalog server with no live tools (presence is the registry, not the catalog)', () => {
    const rows = buildPermissionToolRows({ ue: {} }, [])
    expect(rows.map(row => row.id)).not.toContain('mcp__ue__*')
  })

  it('always ends with the derived mcp__* master row and keeps core rows when no registry is given', () => {
    const rows = buildPermissionToolRows(undefined, [])
    expect(rows[rows.length - 1]).toEqual({ id: 'mcp__*', name: 'All MCP tools', kind: 'mcp-master', members: [] })
    expect(rows.map(row => row.id)).toContain('read')
    expect(rows.map(row => row.id)).not.toContain('mcp__x*')
    // The permanent whiteboard policy survives an unmounted plugin.
    expect(rows.find(row => row.id === 'whiteboard_*')).toMatchObject({ kind: 'family' })
  })
})

describe('groupMcpToolNames', () => {
  it('groups live names under their catalog server and sorts tools per group', () => {
    const groups = groupMcpToolNames(
      { plane: { serverName: 'plane' } },
      ['mcp__plane__b_tool', 'mcp__plane__a_tool'],
    )
    expect(groups).toEqual([{ server: 'plane', wildcard: 'mcp__plane__*', tools: ['mcp__plane__a_tool', 'mcp__plane__b_tool'] }])
  })

  it('falls back to the `__` segment for a server that left the catalog', () => {
    expect(groupMcpToolNames(undefined, ['mcp__ghost__tool']))
      .toEqual([{ server: 'ghost', wildcard: 'mcp__ghost__*', tools: ['mcp__ghost__tool'] }])
  })

  it('drops non-MCP names and unusable `mcp__` prefixes instead of inventing a server', () => {
    expect(groupMcpToolNames(undefined, ['bash', 'mcp__', 'mcp__ghost__tool']))
      .toEqual([{ server: 'ghost', wildcard: 'mcp__ghost__*', tools: ['mcp__ghost__tool'] }])
  })
})

describe('fetchMcpToolNames', () => {
  it('reads the live registry RPC and keeps only sorted mcp__ names', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      result: { ok: true, value: { tools: ['mcp__plane__b', 'bash', 'mcp__plane__a'] } },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchMcpToolNames()).resolves.toEqual(['mcp__plane__a', 'mcp__plane__b'])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/enpoiCapabilities.mcpTools')
    expect(JSON.parse(String(init.body)).method).toBe('enpoiCapabilities.mcpTools')
    vi.unstubAllGlobals()
  })

  it('answers undefined on a failed or malformed answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 500 })))
    await expect(fetchMcpToolNames()).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { ok: false } }), { status: 200 })))
    await expect(fetchMcpToolNames()).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: { ok: true, value: { tools: 'not-an-array' } },
    }), { status: 200 })))
    await expect(fetchMcpToolNames()).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(fetchMcpToolNames()).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('fetchRegisteredToolNames', () => {
  it('reads the full live-registry RPC and sorts the names', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      result: { ok: true, value: { tools: ['whiteboard_write', 'bash', 'whiteboard_read'] } },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchRegisteredToolNames()).resolves.toEqual(['bash', 'whiteboard_read', 'whiteboard_write'])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/enpoiCapabilities.registeredTools')
    expect(JSON.parse(String(init.body)).method).toBe('enpoiCapabilities.registeredTools')
    vi.unstubAllGlobals()
  })

  it('answers undefined on a failed or malformed answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 500 })))
    await expect(fetchRegisteredToolNames()).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { ok: false } }), { status: 200 })))
    await expect(fetchRegisteredToolNames()).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(fetchRegisteredToolNames()).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('derived aggregate rows', () => {
  const master: PermissionToolRow = {
    id: 'mcp__*',
    name: 'All MCP tools',
    kind: 'mcp-master',
    members: ['mcp__plane__a', 'mcp__plane__b'],
  }

  it('fans a toggle out to every member and unsets the legacy aggregate key', () => {
    expect(isAggregateRow(master)).toBe(true)
    expect(rowTargets(master)).toEqual(['mcp__plane__a', 'mcp__plane__b'])
    expect(rowPolicyOps(master, ['tools'], 'allow')).toEqual([
      { op: 'set', path: ['tools', 'mcp__plane__a'], value: 'allow' },
      { op: 'set', path: ['tools', 'mcp__plane__b'], value: 'allow' },
      { op: 'unset', path: ['tools', 'mcp__*'] },
    ])
    expect(rowPolicyOps(master, ['agents', 'oracle', 'tools'], undefined)).toEqual([
      { op: 'unset', path: ['agents', 'oracle', 'tools', 'mcp__plane__a'] },
      { op: 'unset', path: ['agents', 'oracle', 'tools', 'mcp__plane__b'] },
      { op: 'unset', path: ['agents', 'oracle', 'tools', 'mcp__*'] },
    ])
    // A plain row writes only itself.
    expect(rowPolicyOps({ id: 'bash', name: 'Bash' }, ['tools'], 'deny'))
      .toEqual([{ op: 'set', path: ['tools', 'bash'], value: 'deny' }])
  })

  it('derives uniform, mixed, and legacy states from the member rules', () => {
    const uniform: PermissionsConfig = { tools: { 'mcp__plane__a': 'allow', 'mcp__plane__b': 'allow' } }
    expect(rowPolicyState(uniform, undefined, master)).toMatchObject({ ownOverride: 'allow', mixed: false, provenance: 'derived' })
    const mixed: PermissionsConfig = { tools: { 'mcp__plane__a': 'allow', 'mcp__plane__b': 'deny' } }
    expect(rowPolicyState(mixed, undefined, master)).toMatchObject({ ownOverride: undefined, mixed: true, provenance: 'mixed' })
    // A persisted legacy `mcp__*` key is surfaced until the next click folds it.
    const legacy: PermissionsConfig = { tools: { 'mcp__*': 'deny' } }
    expect(rowPolicyState(legacy, undefined, master)).toMatchObject({ ownOverride: 'deny', mixed: false, provenance: 'legacy aggregate' })
    // Inherit everywhere resolves through the shipped/default answer.
    expect(rowPolicyState({ defaults: { unknownTools: 'ask' } }, undefined, master)).toMatchObject({ mixed: false, provenance: 'derived' })
  })

  it('checks a role aggregate only when every member is on the allowlist', () => {
    expect(roleRowChecked(master, ['mcp__plane__a', 'mcp__plane__b'])).toBe(true)
    expect(roleRowChecked(master, ['mcp__plane__a'])).toBe(false)
    expect(roleRowChecked({ id: 'bash', name: 'Bash' }, ['bash'])).toBe(true)
    // An empty aggregate has nothing to check and toggles nothing.
    expect(roleRowChecked({ id: 'mcp__*', name: 'All MCP tools', kind: 'mcp-master', members: [] }, ['bash'])).toBe(false)
  })

  it('marks an aggregate mixed when the members resolve to different effective policies', () => {
    const perms: PermissionsConfig = {
      defaults: { unknownTools: 'ask' },
      grants: { g: { id: 'g', tool: 'mcp__plane__a' } },
    }
    // No own rules, but a grant makes one member allow and the other ask.
    expect(rowPolicyState(perms, undefined, master)).toMatchObject({ ownOverride: undefined, mixed: true, provenance: 'mixed' })
  })

  it('surfaces a legacy aggregate key on an empty-member row', () => {
    const empty: PermissionToolRow = { id: 'mcp__*', name: 'All MCP tools', kind: 'mcp-master', members: [] }
    expect(rowPolicyState({ tools: { 'mcp__*': 'deny' } }, undefined, empty))
      .toMatchObject({ ownOverride: 'deny', effective: 'deny', provenance: 'legacy aggregate' })
    expect(rowPolicyState({}, undefined, empty))
      .toMatchObject({ ownOverride: undefined, provenance: 'inherit (default)' })
  })

  it('persists a fan-out as atomic leaf writes and reports any failure', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { ok: true } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(persistRowPolicyOps(rowPolicyOps(master, ['tools'], 'allow'))).resolves.toBe(true)
    const bodies = fetchMock.mock.calls.map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)))
    expect(bodies.map((body: { payload: { args: { ops: Array<{ op: string; path: string[] }> } } }) => body.payload.args.ops[0]?.op))
      .toEqual(['set', 'set', 'unset'])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { ok: false } }), { status: 200 })))
    await expect(persistRowPolicyOps(rowPolicyOps(master, ['tools'], 'deny'))).resolves.toBe(false)
    vi.unstubAllGlobals()
  })
})

describe("Adam's live fixture (2026-09-26)", () => {
  // The imported settings document: tools {} plus four whiteboard grants, and
  // a registry that holds the whiteboard + a Plane MCP server.
  const perms: PermissionsConfig = {
    defaults: { unknownTools: 'ask' },
    tools: {},
    grants: {
      'g-read': { id: 'g-read', tool: 'whiteboard_read', createdAt: '2026-09-23T09:38:13.925Z' },
      'g-write': { id: 'g-write', tool: 'whiteboard_write', createdAt: '2026-09-23T09:38:42.163Z' },
      'g-pin': { id: 'g-pin', tool: 'whiteboard_pin', createdAt: '2026-09-23T09:38:52.444Z' },
      'g-unpin': { id: 'g-unpin', tool: 'whiteboard_unpin', createdAt: '2026-09-23T09:41:35.943Z' },
    },
  }
  const liveTools = ['whiteboard_read', 'whiteboard_write', 'whiteboard_pin', 'whiteboard_unpin', 'whiteboard_forget', 'mcp__plane__list_projects', 'bash']

  it('folds the whiteboard into ONE permanent allowed row (grants stay listed)', () => {
    const rows = buildPermissionToolRows({ plane: { serverName: 'plane' } }, [], liveTools)
    const ids = rows.map(row => row.id)
    expect(ids).not.toContain('whiteboard_write')
    const family = rows.find(row => row.id === 'whiteboard_*')
    expect(family).toMatchObject({ kind: 'family' })
    expect(family?.members).toHaveLength(5)
    const state = rowPolicyState(perms, undefined, family!)
    expect(state.effective).toBe('allow')
    expect(state.provenance).toBe('derived')
    // The per-feature grants are never removed or hidden.
    expect(Object.keys(perms.grants ?? {})).toHaveLength(4)
  })

  it('shows ONE derived MCP model (server group + master), never a second persisted key', () => {
    const rows = buildPermissionToolRows({ plane: { serverName: 'plane' } }, [], liveTools)
    expect(rows.filter(row => row.id.startsWith('mcp__')).map(row => row.id))
      .toEqual(['mcp__plane__*', 'mcp__plane__list_projects', 'mcp__*'])
    // The master fans out to the concrete tool, not to its own key.
    expect(rowPolicyOps(rows[rows.length - 1]!, ['tools'], 'allow'))
      .toEqual([
        { op: 'set', path: ['tools', 'mcp__plane__list_projects'], value: 'allow' },
        { op: 'unset', path: ['tools', 'mcp__*'] },
      ])
  })
})

describe('effectivePolicy and provenanceFor', () => {
  it('resolves agent rule over global rule over shipped default over the unknown-tool fallback', () => {
    const perms: PermissionsConfig = {
      defaults: { unknownTools: 'ask' },
      tools: { bash: 'deny' },
      agents: { fixer: { tools: { bash: 'allow' } } },
    }
    expect(effectivePolicy(perms, 'fixer', 'bash')).toBe('allow')
    expect(provenanceFor(perms, 'fixer', 'bash')).toBe('agent rule')
    expect(effectivePolicy(perms, 'oracle', 'bash')).toBe('deny')
    expect(provenanceFor(perms, 'oracle', 'bash')).toBe('global rule')
    expect(effectivePolicy(perms, 'oracle', 'read')).toBe('allow')
    expect(provenanceFor(perms, 'oracle', 'read')).toBe('inherit (default)')
    expect(effectivePolicy(perms, 'oracle', 'designer')).toBe('ask')
    expect(provenanceFor(perms, undefined, 'read')).toBe('inherit (default)')
  })

  it('inherits the configured unknown-tool default before the shipped ask', () => {
    const perms: PermissionsConfig = { defaults: { unknownTools: 'deny' } }
    expect(effectivePolicy(perms, 'oracle', 'designer')).toBe('deny')
  })

  it('lets a tool-level standing grant absorb an ask, exactly like the host resolver', () => {
    const perms: PermissionsConfig = {
      defaults: { unknownTools: 'ask' },
      grants: { g1: { id: 'g1', tool: 'custom_tool', agent: 'fixer', global: true } },
    }
    expect(toolGrantApplies(perms, 'oracle', 'custom_tool')).toBe(true)
    expect(effectivePolicy(perms, 'oracle', 'custom_tool')).toBe('allow')
    expect(provenanceFor(perms, 'oracle', 'custom_tool')).toBe('standing grant')
    // An agent-scoped grant (no `global`) only covers its own agent.
    const scoped: PermissionsConfig = {
      defaults: { unknownTools: 'ask' },
      grants: { g2: { id: 'g2', tool: 'custom_tool', agent: 'fixer' } },
    }
    expect(effectivePolicy(scoped, 'oracle', 'custom_tool')).toBe('ask')
    expect(effectivePolicy(scoped, 'fixer', 'custom_tool')).toBe('allow')
    // Pattern grants never absorb a tool-level ask.
    const patterned: PermissionsConfig = {
      defaults: { unknownTools: 'ask' },
      grants: { g3: { id: 'g3', tool: 'custom_tool', pattern: 'rm' } },
    }
    expect(effectivePolicy(patterned, 'oracle', 'custom_tool')).toBe('ask')
  })
})

describe('settings.mutate wrappers', () => {
  const gatewayOk = () => new Response(JSON.stringify({ result: { ok: true } }), { status: 200 })

  it('setPermissionPath writes one leaf op with the mandatory ns + args wrapper', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      void init
      return gatewayOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(setPermissionPath(['tools', 'bash'], 'deny')).resolves.toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/settings.mutate')
    const body = JSON.parse(String(init.body)) as {
      method: string
      payload: { args: { ns: string; ops: Array<{ op: string; path: string[]; value?: unknown }> } }
    }
    expect(body.method).toBe('settings.mutate')
    expect(body.payload.args.ns).toBe('enpoi-orchestration')
    expect(body.payload.args.ops).toEqual([{ op: 'set', path: ['permissions', 'tools', 'bash'], value: 'deny' }])
    vi.unstubAllGlobals()
  })

  it('unsetPermissionPath removes one leaf op', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      void init
      return gatewayOk()
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(unsetPermissionPath(['grants', 'g1'])).resolves.toBe(true)
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      payload: { args: { ops: Array<{ op: string; path: string[] }> } }
    }
    expect(body.payload.args.ops).toEqual([{ op: 'unset', path: ['permissions', 'grants', 'g1'] }])
    vi.unstubAllGlobals()
  })

  it('reports failure on HTTP error and on gateway ok:false business rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })))
    await expect(setPermissionPath(['tools', 'bash'], 'deny')).resolves.toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { ok: false } }), { status: 200 })))
    await expect(unsetPermissionPath(['tools', 'bash'])).resolves.toBe(false)
    vi.unstubAllGlobals()
  })

  it('describePermissionsView resolves the enpoi-orchestration namespace or undefined', async () => {
    const describeBody = {
      result: {
        ok: true,
        value: {
          namespaces: [
            { ns: 'other' },
            { ns: 'enpoi-orchestration', value: { permissions: { tools: { bash: 'ask' } } } },
          ],
        },
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(describeBody), { status: 200 })))
    const view = await describePermissionsView()
    expect(view?.value?.permissions?.tools).toEqual({ bash: 'ask' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 500 })))
    await expect(describePermissionsView()).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})
