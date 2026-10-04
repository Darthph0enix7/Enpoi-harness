/**
 * Council fiber lifecycle — ported from the pre-redesign engine and
 * generalized to seats (doc 54). Preserves the five anti-leak measures:
 *   - dual-level quiet (spec.quiet + request.quiet)  [c4726c2ad8]
 *   - send_message denied                             [335ffa7]
 *   - text-only extraction (no reasoning blocks)      [3b15d87]
 *   - I12 route pinning via personas at spawn
 *   - unconditional deny list (unknown names are no-ops)
 *
 * Evidence fencing (doc 54 §6): DEBATER fibers deny all retrieval tools —
 * their only ingress to facts is the NEED_EVIDENCE text protocol serviced by
 * the broker. BROKER children (explorer/librarian role) keep the research
 * surface and deny everything else.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, Session, SessionId } from '@deepseek-ai/dsh-agent'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { getBriefService } from 'dsh-enpoi-context-keeper'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const LOG_FILE = path.join(os.homedir(), '.dsh', 'logs', 'enpoi-council.log')
export function councilDiag(msg: string) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

/** Bounded wait for the demand-driven Living Brief before council start. */
export const BRIEF_WAIT_MS = 4_000

export async function ensureBriefWithin(parent: Agent, signal: AbortSignal, waitMs = BRIEF_WAIT_MS): Promise<void> {
  const brief = getBriefService()
  if (brief === null || brief === undefined) return
  const pending = brief.ensureFreshBrief(parent.session, signal).catch((error: unknown) => {
    councilDiag(`brief wait degraded: ${String(error)}`)
    return null
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs) })
  try {
    await Promise.race([pending.then(() => undefined), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (signal.aborted) throw signal.reason ?? new Error('aborted')
}

/** Extract the final report text from message blocks (reasoning excluded). */
export function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content !== null && typeof content === 'object') {
    if ('message' in content && typeof (content as { message: unknown }).message === 'object') {
      const inner = (content as { message: { content?: unknown } }).message?.content
      if (inner !== undefined) return textOfContent(inner)
    }
    if ('text' in content && typeof (content as { text: unknown }).text === 'string') {
      return (content as { text: string }).text
    }
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object') {
          const blockType = (part as { type?: unknown }).type
          if ((blockType === 'text' || blockType === undefined)
            && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
            return (part as { text: string }).text
          }
        }
        return ''
      })
      .filter((t) => t.length > 0)
      .join('\n')
  }
  return ''
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// Base deny list for EVERY council fiber (anti-leak). Passed UNCONDITIONALLY —
// the fork's tools.restrict() skips unknown deny names safely.
// NOTE: `run_code` is deliberately absent — the PTC transport is reserved and
// naming it in a filter throws (doc 52).
export const COUNCIL_DENIED_TOOLS = [
  'send_message',
  'oracle_review', 'dispatch_task', 'subagent', 'subagent_fork', 'subagent_codex',
  'subagent_claude_code', 'edit', 'write', 'str_replace_editor',
  'plan_mode', 'goal', 'roundtable', 'chorus',
  'memory_save', 'memory_rescind', 'memory_confirm',
  'workflow', 'ralph',
  'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode',
  'job_output', 'job_list', 'job_kill',
  'skill', 'ask_user_question',
  // Councils cannot register sub-councils (amendment #10)
  'council_register',
  // Read-only registry listing is an operator surface, not a seat surface.
  'council_list',
  // Seats request evidence through the epoch broker (NEED_EVIDENCE), not the
  // synchronous request_evidence tool — one evidence ingress per seat.
  'request_evidence',
  // Harness authoring is the creator seat's own surface, and reviewer-exec is
  // a reviewer-seat capability: a council child inherits its parent's preset
  // (the pre-execute seat guard refuses the trio to every orchestrator/
  // sysadmin parent) and the capabilities advertise filter already strips
  // `review_run` from every council catalog because the agent role is the
  // parent preset. Naming all four here keeps the seat catalog honest even
  // when a seat label resolves to a seat-restricted tool group or a future
  // advertise pass turns reviewer-aware; a council seat's protocol is
  // deliberation, not workspace test execution.
  'plugin_manager',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'review_run',
]

// Evidence fencing: deliberation seats additionally lose ALL retrieval tools.
// Their only ingress to facts is the NEED_EVIDENCE protocol (doc 54 §6,
// Oracle amendment #2 — no DECLARED_READ loophole).
export const RETRIEVAL_TOOLS = ['read', 'glob', 'grep', 'read_image', 'web_search'] as const

/**
 * Tools every council fiber keeps regardless of fencing tier: the pinned
 * whiteboard. Seats are fenced off retrieval and mutation, but the board is
 * shared deliberation context — one seat records a finding the others read —
 * so it is subtracted from every deny composition (debaters, referee, broker,
 * registered-council denies) and survives the seat hand-off.
 */
export const COUNCIL_KEPT_TOOLS = [
  'whiteboard_read', 'whiteboard_write', 'whiteboard_pin', 'whiteboard_unpin',
] as const

const isKeptTool = (name: string): boolean => (COUNCIL_KEPT_TOOLS as readonly string[]).includes(name)

// Deliberation tier (seats, referee, chair) additionally loses ALL retrieval
// tools AND `bash`. The operator-observed failure (2026-09-27): a referee
// emitted its JSON through a `cat <<JSON` bash heredoc — the fiber result
// capture reads assistant text only, so the pass was silently lost — and a
// chair spent ~3 minutes shelling around for a ledger that never existed.
// Neither role has any legitimate shell need; their only fact ingress is the
// NEED_EVIDENCE broker. The broker tier keeps the research surface.
export const DEBATER_DENIED_TOOLS = [...COUNCIL_DENIED_TOOLS, ...RETRIEVAL_TOOLS, 'bash'].filter(name => !isKeptTool(name))

/**
 * The deny list for one fiber: the base list plus every REGISTERED council's
 * tool id (settings-registered councils included), so a seat can never invoke
 * another council — the static list can only name the built-ins.
 * @param registeredCouncilTools - council ids that expose a tool right now.
 * @returns the deny names passed to the subagent toolFilter.
 */
export function councilDenyList(registeredCouncilTools: readonly string[]): string[] {
  return [...new Set([...DEBATER_DENIED_TOOLS, ...registeredCouncilTools.filter(id => id !== 'roundtable' && id !== 'chorus')])]
    .filter(name => !isKeptTool(name))
}

// The BROKER child keeps the research surface (it is the errand boy's door).
export const BROKER_KEPT_TOOLS = [...RETRIEVAL_TOOLS]

export interface PersonaModelConfig {
  provider: string
  model: string
  reasoningEffort?: string
}

/** One resolved chain snapshot as the `modelChains` service answers it (doc 60). */
interface ChainSnapshotLink {
  provider: string
  model: string
  effort?: string
}

interface ChainSnapshot {
  id: string
  links: ChainSnapshotLink[]
  attempts?: number
  onCut?: 'failover' | 'continue'
}

/**
 * Resolve a model-chain snapshot through the `modelChains` service (provided
 * by dsh-enpoi-model-chains). Fail-open: a missing service, an unknown or
 * disabled id, a malformed payload, or any read error answers `undefined` and
 * the caller keeps its single-model behaviour.
 */
function resolveChainSnapshot(ctx: Context, id: unknown): ChainSnapshot | undefined {
  if (typeof id !== 'string' || id.trim() === '') return undefined
  try {
    const service = ctx.get('modelChains') as { resolve?: (id: string) => unknown } | undefined
    const snapshot = service?.resolve?.(id.trim())
    if (snapshot === null || typeof snapshot !== 'object') return undefined
    const record = snapshot as { id?: unknown; links?: unknown; attempts?: unknown; onCut?: unknown }
    if (!Array.isArray(record.links)) return undefined
    const links: ChainSnapshotLink[] = []
    for (const raw of record.links) {
      if (raw === null || typeof raw !== 'object') continue
      const link = raw as { provider?: unknown; model?: unknown; effort?: unknown }
      const provider = typeof link.provider === 'string' ? link.provider.trim() : ''
      const model = typeof link.model === 'string' ? link.model.trim() : ''
      if (provider === '' || model === '') continue
      const effort = typeof link.effort === 'string' && link.effort.trim() !== '' ? link.effort.trim() : undefined
      links.push({ provider, model, ...(effort !== undefined ? { effort } : {}) })
    }
    if (links.length === 0) return undefined
    const attempts = typeof record.attempts === 'number' && Number.isFinite(record.attempts) && record.attempts >= 1
      ? Math.floor(record.attempts)
      : undefined
    return {
      id: typeof record.id === 'string' && record.id !== '' ? record.id : id.trim(),
      links,
      ...(attempts !== undefined ? { attempts } : {}),
      onCut: record.onCut === 'continue' ? 'continue' : 'failover',
    }
  } catch {
    return undefined
  }
}

/** A seat's chain assignment: frozen ordered links plus the cut policy. */
export interface PersonaChainConfig {
  id: string
  links: PersonaModelConfig[]
  onCut: 'failover' | 'continue'
  /**
   * Whether the persona's ACTIVE link is the chain's head, so the fork's
   * `AgentOptions.chain` can be carried without its link resolution overriding
   * the seat's own first route (it starts at the request's named link).
   */
  carryId: boolean
}

/**
 * Resolve a persona's model chain (doc 60) into an ordered link list.
 *
 * `personas[seat].chain` names the chain; the persona's provider/model (when
 * present) is the ACTIVE link and the chain's remaining links follow in order.
 * The returned list is a detached snapshot: callers keep it for the whole
 * seat/run and never re-read settings between attempts. `chain` link `effort`
 * maps onto the existing `reasoningEffort` field so spawns stay unchanged.
 * @param ctx - owning plugin context.
 * @param persona - seat/persona id.
 * @returns the chain snapshot, or undefined (no chain/dangling/disabled/fail-open).
 */
export function resolvePersonaChain(ctx: Context, persona: string): PersonaChainConfig | undefined {
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const key = persona.toLowerCase().replace(/^the\s+/, '').trim()
    const entry = (doc?.personas as Record<string, { provider?: string; model?: string; reasoningEffort?: string; chain?: string } | null> | undefined)?.[key]
    const snapshot = resolveChainSnapshot(ctx, entry?.chain)
    if (snapshot === undefined) return undefined
    const toModel = (link: ChainSnapshotLink): PersonaModelConfig => ({
      provider: link.provider,
      model: link.model,
      ...(link.effort !== undefined ? { reasoningEffort: link.effort } : {}),
    })
    const active: PersonaModelConfig = entry !== undefined && entry.provider && entry.model
      ? {
          provider: entry.provider,
          model: entry.model,
          ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
        }
      : toModel(snapshot.links[0]!)
    const links: PersonaModelConfig[] = [
      active,
      ...snapshot.links.map(toModel).filter(link => !(link.provider === active.provider && link.model === active.model)),
    ]
    const head = snapshot.links[0]!
    return {
      id: snapshot.id,
      links,
      onCut: snapshot.onCut ?? 'failover',
      carryId: head.provider === active.provider && head.model === active.model,
    }
  } catch (err: unknown) {
    councilDiag(`resolvePersonaChain error for ${persona}: ${String(err)}`)
    return undefined
  }
}

export function resolvePersonaModel(ctx: Context, persona: string): PersonaModelConfig | undefined {
  try {
    const doc = readOrchestrationDocument(ctx.get('settings') as SettingsDocumentReader | undefined)
    const key = persona.toLowerCase().replace(/^the\s+/, '').trim()
    const entry = (doc?.personas as Record<string, { provider?: string; model?: string; reasoningEffort?: string } | null> | undefined)?.[key]
    if (entry && entry.provider && entry.model) {
      return {
        provider: entry.provider,
        model: entry.model,
        ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
      }
    }
  } catch (err: unknown) {
    councilDiag(`resolvePersonaModel error for ${persona}: ${String(err)}`)
  }
  return undefined
}

export function applyPersonaModel(ctx: Context, childId: string, persona: string): void {
  try {
    const entry = resolvePersonaModel(ctx, persona)
    if (entry && entry.provider && entry.model) {
      const sessions = ctx.get('sessions') as { get?: (id: string) => Session } | undefined
      const childSession = sessions?.get?.(childId)
      if (childSession && typeof childSession.append === 'function') {
        childSession.append('request/header', {
          header: {
            config: {
              provider: entry.provider,
              model: entry.model,
              ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
            },
          },
          reason: 'custom',
        })
        councilDiag(`Applied persona model header for ${persona}: ${entry.provider}/${entry.model}`)
      }
    }
  } catch (err: unknown) {
    councilDiag(`applyPersonaModel warning for ${persona}: ${String(err)}`)
  }
}

export interface SeatFiber {
  seatId: string
  label: string
  childId: string
  isOffline: boolean
  totalTokens: number
}

/**
 * Spawn one quiet continuable fiber for a council seat.
 * `denyTools` selects the fencing tier (debater vs broker).
 */
export async function startSeatFiber(
  ctx: Context,
  parent: Agent,
  opts: {
    seatId: string
    label: string
    persona: string
    initialPrompt: string
    denyTools: readonly string[]
    /**
     * Explicit link override for chain-aware seats (doc 60). Absent = resolve
     * the persona assignment as before; present = spawn on exactly this link.
     */
    model?: PersonaModelConfig
    /**
     * Chain id carried on `AgentOptions.chain` (the fork's field) so the
     * child's own step retries can escalate pre-commit failures. Only passed
     * when the spawned link is the chain head.
     */
    chainId?: string
  },
  signal: AbortSignal,
): Promise<SeatFiber> {
  const personaModel = opts.model ?? resolvePersonaModel(ctx, opts.seatId)
  const started = await ctx.subagents.startContinuable({
    provider: 'spawn',
    label: opts.label,
    quiet: true,
    request: {
      prompt: [{ type: 'text', text: opts.initialPrompt }],
      parent,
      persona: opts.persona,
      quiet: true,
      toolFilter: opts.denyTools.length > 0 ? { deny: [...opts.denyTools] } : undefined,
      ...(personaModel !== undefined ? {
        agentOptions: {
          provider: personaModel.provider,
          model: personaModel.model,
          ...(opts.chainId !== undefined ? { chain: opts.chainId } : {}),
        },
      } : {}),
    },
    signal,
  })
  if (!started.childId || started.childId === 'null' || !String(started.childId).includes('-')) {
    throw new Error(`council seat spawn returned an invalid child id for ${opts.seatId}: ${String(started.childId)}`)
  }
  // Model routing happens at spawn via agentOptions — no extra request/header
  // is appended (a second header duplicated the "System prompt" chip in the
  // trajectory and wrote a reason value the session validator rejects).
  return { seatId: opts.seatId, label: opts.label, childId: started.childId, isOffline: false, totalTokens: 0 }
}

/** Follow-up turn on an existing seat fiber; bounded so a stuck lock fails loud. */
export async function followupSeatFiber(
  ctx: Context,
  parent: Agent,
  fiber: SeatFiber,
  promptText: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      queueHostSubagentPrompt(
        ctx.subagents,
        parent,
        fiber.childId as SessionId,
        [{ type: 'text', text: promptText }],
        { kind: 'user' },
        signal,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`council followup to ${fiber.seatId} (${fiber.childId}) timed out after ${timeoutMs}ms — child activation lock stuck`))
        }, timeoutMs)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('council followup aborted'))
        }, { once: true })
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Poll a child session until its turn settles; return the extracted text.
 * Detects provider errors from turn/end immediately.
 */
export async function waitForSeatTurn(
  ctx: Context,
  childId: string,
  signal: AbortSignal,
  timeoutMs = 90_000,
): Promise<string> {
  return (await waitForSeatTurnDetailed(ctx, childId, signal, timeoutMs)).text
}

export interface SeatTurnResult {
  text: string
  /** True when the turn ended at the provider's output-token cap (max-tokens). */
  truncated: boolean
}

/** Per-probe bound: a hung persistence store must not stall the seat wait. */
const PERSISTENCE_PROBE_TIMEOUT_MS = 5_000
/** Minimum gap between persistence probes while the child is still registered. */
const PERSISTENCE_PROBE_INTERVAL_MS = 250

/** Bound one persistence call so a wedged store fails loud, not silent. */
async function withBoundedWait<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Read a child's persisted event log with open/read both time-bounded. */
async function readPersistedEvents(
  persistence: SessionPersistence,
  childId: SessionId,
  timeoutMs: number,
): Promise<readonly SessionEvent[]> {
  const handle = await withBoundedWait(
    persistence.open(childId, 'read'),
    timeoutMs,
    `session persistence open for ${childId}`,
  )
  try {
    const page = await withBoundedWait(
      handle.read(0, undefined),
      timeoutMs,
      `session persistence read for ${childId}`,
    )
    return page.events
  } finally {
    try { await handle.close() } catch { /* best-effort close */ }
  }
}

/**
 * Like {@link waitForSeatTurn} but also reports whether the turn ended at the
 * output-token cap — callers can resume the seat instead of arguing from a
 * silently truncated position.
 *
 * Persistence is probed when the child is gone OR while it is still registered
 * but not running. The earlier `agent === undefined` gate missed
 * SETTLED-BUT-STILL-REGISTERED children: their text was durable in persistence,
 * but the wait polled to the 90s deadline instead of reading it.
 */
export async function waitForSeatTurnDetailed(
  ctx: Context,
  childId: string,
  signal: AbortSignal,
  timeoutMs = 90_000,
): Promise<SeatTurnResult> {
  const started = Date.now()
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  let probes = 0
  let lastProbeError: string | undefined
  let lastProbeAt = 0
  try {
    for (;;) {
      if (signal.aborted) throw new Error('council deliberation aborted')
      const elapsed = Date.now() - started
      if (elapsed > timeoutMs) {
        const probeNote = probes === 0
          ? '; no persistence probe was attempted'
          : lastProbeError !== undefined
            ? `; ${probes} persistence probe(s), last failed: ${lastProbeError}`
            : `; ${probes} persistence probe(s) saw no settled turn`
        throw new Error(`council seat timed out after ${timeoutMs}ms (child ${childId} never settled a turn — no assistant text and no completed turn/end observed${probeNote})`)
      }
      const agent = ctx.agents.get(childId as SessionId)
      // Probe when the child is gone OR registered-but-not-running. `!==
      // 'running'` (not `=== 'idle'`) also covers agents whose status is
      // unobservable; a probe that finds no settled turn simply keeps polling.
      const settledOrGone = agent === undefined || (agent as { status?: string }).status !== 'running'
      if (settledOrGone && Date.now() - lastProbeAt >= PERSISTENCE_PROBE_INTERVAL_MS) {
        lastProbeAt = Date.now()
        const persistence = ctx.get('sessionPersistence') as SessionPersistence | undefined
        if (persistence !== undefined) {
          probes += 1
          let events: readonly SessionEvent[] = []
          try {
            events = await readPersistedEvents(
              persistence,
              childId as SessionId,
              Math.max(1, Math.min(PERSISTENCE_PROBE_TIMEOUT_MS, timeoutMs - elapsed)),
            )
            lastProbeError = undefined
          } catch (err) {
            lastProbeError = err instanceof Error ? err.message : String(err)
          }
          const lastUser = [...events].reverse().find(e => e.type === 'user/message')
          const since = lastUser === undefined ? 0 : lastUser.seq
          const messages = events.filter(e => e.type === 'assistant/message' && e.seq > since)
          const extracted = messages
            .map(m => {
              const data = m.data as { message?: { content?: unknown }; content?: unknown }
              return textOfContent(data.message?.content ?? data.content)
            })
            .filter(t => t.length > 0)
            .join('\n')
            .trim()
          if (extracted.length > 0) {
            // Truncation flag: the LAST turn/end before this read may be
            // max-tokens even though text exists (text-first, then cut).
            const truncated = events.some(e => e.type === 'turn/end'
              && (e.data as { reason?: { kind?: string } })?.reason?.kind === 'max-tokens')
            return { text: extracted, truncated }
          }
          // The turn settled with no usable text (reasoning-only or whitespace
          // assistant blocks). Report it IMMEDIATELY with a reason instead of
          // spinning to the deadline — a settled child is never "still working".
          // The operator-observed failure: a chair emitted 34 steps of
          // reasoning + tool calls and no text, the wait kept polling for 90s
          // past its completed turn/end, then the fail-safe respawned it.
          const turnEnd = events.find(e => e.type === 'turn/end' && e.seq > since)
          if (turnEnd !== undefined) {
            const reason = (turnEnd.data as { reason?: { kind?: string; error?: { message?: string }; failure?: { message?: string }; reason?: { kind?: string } } })?.reason
            if (reason?.kind === 'error') {
              throw new Error(`Turn failed: ${reason.error?.message ?? reason.failure?.message ?? 'Model execution failed'}`)
            }
            if (reason?.kind === 'aborted') {
              throw new Error(`Turn was aborted (${reason.reason?.kind ?? 'cancelled'})`)
            }
            return { text: '[NO_OUTPUT: seat settled without text content]', truncated: reason?.kind === 'max-tokens' }
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export interface SeatTurn {
  seatId: string
  text: string
  tokens: number
  error?: string
}

/** Dispose seat fibers (best-effort). */
export async function disposeSeatFibers(ctx: Context, fibers: { childId: string }[]): Promise<void> {
  for (const fiber of fibers) {
    if (!fiber.childId) continue
    try {
      const sessionStore = ctx.get('sessions')
      if (sessionStore !== undefined) {
        await sessionStore.delete(fiber.childId as SessionId)
      }
    } catch {
      /* best-effort disposal */
    }
  }
}

/** Read the Living Brief projection snapshot for context injection. */
export function getLivingBriefText(ctx: Context, parent: Agent): string {
  try {
    const projections = ctx.get('sessionProjections') as
      { snapshot?: (s: Session) => { values?: { livingBrief?: { goal?: string; prose?: { text?: string }; decisions?: Array<{ text: string }>; goalSeq?: number } } } } | undefined
    const snap = projections?.snapshot?.(parent.session)
    const lb = snap?.values?.livingBrief
    if (lb) {
      const goal = lb.goal ? `Goal: ${lb.goal}` : ''
      const prose = lb.prose?.text ?? ''
      const decisions = lb.decisions && lb.decisions.length > 0
        ? `Decisions:\n${lb.decisions.map(d => `• ${d.text}`).join('\n')}`
        : ''
      return [goal, prose, decisions].filter(Boolean).join('\n\n')
    }
  } catch {
    /* no living brief */
  }
  return ''
}
