/**
 * dsh-enpoi-debug — the `session_debug` agent tool (doc 69 §9.1).
 *
 * One read-only call the orchestrator/sysadmin agents use to understand a
 * Session at a glance: the execution latch, current model, pending asks, the
 * last turn terminal with its structured error, bounded recent tool traffic,
 * the injection index, the subagent tree, the main-model request summary, and
 * optionally the diagnostics incident tail.
 *
 * Guarantees:
 * - Read-only: no session-log writes, no prompts, no host mutations.
 * - Never raw request bodies unless `includeBodies: true` (heavy, secret-bearing)
 *   AND the local operator grants `allowed-once` on an approval card.
 * - Bounded: hard caps and previews in `fold.ts`, roughly at or under 4k tokens.
 * - Errors keep the gateway's code (`session/not-found`, `gateway/bad-request`, …).
 * - Incidents come from the diagnostics service through the same in-process
 *   seam the `diagnostics.list` RPC wraps; a missing diagnostics service
 *   degrades only that section.
 *
 * @module dsh-enpoi-debug/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { errorFacts, clampRecentTools, foldDigest, foldIncidents, foldSnapshot } from './fold.js'
import { resolveSessionSources } from './source.js'
import type { DebugSources } from './types.js'

/** Registered tool name. */
export const SESSION_DEBUG_TOOL_NAME = 'session_debug'

/** Exact reason shown on the local approval card before any body is read. */
export const INCLUDE_BODIES_REASON = 'session_debug includeBodies exposes the raw system prompt and message bodies'

/** Injectable seams for tests. */
export interface SessionDebugToolOptions {
  /** Resolve the read surface; defaults to the live context resolution. */
  readonly resolve?: () => DebugSources | undefined
  /** Log tag for the registration proof. */
  readonly log?: (message: string) => void
}

const INCLUDE_SECTIONS = ['digest', 'snapshot', 'incidents'] as const
type IncludeSection = typeof INCLUDE_SECTIONS[number]

const DESCRIPTION = [
  'Read one Session\'s debug/transparency surface (doc 69 §9.1): execution latch, current model, pending asks,',
  'the last turn end with its structured error, bounded recent tool calls with previews, the injection index, the',
  'subagent tree, the main-model request summary, and (optionally) the diagnostics incident tail. Read-only — it',
  'never prompts, mutates, or writes the session log. Omit sessionId to inspect the calling session itself; pass',
  'one only to inspect another Session, which must be attached (otherwise session/not-found). Bodies are excluded',
  'unless includeBodies:true is passed explicitly AND the local operator grants allowed-once on the resulting',
  'approval card; that flag is HEAVY and secret-bearing (full system prompt, tool schemas, message text).',
].join(' ')

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    sessionId: { type: 'string' },
    include: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    error: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: { code: { type: 'string' }, message: { type: 'string' } },
          required: ['code', 'message'],
        },
      ],
    },
    digest: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    snapshot: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
    incidents: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: true }] },
  },
  required: ['ok', 'sessionId', 'include', 'notes', 'error', 'digest', 'snapshot', 'incidents'],
} satisfies import('@deepseek-ai/dsh-tools').JsonSchemaNode

/**
 * Parse the tool arguments at the boundary.
 * @param args - raw model-supplied arguments.
 * @returns the normalized request; `sessionId` is undefined when the model
 *   omitted it, which the caller resolves to the calling Session.
 * @throws {Error} with `code: 'gateway/bad-request'` for malformed input.
 */
export function parseSessionDebugArgs(args: unknown): {
  readonly sessionId: string | undefined
  readonly include: readonly IncludeSection[]
  readonly recentTools: number
  readonly includeBodies: boolean
} {
  const request = (args ?? {}) as Record<string, unknown>
  const rawSessionId = request.sessionId
  const sessionId = typeof rawSessionId === 'string' && rawSessionId.trim() !== '' ? rawSessionId.trim() : undefined
  if (rawSessionId !== undefined && sessionId === undefined) {
    const error = new Error('session_debug: sessionId must be a non-empty string when provided') as Error & { code?: string }
    error.code = 'gateway/bad-request'
    throw error
  }
  const requested = Array.isArray(request.include)
    ? request.include.filter((entry): entry is IncludeSection => (INCLUDE_SECTIONS as readonly string[]).includes(entry))
    : []
  return {
    sessionId,
    include: requested.length > 0 ? requested : ['digest'],
    recentTools: clampRecentTools(request.recentTools),
    includeBodies: request.includeBodies === true,
  }
}

/**
 * Ask the operator, through the local approval service, before any raw body is
 * read. Shipped-allow is not a human decision: fail closed on every outcome
 * other than `allowed-once` (missing service, no agent, no open turn, refusal,
 * cancellation, or timeout).
 * @param ctx - context that may provide `approval`.
 * @param exec - the running `session_debug` call (agent, call id, signal).
 * @returns the approval outcome, or `'unavailable'` when no human could decide.
 */
async function approveIncludeBodies(ctx: Context, exec: ToolRunContext | undefined): Promise<ApprovalOutcome> {
  if (exec?.agent === undefined) return 'unavailable'
  const approval = ctx.get('approval')
  if (approval === undefined) return 'unavailable'
  try {
    return await approval.request({
      agent: exec.agent,
      toolName: SESSION_DEBUG_TOOL_NAME,
      ...(exec.callId === undefined ? {} : { callId: exec.callId }),
      reason: INCLUDE_BODIES_REASON,
      signal: exec.signal,
    })
  } catch {
    // No open turn, no answerer, or a withdrawn ask: the bodies stay unread.
    return 'unavailable'
  }
}

/**
 * The calling Agent's own Session id — the default when the model omits
 * `sessionId`. The executing Agent always carries the live Session it drives;
 * `Agent.id` is the same SessionId on the lightweight identity face.
 * @param exec - the running `session_debug` call, when the registry supplied one.
 * @returns the caller's Session id, or undefined when no Agent was attached.
 */
function callerSessionId(exec: ToolRunContext | undefined): string | undefined {
  const agent = exec?.agent
  if (agent === undefined) return undefined
  const sessionId = agent.session?.id ?? agent.id
  return sessionId === undefined ? undefined : String(sessionId)
}

/**
 * Register the `session_debug` tool on one tools scope.
 *
 * The preset mounts this plugin inside the agent-plane group, so the tool
 * registers into that agent's own tools layer — it is visible only to the
 * presets that name it, never to every agent in the process.
 *
 * @param ctx - context that provides `tools` (the preset mount scope).
 * @param options - resolve seam and logging hook (tests).
 */
export function registerSessionDebugTool(ctx: Context, options: SessionDebugToolOptions = {}): void {
  const resolve = options.resolve ?? (() => resolveSessionSources(ctx))
  ctx.tools.register({
    name: SESSION_DEBUG_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Durable Session identity to inspect. Omit to inspect the calling session (this Agent\'s own Session); a provided id must name an attached Session or the call returns session/not-found.' },
        include: {
          type: 'array',
          items: { type: 'string', enum: [...INCLUDE_SECTIONS] },
          description: 'Sections to read; default [\'digest\']. `snapshot` is the main-model request summary (bodies only with includeBodies + operator approval). `incidents` is the diagnostics tail.',
        },
        recentTools: { type: 'number', description: 'Recent tool calls to include (1..50, default 10).' },
        includeBodies: {
          type: 'boolean',
          description: 'HEAVY + SECRET-BEARING: also return the captured system prompt, tool schemas, and message bodies. Requires an explicit allowed-once approval from the local operator (anything else refuses the bodies). Only pass this when the raw request must be inspected; never echo credentials from it.',
        },
      },
      // sessionId is optional: omission means "the calling session".
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderSessionDebug(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: unknown, exec?: ToolRunContext): Promise<unknown> {
      let request: ReturnType<typeof parseSessionDebugArgs>
      try {
        request = parseSessionDebugArgs(args)
      } catch (error) {
        const facts = errorFacts(error)
        return {
          ok: false,
          sessionId: typeof (args as { sessionId?: unknown } | undefined)?.sessionId === 'string' ? String((args as { sessionId?: unknown }).sessionId) : '',
          include: [],
          notes: [],
          error: facts,
          digest: null,
          snapshot: null,
          incidents: null,
        }
      }
      // An omitted sessionId means "this session": resolve the caller from the
      // same exec/agent seam the includeBodies approval uses.
      const sessionId = request.sessionId ?? callerSessionId(exec)
      if (sessionId === undefined) {
        return {
          ok: false,
          sessionId: '',
          include: request.include,
          notes: [],
          error: { code: 'gateway/bad-request', message: 'session_debug: sessionId was omitted and the calling Agent has no Session' },
          digest: null,
          snapshot: null,
          incidents: null,
        }
      }
      try {
        const sources = resolve()
        if (sources === undefined) {
          return {
            ok: false,
            sessionId,
            include: request.include,
            notes: ['no session read surface is present in this process'],
            error: { code: 'debug/unavailable', message: 'sessionController/remote.session with digest+requestSnapshot is unavailable' },
            digest: null,
            snapshot: null,
            incidents: null,
          }
        }
        const notes: string[] = []
        const digest = request.include.includes('digest')
          ? foldDigest(await sources.digest({ sessionId, recentTools: request.recentTools }))
          : null
        let snapshot: Readonly<Record<string, unknown>> | null = null
        if (request.include.includes('snapshot')) {
          let includeBodies = request.includeBodies
          if (includeBodies) {
            // An agent's `allow` is not a human decision: the raw system prompt
            // and message bodies stay unread unless the operator grants once.
            const outcome = await approveIncludeBodies(ctx, exec)
            if (outcome === 'allowed-once') {
              notes.push('includeBodies=true: the secret-bearing request bodies are included below; never echo credentials from them.')
            } else {
              includeBodies = false
              notes.push(`includeBodies refused (${outcome}): the raw system prompt and message bodies were not read or returned; the summary below excludes them.`)
            }
          } else {
            notes.push('snapshot bodies excluded (pass includeBodies:true explicitly to read them).')
          }
          snapshot = foldSnapshot(await sources.requestSnapshot({ sessionId, includeBodies }), includeBodies)
        }
        let incidents: Readonly<Record<string, unknown>> | null = null
        if (request.include.includes('incidents')) {
          if (sources.incidents === undefined) notes.push('diagnostics service unavailable: incidents excluded.')
          else incidents = foldIncidents(await sources.incidents(25), sessionId)
        }
        return { ok: true, sessionId, include: request.include, notes, error: null, digest, snapshot, incidents }
      } catch (error) {
        return {
          ok: false,
          sessionId,
          include: request.include,
          notes: [],
          error: errorFacts(error),
          digest: null,
          snapshot: null,
          incidents: null,
        }
      }
    },
  })
}

/** Render the bounded result as compact text for the model. */
export function renderSessionDebug(value: unknown): string {
  const result = value as {
    ok?: boolean
    sessionId?: string
    include?: readonly string[]
    notes?: readonly string[]
    error?: { code: string; message: string } | null
    digest?: Record<string, unknown> | null
    snapshot?: Record<string, unknown> | null
    incidents?: Record<string, unknown> | null
  }
  if (result.ok !== true) {
    return `session_debug FAILED ${result.error?.code ?? 'unknown'}: ${result.error?.message ?? 'no detail'}`
  }
  const lines: string[] = [`session_debug ${result.sessionId} (${(result.include ?? []).join(', ')})`]
  const digest = result.digest
  if (digest !== null && digest !== undefined) {
    const model = digest.model as { provider?: string; model?: string } | null
    lines.push(`  latch=${String(digest.latch)} since=${String(digest.since)} descendants=${String(digest.activeDescendants)}${digest.descendantsExact === false ? ' (inexact)' : ''}${model == null ? '' : ` model=${model.provider ?? '?'}/${model.model ?? '?'}`}`)
    const last = digest.lastTurnEnd as { turn?: number; reason?: string; error?: { code: string; message: string } } | null
    if (last !== null && last !== undefined) {
      lines.push(`  last turn end: turn ${String(last.turn)} ${String(last.reason)}${last.error === undefined ? '' : ` — ${last.error.code}: ${last.error.message}`}`)
    }
    const asks = (digest.pendingInteractions ?? []) as readonly Record<string, unknown>[]
    lines.push(`  pending asks (${String(digest.pendingAskCount ?? asks.length)})`)
    for (const ask of asks) {
      lines.push(ask.kind === 'approval'
        ? `    · approval ${String(ask.askId)} tool=${String(ask.toolName)}${ask.reason === undefined ? '' : ` reason="${String(ask.reason)}"`}`
        : `    · question ${String(ask.askId)}`)
    }
    const failures = (digest.recentFailures ?? []) as readonly Record<string, unknown>[]
    if (failures.length > 0) {
      lines.push(`  recent failures (${String(digest.recentFailureCount ?? failures.length)})`)
      for (const failure of failures) {
        lines.push(`    · ${String(failure.provider)}/${String(failure.model)} ${String(failure.code)}: ${String(failure.message)}${failure.next === undefined ? '' : ` → next ${String(failure.next)}`}`)
      }
    }
    const calls = (digest.recentToolCalls ?? []) as readonly Record<string, unknown>[]
    lines.push(`  recent tools (${String(digest.recentToolCallCount ?? calls.length)})`)
    for (const call of calls) {
      const error = call.error as { name: string; code: string } | undefined
      lines.push(`    · ${String(call.status)} ${String(call.tool)}${error === undefined ? '' : ` — ${error.name}:${error.code}`}`)
    }
    const injections = (digest.injectionIndex ?? []) as readonly Record<string, unknown>[]
    lines.push(`  injections (${String(digest.injectionCount ?? injections.length)}): ${injections.map(entry => String(entry.kind)).join(', ')}`)
    const tree = (digest.subagentTree ?? []) as readonly Record<string, unknown>[]
    lines.push(`  subagents (${String(digest.subagentCount ?? tree.length)})`)
    for (const child of tree) {
      lines.push(`    · ${String(child.childSessionId)} mode=${String(child.mode)} quiet=${String(child.quiet)} status=${String(child.status)}`)
    }
  }
  const snapshot = result.snapshot
  if (snapshot !== null && snapshot !== undefined) {
    lines.push(`  request: ${String(snapshot.provider)}/${String(snapshot.model)} tools=${String(snapshot.toolCount)} messages=${String(snapshot.messageCount)} (${String(snapshot.messageChars)} chars) bodies=${String(snapshot.bodiesIncluded)}`)
  }
  const incidents = result.incidents
  if (incidents !== null && incidents !== undefined) {
    lines.push(`  incidents (${String(incidents.sessionMatches ?? 0)} for this session / ${String(incidents.total ?? 0)} total)`)
    for (const item of (incidents.items ?? []) as readonly Record<string, unknown>[]) {
      lines.push(`    · [${String(item.severity)}] ${String(item.code)} — ${String(item.message)}`)
    }
  }
  for (const note of result.notes ?? []) lines.push(`  note: ${note}`)
  return lines.join('\n')
}
