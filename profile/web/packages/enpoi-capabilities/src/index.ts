/**
 * enpoi-capabilities — Capabilities enforcement engine (Global Management).
 *
 * Implements:
 * - B1: Execution-level enforcement via monotonic tool guard (`ctx.tools.guard`).
 * - B4: Disabled skills are SHADOWED out of every injection surface — a runtime twin
 *   with both invocation surfaces off outranks the provider entry (providerOrder -1),
 *   so the skill vanishes from the model-facing catalog, the `skill` tool, and the
 *   `/name` user gesture, exactly as if it were uninstalled. Zero token cost.
 * - I15: Protected infrastructure invariants (contracts, keeper, cascade, living-brief, read, glob, grep).
 *
 * The operator UI lives in the dsh-better-sidebar "Capabilities & Tools" drawer
 * (sidebar-patch/src/client/CapabilitiesView.tsx); this plugin is the single
 * enforcement + state-resolution backend both surfaces write into via
 * settings namespace `enpoi-orchestration.capabilities`.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { ContextFormed, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { hasOpenTurn } from '@deepseek-ai/dsh-user-approval'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** The skill-hint mount note attached after a `skill` load. */
    'mcp-mounts': { kind: 'mcp-mounts' } & ContextFormed
  }
}
import Schema from '@deepseek-ai/schemastery'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import type { CapabilitiesState } from './types'
import { KNOWN_CAPABILITIES, PROTECTED_CAPABILITIES } from './types'
import { initialCapabilitiesState } from './state'
import { filterSkillCatalogMessages } from './catalog'
import { evaluateToolCall } from './enforcement'
import {
  resolvePolicy, grantProposalFor, grantProposalForOutcome, standingGrantRecord, agentRoleOf, reviewerSeatOf, mcpServerNameOf, mcpPolicyRemovalOps,
  SHIPPED_TOOL_DEFAULTS, SHIPPED_BASH_PATTERNS, advertisedToolNames, isFullAccessMode, FULL_ACCESS_ASK_REASON, REVIEW_RUN_TOOL, seatToolDenyFor,
  type AgentLike, type PermissionPolicyConfig, type GrantProposal, type StandingGrant,
} from './policy'
import { canFenceMcpWrites, type McpCatalogSettings, type SettingsPathOp } from './mcp-tools'
import {
  buildMountRows, mcpDefaultWorldIds, mcpDisabledReason, mcpMountsProjection,
  mcpServerOfToolName, mcpToolDenyReason, mcpVisibleIds, mcpWorldOf, MCP_MOUNTS_EVENT,
  serverModeOf, serverNameOf,
  type McpMountRow, type McpServerRecord,
} from './mcp-mounts'
import {
  capabilityOverridesProjection, effectiveCapabilitiesState, withCapabilityOverride,
  CAPABILITY_OVERRIDES_EVENT, EMPTY_CAPABILITY_OVERRIDES,
  type CapabilityOverrideKind, type CapabilityOverrideRecord,
} from './capability-overrides'
import { stripUnavailableToolGuidance } from './prompt-honesty'
import { installSearchNudge } from './search-nudge'
import { installReviewRunTool } from './review-run'
import { createApprovalParkJournal } from './approval-parks'
import {
  ChildApprovalForwarder, FORWARDED_ASK_MARKER, delegatedChildOf, forwardedApprovalsSeam,
  type ApprovalOutcome, type ChildAgentLike, type ModelRecommendation, type ParentRailQuery,
  type RecommendationQuery, type RootAskQuery, type RootHandle, type RootMode,
} from './forwarding'
import { requestRecommendation, RECOMMENDATION_TIMEOUT_MS } from './recommendation'

/** Last published catalog entry names per session (dedupe of no-op updates). */
const publishedCatalog = new Map<string, string>()

/** Last logged on-demand surface signature (dedupe of repeated assemble passes). */
let lastOnDemandSurfaceSignature: string | undefined

export const name = 'enpoi-capabilities'
export const inject = ['tools', 'systemPrompt', 'settings', 'timer']

const ORCH_NS = 'enpoi-orchestration'

/**
 * Mark a schema subtree live-editable. The merged engine's vendored
 * schemastery carries `.volatile()`; the pre-0.1.7 build of the same module
 * predates it, and the profile must boot on both during the sync window.
 */
function live<T extends object>(schema: T): T {
  return (schema as T & { volatile?: () => T }).volatile?.() ?? schema
}

export const CapabilitiesSchema = Schema.object({
  tools: Schema.dict(Schema.boolean()).default({}),
  skills: Schema.dict(Schema.boolean()).default({}),
  mcp: Schema.dict(Schema.boolean()).default({}),
})

/** One MCP server catalog entry (`enpoi-orchestration.mcpServers.<id>`). */
export interface OrchestrationMcpServer {
  serverName?: string
  transport?: string
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  apiKeyEnv?: string
  /**
   * `on-demand` servers are never auto-mounted: the agent mounts them for its
   * session with the `mcp` tool (or a skill's `mcp:` hint). Absent = always-on
   * (the pre-existing behavior). Both modes require the master allow
   * `capabilities.mcp[id] === true`.
   */
  mode?: 'always-on' | 'on-demand'
}

/**
 * Namespace owner Config for `enpoi-orchestration` — the shared state surface
 * every enpoi plugin reads (capabilities, MCP catalog + status, fleet
 * personas, orchestration parameters, UI preferences). Under the merged
 * settings model the owner entry's Config IS the document: `settings.yaml` is
 * imported into the entry of the same id, the settings service projects these
 * `.volatile()` fields as a live form, and every other plugin reads the
 * document through the settings service (see `dsh-enpoi-contracts`
 * `readOrchestrationDocument`). Nested records stay opaque plugin-owned
 * vocabularies so round-trips are byte-faithful.
 */
export interface OrchestrationConfig {
  /** Global capability toggles (tools/skills/mcp). */
  capabilities: Volatile<Partial<CapabilitiesState>>
  /** Declarative MCP server catalog; a mount requires `capabilities.mcp[id] === true`. */
  mcpServers: Volatile<Record<string, OrchestrationMcpServer>>
  /** Runtime reachability heartbeat written by this plugin (green/blue/grey dots). */
  mcpStatus: Volatile<Record<string, unknown>>
  /** Fleet model assignments per persona/seat id. */
  personas: Volatile<Record<string, unknown>>
  /** Operator-defined specialist roles (doc 59). */
  roles: Volatile<Record<string, unknown>>
  /** Operator-defined councils (doc 59). */
  councils: Volatile<Record<string, unknown>>
  /** Operator-defined model failover chains (doc 60). */
  chains: Volatile<Record<string, unknown>>
  /** Dynamic catalogue rules (doc 82 §E5): visibility, privacy, group selectors. */
  catalogRules: Volatile<Record<string, unknown>>
  /** Orchestration parameters (council/keeper/oracle/memory/verifyGate). */
  parameters: Volatile<Record<string, unknown>>
  /** UI preferences (favorites, hidden models, hidden surfaces, provider order). */
  uiPreferences: Volatile<Record<string, unknown>>
  /** Permission policy document (defaults/tools/grants/agents) — doc 55. */
  permissions: Volatile<PermissionPolicyConfig>
  /** Pinned whiteboard store (doc 66 §3c / doc 67 §B). */
  whiteboard: Volatile<Record<string, unknown>>
  /** Tool-group overrides (doc 80): per-group `enabled`, per-seat `preAttach`. */
  toolGroups: Volatile<Record<string, unknown>>
  /** Operator-authored command tools (enpoi-custom-tools): id → record. */
  customTools: Volatile<Array<Record<string, unknown>>>
  /**
   * Per-seat execution deny lists (tool names a seat may not CALL while the
   * tool stays advertised for prompt-prefix cache neutrality). A seat key
   * replaces its shipped list; absent = the shipped default.
   */
  seatToolDeny: Volatile<Record<string, string[]>>
}

export const OrchestrationSettingsSchema = Schema.object({
  capabilities: live(CapabilitiesSchema.default({})),
  mcpServers: live(Schema.dict(Schema.any()).default({})),
  mcpStatus: live(Schema.dict(Schema.any()).default({})),
  personas: live(Schema.dict(Schema.any()).default({})),
  // Operator-defined specialist roles and councils (doc 59): declared here so
  // the namespace contract is explicit rather than relying on unknown-key
  // survival — both remain opaque plugin-owned vocabularies.
  roles: live(Schema.dict(Schema.any()).default({})),
  councils: live(Schema.dict(Schema.any()).default({})),
  // Operator-defined model failover chains (doc 60): id → { label?, links,
  // attempts?, onCut?, disabled? }. Owned by enpoi-model-chains, declared here
  // so the namespace contract admits the key rather than relying on
  // unknown-key survival.
  chains: live(Schema.dict(Schema.any()).default({})),
  // Dynamic catalogue rules (doc 82 §E5): privacy seed, visibility hide rules,
  // manual overrides. Owned by dsh-enpoi-catalog-rules and declared here so the
  // namespace contract admits the key rather than relying on unknown-key survival.
  catalogRules: live(Schema.dict(Schema.any()).default({})),
  parameters: live(Schema.dict(Schema.any()).default({})),
  // UI preferences (favorites, hidden models, model assignments, …) shared by
  // every client through `settings/document-updated`. The whole record stays
  // opaque so sibling keys survive the form projection.
  uiPreferences: live(Schema.dict(Schema.any()).default({})),
  permissions: live(Schema.dict(Schema.any()).default({})),
  // Pinned whiteboard (doc 66 §3c / doc 67 §B): orchestrator-authored
  // core-context board, owned by enpoi-whiteboard and rendered into every
  // runtime-context snapshot. Declared so the namespace contract admits the
  // key rather than relying on unknown-key survival.
  whiteboard: live(Schema.dict(Schema.any()).default({})),
  // Tool-group overrides (doc 80): `groups.<id>.enabled` and
  // `seats.<seat>.preAttach`. Declared so the namespace contract admits the
  // key; the shipped group catalog lives in dsh-enpoi-tool-groups.
  toolGroups: live(Schema.dict(Schema.any()).default({})),
  // Operator-authored command tools (enpoi-custom-tools): an array of
  // { id, name, description, params, command } records. Declared so the
  // namespace contract admits the key; the runtime plugin owns the vocabulary.
  customTools: live(Schema.array(Schema.any()).default([])),
  // Per-seat execution deny lists (tool names a seat may not CALL). Declared so
  // the namespace contract admits the key; the shipped defaults live in
  // `policy.ts` (`SHIPPED_SEAT_TOOL_DENY`) and a seat key here replaces one.
  seatToolDeny: live(Schema.dict(Schema.array(Schema.string())).default({})),
})

/** Function-plugin Config export: the owning entry's schema IS the shared document. */
export const Config = OrchestrationSettingsSchema

/**
 * Revision-fenced removal of every policy row belonging to servers that left
 * the catalog: the `mcp__<server>__*` wildcard, exact `mcp__<server>__<tool>`
 * rows, and the same keys under every agent override. The permission config is
 * re-read on each attempt so a concurrent write is included, not clobbered.
 * The removal path itself ({@link removeMcpServerFenced}) unsets catalog entry
 * and rows in one write; this is the backstop for catalog shrinks that arrived
 * through another writer.
 * @param settings - settings service (no-op when unavailable).
 * @param servers - mounted server names that are no longer in the catalog.
 * @param readConfig - fresh permission-config reader.
 * @returns the number of rule rows unset.
 */
export async function pruneRemovedMcpPolicyRows(
  settings: McpCatalogSettings | undefined,
  servers: readonly string[],
  readConfig: () => PermissionPolicyConfig | undefined,
): Promise<number> {
  if (!canFenceMcpWrites(settings) || servers.length === 0) return 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ops: SettingsPathOp[] = servers.flatMap(server => mcpPolicyRemovalOps(server, readConfig()))
    if (ops.length === 0) return 0
    const revision = settings.describe?.().find((entry: { ns: string; revision?: number }) => entry.ns === ORCH_NS)?.revision
    try {
      await settings.mutate(ORCH_NS, ops, revision)
      return ops.length
    } catch (error) {
      const conflict = error as { code?: string }
      if ((conflict?.code === 'SETTINGS_CONFLICT' || conflict?.code === 'settings/conflict') && attempt < 2) continue
      throw error
    }
  }
  return 0
}

export function apply(ctx: Context, config: OrchestrationConfig = {} as OrchestrationConfig): void {
  // 0. Ownership: the merged settings model derives the form from THIS entry's
  //    Config (`enpoi-orchestration` is the entry id), so no namespace
  //    registration is needed. Pre-0.1.7 engines still build their document
  //    from a registered namespace schema — the optional call is a no-op on
  //    the merged engine and keeps the sync-window profile bootable on both.
  try {
    const settingsApi = ctx.get('settings') as {
      register?: (ns: string, schema: unknown, opts?: { base?: unknown }) => unknown
    } | undefined
    settingsApi?.register?.(ORCH_NS, OrchestrationSettingsSchema, { base: { capabilities: {} } })
  } catch (error) {
    process.stderr.write(`[enpoi-capabilities] namespace registration failed: ${String(error)}\n`)
  }

  // 0a. This plugin ships its own client page (the Capabilities & Tools drawer
  //     in the sidebar patch), so suppress the auto-generated settings page.
  ctx.inject(['settings'], (child) => {
    child.effect(() => {
      const settings = child.get('settings') as { configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void } | undefined
      return settings?.configure?.({ auto: false }, ctx.fiber)
    })
  })

  /**
   * Read one shared-document field. The merged engine hands the owner entry's
   * volatile Config fields to `apply` as references; a pre-0.1.7 engine has no
   * Config-backed namespace, so the same field is read back from the registered
   * settings namespace instead — one profile boots on both.
   */
  function documentValue<T>(field: Volatile<T> | T | undefined, key: string): T | undefined {
    const ref = field as Volatile<T> | undefined
    if (typeof ref?.get === 'function') return ref.get()
    const document = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    return document?.[key] as T | undefined
  }

  /** The live capability toggles, read through the owning Config reference. */
  function getGlobalDefaults(): Partial<CapabilitiesState> | undefined {
    try {
      return documentValue(config.capabilities, 'capabilities')
    } catch {
      return undefined
    }
  }

  // 0b. Permissions matrix source: `enpoiCapabilities.registeredTools`
  //     projects the ENTIRE live tool registry (`ctx.tools.schemas()`), and
  //     `enpoiCapabilities.mcpTools` the MCP subset, so the Permissions page
  //     and the per-agent tool grid list every real tool with its policy chips
  //     (whiteboard, upstream additions, `mcp__<server>__<tool>` rows alike)
  //     and follow mounting/unmounting dynamically. Imported lazily so the
  //     @Remote decorator stays out of the unit-test import graph.
  void import('./rpc.ts').then((remote) => {
    try {
      remote.mountCapabilitiesRemote(ctx)
    } catch (error) {
      process.stderr.write(`[enpoi-capabilities] capabilities remote mount failed: ${String(error)}\n`)
    }
  }).catch(() => {})

  // 1. Invariant B1: Monotonic pre-dispatch tool execution guard. The session
  // level is authoritative (defaults ⊕ its overrides) and a server pulled into
  // that session's MCP world stays callable even when the master switch is off.
  const disposeGuard = ctx.tools.guard((exec) => {
    const guardSession = (exec.agent as { session?: { id?: string } } | undefined)?.session
    const decision = evaluateToolCall(
      exec.name,
      exec.arguments as Record<string, unknown> | undefined,
      effectiveStateFor(guardSession),
      readMcpCatalogDefs(),
      sessionMountsAccess?.world(guardSession),
    )
    if (!decision.allowed) {
      return decision.syntheticResult ?? `[CAPABILITY_DISABLED] Tool '${exec.name}' is disabled by operator preference.`
    }
    return undefined
  })
  ctx.effect(() => disposeGuard, 'enpoi-capabilities: tool guard')

  /**
   * Late-bound session-mount accessor: the mcp-client import block owns the
   * machinery, while the assemble filter and the pre-execute listener (both
   * registered synchronously) read it lazily.
   */
  let sessionMountsAccess: {
    catalog: () => Record<string, McpServerRecord>
    /** The master switch: global `capabilities.mcp[id] === true`. */
    masterEnabled: () => Set<string>
    /** The session's MCP world (`mcpWorldOf`); the default world without one. */
    world: (session: { id?: string } | undefined) => Set<string>
    /** The pre-execute denial for one tool name ('' when the call is allowed). */
    toolDenyReason: (session: { id: string }, toolName: string) => string
    list: (session: { id: string }, agentFacing: boolean) => McpMountRow[]
    mount: (session: { id: string }, id: string) => Promise<{ ok: boolean; reason: string; toolCount: number }>
    unmount: (session: { id: string }, id: string) => Promise<{ ok: boolean; reason: string }>
  } | undefined

  /** One session as the override service reads it. */
  interface OverrideSessionLike {
    id: string
    append: (type: string, data: unknown, options?: { ignorable?: boolean }) => void
  }

  /** In-memory fallback for sessions whose projection registry is absent. */
  const overrideMemory = new Map<string, CapabilityOverrideRecord>()

  /** The session's override record: the durable projection first, memory otherwise. */
  function readOverrides(session: OverrideSessionLike): CapabilityOverrideRecord {
    try {
      const projections = ctx.get('sessionProjections') as
        | { stateOf?: (session: unknown, key: string) => CapabilityOverrideRecord | undefined }
        | undefined
      const state = projections?.stateOf?.(session, 'capabilityOverrides')
      if (state !== undefined) return state
    } catch {
      // Fall through to the in-memory record.
    }
    return overrideMemory.get(session.id) ?? EMPTY_CAPABILITY_OVERRIDES
  }

  /** Persist the session's override record (durable event + memory mirror). */
  function setOverrides(session: OverrideSessionLike, next: CapabilityOverrideRecord): void {
    overrideMemory.set(session.id, next)
    try {
      session.append(CAPABILITY_OVERRIDES_EVENT, next, { ignorable: true })
    } catch (error) {
      process.stderr.write(`[enpoi-capabilities] capability overrides append failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  /**
   * Late-bound MCP pull/release for a session override write (assigned by the
   * mcp-client block): the center's "This session" switch on a switched-off
   * always-on server must mount it, and switching it off must release it.
   */
  let syncMcpOverride: ((session: OverrideSessionLike, id: string, value: boolean | null) => void) | undefined

  /** The session-scoped override service consumed by the RPC and the filters. */
  const capabilityOverridesService = {
    read: (session: OverrideSessionLike): CapabilityOverrideRecord => readOverrides(session),
    set: (session: OverrideSessionLike, kind: CapabilityOverrideKind, id: string, value: boolean | null): CapabilityOverrideRecord => {
      const next = withCapabilityOverride(readOverrides(session), kind, id, value)
      setOverrides(session, next)
      process.stderr.write(`[enpoi-capabilities] capability override: session ${session.id} ${kind}.${id}=${value === null ? 'default' : String(value)}\n`)
      if (kind === 'mcp') {
        try {
          syncMcpOverride?.(session, id, value)
        } catch (error) {
          process.stderr.write(`[enpoi-capabilities] mcp override sync failed: ${error instanceof Error ? error.message : String(error)}\n`)
        }
      }
      return next
    },
  }
  ctx.provide('capabilityOverrides', capabilityOverridesService)
  try {
    ;(ctx.get('sessionProjections') as { register?: (unit: unknown) => void } | undefined)?.register?.(capabilityOverridesProjection)
  } catch (error) {
    process.stderr.write(`[enpoi-capabilities] capability overrides projection registration failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }

  /** The effective capabilities state for one session (defaults ⊕ overrides). */
  function effectiveStateFor(session: { id?: string } | undefined): ReturnType<typeof initialCapabilitiesState> {
    const defaults = initialCapabilitiesState(getGlobalDefaults())
    if (session === undefined || typeof session.id !== 'string') return defaults
    return effectiveCapabilitiesState(defaults, readOverrides(session as OverrideSessionLike))
  }

  // 1b. Invariant B1b: Disabled tools are STRIPPED from the model-facing tool
  // schema entirely (zero token cost, no instruction-following risk). The
  // system-prompt/assemble waterfall carries the assembled tool list; we
  // filter out every disabled tool (minus the I15 protected set) so the model
  // never sees the schema, never attempts the call, and never wastes tokens.
  // 1c. Same surface, approval honesty: a tool whose effective policy resolves
  // `deny` can never run in ANY mode (denies terminate in resolvePolicy and are
  // never cardable), so it is absent from the advertised surface — never shown
  // and then refused. An `ask` stays visible: it is answerable by the human
  // card, by the parent for a forwarded child ask, or by the session's own
  // Full-access mode. The B1 guard stays as the execution-time backstop for
  // in-flight turns.
  // 1d. Same surface, prompt honesty: the wire list and the prompt TEXT stay in
  // lockstep — a section may only name a tool the final surface advertises
  // (the stale `job_output` guidance that burned a council debater four calls).
  const disposeAssemble = ctx.on('system-prompt/assemble', (async (_assembly: unknown, context: unknown, next: () => Promise<unknown>) => {
    const assembled = (await next()) as {
      tools?: Array<{ name: string }>
      sections?: Array<{ name: string; order: number; text: string; interpolate?: boolean }>
    }
    if (!Array.isArray(assembled.tools)) return assembled
    const scopeForCaps = (context as { scope?: { session?: { id?: string } } } | undefined)?.scope
    const state = effectiveStateFor(scopeForCaps?.session)
    const disabled = new Set(
      Object.entries(state.tools)
        .filter(([id, enabled]) => !enabled && !PROTECTED_CAPABILITIES.has(id))
        .map(([id]) => id),
    )
    let kept = disabled.size === 0 ? assembled.tools : assembled.tools.filter(tool => !disabled.has(tool.name))
    const scope = (context as { scope?: AgentLike & { session?: { id?: string } } } | undefined)?.scope
    // 1e. Approval-mode honesty, both directions (the corrected model,
    // 2026-09-28): a tool whose effective policy resolves `deny` can never run
    // — the executor hard-denies every call — so it is absent from every
    // advertised surface (hide, never show-then-refuse). An `ask` stays
    // visible because it is answerable: the human card, the forwarded child
    // path, or the session's own Full-access mode. The B1 guard stays as the
    // execution-time backstop for in-flight turns.
    const advertise = new Set(advertisedToolNames(kept.map(tool => tool.name), readApprovalPolicy(scope)?.policy, {
      agent: askingAgentOf({ agent: scope }),
      config: readPermissionConfig(),
      sandboxMode: readSandboxMode(scope),
      mcpServerNames: readMcpServerNames() ?? [],
    }))
    if (advertise.size < kept.length) kept = kept.filter(tool => advertise.has(tool.name))
    // 1f. MCP honesty: a server's tools are absent from a session unless the
    // server is in that session's MCP world — the default world (master-on
    // always-on) or a pull (skill `mcp:` hint, explicit mount, session switch).
    // A switched-off server the session has not pulled in is therefore absent
    // from its surface ("the agent doesn't even see it"). Model-visible ⟺ in
    // world ⟺ logged: the drop is announced once per surface signature.
    const scopeSession = (scope as { session?: { id?: string } } | undefined)?.session
    if (sessionMountsAccess !== undefined && scopeSession !== undefined && typeof scopeSession.id === 'string') {
      const world = sessionMountsAccess.world(scopeSession as { id: string })
      const hidden = new Set(
        Object.entries(sessionMountsAccess.catalog())
          .filter(([id]) => !world.has(id))
          .map(([id, def]) => serverNameOf(id, def)),
      )
      if (hidden.size > 0) {
        const before = kept.length
        kept = kept.filter(tool => {
          const server = mcpServerOfToolName(tool.name)
          return server === undefined || !hidden.has(server)
        })
        if (kept.length !== before) {
          const signature = `session=${scopeSession.id} hidden=[${[...hidden].join(',')}]`
          if (signature !== lastOnDemandSurfaceSignature) {
            lastOnDemandSurfaceSignature = signature
            process.stderr.write(`[enpoi-capabilities] mcp world surface: ${signature}\n`)
          }
        }
      }
    }
    // The mention dictionary is the whole registry, not the surviving list: a
    // section naming a REMOVED tool must be pruned too, and the removed name
    // only exists in the registry view.
    const vocabulary = new Set(ctx.tools.schemas().map(tool => tool.name))
    const advertised = new Set(kept.map(tool => tool.name))
    const sections = Array.isArray(assembled.sections)
      ? stripUnavailableToolGuidance(assembled.sections, advertised, vocabulary)
      : assembled.sections
    const toolsChanged = kept !== assembled.tools
    const sectionsChanged = sections !== undefined && sections !== assembled.sections
    if (!toolsChanged && !sectionsChanged) return assembled
    return { ...assembled, tools: kept, sections }
  }) as (...args: unknown[]) => unknown)
  ctx.effect(() => disposeAssemble, 'enpoi-capabilities: tool schema strip')

  // 2. MCP mounting (B5): capabilities.mcp[id]===true spawns a live mcp-client
  //     fiber for the server catalog entry (enpoi-orchestration.mcpServers) —
  //     its mcp__<server>__* tools register and are injected like native tools.
  //     false = the fiber is disposed and the tools vanish from the schema
  //     entirely (the model: "disabling = not injected at all"). The B1
  //     guard stays as the execution backstop for in-flight turns.
  import('@deepseek-ai/dsh-mcp-client').then(async (mcpClient) => {
    type Fiber = { dispose: () => Promise<void> } & PromiseLike<unknown>
    const mounted = new Map<string, Fiber>()
    const mountedPending = new Set<string>()
    /** Last mount failure per server id; surfaced through the status heartbeat. */
    const mountErrors = new Map<string, string>()
    /** Mount errors already pushed to `mcpStatus` (dedupe of the retry-triggering write). */
    const publishedMountErrors = new Map<string, string>()

    function getServerCatalog(): Record<string, OrchestrationMcpServer> {
      try {
        return documentValue(config.mcpServers, 'mcpServers') ?? {}
      } catch {
        return {}
      }
    }

    /**
     * Resolve an apiKeyEnv reference through the deployment credential
     * provider (process env + ~/.dsh/.credentials.yaml sources); values are
     * never logged.
     */
    async function resolveCredential(name: string | undefined): Promise<string | undefined> {
      if (!name) return undefined
      const seam = ctx.get('credentials') as
        | { resolve?: (ref: string) => Promise<{ value: string } | undefined> }
        | undefined
      if (seam?.resolve === undefined) return undefined
      try {
        const hit = await seam.resolve(name)
        return hit?.value
      } catch {
        return undefined
      }
    }

    /** Signature of the last logged sync: repeated settings pushes stay silent. */
    let lastSyncSignature: string | undefined

    /** One live session as the mount service reads it. */
    interface SessionLike {
      id: string
      append: (type: string, data: unknown, options?: { ignorable?: boolean }) => void
    }

    /** In-memory fallback for sessions whose projection registry is absent. */
    const sessionMounts = new Map<string, Set<string>>()

    /** The session's mounted set: the durable projection first, memory otherwise. */
    function mountedSetOf(session: SessionLike): Set<string> {
      try {
        const projections = ctx.get('sessionProjections') as
          | { stateOf?: (session: unknown, key: string) => { mounted?: readonly string[] } | undefined }
          | undefined
        const state = projections?.stateOf?.(session, 'mcpMounts')
        if (state !== undefined) return new Set(state.mounted ?? [])
      } catch {
        // Fall through to the in-memory set.
      }
      return new Set(sessionMounts.get(session.id) ?? [])
    }

    /** Persist the session's mounted set (durable event + memory mirror). */
    function setMounted(session: SessionLike, next: Set<string>): void {
      sessionMounts.set(session.id, next)
      try {
        session.append(MCP_MOUNTS_EVENT, { mounted: [...next] }, { ignorable: true })
      } catch (error) {
        process.stderr.write(`[enpoi-capabilities] mcp mounts append failed: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }

    /** Every session that currently has one server mounted (refcount for disposal). */
    function sessionsWithMount(id: string): number {
      let count = 0
      for (const set of sessionMounts.values()) if (set.has(id)) count += 1
      return count
    }

    /** Count the registered tools of one mounted namespace. */
    function toolCountOf(serverName: string): number {
      try {
        const schemas = (ctx.get('tools') as { schemas?: () => Array<{ name: string }> } | undefined)?.schemas?.() ?? []
        return schemas.filter(schema => mcpServerOfToolName(schema.name) === serverName).length
      } catch {
        return 0
      }
    }

    /**
     * Connect one server's global mcp-client fiber (shared by every session).
     * @param id - catalog server id.
     * @param failOnStartupError - true for an explicit on-demand mount (a failed
     *   initial connection must reject with its reason); false for the always-on
     *   sync (the supervisor keeps retrying in the background).
     */
    async function mountServer(id: string, failOnStartupError = false): Promise<{ ok: boolean; reason: string }> {
      if (mounted.has(id)) return { ok: true, reason: '' }
      if (mountedPending.has(id)) return { ok: false, reason: 'a mount is already in flight' }
      const def = getServerCatalog()[id]
      if (def === undefined) {
        process.stderr.write(`[enpoi-capabilities] mcp mount skipped: ${id} is not in the catalog\n`)
        return { ok: false, reason: `server "${id}" is not in the catalog` }
      }
      if (def.url === undefined || def.url === '') {
        process.stderr.write(`[enpoi-capabilities] mcp mount skipped: ${id} has no url\n`)
        return { ok: false, reason: `server "${id}" has no url configured` }
      }
      mountedPending.add(id)
      process.stderr.write(`[enpoi-capabilities] mcp mount starting: ${id} (${def.url})\n`)
      try {
        const apiKey = await resolveCredential(def.apiKeyEnv)
        const headers: Record<string, string> = { ...(def.headers ?? {}) }
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`
        const fiber = ctx.plugin(mcpClient.apply, {
          transport: 'streamable-http',
          serverName: serverNameOf(id, def),
          url: def.url,
          headers,
          toolCallTimeoutMs: def.toolCallTimeoutMs ?? 60_000,
          failOnStartupError,
        }) as unknown as Fiber
        await fiber
        mounted.set(id, fiber)
        mountErrors.delete(id)
        publishedMountErrors.delete(id)
        return { ok: true, reason: '' }
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
        const message = `${error instanceof Error ? error.message : String(error)}${cause}`
        mountErrors.set(id, message)
        process.stderr.write(`[enpoi-capabilities] mcp mount failed for ${id}: ${message}\n`)
        // Publish the failure once per message: the status write itself emits
        // `settings/updated`, which retries the mount, so an unguarded publish
        // would spin. A different message re-publishes; a successful mount clears it.
        if (publishedMountErrors.get(id) !== message) {
          publishedMountErrors.set(id, message)
          void probeAll().catch(() => {})
        }
        return { ok: false, reason: message }
      } finally {
        mountedPending.delete(id)
      }
    }

    /** Dispose one server's global fiber. */
    function disposeServer(id: string): void {
      const fiber = mounted.get(id)
      if (fiber === undefined) return
      mounted.delete(id)
      process.stderr.write(`[enpoi-capabilities] mcp dispose: ${id}\n`)
      void fiber.dispose().catch(() => {})
    }

    /** The master switch: the operator's global `capabilities.mcp[id] === true`. */
    function masterEnabledServers(): Set<string> {
      const state = initialCapabilitiesState(getGlobalDefaults())
      return new Set(Object.keys(getServerCatalog()).filter(id => state.mcp[id] === true))
    }

    /** The default world: every master-on always-on server (no session needed). */
    function defaultWorldServers(): Set<string> {
      return mcpDefaultWorldIds(getServerCatalog(), masterEnabledServers())
    }

    /**
     * The session's MCP world:
     * `(session mounts ∪ default-world always-on ∪ session override true) − session override false`.
     * The master switch sets the DEFAULT world; a pull (skill `mcp:` hint,
     * explicit mount, or the session switch) brings a switched-off server in
     * for this session, and a session-off override removes a default-world
     * server for this session only.
     */
    function worldOf(session: SessionLike | undefined): Set<string> {
      if (session === undefined || typeof session.id !== 'string') return defaultWorldServers()
      return mcpWorldOf(getServerCatalog(), masterEnabledServers(), mountedSetOf(session), readOverrides(session).mcp)
    }

    /** Pull one server into one session (connect on first use, then record it). */
    async function mountForSession(session: SessionLike, id: string): Promise<{ ok: boolean; reason: string; toolCount: number }> {
      const def = getServerCatalog()[id]
      if (def === undefined) return { ok: false, reason: `server "${id}" is not in the catalog`, toolCount: 0 }
      const outcome = await mountServer(id, true)
      if (!outcome.ok) return { ok: false, reason: outcome.reason, toolCount: 0 }
      // An explicit pull wins over a session-off switch that would filter it.
      const record = readOverrides(session)
      if (record.mcp[id] === false) setOverrides(session, withCapabilityOverride(record, 'mcp', id, null))
      const next = mountedSetOf(session)
      next.add(id)
      setMounted(session, next)
      const toolCount = toolCountOf(serverNameOf(id, def))
      process.stderr.write(`[enpoi-capabilities] mcp mount: session ${session.id} mounted ${id} (${String(toolCount)} tools)\n`)
      return { ok: true, reason: '', toolCount }
    }

    /**
     * Release one server from one session (durable mount and/or session-on
     * override). The shared fiber disconnects when the server is not in the
     * default world and no session holds it; a default-world server keeps it.
     */
    async function unmountForSession(session: SessionLike, id: string): Promise<{ ok: boolean; reason: string }> {
      const def = getServerCatalog()[id]
      if (def === undefined) return { ok: false, reason: `server "${id}" is not in the catalog` }
      const record = readOverrides(session)
      const next = mountedSetOf(session)
      const hadMount = next.delete(id)
      const hadOverride = record.mcp[id] === true
      if (!hadMount && !hadOverride) return { ok: false, reason: `server "${id}" is not mounted in this session` }
      if (hadMount) setMounted(session, next)
      if (hadOverride) setOverrides(session, withCapabilityOverride(record, 'mcp', id, null))
      if (hadMount && !defaultWorldServers().has(id) && sessionsWithMount(id) === 0) disposeServer(id)
      process.stderr.write(`[enpoi-capabilities] mcp unmount: session ${session.id} unmounted ${id}\n`)
      return { ok: true, reason: '' }
    }

    /**
     * The `mcp` rows for one session. `agentFacing` keeps only the
     * agent-visible ids: the session's world plus switched-on pullable
     * servers. The operator view (RPC) lists every configured server, with a
     * switched-off, unpulled one marked `disabled`.
     */
    function listMounts(session: SessionLike, agentFacing: boolean): McpMountRow[] {
      const catalog = getServerCatalog() as Record<string, McpServerRecord>
      const toolNames = (() => {
        try {
          return ((ctx.get('tools') as { schemas?: () => Array<{ name: string }> } | undefined)?.schemas?.() ?? []).map(schema => schema.name)
        } catch {
          return []
        }
      })()
      const master = masterEnabledServers()
      const world = worldOf(session)
      if (!agentFacing) return buildMountRows(catalog, master, world, new Set(mounted.keys()), mountErrors, toolNames)
      const include = mcpVisibleIds(catalog, master, world, readOverrides(session).mcp)
      return buildMountRows(catalog, master, world, new Set(mounted.keys()), mountErrors, toolNames, { include })
    }

    /** The session-scoped mount service consumed by the `mcp` tool, the skill hint, and the RPC. */
    const mcpMountsService = {
      // The operator/RPC view: every configured server, switched-off included.
      list: (session: SessionLike): McpMountRow[] => listMounts(session, false),
      mount: (session: SessionLike, id: string) => mountForSession(session, id),
      unmount: (session: SessionLike, id: string) => unmountForSession(session, id),
    }
    ctx.provide('mcpMounts', mcpMountsService)
    try {
      ;(ctx.get('sessionProjections') as { register?: (unit: unknown) => void } | undefined)?.register?.(mcpMountsProjection)
    } catch (error) {
      process.stderr.write(`[enpoi-capabilities] mcp mounts projection registration failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }

    // The center's session switch is authoritative too: mcp true = pull,
    // false/null = release (late-bound here so the override service can stay
    // above the mcp-client import).
    syncMcpOverride = (session: OverrideSessionLike, id: string, value: boolean | null): void => {
      const target = session as unknown as SessionLike
      if (value === true) {
        void mountForSession(target, id).catch((error: unknown) => {
          process.stderr.write(`[enpoi-capabilities] mcp override pull failed: ${error instanceof Error ? error.message : String(error)}\n`)
        })
      } else {
        void unmountForSession(target, id).catch((error: unknown) => {
          process.stderr.write(`[enpoi-capabilities] mcp override release failed: ${error instanceof Error ? error.message : String(error)}\n`)
        })
      }
    }

    /**
     * The pre-execute denial for one tool name ('' = callable): a switched-off
     * server not pulled into this session first, then an allowed on-demand
     * server the session has not mounted, then a default-world server switched
     * off for this session. Unknown servers stay with the policy ladder.
     */
    function toolDenyReason(session: SessionLike, toolName: string): string {
      return mcpToolDenyReason(getServerCatalog(), masterEnabledServers(), worldOf(session), toolName)
    }

    sessionMountsAccess = {
      catalog: getServerCatalog,
      masterEnabled: masterEnabledServers,
      world: (session: { id?: string } | undefined) => worldOf(session as SessionLike | undefined),
      toolDenyReason: (session: { id: string }, toolName: string) => toolDenyReason(session as SessionLike, toolName),
      list: (session: { id: string }, agentFacing: boolean) => listMounts(session as SessionLike, agentFacing),
      mount: (session: { id: string }, id: string) => mountForSession(session as SessionLike, id),
      unmount: (session: { id: string }, id: string) => unmountForSession(session as SessionLike, id),
    }

    // Session end tears the session's pulls down: the durable projection dies
    // with the session, and a server outside the default world that nobody
    // else holds disconnects.
    ctx.on('session/disposed', ((session: SessionLike) => {
      const set = sessionMounts.get(session.id)
      sessionMounts.delete(session.id)
      if (set === undefined || set.size === 0) return
      const defaults = defaultWorldServers()
      for (const id of set) {
        if (!defaults.has(id) && sessionsWithMount(id) === 0) disposeServer(id)
      }
      process.stderr.write(`[enpoi-capabilities] mcp teardown: session ${session.id} released [${[...set].join(',')}]\n`)
    }) as (...args: unknown[]) => unknown)

    // ── the `mcp` lifecycle tool ────────────────────────────────────────────
    // One tool, three actions. Permission row: shipped `allow` (see
    // SHIPPED_TOOL_DEFAULTS) — list is read-only, and mount/unmount only touch
    // servers the operator already configured, scoped to the calling session
    // and reversible (a pull of a switched-off server included: that is the
    // skill-requirement path). The mounted server's OWN tools keep their own
    // rows (unknownTools = ask), so the dangerous surface still asks.
    const MCP_TOOL_OUTPUT_SCHEMA = {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string' },
        server: { type: 'string' },
        ok: { type: 'boolean' },
        reason: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['action', 'server', 'ok', 'reason', 'text'],
    } as const

    /** Render one `mcp` tool value as model-facing text. */
    function renderMcpToolResult(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
      const run = value as { text: string }
      return [{ type: 'text', text: run.text }]
    }

    /** One `mcp list` line: mode, switch, mount state, reason, tool count. */
    function renderMountRow(row: McpMountRow): string {
      const gate = row.enabled ? 'enabled' : 'default-off'
      const detail = row.state === 'mounted'
        ? `mounted — ${String(row.toolCount)} tools`
        : row.state === 'available'
          ? `available — ${String(row.toolCount)} tools`
          : row.state === 'disabled'
            ? `disabled — ${row.reason}`
            : `unavailable — ${row.reason}`
      return `- ${row.id} [${row.mode}, ${gate}] ${detail}`
    }

    ctx.tools.register({
      name: 'mcp',
      description: [
        'Manage MCP servers for THIS session. The Capabilities switch sets the DEFAULT world: a switched-off server is absent from the agent surface and from "list" until something pulls it in (a skill\'s mcp: hint, "mount", or the operator\'s session switch).',
        'Actions:',
        '"list" shows the servers available to this session with their mode (always-on | on-demand), switch (enabled | default-off), mount state (mounted | available | unavailable), reason, and tool count;',
        '"mount" connects one server (a switched-off one too — the explicit pull is the point) and registers its tools for this session (they stay for continuing work);',
        "\"unmount\" releases this session's pull when the errand is done.",
        'Nothing auto-connects: a server that failed once stays down until explicitly mounted.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'mount', 'unmount'], description: 'The lifecycle action to perform.' },
          server: { type: 'string', description: 'Catalog server id (required for mount/unmount).' },
        },
        required: ['action'],
      },
      output: { schema: MCP_TOOL_OUTPUT_SCHEMA as never, render: renderMcpToolResult as never },
      isConcurrencySafe: () => false,
      async execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> {
        const request = (args ?? {}) as { action?: unknown; server?: unknown }
        const action = typeof request.action === 'string' ? request.action : ''
        const server = typeof request.server === 'string' ? request.server : ''
        const session = (exec as { agent?: { session?: SessionLike } }).agent?.session
        if (session === undefined) {
          return { action, server, ok: false, reason: 'mcp requires a live session', text: 'mcp requires a live session' }
        }
        if (action === 'list') {
          const rows = listMounts(session, true)
          const text = rows.length === 0
            ? 'no MCP servers are configured'
            : `mcp servers (session ${session.id}):\n${rows.map(renderMountRow).join('\n')}`
          return { action, server: '', ok: true, reason: '', text }
        }
        if (action === 'mount') {
          if (server === '') return { action, server, ok: false, reason: 'mount requires a server id', text: 'mount requires a server id' }
          const outcome = await mountForSession(session, server)
          const def = getServerCatalog()[server]
          const prefix = serverNameOf(server, def)
          const text = outcome.ok
            ? `mounted "${server}" for this session (${String(outcome.toolCount)} tools). Its tools are active immediately (e.g. mcp__${prefix}__*). Call "mcp unmount ${server}" when your task is complete.`
            : `could not mount "${server}": ${outcome.reason}`
          return { action, server, ok: outcome.ok, reason: outcome.reason, text }
        }
        if (action === 'unmount') {
          if (server === '') return { action, server, ok: false, reason: 'unmount requires a server id', text: 'unmount requires a server id' }
          const outcome = await unmountForSession(session, server)
          const def = getServerCatalog()[server]
          const prefix = serverNameOf(server, def)
          const text = outcome.ok
            ? `unmounted "${server}" for this session. Its tools (mcp__${prefix}__*) are deactivated immediately. Do NOT call any tools from "${server}" as they will be rejected.`
            : `could not unmount "${server}": ${outcome.reason}`
          return { action, server, ok: outcome.ok, reason: outcome.reason, text }
        }
        return { action, server, ok: false, reason: `unknown action "${action}"`, text: `unknown action "${action}"` }
      },
    })

    // ── skill hint: `mcp: [server]` frontmatter mounts on load ──────────────
    async function mountSkillHints(session: SessionLike, skillName: string, agent?: unknown): Promise<string[]> {
      let hints: string[] = []
      try {
        const skills = ctx.get('skills') as
          | { get?: (name: string, options: Record<string, unknown>) => Promise<{ mcp?: readonly string[] } | undefined> }
          | undefined
        const definition = await skills?.get?.(skillName, { scope: agent, cwd: session.header?.cwd })
        hints = Array.isArray(definition?.mcp) ? [...definition.mcp] : []
      } catch {
        return []
      }
      if (hints.length === 0) return []
      const notes: string[] = []
      for (const server of hints) {
        const outcome = await mountForSession(session, server)
        const def = getServerCatalog()[server]
        const prefix = serverNameOf(server, def)
        notes.push(outcome.ok
          ? `[mcp] Auto-mounted MCP server "${server}" (${String(outcome.toolCount)} tools) declared by skill "${skillName}". Its tools (e.g. mcp__${prefix}__*) are ready and callable immediately in this session. Unmount with "mcp unmount ${server}" when your task is complete.`
          : `[mcp] Could not mount MCP server "${server}" declared by skill "${skillName}": ${outcome.reason}`)
      }
      return notes
    }

    ctx.on('tools/post-execute', (async (
      exec: { name: string; arguments?: Record<string, unknown>; agent?: { session?: SessionLike } },
      _result: unknown,
      next: () => Promise<{ kind: string; additionalContexts?: unknown[] }>,
    ) => {
      const downstream = await next()
      if (exec.name !== 'skill' || downstream.kind !== 'accept') return downstream
      const session = exec.agent?.session
      const name = exec.arguments?.name
      if (session === undefined || typeof name !== 'string' || name === '') return downstream
      const notes = await mountSkillHints(session, name, exec.agent)
      if (notes.length === 0) return downstream
      // The skill tool re-renders its canonical value after post-execute, so a
      // content replacement would be discarded; the note rides as an injected
      // context message instead (model-visible, durable, and honest).
      return {
        ...downstream,
        additionalContexts: [
          ...(downstream.additionalContexts ?? []),
          createUserMessage({
            content: [{ type: 'text', text: notes.join('\n') }],
            source: { kind: 'mcp-mounts', form: 'notice', summary: `mcp mounts for ${name}` },
          }),
        ],
      }
    }) as (...args: unknown[]) => unknown)

    // ── skill hint: slash command `/<skill>` or `<skill_content>` mounts on turn start ──
    const SKILL_GESTURE = /(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
    const SKILL_CONTENT_TAG = /<skill_content\s+name=["']([^"']+)["']/g

    ctx.on('agent/pre-step', (async (
      params: { agent?: { session?: SessionLike }; messages?: Array<{ role?: string; source?: unknown; content?: Array<{ type?: string; text?: string }> }> },
      next: () => Promise<{ kind: string; messages?: Array<{ role?: string; source?: unknown; content?: Array<{ type?: string; text?: string }> }> }>,
    ) => {
      const decision = await next()
      if (decision?.kind !== 'enter' || !Array.isArray(decision?.messages)) return decision
      const session = params?.agent?.session
      if (session === undefined || typeof session.id !== 'string') return decision

      const skillNames = new Set<string>()
      // Check newly incoming messages for this step (slash command gestures)
      const incoming = Array.isArray(params?.messages) ? params.messages : []
      for (const msg of incoming) {
        const source = msg?.source as { kind?: string; name?: string } | undefined
        if (source?.kind === 'skill-invocation' && typeof source.name === 'string' && source.name !== '') {
          skillNames.add(source.name)
        }
        if (Array.isArray(msg?.content)) {
          for (const part of msg.content) {
            if (part?.type === 'text' && typeof part.text === 'string') {
              for (const m of part.text.matchAll(SKILL_CONTENT_TAG)) skillNames.add(m[1])
              if (msg?.role === 'user') {
                for (const m of part.text.matchAll(SKILL_GESTURE)) skillNames.add(m[1])
              }
            }
          }
        }
      }

      // Also check decision.messages for newly injected skill-invocation (from tool-skill pre-step)
      for (const msg of decision.messages) {
        const source = msg?.source as { kind?: string; name?: string } | undefined
        if (source?.kind === 'skill-invocation' && typeof source.name === 'string' && source.name !== '') {
          skillNames.add(source.name)
        }
      }

      if (skillNames.size === 0) return decision

      const allNotes: string[] = []
      for (const name of skillNames) {
        const notes = await mountSkillHints(session, name, params.agent)
        allNotes.push(...notes)
      }

      if (allNotes.length > 0) {
        decision.messages.push(createUserMessage({
          content: [{ type: 'text', text: allNotes.join('\n') }],
          source: { kind: 'mcp-mounts', form: 'notice', summary: 'mcp skill auto-mount' },
        }) as never)
      }

      return decision
    }) as (...args: unknown[]) => unknown)

    // ── doctrine: the mount lifecycle line ──────────────────────────────────
    ctx.systemPrompt.section({
      name: 'mcp:lifecycle',
      order: ctx.systemPrompt.getSectionOrder('MCP_SERVERS'),
      text: [
        '## MCP Tools & Lifecycle',
        '- On-Demand & Skills: MCP servers with tools (prefixed mcp__<server>__*) are default-off or on-demand. When you or the user invoke a skill with an `mcp: [server]` declaration (e.g. via `/skill-name` or the skill tool), the harness automatically mounts those servers on turn start. Their tools are active and callable immediately. You do NOT need to search files, glob, or read SKILL.md to investigate MCP servers for an invoked skill — they are already mounted and ready.',
        '- Explicit Mounting: If an unmounted server is needed for a task, call `mcp mount <server>` once, then use its tools. Use `mcp list` to see configured servers.',
        '- Clean Unmounting: When a one-shot errand is done, call `mcp unmount <server>` as your final cleanup step. For continuing multi-step work, leave it mounted.',
        '- Immediate Deactivation: Unmounting deactivates that server\'s tools immediately in the runtime. Once unmounted, never attempt to call its mcp__<server>__* tools; they will be rejected with CAPABILITY_DISABLED.',
        '- Tools vs Resources: Tools (mcp__<server>__*) are direct callable functions. The separate tools list_mcp_resources, list_mcp_resource_templates, and read_mcp_resource are solely for server documentation and resource templates.',
      ].join('\n'),
    })

    async function syncMcpMounts(): Promise<void> {
      const catalog = getServerCatalog()
      // The default world: master-on always-on servers. Everything else
      // connects only when a session pulls it (skill hint, explicit mount,
      // session switch).
      const defaults = defaultWorldServers()
      // A server that left the catalog no longer has a failure to report; drop
      // its error before publishing status. Errors of present servers stay
      // (they are also the reason a pulled server shows `unavailable`).
      for (const id of [...mountErrors.keys()]) {
        if (catalog[id] !== undefined) continue
        mountErrors.delete(id)
        publishedMountErrors.delete(id)
      }
      if (defaults.size > 0 || mounted.size > 0) {
        const signature = `default=[${[...defaults].join(',')}] mounted=[${[...mounted.keys()].join(',')}]`
        if (signature !== lastSyncSignature) {
          lastSyncSignature = signature
          process.stderr.write(`[enpoi-capabilities] mcp sync: ${signature}\n`)
        }
      }
      // Unmount removed servers, and servers outside the default world that no
      // session holds. A pulled switched-off server stays while a session
      // holds it (the pull is a session-scoped requirement).
      for (const id of [...mounted.keys()]) {
        const keep = defaults.has(id) || sessionsWithMount(id) > 0
        if (!keep) disposeServer(id)
      }
      // Mount newly enabled always-on servers.
      for (const id of defaults) {
        if (mounted.has(id) || mountedPending.has(id)) continue
        await mountServer(id)
      }
    }

    /**
     * Ensure a live session's pulls have fibers. A resumed session whose
     * durable mounts point at switched-off servers must reconnect them when
     * work continues; default-world servers are already handled by
     * `syncMcpMounts`.
     */
    async function reconcileSessionWorld(session: SessionLike): Promise<void> {
      const defaults = defaultWorldServers()
      for (const id of worldOf(session)) {
        if (defaults.has(id) || mounted.has(id) || mountedPending.has(id)) continue
        await mountServer(id)
      }
    }
    ctx.on('session/event', ((session: SessionLike, event: { type?: string }) => {
      if (event?.type !== 'turn/start' || typeof session?.id !== 'string') return
      void reconcileSessionWorld(session).catch((error: unknown) => {
        process.stderr.write(`[enpoi-capabilities] mcp reconcile failed: ${error instanceof Error ? error.message : String(error)}\n`)
      })
    }) as (...args: unknown[]) => unknown)

    void syncMcpMounts()
    ctx.setTimeout(() => void syncMcpMounts(), 3000)
    // Only a change to the toggle map warrants a re-sync: the heartbeat writes
    // mcpStatus into the same namespace, and reacting to that fed a loop.
    let lastSyncedToggleMap: string | undefined
    const onTogglesUpdated = ((ns: unknown) => {
      if (String(ns) !== 'enpoi-orchestration') return
      const toggleMap = JSON.stringify(initialCapabilitiesState(getGlobalDefaults()).mcp)
      if (toggleMap === lastSyncedToggleMap) return
      lastSyncedToggleMap = toggleMap
      void syncMcpMounts()
    }) as (...args: unknown[]) => unknown
    // The merged form service emits `settings/document-updated`; the pre-0.1.7
    // storage service emitted `settings/updated`. Both engines stay wired.
    ctx.on('settings/updated', onTogglesUpdated)
    ctx.on('settings/document-updated', onTogglesUpdated)

    // 2b. Reachability heartbeat (operator): liveness of each catalog server,
    //     INDEPENDENT of the enable toggle. green=mounted, blue=running but
    //     toggled off, grey=unreachable. Results land in
    //     enpoi-orchestration.mcpStatus so every client renders the same dots.
    interface McpStatusEntry { state: 'online' | 'down'; mounted: boolean; checkedAt: number; authError?: boolean; error?: string }
    let lastWrittenJson = ''

    /** One Streamable-HTTP liveness handshake; any HTTP response ⇒ online. */
    async function probeServer(id: string, def: { url?: string; headers?: Record<string, string>; apiKeyEnv?: string }): Promise<{ state: 'online' | 'down'; authError?: boolean }> {
      if (!def.url) return { state: 'down' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2500)
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(def.headers ?? {}),
        }
        const apiKey = await resolveCredential(def.apiKeyEnv)
        if (apiKey && !headers.Authorization) headers.Authorization = `Bearer ${apiKey}`
        // Minimal Streamable-HTTP liveness: a JSON-RPC initialize handshake.
        const res = await fetch(def.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'enpoi-capabilities-probe', version: '1.0.0' } } }),
          signal: controller.signal,
        })
        return { state: 'online', authError: res.status === 401 || res.status === 403 }
      } catch {
        return { state: 'down' }
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * The last heartbeat successfully published. `checkedAt` is carried over
     * when every other field of an entry is unchanged, so an idle heartbeat
     * serializes identically and the write (and the reconcile burst behind it)
     * is suppressed.
     */
    let lastWritten: Record<string, McpStatusEntry> = {}

    /** Whether one entry differs from its previous heartbeat in any field but `checkedAt`. */
    function sameStatus(previous: McpStatusEntry | undefined, next: McpStatusEntry): boolean {
      return previous !== undefined && previous.state === next.state && previous.mounted === next.mounted
        && previous.authError === next.authError && previous.error === next.error
    }

    async function probeAll(): Promise<void> {
      const catalog = getServerCatalog()
      const next: Record<string, McpStatusEntry> = {}
      for (const [id, def] of Object.entries(catalog)) {
        const isMounted = mounted.has(id) || mountedPending.has(id)
        if (isMounted) {
          const entry: McpStatusEntry = { state: 'online', mounted: true, checkedAt: Date.now() }
          const previous = lastWritten[id]
          next[id] = sameStatus(previous, entry) ? { ...entry, checkedAt: previous.checkedAt } : entry
          continue
        }
        const probe = await probeServer(id, def)
        const entry: McpStatusEntry = {
          state: probe.state,
          mounted: false,
          checkedAt: Date.now(),
          ...(probe.authError ? { authError: true } : {}),
          ...(mountErrors.has(id) ? { error: mountErrors.get(id) } : {}),
        }
        const previous = lastWritten[id]
        next[id] = sameStatus(previous, entry) ? { ...entry, checkedAt: previous.checkedAt } : entry
      }
      const json = JSON.stringify(next)
      if (json === lastWrittenJson) return
      lastWrittenJson = json
      lastWritten = next
      try {
        const settingsApi = ctx.get('settings') as unknown as { mutate?: (ns: unknown, ops: { op: string; path: string[]; value?: unknown }[]) => Promise<unknown> | undefined }
        void settingsApi.mutate?.(ORCH_NS, [{ op: 'set', path: ['mcpStatus'], value: next }])
      } catch {
        // non-fatal: status is advisory only
      }
    }

    ctx.setInterval(() => void probeAll().catch(() => {}), 15_000)
    ctx.setTimeout(() => void probeAll().catch(() => {}), 4_000)
  }).catch(() => {})

  // 3. Invariant B4: Disabled skills are stripped from the skill-catalog message
  //    before it reaches the model. The catalog listener (tool-skill) appends a
  //    user message with source.kind==='skill-catalog' containing the <available_skills>
  //    block. We register a later pre-step waterfall listener that finds that message
  //    and removes lines for disabled skills — zero injection, zero token cost.
  //    This approach is timing-agnostic (no provider race), rank-agnostic (no rank
  //    contest with the filesystem provider), and fully dynamic (reads settings at
  //    each turn). The guard (B1) remains the execution-time backstop.
  ctx.on('agent/pre-step', (async (params: { agent?: { session?: { id?: string } } }, next: (...args: unknown[]) => Promise<unknown>) => {
    const decision = (await next()) as {
      kind: string
      messages?: Array<{ source?: unknown; content?: unknown }>
    }
    if (decision.kind !== 'enter') return decision
    const messages = decision.messages
    if (!Array.isArray(messages)) return decision

    const state = effectiveStateFor(params?.agent?.session)
    // Key-driven: ANY skill disabled in settings (or overridden off in this
    // session) is stripped — including skills created on disk after this
    // plugin was written (OpenCode-parity dynamics).
    const disabledSkillIds = new Set(
      Object.entries(state.skills).filter(([, enabled]) => enabled === false).map(([id]) => id),
    )
    if (disabledSkillIds.size === 0) return decision

    const sessionId = params?.agent?.session?.id ?? ''
    const { messages: filtered } = filterSkillCatalogMessages(messages, disabledSkillIds, publishedCatalog, sessionId)
    return { ...decision, messages: filtered }
  }) as (...args: unknown[]) => unknown)

  // ── Permission policy engine (doc 55) ────────────────────────────────────
  // Fresh per dispatch; settings.yaml is the single source of truth. The
  // capability-disabled check runs HERE (not via the separate tools.guard):
  // the registry resolves serviceAsk BEFORE guardReason, so a disabled tool
  // with an ask policy would prompt first and deny after (Oracle amendment).
  // Grants short-circuit asks at the granularity the ask arose at; deny
  // always terminates; grants never upgrade a deny.

  /** Pending ask proposals by callId — consumed by allow-always grant writes. */
  const pendingGrants = new Map<string, GrantProposal>()

  function readPermissionConfig(): PermissionPolicyConfig {
    try {
      return documentValue(config.permissions, 'permissions') ?? {}
    } catch {
      return {}
    }
  }

  /** The operator's per-seat execution deny overrides (`seatToolDeny`), fresh per dispatch. */
  function readSeatToolDeny(): Record<string, string[]> {
    try {
      return documentValue(config.seatToolDeny, 'seatToolDeny') ?? {}
    } catch {
      return {}
    }
  }

  /**
   * The live MCP catalog (`enpoi-orchestration.mcpServers`) as id → descriptor.
   * `undefined` = settings unreadable; `{}` = no catalog entries. The
   * capability-disabled check maps a tool-name server segment back to its
   * catalog id — the key `capabilities.mcp[...]` is written under.
   */
  function readMcpCatalogDefs(): Record<string, OrchestrationMcpServer> | undefined {
    try {
      const catalog = documentValue(config.mcpServers, 'mcpServers')
      // A namespace without a readable catalog (mid-reload / unregistered) is
      // NOT an empty catalog: treating it as one would prune every live row.
      if (catalog === undefined || catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) return undefined
      return catalog
    } catch {
      return undefined
    }
  }

  /**
   * Mounted MCP server names of the live catalog (`serverName ?? id minus
   * '-mcp'` — the naming the MCP mount and the client's permission grouping
   * both use). `undefined` = settings unreadable; `[]` = no catalog entries.
   */
  function readMcpServerNames(): string[] | undefined {
    const catalog = readMcpCatalogDefs()
    return catalog === undefined ? undefined : Object.entries(catalog).map(([id, def]) => mcpServerNameOf(id, def))
  }

  /** The session's current agent preset, through the projection registry. */
  function currentPresetOf(session: unknown): string | undefined {
    try {
      const projections = ctx.get('sessionProjections') as { stateOf?: (session: unknown, key: string) => unknown } | undefined
      const value = projections?.stateOf?.(session, 'agentPreset')
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  /** The asking agent's role id for one live exec (session header/projection). */
  function askingAgentOf(exec: { agent?: AgentLike }): string | undefined {
    return agentRoleOf(exec.agent, currentPresetOf)
  }

  function readSandboxMode(agent: { session?: unknown } | undefined): string | undefined {
    try {
      const session = agent?.session as {
        seq?: number
        eventAt?: (seq: number) => { type?: string; data?: Record<string, unknown> } | undefined
      } | undefined
      if (session === undefined || typeof session.eventAt !== 'function') return undefined
      const seq = typeof session.seq === 'number' ? session.seq : 0
      for (let index = seq - 1; index >= 0; index -= 1) {
        const event = session.eventAt(index)
        if (event?.type === 'sandbox/mode') return String((event.data as { mode?: string } | undefined)?.mode ?? '')
      }
      const shell = ctx.get('shell') as { sandboxMode?: string } | undefined
      return shell?.sandboxMode
    } catch {
      return undefined
    }
  }

  /**
   * The asking session's pinned approval policy from its log (`approval/policy`,
   * the last one wins) with the delegation marker. Child-agent delegation pins
   * `'never'`, which makes every ask reject deterministically before any card
   * can appear — the registry then reports that rejection as a user rejection.
   */
  function readApprovalPolicy(agent: { session?: unknown } | undefined): { policy: string; delegated: boolean } | undefined {
    try {
      const session = agent?.session as {
        seq?: number
        eventAt?: (seq: number) => { type?: string; data?: { policy?: unknown; source?: unknown } } | undefined
      } | undefined
      if (session === undefined || typeof session.eventAt !== 'function') return undefined
      const seq = typeof session.seq === 'number' ? session.seq : 0
      for (let index = seq - 1; index >= 0; index -= 1) {
        const event = session.eventAt(index)
        if (event?.type === 'approval/policy') {
          return { policy: String(event.data?.policy ?? ''), delegated: event.data?.source === 'delegation' }
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  // ── forwarded child approvals (doc 82 §E7, doc 55 extension) ────────────────
  // A delegated child's approval policy is pinned `never`, so its asks used to
  // dead-end. The forwarder resolves them through the nearest live ROOT session:
  // rails first, then a session-scoped grant, then the root's mode — Full access
  // applies one bounded parent judgement in the operator's place (doc 82 item 8),
  // every other mode keeps the existing human card. See forwarding.ts.

  /** Live Agent slice the root walk reads (structural `ctx.get('agents')`). */
  interface LiveAgentLike {
    id?: string
    session?: {
      header?: { id?: string; parentSession?: string; cwd?: string; delegationDepth?: number; origin?: string }
      ownEvents?: () => readonly { type?: string; data?: { label?: unknown; persona?: unknown } }[]
    }
  }

  /** Walk the live parent chain to the nearest root Agent (bounded at 32 hops). */
  function liveRootOf(childSessionId: string): RootHandle | undefined {
    const agents = ctx.get('agents') as { get?: (id: string) => LiveAgentLike | undefined } | undefined
    if (agents?.get === undefined) return undefined
    let current = agents.get(childSessionId)
    for (let hop = 0; hop < 33; hop += 1) {
      if (current === undefined) return undefined
      const header = current.session?.header
      const parentSession = header?.parentSession
      if (parentSession === undefined || parentSession === '') {
        const id = typeof header?.id === 'string' && header.id !== '' ? header.id : (current.id ?? '')
        if (id === '') return undefined
        const cwd = typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
        return { id, agent: current, ...cwd !== undefined ? { cwd } : {} }
      }
      current = agents.get(String(parentSession))
    }
    return undefined
  }

  /**
   * The root's effective mode for a forwarded ask: Full access / no restrictions
   * (sandbox `danger-full-access` + approval `never`) applies one bounded parent
   * judgement in the operator's place (doc 82 item 8); approval `never` without
   * full access is unattended (no card possible); everything else is interactive.
   */
  function rootModeOf(root: RootHandle): RootMode | undefined {
    const agent = root.agent as AgentLike
    if (agent?.session === undefined) return undefined
    const sandbox = readSandboxMode(agent) ?? 'workspace-write'
    const approval = readApprovalPolicy(agent)?.policy
      ?? (ctx.get('approval') as { config?: { policy?: string } } | undefined)?.config?.policy
      ?? 'ask'
    if (approval !== 'never') return 'interactive'
    return sandbox === 'danger-full-access' ? 'full-access' : 'unattended'
  }

  /**
   * The parent's own effective-policy ceiling for one rail class. The boundary
   * ceiling is the root's sandbox scope; every other rail runs the same policy
   * ladder under the root's role, so the operator's own deny rules and explicit
   * allows decide. An ask or deny there means the child's card stays closed.
   */
  function parentAllowsRail(query: ParentRailQuery): boolean {
    const agent = query.root.agent as AgentLike
    if (query.rail === 'boundary') return readSandboxMode(agent) === 'danger-full-access'
    const decision = resolvePolicy({
      toolName: query.toolName,
      ...query.command !== undefined ? { command: query.command } : {},
      agent: askingAgentOf({ agent }),
      reviewer: false,
      config: readPermissionConfig(),
      sandboxMode: readSandboxMode(agent),
      mcpServerNames: readMcpServerNames() ?? [],
    })
    return decision.kind === 'allow'
  }

  /**
   * Dispatch one forwarded ask as the existing approval card on the root agent.
   * No `callId`: the parent session has no correlated tool call, so the card
   * renders without tool detail and the child's own log keeps the call identity.
   */
  function requestRootApproval(query: RootAskQuery): Promise<ApprovalOutcome> {
    const approval = ctx.get('approval') as {
      request?: (request: Record<string, unknown>) => Promise<ApprovalOutcome>
    } | undefined
    if (approval?.request === undefined) {
      return Promise.reject(new Error('the approval service is not composed'))
    }
    return approval.request({
      agent: query.root.agent,
      toolName: query.toolName,
      reason: query.reason,
      displayReason: query.displayReason,
      // The card renders this as its own highlighted line; it is presentation
      // only and can never answer the ask (the outcome comes from the human).
      ...query.recommendation !== undefined ? { recommendation: query.recommendation } : {},
      ...query.broadAllow !== undefined ? { broadAllow: query.broadAllow } : {},
      ...query.signal !== undefined ? { signal: query.signal } : {},
    })
  }

  /**
   * ONE bounded root-side recommendation for a forwarded ask: the root
   * session's default model answers a single JSON question over the same
   * one-shot seam family as the keeper/oracle calls (`llm.stream` + a tight
   * deadline). Every miss returns undefined (the forwarder keeps its derived
   * line): no `llm`, no default-model selection, provider error, timeout, cut,
   * or unparseable output. On the card the answer is advisory presentation
   * only; in Full access (no card) the forwarder APPLIES the suggestion as the
   * parent's judgement, and `query.applied` tells the prompt so.
   */
  async function forwardedRecommendation(query: RecommendationQuery): Promise<ModelRecommendation | undefined> {
    const llm = ctx.get('llm') as {
      stream?: (options: GenerateOptions) => AsyncIterable<StreamChunk>
    } | undefined
    if (llm?.stream === undefined) return undefined
    const selection = (ctx.get('agentDefaultModel') as {
      currentSelection?: () => { provider?: unknown; model?: unknown }
    } | undefined)?.currentSelection?.()
    const provider = selection?.provider
    const model = selection?.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      ctx.logger.debug?.('enpoi-capabilities: no default model selection; forwarded ask keeps the derived recommendation')
      return undefined
    }
    return await requestRecommendation(
      {
        toolName: query.toolName,
        ...query.args !== undefined ? { args: query.args } : {},
        origin: query.origin,
        workspaceRelation: query.workspaceRelation,
        ...query.rail !== undefined ? { rail: query.rail } : {},
        decision: query.decision,
        ...query.applied === true ? { applied: true } : {},
      },
      {
        stream: options => llm.stream!(options),
        provider,
        model,
        timeoutMs: RECOMMENDATION_TIMEOUT_MS,
        // One observable line per miss (this harness's logger drops debug);
        // the derived line is kept either way, so the card never suffers.
        onMiss: reason => process.stderr.write(
          `[enpoi-capabilities] recommendation miss (${provider}/${model}): ${reason}\n`,
        ),
        ...query.signal !== undefined ? { signal: query.signal } : {},
      },
    )
  }

  // Per-turn judgement budget (Full access, doc 82 item 8): the forwarder caps
  // how many parent judgements one root turn may spend. `turn/start` bumps the
  // root session's turn identity; the forwarder resets its budget on the bump.
  // The same event drives the idle-parent park failsafe (doc 04 §6, doc 11):
  // asks parked while the root sat between turns replay here, in FIFO order,
  // under the root's policy at that moment.
  const rootTurns = new Map<string, number>()
  const approvalParks = createApprovalParkJournal()

  const approvalForwarding = new ChildApprovalForwarder({
    findRoot: liveRootOf,
    modeOf: rootModeOf,
    parentAllowsRail,
    askRoot: requestRootApproval,
    recommendation: forwardedRecommendation,
    turnOf: (root: RootHandle) => String(rootTurns.get(root.id) ?? 0),
    isRootIdle: (root: RootHandle) => {
      const agent = root.agent as { session?: Parameters<typeof hasOpenTurn>[0] | undefined } | undefined
      return agent?.session === undefined ? false : !hasOpenTurn(agent.session)
    },
    parkJournal: approvalParks,
    report: (line: string) => process.stderr.write(`[enpoi-capabilities] ${line}\n`),
    depthCap: () => {
      const subagents = ctx.get('subagents') as { resolveMaxDepth?: (configured?: unknown) => number | undefined } | undefined
      const depth = subagents?.resolveMaxDepth?.()
      return typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 0 ? depth : 1
    },
  })
  ctx.effect(() => {
    const disposeTurn = ctx.on('session/event', ((session: { id?: string }, event: { type?: string }) => {
      if (typeof session?.id !== 'string' || session.id === '') return undefined
      if (event?.type === 'turn/start') {
        rootTurns.set(session.id, (rootTurns.get(session.id) ?? 0) + 1)
        // The root returned: replay every ask parked while it sat between turns.
        approvalForwarding.replayParked(session.id)
      }
      return undefined
    }) as never)
    const disposeDisposed = ctx.on('session/disposed', ((session: { id?: string }) => {
      if (typeof session?.id !== 'string') return
      rootTurns.delete(session.id)
      // A parked ask must not outlive the child or root session it belongs to.
      approvalForwarding.releaseSession(session.id, 'the session ended before the ask was resolved')
    }) as never)
    return () => {
      disposeTurn()
      disposeDisposed()
      // Plugin disposal releases every parked child with a corrective denial.
      approvalForwarding.dispose()
    }
  }, 'enpoi-capabilities: forwarded-ask turn budget + park replay')
  // Finality seam (doc 55): the core tool registry's ask path reads
  // `forwardedApprovals` so an outer ask or a reviewer denial cannot re-open a
  // call a forwarded child ask already allowed. Keyed by the requester's
  // session and the child's call identity; process-local, like the grants.
  ctx.provide('forwardedApprovals', forwardedApprovalsSeam(approvalForwarding))

  const disposePolicy = ctx.on('tools/pre-execute', (async (exec: { name: string; arguments?: Record<string, unknown>; callId?: string | number; agent?: AgentLike; signal?: AbortSignal }, next: () => Promise<{ kind: string; reason?: string }>) => {
    // Capability-disabled check FIRST (Oracle 1.2): the registry runs serviceAsk
    // before guardReason, so a disabled tool with an ask policy would otherwise
    // prompt and then deny after the user clicks allow. A server PULLED into
    // this session's MCP world (skill hint, explicit mount, session switch) is
    // allowed through even when the master switch is off.
    const capSession = (exec.agent as { session?: { id?: string } } | undefined)?.session
    const state = effectiveStateFor(capSession)
    const capabilityDecision = evaluateToolCall(exec.name, exec.arguments, state, readMcpCatalogDefs(), sessionMountsAccess?.world(capSession))
    if (!capabilityDecision.allowed) {
      return { kind: 'deny', reason: capabilityDecision.syntheticResult ?? `[CAPABILITY_DISABLED] Tool '${exec.name}' is disabled by operator preference.` }
    }
    // Per-seat execution restriction: the canonical main-agent compositions
    // mount the same tool rows (prompt-prefix cache neutrality forbids
    // per-agent tool ABSENCE), so a seat that must not run a tool is denied
    // HERE while the tool stays advertised. Denial is final: the model reads
    // the reason and the alternative seat.
    const agentRole = askingAgentOf(exec)
    const seatDeny = seatToolDenyFor(agentRole, readSeatToolDeny())
    if (seatDeny.includes(exec.name)) {
      return {
        kind: 'deny',
        reason: `${exec.name} is restricted to the creator seat; seat "${agentRole ?? 'unknown'}" may not run it. Switch to the creator agent for harness authoring.`,
      }
    }
    // MCP enable/scope gate: a tool of a DISABLED server is denied first (the
    // master gate), then a tool of an allowed on-demand server this session
    // has not mounted (the surface filter is the first line; this is the
    // backstop for in-flight turns and direct calls).
    const execSession = (exec.agent as { session?: { id?: string } } | undefined)?.session
    if (sessionMountsAccess !== undefined && execSession !== undefined && typeof execSession.id === 'string') {
      const mcpDenial = sessionMountsAccess.toolDenyReason(execSession as { id: string }, exec.name)
      if (mcpDenial !== '') return { kind: 'deny', reason: mcpDenial }
    }
    const config = readPermissionConfig()
    const isBash = exec.name === 'bash'
    // Custom tools (enpoi-custom-tools): the rendered command enters the SAME
    // evaluator bash uses, so dangerous verbs/wrappers/interpreters ask or deny
    // exactly as they would for bash. The seam is optional: without the plugin
    // the tool name alone resolves through the matrix/defaults.
    const customCommand = !isBash && exec.name.startsWith('custom_')
      ? (ctx.get('customToolCommands') as { render?: (name: string, args: unknown) => { command?: string } | undefined } | undefined)
        ?.render?.(exec.name, exec.arguments)?.command
      : undefined
    // A delegated child is identified once per call: its policy resolution
    // must not consume a config standing grant, because the ask has to reach
    // the parent-forwarding path (rails, parent policy, or card) rather than
    // run silently on a grant the main session recorded.
    const delegated = delegatedChildOf(exec.agent as ChildAgentLike | undefined)
    const decision = resolvePolicy({
      toolName: exec.name,
      command: isBash && typeof exec.arguments?.command === 'string' ? exec.arguments.command : undefined,
      ...customCommand === undefined ? {} : { customCommand },
      agent: agentRole,
      // A delegated child carries the PARENT's preset, so reviewer seats are
      // identified from the child's own subagent descriptor, not the role id.
      // Computed only for the gated tool: the descriptor scan is unnecessary
      // work for every other call.
      reviewer: exec.name === REVIEW_RUN_TOOL ? reviewerSeatOf(exec.agent, currentPresetOf) : false,
      delegated: delegated !== undefined,
      config,
      sandboxMode: readSandboxMode(exec.agent),
      mcpServerNames: readMcpServerNames() ?? [],
    })
    if (decision.kind === 'allow') return await next()
    if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
    // A session with approval prompts disabled (delegation pins 'never') cannot
    // answer this ask itself. A delegated child's ask is forwarded through the
    // parent (below); any other such session denies here, naming the real actor
    // (the session's approval policy) and the ask reason, so the model and the
    // transcript show why the call could never run.
    const approvalPolicy = readApprovalPolicy(exec.agent)
    if (approvalPolicy?.policy === 'never') {
      // A delegated child is not dead-ended any more: forward the ask through
      // the parent's existing machinery. The child suspends on this await and a
      // rejection returns as its corrective tool error; rails and standing
      // consent are decided in forwarding.ts, never here.
      if (delegated !== undefined) {
        const resolution = await approvalForwarding.forward({
          agent: exec.agent as ChildAgentLike | undefined,
          toolName: exec.name,
          args: exec.arguments,
          decision,
          ...exec.callId !== undefined ? { callId: exec.callId } : {},
          ...exec.signal !== undefined ? { signal: exec.signal } : {},
        })
        if (resolution.kind === 'deny') return { kind: 'deny', reason: resolution.reason }
        // The forwarded decision is approval, not the whole gate: downstream
        // pre-execute layers (tool groups, mutation capture) still run. A
        // downstream ask cannot be satisfied from a child's `never` session, so
        // it fails closed rather than dead-ending in the approval service —
        // UNLESS this exact call is already final: the forwarded ask answered
        // it, so a downstream layer re-asking (e.g. the Auto reviewer denying
        // after the human approved) cannot re-open it.
        const downstream = await next()
        if (downstream.kind === 'ask') {
          if (exec.callId !== undefined
            && approvalForwarding.resolvesFinalCall(delegated.childSessionId, String(exec.callId), exec.name)) {
            return { kind: 'allow', reason: 'the forwarded parent decision is final for this call' }
          }
          return { kind: 'deny', reason: `a downstream policy layer requires approval for ${exec.name}, which a delegated child's forwarded ask cannot satisfy` }
        }
        return downstream
      }
      // Full access (the corrected model, 2026-09-28): a MAIN/root
      // session's mode — approval prompts disabled + the danger-full-access
      // sandbox — IS the operator's standing consent. Every ask-policy call
      // resolves allow with the mode named and an audit line: no card, no
      // denial, rails included (rails are a child-forwarding concern; a root
      // call is the operator's own). A delegated child never reaches this
      // branch (checked above), so the parent-judgement path is untouched.
      if (isFullAccessMode(approvalPolicy.policy, readSandboxMode(exec.agent))) {
        process.stderr.write(
          `[enpoi-capabilities] audit: allowed ${exec.name} for the main session in Full access mode `
          + `(ask source: ${decision.source}) — the mode is the operator's standing consent\n`,
        )
        // Downstream pre-execute layers still run; an explicit downstream deny
        // (e.g. a tool the operator disabled) stands, but no layer may card
        // here — Full access never asks.
        const downstream = await next()
        if (downstream.kind === 'deny') return downstream
        return { kind: 'allow', reason: FULL_ACCESS_ASK_REASON }
      }
      return {
        kind: 'deny',
        reason: `${exec.name} was denied automatically: this ${approvalPolicy.delegated ? 'delegated subagent' : 'session'} runs with approval prompts disabled, so the approval policy denied it without asking a user. It required approval because: ${decision.reason}.`,
      }
    }
    // ask: stash the grant proposal for the host-side allow-always writer.
    if (typeof exec.callId === 'string' && pendingGrants.size < 128) {
      const grantCommand = isBash
        ? String(exec.arguments?.command)
        : customCommand
      pendingGrants.set(String(exec.callId), grantProposalFor(decision, exec.name, grantCommand, askingAgentOf(exec)))
    }
    return {
      kind: 'ask',
      reason: decision.reason,
      // The danger-list broad action travels with the ask so the card can label
      // it ("allow all rm"); the decision itself stays a closed outcome.
      ...decision.broadAllow !== undefined ? { broadAllow: decision.broadAllow } : {},
    }
  }) as (...args: unknown[]) => unknown)
  ctx.effect(() => disposePolicy, 'enpoi-capabilities: permission policy pre-execute')

  // ── bash search nudge (doc 80 follow-up) ───────────────────────────────────
  // One advisory line when a search-leading bash command runs in a turn that
  // has not used grep/glob yet; never a deny, once per turn (search-nudge.ts).
  installSearchNudge(ctx)

  // ── reviewer-exec: the dedicated read-only test-run tool ───────────────────
  // Reviewer/oracle seats run under the `never` approval policy (delegation
  // pins it), where an ask is an automatic denial. `review_run` is their
  // read-only execution path: a fixed runner enum rooted at the workspace
  // under a forced read-only sandbox policy, never the general bash surface.
  installReviewRunTool(ctx)

  // Host-side allow-always persistence (Oracle amendment 2): the card only
  // answers; the host observes the decided outcome and writes the standing
  // grant into settings under the file lock — no client-side read-modify-write.
  async function persistGrant(proposal: GrantProposal): Promise<void> {
    const id = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const grant: StandingGrant = standingGrantRecord(id, proposal, new Date().toISOString())
    const settings = ctx.get('settings') as {
      describe?: () => Array<{ ns: string; revision?: number }>
      mutate?: (ns: string, ops: Array<{ op: string; path: string[]; value?: unknown }>, expectedRevision?: number) => Promise<unknown>
    } | undefined
    if (settings?.mutate === undefined) {
      process.stderr.write('[enpoi-capabilities] grant persistence failed: settings service unavailable\n')
      return
    }
    // The grants map is written as a whole leaf value, so the write is fenced
    // with the namespace revision and re-applied onto the fresh map on a
    // conflict (another writer won the race); the operator's grant is never
    // silently dropped and never clobbers a concurrent grant.
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = settings.describe?.().find((entry: { ns: string; revision?: number }) => entry.ns === ORCH_NS)?.revision
      const existing = readPermissionConfig().grants ?? {}
      const next = { ...existing, [id]: grant }
      try {
        await settings.mutate(ORCH_NS, [{ op: 'set', path: ['permissions', 'grants'], value: next }], revision)
        process.stderr.write(`[enpoi-capabilities] standing grant persisted: ${grant.tool}${grant.pattern ? ` ${grant.pattern}` : ''}${grant.agent ? ` (agent ${grant.agent})` : ''}\n`)
        return
      } catch (error) {
        const conflict = error as { code?: string }
        if (conflict?.code === 'SETTINGS_CONFLICT' && attempt < 2) continue
        process.stderr.write(`[enpoi-capabilities] grant persistence failed: ${String(error)}\n`)
        return
      }
    }
  }

  // A server that leaves the catalog (or is renamed) would otherwise leave
  // its policy rows behind forever — inert but accumulating. Observe catalog
  // shrink and unset every row of a server that is gone, under the same
  // revision fence as the grant writer. The baseline is seeded at boot; a
  // server already absent then is not treated as a removal (its rows may be
  // operator-prepared rules).
  let lastMcpServerNames = readMcpServerNames()
  const onCatalogUpdated = ((ns: unknown) => {
    if (String(ns) !== ORCH_NS) return
    const names = readMcpServerNames()
    if (names === undefined) return
    const previous = lastMcpServerNames
    lastMcpServerNames = names
    if (previous === undefined) return
    const current = new Set(names)
    const removed = [...new Set(previous.filter(name => !current.has(name)))]
    if (removed.length === 0) return
    const settings = ctx.get('settings') as McpCatalogSettings | undefined
    void pruneRemovedMcpPolicyRows(settings, removed, readPermissionConfig)
      .then((count) => {
        if (count > 0) process.stderr.write(`[enpoi-capabilities] removed MCP policy rows: ${count} row(s) for ${removed.join(', ')}\n`)
      })
      .catch((error: unknown) => {
        process.stderr.write(`[enpoi-capabilities] removed MCP policy cleanup failed: ${String(error)}\n`)
      })
  }) as (...args: unknown[]) => unknown
  ctx.effect(() => {
    const disposeUpdated = ctx.on('settings/updated', onCatalogUpdated)
    const disposeDocumentUpdated = ctx.on('settings/document-updated', onCatalogUpdated)
    return () => {
      disposeUpdated()
      disposeDocumentUpdated()
    }
  }, 'enpoi-capabilities: removed-MCP policy cleanup')

  const disposeGrantWatch = ctx.on('session/event', ((session: { id?: string; eventAt?: (seq: number) => { type: string; data?: Record<string, unknown>; seq?: number } | undefined; seq?: number }, event: { type: string; seq?: number; data?: Record<string, unknown> }) => {
    if (event?.type !== 'approval/decided') return undefined
    const outcome = event.data?.outcome
    // `allowed-always` is the default action (exact-command pin for the danger
    // list); `allowed-always-broad` is the card's separate explicit action
    // (rule-level pin, "allow all rm").
    if (outcome !== 'allowed-always' && outcome !== 'allowed-always-broad') return undefined
    const approvalId = (event.data as { id?: string }).id
    if (approvalId === undefined) return undefined
    // The decided event carries the APPROVAL id; the paired asked event carries
    // the exec callId our pending-proposal map is keyed by. Pair them by scan.
    let callId: string | undefined
    let forwarded = false
    if (typeof session?.eventAt === 'function') {
      for (let seq = (event.seq ?? session.seq ?? 0); seq >= 0 && seq >= (event.seq ?? 0) - 64; seq -= 1) {
        const e = session.eventAt(seq)
        if (e?.type === 'approval/asked' && (e.data as { id?: string }).id === approvalId) {
          const reason = (e.data as { reason?: string }).reason
          if (typeof reason === 'string' && reason.includes(FORWARDED_ASK_MARKER)) forwarded = true
          const c = (e.data as { callId?: string }).callId
          if (c !== undefined) callId = String(c)
          break
        }
      }
    }
    // A forwarded child ask never writes a global grant: its answer is scoped to
    // the requester's session by the forwarder itself (forwarding.ts).
    if (forwarded) return undefined
    if (callId === undefined) {
      // Fallback: pop the oldest pending proposal (single-approval flows).
      callId = [...pendingGrants.keys()][0]
    }
    if (callId === undefined) return undefined
    const proposal = pendingGrants.get(callId)
    pendingGrants.delete(callId)
    if (proposal !== undefined) void persistGrant(
      grantProposalForOutcome(proposal, outcome === 'allowed-always-broad'),
    ).catch((error: unknown) => {
      process.stderr.write(`[enpoi-capabilities] grant persistence failed: ${String(error)}\n`)
    })
    return undefined
  }) as (...args: unknown[]) => unknown)
  ctx.effect(() => disposeGrantWatch, 'enpoi-capabilities: allow-always grant writer')
}

export type { CapabilitiesState, CapabilityDescriptor, CapabilityKind } from './types'
export { KNOWN_CAPABILITIES, PROTECTED_CAPABILITIES } from './types'
export { initialCapabilitiesState } from './state'
export { evaluateToolCall } from './enforcement'
