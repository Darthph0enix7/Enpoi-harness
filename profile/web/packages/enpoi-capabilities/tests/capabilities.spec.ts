import { describe, it, expect } from 'vitest'
import {
  initialCapabilitiesState,
  evaluateToolCall,
  pruneRemovedMcpPolicyRows,
  PROTECTED_CAPABILITIES,
  type CapabilitiesState,
} from '../src/index'

describe('enpoi-capabilities unit & enforcement suite', () => {
  it('initializes defaults correctly (no MCP defaults, skills/tools default ON)', () => {
    const state = initialCapabilitiesState()

    // No MCP server ships as a default; every MCP row is settings-owned and
    // merges in from global defaults, never from this catalog.
    expect(state.mcp).toEqual({})
    expect(state.mcp['plane-mcp']).toBeUndefined()

    // Skills must be default ON
    expect(state.skills['tier2-workflow']).toBe(true)
    expect(state.skills['tier1-workflow']).toBe(true)

    // Subagents & core tools must be default ON
    expect(state.tools.oracle_review).toBe(true)
    expect(state.tools.roundtable).toBe(true)
    expect(state.tools.fixer).toBe(true)
    expect(state.tools.edit).toBe(true)
  })

  it('merges global settings defaults correctly', () => {
    const globalDefaults: Partial<CapabilitiesState> = {
      tools: { roundtable: false, chorus: false },
      skills: { 'tier1-workflow': false },
      mcp: { 'plane-mcp': true },
    }
    const state = initialCapabilitiesState(globalDefaults)

    expect(state.tools.roundtable).toBe(false)
    expect(state.tools.chorus).toBe(false)
    expect(state.skills['tier1-workflow']).toBe(false)
    expect(state.mcp['plane-mcp']).toBe(true)
    // Other defaults remain intact
    expect(state.tools.oracle_review).toBe(true)
  })

  it('Invariant B1: denies disabled direct tool calls with structured synthetic denial', () => {
    const state = initialCapabilitiesState({
      tools: { oracle_review: false, bash: false },
    })

    const oracleDecision = evaluateToolCall('oracle_review', {}, state)
    expect(oracleDecision.allowed).toBe(false)
    expect(oracleDecision.syntheticResult).toContain('[CAPABILITY_DISABLED]')
    expect(oracleDecision.syntheticResult).toContain('oracle_review')

    const bashDecision = evaluateToolCall('bash', { command: 'ls' }, state)
    expect(bashDecision.allowed).toBe(false)
    expect(bashDecision.syntheticResult).toContain('[CAPABILITY_DISABLED]')
    expect(bashDecision.syntheticResult).toContain('bash')

    // Allowed tool passes
    const editDecision = evaluateToolCall('edit', { filePath: '/test' }, state)
    expect(editDecision.allowed).toBe(true)
  })

  it('Invariant B1: denies disabled specialist worker subagent dispatches via dispatch_task', () => {
    const state = initialCapabilitiesState({
      tools: { fixer: false, designer: false },
    })

    const fixerDecision = evaluateToolCall('dispatch_task', { subagent_type: 'fixer', prompt: 'fix code' }, state)
    expect(fixerDecision.allowed).toBe(false)
    expect(fixerDecision.syntheticResult).toContain('[CAPABILITY_DISABLED]')
    expect(fixerDecision.syntheticResult).toContain("worker 'fixer'")

    const explorerDecision = evaluateToolCall('dispatch_task', { subagent_type: 'explorer', prompt: 'map code' }, state)
    expect(explorerDecision.allowed).toBe(true)
  })

  it('Invariant B1: denies disabled skills via skill loader tool', () => {
    const state = initialCapabilitiesState({
      skills: { 'tier2-workflow': false, 'ue-mcp-skill': false },
    })

    const tier2Decision = evaluateToolCall('skill', { name: 'tier2-workflow' }, state)
    expect(tier2Decision.allowed).toBe(false)
    expect(tier2Decision.syntheticResult).toContain('[SKILL_DISABLED]')
    expect(tier2Decision.syntheticResult).toContain("Skill 'tier2-workflow'")

    const pmDecision = evaluateToolCall('skill', { name: 'project-management' }, state)
    expect(pmDecision.allowed).toBe(true)
  })

  it('Invariant B1: denies disabled MCP tool suites via mcp__ prefix matching', () => {
    const state = initialCapabilitiesState({
      mcp: { 'plane-mcp': false, 'custom-mcp': true },
    })

    const planeDecision = evaluateToolCall('mcp__plane__list_projects', {}, state)
    expect(planeDecision.allowed).toBe(false)
    expect(planeDecision.syntheticResult).toContain('[CAPABILITY_DISABLED]')
    expect(planeDecision.syntheticResult).toContain("MCP Tool suite 'plane-mcp'")

    const customDecision = evaluateToolCall('mcp__custom__do_thing', {}, state)
    expect(customDecision.allowed).toBe(true)

    // The server id is derived from the tool-name prefix for any server.
    const off = initialCapabilitiesState({ mcp: { 'other-mcp': false } })
    expect(evaluateToolCall('mcp__other__do_thing', {}, off).allowed).toBe(false)
  })

  it('resolves the mcp toggle through the catalog: `__` id, custom serverName, normal id, unknown server', () => {
    const catalog = {
      'plane-mcp': {},
      'a__b-mcp': {},
      'acme-mcp': { serverName: 'bar' },
    }

    // Normal id: mounted name is the id minus the standard `-mcp` suffix.
    const plane = initialCapabilitiesState({ mcp: { 'plane-mcp': false } })
    const planeDecision = evaluateToolCall('mcp__plane__list_projects', {}, plane, catalog)
    expect(planeDecision.allowed).toBe(false)
    expect(planeDecision.syntheticResult).toContain("'plane-mcp'")

    // An id containing `__` resolves whole: `mcp__a__b__tool` is server `a__b`.
    const deep = initialCapabilitiesState({ mcp: { 'a__b-mcp': false } })
    const deepDecision = evaluateToolCall('mcp__a__b__do_thing', {}, deep, catalog)
    expect(deepDecision.allowed).toBe(false)
    expect(deepDecision.syntheticResult).toContain("'a__b-mcp'")
    // The old split-based key must not veto the suite in either direction.
    expect(evaluateToolCall('mcp__a__b__do_thing', {}, initialCapabilitiesState({ mcp: { 'a-mcp': false, 'a__b-mcp': true } }), catalog).allowed).toBe(true)

    // A custom serverName maps back to its catalog id.
    const acme = initialCapabilitiesState({ mcp: { 'acme-mcp': false } })
    const acmeDecision = evaluateToolCall('mcp__bar__do_thing', {}, acme, catalog)
    expect(acmeDecision.allowed).toBe(false)
    expect(acmeDecision.syntheticResult).toContain("'acme-mcp'")

    // An unknown server keeps the legacy `__`-split / `-mcp` fallback.
    const ghost = initialCapabilitiesState({ mcp: { 'ghost-mcp': false } })
    const ghostDecision = evaluateToolCall('mcp__ghost__do_thing', {}, ghost, catalog)
    expect(ghostDecision.allowed).toBe(false)
    expect(ghostDecision.syntheticResult).toContain("'ghost-mcp'")
    expect(evaluateToolCall('mcp__ghost__do_thing', {}, initialCapabilitiesState({ mcp: { 'ghost-mcp': true } }), catalog).allowed).toBe(true)
  })

  it('Invariant B1: a server pulled into the session world is callable while the master switch is off', () => {
    const catalog = { 'plane-mcp': {} }
    const off = initialCapabilitiesState({ mcp: { 'plane-mcp': false } })

    // Not pulled: the call is refused with the disabled reason (never "unknown").
    const refused = evaluateToolCall('mcp__plane__list_projects', {}, off, catalog)
    expect(refused.allowed).toBe(false)
    expect(refused.syntheticResult).toContain('disabled by the operator')

    // Pulled for THIS session (skill hint / mount / session switch): callable.
    const pulled = evaluateToolCall('mcp__plane__list_projects', {}, off, catalog, new Set(['plane-mcp']))
    expect(pulled.allowed).toBe(true)

    // A pull of one server does not open another.
    const other = evaluateToolCall('mcp__plane__list_projects', {}, off, catalog, new Set(['other-mcp']))
    expect(other.allowed).toBe(false)
  })

  it('strips disabled skills from catalog text and entries, and drops no-op updates', async () => {
    const { filterSkillCatalogMessages } = await import('../src/catalog.ts')
    const published = new Map<string, string>()
    const disabled = new Set(['ue-mcp', 'tier1-workflow'])
    const catalog = (update: boolean) => ({
      source: {
        kind: 'skill-catalog',
        ...(update ? { update: true } : {}),
        entries: [
          { name: 'project-management', description: 'enabled skill' },
          { name: 'ue-mcp', description: 'disabled skill' },
        ],
      },
      content: [{
        type: 'text',
        text: '<available_skills>\n- `project-management`: enabled skill\n- `ue-mcp`: disabled skill\n</available_skills>',
      }],
    })

    const first = filterSkillCatalogMessages([catalog(false)], disabled, published, 's1')
    expect(first.messages).toHaveLength(1)
    const message = first.messages[0] as { source: { entries: { name: string }[] }; content: { text: string }[] }
    expect(message.source.entries.map(e => e.name)).toEqual(['project-management'])
    expect(message.content[0].text).not.toContain('ue-mcp')

    // The same filtered catalog arriving as an update is a no-op: never shipped.
    const second = filterSkillCatalogMessages([catalog(true)], disabled, published, 's1')
    expect(second.messages).toHaveLength(0)
    expect(second.droppedUpdates).toBe(1)

    // A genuinely new set still ships.
    const third = filterSkillCatalogMessages([{
      source: { kind: 'skill-catalog', update: true, entries: [{ name: 'test-alpha', description: 'new' }] },
      content: [{ type: 'text', text: '- `test-alpha`: new' }],
    }], disabled, published, 's1')
    expect(third.messages).toHaveLength(1)
  })

  it('removing an MCP server unsets every policy row it owned (revision-fenced)', async () => {
    // Catalog + policy rows state: the server was added, rules were written,
    // then the catalog entry was removed — the rows must not survive it.
    const tree: {
      mcpServers: Record<string, { serverName?: string }>
      permissions: {
        tools: Record<string, 'allow' | 'ask' | 'deny'>
        agents: Record<string, { tools: Record<string, 'allow' | 'ask' | 'deny'> }>
      }
    } = {
      mcpServers: {},
      permissions: {
        tools: {
          'mcp__plane__*': 'ask',
          'mcp__plane__create_page': 'ask',
          'mcp__plane2__*': 'allow',
          bash: 'ask',
        },
        agents: {
          orchestrator: { tools: { 'mcp__plane__*': 'allow', 'mcp__ghost__*': 'ask' } },
          fixer: { tools: { 'mcp__plane__create_page': 'deny' } },
        },
      },
    }
    let revision = 7
    let conflicts = 0
    const settings = {
      describe: () => [{ ns: 'enpoi-orchestration', revision }],
      mutate: async (_ns: string, ops: Array<{ op: string; path: string[] }>, expected?: number) => {
        if (expected !== revision) {
          conflicts += 1
          throw Object.assign(new Error('stale revision'), { code: 'SETTINGS_CONFLICT' })
        }
        for (const op of ops) {
          let node = tree as unknown as Record<string, unknown>
          for (const key of op.path.slice(0, -1)) node = node[key] as Record<string, unknown>
          delete node[op.path[op.path.length - 1] as string]
        }
        revision += 1
      },
    }
    const count = await pruneRemovedMcpPolicyRows(settings, ['plane'], () => tree.permissions)
    expect(conflicts).toBe(0)
    expect(count).toBe(4) // global wildcard + global exact + 1 agent wildcard + 1 agent exact
    expect(tree.permissions.tools).toEqual({ 'mcp__plane2__*': 'allow', bash: 'ask' })
    expect(tree.permissions.agents.orchestrator.tools).toEqual({ 'mcp__ghost__*': 'ask' })
    expect(tree.permissions.agents.fixer.tools).toEqual({})
    // Idempotent: nothing left for the server means no further write.
    expect(await pruneRemovedMcpPolicyRows(settings, ['plane'], () => tree.permissions)).toBe(0)
    expect(revision).toBe(8)
  })

  it('Invariant I15: protected infrastructure capabilities can never be disabled', () => {
    const state = initialCapabilitiesState({
      tools: {
        read: false,
        glob: false,
        grep: false,
        'enpoi-context-keeper': false,
        'enpoi-cascade': false,
      },
    })

    // Invariant I15 guarantees these remain true
    for (const p of PROTECTED_CAPABILITIES) {
      expect(state.tools[p]).toBe(true)
      const decision = evaluateToolCall(p, {}, state)
      expect(decision.allowed).toBe(true)
    }
  })
})
