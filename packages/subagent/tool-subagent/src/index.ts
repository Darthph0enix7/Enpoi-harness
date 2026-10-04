/**
 * Model-facing delegation through one configured `ctx.subagents` provider.
 * Provider lifecycle controls tool registration and context-sensitive schema
 * wording. Foreground calls always dispose the run after collection.
 * Background policy is selected by this plugin's configuration: one-shot
 * calls own a plain Task, while continuable calls use
 * `ctx.subagents.startContinuable()`.
 * @module @deepseek-ai/dsh-tool-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  assertSubagentMaxDepth,
  parentAgentOptionsForDelegation,
  settleRun,
  withChildBudgetGuidance,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import {
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from './model-selection.ts'
import type { DelegationModelRequest, ModelSelectionPolicy } from './model-selection.ts'
import { registerListSubagentModels } from './list-models.ts'
import type {} from './model-selection-settings.ts'
import {
  recordSubagentModelSelection,
  subagentModelSelectionProjectionDefinition,
  subagentModelSelectionPolicy,
} from './model-selection-state.ts'

export const name = 'tool-subagent'
export const inject = ['tools', 'subagents', 'systemPrompt', 'sessionProjections']

/** Config: which registered provider this tool delegates to, plus child defaults. */
export interface Config {
  /** The `ctx.subagents` provider name to start runs on (e.g. `spawn`, `acp`). */
  provider: string
  /**
   * Model-facing tool name (default `subagent`). Each loaded instance must use
   * a distinct name.
   */
  toolName?: string
  /**
   * Sample the Host `subagent-model-selection` setting for each new top-level
   * Session and inherit that decision in its child Sessions.
   */
  modelSelectionSettings?: boolean
  /**
   * Expose `run_in_background` (default true). Disabled instances omit the
   * parameter and reject forced background calls.
   */
  enableRunInBackground?: boolean
  /**
   * Background execution policy (default `one-shot`). `one-shot` defaults calls
   * to foreground; `continuable` defaults them to background, requires a provider
   * with the `prepareContinuable` capability, and returns the durable child id.
   * Follow-up adapters remain independently optional.
   */
  backgroundMode?: 'one-shot' | 'continuable'
  /**
   * Agent options applied to every child; omitted fields use child-loop defaults.
   */
  agentOptions?: AgentOptions
  /**
   * Per-child persona that shadows `deployment:persona-prefix`. Requires the
   * provider's `persona` capability; omission preserves the deployment persona.
   */
  persona?: string
  /**
   * Tool filter applied to every child. Filtered tools disappear from its
   * prompt and reject execution. Requires the provider's `toolFilter`
   * capability; unknown names fail startup.
   */
  toolFilter?: {
    /** Global tool names the child keeps; everything else is removed. */
    allow?: string[]
    /** Global tool names removed from the child. */
    deny?: string[]
  }
  /**
   * Maximum child depth: a non-negative safe integer (`0` forbids delegation),
   * or `'provider-managed'` to send no cap. A numeric cap
   * requires the provider's `depthLimit` capability (mount fails loud
   * otherwise). The provider checks the calling agent's current depth at every
   * start; the tool remains model-visible so runtime policy owns rejection.
   * `'provider-managed'` is for an out-of-process provider whose recursion
   * budget belongs to the child runtime or its own deployment. Omission reads
   * the current Host subagent depth setting (default `1`) at each delegation.
   */
  maxDepth?: number | 'provider-managed'
}

export const Config: z<Config> = z.object({
  provider: z.string().required(),
  toolName: z.string().default('subagent'),
  modelSelectionSettings: z.boolean().default(false),
  enableRunInBackground: z.boolean().default(true),
  backgroundMode: z.union(['one-shot', 'continuable'] as const).default('one-shot'),
  // Prevent Schemastery from materializing omitted agentOptions as `{}`.
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  }).default(undefined as unknown as {
    provider: string
    model: string
    reasoningEffort: ReturnType<typeof ReasoningEffortId>
    maxTokens: number
  }),
  persona: z.string(),
  // Preserve omission; Schemastery's `{ allow: [] }` default would deny every tool.
  toolFilter: z.object({
    allow: z.array(z.string()).default(undefined as unknown as string[]),
    deny: z.array(z.string()).default(undefined as unknown as string[]),
  }).default(undefined as unknown as { allow: string[]; deny: string[] }),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]),
})

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(start: Promise<SubagentRun>, signal: AbortSignal): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    // Product providers aggregate startup and rollback failures. Cancellation
    // must not turn a failed cleanup into a cleanly killed Job.
    return signal.aborted && !(error instanceof AggregateError)
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    // Merge-extensible union: a backend may add stop reasons. Treat an unknown
    // terminal reason as a failure rather than reporting partial output as success.
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/**
 * Append provider-authored failure detail and the child's preserved partial
 * answer to a stop-reason error, keeping diagnostic text separate from the
 * child's assistant output.
 * @param error - the stop-reason headline.
 * @param result - the child's terminal result.
 * @returns the headline, diagnostic, and partial text that are present.
 */
function withDiagnosticAndPartialText(error: string, result: SubagentResult): string {
  const diagnostic = result.diagnostic === undefined
    ? ''
    : `\nDiagnostic: ${result.diagnostic}`
  const text = result.output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  const partial = text.length === 0
    ? ''
    : `\nPartial output before the run ended:\n${text}`
  return `${error}${diagnostic}${partial}`
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
}

/**
 * Collect and release one foreground run without letting disposal replace an
 * independent result failure.
 */
async function settleForegroundRun(run: SubagentRun): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        // The registry converts this throw to isError; partial output is not
        // success, but the preserved partial answer still reaches the parent.
        throw new Error(withDiagnosticAndPartialText(error, result))
      }
      const report = result.output.filter(
        (block): block is Extract<ContentBlock, { type: 'text' | 'image' }> =>
          block.type === 'text' || block.type === 'image',
      )
      return {
        kind: 'foreground',
        runId: run.id,
        // Only the child's final REPORT reaches the parent — reasoning and
        // tool-call blocks (the child's thinking and its intermediate
        // actions) are stripped so the parent receives the targeted result,
        // not the exploration that produced it. Text and image blocks pass
        // through; the registry performs the authoritative lossless snapshot.
        output: report as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * Model-facing wording from the provider's conversation-history descriptor
 * ({@link SubagentProvider.inheritsParentContext}).
 * A fresh child needs a standalone prompt; a forked child already sees the
 * conversation's completed turns — telling the model to restate everything
 * (or, worse, that the child "does not see this conversation") would be false
 * for a fork.
 * @param inheritsConversation - whether the child's conversation is seeded
 *   with the parent's completed turns; this says nothing about tool, service,
 *   scope, or authority inheritance.
 * @returns the tool `description` and the `prompt` parameter description.
 */
function providerWording(inheritsConversation: boolean): { description: string; promptDescription: string } {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

interface DelegationRunRequest {
  readonly run_in_background?: boolean
}

interface DelegationRunSpec {
  readonly runInBackground: boolean
}


/**
 * Resolve the child route from Settings > enpoi-orchestration.personas for the
 * role selected for this delegation (explicit `role` argument first, then the
 * detected role), falling back to matching any persona key in the delegation
 * text (e.g. "fixer", "librarian", "explorer"). A persona assigned to a chain
 * resolves through the live chains document to the first enabled link, so the
 * child is recorded on the route it actually runs and a stale or disabled
 * chain falls back to the parent's route instead of failing the spawn.
 * @param personas - the namespace's per-role child routes.
 * @param role - the role selected for this delegation, if any.
 * @param description - the delegated task description.
 * @param prompt - the delegated task prompt.
 * @param registry - the live role registry; a tool-only role's persona route is
 *   never matched from text, so a delegation cannot silently become that role.
 * @param chains - the namespace's model-group chains, keyed by chain id.
 * @returns the selected role's child route, or undefined when none is configured.
 */
function resolveSubagentPersonaModel(
  personas: OrchestrationSettingsDocument['personas'],
  role: string | undefined,
  description?: string,
  prompt?: string,
  registry?: Record<string, ResolvedRole>,
  chains?: OrchestrationSettingsDocument['chains'],
): AgentOptions | undefined {
  if (personas === undefined) return undefined
  const routeFor = (candidate: string): AgentOptions | undefined => {
    const entry = personas[candidate]
    // A cleared seat materializes as null in the stored document; it routes
    // like an absent one.
    if (entry === undefined || entry === null) return undefined
    if (entry.chain !== undefined) {
      const chain = chains?.[entry.chain]
      const link = chain?.disabled === true ? undefined : chain?.links?.[0]
      if (link?.provider === undefined || link.model === undefined) return undefined
      // Resolve the group to its first link: the child starts on a concrete
      // route (truthful header) and keeps the group id so the runtime can
      // still fail over to the next link.
      return { provider: link.provider, model: link.model, chain: entry.chain }
    }
    if (entry.provider === undefined || entry.model === undefined) return undefined
    return { provider: entry.provider, model: entry.model }
  }
  if (role !== undefined) {
    const selected = routeFor(role)
    if (selected !== undefined) return selected
  }
  const text = `${description ?? ''} ${prompt ?? ''}`.toLowerCase()
  for (const candidate of Object.keys(personas)) {
    if (candidate === role) continue
    // Tool-only roles (the Oracle) are reached through their own tool with
    // their own query-bound route, never through a generic delegation.
    if (registry?.[candidate]?.spawnable === false) continue
    if (new RegExp(`\\b${escapeRegExp(candidate)}\\b`, 'i').test(text)) {
      const selected = routeFor(candidate)
      if (selected !== undefined) return selected
    }
  }
  return undefined
}

/**
 * Role-specific personas for delegated subagents. When the delegating agent
 * names a specialist role in the description or prompt (librarian, fixer,
 * explorer, designer, oracle), the child receives this persona instead of
 * inheriting the parent's — so a librarian knows it is a librarian, not the
 * Master Orchestrator. Compact by design: the delegation prompt carries the
 * task detail; the persona only fixes identity, scope, and reporting style.
 */
const ROLE_PERSONAS: Record<string, string> = {
  librarian:
    'You are the Librarian — a research specialist delegated by the orchestrator. '
    + 'You gather, verify, and synthesize information from external sources (web, docs, APIs) and run the research skill end-to-end. '
    + 'You report findings clearly and cite your sources.',
  fixer:
    'You are the Fixer — a focused implementation specialist delegated by the orchestrator. '
    + 'You make precise, bounded code changes for a clearly-scoped task. '
    + 'You verify your work (build/test where applicable) and report exactly what changed. '
    + 'For multi-file checks, batch inspections, or programmatic loops, you can use run_code to execute TypeScript in a single turn.',
  explorer:
    'You are the Explorer — a codebase mapper delegated by the orchestrator. '
    + 'You search, read, and map unfamiliar code to answer questions about structure and behavior. '
    + 'You report findings with concrete file paths and line references; you do not implement. '
    + 'For scanning multiple files or programmatic filtering in one turn, you can use run_code.',
  designer:
    'You are the Designer — a UI/UX specialist delegated by the orchestrator. '
    + 'You craft interfaces, styling, and design systems with visual polish and responsive care. '
    + 'You implement frontend changes and report what you changed and why.',
  oracle:
    'You are the Oracle — a senior reviewer delegated by the orchestrator. '
    + 'You evaluate architecture, concepts, trade-offs, and code independently and deeply. '
    + 'You are an advisor, not a dictator: say plainly when something is flawed. '
    + 'You never write or edit files; you summarize, explain, and cite.',
}

/**
 * Shipped roles the generic delegation tool must never spawn. The Oracle is a
 * TOOL with its own protocol (`oracle_review`: query-bound lifecycle, brief
 * injection at call #1, verdict contract, scorecard), not a worker, so a
 * `subagent(role='oracle')` call is refused and no delegation text can infer
 * it. Reversible by data: a settings entry with `spawnable: true` re-enables
 * delegation for the id, and any other role can opt out with `spawnable: false`.
 */
const NON_SPAWNABLE_BUILTINS: readonly string[] = ['oracle']

/**
 * Optional refusal hint per tool-only role: how to reach it instead. A role
 * without a hint gets the generic `spawnable: false` message.
 */
const TOOL_ONLY_ROLE_HINTS: Readonly<Record<string, string>> = {
  oracle: 'the Oracle is consulted through the oracle_review tool, not spawned as a worker',
}

/** The refusal text for a `subagent` call naming a non-spawnable role. */
function nonSpawnableRoleMessage(id: string): string {
  return TOOL_ONLY_ROLE_HINTS[id]
    ?? `role "${id}" is marked spawnable: false — it cannot be delegated; remove the marker in Settings → Dynamic → Roles to delegate it`
}

/**
 * Tools denied to EVERY child this tool spawns. A worker is a one-shot
 * specialist that reports to the orchestrator: it never delegates, convenes a
 * council or oracle review, curates memory, drives harness-level plan
 * mode/goals/workflows, or asks the user. Deny-only by design —
 * `tools.restrict()` skips deny names it does not know, so a tool added
 * upstream stays available unless this list names it.
 *
 * The list also carries the one-delivery rule: denying the child-scoped
 * `send_message` relay makes the settlement notice (background) or this call's
 * result (foreground) the ONLY delivery, and the deny disarms the continuable
 * return-guidance injection (continuation.ts), which would otherwise instruct
 * the child to send a duplicate. Deny wins over allow-lists.
 *
 * The background job controls (`job_output`, `job_list`, `job_kill`) are NOT
 * denied: a child's bash command that outlives the executor timeout is
 * promoted to a job owned by the child, and the bash contract (promoted-result
 * text and `run_in_background`) tells the model to collect it. Job access is
 * fenced by owning session id in the job registry, so a child sees and stops
 * only its own jobs; collection is orthogonal to the one-delivery rule.
 *
 * The harness-authoring tools and `review_run` are named here because the
 * execution guards refuse them for delegated children: the seat guard in
 * `enpoi-capabilities` denies the creator trio to every orchestrator- or
 * sysadmin-parented child, and the reviewer gate in `resolvePolicy` denies
 * `review_run` to every child that is not a reviewer seat. The creator tool
 * group and the capabilities advertise filter already hide them today, but a
 * stored role `available` allowlist or a seat label that resolves to a
 * seat-restricted group would surface them again; the shared floor is what
 * makes the catalog and the guards agree in every path. A delegated child is
 * a worker, never the creator or a reviewer seat.
 */
export const SHARED_CHILD_DENY: readonly string[] = [
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
  'roundtable',
  'chorus',
  'oracle_review',
  'create_goal',
  'get_goal',
  'update_goal',
  'exit_plan_mode',
  'plan_mode',
  'goal',
  'ralph',
  'workflow',
  'ask_user_question',
  // Sub-agents keep their own todo list and their own memory writes (their
  // sessions are isolated; the operator's default is "let them work").
  'send_message',
  'interrupt_agent',
  'list_agents',
  // Harness authoring (creator seat) and reviewer-exec (reviewer seats): the
  // pre-execute guards refuse them for delegated children, so no child catalog
  // may carry them.
  'plugin_manager',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'review_run',
]

/**
 * Tools every child keeps regardless of role surface: the pinned whiteboard.
 * A delegated child may be sent precisely to read or record the board, so the
 * keep list is unioned into every explicit allow surface (operator-configured
 * or role-registry) and stripped from the built-in role deny maps. Only an
 * explicit operator `deny` entry can still remove them — deny is the
 * operator's voice and always wins in `tools.restrict()`.
 */
export const SHARED_CHILD_KEEP: readonly string[] = [
  'whiteboard_read',
  'whiteboard_write',
  'whiteboard_pin',
  'whiteboard_unpin',
]

/**
 * Extra tools denied per inferred specialist role, unioned with
 * {@link SHARED_CHILD_DENY}. Each role keeps only the surface its work needs:
 * explorers read and search but never mutate; the librarian is the research
 * worker and authors its own claim files, so `write`/`edit` are part of its
 * work (the generic `subagent` survives through {@link childToolFilter} for
 * the deep dial's fan-out); fixers and designers implement but never run code
 * or reach the web. A role outside this map (e.g. `oracle`) receives the
 * shared set only.
 */
const ROLE_CHILD_DENY: Record<string, readonly string[]> = {
  // `run_code` is deliberately absent everywhere: the PTC presentation
  // transport is reserved, and `tools.restrict()` throws when a filter names
  // it. A child holding it can only orchestrate the tools it can already see,
  // which these lists bound.
  //
  // Operator defaults: every sub-agent may run bash (reading,
  // analysis, tests — not only writing), use skills, search memory, and keep
  // its own todo list. Readers keep the mutation veto; the research librarian
  // writes its claims; implementers are unrestricted beyond the shared
  // anti-leak floor.
  explorer: ['edit', 'write', 'str_replace_editor'],
  librarian: ['str_replace_editor'],
}

/** Grouping label for one role seat on the operator's orchestration surfaces. */
export type RoleGroup = 'supervision' | 'specialists' | 'council' | 'custom'

/** One `enpoi-orchestration.roles` settings entry. */
export interface RoleRegistryEntry {
  /** Display label for the role; defaults to the capitalized id for user roles. */
  label?: string
  /** System-prompt text a child spawned with this role receives. */
  persona?: string
  /** Fleet grouping hint for UI consumers. */
  group?: RoleGroup
  /**
   * Whether a Fleet seat row shows this role (default true). `false` keeps the
   * role spawnable and listed in permissions while hiding its seat row.
   */
  seat?: boolean
  /** Retire the role — not spawnable, absent from every surface — keeping its definition. */
  disabled?: boolean
  /**
   * Whether the generic delegation tool may spawn this role by name. `false`
   * keeps the role listed (seat, permissions surface, and its own tool path
   * stay untouched) but refuses a `subagent` spawn and removes the id from
   * text inference. Absent → the shipped default: the Oracle is tool-only.
   */
  spawnable?: boolean
  /** Child tool surface for this role. */
  tools?: {
    /** Allowlist that replaces this role's built-in child deny map. */
    available?: string[]
  }
}

/** One role after the settings registry merges over the code defaults. */
export interface ResolvedRole {
  /** Registry id used by the `role` tool parameter and settings keys. */
  id: string
  /** Display label, when one is configured. */
  label?: string
  /** Child system-prompt persona. */
  persona?: string
  /** Fleet grouping hint for UI consumers. */
  group?: RoleGroup
  /** Whether a Fleet seat row shows this role (retired roles are absent). */
  seat: boolean
  /** Whether this role exists in the code defaults (not only in settings). */
  builtin: boolean
  /**
   * Whether the generic delegation tool may spawn this role. `false` means the
   * role is tool-only: it stays listed (seat and permissions surface intact)
   * but `subagent` refuses it and text inference never selects it.
   */
  spawnable: boolean
  /**
   * Explicit child tool allowlist from `tools.available`; when present it
   * replaces {@link ResolvedRole.deny} for this role.
   */
  available?: readonly string[]
  /** Built-in child tool deny extras; empty for a settings-only role or when `available` replaces the deny map. */
  deny: readonly string[]
}

/** The Settings service handle this tool reads through (`ctx.get('settings')`). */
export interface OrchestrationSettingsHandle {
  /** Describe every configurable profile entry; the shared document rides the matching `ns`. */
  describe?: () => ReadonlyArray<{ ns: string; value?: unknown }>
}

/** Structural view of the `enpoi-orchestration` document this tool consumes. */
export interface OrchestrationSettingsDocument {
  /** Per-role child model route, keyed by role id; a cleared seat stores null. */
  personas?: Record<string, { provider?: string; model?: string; chain?: string } | null>
  /** Model-group chains the persona routes may reference, keyed by chain id. */
  chains?: Record<string, {
    /** Ordered failover links; the first enabled link is the initial route. */
    links?: ReadonlyArray<{ provider?: string; model?: string }>
    disabled?: boolean
  }>
  /** Operator role registry, merged over the code defaults. */
  roles?: Record<string, RoleRegistryEntry>
  /** Operator permission overrides, including per-role tool availability. */
  permissions?: { agents?: Record<string, { available?: string[] }> }
}

/** The group values a {@link RoleRegistryEntry.group} may name. */
const ROLE_GROUPS: readonly RoleGroup[] = ['supervision', 'specialists', 'council', 'custom']

/** Escape a role id so it matches literally inside a word-boundary pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Read one settings entry as a registry object; invalid JSON entries are ignored. */
function asRoleRegistryEntry(value: unknown): RoleRegistryEntry | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : undefined
}

/** Keep only a declared {@link RoleGroup}. */
function asRoleGroup(value: unknown): RoleGroup | undefined {
  return ROLE_GROUPS.includes(value as RoleGroup) ? value as RoleGroup : undefined
}

/** The profile entry id owning the orchestration document this tool consumes. */
const ORCHESTRATION_ENTRY_ID = 'enpoi-orchestration'

/**
 * Entry ids the last completed read found without a configurable form, so the
 * warning fires once per entry change instead of once per delegation.
 */
const entryWithoutVolatileForm = new Set<string>()

/** One completed `enpoi-orchestration` read, carried into {@link listRoleRegistry}. */
export interface OrchestrationDocumentRead {
  /** The described document, or `undefined` when no configurable entry exists. */
  readonly document: OrchestrationSettingsDocument | undefined
}

/**
 * Read the live `enpoi-orchestration` document through the Settings service's
 * `describe()` descriptors (the profile entry of the same id owns the document
 * after the settings→Config migration). A missing service, an entry without a
 * configurable form, or a failed read yields `undefined`, so delegation keeps
 * its code defaults instead of failing. The engine omits entries whose Config
 * declares no volatile field, so an absent entry warns once per entry change
 * through `warn` when the caller can report it.
 * @param settings - the Settings service handle (`ctx.get('settings')`).
 * @param warn - sink for the once-per-entry-change no-volatile-form warning.
 * @returns the document, or `undefined` when it is unavailable.
 */
export function readOrchestrationDocument(
  settings: OrchestrationSettingsHandle | undefined,
  warn?: (message: string) => void,
): OrchestrationSettingsDocument | undefined {
  try {
    if (settings?.describe === undefined) return undefined
    const document = settings.describe().find(entry => entry.ns === ORCHESTRATION_ENTRY_ID)?.value
    if (typeof document !== 'object' || document === null) {
      if (warn !== undefined && !entryWithoutVolatileForm.has(ORCHESTRATION_ENTRY_ID)) {
        entryWithoutVolatileForm.add(ORCHESTRATION_ENTRY_ID)
        warn(`tool-subagent: ${ORCHESTRATION_ENTRY_ID} has no volatile form; consumers fall back to defaults`)
      }
      return undefined
    }
    entryWithoutVolatileForm.delete(ORCHESTRATION_ENTRY_ID)
    return document
  } catch {
    // A settings read is best-effort: a provider fault must not fail delegation.
    return undefined
  }
}

/**
 * Resolve the operator's role registry: the code-default roles merged with
 * `enpoi-orchestration.roles`. A settings entry with a built-in id overrides
 * that role's persona, label, group, and tool surface; an entry with a new id
 * adds a role; `disabled: true` retires a role — built-in or not — from every
 * surface, while `seat: false` only hides its Fleet row. Read fresh per spawn,
 * so settings edits apply on the next dispatch.
 * @param settings - the Settings service handle; omit for the code defaults.
 * @param read - a completed {@link readOrchestrationDocument} result; omit to read here.
 * @returns every active role keyed by its id.
 */
export function listRoleRegistry(
  settings?: OrchestrationSettingsHandle,
  read?: OrchestrationDocumentRead,
): Record<string, ResolvedRole> {
  const document = read === undefined ? readOrchestrationDocument(settings) : read.document
  const configured: unknown = document?.roles
  const overrides = new Map<string, RoleRegistryEntry>()
  const retired = new Set<string>()
  if (typeof configured === 'object' && configured !== null && !Array.isArray(configured)) {
    for (const [id, value] of Object.entries(configured)) {
      const entry = asRoleRegistryEntry(value)
      if (entry === undefined) continue
      if (entry.disabled === true) retired.add(id)
      else overrides.set(id, entry)
    }
  }
  const registry: Record<string, ResolvedRole> = {}
  for (const id of new Set([...Object.keys(ROLE_PERSONAS), ...overrides.keys()])) {
    if (retired.has(id)) continue
    const builtinPersona = ROLE_PERSONAS[id]
    const entry = overrides.get(id)
    const available = Array.isArray(entry?.tools?.available)
      ? entry.tools.available.map(String)
      : undefined
    const persona = typeof entry?.persona === 'string' ? entry.persona : builtinPersona
    const label = typeof entry?.label === 'string' ? entry.label : undefined
    const group = asRoleGroup(entry?.group)
    // Spawnability is data-driven and reversible: the shipped tool-only
    // defaults (the Oracle) apply unless the operator entry says otherwise.
    const spawnable = entry?.spawnable ?? !NON_SPAWNABLE_BUILTINS.includes(id)
    registry[id] = {
      id,
      seat: entry?.seat !== false,
      builtin: builtinPersona !== undefined,
      spawnable,
      deny: available === undefined ? ROLE_CHILD_DENY[id] ?? [] : [],
      ...persona !== undefined ? { persona } : {},
      ...label !== undefined ? { label } : {},
      ...group !== undefined ? { group } : {},
      ...available !== undefined ? { available } : {},
    }
  }
  return registry
}

/**
 * The registry read used to audit a STORED availability list (`permissions.
 * agents[role].available` and the registry's `tools.available`): operator data
 * outlives tool renames, so an unresolvable name is dropped with a warning
 * instead of reaching `tools.restrict()`, whose unknown-allow check would
 * abort the child's spawn. The code-authored `config.toolFilter` never goes
 * through this audit — there an unknown name stays a build-time contract and
 * keeps throwing.
 */
interface StoredAvailabilityAudit {
  /** Whether the registry resolves a tool name for the spawning agent's scope. */
  readonly isKnown: (name: string) => boolean
  /** Warning sink for each dropped name. */
  readonly warn: (message: string) => void
}

/**
 * Drop names a stored availability list carries that the live registry no
 * longer resolves, warning once per name. The known subset keeps its order;
 * the caller re-deduplicates when composing the filter.
 * @param available - the stored allowlist, in stored order.
 * @param role - the role the list belongs to (for the warning).
 * @param audit - registry lookup plus warning sink.
 * @returns the resolvable names, in their stored order.
 */
function auditStoredAvailability(
  available: readonly string[],
  role: string | undefined,
  audit: StoredAvailabilityAudit,
): string[] {
  const kept: string[] = []
  for (const name of available) {
    if (audit.isKnown(name)) kept.push(name)
    else audit.warn(`tool-subagent: role "${role ?? 'unknown'}" stores unavailable tool "${name}" — dropping it so the role still spawns`)
  }
  return kept
}

/**
 * Compose the per-child tool filter: the configured filter merged with the
 * shared worker deny list and the selected role's surface. Configured deny
 * entries survive (first, de-duplicated), the configured `allow` list passes
 * through untouched, and `deny` wins over `allow` in `tools.restrict()`.
 * Unknown deny names are no-ops there. A stored availability list is audited
 * against the live registry first (see {@link StoredAvailabilityAudit});
 * configured code-authored names are never audited. Providers without the
 * `toolFilter` capability keep the configured filter unchanged.
 * @param provider - the provider that will start the child.
 * @param configured - the tool instance's configured filter, if any.
 * @param document - the live `enpoi-orchestration` document, if any.
 * @param role - the selected specialist role, if any.
 * @param roleEntry - the registry entry for `role`, when the registry has it.
 * @param audit - live-registry audit for stored availability names.
 * @returns the composed filter, or the configured filter for a provider that cannot apply one.
 */
function childToolFilter(
  provider: SubagentProvider,
  configured: Config['toolFilter'],
  document: OrchestrationSettingsDocument | undefined,
  role: string | undefined,
  roleEntry: ResolvedRole | undefined,
  audit: StoredAvailabilityAudit,
): Config['toolFilter'] {
  if (!provider.capabilities.toolFilter) return configured
  // The Oracle and the Librarian are the children allowed to delegate
  // (operator design: the reviewer spawns its own researchers; the librarian's
  // deep research dial fans out to leaf readers). Every other role keeps the
  // shared subagent veto.
  const keepTool = (name: string): boolean => SHARED_CHILD_KEEP.includes(name)
  const delegatingRole = role === 'oracle' || role === 'librarian'
  const sharedDeny = (delegatingRole
    ? SHARED_CHILD_DENY.filter(name => name !== 'subagent')
    : SHARED_CHILD_DENY).filter(name => !keepTool(name))
  // Layer precedence (doc 61 WP-S6): the permission allowlist is the operator's
  // hard gate and wins; the role registry's `tools.available` (Dynamic → Roles)
  // is the fallback that gives a user-defined role a surface; absent both, the
  // registry entry's built-in deny extras apply. The shared anti-leak floor is
  // always unioned in, and the whiteboard keep list survives every surface.
  const stored = roleAvailableAllowlist(document, role) ?? roleEntry?.available
  if (stored !== undefined) {
    // Operator-defined surface: allow the named tools plus the whiteboard
    // keep list, deny everything else except the shared anti-leak floor
    // (never widen what SHARED_CHILD_DENY already removes).
    return {
      ...configured,
      allow: [...new Set([...configured?.allow ?? [], ...auditStoredAvailability(stored, role, audit), ...SHARED_CHILD_KEEP])],
      deny: [...new Set([...configured?.deny ?? [], ...sharedDeny])],
    }
  }
  return {
    ...configured,
    ...configured?.allow !== undefined
      ? { allow: [...new Set([...configured.allow, ...SHARED_CHILD_KEEP])] }
      : {},
    deny: [...new Set([...configured?.deny ?? [], ...sharedDeny, ...(roleEntry?.deny ?? []).filter(name => !keepTool(name))])],
  }
}

/**
 * Operator-overridable role availability (doc 55 P2): when the permission
 * settings define `agents[role].available`, that allowlist REPLACES the
 * registry's `tools.available` and the built-in role deny map (the operator's
 * explicit surface wins wholesale); absent → the registry's `tools.available`
 * or the built-in ROLE_CHILD_DENY table applies. Read fresh per spawn, so
 * edits hot-swap on the next dispatch.
 * @param document - the live `enpoi-orchestration` document, if any.
 * @param role - the selected specialist role, if any.
 * @returns the permission allowlist, or undefined when the operator set none.
 */
function roleAvailableAllowlist(
  document: OrchestrationSettingsDocument | undefined,
  role: string | undefined,
): string[] | undefined {
  if (role === undefined) return undefined
  const available = document?.permissions?.agents?.[role]?.available
  return Array.isArray(available) ? available.map(String) : undefined
}

/** Task-type fallback signals; a signal only selects a role the registry still has. */
const ROLE_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['librarian', /\b(research|investigate|gather|sources?|api docs?|documentation|web search|external)\b/],
  ['explorer', /\b(map|explore|codebase|structure|locate|find where|understand the code)\b/],
  ['designer', /\b(ui|ux|design|style|interface|responsive|visual|layout)\b/],
  ['fixer', /\b(implement|fix|add|patch|refactor|write code|bug|change the code)\b/],
]

/**
 * Detect the specialist role named in a delegation description or prompt.
 * @param registry - the live role registry; its ids are the explicit names.
 * @param description - the delegated task description.
 * @param prompt - the delegated task prompt.
 * @returns the selected role id, or undefined when nothing matches.
 */
function detectSubagentRole(
  registry: Record<string, ResolvedRole>,
  description?: string,
  prompt?: string,
): string | undefined {
  const text = `${description ?? ''} ${prompt ?? ''}`.toLowerCase()
  // 1. Explicit role name wins — a tool-only role (the Oracle) is never a
  // delegation target, so naming it must not silently spawn it.
  for (const role of Object.keys(registry)) {
    if (registry[role]?.spawnable === false) continue
    const re = new RegExp(`\\b${escapeRegExp(role)}\\b`, 'i')
    if (re.test(text)) return role
  }
  // 2. Task-type heuristics as a fallback — the delegating model often strips
  // the role name from the prompt, so infer the specialist from the work. A
  // retired or tool-only role is never inferred.
  for (const [role, re] of ROLE_SIGNALS) {
    const candidate = registry[role]
    if (candidate !== undefined && candidate.spawnable && re.test(text)) return role
  }
  return undefined
}

/** Resolve the model's optional scheduling request into one execution route. */

function resolveDelegationRun(
  request: DelegationRunRequest,
  options: { readonly backgroundEnabled: boolean; readonly continuable: boolean },
): DelegationRunSpec {
  if (!options.backgroundEnabled) {
    // The validator permits undeclared keys, so schema omission also needs
    // execution-time enforcement.
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
    }
    return { runInBackground: false }
  }
  return {
    // Continuable work is independently scheduled unless the caller explicitly
    // needs the result before its next action. One-shot policy keeps its existing
    // foreground default because its background result requires Task collection.
    runInBackground: request.run_in_background ?? options.continuable,
  }
}

/**
 * Install one delegation-tool composition.
 * @param ctx - Context that owns the registrations.
 * @param config - delegation-tool configuration.
 * @param session - unpublished Session supplied by a direct Agent setup; omit for a standing composition.
 */
export function apply(ctx: Context, config: Config, session?: Session): void {
  // Direct apply() bypasses Schemastery's numeric constraints. A direct-apply
  // omission stays capless (the schema default only runs through the loader).
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  // Reject an empty explicit filter at load instead of failing every delegation.
  if (config.toolFilter !== undefined && config.toolFilter.allow === undefined && config.toolFilter.deny === undefined) {
    throw new Error('tool-subagent: `toolFilter` is configured but names neither `allow` nor `deny` — remove the key or fill the filter')
  }
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent'

  const modelSelectionCapable = config.modelSelectionSettings === true
  ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)

  const assertSubagentProviderConfiguration = (subagentProvider: SubagentProvider): void => {
    if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== undefined && !subagentProvider.capabilities.depthLimit) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — `
        + 'set maxDepth: \'provider-managed\' to leave the recursion budget to the provider',
      )
    }
    if (config.agentOptions !== undefined && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`,
      )
    }
    if (modelSelectionCapable && !subagentProvider.capabilities.agentOptions) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support child model selection`,
      )
    }
    if (continuable && subagentProvider.prepareContinuable === undefined) {
      throw new Error(
        `tool-subagent: provider "${subagentProvider.name}" does not support \`backgroundMode: continuable\``,
      )
    }
  }

  // Validate provider-owned config outside the optional LLM binding so an
  // invalid provider always rejects its registration or this plugin's load.
  ctx.on('subagent/provider-added', (subagentProvider) => {
    if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider)
  })
  const initialProvider = ctx.subagents.getProvider(config.provider)
  if (initialProvider !== undefined) assertSubagentProviderConfiguration(initialProvider)

  const install = (runtimeCtx: Context, modelSelectionPolicy: ModelSelectionPolicy | undefined): void => {
    const modelSelectionEnabled = modelSelectionPolicy !== undefined
    if (modelSelectionPolicy !== undefined) registerListSubagentModels(runtimeCtx, modelSelectionPolicy)
    // Load order and HMR replacement can change provider availability while
    // this fiber remains active.
    let mounted: { subagentProvider: SubagentProvider; disposeTool: () => void } | undefined
    const mount = (subagentProvider: SubagentProvider): void => {
      assertSubagentProviderConfiguration(subagentProvider)
      const wording = providerWording(subagentProvider.inheritsParentContext)
      const providerRouteDefaults = subagentProvider.agentRouteDefaults
      const selectionDescription = providerRouteDefaults !== undefined
        ? ' Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and this provider\'s route defaults. Supply `provider` and `model` together after using `list_subagent_models` to inspect advertised routes and efforts. Changing the effective route without naming an effort uses the selected model\'s default effort.'
        : ' Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and inherit compatible missing values from the parent Agent. Supply `provider` and `model` together after using `list_subagent_models` to inspect advertised routes and efforts. Changing the effective route without naming an effort uses the selected model\'s default effort.'
      const choiceDescription = !modelSelectionEnabled
        ? ''
        : selectionDescription
          + (subagentProvider.inheritsParentContext
            ? ' Changing the route can prevent provider-side reuse of the inherited conversation prefix.'
            : '')
      const roleDescription = ' An optional `role` names the child\'s specialist identity from the operator role registry '
        + '(for example `librarian`, `fixer`, `explorer`); omit it to infer the role from the task. '
        + 'Tool-only roles (for example the Oracle, consulted via `oracle_review`) are refused by design.'
      const disposeTool = runtimeCtx.tools.register(defineTool({
        name: toolName,
        description: wording.description + roleDescription + (backgroundEnabled
          // The completion notice is the continuation service's own behavior, not
          // a separately installed capability, so this promise holds whenever the
          // continuable background path is reachable at all.
          ? continuable
            ? ' This tool runs in the background by default and keeps the child conversation available for later turns. When that run settles, the runtime injects a notice into this session containing its outcome and the child\'s final report; the session wakes to process it, or the notice steers the running turn. Set `run_in_background: false` only when your next action depends on the result.'
            : ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
          : ' This call waits for the subagent and returns its result.') + choiceDescription,
        parameters: {
          description: {
            type: 'string',
            required: true,
            description: 'A short (3-5 word) description of the delegated task, for display.',
          },
          prompt: {
            type: 'string',
            required: true,
            description: wording.promptDescription,
          },
          role: {
            type: 'string' as const,
            description: 'Optional specialist role id for the child, naming a delegatable role in the operator role registry. '
              + 'Omit to infer the role from the description and prompt. An unknown or tool-only id is rejected and lists the configured roles.',
          },
          ...modelSelectionEnabled ? {
            provider: {
              type: 'string' as const,
              description: providerRouteDefaults !== undefined
                ? 'LLM provider route for the child. Supply together with model; omit both to use configured child defaults or this provider\'s route defaults.'
                : 'LLM provider route for the child. Supply together with model; omit both to use configured child defaults or inherit the parent route.',
            },
            model: {
              type: 'string' as const,
              description: providerRouteDefaults !== undefined
                ? 'Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or this provider\'s route defaults.'
                : 'Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or inherit the parent route.',
            },
            reasoning_effort: {
              type: 'string' as const,
              description: providerRouteDefaults !== undefined
                ? 'Adapter-owned reasoning effort for the effective child route. Omit to use a compatible configured effort or the selected model\'s default.'
                : 'Adapter-owned reasoning effort for the effective child route. Omit to inherit a compatible configured/parent effort or use a newly selected model\'s default.',
            },
          } : {},
          ...backgroundEnabled ? {
            run_in_background: {
              type: 'boolean' as const,
              description: continuable
                ? 'Defaults to true. Set false only when your next action depends on the result.'
                : 'Run as a background job and return its id (collect with job_output, stop with job_kill). Defaults to false.',
            },
          } : {},
        },
        output: {
          schema: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'background' },
                  jobId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'continuable' },
                  subagentId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'foreground' },
                  runId: { type: 'string', required: true },
                  output: { type: 'array', required: true, items: { type: 'json' } },
                },
              },
            ],
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.kind === 'background'
              ? `started background subagent job ${value.jobId}`
              : value.kind === 'continuable'
                ? `started subagent ${value.subagentId}`
                : outputValueText(value.output),
          }],
        },
        // Children never mutate the parent session; the one parent-owned write
        // (tasks.start) is a synchronous commutative insertion.
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) {
            // Non-agent callers provide no parent for delegation ownership.
            throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
          }

          const modelRequest = args as DelegationModelRequest
          const parentOptions = parentAgentOptionsForDelegation(parent)
          // Role selection is settings-backed and read fresh per spawn: the
          // registry supplies explicit names, personas, and tool surfaces, and
          // an explicit `role` argument is validated before any child starts.
          const settingsHandle = runtimeCtx.get('settings') as OrchestrationSettingsHandle | undefined
          const document = readOrchestrationDocument(settingsHandle, (message) => { runtimeCtx.logger.warn(message) })
          const registry = listRoleRegistry(settingsHandle, { document })
          const requestedRole = args.role
          if (requestedRole !== undefined && registry[requestedRole] === undefined) {
            const availableRoles = Object.keys(registry)
            throw new Error(availableRoles.length === 0
              ? `unknown subagent role "${requestedRole}": this deployment configures no roles`
              : `unknown subagent role "${requestedRole}"; available roles: ${availableRoles.join(', ')}`)
          }
          const role = requestedRole ?? detectSubagentRole(registry, args.description, args.prompt)
          const roleEntry = role === undefined ? undefined : registry[role]
          // Tool-only roles (the Oracle) keep their registry row, seat, and
          // permissions surface, but the generic delegation tool never spawns
          // them: their own tool owns the protocol and the route.
          if (role !== undefined && roleEntry?.spawnable === false) {
            throw new Error(nonSpawnableRoleMessage(role))
          }
          const requiresRoutePreflight = hasDelegationModelRequest(modelRequest)
            || hasConfiguredLlmSelection(config.agentOptions)
          const configuredChildAgentOptions = requiresRoutePreflight && providerRouteDefaults !== undefined
            ? { ...providerRouteDefaults, ...config.agentOptions }
            : config.agentOptions
          const requestedChildAgentOptions = requestedAgentOptions(
            parentOptions,
            configuredChildAgentOptions,
            modelRequest,
            modelSelectionEnabled,
          ) ?? resolveSubagentPersonaModel(document?.personas, role, args.description, args.prompt, registry, document?.chains)
          assertAllowedModelSelection(
            modelSelectionPolicy,
            parentOptions,
            requestedChildAgentOptions,
            modelRequest,
          )
          if (requiresRoutePreflight) {
            const llm = runtimeCtx.get('llm')
            if (llm === undefined) {
              throw new Error('cannot resolve the selected child LLM route because the `llm` service is unavailable')
            }
            await preflightChildLlmRoute(
              llm,
              parentOptions,
              requestedChildAgentOptions,
              exec.signal,
              providerRouteDefaults === undefined,
            )
            if (runtimeCtx.subagents.getProvider(config.provider) !== subagentProvider) {
              throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`)
            }
          }
          exec.signal.throwIfAborted()
          // Upstream 0.1.6: depth limits resolve through the subagent service
          // (own editable delegation limits) — keep their resolution, keep our
          // role-specific persona + label.
          const maxDepth = runtimeCtx.subagents.resolveMaxDepth(config.maxDepth)
          // Role-specific persona: an explicit config persona wins; otherwise the
          // registry entry for the selected role (librarian/fixer/explorer/
          // designer/oracle or an operator-defined role) gives the child its own
          // identity instead of inheriting the parent's (e.g. the Master
          // Orchestrator).
          const rolePersona = config.persona !== undefined
            ? config.persona
            : roleEntry?.persona
          const formattedLabel = role !== undefined && !new RegExp(`\\b${escapeRegExp(role)}\\b`, 'i').test(args.description)
            ? `${role.charAt(0).toUpperCase() + role.slice(1)}: ${args.description}`
            : args.description
          const request = {
            label: formattedLabel,
            prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
            parent,
            ...requestedChildAgentOptions !== undefined ? { agentOptions: requestedChildAgentOptions } : {},
            ...rolePersona !== undefined ? { persona: rolePersona } : {},
            ...(() => {
              const delegated = childToolFilter(subagentProvider, config.toolFilter, document, role, roleEntry, {
                // A stored availability name counts as known when the parent's
                // scope resolves it; the child inherits exactly that surface.
                isKnown: name => runtimeCtx.tools.get(name, parent) !== undefined,
                warn: (message) => { runtimeCtx.logger.warn(message) },
              })
              return delegated === undefined ? {} : { toolFilter: delegated }
            })(),
            ...maxDepth !== undefined ? { maxDepth } : {},
          }

          const runSpec = resolveDelegationRun(args, { backgroundEnabled, continuable })
          if (runSpec.runInBackground) {
            if (continuable) {
              // Resolves at inbox acceptance: the child owns its own turns from
              // there, so this call neither waits for nor collects a result.
              const started = await runtimeCtx.subagents.startContinuable({
                provider: config.provider,
                label: formattedLabel,
                request,
                signal: exec.signal,
              })
              return { kind: 'continuable' as const, subagentId: started.childId }
            }
            const jobs = runtimeCtx.get('jobs')
            if (jobs === undefined) {
              throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
            }
            // One-shot background child: job preflight finishes before the
            // starter can spawn, and the task-owned signal covers startup.
            const id = jobs.start({
              kind: 'subagent',
              label: args.description,
              owner: parent.id,
              run: () => {
                const controller = new AbortController()
                const start = runtimeCtx.subagents.start(config.provider, {
                  ...request,
                  // One-shot children bypass the continuable create path, so the
                  // standing budget clause is applied here too.
                  prompt: withChildBudgetGuidance(request.prompt),
                  signal: controller.signal,
                })
                return {
                  cancel: (reason?: string) => {
                    controller.abort(reason ?? 'background subagent task killed')
                  },
                  done: settleStart(start, controller.signal),
                  // No output sources: the child session owns intermediate detail.
                }
              },
            })
            return { kind: 'background' as const, jobId: id }
          }

          const run: SubagentRun = await runtimeCtx.subagents.start(config.provider, {
            ...request,
            // Foreground children bypass the continuable create path; apply the
            // same standing budget clause here so every delegation inherits it.
            prompt: withChildBudgetGuidance(request.prompt),
            signal: exec.signal,
          })
          return settleForegroundRun(run)
        },
      }))
      mounted = { subagentProvider, disposeTool }
    }

    // Register listeners before checking presence so no synchronous change is missed.
    // TODO(subagent-dup-toolname): two waiting one-shot fibers configured with the
    // same toolName collide when their provider appears, and the duplicate-name
    // throw rolls back the provider registration. Continuable instances reserve
    // their prompt-section name during apply() and fail earlier. Add an intent
    // registry if the late one-shot collision occurs in a shipped composition.
    runtimeCtx.on('subagent/provider-added', (subagentProvider) => {
      if (subagentProvider.name === config.provider && mounted === undefined) mount(subagentProvider)
    })
    runtimeCtx.on('subagent/provider-removed', (name) => {
      if (name !== config.provider || mounted === undefined) return
      mounted.disposeTool()
      mounted = undefined
    })
    const present = runtimeCtx.subagents.getProvider(config.provider)
    if (present !== undefined) {
      mount(present)
    } else {
      // A backend fiber may activate later; a misspelled provider remains visible in this log.
      runtimeCtx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? 'subagent'}" tool will register when it appears`)
    }
    if (backgroundEnabled && continuable) {
      // The section follows provider availability without its own manual
      // lifecycle: empty text is omitted from rendered prompts while the tool is
      // absent, and the registration itself stays owned by this plugin fiber.
      runtimeCtx.systemPrompt.section({
        name: `tool:${toolName}`,
        order: runtimeCtx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
        text: context => mounted === undefined || runtimeCtx.tools.get(toolName, context.scope) === undefined
          ? ''
          : `Start independent ${toolName} delegations together in one assistant message and continue useful work while they run.`,
      })
    }
  }

  if (config.modelSelectionSettings !== true) {
    install(ctx, undefined)
    return
  }

  const settings = ctx.get('subagentModelSelection')
  if (settings === undefined) {
    throw new Error(
      'tool-subagent: `modelSelectionSettings` requires '
      + '@deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope',
    )
  }
  const selectForSession = (target: Session): ModelSelectionPolicy | undefined => {
    const freshSession = target.firstLiveSeq === 0
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      && target.eventAt(SessionSeq(0))?.type !== 'session/end-seed'
    let allowedModels = subagentModelSelectionPolicy(ctx.sessionProjections, target)
    if (allowedModels === undefined) {
      const parentId = target.header.origin === 'subagent'
        ? target.header.parentSession
        : undefined
      if (parentId !== undefined) {
        const sessions = ctx.get('sessions')
        if (sessions === undefined) {
          throw new Error('tool-subagent: child model-selection inheritance requires the Session registry')
        }
        const parent = sessions.get(parentId)
        allowedModels = parent === undefined
          ? undefined
          : subagentModelSelectionPolicy(ctx.sessionProjections, parent)
      } else if (freshSession) {
        const current = settings.current()
        allowedModels = current.enabled ? current.allowedModels : undefined
      }
    }
    if (allowedModels !== undefined) {
      recordSubagentModelSelection(ctx.sessionProjections, target, allowedModels)
    }
    return allowedModels === undefined ? undefined : { routes: allowedModels }
  }

  if (session !== undefined) {
    install(ctx, selectForSession(session))
    return
  }

  const compositionScope = scopeOf(ctx)
  if (compositionScope === undefined) {
    throw new Error('tool-subagent: standing `modelSelectionSettings` requires a scoped preset Context')
  }
  const agents = ctx.get('agents')
  /* v8 ignore next -- shipped preset compositions always include the Agent registry. */
  if (agents === undefined) throw new Error('tool-subagent: standing `modelSelectionSettings` requires the Agent registry')
  const scopedInstalls = new WeakMap<Agent, ReturnType<Context['inject']>>()
  const installing = new WeakSet<Agent>()
  const belongsToComposition = (candidate: Agent): boolean =>
    scopeChainOf(scopeOf(candidate.ctx)).includes(compositionScope)
  const installScoped = (candidate: Agent): ReturnType<Context['inject']> | undefined => {
    const existing = scopedInstalls.get(candidate)
    if (existing !== undefined) return existing
    if (installing.has(candidate)) return
    // Reserve before the injected fiber runs: tool registration emits
    // `tools/change` synchronously, which re-enters the reconciliation below.
    installing.add(candidate)
    let fiber: ReturnType<Context['inject']>
    try {
      const policy = selectForSession(candidate.session)
      fiber = candidate.ctx.inject(['tools', 'subagents', 'systemPrompt'], (runtimeCtx) => {
        install(runtimeCtx, policy)
      })
    } finally {
      installing.delete(candidate)
    }
    scopedInstalls.set(candidate, fiber)
    return fiber
  }
  const removeScoped = (candidate: Agent): void => {
    const fiber = scopedInstalls.get(candidate)
    if (fiber === undefined) return
    scopedInstalls.delete(candidate)
    /* v8 ignore next 3 -- Cordis Fiber disposal contains registration cleanup failures; this is the final diagnostic sink. */
    void Promise.resolve(fiber.dispose()).catch((error: unknown) => {
      ctx.logger.warn(`tool-subagent: failed to remove recomposed Agent "${candidate.id}" definitions: ${String(error)}`)
    })
  }
  const reconcileComposedAgents = (): void => {
    for (const candidate of agents.list()) {
      if (belongsToComposition(candidate)) installScoped(candidate)
      else removeScoped(candidate)
    }
  }
  // The preset-scoped listener admits descendant Agents and installs the
  // sampled tool definition in each Agent's own scope, so a later settings
  // change cannot mutate a live session.
  ctx.on('agent/created', async ({ agent: created }) => {
    await installScoped(created)
  })
  ctx.on('agent/disposed', ({ agent: disposed }) => { removeScoped(disposed) })
  // Reparenting an Agent between standing presets changes its inherited tool
  // set and emits `tools/change`; reconcile the Agent-owned override with the
  // new ancestry. Other registry changes are idempotent no-ops here.
  ctx.on('tools/change', reconcileComposedAgents)
  reconcileComposedAgents()
}
