/**
 * Fresh-home boot gate — the system-composition acceptance proof.
 *
 * A fresh install used to boot a different agent than the server: the library
 * search layer (Exa provider, wizard host rows), the role/persona registry, and
 * the child tool surfaces lived only in the server's live profile document, so
 * a new machine got a librarian with no web_search and a dead wizard path.
 *
 * This spec builds a throwaway home exactly as the installer does — the real
 * `copy_profile_tree` seed mode (which strips and then asserts the fresh
 * patch), the real `seed_profile_home`, and the real first-run Kilo seed — and
 * asserts the seeded composition the way the runtime resolves it: the preset
 * declarations, the subagent depth, the promoted web rows, the role registry
 * and capabilities through the real `listRoleRegistry` /
 * `initialCapabilitiesState`, the tool-group pre-attach map, and the built-in
 * child allowlists. It reads declarations and pure resolvers rather than
 * launching a full host process, matching `preset-prompt-parity.spec.ts`.
 *
 * This gate proves FRESH homes; the update merge is additive-only and never
 * rewrites an existing live document.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSON_SCHEMA, Type, load } from 'js-yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FIRST_RUN_SEED_VERSION,
  KILO_MODEL_ID,
  KILO_ROUTE_ID,
  seedFirstRun,
  type SeedSettings,
} from '@deepseek-ai/dsh-host-first-run/src/index.ts'
import { ROLE_CHILD_ALLOW, SHARED_CHILD_DENY, SHARED_CHILD_KEEP, listRoleRegistry } from '@deepseek-ai/dsh-tool-subagent/src/index.ts'
import { initialCapabilitiesState } from '../packages/enpoi-capabilities/src/state.ts'
import { preAttachFor, resolveToolGroups } from '../packages/enpoi-tool-groups/src/catalog.ts'

interface InsertRow {
  id: string
  name?: string
  config?: Record<string, unknown>
}
interface LoaderEntry {
  id?: string
  name?: string
  disabled?: unknown
  insert?: InsertRow[]
  config?: Record<string, unknown>
}

const JS_TAG = 'tag:yaml.org,2002:js'
const SCHEMA = JSON_SCHEMA.extend(new Type(JS_TAG, {
  kind: 'scalar',
  construct: (value: string) => ({ __js: String(value) }),
  represent: (value: unknown) => String((value as { __js?: unknown } | null)?.__js ?? ''),
}))

const PROFILE = join(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL_SH = join(PROFILE, '..', '..', 'scripts', 'install.sh')

let root: string
let home: string
let patchText: string
let entries: LoaderEntry[]
let settings: Record<string, unknown>
let seeded: Record<string, unknown>
let seedOutcome: string

/** Every row of one preset declaration, including nested group rows. */
function allRows(entry: LoaderEntry): InsertRow[] {
  const flat: InsertRow[] = []
  const walk = (rows: ReadonlyArray<{ id?: string; config?: unknown }>): void => {
    for (const row of rows) {
      if (typeof row.id === 'string') flat.push(row as InsertRow)
      if (Array.isArray(row.config)) walk(row.config as Array<{ id?: string; config?: unknown }>)
    }
  }
  walk(entry.config?.plugins as ReadonlyArray<{ id?: string; config?: unknown }> ?? [])
  return flat
}

const presetDeclaration = (seat: string): InsertRow =>
  entries.flatMap(entry => entry.insert ?? []).find(row => row.id === `preset-${seat}`)!

const presetRows = (seat: string): InsertRow[] => allRows(presetDeclaration(seat))

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-fresh-home-'))
  home = join(root, 'dsh')
  const stage = join(root, 'stage')
  const xdg = join(root, 'xdg')
  mkdirSync(stage, { recursive: true })
  mkdirSync(xdg, { recursive: true })
  copyFileSync(join(PROFILE, 'cordis.patch.yml'), join(stage, 'cordis.patch.yml'))
  copyFileSync(join(PROFILE, 'fresh-settings.yaml'), join(stage, 'fresh-settings.yaml'))
  const script = [
    'export DSH_INSTALL_LIB_ONLY=1',
    '. "$INSTALL_SH" 2>/dev/null',
    'DSH_HOME="$HOME_VALUE"',
    'XDG_CONFIG_HOME="$XDG_VALUE"',
    'VERBOSE=1',
    'copy_profile_tree "$STAGE_VALUE" "$DSH_HOME/profiles/web" seed || exit 1',
    'seed_profile_home "$STAGE_VALUE" || exit 1',
  ].join('\n')
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, INSTALL_SH, HOME_VALUE: home, XDG_VALUE: xdg, STAGE_VALUE: stage },
    encoding: 'utf8',
  })
  expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0)

  patchText = readFileSync(join(home, 'profiles/web/cordis.patch.yml'), 'utf8')
  entries = load(patchText, { schema: SCHEMA }) as LoaderEntry[]
  settings = load(readFileSync(join(home, 'settings.yaml'), 'utf8'), { schema: JSON_SCHEMA }) as Record<string, unknown>

  // The real first-run seed, against an in-memory settings document seeded
  // from the fresh settings.yaml, exactly as the first settled boot runs it.
  seeded = structuredClone(settings)
  const handle: SeedSettings = {
    describeNamespace: (ns: string) => ({ user: seeded[ns] }),
    update: (ns: string, patch: object) => {
      seeded[ns] = { ...(seeded[ns] as Record<string, unknown> | undefined), ...patch }
      return Promise.resolve()
    },
  }
  return seedFirstRun(handle, {
    provider: KILO_ROUTE_ID,
    model: KILO_MODEL_ID,
    version: FIRST_RUN_SEED_VERSION,
  }).then((outcome) => { seedOutcome = outcome })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('fresh-home boot composition', () => {
  it('seeds the three presets, the depth-2 subagent, and the research web rows', () => {
    const presetIds = entries.flatMap(entry => entry.insert ?? []).map(row => row.id).filter(id => id.startsWith('preset-'))
    expect(presetIds.sort()).toEqual(['preset-creator', 'preset-orchestrator', 'preset-sysadmin'])
    for (const id of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
      expect(entries.find(entry => entry.id === id)?.disabled, `${id} must stay disabled`).toBe(true)
    }

    expect(entries.find(entry => entry.id === 'subagent')?.config?.maxDepth).toBe(2)

    const web = entries.find(entry => entry.id === 'web')
    expect(web?.config).toEqual({ searchProvider: 'exa', fetchProvider: 'http' })
    const searchExa = entries.flatMap(entry => entry.insert ?? []).find(row => row.id === 'web-search-exa')
    expect(searchExa?.config).toEqual({ searchType: 'auto', highlightsPerResult: 2 })
    const setup = entries.flatMap(entry => entry.insert ?? []).find(row => row.id === 'web-setup')
    expect(setup?.name).toBe('@deepseek-ai/dsh-web-setup')
  })

  it('runs the real first-run seed to the keyless Kilo route', () => {
    expect(seedOutcome).toBe('seeded')
    const providers = (seeded['llm-pi-ai'] as { providers?: Record<string, { keyless?: boolean }> } | undefined)?.providers
    expect(providers?.[KILO_ROUTE_ID]?.keyless).toBe(true)
    expect(seeded['agent-default-model']).toEqual({ provider: KILO_ROUTE_ID, model: KILO_MODEL_ID })
  })

  it('keeps the wizard search gate closed in every preset until the wizard applies', () => {
    for (const seat of ['orchestrator', 'sysadmin', 'creator']) {
      const webTool = presetRows(seat).find(row => row.id === 'tool-web')
      expect(webTool?.config?.search, `${seat} tool-web.search`).toBe(false)
      expect(webTool?.config?.fetch, `${seat} tool-web.fetch`).toBe(true)
    }
  })

  it('resolves the role registry the server runs: four spawnable workers and a tool-only oracle', () => {
    const orchestration = entries.find(entry => entry.id === 'enpoi-orchestration')
    const document = { ...orchestration?.config, ...(settings['enpoi-orchestration'] as Record<string, unknown> | undefined) }
    // The fresh document never carries the operator capabilities section; the
    // defaults below are what a fresh boot runs with.
    expect(document.capabilities).toBeUndefined()
    const registry = listRoleRegistry({ describe: () => [{ ns: 'enpoi-orchestration', value: document }] })
    expect(Object.keys(registry).sort()).toEqual(['designer', 'explorer', 'fixer', 'librarian', 'oracle'])
    for (const id of ['fixer', 'explorer', 'librarian', 'designer']) {
      expect(registry[id]?.spawnable, `${id} must be spawnable`).toBe(true)
    }
    expect(registry['oracle']?.spawnable).toBe(false)
    expect(registry['designer']?.label).toBe('Designer')
    expect(registry['oracle']?.label).toBe('The Oracle')
  })

  it('enables the fleet capabilities by default and pre-attaches no tool group for any seat', () => {
    const state = initialCapabilitiesState()
    for (const id of ['oracle_review', 'roundtable', 'chorus', 'fixer', 'explorer', 'librarian', 'designer']) {
      expect(state.tools[id], `tool ${id} must default on`).toBe(true)
    }
    for (const id of ['tier1-workflow', 'tier2-workflow', 'tier3-workflow']) {
      expect(state.skills[id], `skill ${id} must default on`).toBe(true)
    }
    expect(state.mcp['plane-mcp']).toBe(false)

    const catalog = resolveToolGroups(undefined)
    for (const seat of ['orchestrator', 'sysadmin', 'creator', 'broker', 'fixer', 'explorer', 'librarian', 'designer', 'oracle']) {
      expect(preAttachFor(catalog, seat), `seat ${seat} pre-attach`).toEqual([])
    }
  })

  it('pins the child catalogs to the narrower server surfaces', () => {
    expect(ROLE_CHILD_ALLOW.librarian).toEqual([
      'bash', 'custom_research-fetch', 'custom_research-verify', 'edit', 'glob', 'grep',
      'memory_save', 'memory_search', 'read', 'read_image', 'skill', 'subagent',
      'todo_write', 'web_fetch', 'web_search', 'whiteboard_read', 'write',
    ])
    expect(ROLE_CHILD_ALLOW.oracle).toEqual([
      'bash', 'edit', 'glob', 'grep', 'memory_confirm', 'memory_rescind', 'memory_save',
      'memory_search', 'read', 'read_image', 'request_evidence', 'skill', 'subagent',
      'todo_write', 'web_search', 'whiteboard_read', 'write',
    ])
    // The delegation exception is the only built-in allow name the shared
    // worker floor names; every other allow name survives it. The whiteboard
    // keep list is unioned at composition time by `childToolFilter`, so the
    // built-in lists carry only the one board tool the live server surface
    // names.
    expect(Object.keys(ROLE_CHILD_ALLOW).sort()).toEqual(['librarian', 'oracle'])
    for (const [role, allow] of Object.entries(ROLE_CHILD_ALLOW)) {
      const overlaps = allow.filter(name => SHARED_CHILD_DENY.includes(name))
      expect(overlaps, `${role} allowlist overlaps the shared floor`).toEqual(['subagent'])
      expect(new Set(allow).size, `${role} allowlist duplicates`).toBe(allow.length)
      const board = allow.filter(name => SHARED_CHILD_KEEP.includes(name))
      expect(board, `${role} board entry`).toEqual(['whiteboard_read'])
    }
  })
})
