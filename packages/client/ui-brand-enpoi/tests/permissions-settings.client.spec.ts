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
  provenanceFor,
  roleSurfaceFor,
  setPermissionPath,
  shippedPolicyFor,
  unsetPermissionPath,
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
  it('leads with registry roles (labelled) and dedupes the roster and permission extras against them', () => {
    const registry = mergeRoleRegistry({ muse: { label: 'The Muse' } })
    const subjects = buildAgentSubjects(registry, ['oracle', 'keeper', 'fixer'], ['zeta', 'muse'])
    expect(subjects.slice(0, 6).map(subject => subject.id))
      .toEqual(['oracle', 'fixer', 'explorer', 'librarian', 'designer', 'muse'])
    expect(subjects.find(subject => subject.id === 'muse')?.label).toBe('The Muse')
    // Roster and permission-only names keep their id as the label.
    expect(subjects.find(subject => subject.id === 'keeper')?.label).toBe('keeper')
    expect(subjects.map(subject => subject.id)).toContain('zeta')
    expect(subjects.filter(subject => subject.id === 'oracle')).toHaveLength(1)
  })
})

describe('registry role surfaces', () => {
  it('falls back to a registry role tools.available and reports unknown roles as no surface', () => {
    const registry = mergeRoleRegistry({ muse: { tools: { available: ['read', 'bash'] } } })
    expect(builtRoleAvailability('muse', 'bash', registry)).toBe(true)
    expect(builtRoleAvailability('muse', 'web_search', registry)).toBe(false)
    expect(builtRoleAvailability('ghost', 'bash', registry)).toBeUndefined()
    // A shipped surface still wins over a registry entry for the same id.
    expect(builtRoleAvailability('oracle', 'subagent', mergeRoleRegistry({ oracle: { tools: { available: [] } } }))).toBe(true)
    // Without a registry the shipped behavior is unchanged.
    expect(builtRoleAvailability('fixer', 'edit')).toBe(true)
    expect(builtRoleAvailability('ghost', 'edit')).toBeUndefined()
  })

  it('roleSurfaceFor resolves a registry-only role surface', () => {
    expect(roleSurfaceFor('muse', mergeRoleRegistry({ muse: { tools: { available: ['read'] } } }))).toEqual(['read'])
    expect(roleSurfaceFor('muse')).toBeUndefined()
    expect(roleSurfaceFor(undefined)).toBeUndefined()
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
})

describe('buildPermissionToolRows', () => {
  it('lists the core tool rows, then per-server and generic MCP rows', () => {
    const rows = buildPermissionToolRows(
      { plane: { serverName: 'plane' } },
      [
        { id: 'bash', name: 'Bash Terminal', kind: 'tool' },
        { id: 'keeper', name: 'Keeper', kind: 'tool' },
        { id: 'tier1-workflow', name: 'Tier 1', kind: 'skill' },
      ],
    )
    const ids = rows.map(row => row.id)
    expect(ids.filter(id => id === 'bash')).toHaveLength(1)
    // Role names are subjects in the left rail, never tool rows.
    expect(ids).not.toContain('keeper')
    expect(ids).toContain('str_replace_editor')
    expect(ids).not.toContain('tier1-workflow')
    expect(ids[ids.length - 1]).toBe('mcp__*')
    expect(ids).toContain('mcp__plane*')
  })

  it('falls back to the catalog id when a server entry carries no serverName', () => {
    const ids = buildPermissionToolRows({ ue: {} }, []).map(row => row.id)
    expect(ids).toContain('mcp__ue*')
  })

  it('always ends with the generic mcp__* row and keeps core rows when no catalog is given', () => {
    const rows = buildPermissionToolRows(undefined, [])
    expect(rows[rows.length - 1]).toEqual({ id: 'mcp__*', name: 'All MCP tools' })
    expect(rows.map(row => row.id)).toContain('read')
    expect(rows.map(row => row.id)).not.toContain('mcp__x*')
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
