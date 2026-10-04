/**
 * enpoi-capabilities — Forwarded child approvals (doc 82 §E7; doc 55 extension).
 *
 * A delegated child runs with its approval policy pinned to `never`
 * (`@deepseek-ai/dsh-subagent` `captureDelegatedPolicyOverrides`), so an
 * approval-required action is rejected before any card can appear and
 * dangerous-but-legitimate work dead-ends. This module resolves such an ask
 * through the parent instead of the child.
 *
 * Resolution order for one child ask:
 *   1. RAILS FIRST. Explicit deny rules, workspace-boundary escapes the parent
 *      itself does not allow, credential paths (`.env`, `.ssh`, keys, …) and the
 *      dangerous classes (recursive deletes, force-push/history rewrite,
 *      exfiltration, `curl | sh`, privilege escalation) plus recursion past the
 *      delegation depth cap are NEVER card-approvable. Each resolves only through
 *      the parent's own effective policy: an `allow` there passes, anything else
 *      denies with the rail named. The child asking nicely can never lift them.
 *   2. Subtree grants answered earlier on a forwarded card (this session only).
 *   3. FULL ACCESS = PARENT JUDGEMENT (doc 82 item 8): when the ROOT
 *      session runs in Full access / no-restrictions mode (sandbox
 *      `danger-full-access` + approval `never`), the parent's own bounded
 *      reasoner judges each forwarded ask and the judgement is APPLIED in the
 *      operator's place: an allow resolves `allowed-once` with the parent's
 *      reason; a reject returns the corrective denial carrying that reason. A
 *      missed judgement (absent seam, error, timeout, unparseable, no
 *      suggestion) falls back to the derived risk check ({@link derivedRiskOf})
 *      — a clean ask allows with a named reason, a found risk signal denies with
 *      the signal named. There is no card in this mode and never a silent allow;
 *      one judgement per ask, batched, and capped per root turn.
 *      In EVERY other mode the human card appears (interactive) or the ask fails
 *      closed (unattended approval `never` without full access).
 *   4. Interactive: the ask is forwarded into the ROOT session as the existing
 *      approval card (`ctx.approval.request` on the root agent), carrying
 *      provenance (origin session, agent label, depth, matched rule) plus a
 *      recommendation line the card renders on its own. The line comes from ONE
 *      bounded root-side model call (the {@link ForwardingDeps.recommendation}
 *      seam; see recommendation.ts) and falls back to the derived
 *      {@link recommendationOf} heuristic on error, timeout, or nothing to
 *      reason about. The reply routes back by request id and the waiting child
 *      suspends on it; only the human card may answer. On the card the model's
 *      suggestion is advisory presentation — this module never reads it into a
 *      resolution, so no agent's words can approve a child's ask. The SAME
 *      judgement seam IS applied in Full access (item 3): the operator's mode
 *      delegates the answer to the parent agent rather than to a human.
 *
 * Failure semantics: a rejection is a corrective tool error the child adapts to,
 * never its death. An unanswered/undeliverable ask fails closed with a quiet
 * notification (stderr) and lets the child's turn settle — no hang, no waking the
 * root mid-turn.
 *
 * Grant scoping: an "always allow" answered on a forwarded card is stored in
 * memory against the REQUESTER'S OWN session for this process only; a sibling,
 * another root, or another process does not inherit it, and it never overrides a
 * deny because denies terminate in {@link resolvePolicy} before this module runs.
 * A broad allow is asked a SECOND time before it is stored. A child can never
 * self-escalate: this module only maps an ask the child's own policy produced.
 *
 * Finality: an ask resolved `allow` is recorded against the requester's own
 * session and call identity ({@link ChildApprovalForwarder.resolvesFinalCall})
 * and served to the host as the `forwardedApprovals` service. The core tool
 * registry's ask path consumes that record, so a later outer ask or a reviewer
 * denial cannot re-open a call the human (or the root's Full-access mode)
 * already allowed.
 */

import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import {
  dangerVerbInText,
  effectiveCommandText,
  grantProposalFor,
  grantProposalForOutcome,
  splitCompoundCommand,
  stripEnvPrefixes,
  type GrantProposal,
  type PolicyDecision,
} from './policy'

/** The closed approval vocabulary the card can return. */
export type ApprovalOutcome =
  | 'allowed-once'
  | 'allowed-always'
  | 'allowed-always-broad'
  | 'rejected'
  | 'cancelled'
  | 'unavailable'

/** The ask arm of a policy decision this module forwards. */
export type AskDecision = Extract<PolicyDecision, { kind: 'ask' }>

/** The root session's effective operating mode for a forwarded ask. */
export type RootMode = 'full-access' | 'interactive' | 'unattended'

/** Provenance carried on every forwarded ask (card, audit, and grant scope). */
export interface ForwardingOrigin {
  /** Session that produced the ask (the delegated child). */
  readonly childSessionId: string
  /** Session the card is rendered in (the nearest live root). */
  readonly rootSessionId: string
  /** The child's direct parent session id. */
  readonly parentSessionId: string
  /** Delegation depth from the root (1 = direct child). */
  readonly depth: number
  /** Human-readable agent label from the child's subagent descriptor. */
  readonly label: string
  /** The child session's workspace root, for the recommendation/boundary rail. */
  readonly cwd?: string
}

/** Dangerous classes that are never card-approvable for a child. */
export type RailClass =
  | 'depth'
  | 'privilege-escalation'
  | 'recursive-delete'
  | 'history-rewrite'
  | 'exfiltration'
  | 'pipe-to-shell'
  | 'credentials'
  | 'boundary'

/** One rail match: the class and the exact evidence it matched. */
export interface RailHit {
  readonly rail: RailClass
  readonly evidence: string
}

/** The structural child-agent slice this module reads (never the live Agent type). */
export interface ChildAgentLike {
  readonly session?: {
    readonly header?: {
      readonly id?: unknown
      readonly parentSession?: unknown
      readonly cwd?: unknown
      readonly delegationDepth?: unknown
      readonly origin?: unknown
    }
    readonly ownEvents?: () => readonly {
      readonly type?: string
      readonly data?: { readonly label?: unknown; readonly persona?: unknown }
    }[]
  }
}

/** The live root agent handed back to the host for `approval.request`. */
export interface RootHandle {
  readonly id: string
  /** The exact live Agent the host passes to `ApprovalService.request`. */
  readonly agent: unknown
  /** The root session's workspace root, for the recommendation's relation line. */
  readonly cwd?: string
}

/** The closed advisory vocabulary a root-side recommendation may carry. */
export type RecommendationSuggestion = 'allow' | 'reject' | 'allow-once'

/** One recommendation answer: a short sentence plus an advisory suggestion. */
export interface ModelRecommendation {
  /** The one short sentence the card shows / the judgement carries. */
  readonly text: string
  /** The model's suggestion: advisory on the card, APPLIED in Full access. */
  readonly suggestion?: RecommendationSuggestion
}

/** One card recommendation line: the answer plus where it came from. */
export interface CardRecommendation extends ModelRecommendation {
  /** `model` when the root-side reasoner produced the line; `derived` on the heuristic. */
  readonly source: 'model' | 'derived'
}

/** What one root-side recommendation call is given (ask + provenance + rails + workspace). */
export interface RecommendationQuery {
  readonly toolName: string
  readonly args?: Record<string, unknown> | undefined
  readonly origin: ForwardingOrigin
  /** The child's workspace relation to the root's, precomputed for the prompt. */
  readonly workspaceRelation: string
  /**
   * The rails verdict for this ask. The card path is only reached after the
   * rails ran and matched nothing, so this stays absent on every forwarded card
   * today; it travels so the reasoner sees the verdict rather than inferring it.
   */
  readonly rail?: RailHit | undefined
  readonly decision: AskDecision
  readonly signal?: AbortSignal | undefined
  /**
   * True when this answer is APPLIED as the decision (the Full-access parent
   * judgement), not rendered as card advice; the prompt says so explicitly.
   */
  readonly applied?: boolean | undefined
}

/** One card dispatch on the root agent. */
export interface RootAskQuery {
  readonly root: RootHandle
  readonly toolName: string
  readonly reason: string
  readonly displayReason: { readonly en: string; readonly [locale: string]: string }
  readonly broadAllow?: { readonly label: string }
  /** True for the second card that confirms a broad standing grant. */
  readonly secondConfirmation?: boolean
  /**
   * The distinct recommendation line the card renders (model or derived) plus
   * its advisory hint. Presentation only: the card's answer, never this field,
   * resolves the ask.
   */
  readonly recommendation?: CardRecommendation
  readonly signal?: AbortSignal
  readonly origin: ForwardingOrigin
}

/** One rail-ceiling query: "would the parent's own policy allow this action?". */
export interface ParentRailQuery {
  readonly root: RootHandle
  readonly toolName: string
  readonly command?: string
  readonly rail: RailClass
}

/** Host seams the forwarder consumes; every one is owned by index.ts. */
export interface ForwardingDeps {
  /** Nearest live root ancestor of a child session, or undefined when none is live. */
  findRoot(childSessionId: string): RootHandle | undefined
  /** The root session's effective mode; undefined when its log is unreadable. */
  modeOf(root: RootHandle): RootMode | undefined
  /** Whether the parent's own effective policy allows a rail class outright. */
  parentAllowsRail(query: ParentRailQuery): boolean
  /** Dispatch one approval card on the root agent and await its outcome. */
  askRoot(query: RootAskQuery): Promise<ApprovalOutcome>
  /**
   * ONE bounded root-side model judgement for a forwarded ask (the
   * keeper/oracle one-shot seam family; the host owns the model, route,
   * timeout, and parsing). On the card the answer is rendered as advice and can
   * never resolve the ask; in Full access the returned suggestion IS applied as
   * the parent's decision (see {@link ForwardingDeps.turnOf} for the cap).
   * Absent, throwing, slow, or empty calls keep the derived
   * {@link recommendationOf} / {@link derivedRiskOf} path, so an ask never
   * blocks and is never silently allowed.
   */
  recommendation?(query: RecommendationQuery): Promise<ModelRecommendation | undefined>
  /**
   * The root's current turn identity, for the per-turn parent-judgement budget.
   * Resets when the root starts a new turn; absent means the budget stays
   * per-root-session (still capped, never unlimited).
   */
  turnOf?(root: RootHandle): string | undefined
  /** Quiet audit/notification line; never wakes the root. */
  report(line: string): void
  /** The deployment's delegation depth cap (`ctx.subagents.resolveMaxDepth`). */
  depthCap(): number
  /**
   * Whether the root session currently sits outside any open turn. The host
   * supplies the harness's own open-turn fold; absent keeps the immediate card
   * path, so the park failsafe is opt-in and never guessed.
   */
  isRootIdle?(root: RootHandle): boolean
  /** Durable park journal; absent keeps parked records live in memory only. */
  parkJournal?: ParkJournal
  /** Park window override; default {@link DEFAULT_PARK_TTL_MS}. */
  parkTtlMs?(): number
}

/** One delegated child ask entering the forwarder. */
export interface ChildAskInput {
  readonly agent: ChildAgentLike | undefined
  readonly toolName: string
  readonly args?: Record<string, unknown>
  readonly decision: AskDecision
  /** The child's call identity; an allowed ask is recorded against it as final. */
  readonly callId?: string | number | undefined
  readonly signal?: AbortSignal
}

/** The tool-level decision the pre-execute listener returns. */
export type ChildAskResolution =
  | { readonly kind: 'allow'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string }

/** In-process parked ask: the durable record plus the waiting child's resolution. */
interface ParkedEntry {
  readonly record: ParkedAskRecord
  readonly input: ChildAskInput
  readonly root: RootHandle
  readonly origin: ForwardingOrigin
  readonly proposal: GrantProposal
  readonly rail: RailHit | undefined
  resolve: (resolution: ChildAskResolution) => void
  timer?: ReturnType<typeof setTimeout> | undefined
  removeAbort?: (() => void) | undefined
  settled: boolean
}

/** The root's turn closed between replay and dispatch: keep the ask parked. */
const REPARK = Symbol('approval-repark')
type CardResolution = ChildAskResolution | typeof REPARK

/**
 * Marker embedded in every forwarded ask reason. The allow-always grant writer
 * recognises it and skips its global persistence path: a forwarded grant is
 * scoped to the requester's session and written by the forwarder itself.
 */
export const FORWARDED_ASK_MARKER = '[forwarded child ask]'

/**
 * Most parent judgements one root turn may spend in Full access. Identical
 * concurrent asks share one judgement; beyond the cap the forwarder denies
 * with a named reason instead of queueing judgements forever.
 */
export const PARENT_JUDGEMENT_BUDGET_PER_TURN = 8

/**
 * Default window one forwarded ask may stay parked while its root session sits
 * between turns. Long enough that an operator finishing the current task and
 * starting the next root turn can still answer it, short enough that a child
 * whose root never returns is denied well before a full work session is lost.
 * The window bounds the wait FOR THE ROOT only: once the root's turn opens,
 * the card's own answer timeout bounds the answer.
 */
export const DEFAULT_PARK_TTL_MS = 10 * 60 * 1000

/**
 * Most forwarded asks one process keeps parked at once. Beyond the cap a new
 * idle-root ask fails closed with a named reason instead of growing the queue
 * without bound; a flood of asks is still bounded and still answered.
 */
export const MAX_PARKED_ASKS = 32

/** Settled park records a journal keeps for audit; the oldest are pruned first. */
export const PARK_JOURNAL_SETTLED_KEEP = 50

/** Lifecycle state of one parked forwarded ask. */
export type ParkState = 'parked' | 'resolved' | 'expired' | 'cancelled'

/** How a parked ask left the queue: the resolver and whether it was a decision. */
export type ParkSettlement = 'full-access' | 'card' | 'expired' | 'cancelled' | 'unavailable' | 'restart'

/**
 * One durably recorded parked forwarded ask: the root sat between turns when
 * the ask arrived, so no card could be audited or answered. Identity fields
 * survive in a {@link ParkJournal}; the waiting child's promise is
 * process-local, so a restart expires restored records rather than replaying a
 * card no live child is waiting for.
 */
export interface ParkedAskRecord {
  readonly id: string
  /** Monotonic park order within the origin process; replay is FIFO by this. */
  readonly seq: number
  /** The delegated child that produced the ask. */
  readonly childSessionId: string
  /** The child's descriptor label, for the audit line. */
  readonly childLabel: string
  /** Delegation depth from the root. */
  readonly depth: number
  /** The root session whose next turn start resolves the ask. */
  readonly rootSessionId: string
  readonly toolName: string
  /** The bash command (or equivalent action identity), when the tool has one. */
  readonly command?: string
  /** Why the child's policy required approval. */
  readonly reason: string
  readonly parkedAt: number
  readonly expiresAt: number
  /** Transition fields; the journal durably records each settled state. */
  state: ParkState
  settledAt?: number
  settledVia?: ParkSettlement
  /** The resolved tool-call decision: `allow` proceeds, `deny` is corrective. */
  settledWith?: 'allow' | 'deny'
}

/** Durable journal of parked asks: load at boot, upsert one record per transition. */
export interface ParkJournal {
  /** Every record from the previous process, newest state each. */
  load(): readonly ParkedAskRecord[]
  /** Insert or replace one record by id. */
  append(record: ParkedAskRecord): void
}

/** Path-argument keys scanned for credential and boundary rails. */
const PATH_ARG_KEYS: readonly string[] = [
  'file_path', 'filePath', 'path', 'paths', 'target', 'destination', 'source', 'file', 'dir', 'directory',
]

/** Credential-bearing paths that are never card-approvable for a child. */
const CREDENTIAL_PATH = /(?:^|[\s/'"=@])\.env(?:\.|$|\s)|(?:^|[\s/'"=])\.ssh(?:\/|[\s'"]|$)|id_(?:rsa|ed25519|ecdsa)\b|\.pem\b|(?:^|[\s/'"=])\.netrc\b|(?:^|[\s/'"=])\.aws(?:\/|[\s'"]|$)|(?:^|[\s/'"=])\.git-credentials\b|(?:^|[\s/'"=])known_hosts\b|(?:^|[\s/'"=])credentials(?:\.json)?(?:\s|$)|\/\.config\/gcloud\/|\/\.kube\/config\b|\/\.docker\/config\.json\b|\/\.npmrc\b/i

/** Commands that escalate privilege outright. */
const PRIVILEGE_ESCALATORS: ReadonlySet<string> = new Set(['sudo', 'su', 'doas', 'pkexec'])

/** Commands whose primary purpose is moving bytes off the machine. */
const EXFILTRATORS: ReadonlySet<string> = new Set(['scp', 'sftp', 'ftp', 'lftp', 'nc', 'ncat', 'socat', 'telnet', 'sshpass'])

/** Interpreters that turn a pipe or process substitution into code execution. */
const PIPE_INTERPRETER = /^(?:python[0-9.]*|perl|ruby|node|deno|bun|php)$/

/** Read-only filesystem capability that still touches a path argument. */
const FS_PATH_TOOLS: ReadonlySet<string> = new Set([
  'read', 'read_image', 'read_image_file', 'write', 'edit', 'str_replace_editor', 'list_dir', 'delete', 'move', 'copy',
])

/** Truncated session id used in human-facing provenance text. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** Audit-friendly park window: seconds once at least a second, else milliseconds. */
function windowText(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}

/**
 * Read the delegated-child provenance of one live agent, or undefined when the
 * agent is not a delegated child (no persisted parent session). The label is the
 * newest `subagent/descriptor` the spawning tool authored; reviewer tools label
 * their children by convention, so this is the honest agent identity.
 * @param agent - the live asking agent, structurally narrow.
 * @returns the child session id, parent session id, depth, label, and cwd.
 */
export function delegatedChildOf(agent: ChildAgentLike | undefined): {
  childSessionId: string
  parentSessionId: string
  depth: number
  label: string
  cwd?: string
} | undefined {
  const header = agent?.session?.header
  const childSessionId = typeof header?.id === 'string' && header.id !== '' ? header.id : undefined
  const parentSessionId = typeof header?.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : undefined
  if (childSessionId === undefined || parentSessionId === undefined) return undefined
  const rawDepth = header?.delegationDepth
  const depth = typeof rawDepth === 'number' && Number.isSafeInteger(rawDepth) && rawDepth > 0 ? rawDepth : 1
  let label: string | undefined
  for (const event of agent?.session?.ownEvents?.() ?? []) {
    if (event?.type !== 'subagent/descriptor') continue
    if (typeof event.data?.label === 'string' && event.data.label.trim() !== '') label = event.data.label.trim()
    break
  }
  const cwd = typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
  return {
    childSessionId,
    parentSessionId,
    depth,
    label: label ?? `child ${shortId(childSessionId)}`,
    ...cwd !== undefined ? { cwd } : {},
  }
}

/** Collect every declared path argument of one tool call. */
function pathArguments(args: Record<string, unknown> | undefined): string[] {
  if (args === undefined) return []
  const found: string[] = []
  for (const key of PATH_ARG_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') found.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item !== '') found.push(item)
    }
  }
  return found
}

/** Whether a path argument resolves outside the child's workspace root. */
function isOutsideWorkspace(path: string, cwd: string | undefined): boolean {
  if (cwd === undefined || cwd === '') return false
  const absolute = isAbsolute(path) ? path : resolvePath(cwd, path)
  const rel = relative(cwd, absolute)
  return rel === '..' || rel.startsWith(`..${'/'}`) || isAbsolute(rel)
}

/** The basename of one shell word (`/usr/bin/rm` → `rm`). */
function baseName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

/** Whether one `rm`/`rmdir` invocation is recursive or forced. */
function isRecursiveDelete(argv: readonly string[]): boolean {
  const argv0 = baseName(argv[0] ?? '')
  if (argv0 === 'rmdir') return true
  return argv.slice(1).some((token) => {
    if (token === '--') return false
    if (token.startsWith('--')) return token === '--recursive' || token === '--force'
    return token.startsWith('-') && /[rRf]/.test(token.slice(1))
  })
}

/** Whether one `git` sub-command rewrites history or force-pushes. */
function isHistoryRewrite(argv: readonly string[]): boolean {
  const sub = argv[1]
  if (sub === 'push') {
    return argv.slice(2).some(token => token === '-f' || token === '--force' || token === '--force-with-lease'
      || token === '--force-if-includes' || token === '--mirror' || token === '--delete'
      || token.startsWith('--force-with-lease='))
  }
  if (sub === 'reset') return argv.includes('--hard')
  return sub === 'filter-branch' || sub === 'filter-repo'
}

/** Whether a token names a remote rsync/scp target (`host:path`, `user@host:path`). */
function isRemoteTarget(token: string): boolean {
  if (token.includes('://') || token.startsWith('/') || token.startsWith('-')) return false
  return /^[^/][^:]*:.+/.test(token)
}

/** Whether a piped/process-substituted interpreter can run arbitrary code. */
function isPipeToShell(command: string): boolean {
  if (/\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh(?:\s|$)/.test(command)) return true
  if (/\|\s*(?:python[0-9.]*|perl|ruby|node|deno|bun|php)(?:\s|$)/.test(command)) return true
  return /(?:ba|z|da|k)?sh\s+<\(|(?:python[0-9.]*|node)\s+<\(/.test(command)
}

/** Classify one bash command against the never-card-approvable classes. */
function railOfBash(command: string): RailHit | undefined {
  if (isPipeToShell(command)) return { rail: 'pipe-to-shell', evidence: command.trim() }
  const credential = CREDENTIAL_PATH.exec(command)
  if (credential !== null) return { rail: 'credentials', evidence: credential[0] }
  for (const rawSub of splitCompoundCommand(command)) {
    const sub = stripEnvPrefixes(rawSub).trim()
    if (sub === '') continue
    // Classify by the command word's basename: `/bin/rm` is the `rm` rail,
    // `/usr/bin/sudo` is the privilege-escalation rail.
    const rawArgv0 = baseName(sub.split(/\s+/)[0] ?? '')
    if (PRIVILEGE_ESCALATORS.has(rawArgv0)) return { rail: 'privilege-escalation', evidence: sub }
    // See through the same transparent command wrappers the policy evaluator
    // strips, so a `nice`/`env`/`timeout`/`command` prefix cannot hide a rail.
    const effective = effectiveCommandText(sub)
    const argv = effective.split(/\s+/)
    if (argv.length > 0) argv[0] = baseName(argv[0] ?? '')
    const argv0 = argv[0] ?? ''
    if (PRIVILEGE_ESCALATORS.has(argv0)) return { rail: 'privilege-escalation', evidence: sub }
    if ((argv0 === 'rm' || argv0 === 'rmdir') && isRecursiveDelete(argv)) return { rail: 'recursive-delete', evidence: sub }
    if (argv0 === 'find' && /(?:^|\s)(?:-delete|-exec(?:dir)?\s+rm\b)/.test(effective)) return { rail: 'recursive-delete', evidence: sub }
    if (argv0 === 'rsync' && /(?:^|\s)--delete\b/.test(effective)) return { rail: 'recursive-delete', evidence: sub }
    if (argv0 === 'git' && isHistoryRewrite(argv)) return { rail: 'history-rewrite', evidence: sub }
    if (EXFILTRATORS.has(argv0)) return { rail: 'exfiltration', evidence: sub }
    if (argv0 === 'rsync' && argv.slice(1).some(isRemoteTarget)) return { rail: 'exfiltration', evidence: sub }
    if (argv0 === 'curl' && argv.slice(1).some((token: string) => token === '-T' || token === '--upload-file' || token.startsWith('--upload-file='))) {
      return { rail: 'exfiltration', evidence: sub }
    }
    if (argv0 === 'wget' && argv.slice(1).some((token: string) => token === '--post-file' || token === '--body-file')) {
      return { rail: 'exfiltration', evidence: sub }
    }
    if ((argv0 === 'docker' || argv0 === 'podman') && argv[1] === 'push') return { rail: 'exfiltration', evidence: sub }
  }
  return undefined
}

/**
 * Classify one child tool call against the rails. Bash commands are classified
 * by class (privilege escalation, recursive delete, history rewrite, exfil,
 * pipe-to-shell, credentials); filesystem tools by their declared path
 * arguments (credentials, workspace boundary). Returns the first hit.
 * @param input - tool name, call arguments, and the child's workspace root.
 * @returns the matched rail and its evidence, or undefined when none apply.
 */
export function railHitOf(input: {
  toolName: string
  args?: Record<string, unknown> | undefined
  cwd?: string | undefined
}): RailHit | undefined {
  if (input.toolName === 'bash') {
    const command = typeof input.args?.command === 'string' ? input.args.command : undefined
    return command === undefined || command.trim() === '' ? undefined : railOfBash(command)
  }
  if (!FS_PATH_TOOLS.has(input.toolName)) return undefined
  for (const path of pathArguments(input.args)) {
    if (CREDENTIAL_PATH.test(path)) return { rail: 'credentials', evidence: path }
    if (isOutsideWorkspace(path, input.cwd)) return { rail: 'boundary', evidence: path }
  }
  return undefined
}

/**
 * The short DERIVED recommendation line, computed from the parent's policy
 * facts. This is the fallback when the root-side model reasoner is absent,
 * errors, times out, or has nothing to reason about; it is presentation text
 * and never influences the resolution (only the card's answer does). Boundary
 * escapes never reach here (the rail handles them), so a named path is inside
 * the workspace.
 * @param input - tool name, call arguments, and the child's workspace root.
 * @returns a short recommendation sentence.
 */
export function recommendationOf(input: {
  toolName: string
  args?: Record<string, unknown> | undefined
  cwd?: string | undefined
}): string {
  const paths = input.toolName === 'bash' ? [] : pathArguments(input.args)
  if (paths.length === 0) return 'no filesystem path named'
  return 'inside the workspace, looks safe'
}

/**
 * The derived RISK check the Full-access fallback applies when the parent
 * judgement misses. It reads the same raw facts {@link recommendationOf}
 * renders for the card, but for risk instead of presentation: a rail that
 * slipped through, a bash command adjacent to a never-approvable class, a path
 * outside the child workspace, or any filesystem path named is a signal; an
 * ask with none of those is clean. The result is never silent: the caller names
 * this string in the denial (or allows with the named "no risk signal" reason).
 * @param input - tool name, call arguments, and the child's workspace root.
 * @returns the named risk signal, or undefined when the derived check finds none.
 */
export function derivedRiskOf(input: {
  toolName: string
  args?: Record<string, unknown> | undefined
  cwd?: string | undefined
}): string | undefined {
  // Defense in depth: rails resolve before the mode, so a hit here means the
  // ask reached the fallback with an unhandled class. Treat it as a signal.
  const rail = railHitOf(input)
  if (rail !== undefined) return `rail ${rail.rail} (${rail.evidence})`
  if (input.toolName === 'bash') {
    const command = typeof input.args?.command === 'string' ? input.args.command : ''
    const adjacent = dangerVerbInText(command)
    if (adjacent !== undefined) return `bash command is adjacent to a never-approvable class (${adjacent})`
    for (const token of command.split(/\s+/)) {
      if (!token.startsWith('/') || token.startsWith('//')) continue
      if (isOutsideWorkspace(token, input.cwd)) return `path ${token} outside the child workspace`
    }
    return undefined
  }
  const paths = pathArguments(input.args)
  for (const path of paths) {
    if (isOutsideWorkspace(path, input.cwd)) return `path ${path} outside the child workspace`
  }
  return paths.length === 0 ? undefined : `filesystem path ${paths[0]} named`
}

/**
 * Whether one ask carries anything worth a bounded model look. A bare call
 * (no arguments, or only empty ones) has nothing to reason about, so the
 * derived line is kept and no model call is spent.
 * @param args - the tool call arguments, as the registry received them.
 * @returns `true` when at least one argument carries a value.
 */
export function hasReasoningMaterial(args: Record<string, unknown> | undefined): boolean {
  if (args === undefined) return false
  for (const value of Object.values(args)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      if (value.trim() !== '') return true
      continue
    }
    if (Array.isArray(value)) {
      if (value.length > 0) return true
      continue
    }
    return true
  }
  return false
}

/**
 * One-line relation of the child's workspace to the root's, for the
 * recommendation prompt. Both roots come from session headers and may be absent
 * (structural slices), so unknown sides are named as unknown rather than
 * guessed.
 * @param childCwd - the child session's workspace root, when known.
 * @param parentCwd - the root session's workspace root, when known.
 * @returns a short human-readable relation line.
 */
export function workspaceRelationOf(childCwd: string | undefined, parentCwd: string | undefined): string {
  if (childCwd === undefined && parentCwd === undefined) return 'both workspace roots are unknown'
  if (childCwd === undefined) return `the child workspace is unknown; the root runs in ${parentCwd}`
  if (parentCwd === undefined) return `the child runs in ${childCwd}; the root workspace is unknown`
  if (childCwd === parentCwd) return `the child runs in the root's own workspace (${childCwd})`
  return isOutsideWorkspace(childCwd, parentCwd)
    ? `the child workspace ${childCwd} is OUTSIDE the root workspace ${parentCwd}`
    : `the child workspace ${childCwd} is inside the root workspace ${parentCwd}`
}

/** The audited reason one forwarded ask carries (full provenance). */
export function forwardedAskReason(
  origin: ForwardingOrigin,
  decision: AskDecision,
  recommendation: CardRecommendation,
): string {
  const label = recommendation.source === 'model'
    ? `Root model recommendation (advisory${recommendation.suggestion !== undefined ? `: ${recommendation.suggestion}` : ''})`
    : 'Parent recommendation'
  // The answer is a sentence of its own; join it with exactly one period.
  const text = recommendation.text.replace(/[.\s]+$/, '')
  return `${FORWARDED_ASK_MARKER} ${decision.reason}. Origin session ${shortId(origin.childSessionId)}, `
    + `agent ${origin.label}, depth ${origin.depth}, matched rule ${decision.source}. `
    + `${label}: ${text}.`
}

/**
 * The card's localized headline, keeping provenance short. The recommendation
 * is NOT inlined here any more: the card renders it as its own highlighted
 * element from {@link RootAskQuery.recommendation}.
 */
export function forwardedAskDisplayReason(
  origin: ForwardingOrigin,
  decision: AskDecision,
): { readonly en: string; readonly zh: string } {
  return {
    en: `Forwarded from ${origin.label} (depth ${origin.depth}): ${decision.reason}.`,
    zh: `来自 ${origin.label} 的转发请求（深度 ${origin.depth}）：${decision.reason}。`,
  }
}

/** One in-memory grant record, scoped to the requester's own session. */
interface SubtreeGrant {
  readonly proposal: GrantProposal
  readonly admittedAt: number
}

/**
 * Forwarder for delegated-child asks. One instance per plugin application;
 * every host seam arrives through {@link ForwardingDeps} so the decision rules
 * are exercised without a live harness.
 */
export class ChildApprovalForwarder {
  private readonly grants = new Map<string, SubtreeGrant[]>()
  private readonly pending = new Map<string, Promise<ChildAskResolution>>()
  /** Calls an allow resolution made final: child session id → call id → tool name. */
  private readonly allowedCalls = new Map<string, Map<string, string>>()
  /** Per-root judgement budget: the turn it counts against and how much it spent. */
  private readonly judgementBudget = new Map<string, { turn: string; count: number }>()
  /** Parked asks by park id; Map order is park order. */
  private readonly parked = new Map<string, ParkedEntry>()
  /** Park order counter; restored records advance it past their own seq. */
  private parkSeq = 0
  /** Replays in flight per root session, plus one queued follow-up pass each. */
  private readonly replays = new Map<string, Promise<void>>()
  private readonly replayQueued = new Set<string>()
  private disposed = false

  constructor(private readonly deps: ForwardingDeps) {
    this.restoreParked()
  }

  /**
   * Resolve one child ask through the parent. Rails run first and are never
   * card-approvable; then an existing subtree grant; then the root's mode:
   * interactive dispatches the human card, Full access applies one bounded
   * parent judgement (allow / corrective denial), unattended mode fails closed.
   * A rejection is returned as a corrective deny; nothing here kills the child.
   * An allow is final for the exact call identity: {@link resolvesFinalCall}
   * reports it so no later ask or reviewer denial can re-open what the human
   * (or the parent's Full-access judgement) already allowed, and a call already
   * on record resolves allow here without another judgement.
   * @param input - the child agent, tool call, and the ask the child's policy produced.
   * @returns the allow/deny resolution for the pre-execute listener.
   */
  async forward(input: ChildAskInput): Promise<ChildAskResolution> {
    if (input.callId !== undefined) {
      const child = delegatedChildOf(input.agent)
      if (child !== undefined && this.resolvesFinalCall(child.childSessionId, String(input.callId), input.toolName)) {
        return { kind: 'allow', reason: 'this call was already allowed by a forwarded ask' }
      }
    }
    const resolution = await this.resolveAsk(input)
    if (resolution.kind === 'allow' && input.callId !== undefined) {
      const child = delegatedChildOf(input.agent)
      if (child !== undefined) {
        const calls = this.allowedCalls.get(child.childSessionId) ?? new Map<string, string>()
        calls.set(String(input.callId), input.toolName)
        this.allowedCalls.set(child.childSessionId, calls)
      }
    }
    return resolution
  }

  /**
   * Whether one exact call from one child session was already allowed by a
   * forwarded ask. The record is scoped to the requesting child session and
   * pins the tool name, so a sibling session or another tool reusing the call
   * id never matches.
   * @param childSessionId - the requesting child session.
   * @param callId - the call identity the forwarded ask was recorded under.
   * @param toolName - the tool the recorded ask resolved for.
   * @returns `true` when the call is already allowed and final.
   */
  resolvesFinalCall(childSessionId: string, callId: string, toolName: string): boolean {
    return this.allowedCalls.get(childSessionId)?.get(callId) === toolName
  }

  /** Resolve one child ask through the parent; see {@link forward}. */
  private async resolveAsk(input: ChildAskInput): Promise<ChildAskResolution> {
    const child = delegatedChildOf(input.agent)
    if (child === undefined) {
      this.deps.report(`deny: non-child ask for ${input.toolName} reached the child forwarder`)
      return { kind: 'deny', reason: `child approval forwarding received a non-child ask for ${input.toolName}` }
    }
    const root = this.deps.findRoot(child.childSessionId)
    if (root === undefined) {
      return this.failClosed(child.childSessionId, input.toolName, 'no live parent session to forward to')
    }
    const origin: ForwardingOrigin = { ...child, rootSessionId: root.id }

    const depthCap = this.deps.depthCap()
    if (child.depth > depthCap) {
      this.deps.report(`deny: ${input.toolName} from child ${shortId(child.childSessionId)} at depth ${child.depth} exceeds cap ${depthCap}`)
      return {
        kind: 'deny',
        reason: `approval for ${input.toolName} was denied: delegation depth ${child.depth} is past the cap ${depthCap}, `
          + 'so this ask is never forwarded to a human card',
      }
    }

    const command = input.toolName === 'bash' && typeof input.args?.command === 'string' ? input.args.command : undefined
    const rail = railHitOf({ toolName: input.toolName, args: input.args, cwd: child.cwd })
    if (rail !== undefined) {
      const allowed = this.deps.parentAllowsRail({ root, toolName: input.toolName, ...command !== undefined ? { command } : {}, rail: rail.rail })
      this.deps.report(
        `${allowed ? 'allow' : 'deny'}: rail ${rail.rail} (${rail.evidence}) from child ${shortId(child.childSessionId)} `
        + `resolved through the parent's own policy`,
      )
      if (allowed) return { kind: 'allow', reason: `rail ${rail.rail}: the parent's own policy allows this action` }
      return {
        kind: 'deny',
        reason: `approval for ${input.toolName} was denied: ${rail.rail} (${rail.evidence}) is never approvable from a `
          + "forwarded child card and the parent's own policy does not allow it",
      }
    }

    const proposal = grantProposalFor(input.decision, input.toolName, command, child.label)
    if (this.grantAllows(child.childSessionId, input.decision, proposal)) {
      this.deps.report(`allow: ${input.toolName} absorbed by a grant scoped to child session ${shortId(child.childSessionId)}`)
      return { kind: 'allow', reason: 'allowed by a standing grant scoped to this child session' }
    }

    const mode = this.deps.modeOf(root)
    if (mode !== 'interactive' && mode !== 'full-access') {
      return this.failClosed(
        child.childSessionId,
        input.toolName,
        mode === undefined ? 'parent session mode is unknown' : 'parent runs unattended with approval prompts disabled',
      )
    }

    // Identical concurrent asks share ONE judgement (Full access) or ONE card
    // (interactive); the batch key is per child session, tool, and call shape.
    const batchKey = `${child.childSessionId}\u0000${input.toolName}\u0000${command ?? stableJson(input.args)}`
    const inFlight = this.pending.get(batchKey)
    if (inFlight !== undefined) return await inFlight
    // Idle-parent failsafe: a card cannot be audited or answered while the root
    // sits between turns, so the ask parks and replays at the root's next turn
    // start (or expires with a bounded denial). Full access parks too: the
    // parent policy decides at the root's next turn, not in the idle gap.
    const run = (this.deps.isRootIdle?.(root) ?? false)
      ? this.parkAsk(input, root, origin, mode, proposal, rail)
      : mode === 'full-access'
        ? this.fullAccessDecision(input, root, origin, rail)
        : this.askThroughCard(input, root, origin, proposal, rail)
    // The immediate paths can never return REPARK (only replay asks for it);
    // normalize defensively so the pending map stays a closed resolution type.
    const settled: Promise<ChildAskResolution> = run.then(result => result === REPARK
      ? this.failClosed(child.childSessionId, input.toolName, "the root's turn closed while the ask was being delivered")
      : result)
    this.pending.set(batchKey, settled)
    try {
      return await settled
    } finally {
      this.pending.delete(batchKey)
    }
  }

  /**
   * The shared recommendation query both the card's advisory line and the
   * Full-access judgement are built from, so the reasoner sees identical facts
   * either way (`applied` is the only difference: it is the decision there).
   */
  private recommendationQuery(
    input: ChildAskInput,
    root: RootHandle,
    origin: ForwardingOrigin,
    rail: RailHit | undefined,
    applied?: boolean,
  ): RecommendationQuery {
    return {
      toolName: input.toolName,
      ...input.args !== undefined ? { args: input.args } : {},
      origin,
      workspaceRelation: workspaceRelationOf(origin.cwd, root.cwd),
      ...rail !== undefined ? { rail } : {},
      decision: input.decision,
      ...input.signal !== undefined ? { signal: input.signal } : {},
      ...applied === true ? { applied: true } : {},
    }
  }

  /**
   * FULL ACCESS = PARENT JUDGEMENT (doc 82 item 8). The operator's
   * Full-access mode delegates the answer to the parent agent: the SAME bounded
   * root-side one-shot the card path uses judges this ask and its suggestion is
   * APPLIED in the operator's place — an allow resolves `allowed-once` with the
   * parent's reason, a reject returns the corrective denial carrying that
   * reason. A missed judgement falls back to {@link derivedRiskOf}: clean asks
   * allow with a named reason, risk signals deny with the signal named — never
   * a silent allow. Rails never reach here (they resolve above, through the
   * parent's own policy). One judgement per ask (identical concurrent asks
   * share it) and at most {@link PARENT_JUDGEMENT_BUDGET_PER_TURN} per root turn.
   */
  private async fullAccessDecision(
    input: ChildAskInput,
    root: RootHandle,
    origin: ForwardingOrigin,
    rail: RailHit | undefined,
  ): Promise<ChildAskResolution> {
    const child = shortId(origin.childSessionId)
    if (!this.consumeJudgementBudget(root)) {
      this.deps.report(
        `audit: parent refused ${input.toolName} for child ${child} (${origin.label}) because parent judgement `
        + 'budget exhausted this turn — Full access',
      )
      return {
        kind: 'deny',
        reason: `approval for ${input.toolName} was denied: parent judgement budget exhausted this turn `
          + `(${PARENT_JUDGEMENT_BUDGET_PER_TURN} per root turn). Adapt the task or report the limitation instead of retrying.`,
      }
    }
    const judgement = await this.fullAccessJudgement(input, root, origin, rail)
    if (judgement !== undefined && (judgement.suggestion === 'allow' || judgement.suggestion === 'allow-once')) {
      const text = judgement.text.trim()
      this.deps.report(
        `audit: parent approved ${input.toolName} for child ${child} (${origin.label}) because ${text} — Full access (model judgement)`,
      )
      return { kind: 'allow', reason: `parent approved (Full access): ${text}` }
    }
    if (judgement !== undefined && judgement.suggestion === 'reject') {
      const text = judgement.text.trim()
      this.deps.report(
        `audit: parent refused ${input.toolName} for child ${child} (${origin.label}) because ${text} — Full access (model judgement)`,
      )
      // The answer is a sentence of its own; join it with exactly one period.
      return {
        kind: 'deny',
        reason: `the parent (Full access) refused ${input.toolName}: ${text.replace(/[.\s]+$/, '')}. It required approval because: `
          + `${input.decision.reason}. Adapt the task or report the limitation instead of retrying.`,
      }
    }
    const risk = derivedRiskOf({
      toolName: input.toolName,
      ...input.args !== undefined ? { args: input.args } : {},
      cwd: origin.cwd,
    })
    if (risk === undefined) {
      this.deps.report(
        `audit: parent approved ${input.toolName} for child ${child} (${origin.label}) because the derived check `
        + 'found no risk signal — Full access (derived fallback)',
      )
      return { kind: 'allow', reason: 'derived: no risk signal (Full access)' }
    }
    this.deps.report(
      `audit: parent refused ${input.toolName} for child ${child} (${origin.label}) because the derived check `
      + `found a risk signal: ${risk} — Full access (derived fallback)`,
    )
    return {
      kind: 'deny',
      reason: `the parent (Full access) could not judge ${input.toolName}; the derived check found a risk signal: `
        + `${risk}. Adapt the task or report the limitation instead of retrying.`,
    }
  }

  /**
   * ONE bounded root-side judgement for a Full-access ask. Unlike the card's
   * advisory line it is not skipped for a bare ask: here the judgement IS the
   * decision. A miss (absent seam, throw, undefined answer, empty text) returns
   * undefined; an answer without a usable suggestion falls through to the same
   * fallback in the caller. The caller then applies the derived risk check
   * rather than any default.
   */
  private async fullAccessJudgement(
    input: ChildAskInput,
    root: RootHandle,
    origin: ForwardingOrigin,
    rail: RailHit | undefined,
  ): Promise<ModelRecommendation | undefined> {
    if (this.deps.recommendation === undefined) {
      this.deps.report(`judgement: no root-side reasoner is wired for ${input.toolName}; applying the derived check (Full access)`)
      return undefined
    }
    try {
      const answer = await this.deps.recommendation(this.recommendationQuery(input, root, origin, rail, true))
      if (answer === undefined || answer.text.trim() === '') {
        this.deps.report(`judgement: root reasoner produced nothing for ${input.toolName}; applying the derived check (Full access)`)
        return undefined
      }
      return answer
    } catch (error) {
      this.deps.report(
        `judgement: root reasoner failed for ${input.toolName} `
        + `(${error instanceof Error ? error.message : String(error)}); applying the derived check (Full access)`,
      )
      return undefined
    }
  }

  /**
   * Whether this root may spend another parent judgement in its current turn.
   * The turn identity comes from the host ({@link ForwardingDeps.turnOf}); when
   * the host provides none the budget stays per-root-session, so the cap holds
   * rather than being lifted.
   */
  private consumeJudgementBudget(root: RootHandle): boolean {
    const turn = this.deps.turnOf?.(root) ?? 'current'
    const record = this.judgementBudget.get(root.id)
    if (record === undefined || record.turn !== turn) {
      this.judgementBudget.set(root.id, { turn, count: 1 })
      return true
    }
    if (record.count >= PARENT_JUDGEMENT_BUDGET_PER_TURN) return false
    record.count += 1
    return true
  }

  /**
   * The card's recommendation line: ONE bounded root-side model call when the
   * host provides the seam and the ask carries something to reason about;
   * every miss (absent seam, error, timeout, empty answer) keeps the derived
   * heuristic. The returned suggestion is advisory presentation only — nothing
   * here reads it into a resolution, so a model's words can never approve a
   * child's ask on the card.
   */
  private async cardRecommendation(
    input: ChildAskInput,
    root: RootHandle,
    origin: ForwardingOrigin,
    rail: RailHit | undefined,
  ): Promise<CardRecommendation> {
    const derived: CardRecommendation = {
      text: recommendationOf({ toolName: input.toolName, args: input.args, cwd: origin.cwd }),
      source: 'derived',
    }
    if (this.deps.recommendation === undefined || !hasReasoningMaterial(input.args)) return derived
    try {
      const answer = await this.deps.recommendation(this.recommendationQuery(input, root, origin, rail))
      if (answer === undefined || answer.text.trim() === '') {
        this.deps.report(`recommendation: root reasoner produced nothing for ${input.toolName}; keeping the derived line`)
        return derived
      }
      return {
        text: answer.text.trim(),
        source: 'model',
        ...answer.suggestion !== undefined ? { suggestion: answer.suggestion } : {},
      }
    } catch (error) {
      this.deps.report(
        `recommendation: root reasoner failed for ${input.toolName} `
        + `(${error instanceof Error ? error.message : String(error)}); keeping the derived line`,
      )
      return derived
    }
  }

  /**
   * Forward the ask as one root-session card and map its outcome. During a
   * park replay (`reparkOnIdle`) a card that reaches a root whose turn closed
   * in the meantime re-parks instead of denying an ask the operator never saw.
   */
  private async askThroughCard(
    input: ChildAskInput,
    root: RootHandle,
    origin: ForwardingOrigin,
    proposal: GrantProposal,
    rail: RailHit | undefined,
    reparkOnIdle = false,
  ): Promise<CardResolution> {
    const recommendation = await this.cardRecommendation(input, root, origin, rail)
    const reason = forwardedAskReason(origin, input.decision, recommendation)
    let outcome: ApprovalOutcome
    try {
      outcome = await this.deps.askRoot({
        root,
        toolName: input.toolName,
        reason,
        displayReason: forwardedAskDisplayReason(origin, input.decision),
        ...input.decision.broadAllow !== undefined ? { broadAllow: input.decision.broadAllow } : {},
        ...input.signal !== undefined ? { signal: input.signal } : {},
        recommendation,
        origin,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A replay dispatched exactly as the root's turn closed: park again
      // rather than deny a card the operator never saw.
      if (reparkOnIdle && message.includes('outside an open turn')) return REPARK
      return this.failClosed(
        origin.childSessionId,
        input.toolName,
        `the forwarded ask could not be delivered: ${message}`,
      )
    }
    switch (outcome) {
      case 'allowed-once':
        this.deps.report(`allow: human approved ${input.toolName} once for child ${shortId(origin.childSessionId)}`)
        return { kind: 'allow', reason: 'approved once on the forwarded parent card' }
      case 'allowed-always':
        this.recordGrant(origin.childSessionId, proposal)
        this.deps.report(`allow: exact-command always granted to child session ${shortId(origin.childSessionId)}`)
        return { kind: 'allow', reason: 'approved with a standing grant scoped to this child session' }
      case 'allowed-always-broad': {
        let confirm: ApprovalOutcome
        try {
          confirm = await this.deps.askRoot({
            root,
            toolName: input.toolName,
            reason: `${FORWARDED_ASK_MARKER} second confirmation: grant "${proposal.broadPattern ?? proposal.pattern ?? input.toolName}" as a `
              + `standing allowance for child ${shortId(origin.childSessionId)} (${origin.label}, depth ${origin.depth})?`,
            displayReason: {
              en: `Confirm a broad standing grant to ${origin.label} (depth ${origin.depth}) for "${proposal.broadPattern ?? proposal.pattern ?? input.toolName}".`,
              zh: `请再次确认向 ${origin.label}（深度 ${origin.depth}）授予 "${proposal.broadPattern ?? proposal.pattern ?? input.toolName}" 的长期许可。`,
            },
            secondConfirmation: true,
            ...input.signal !== undefined ? { signal: input.signal } : {},
            origin,
          })
        } catch (error) {
          return this.failClosed(
            origin.childSessionId,
            input.toolName,
            `the broad-grant confirmation could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        if (confirm === 'allowed-once' || confirm === 'allowed-always' || confirm === 'allowed-always-broad') {
          this.recordGrant(origin.childSessionId, grantProposalForOutcome(proposal, true))
          this.deps.report(`allow: broad grant confirmed for child session ${shortId(origin.childSessionId)}`)
          return { kind: 'allow', reason: 'approved with a confirmed broad grant scoped to this child session' }
        }
        return {
          kind: 'deny',
          reason: `the broad standing grant for ${input.toolName} was not confirmed`,
        }
      }
      case 'rejected':
        this.deps.report(`deny: human rejected ${input.toolName} for child ${shortId(origin.childSessionId)}`)
        return {
          kind: 'deny',
          reason: `the user rejected ${input.toolName}; it required approval because: ${input.decision.reason}`,
        }
      case 'cancelled':
        return { kind: 'deny', reason: `approval for ${input.toolName} was cancelled before it was answered` }
      case 'unavailable':
        return this.failClosed(origin.childSessionId, input.toolName, 'the forwarded ask was left unanswered')
      default:
        return this.failClosed(origin.childSessionId, input.toolName, `unexpected approval outcome ${String(outcome)}`)
    }
  }

  /** Fail closed with a quiet notification; the child's turn settles normally. */
  private failClosed(childSessionId: string, toolName: string, why: string): ChildAskResolution {
    this.deps.report(`fail-closed: ${toolName} from child ${shortId(childSessionId)}: ${why}`)
    return {
      kind: 'deny',
      reason: `approval for ${toolName} failed closed: ${why}. Adapt the task or report the limitation instead of retrying.`,
    }
  }

  /** Whether an earlier forwarded "always" covers this ask for this child session. */
  private grantAllows(childSessionId: string, decision: AskDecision, proposal: GrantProposal): boolean {
    const grants = this.grants.get(childSessionId)
    if (grants === undefined) return false
    for (const grant of grants) {
      if (grant.proposal.tool !== proposal.tool) continue
      if (grant.proposal.pattern === proposal.pattern) return true
      if (grant.proposal.pattern !== undefined && grant.proposal.pattern === decision.pattern) return true
    }
    return false
  }

  /** Record one grant against the requester's own session (deduplicated). */
  private recordGrant(childSessionId: string, proposal: GrantProposal): void {
    const grants = this.grants.get(childSessionId) ?? []
    if (!grants.some(grant => grant.proposal.tool === proposal.tool && grant.proposal.pattern === proposal.pattern)) {
      grants.push({ proposal, admittedAt: Date.now() })
      this.grants.set(childSessionId, grants)
    }
  }

  // ── idle-parent park-and-replay (doc 04 §6, doc 11 troubleshooting) ────────
  // A forwarded ask whose root sits between turns cannot dispatch a card: the
  // harness's approval audit must be turn-enclosed, so `approval.request()`
  // rejects outside an open turn. Parking records the ask (reason, child,
  // tool/command, deadline), waits for the root's next `turn/start`, and
  // replays it in FIFO order under the root's policy at that moment. Every
  // exit — resolve, expire, abort, session end, dispose — settles the waiting
  // child and the durable journal; nothing hangs and no card outlives its ask.

  /** Window one ask may wait for its root's next turn; see {@link DEFAULT_PARK_TTL_MS}. */
  private parkTtlMs(): number {
    const configured = this.deps.parkTtlMs?.()
    return configured !== undefined && configured > 0 ? configured : DEFAULT_PARK_TTL_MS
  }

  /**
   * Park one ask whose root sits between turns. Records it durably, reports
   * the park, and returns a promise settled by {@link replayParked} at the
   * root's next turn start, by the park window's expiry, by the ask's abort
   * signal, or by {@link releaseSession}/{@link dispose}. Identical concurrent
   * asks share one entry through {@link resolveAsk}'s pending batch.
   */
  private parkAsk(
    input: ChildAskInput,
    root: RootHandle,
    origin: ForwardingOrigin,
    mode: RootMode,
    proposal: GrantProposal,
    rail: RailHit | undefined,
  ): Promise<ChildAskResolution> {
    if (this.disposed) {
      return Promise.resolve(this.failClosed(
        origin.childSessionId, input.toolName, 'the approval forwarder is disposed',
      ))
    }
    if (this.parked.size >= MAX_PARKED_ASKS) {
      return Promise.resolve(this.failClosed(
        origin.childSessionId,
        input.toolName,
        `too many forwarded asks are already parked (${MAX_PARKED_ASKS}); the root session has not returned to open a turn`,
      ))
    }
    const now = Date.now()
    const ttl = this.parkTtlMs()
    this.parkSeq += 1
    const command = input.toolName === 'bash' && typeof input.args?.command === 'string' ? input.args.command : undefined
    const record: ParkedAskRecord = {
      id: `park-${now.toString(36)}-${this.parkSeq.toString(36)}`,
      seq: this.parkSeq,
      childSessionId: origin.childSessionId,
      childLabel: origin.label,
      depth: origin.depth,
      rootSessionId: root.id,
      toolName: input.toolName,
      ...command !== undefined ? { command } : {},
      reason: input.decision.reason,
      parkedAt: now,
      expiresAt: now + ttl,
      state: 'parked',
    }
    let resolveEntry!: (resolution: ChildAskResolution) => void
    const promise = new Promise<ChildAskResolution>((resolve) => { resolveEntry = resolve })
    const entry: ParkedEntry = { record, input, root, origin, proposal, rail, resolve: resolveEntry, settled: false }
    this.parked.set(record.id, entry)
    this.appendJournal(record)
    this.deps.report(
      `park: ${input.toolName} from child ${shortId(origin.childSessionId)} (${origin.label}, depth ${origin.depth}) for root `
      + `${shortId(root.id)} while it sits between turns — ${input.decision.reason} (replays at the root's next turn as `
      + `${mode === 'full-access' ? 'a parent judgement, no card' : "the operator's card"}, expires in ${windowText(ttl)})`,
    )
    entry.timer = setTimeout(() => { this.expireParked(entry) }, ttl)
    ;(entry.timer as { unref?: () => void }).unref?.()
    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        this.settleParked(entry, 'cancelled', 'cancelled', {
          kind: 'deny',
          reason: `approval for ${input.toolName} was cancelled before it was parked`,
        })
      } else {
        const onAbort = (): void => {
          this.deps.report(`cancel: ${input.toolName} from child ${shortId(origin.childSessionId)} — the asking turn was aborted while parked`)
          this.settleParked(entry, 'cancelled', 'cancelled', {
            kind: 'deny',
            reason: `approval for ${input.toolName} was cancelled: the asking turn was aborted while the ask was parked`,
          })
        }
        input.signal.addEventListener('abort', onAbort, { once: true })
        entry.removeAbort = () => input.signal?.removeEventListener('abort', onAbort)
      }
    }
    return promise
  }

  /**
   * Resolve every ask parked for one root at its turn start, in FIFO park
   * order, one at a time. Full access applies the parent judgement (audit
   * line, no card); every other resolvable mode dispatches the operator's
   * card. A replay that races the turn's end re-parks and stops; the remaining
   * asks stay parked for the next turn start.
   * @param rootSessionId - the root session whose turn just opened.
   */
  replayParked(rootSessionId: string): void {
    if (this.disposed) return
    if (![...this.parked.values()].some(entry => entry.record.rootSessionId === rootSessionId)) return
    if (this.replays.has(rootSessionId)) {
      // A turn started while a previous replay is mid-card; run one more pass
      // after it settles so asks parked since are not stranded.
      this.replayQueued.add(rootSessionId)
      return
    }
    const replay = this.replayEntries(rootSessionId)
      .catch((error: unknown) => {
        this.deps.report(`replay: root ${shortId(rootSessionId)} replay failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        this.replays.delete(rootSessionId)
        if (this.replayQueued.delete(rootSessionId)) this.replayParked(rootSessionId)
      })
    this.replays.set(rootSessionId, replay)
  }

  /** One FIFO pass over a root's parked asks; see {@link replayParked}. */
  private async replayEntries(rootSessionId: string): Promise<void> {
    const entries = [...this.parked.values()]
      .filter(entry => entry.record.rootSessionId === rootSessionId && !entry.settled)
      .sort((a, b) => a.record.seq - b.record.seq)
    // The root returned, so the park window has done its job; suspend every
    // bound up front so a later entry cannot expire while an earlier card is
    // answered. A reparked entry re-arms its remaining window.
    for (const entry of entries) this.suspendTimer(entry)
    for (const entry of entries) {
      if (this.disposed) return
      if (entry.settled) continue
      const root = this.deps.findRoot(entry.record.childSessionId)
      if (root === undefined) {
        this.deps.report(`replay: no live root for parked ${entry.record.toolName} from child ${shortId(entry.record.childSessionId)}; failing closed`)
        this.settleParked(entry, 'resolved', 'unavailable', this.failClosed(
          entry.record.childSessionId, entry.record.toolName, 'no live parent session to forward to',
        ))
        continue
      }
      if (this.deps.isRootIdle?.(root) ?? false) {
        // The root's turn closed before this entry's turn; leave this and every
        // later entry parked for the next turn start.
        for (const rest of entries) this.resumeTimer(rest)
        return
      }
      const mode = this.deps.modeOf(root)
      let resolution: CardResolution
      if (mode === 'full-access') {
        resolution = await this.fullAccessDecision(entry.input, root, entry.origin, entry.rail)
      } else if (mode === 'interactive') {
        resolution = await this.askThroughCard(entry.input, root, entry.origin, entry.proposal, entry.rail, true)
      } else {
        resolution = this.failClosed(
          entry.record.childSessionId,
          entry.record.toolName,
          mode === undefined ? 'parent session mode is unknown' : 'parent runs unattended with approval prompts disabled',
        )
      }
      if (resolution === REPARK) {
        this.deps.report(`replay: ${entry.record.toolName} from child ${shortId(entry.record.childSessionId)} re-parks — the root's turn closed before the card was dispatched`)
        for (const rest of entries) this.resumeTimer(rest)
        return
      }
      // A release (session end/dispose) can land while the card is pending;
      // that settlement already answered the child, so do not restate it.
      if (entry.settled) continue
      this.deps.report(
        `resolve: ${entry.record.toolName} from child ${shortId(entry.record.childSessionId)} — `
        + `${resolution.kind === 'allow' ? 'allowed' : 'denied'} via ${mode === 'full-access' ? 'the parent policy (Full access, no card)' : "the operator's forwarded card"}`,
      )
      this.settleParked(entry, 'resolved', mode === 'full-access' ? 'full-access' : 'card', resolution)
    }
  }

  /**
   * Release every ask parked for a session that ended (the asking child or the
   * root): a wait must not outlive its participants.
   * @param sessionId - the ended session (child or root).
   * @param why - the audit reason, carried into the child's corrective denial.
   */
  releaseSession(sessionId: string, why: string): void {
    for (const entry of [...this.parked.values()]) {
      if (entry.record.childSessionId !== sessionId && entry.record.rootSessionId !== sessionId) continue
      this.deps.report(`cancel: ${entry.record.toolName} from child ${shortId(entry.record.childSessionId)} — ${why}`)
      this.settleParked(entry, 'cancelled', 'cancelled', {
        kind: 'deny',
        reason: `approval for ${entry.record.toolName} was cancelled: ${why}. The call was not approved.`,
      })
    }
  }

  /** Release every parked ask when the plugin is disposed; nothing may hang. */
  dispose(): void {
    this.disposed = true
    for (const entry of [...this.parked.values()]) {
      this.deps.report(`cancel: ${entry.record.toolName} from child ${shortId(entry.record.childSessionId)} — the approval forwarder was disposed`)
      this.settleParked(entry, 'cancelled', 'cancelled', {
        kind: 'deny',
        reason: `approval for ${entry.record.toolName} was cancelled: the approval forwarder was disposed before the root's next turn. The call was not approved.`,
      })
    }
    this.replayQueued.clear()
  }

  /**
   * Expire records left parked by a previous process. The waiting child's
   * promise died with that process, so replaying a restored record would mint
   * a card nobody is waiting for; expiring it keeps a restart safe and the
   * audit trail honest. New parks sort after every restored seq.
   */
  private restoreParked(): void {
    const journal = this.deps.parkJournal
    if (journal === undefined) return
    let loaded: readonly ParkedAskRecord[]
    try {
      loaded = journal.load()
    } catch (error) {
      this.deps.report(`journal: failed to load parked asks: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const record of loaded) {
      if (record.seq > this.parkSeq) this.parkSeq = record.seq
      if (record.state !== 'parked') continue
      record.state = 'expired'
      record.settledAt = Date.now()
      record.settledVia = 'restart'
      record.settledWith = 'deny'
      this.deps.report(
        `restore: parked ${record.toolName} from child ${shortId(record.childSessionId)} did not survive the approval `
        + 'forwarder restart; expiring it (the waiting child ended with the previous process)',
      )
      this.appendJournal(record)
    }
  }

  /** The park window elapsed with no root turn: deny with the named reason. */
  private expireParked(entry: ParkedEntry): void {
    if (entry.settled) return
    const window = windowText(entry.record.expiresAt - entry.record.parkedAt)
    this.deps.report(
      `expire: ${entry.record.toolName} from child ${shortId(entry.record.childSessionId)} — approval was not resolved in `
      + `time (root ${shortId(entry.record.rootSessionId)} stayed between turns for the ${window} park window)`,
    )
    this.settleParked(entry, 'expired', 'expired', {
      kind: 'deny',
      reason: `approval was not resolved in time for ${entry.record.toolName}: the root session `
        + `${shortId(entry.record.rootSessionId)} stayed between turns for the ${window} park window. Ask again while `
        + 'the root is active, or run the action from the root session.',
    })
  }

  /** Leave the parked queue exactly once: clear bounds, journal, resolve. */
  private settleParked(
    entry: ParkedEntry,
    state: ParkState,
    via: ParkSettlement,
    resolution: ChildAskResolution,
  ): void {
    if (entry.settled) return
    entry.settled = true
    this.suspendTimer(entry)
    entry.removeAbort?.()
    this.parked.delete(entry.record.id)
    entry.record.state = state
    entry.record.settledAt = Date.now()
    entry.record.settledVia = via
    entry.record.settledWith = resolution.kind === 'allow' ? 'allow' : 'deny'
    this.appendJournal(entry.record)
    entry.resolve(resolution)
  }

  private suspendTimer(entry: ParkedEntry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  /** Re-arm a park whose replay had to stop, preserving the original window. */
  private resumeTimer(entry: ParkedEntry): void {
    if (entry.settled || entry.timer !== undefined) return
    const remaining = entry.record.expiresAt - Date.now()
    if (remaining <= 0) {
      this.expireParked(entry)
      return
    }
    entry.timer = setTimeout(() => { this.expireParked(entry) }, remaining)
    ;(entry.timer as { unref?: () => void }).unref?.()
  }

  /** Best-effort durable upsert; a failing journal never blocks the decision. */
  private appendJournal(record: ParkedAskRecord): void {
    const journal = this.deps.parkJournal
    if (journal === undefined) return
    try {
      journal.append(record)
    } catch (error) {
      this.deps.report(`journal: failed to record parked ask ${record.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** The session id inside the structural session slice a host passes to the seam. */
function sessionIdOf(session: unknown): string | undefined {
  const header = (session as { header?: { id?: unknown } } | undefined)?.header
  return typeof header?.id === 'string' && header.id !== '' ? header.id : undefined
}

/**
 * The `forwardedApprovals` host service one forwarder provides. It answers
 * whether one exact call was already allowed by a forwarded child ask, keyed by
 * the requesting session and call identity. The core tool registry consumes it
 * with `ctx.get('forwardedApprovals')` so an outer ask or a reviewer denial
 * cannot re-open a call the human (or the root's Full-access mode) already
 * allowed.
 * @param forwarder - the live forwarder whose records answer the query.
 * @returns the resolves-only service facade.
 */
export function forwardedApprovalsSeam(forwarder: ChildApprovalForwarder): {
  resolves(session: unknown, callId: unknown, toolName: unknown): boolean
} {
  return {
    resolves: (session, callId, toolName) => {
      const childSessionId = sessionIdOf(session)
      return childSessionId !== undefined && typeof callId === 'string' && typeof toolName === 'string'
        && forwarder.resolvesFinalCall(childSessionId, callId, toolName)
    },
  }
}

/** Stable JSON for the batch key; arguments are already logged, lossless JSON. */
function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '<unserializable>'
  }
}
