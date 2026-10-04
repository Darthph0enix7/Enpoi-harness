/**
 * enpoi-council — Tool registrations.
 *
 * Built-in `roundtable` and `chorus` keep their exact argument surface and
 * output contracts (compat): a settings entry for their id rewrites the spec
 * they run, never their signature. Settings-defined councils get one tool per
 * council id (`<councilId>`, arguments `{task, context?}`), plus the two
 * management tools `council_register` (validate + persist one declarative
 * council) and `council_list` (ids, labels, seats, enabled state).
 *
 * Every registration is an effect on the injected context, and `settings/updated`
 * for `enpoi-orchestration` re-syncs the live set: changed/new councils are
 * registered, removed/disabled ones are disposed. I7 single-flight applies
 * across every council of one session.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { runCouncil } from './core/engine.ts'
import type { CouncilRuntimeResult } from './core/engine.ts'
import type { CouncilSpec, DeclarativeCouncilSpec } from './core/spec.ts'
import { CHORUS_PARAM_DEFAULTS } from './profiles/chorus.ts'
import { ROUNDTABLE_PARAM_DEFAULTS } from './profiles/roundtable.ts'
import { getCouncilParams } from './params.ts'
import type { CouncilRuntimeParams } from './params.ts'
import {
  BUILTIN_COUNCIL_IDS,
  COUNCIL_MANAGEMENT_TOOL_IDS,
  ORCH_NAMESPACE,
  councilProblem,
  councilSettingsEntry,
  loadCouncilRegistry,
  validateDeclarativeCouncil,
  type CouncilEntry,
} from './registry.ts'

interface CouncilArgs {
  query: string
  maxRounds?: number
  hideLimit?: boolean
}

interface DeclarativeCouncilArgs {
  task: string
  context?: string
}

/** Optional settings write seam (the settings service is an optional dependency). */
interface SettingsWriter {
  describe?: () => Array<{ ns: string; revision?: number }>
  mutate?: (ns: string, ops: Array<{ op: string; path: string[]; value?: unknown }>, expectedRevision?: number) => Promise<unknown>
}

function mergeParams(resolved: CouncilRuntimeParams, over: Partial<CouncilRuntimeParams>): CouncilRuntimeParams {
  return { ...resolved, ...over }
}

function qualityBlock(r: CouncilRuntimeResult): string {
  const q = r.quality
  const lines = [
    `Crux resolution: ${q.cruxResolutionRatio !== null ? `${(q.cruxResolutionRatio * 100).toFixed(0)}%` : 'n/a'}`,
    `Adversarial survivability: ${q.adversarialSurvivability !== null ? `${(q.adversarialSurvivability * 100).toFixed(0)}%` : 'n/a'}`,
    `Evidence-backed invariants: ${q.invariantDensity}`,
  ]
  if (q.newClusters !== null) lines.push(`Distinct idea clusters: ${q.newClusters}`)
  return lines.join(' · ')
}

/** Map a settings entry's stopping policy onto runtime params and the round bound. */
function stoppingOverrides(entry: CouncilEntry): { params: Partial<CouncilRuntimeParams>; maxRounds?: number } {
  const policy = entry.declarative?.stoppingPolicy
  const params: Partial<CouncilRuntimeParams> = {}
  if (policy?.stagnationLimit !== undefined) params.stagnationLimit = policy.stagnationLimit
  const maxRounds = policy?.type === 'fixed_epochs' ? policy.maxEpochs : undefined
  return { params, ...(maxRounds !== undefined ? { maxRounds } : {}) }
}

export function registerCouncilTools(ctx: Context, root: Context): void {
  void root
  const busyCouncils = new Set<string>()
  const live = new Map<string, { dispose: () => void; fingerprint: string }>()
  /** Sync-time problems already reported (settings/updated fires often; no spam). */
  let reportedProblems = new Set<string>()

  /** Rebuild the live tool set from the current settings (idempotent hot-swap). */
  const sync = (): void => {
    let registry
    try {
      registry = loadCouncilRegistry(ctx)
    } catch (err) {
      councilProblem('(registry)', String(err))
      return
    }
    const seenProblems = new Set<string>()
    const reportOnce = (id: string, problem: string): void => {
      const key = `${id}\u0000${problem}`
      seenProblems.add(key)
      if (reportedProblems.has(key)) return
      councilProblem(id, problem)
    }
    const desired = new Map<string, { fingerprint: string; definition: ToolDefinition }>()
    for (const entry of registry.entries) {
      if (!entry.enabled || entry.spec === null) continue
      if (COUNCIL_MANAGEMENT_TOOL_IDS.includes(entry.id)) {
        reportOnce(entry.id, 'id is reserved for a council management tool')
        continue
      }
      const definition = BUILTIN_COUNCIL_IDS.includes(entry.id)
        ? builtinDefinition(entry, busyCouncils, ctx)
        : declarativeDefinition(entry, busyCouncils, ctx)
      desired.set(entry.id, { fingerprint: fingerprintOf(entry, definition), definition })
    }
    for (const [name, tool] of [...live]) {
      const want = desired.get(name)
      if (want !== undefined && want.fingerprint === tool.fingerprint) continue
      tool.dispose()
      live.delete(name)
    }
    for (const [name, want] of desired) {
      if (live.has(name)) continue
      try {
        live.set(name, { dispose: ctx.tools.register(want.definition), fingerprint: want.fingerprint })
      } catch (err) {
        reportOnce(name, `tool registration failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    reportedProblems = seenProblems
  }

  // Management tools are always present (their own effects dispose with ctx).
  ctx.tools.register(registerDefinition(sync, ctx))
  ctx.tools.register(listDefinition(ctx))

  sync()
  ctx.on('settings/updated', ((ns: unknown) => {
    if (String(ns) !== ORCH_NAMESPACE) return
    sync()
  }) as (...args: unknown[]) => unknown)
}

/** Model-facing surface + spec identity: a change to either re-registers the tool. */
function fingerprintOf(entry: CouncilEntry, definition: ToolDefinition): string {
  return JSON.stringify({
    description: definition.description,
    parameters: definition.parameters,
    spec: entry.spec,
    declarative: entry.declarative,
  })
}

// ---------------------------------------------------------------------------
// Built-in councils — signatures frozen for existing sessions
// ---------------------------------------------------------------------------

function builtinDefinition(
  entry: CouncilEntry,
  busyCouncils: Set<string>,
  ctx: Context,
): ToolDefinition {
  const id = entry.id
  const spec = entry.spec as CouncilSpec
  /** Declarative extras apply to a settings override too (never silently dropped). */
  const runOptions = (
    toolRounds: number | undefined,
    defaults: Partial<CouncilRuntimeParams>,
  ): { params: CouncilRuntimeParams; maxRoundsOverride: number | undefined; chairTemplate: DeclarativeCouncilSpec['chairTemplate'] | undefined } => {
    const { params: policyParams, maxRounds: policyRounds } = stoppingOverrides(entry)
    return {
      params: mergeParams(getCouncilParams(ctx), { ...defaults, ...policyParams }),
      maxRoundsOverride: toolRounds ?? policyRounds,
      chairTemplate: entry.declarative?.chairTemplate,
    }
  }
  if (id === 'roundtable') {
    return {
      name: 'roundtable',
      description: [
        'Run a high-stakes multi-agent architecture debate (Skeptic, Architect, Pragmatist + Referee + Chair).',
        'Blind independent formulation, steelmanned dialectic over a dispute ledger, referee adjudication with floor allocation,',
        'evidence broker for codebase/web ground truth, deterministic peak-stopping with a final challenge round.',
        'Hardcoded blocking — returns the Council Decision (ADR) with binding dissents and quality metrics.',
        'Pure deliberation: the result is an advisory report — do NOT make speculative code edits or file modifications during or immediately after this call without explicit user confirmation.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The specific architectural dilemma, design choice, or technical decision to debate.',
          },
          maxRounds: {
            type: 'number',
            description: 'Safety round cap (default 6). Never announced to the seats.',
          },
          hideLimit: {
            type: 'boolean',
            description: 'Kept for compatibility; the round cap is always hidden from the seats.',
          },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            synthesis: { type: 'string' },
            roundsRun: { type: 'number' },
            consensusRatio: { type: 'number' },
            stopReason: { type: 'string' },
            dissents: { type: 'array', items: { type: 'string' } },
          },
          required: ['synthesis', 'roundsRun', 'consensusRatio', 'stopReason', 'dissents'],
        },
        render: (_args, value) => [{ type: 'text', text: value.synthesis }],
      },
      async execute(args: CouncilArgs, exec) {
        const parent: Agent | undefined = exec.agent
        if (parent === undefined) throw new Error('roundtable requires a calling agent')
        const key = parent.session.id
        if (busyCouncils.has(key)) {
          return {
            synthesis: '## Council Decision\n\nDebate rejected by single-flight mutex (I7): another Council deliberation is already running.',
            roundsRun: 0, consensusRatio: 0, stopReason: 'CONCURRENT_CALL_REJECTED', dissents: [],
          }
        }
        busyCouncils.add(key)
        try {
          const { params, maxRoundsOverride, chairTemplate } = runOptions(args.maxRounds, ROUNDTABLE_PARAM_DEFAULTS)
          const result = await runCouncil(ctx, parent, {
            spec,
            query: args.query,
            params,
            signal: exec.signal,
            maxRoundsOverride,
            chairTemplate,
          })
          const dissents = result.ledgerState.entries
            .filter(e => e.status === 'dissent')
            .map(e => `${e.id}: ${e.assertion}`)
          const consensusRatio = result.quality.cruxResolutionRatio ?? 0
          const synthesis = [
            result.deliverable,
            '',
            '---',
            `_${result.roundsRun} epoch(s) · stop: ${result.stopReason} · ${qualityBlock(result)}_`,
          ].join('\n')
          return { synthesis, roundsRun: result.roundsRun, consensusRatio, stopReason: result.stopReason, dissents }
        } finally {
          busyCouncils.delete(key)
        }
      },
    }
  }
  return {
    name: 'chorus',
    description: [
      'Run a polyphonic brainstorm (Visionary, Experiencer, Integrator + Curator).',
      'Ideas grow in an append-only forest — divergence-first, nothing ever pruned — with blind independent formulation,',
      'topological-saturation stopping, and a lineage-tracked harvest.',
      'Hardcoded blocking — returns the Idea Harvest with themes, gems and provenance.',
      'Pure ideation: the result is an advisory report — do NOT make speculative code edits or file modifications during or immediately after this call without explicit user confirmation.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The vision, feature concept, or seed idea to brainstorm.',
        },
        maxRounds: {
          type: 'number',
          description: 'Safety round cap (default 6). Never announced to the seats.',
        },
        hideLimit: {
          type: 'boolean',
          description: 'Kept for compatibility; the round cap is always hidden from the seats.',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          harvest: { type: 'string' },
          roundsRun: { type: 'number' },
          gems: { type: 'array', items: { type: 'string' } },
          stopReason: { type: 'string' },
        },
        required: ['harvest', 'roundsRun', 'gems', 'stopReason'],
      },
      render: (_args, value) => [{ type: 'text', text: value.harvest }],
    },
    async execute(args: CouncilArgs, exec) {
      const parent: Agent | undefined = exec.agent
      if (parent === undefined) throw new Error('chorus requires a calling agent')
      const key = parent.session.id
      if (busyCouncils.has(key)) {
        return {
          harvest: '## Chorus Harvest\n\nBrainstorm rejected by single-flight mutex (I7): another Council deliberation is already running.',
          roundsRun: 0, gems: [], stopReason: 'CONCURRENT_CALL_REJECTED',
        }
      }
      busyCouncils.add(key)
      try {
        const { params, maxRoundsOverride, chairTemplate } = runOptions(args.maxRounds, CHORUS_PARAM_DEFAULTS)
        const result = await runCouncil(ctx, parent, {
          spec,
          query: args.query,
          params,
          signal: exec.signal,
          maxRoundsOverride,
          chairTemplate,
        })
        const gems = result.ledgerState.entries.slice(0, 12).map(e => `${e.id}: ${e.assertion}`)
        const harvest = [
          result.deliverable,
          '',
          '---',
          `_${result.roundsRun} epoch(s) · stop: ${result.stopReason} · ${qualityBlock(result)}_`,
        ].join('\n')
        return { harvest, roundsRun: result.roundsRun, gems, stopReason: result.stopReason }
      } finally {
        busyCouncils.delete(key)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Settings-defined councils
// ---------------------------------------------------------------------------

function declarativeDefinition(entry: CouncilEntry, busyCouncils: Set<string>, ctx: Context): ToolDefinition {
  const spec = entry.spec as CouncilSpec
  const chairTemplate = entry.declarative?.chairTemplate
  const seats = spec.seats.map(s => `${s.label} (${s.id})`).join(', ')
  const description = [
    `Run the ${entry.label} council — seats: ${seats} — plus Referee and Chair arbitration.`,
    entry.description,
    'Blind independent formulation, referee-adjudicated ledger, deterministic stopping, chair synthesis.',
    'Hardcoded blocking — returns the council report with quality metrics.',
    'Pure deliberation: the result is an advisory report — do NOT make speculative code edits or file modifications during or immediately after this call without explicit user confirmation.',
  ].filter(Boolean).join(' ')
  return {
    name: spec.id,
    description,
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The decision, question, or seed this council deliberates on.',
        },
        context: {
          type: 'string',
          description: 'Optional supporting context (constraints, prior decisions, file paths) appended to the task.',
        },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string' },
          roundsRun: { type: 'number' },
          stopReason: { type: 'string' },
        },
        required: ['report', 'roundsRun', 'stopReason'],
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args: DeclarativeCouncilArgs, exec) {
      const parent: Agent | undefined = exec.agent
      if (parent === undefined) throw new Error(`${spec.id} requires a calling agent`)
      const key = parent.session.id
      if (busyCouncils.has(key)) {
        return {
          report: `## ${entry.label}\n\nCouncil rejected by single-flight mutex (I7): another Council deliberation is already running.`,
          roundsRun: 0, stopReason: 'CONCURRENT_CALL_REJECTED',
        }
      }
      busyCouncils.add(key)
      try {
        const { params: policyParams, maxRounds } = stoppingOverrides(entry)
        const query = typeof args.context === 'string' && args.context !== ''
          ? `${args.task}\n\nCONTEXT:\n${args.context}`
          : args.task
        const result = await runCouncil(ctx, parent, {
          spec,
          query,
          params: mergeParams(getCouncilParams(ctx), policyParams),
          signal: exec.signal,
          ...(maxRounds !== undefined ? { maxRoundsOverride: maxRounds } : {}),
          ...(chairTemplate !== undefined ? { chairTemplate } : {}),
        })
        const report = [
          result.deliverable,
          '',
          '---',
          `_${result.roundsRun} epoch(s) · stop: ${result.stopReason} · ${qualityBlock(result)}_`,
        ].join('\n')
        return { report, roundsRun: result.roundsRun, stopReason: result.stopReason }
      } finally {
        busyCouncils.delete(key)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Management tools
// ---------------------------------------------------------------------------

function registerDefinition(sync: () => void, ctx: Context): ToolDefinition {
  return {
    name: 'council_register',
    description: [
      'Register or replace ONE declarative council in enpoi-orchestration.councils (persisted through settings).',
      'Supply the full council definition: id, label, seats (2-8, persona each), ledger kinds, actions, deliverable sections,',
      'stopping policy, and chair prompt template. The id becomes the tool name; a settings entry for the built-in ids',
      'roundtable/chorus rewrites those councils in place. Invalid definitions are rejected with the exact problems.',
      'A registered council hot-swaps its tool immediately (no restart).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Council id: /^[a-z0-9_-]{2,32}$/ — also the tool name.' },
        label: { type: 'string', description: 'Human label shown in the UI (1-64 chars).' },
        description: { type: 'string', description: 'One-line description of what the council deliberates.' },
        seats: {
          type: 'array',
          minItems: 2,
          maxItems: 8,
          description: 'Contender seats; "referee" and "chair" are reserved arbiter ids.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Seat id: /^[a-z0-9_-]{2,32}$/; also the personas routing key.' },
              label: { type: 'string', description: 'Seat label (1-64 chars).' },
              persona: { type: 'string', description: 'Persona text injected as the seat system context.' },
              opGates: { type: 'array', items: { type: 'string' }, description: 'Ledger kinds / actions this seat may propose.' },
              family: { type: 'string', enum: ['adversarial', 'systemic', 'practical', 'divergent', 'empirical', 'neutral'], description: 'Model-family hint for default routing.' },
            },
            required: ['id', 'label', 'persona'],
          },
        },
        ledgerKinds: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              idPrefix: { type: 'string', description: '1-4 chars; ledger ids are PREFIX-N.' },
              terminalStatuses: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', enum: ['open', 'contested', 'invariant', 'falsified', 'dissent'] },
              },
            },
            required: ['kind', 'idPrefix', 'terminalStatuses'],
          },
        },
        actions: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Ops a contender turn may propose (e.g. CONCEDE, DEFEND).' },
        steelman: { type: 'boolean', description: 'Require a steelman before attacks (debate councils).' },
        scopeContract: { type: 'string', description: 'Out-of-scope rules the referee enforces.' },
        opening: { type: 'string', enum: ['blind', 'open'], description: 'blind = independent epoch-0 formulation; open = straight to rounds.' },
        forestMode: { type: 'boolean', description: 'Idea-forest council (SPROUT/BRANCH/FUSE/TENSION); nothing is ever pruned.' },
        deliverableSections: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Exact sections the chair compiles.' },
        stoppingPolicy: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['ledger_convergence', 'topological_saturation', 'fixed_epochs'] },
            stagnationLimit: { type: 'number', description: 'Epochs without movement before the final challenge (1-6).' },
            maxEpochs: { type: 'number', description: 'Hard epoch bound for fixed_epochs (1-12).' },
          },
          required: ['type'],
        },
        chairTemplate: {
          type: 'object',
          description: 'Chair prompts; placeholders {{label}}, {{query}}, {{ledger}}, {{evidence}}, {{sections}}, {{note}} are substituted in userPromptTemplate.',
          properties: {
            systemPrompt: { type: 'string' },
            userPromptTemplate: { type: 'string' },
          },
          required: ['systemPrompt', 'userPromptTemplate'],
        },
      },
      required: ['id', 'label', 'seats', 'ledgerKinds', 'actions', 'deliverableSections', 'stoppingPolicy', 'chairTemplate'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          enabled: { type: 'boolean' },
        },
        required: ['id', 'enabled'],
      },
      render: (_args, value) => [{ type: 'text', text: `Council "${value.id}" registered and enabled (tool: ${value.id}).` }],
    },
    async execute(args: unknown) {
      const { decl, errors } = validateDeclarativeCouncil(args)
      if (decl === undefined) {
        throw new Error(`council_register rejected the definition: ${errors.join('; ')}`)
      }
      await persistCouncil(ctx, decl.id, decl)
      sync()
      return { id: decl.id, enabled: true }
    },
  }
}

function listDefinition(ctx: Context): ToolDefinition {
  return {
    name: 'council_list',
    description: [
      'List the councils available in this session: the built-in roundtable and chorus plus every council registered under',
      'enpoi-orchestration.councils. Shows each council id, label, seats, whether its tool is enabled, and any validation problem.',
    ].join(' '),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          councils: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                builtin: { type: 'boolean' },
                enabled: { type: 'boolean' },
                seats: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { id: { type: 'string' }, label: { type: 'string' }, family: { type: 'string' } },
                    required: ['id', 'label'],
                  },
                },
                error: { type: 'string' },
              },
              required: ['id', 'label', 'builtin', 'enabled', 'seats'],
            },
          },
        },
        required: ['councils'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.councils.map(c =>
          `${c.enabled ? '●' : '○'} ${c.id} — ${c.label} [${c.seats.map((s: { id: string }) => s.id).join(', ')}]${c.error !== undefined ? ` — invalid: ${c.error}` : ''}`,
        ).join('\n'),
      }],
    },
    async execute() {
      const registry = loadCouncilRegistry(ctx)
      return {
        councils: registry.entries.map(entry => ({
          id: entry.id,
          label: entry.label,
          builtin: entry.builtin,
          enabled: entry.enabled,
          seats: entry.seats.map(seat => ({
            id: seat.id,
            label: seat.label,
            ...(seat.family !== undefined ? { family: seat.family } : {}),
          })),
          ...(entry.error !== undefined ? { error: entry.error } : {}),
        })),
      }
    },
  }
}

/**
 * Persist one declarative council under `councils[id]` through the settings
 * service, retrying a stale-revision conflict so a concurrent write never
 * silently drops the registration.
 * @param ctx - owning plugin context.
 * @param id - council id (the settings map key).
 * @param decl - the validated definition.
 * @throws when no writable settings service is available or persistence fails.
 */
async function persistCouncil(ctx: Context, id: string, decl: DeclarativeCouncilSpec): Promise<void> {
  const settings = ctx.get('settings') as SettingsWriter | undefined
  if (settings?.mutate === undefined) {
    throw new Error('council_register needs a writable settings service (enpoi-orchestration.councils is the registry source of truth)')
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = settings.describe?.().find(entry => entry.ns === ORCH_NAMESPACE)?.revision
    try {
      await settings.mutate(ORCH_NAMESPACE, [{ op: 'set', path: ['councils', id], value: councilSettingsEntry(decl) }], revision)
      return
    } catch (err) {
      if ((err as { code?: unknown }).code === 'SETTINGS_CONFLICT' && attempt < 2) continue
      throw err
    }
  }
  throw new Error(`council_register could not persist "${id}": the settings namespace kept changing under it`)
}
