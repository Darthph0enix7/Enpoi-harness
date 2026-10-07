/**
 * Preset prompt parity — the cache-neutral switch contract for every main agent.
 *
 * The provider prefix cache is keyed by the exact request prefix, and the tool block plus the
 * system prompt sit before the conversation, so any per-preset byte this early rebuilds the
 * whole cached prefix on a switch (measured live: control turn-2 cacheRead 12,288 → treatment 0
 * after an orchestrator→sysadmin switch). Every main-agent preset declaration must therefore
 * assemble identical bytes up to the per-preset doctrine that `dsh-persona` renders LAST
 * (suffix order 10200): a SHARED BASE prefix + a PER-PRESET TAIL suffix, with per-seat tool
 * restrictions enforced at execution (the enpoi-capabilities pre-execute guard) instead of by
 * tool absence — `orchestrator`, `sysadmin`, `creator`, and any preset the authoring flow
 * clones from one of them.
 *
 * This spec reads the active declarations in `cordis.patch.yml` (the source the host mounts),
 * proves every other row/config is identical, and assembles all three prompts through the real
 * `SystemPrompt` registry to prove the shared prefix is byte-identical and only the tail
 * differs. A future edit that puts per-preset text back into the prefix — or ships a new
 * row/config one preset lacks — fails here instead of silently costing cache rebuilds.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, {
  PERSONA_PREFIX_SECTION,
  PERSONA_SUFFIX_SECTION,
  renderPrompt,
  type PromptSectionOrderName,
} from '@deepseek-ai/dsh-system-prompt'
import { JSON_SCHEMA, Type, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { TOOL_GROUPS_MENU_ORDER } from '../packages/enpoi-tool-groups/src/index.ts'
import { preAttachFor, renderMenuText, resolveToolGroups } from '../packages/enpoi-tool-groups/src/catalog.ts'

interface PresetRow {
  id: string
  name?: string
  disabled?: unknown
  config?: Record<string, unknown>
}
interface PersonaConfig {
  prefix: string
  suffix?: string
}

const JS_TAG = 'tag:yaml.org,2002:js'
const SCHEMA = JSON_SCHEMA.extend(new Type(JS_TAG, {
  kind: 'scalar',
  construct: (value: string) => ({ __js: String(value) }),
  represent: (value: unknown) => String((value as { __js?: unknown } | null)?.__js ?? ''),
}))

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '..')
const declarations = (load(readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8'), { schema: SCHEMA }) as Array<{ insert?: Array<{ id: string; config: { plugins: PresetRow[] } }> }>)
  .flatMap(entry => entry?.insert ?? [])

const rowsOf = (seat: string): PresetRow[] =>
  declarations.find(item => item.id === `preset-${seat}`)!.config.plugins
const personaOf = (seat: string): PersonaConfig =>
  rowsOf(seat).find(row => row.id === 'persona')!.config as unknown as PersonaConfig

/** Every row of a preset, including rows nested in a `cordis:group` config list. */
const allRowsOf = (seat: string): PresetRow[] => {
  const flat: PresetRow[] = []
  const walk = (rows: PresetRow[]): void => {
    for (const row of rows) {
      flat.push(row)
      if (Array.isArray(row.config)) walk(row.config as unknown as PresetRow[])
    }
  }
  walk(rowsOf(seat))
  return flat
}

describe('preset prompt parity (cache-neutral switch contract)', () => {
  it('declares identical rows across every main agent; only persona text and the seat label differ', () => {
    const seats = ['orchestrator', 'sysadmin', 'creator'] as const
    const rows = Object.fromEntries(seats.map(seat => [seat, rowsOf(seat)])) as Record<typeof seats[number], PresetRow[]>
    const reference = rows.orchestrator
    for (const seat of seats) {
      expect(rows[seat].map(row => [row.id, row.name, row.disabled]), `${seat} row list`)
        .toEqual(reference.map(row => [row.id, row.name, row.disabled]))

      const differing = reference
        .filter((row, index) => JSON.stringify(row.config ?? null) !== JSON.stringify(rows[seat][index].config ?? null))
        .map(row => row.id)
      // `persona` carries the per-preset doctrine (the tail); `enpoi-orchestration`
      // carries the seat id, which only resolves group pre-attach and menu
      // visibility — the shipped catalog pre-attaches nothing for any seat.
      expect(differing, `${seat} differing configs`)
        .toEqual(seat === 'orchestrator' ? [] : ['persona', 'enpoi-orchestration'])
    }

    // The canonical surface mounts the harness-authoring rows and the oracle row
    // on EVERY main agent: the tool array must not differ, so restrictions are
    // enforced at execution by the enpoi-capabilities pre-execute guard.
    for (const seat of seats) {
      for (const id of ['tool-plugin-manager', 'tool-cordis', 'enpoi-oracle', 'enpoi-debug']) {
        expect(allRowsOf(seat).find(row => row.id === id), `${seat} must mount ${id}`).toBeDefined()
      }
    }

    // Recovery continuation is on in every cache-paired preset: the two
    // control rows must stay declared and enabled together.
    for (const seat of seats) {
      const rows = allRowsOf(seat)
      for (const id of ['tool-subagent-control', 'tool-subagent-list-agents']) {
        const row = rows.find(item => item.id === id)
        expect(row, `${seat} must declare ${id}`).toBeDefined()
        expect(row!.disabled, `${seat} ${id} must be enabled`).not.toBe(true)
      }
    }

    // `enpoi-orchestration` differs only by the seat label, and the seat only resolves group
    // pre-attach and menu visibility: the shipped catalog pre-attaches nothing, and the
    // orchestrator/sysadmin menus are byte-identical because both hide the creator family.
    const catalog = resolveToolGroups(undefined)
    const orchestratorAttach = preAttachFor(catalog, 'orchestrator')
    expect(orchestratorAttach).toEqual([])
    expect(orchestratorAttach).toEqual(preAttachFor(catalog, 'sysadmin'))
    expect(preAttachFor(catalog, 'creator')).toEqual([])
    const menu = (seat: string): string => renderMenuText(catalog, new Set(preAttachFor(catalog, seat)), [], seat)
    expect(menu('orchestrator')).toBe(menu('sysadmin'))
    expect(menu('orchestrator')).toContain('peer')
    // Awareness for the seat-hidden family: notice for every seat, attach state only for the owner.
    expect(menu('orchestrator')).toContain('Creator-seat-only family')
    expect(menu('creator')).toContain('(3 tools, not attached)')
  })

  it('mounts the profile skills dir on every fleet preset', () => {
    // The shipped tier skills are canonical in the profile's own `skills/`
    // dir; every fleet preset must scan it (custom rank precedes the user
    // root), or a preset silently falls back to whatever `$DSH_HOME/skills`
    // happens to hold.
    const customDirs = (seat: string): unknown => {
      const row = allRowsOf(seat).find(item => item.id === 'skill-filesystem')
      expect(row, `${seat} must declare skill-filesystem`).toBeDefined()
      return (row!.config as { customSkillDirs?: unknown } | undefined)?.customSkillDirs
    }
    const expected = customDirs('creator')
    expect(expected).toBeDefined()
    for (const seat of ['orchestrator', 'sysadmin'] as const) {
      expect(customDirs(seat), `${seat} must mount the profile skills dir`).toEqual(expected)
    }
  })

  it('keeps identity and doctrine in the tail; the prefix is the shared base', () => {
    const seats = ['orchestrator', 'sysadmin', 'creator'] as const
    const personas = Object.fromEntries(seats.map(seat => [seat, personaOf(seat)])) as Record<typeof seats[number], PersonaConfig>
    const orchestrator = personas.orchestrator
    for (const seat of seats) {
      expect(personas[seat].prefix, `${seat} prefix must be the shared base`).toBe(orchestrator.prefix)
    }
    expect(orchestrator.prefix.length).toBeGreaterThan(512)
    expect(orchestrator.prefix).toContain('## Tooling')
    expect(orchestrator.prefix).toContain('## Verification & Ambiguity')
    expect(orchestrator.prefix).toContain('## Communication')

    expect(orchestrator.suffix).toContain('Master Orchestrator')
    expect(orchestrator.suffix).toContain('## Delegation Doctrine')
    expect(orchestrator.suffix).toContain('## Fleet')
    expect(personas.sysadmin.suffix).toContain('You are Sysadmin')
    expect(personas.sysadmin.suffix).toContain('verify service state before and after every action')
    expect(personas.creator.suffix).toContain('You are the Creator')
    expect(personas.creator.suffix).toContain('## Knowledge base')
    expect(orchestrator.suffix).not.toBe(personas.sysadmin.suffix)
    expect(orchestrator.suffix).not.toBe(personas.creator.suffix)

    for (const seat of seats) {
      expect(personas[seat].prefix).not.toContain('Master Orchestrator')
      expect(personas[seat].prefix).not.toContain('You are Sysadmin')
      expect(personas[seat].prefix).not.toContain('You are the Creator')
    }
  })

  it('assembles identical shared prefixes and only the suffix tail differs', async () => {
    const ctx = new Context()
    // Scope keys are identities, not value objects: create each once and reuse it for the
    // scope registration and for the assembly that must see it.
    const keys = {
      orchestrator: { id: 'parity-orchestrator' },
      sysadmin: { id: 'parity-sysadmin' },
      creator: { id: 'parity-creator' },
    } as const
    const seats = ['orchestrator', 'sysadmin', 'creator'] as const
    const scopes: Array<{ dispose: () => Promise<void> }> = []
    try {
      await ctx.plugin(SystemPrompt)
      // Injecting `systemPrompt` is how a context registers prompt sections (`ctx.systemPrompt`
      // is guarded); the sentinels land on the global layer and the personas on their scopes.
      await ctx.plugin({
        name: 'parity-setup',
        inject: ['systemPrompt'],
        apply(pluginCtx: Context): void {
          const section = (name: string, order: PromptSectionOrderName | number, text: string): void => {
            pluginCtx.systemPrompt.section({
              name,
              order: typeof order === 'number' ? order : pluginCtx.systemPrompt.getSectionOrder(order),
              text,
            })
          }
          // Stand-ins for the composition's first-party sections, at the real orders.
          section('plan:policy', 'PLAN_POLICY', 'plan sentinel')
          section('tool:bash', 'TOOL_BASH', 'bash sentinel')
          section('tool:subagent', 'TOOL_SUBAGENT', 'subagent sentinel')
          section('tool:computer-use', 'TOOL_COMPUTER_USE', 'computer sentinel')
          section('mcp:servers', 'MCP_SERVERS', 'mcp sentinel')
          section('tool-groups:menu', TOOL_GROUPS_MENU_ORDER, 'menu sentinel')

          for (const seat of seats) {
            const persona = personaOf(seat)
            const scope = createScope(pluginCtx, keys[seat])
            scopes.push(scope)
            scope.ctx.systemPrompt.section({
              name: PERSONA_PREFIX_SECTION,
              order: scope.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
              text: persona.prefix,
            })
            scope.ctx.systemPrompt.section({
              name: PERSONA_SUFFIX_SECTION,
              order: scope.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
              text: persona.suffix ?? '',
            })
          }
        },
      } as never)

      const sharedPrefixes = seats.map(seat => {
        const assembly = ctx.systemPrompt.assemble({ scope: keys[seat] })
        return assembly
      })
      const assemblies = await Promise.all(sharedPrefixes)
      const prompts = assemblies.map((assembly, index) => {
        expect(assembly.sections.at(-1)?.name).toBe(PERSONA_SUFFIX_SECTION)
        const prompt = renderPrompt(assembly)
        const persona = personaOf(seats[index])
        expect(prompt.endsWith(persona.suffix ?? '')).toBe(true)
        return { prompt, suffix: persona.suffix ?? '' }
      })
      const base = prompts[0].prompt.slice(0, prompts[0].prompt.length - prompts[0].suffix.length)
      for (const { prompt, suffix } of prompts) {
        expect(prompt.slice(0, prompt.length - suffix.length)).toBe(base)
      }
      expect(base).toContain(personaOf('orchestrator').prefix)
      expect(base).toContain('menu sentinel')
      for (const marker of ['Master Orchestrator', 'You are Sysadmin', 'You are the Creator']) {
        expect(base).not.toContain(marker)
      }
    } finally {
      for (const scope of scopes) await scope.dispose()
      await ctx.fiber.dispose()
    }
  })
})
