/**
 * enpoi-capabilities — Permission policy resolver (pure).
 *
 * Doc 55: OpenCode-grade per-tool/per-command policy with per-agent overrides,
 * standing allow-always grants, MCP server wildcards, and compound-command
 * aggregation. Resolution is fresh per dispatch; settings.yaml under
 * `enpoi-orchestration.permissions` is the single source of truth (creator-
 * editable); the shipped defaults below are code, not YAML.
 *
 * Resolution order (Oracle plan gate, amended):
 *   capability-disabled → read-only veto → agent bashPatterns → agent tool
 *   → global bashPatterns → global tool → grants (same granularity as the
 *   ask they short-circuit) → MCP wildcards → defaults.unknownTools.
 * Deny terminates immediately; grants NEVER upgrade a deny.
 */

export type PermissionPolicy = 'allow' | 'ask' | 'deny'

export interface BashPattern {
  pattern: string
  policy: PermissionPolicy
}

export interface StandingGrant {
  id: string
  tool: string
  /** Undefined = tool-level grant (applies to every command of the tool). */
  pattern?: string
  /**
   * The agent the grant is scoped to — or, when {@link global} is true, the
   * agent that ASKED for it (audit only, never a scope).
   */
  agent?: string
  /**
   * Host-written grants are global by design: the approval card's
   * "Always allow" covers all agents. `agent` stays on the record for
   * auditability and future per-agent scoping, but a global grant never
   * narrows resolution.
   */
  global?: boolean
  createdAt?: string
}

export interface PermissionPolicyConfig {
  defaults?: { unknownTools?: PermissionPolicy }
  tools?: Record<string, PermissionPolicy>
  bashPatterns?: BashPattern[]
  agents?: Record<string, { tools?: Record<string, PermissionPolicy>; bashPatterns?: BashPattern[] }>
  grants?: Record<string, StandingGrant>
}

export type PolicyDecision =
  | { kind: 'allow'; source: string }
  | { kind: 'deny'; reason: string; source: string }
  | {
    kind: 'ask'
    reason: string
    source: string
    /** The grant tier that can absorb this ask. */
    grantTier: 'pattern' | 'tool'
    /** The pattern that asked (grantTier 'pattern'). */
    pattern?: string
    /**
     * Present when the ask can be answered with a BROAD standing grant: the
     * shell verb ("rm") the approval card labels its explicit "allow all"
     * action with. Absent means the card offers only the default action, which
     * for danger-list verbs pins the exact raw command.
     */
    broadAllow?: { label: string }
  }

/** Tools treated as mutations for the read-only session veto. */
const MUTATION_TOOLS = new Set(['bash', 'edit', 'write', 'str_replace_editor'])

/**
 * Whether an asking session runs in Full access: approval prompts disabled AND
 * the danger-full-access sandbox. That pair is the operator's standing consent
 * (the corrected model, 2026-09-28): a MAIN/root session in this mode
 * resolves every ask-policy call as allowed without a card, rails included. A
 * delegated child never uses this helper — its ask is forwarded to the parent.
 * @param approvalPolicy - the session's effective approval policy.
 * @param sandboxMode - the session's current sandbox mode.
 * @returns `true` only for the Full-access pair.
 */
export function isFullAccessMode(approvalPolicy: string | undefined, sandboxMode: string | undefined): boolean {
  return approvalPolicy === 'never' && sandboxMode === 'danger-full-access'
}

/** The allow reason a Full-access ask resolves with: the mode IS the consent. */
export const FULL_ACCESS_ASK_REASON = "approved by the session's Full access mode"

/** The dedicated reviewer-exec tool: fixed read-only test runs, reviewer seats only. */
export const REVIEW_RUN_TOOL = 'review_run'

/**
 * Role ids that hold {@link REVIEW_RUN_TOOL} when they ARE the session's
 * preset (root seats, switched seats). A delegated child does NOT carry its
 * role id — F's `childSessionMeta` copies the parent's composed preset — so
 * children are identified by {@link reviewerSeatOf}'s descriptor check
 * instead.
 */
export const REVIEW_ROLES: ReadonlySet<string> = new Set([
  'oracle', 'reviewer', 'critic', 'referee', 'chair', 'skeptic', 'architect', 'pragmatist',
])

/**
 * Descriptor-label prefixes the reviewer-spawning tools set on their child.
 * The label is authored by server-side spawn code (never model input), and
 * P-owned reviewer tools adopt it: `oracle_review` labels its child
 * `oracle review: …`; the generic delegation tool labels children
 * `<role>: <description>`. A future reviewer tool must add its prefix here.
 */
export const REVIEW_CHILD_LABEL_PREFIXES: readonly string[] = Object.freeze([
  'oracle review:', 'reviewer:', 'critic:', 'referee:', 'chair:', 'skeptic:', 'architect:', 'pragmatist:',
])

/** Reviewer personas as authored by the spawning reviewer tools (defense in depth when the label convention drifts). */
const REVIEW_CHILD_PERSONA = /^you are the (?:oracle|reviewer|critic|referee|chair|skeptic|architect|pragmatist)\b/i

/**
 * Tools a seat may never CALL, enforced at the pre-execute boundary.
 *
 * The presentation layer is the primary mechanism: the `creator` tool group in
 * the `enpoi-tool-groups` catalog belongs to the Creator seat alone
 * (`seats: ['creator']`) and pre-attaches nowhere, so orchestrator and sysadmin
 * never SEE `plugin_manager` or the two `cordis_inspect_*` tools — the group is
 * omitted from their advertised surface (their menu carries a seat-only notice
 * instead of an attach state; `groupVisibleTo`/`denyNames` in
 * `enpoi-tool-groups/catalog`). This table
 * is the EXECUTION backstop behind that structural absence — a call that
 * reaches the pre-execute boundary anyway (a stale composition, a direct
 * invocation path) is denied with the seat message. The cost is accepted and
 * documented: the creator tool group makes the main-agent tool arrays differ,
 * so a cross-agent switch rebuilds the provider's prompt prefix once; turns
 * within one seat keep the cached prefix. A seat absent from the table is
 * unrestricted; the orchestration document's `seatToolDeny` record replaces a
 * seat's shipped list when it names one.
 */
export const SHIPPED_SEAT_TOOL_DENY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  orchestrator: Object.freeze(['plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query']),
  sysadmin: Object.freeze(['plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query']),
})

/** Read one plain record from an unknown value. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * The effective execution deny list for one seat.
 * @param seat - the asking agent's role id (preset id for a main agent).
 * @param document - the orchestration document's `seatToolDeny` record, when configured.
 * @returns tool names the seat may not call; empty means unrestricted.
 */
export function seatToolDenyFor(seat: string | undefined, document: unknown): readonly string[] {
  if (seat === undefined || seat === '') return []
  const override = asRecord(document)?.[seat]
  if (Array.isArray(override)) {
    return [...new Set(override.filter((name): name is string => typeof name === 'string' && name !== ''))]
  }
  return SHIPPED_SEAT_TOOL_DENY[seat] ?? []
}

/**
 * Shipped per-seat tool policy: a seat's own default for one tool, consulted
 * after the operator's global `tools` rows and before the shipped global
 * table. Seat ids are role ids ({@link agentRoleOf}), the same key
 * {@link SHIPPED_SEAT_TOOL_DENY} uses.
 *
 * The orchestrator seat drives the device-to-device peer interconnect. The
 * peer family is the operator's own agent-to-agent surface: the pairing
 * document is human-authored, the tool group is on-demand, and the remote
 * host independently policies everything the request asks it to execute. An
 * unattended orchestrator turn must therefore not park on an approval card
 * for its own peer calls (operator principle: shipped defaults are fully
 * configured; observed live — `peer_status` carded the orchestrator on every
 * call). Every other seat keeps the family on the documented `peer_`
 * exemption, i.e. the unknown-tools ask: a seat with no pairing context has
 * no peer call to make, and an explicit operator row or grant still settles
 * the ask. A delegated child never inherits a seat default — its ask must
 * reach the parent-forwarding path like any other policy ask.
 */
export const SHIPPED_SEAT_TOOL_POLICY: Readonly<Record<string, Readonly<Record<string, PermissionPolicy>>>> = Object.freeze({
  orchestrator: Object.freeze({
    peer_status: 'allow',
    peer_sessions: 'allow',
    peer_ask: 'allow',
    peer_asks: 'allow',
    peer_answer: 'allow',
    peer_cancel: 'allow',
  }),
})

/** Shipped global defaults (user-editable via settings; absent keys fall here). */
export const SHIPPED_TOOL_DEFAULTS: Record<string, PermissionPolicy> = {
  read: 'allow', glob: 'allow', grep: 'allow', read_image: 'allow',
  // Web access is read-only retrieval; an unattended research run must not
  // park on an approval card (operator decision 2026-10-04). The provider
  // layer still fails loudly on a missing or invalid key.
  web_search: 'allow', web_fetch: 'allow',
  // The shipped research custom tools (doc 88): local URL archiving and
  // mechanical claim verification. Both are local and read-only; they exist
  // only where the operator defines the customTools rows.
  'custom_research-fetch': 'allow', 'custom_research-verify': 'allow',
  todo_write: 'allow',
  run_code: 'allow',
  memory_search: 'allow', memory_save: 'allow', memory_rescind: 'allow', memory_confirm: 'allow',
  oracle_review: 'allow', request_evidence: 'allow',
  roundtable: 'allow', chorus: 'allow', subagent: 'allow', task: 'allow',
  job_output: 'allow', job_list: 'allow', job_kill: 'ask',
  skill: 'allow', ask_user_question: 'allow',
  // MCP lifecycle (on-demand mounting): `list` is read-only, and mount/unmount
  // only touch servers the operator already configured and allowed, scoped to
  // the calling session and reversible. The mounted server's OWN tools keep
  // their own rows (unknownTools = ask), so the dangerous surface still asks.
  mcp: 'allow',
  // Read-only introspection: an unattended peer/driver run must be able to look
  // at its own session, diagnostics, and history without parking on an ask
  // nobody is there to answer (observed live: session_debug parked a turn).
  // Mutations keep their policy — registering a council, writing the board, or
  // any execution still asks.
  session_debug: 'allow', diagnostics_report: 'allow', fast_report: 'allow',
  session_search: 'allow', session_trace: 'allow',
  session_event_search: 'allow', session_event_read: 'allow', session_event_trace: 'allow',
  council_list: 'allow',
  // Fleet recovery (doc 07): the orchestrator continues a child that stopped
  // before its end result — the settlement notice names its session id and
  // reason. Messaging and listing its own children is core orchestration;
  // stopping a child stays an ask, like killing a background job.
  send_message: 'allow', list_agents: 'allow', interrupt_agent: 'ask',
  // The whiteboard is permanent core orchestrator context (doc 66 §3c/§67 §B):
  // its five per-feature asks fold into ONE family policy (the curated
  // `whiteboard_*` row in the Permissions UI, permissions-model.ts
  // POLICY_FAMILIES). Operator decision 2026-09-26 after granting read/write/
  // pin/unpin per feature; existing standing grants stay on record but are no
  // longer needed to absorb an ask.
  whiteboard_read: 'allow', whiteboard_write: 'allow', whiteboard_pin: 'allow',
  whiteboard_unpin: 'allow', whiteboard_forget: 'allow',
  edit: 'allow', write: 'allow',
  bash: 'ask',
  str_replace_editor: 'ask',
  // Delivery only declares deliverables; no filesystem or network effect. An
  // unattended run must not park on the unknown-tools ask for it. Availability
  // (per-role tools.available / restrict) still gates which agents hold it.
  present: 'allow',
  // Integrated session/orchestration state (operator decision 2026-10-02):
  // goals, planning mode, and the delegation drivers act on this session's own
  // state or on child sessions the same agent already spawns — no filesystem,
  // network, or fleet effect beyond the integrated loop, so they must not park
  // an unattended run on an approval card. Observed live: the goal tools
  // carded the orchestrator for state it owns.
  create_goal: 'allow', get_goal: 'allow', update_goal: 'allow',
  exit_plan_mode: 'allow',
  ralph: 'allow', workflow: 'allow',
  // On-demand tool groups: list/attach/detach session-scoped tool families.
  // Attach/detach only decide which advertised rows this session MAY call —
  // every row keeps its own policy — and both directions are reversible.
  tool_groups: 'allow',
  // Harness introspection is read-only. The creator tool group keeps it off
  // the orchestrator and sysadmin advertised surfaces; this default decides
  // the creator seat (and any future seat that advertises the tools).
  cordis_inspect_list: 'allow', cordis_inspect_query: 'allow',
  // Harness authoring: the creator tool group presents it to the creator seat
  // alone, and the seat table in this file backs that absence at pre-execute
  // (orchestrator/sysadmin get the seat denial if a call somehow arrives). The
  // creator persona advertises this tool as its specialty; carding the seat
  // whose job is the change itself contradicts self-sufficiency.
  plugin_manager: 'allow',
  // Council registration writes the shared council registry (spawn specs,
  // personas, routes) — a genuine cross-session mutation, so it stays an
  // explicit ask instead of silently riding defaults.unknownTools.
  council_register: 'ask',
}

/**
 * Tool-name families deliberately left to `defaults.unknownTools` (shipped
 * 'ask') instead of an explicit row above. The completeness guard
 * (`tests/tool-defaults-completeness.spec.ts`) requires every tool in the tool-inventory
 * fixtures to have an explicit SHIPPED_TOOL_DEFAULTS row OR match one of these
 * prefixes, so a new first-party or plugin tool cannot silently fall through
 * unaccounted; adding a tool means deciding its default or documenting a new
 * family exemption here.
 */
export const SHIPPED_TOOL_DEFAULT_EXEMPTIONS: readonly { prefix: string; except?: readonly string[]; reason: string }[] = Object.freeze([
  {
    prefix: 'custom_',
    except: ['custom_research-fetch', 'custom_research-verify'],
    reason: 'operator-defined custom tools are configured per tool; each renders a command that runs through the bash evaluator, and until the operator sets a row the unknown-tools ask is the intended gate. The first-party research tools (doc 88) are the documented exception: their commands are fixed, local, and read-only, and they carry explicit allow rows above so an unattended research run never parks on a card',
  },
  {
    prefix: 'mcp__',
    reason: 'tools of mounted MCP servers are third-party surface; the MCP wildcard ladder and the unknown-tools ask gate them until the operator trusts a row or a server wildcard',
  },
  {
    prefix: 'peer_',
    reason: 'first-party on-demand fleet tools (peer_ask, peer_asks, peer_answer, peer_cancel, peer_status) mount from enpoi-peer-bridge only while the peer driver runs; a call reaches another device\'s agent, so until the operator sets a row the unknown-tools ask is the intended gate',
  },
])

export const SHIPPED_BASH_PATTERNS: BashPattern[] = [
  { pattern: 'git *', policy: 'allow' },
  { pattern: 'rm', policy: 'ask' },
  { pattern: 'rm *', policy: 'ask' },
  { pattern: 'rmdir', policy: 'ask' },
  { pattern: 'rmdir *', policy: 'ask' },
  { pattern: 'unlink', policy: 'ask' },
  { pattern: 'unlink *', policy: 'ask' },
  { pattern: 'dd*', policy: 'ask' },
  { pattern: 'mkfs*', policy: 'ask' },
  { pattern: 'fdisk', policy: 'ask' },
  { pattern: 'fdisk *', policy: 'ask' },
  { pattern: 'shutdown', policy: 'ask' },
  { pattern: 'reboot', policy: 'ask' },
  { pattern: 'poweroff', policy: 'ask' },
  { pattern: 'halt', policy: 'ask' },
  { pattern: 'chmod -R *', policy: 'ask' },
  { pattern: 'chown -R *', policy: 'ask' },
  // Irreversible destruction (2026-10-02): secure erase, in-place truncation,
  // and find's own delete/exec forms. `shred` and `truncate` are danger-list
  // verbs, so their cards name the verb's broad action; the find forms are
  // ordinary rules because find itself is a read-only walker.
  { pattern: 'shred', policy: 'ask' },
  { pattern: 'shred *', policy: 'ask' },
  { pattern: 'truncate', policy: 'ask' },
  { pattern: 'truncate *', policy: 'ask' },
  { pattern: 'find * -delete*', policy: 'ask' },
  { pattern: 'find * -exec rm*', policy: 'ask' },
  { pattern: 'find * -execdir rm*', policy: 'ask' },
  // The OpenCode catch-all: every command not explicitly listed runs free.
  // Only the dangerous list above asks.
  { pattern: '*', policy: 'allow' },
]

/**
 * Split a bash command into top-level sub-commands (Oracle amendment 3):
 * separators `&&`, `||`, `;`, `|`, and newlines at quote depth 0. Quoted
 * segments never split.
 */
export function splitCompoundCommand(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      current += ch
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      i += 1
      continue
    }
    if (ch === '\n') {
      parts.push(current)
      current = ''
      i += 1
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      parts.push(current)
      current = ''
      i += 2
      continue
    }
    if (ch === ';' || ch === '|') {
      parts.push(current)
      current = ''
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  parts.push(current)
  return parts.map(p => p.trim()).filter(p => p.length > 0)
}

/** Strip leading unquoted KEY=VAL environment assignments. */
export function stripEnvPrefixes(subCommand: string): string {
  const tokens = subCommand.trim().split(/\s+/)
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i += 1
  return i > 0 ? tokens.slice(i).join(' ') : subCommand.trim()
}

/** A shell word's version stem (`mkfs.ext4` → `mkfs`; `rm` → `rm`). */
function versionStem(word: string): string {
  return word.includes('.') ? word.slice(0, word.indexOf('.')) : word
}

/**
 * One pattern against ONE (env-stripped) sub-command:
 * - bare token (`rm`, no space, no star): the command word matches exactly,
 *   compared by basename for a path-less pattern (`/bin/rm` is the `rm` rule)
 * - trailing star binds to ARGUMENTS, never the argv0 prefix (`rm*` ≡ `rm`;
 *   `rmdir` stays a separate token — matching the OpenCode list semantics) and
 *   a version suffix normalizes for membership (`mkfs*` catches `mkfs.ext4`)
 * - pattern containing a space: glob over the full sub-command string, the
 *   command word compared by basename for a path-less pattern
 * - a pattern that names a path (`/usr/bin/rm`) keeps literal matching
 */
export function matchBashPattern(pattern: string, subCommand: string): boolean {
  const p = pattern.trim()
  if (p === '*') return true
  const tokens = subCommand.split(/\s+/)
  const argv0 = tokens[0] ?? ''
  const patternWord = p.split(/\s+/)[0] ?? ''
  const commandWord = patternWord.includes('/') ? argv0 : baseName(argv0)
  const normalized = commandWord === argv0 ? subCommand : `${commandWord}${subCommand.slice(argv0.length)}`
  if (!p.includes(' ') && !p.includes('*')) return commandWord === p
  if (p.endsWith('*') && !p.slice(0, -1).includes(' ')) {
    const stem = p.slice(0, -1)
    return commandWord === stem || versionStem(commandWord) === versionStem(stem)
  }
  const rx = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '[\\s\\S]*' : `\\${ch}`))}$`)
  return rx.test(normalized)
}

function policyToDecision(policy: PermissionPolicy, subject: string, source: string): PolicyDecision {
  if (policy === 'deny') return { kind: 'deny', reason: `operator policy denies ${subject}`, source }
  if (policy === 'ask') return { kind: 'ask', reason: `operator policy asks for ${subject} — approve once or always`, source, grantTier: 'tool' }
  return { kind: 'allow', source }
}

/**
 * The mounted server name of one catalog entry: the name the mcp-client
 * registers tools under and the client's permission grouping keys rows by
 * (`serverName ?? id minus the standard -mcp suffix`).
 */
export function mcpServerNameOf(id: string, def?: { serverName?: string } | undefined): string {
  return typeof def?.serverName === 'string' && def.serverName !== '' ? def.serverName : id.replace(/-mcp$/, '')
}

/**
 * The server segment of one MCP public tool name (`mcp__<server>__<tool>`).
 * A known catalog server whose mounted name prefixes the tool name wins,
 * longest first — a server id may itself contain `__`, so `mcp__a__b__tool`
 * belongs to `a__b`, not `a`. The `__` split is only the fallback for a
 * server that left the catalog, exactly like the client's row grouping.
 */
export function mcpServerSegment(toolName: string, knownServers?: readonly string[]): string | undefined {
  if (toolName.startsWith('mcp__') && knownServers !== undefined) {
    const known = knownServers
      .filter(server => server !== '' && toolName.startsWith(`mcp__${server}__`))
      .sort((left, right) => right.length - left.length)[0]
    if (known !== undefined) return known
  }
  const parts = toolName.split('__')
  return parts.length >= 3 ? parts[1] : undefined
}

/** MCP wildcard ladder: exact → server (`mcp__server__*`) → family (`mcp__*`) → `*`. */
export function mcpLadder(
  toolName: string,
  table: Record<string, PermissionPolicy> | undefined,
  knownServers?: readonly string[],
): PolicyDecision | null {
  if (table === undefined) return null
  const check = (key: string): PolicyDecision | null => {
    const policy = table[key]
    if (policy === undefined) return null
    if (policy === 'deny') {
      return { kind: 'deny', reason: `operator policy denies ${toolName}`, source: `matrix:${key}` }
    }
    if (policy === 'ask') {
      return { kind: 'ask', reason: `operator policy asks for ${key}`, source: `matrix:${key}`, grantTier: 'tool' }
    }
    return { kind: 'allow', source: `matrix:${key}` }
  }
  const exact = check(toolName)
  if (exact !== null) return exact
  const server = mcpServerSegment(toolName, knownServers)
  if (server !== undefined) {
    const hit = check(`mcp__${server}__*`)
    if (hit !== null) return hit
  }
  if (toolName.startsWith('mcp__')) {
    const family = check('mcp__*')
    if (family !== null) return family
  }
  return null
}

/**
 * Grants matching this ask's granularity: a pattern-level grant never bleeds
 * into a tool-level ask and vice versa. A recorded `agent` scopes the grant
 * unless the grant is marked `global` (host-written "Always allow" grants
 * record the asking agent for audit but cover all agents).
 */
export function grantsShortCircuit(
  toolName: string,
  agent: string | undefined,
  grants: Record<string, StandingGrant> | undefined,
  tier: 'pattern' | 'tool',
  pattern: string | undefined,
): boolean {
  if (grants === undefined) return false
  for (const grant of Object.values(grants)) {
    if (grant.tool !== toolName) continue
    if (tier === 'pattern') {
      if (grant.pattern !== pattern) continue
    } else {
      if (grant.pattern !== undefined) continue
    }
    if (grant.global !== true && grant.agent !== undefined && grant.agent !== agent) continue
    return true
  }
  return false
}

/**
 * Shell constructs that can hide a command from per-sub-command evaluation:
 * command substitution, backticks, wrapper shells, eval, xargs, find -exec,
 * process substitution, heredocs.
 */
const HIDDEN_SURFACE = /\$\(|`|\bbash\s+-c\b|\bsh\s+-c\b|\beval\b|\bxargs\b|-exec(?:dir)?\b|<\(|<</

/**
 * Dangerous verbs in raw text, used ONLY when a hidden surface is present — a
 * plain `git rm` never trips this because its sub-command is evaluated
 * structurally and matched by `git *`.
 */
const DANGER_VERB_SET: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'unlink', 'dd', 'mkfs', 'fdisk', 'sfdisk', 'parted', 'shutdown',
  'reboot', 'poweroff', 'halt', 'wipefs', 'shred', 'chmod', 'chown', 'mount',
  'umount', 'kill', 'pkill', 'killall', 'truncate',
])

/**
 * The first danger-list verb appearing as a stand-alone shell word in one text
 * span, or `undefined` when there is none. This is a token scan, not a
 * word-boundary regex: surrounding shell punctuation (quotes, `$(`, backticks,
 * `;`, `|`, redirects, parentheses) is stripped, a leading `-` marks a flag and
 * is never a verb, and the basename is matched so `/bin/rm` counts. A version
 * suffix normalizes for membership but the spelling is kept (`mkfs.ext4` →
 * `mkfs.ext4`). A flag fragment (`uname -rm`, `--rm`) and an ordinary argument
 * expansion (`echo "$HOME"`) are therefore not verbs.
 * @param text - one sub-command or wrapper-inner segment.
 * @returns the verb as spelled, or undefined.
 */
export function dangerVerbInText(text: string): string | undefined {
  for (const token of text.split(/\s+/)) {
    const cleaned = token.replace(/^[^A-Za-z0-9_/.-]+/, '').replace(/[^A-Za-z0-9_.-]+$/, '')
    if (cleaned === '' || cleaned.startsWith('-')) continue
    const base = cleaned.slice(cleaned.lastIndexOf('/') + 1)
    if (base === '') continue
    const normalized = base.includes('.') ? base.slice(0, base.indexOf('.')) : base
    if (DANGER_VERB_SET.has(normalized)) return base
  }
  return undefined
}

/**
 * The danger-list verb a bash rule pattern asks for, or `undefined` for an
 * ordinary rule. The verb is the pattern's argv0 without a trailing star
 * (`rm`/`rm *` → `rm`, `dd*` → `dd`, `chmod -R *` → `chmod`); a versioned
 * binary normalizes for membership but keeps its spelling as the label.
 * @param pattern - one bash rule pattern.
 * @returns the verb label when the rule is a danger-list rail, else undefined.
 */
export function dangerVerbOfPattern(pattern: string): string | undefined {
  const trimmed = pattern.trim()
  if (trimmed === '' || trimmed === '*') return undefined
  const argv0 = (trimmed.split(/\s+/)[0] ?? '').replace(/\*+$/, '')
  if (argv0 === '' || argv0.includes('/')) return undefined
  const base = argv0.includes('.') ? argv0.slice(0, argv0.indexOf('.')) : argv0
  return DANGER_VERB_SET.has(base) ? argv0 : undefined
}

/**
 * The pattern-ask shape carrying a danger-list verb's broad-action offer. For a
 * danger-list rule the card copy names the exact scope of both actions: the
 * default "Always allow" pins ONLY this exact command, and every-command
 * coverage is the explicit "Allow all <verb>" opt-in. An ordinary rule keeps
 * its historical copy — its default always pins the rule pattern.
 */
function patternAsk(pattern: string, reason: string, source: string): PolicyDecision {
  const verb = dangerVerbOfPattern(pattern)
  return {
    kind: 'ask',
    reason: verb === undefined
      ? reason
      : `${reason}; "Always allow" grants this exact command only, "Allow all ${verb}" grants every ${verb} command`,
    source,
    grantTier: 'pattern',
    pattern,
    ...verb !== undefined ? { broadAllow: { label: verb } } : {},
  }
}

/** Shell interpreters: a bare call, a script path, or an inline `-c` command can execute arbitrary code. */
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])

/** Interpreters where only the inline (-c/-e/--eval) form is opaque. */
const INLINE_INTERPRETERS = /^(?:python[0-9.]*|perl|ruby|node|deno|bun|php)$/

/** Source builtins: a bare `.`/`source` reads stdin; with a path it reads that file. */
const SOURCE_BUILTINS: ReadonlySet<string> = new Set(['source', '.'])

/** Interpreters whose invocation can execute arbitrary code. */
const OPAQUE_EXECUTORS = new Set([...SHELL_INTERPRETERS, 'eval', 'source', '.'])

/** Version/help flags: an interpreter invoked with ONLY these runs no user code. */
const VERSION_HELP_FLAGS: ReadonlySet<string> = new Set(['--version', '-V', '--help', '-h'])

/** Bound on nested wrapper inspection (`bash -c "bash -c '…'"`). */
const MAX_WRAPPER_DEPTH = 3

/** One sub-command's decision through the four tiers (no grants, no compound). */
function decideSubCommand(
  sub: string,
  config: PermissionPolicyConfig,
  agent: string | undefined,
): PolicyDecision {
  const agentCfg = agent !== undefined ? config.agents?.[agent] : undefined
  // 1. agent bashPatterns → 2. agent tools.bash → 3. global bashPatterns → 4. global tools.bash
  const agentPatterns = agentCfg?.bashPatterns
  if (agentPatterns !== undefined) {
    for (const { pattern, policy } of agentPatterns) {
      if (!matchBashPattern(pattern, sub)) continue
      if (policy === 'deny') return { kind: 'deny', reason: `bash rule "${pattern}" denies this command`, source: `agent pattern:${pattern}` }
      if (policy === 'ask') return patternAsk(pattern, `bash rule "${pattern}" requires approval`, `agent pattern:${pattern}`)
      return { kind: 'allow', source: `agent pattern:${pattern}` }
    }
  }
  const agentTool = agentCfg?.tools?.bash
  if (agentTool !== undefined) {
    if (agentTool === 'deny') return { kind: 'deny', reason: `agent policy denies bash`, source: `agent:${agent}` }
    if (agentTool === 'ask') return { kind: 'ask', reason: `agent policy asks for bash`, source: `agent:${agent}`, grantTier: 'tool' }
    return { kind: 'allow', source: `agent:${agent}` }
  }
  const globalPatterns = [...(config.bashPatterns ?? []), ...SHIPPED_BASH_PATTERNS]
  for (const { pattern, policy } of globalPatterns) {
    if (!matchBashPattern(pattern, sub)) continue
    if (policy === 'deny') return { kind: 'deny', reason: `bash rule "${pattern}" denies this command`, source: `pattern:${pattern}` }
    if (policy === 'ask') return patternAsk(pattern, `bash rule "${pattern}" requires approval`, `pattern:${pattern}`)
    return { kind: 'allow', source: `pattern:${pattern}` }
  }
  const globalTool = config.tools?.bash ?? SHIPPED_TOOL_DEFAULTS.bash ?? 'ask'
  if (globalTool === 'deny') return { kind: 'deny', reason: 'operator policy denies bash', source: 'matrix:global' }
  if (globalTool === 'ask') return { kind: 'ask', reason: 'operator policy asks for bash', source: 'matrix:global', grantTier: 'tool' }
  return { kind: 'allow', source: 'matrix:global' }
}

/** The basename of one shell word (`/usr/bin/bash` → `bash`). */
function baseName(word: string): string {
  return word.slice(word.lastIndexOf('/') + 1)
}

/**
 * Split a sub-command into shell words, honoring single/double quotes and
 * backslash escapes. Quotes are dropped and no expansion is performed: this is
 * a lexical read for recognizing interpreters and wrappers, never an execution
 * model.
 * @param sub - one sub-command.
 * @returns the words with quoting removed.
 */
function shellWords(sub: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < sub.length) {
    const ch = sub[i] as string
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      i += 1
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
        i += 1
        continue
      }
      if (ch === '\\' && (sub[i + 1] === '"' || sub[i + 1] === '\\')) {
        current += sub[i + 1]
        i += 2
        continue
      }
      current += ch
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < sub.length) {
      current += sub[i + 1]
      i += 2
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (current !== '') {
        words.push(current)
        current = ''
      }
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  if (current !== '') words.push(current)
  return words
}

/** Wrapper flags whose following word is a value, not the command. */
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  timeout: new Set(['-k', '--kill-after', '-s', '--signal']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-h', '--host', '-R', '--role', '-T', '--type', '-t', '--type']),
  doas: new Set(['-u', '--user', '-C', '--config']),
  nice: new Set(['-n', '--adjustment']),
}

/** Command prefixes the evaluator and the child rails see through. */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set(['timeout', 'env', 'sudo', 'doas', 'nice', 'command'])

/** The command word index plus the wrappers consumed to reach it. */
interface WrapperPrefix {
  /** Index of the effective command word (`words.length` when no command remains). */
  readonly end: number
  /** Wrapper command names consumed, in order (`sudo`, `env`, …). */
  readonly wrappers: readonly string[]
  /** True when the prefix is a `command -v`/`-V` query, which reports but never executes. */
  readonly query: boolean
}

/**
 * Index of the effective command word in a wrapper-prefixed word list and the
 * wrappers consumed. A leading `timeout [flags] <duration>`, `env [flags]
 * [KEY=VALUE]…`, or `sudo`/`doas`/`nice`/`command` prefix is skipped; the
 * value-taking flags of each wrapper are skipped with their argument, and an
 * unparsable prefix stops where it stands, which keeps the ask for the
 * unrecognized form.
 * @param words - the sub-command's shell words.
 * @param stopAtPrivilege - keep `sudo`/`doas` and everything after them (the child rails name the privilege class).
 * @returns the command-word index, consumed wrapper names, and query marker.
 */
function scanWrapperPrefix(words: string[], stopAtPrivilege = false): WrapperPrefix {
  const wrappers: string[] = []
  let query = false
  let i = 0
  while (i < words.length) {
    const argv0 = baseName(words[i] ?? '')
    if (!COMMAND_WRAPPERS.has(argv0)) break
    if (stopAtPrivilege && (argv0 === 'sudo' || argv0 === 'doas')) break
    wrappers.push(argv0)
    i += 1
    const valueFlags = WRAPPER_VALUE_FLAGS[argv0]
    while (i < words.length) {
      const word = words[i] ?? ''
      if (argv0 === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        i += 1
        continue
      }
      if (!word.startsWith('-')) break
      i += 1
      if (!word.includes('=') && (valueFlags?.has(word) ?? false)) i += 1
      if (argv0 === 'command' && (word === '-v' || word === '-V')) query = true
    }
    if (argv0 === 'timeout' && i < words.length) i += 1
  }
  return { end: i, wrappers, query }
}

/**
 * One sub-command with leading environment assignments and the transparent
 * command wrappers (`timeout`, `env`, `nice`, `command`) removed, so a scan sees
 * the command that will run. Privilege wrappers (`sudo`, `doas`) and everything
 * after them are kept: the child rails classify them as privilege-escalation
 * before any other class. The input is returned unchanged when no wrapper is
 * present.
 * @param sub - one env-stripped sub-command.
 * @returns the effective command text.
 */
export function effectiveCommandText(sub: string): string {
  const words = shellWords(sub)
  const prefix = scanWrapperPrefix(words, true)
  return prefix.end > 0 && prefix.end < words.length ? words.slice(prefix.end).join(' ') : sub
}

/** Whether one word is a pure expansion (`$CMD`, `${CMD}`, `$(cmd)`, `` `cmd` ``). */
function isExpansionWord(word: string | undefined): boolean {
  return word !== undefined && /^[$`]/.test(word)
}

/**
 * Whether every argument following the command word is a version/help flag
 * (and there is at least one).
 * @param words - the sub-command's shell words.
 * @param commandIndex - the effective command word's index.
 * @returns `true` only for a version/help-only invocation.
 */
function versionHelpOnly(words: string[], commandIndex: number): boolean {
  const args = words.slice(commandIndex + 1)
  return args.length > 0 && args.every(arg => VERSION_HELP_FLAGS.has(arg))
}

/** Whether an inline interpreter carries executable code (`-c`, `-e`, `--eval`). */
function hasInlineFlag(words: string[], commandIndex: number): boolean {
  return words.slice(commandIndex + 1).some(word => word === '-c' || word === '-e' || word === '--eval')
}

/**
 * What one bash call's recursive evaluation carries: the resolved policy
 * config, the asking agent, and the raw command. The raw command is the
 * exact-command pin every opaque/scan ask records, so an Always-allow grant
 * written for the full call keeps absorbing it.
 */
interface BashEvaluationContext {
  readonly config: PermissionPolicyConfig
  readonly agent: string | undefined
  readonly rawCommand: string
}

/** An opaque-executor ask pinned to the full raw command. */
function opaqueAsk(verb: string, ctx: BashEvaluationContext): PolicyDecision {
  return {
    kind: 'ask',
    reason: `command runs ${verb}, which can execute arbitrary code — approve explicitly; to read, decode, or search files use the read, grep, or glob tools instead`,
    source: 'scan:opaque-executor',
    grantTier: 'pattern',
    pattern: ctx.rawCommand,
  }
}

/** An expansion-as-command-word ask pinned to the full raw command. */
function opaqueExpansionAsk(ctx: BashEvaluationContext): PolicyDecision {
  return {
    kind: 'ask',
    reason: 'command word is a shell expansion, so the command it runs is opaque — approve explicitly; to read, decode, or search files use the read, grep, or glob tools instead',
    source: 'scan:opaque-expansion',
    grantTier: 'pattern',
    pattern: ctx.rawCommand,
  }
}

/** A hidden-surface danger ask pinned to the full raw command. */
function hiddenDangerAsk(ctx: BashEvaluationContext): PolicyDecision {
  return {
    kind: 'ask',
    reason: 'command embeds a shell expansion or wrapper containing a destructive verb — approve explicitly; to read file contents use the read tool (or grep/glob to search) instead',
    source: 'scan:hidden-danger',
    grantTier: 'pattern',
    pattern: ctx.rawCommand,
  }
}

/** A wrapper-only privilege escalation ask (`sudo -i`, `doas -s`) pinned to the full raw command. */
function privilegedShellAsk(ctx: BashEvaluationContext): PolicyDecision {
  return {
    kind: 'ask',
    reason: 'command opens a privileged shell through sudo/doas with no command word — approve explicitly',
    source: 'scan:privileged-shell',
    grantTier: 'pattern',
    pattern: ctx.rawCommand,
  }
}

/**
 * One sub-command's decision, including wrapper recursion. Rules first (agent
 * and global patterns) — a command wrapper (`timeout`, `env`, `sudo`, `doas`,
 * `nice`, `command`) is seen through, so the rules evaluate the command that
 * will actually run; a `command -v`/`-V` query reports a path and never
 * executes its operand. Then: an expansion as the command word asks (opaque
 * execution); a shell wrapper `<interp> -c '<inner>'` is split and evaluated by
 * the same rules (bounded by {@link MAX_WRAPPER_DEPTH}) and asks only when that
 * inner evaluation asks; a wrapper whose inner cannot be extracted statically
 * (missing, expansion, past the depth bound) keeps the pre-recursion ask. An
 * interpreter invoked with only version/help flags is allowed; a bare
 * interpreter, a shell script path, and inline `-c`/`-e` code still ask; a
 * hidden surface containing a stand-alone danger-list verb asks. An expansion
 * as an ordinary argument is not itself an ask — the segment's verb decides.
 * @param sub - one env-stripped sub-command.
 * @param depth - wrapper nesting already entered (0 at the top level).
 * @param ctx - config, agent, and the raw command for exact-command pins.
 * @returns the sub-command's decision.
 */
function evaluateSubCommand(sub: string, depth: number, ctx: BashEvaluationContext): PolicyDecision {
  const words = shellWords(sub)
  const prefix = scanWrapperPrefix(words)
  // `command -v`/`-V` only reports the operand's path; it never executes it.
  if (prefix.query) return { kind: 'allow', source: 'scan:command-query' }
  const rules = decideSubCommand(sub, ctx.config, ctx.agent)
  if (rules.kind === 'deny') return rules
  const effective = prefix.end > 0 && prefix.end < words.length ? words.slice(prefix.end).join(' ') : sub
  if (effective !== sub) {
    const wrapped = decideSubCommand(effective, ctx.config, ctx.agent)
    if (wrapped.kind === 'deny') return wrapped
    if (wrapped.kind === 'ask') return wrapped
  }
  if (rules.kind === 'ask') return rules
  // A privilege wrapper with no command word left (`sudo -i`, `doas -s`) opens
  // an interactive privileged shell; only a version/help probe is exempt.
  if (prefix.end >= words.length
    && prefix.wrappers.some(wrapper => wrapper === 'sudo' || wrapper === 'doas')
    && !words.some(word => VERSION_HELP_FLAGS.has(word))) {
    return privilegedShellAsk(ctx)
  }
  const commandIndex = prefix.end
  const argv0 = baseName(words[commandIndex] ?? '')
  if (isExpansionWord(words[commandIndex])) return opaqueExpansionAsk(ctx)
  if (SHELL_INTERPRETERS.has(argv0)) {
    const inlineIndex = words.findIndex((word, index) => index > commandIndex && word === '-c')
    if (inlineIndex !== -1) {
      const inner = words[inlineIndex + 1]
      if (inner === undefined || isExpansionWord(inner) || depth >= MAX_WRAPPER_DEPTH) return opaqueAsk(argv0, ctx)
      return evaluateCompound(inner, depth + 1, ctx)
    }
  }
  if ((SHELL_INTERPRETERS.has(argv0) || INLINE_INTERPRETERS.test(argv0) || SOURCE_BUILTINS.has(argv0))
    && versionHelpOnly(words, commandIndex)) {
    return { kind: 'allow', source: 'scan:interpreter-version' }
  }
  // `.`/`source` with a path reads that file; only the release-file idiom of
  // read-only probes (`. /etc/os-release`) allows — sourcing any other file
  // runs its code and stays opaque. A bare dotted invocation reads stdin.
  if (SOURCE_BUILTINS.has(argv0)) {
    const target = words[commandIndex + 1]
    return target !== undefined && /^\/etc\/[^/]*release[^/]*$/.test(target)
      ? { kind: 'allow', source: 'scan:source-release' }
      : opaqueAsk(argv0, ctx)
  }
  if (OPAQUE_EXECUTORS.has(argv0)) return opaqueAsk(argv0, ctx)
  if (INLINE_INTERPRETERS.test(argv0) && hasInlineFlag(words, commandIndex)) return opaqueAsk(argv0, ctx)
  if (HIDDEN_SURFACE.test(sub) && dangerVerbInText(sub) !== undefined) return hiddenDangerAsk(ctx)
  // A plain allow keeps the tier that allowed it (agent rule, global rule, or
  // the catch-all), so the resolution source stays attributable.
  return rules
}

/**
 * Evaluate one command text (a full call or a wrapper inner): split the
 * compound at quote depth 0, env-strip each part, and aggregate — a deny
 * anywhere denies, the first ask wins, and every-sub-allowed allows.
 * @param command - the command text.
 * @param depth - wrapper nesting already entered.
 * @param ctx - config, agent, and the raw command for exact-command pins.
 * @returns the aggregate decision.
 */
function evaluateCompound(command: string, depth: number, ctx: BashEvaluationContext): PolicyDecision {
  let sawAsk: PolicyDecision | null = null
  let firstAllow: PolicyDecision | null = null
  for (const raw of splitCompoundCommand(command)) {
    const decision = evaluateSubCommand(stripEnvPrefixes(raw), depth, ctx)
    if (decision.kind === 'deny') return decision
    if (decision.kind === 'ask' && sawAsk === null) sawAsk = decision
    if (decision.kind === 'allow' && firstAllow === null) firstAllow = decision
  }
  if (sawAsk !== null) return sawAsk
  return firstAllow ?? { kind: 'allow', source: 'policy:all-subcommands-allowed' }
}

export interface PolicyResolutionInput {
  toolName: string
  /** The raw command (bash only). */
  command?: string
  /**
   * The rendered command of a custom tool (`custom_<id>`), supplied by the
   * enpoi-custom-tools seam. It runs through the identical sub-command danger
   * evaluation as bash, then the tool's own matrix row decides.
   */
  customCommand?: string
  /** The calling agent's name (role/persona id), when known. */
  agent?: string
  /**
   * Whether the caller is a reviewer/oracle seat per {@link reviewerSeatOf}.
   * Callers with the live agent object must compute this; role-less delegated
   * children can only be identified through their subagent descriptor.
   */
  reviewer?: boolean
  /**
   * Whether the caller is a delegated child session (a persisted
   * `parentSession`). A child's ask must reach the parent-forwarding path —
   * rails, then the parent's own policy or the card — so a config standing
   * grant never short-circuits it silently; the forwarder owns the child's
   * grant scope. The parent's own resolution (the rail ceiling) keeps
   * consulting grants.
   */
  delegated?: boolean
  config: PermissionPolicyConfig
  /** Effective sandbox mode; 'read-only' vetoes mutations. */
  sandboxMode?: string
  /** Mounted MCP server names (catalog `serverName ?? id - '-mcp'`) for the wildcard ladder. */
  mcpServerNames?: readonly string[]
}

/**
 * Every policy row belonging to one MCP server: the server wildcard
 * (`mcp__<server>__*`), any exact `mcp__<server>__<tool>` row, at the global
 * tier and under every agent override. `mcp__<server2>__*` never matches for
 * a different server because the `__` separator is part of the prefix.
 */
export function mcpPolicyRemovalOps(
  server: string,
  config: PermissionPolicyConfig | undefined,
): Array<{ op: 'unset'; path: string[] }> {
  const prefix = `mcp__${server}__`
  const ops: Array<{ op: 'unset'; path: string[] }> = []
  for (const key of Object.keys(config?.tools ?? {})) {
    if (key.startsWith(prefix)) ops.push({ op: 'unset', path: ['permissions', 'tools', key] })
  }
  for (const [agent, agentCfg] of Object.entries(config?.agents ?? {})) {
    for (const key of Object.keys(agentCfg?.tools ?? {})) {
      if (key.startsWith(prefix)) ops.push({ op: 'unset', path: ['permissions', 'agents', agent, 'tools', key] })
    }
  }
  return ops
}

/** The live agent slice `exec.agent` exposes to a policy listener. */
export interface AgentLike {
  agentPreset?: string
  preset?: string
  name?: string
  label?: string
  session?: {
    header?: { agentPreset?: string; meta?: { agentPreset?: string } }
    ownEvents?: () => readonly {
      type?: string
      data?: { agentPreset?: unknown; label?: unknown; persona?: unknown }
    }[]
  }
}

/**
 * The asking agent's role id for a live exec. Precedence: fields the runtime
 * exposes on the agent itself, the session's current-preset projection
 * (`agent-preset/selected` fold, via the injected reader), the session header
 * (creation-time preset — what a child role carries), then the latest logged
 * selection. Returns undefined when the agent is genuinely unidentified.
 */
export function agentRoleOf(
  agent: AgentLike | undefined,
  readCurrentPreset?: (session: unknown) => string | undefined,
): string | undefined {
  if (agent === undefined) return undefined
  for (const candidate of [agent.agentPreset, agent.preset, agent.name, agent.label]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  const session = agent.session
  if (session !== undefined && readCurrentPreset !== undefined) {
    try {
      const current = readCurrentPreset(session)
      if (typeof current === 'string' && current !== '') return current
    } catch {
      // Fall through to the durable header.
    }
  }
  const header = session?.header
  const created = typeof header?.agentPreset === 'string' && header.agentPreset !== ''
    ? header.agentPreset
    : header?.meta?.agentPreset
  if (typeof created === 'string' && created !== '') return created
  try {
    const events = session?.ownEvents?.() ?? []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const value = events[i]?.data?.agentPreset
      if (events[i]?.type === 'agent-preset/selected' && typeof value === 'string' && value !== '') return value
    }
  } catch {
    // An unreadable log has no evidence.
  }
  return undefined
}

/**
 * Whether the live caller is a reviewer/oracle seat. Two independent signals:
 * the role id ({@link agentRoleOf} — a root/switched seat), and, for a
 * delegated child, the NEWEST `subagent/descriptor` in its own log. Delegated
 * children inherit the PARENT's preset (F's `childSessionMeta` copies
 * `composedPreset(parent)`), so the role alone can never identify a reviewer
 * child; the descriptor is written by the spawning tool's own code and
 * reviewer tools label their children with
 * {@link REVIEW_CHILD_LABEL_PREFIXES}. The scan stops at the first (newest)
 * descriptor: a child gets exactly one at creation.
 * @param agent - the live caller.
 * @param readCurrentPreset - optional current-preset projection reader.
 * @returns true only for a reviewer/oracle seat.
 */
export function reviewerSeatOf(
  agent: AgentLike | undefined,
  readCurrentPreset?: (session: unknown) => string | undefined,
): boolean {
  const role = agentRoleOf(agent, readCurrentPreset)
  if (role !== undefined && REVIEW_ROLES.has(role)) return true
  const events = agent?.session?.ownEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'subagent/descriptor') continue
    const label = typeof event.data?.label === 'string' ? event.data.label.toLowerCase() : ''
    if (REVIEW_CHILD_LABEL_PREFIXES.some(prefix => label.startsWith(prefix))) return true
    const persona = typeof event.data?.persona === 'string' ? event.data.persona : ''
    return REVIEW_CHILD_PERSONA.test(persona)
  }
  return false
}

/**
 * The complete policy resolution for one tool call (doc 55, Oracle-amended).
 * Deny terminates at the first hit anywhere; grants only short-circuit an ask
 * at the granularity the ask arose at (a pattern ask is absorbed only by a
 */
export function resolvePolicy(input: PolicyResolutionInput): PolicyDecision {
  const { toolName, command, sandboxMode } = input
  const agent = input.agent ?? '(unknown)'

  // 0. read-only session veto (mutations cannot run in a read-only session).
  if (sandboxMode === 'read-only' && MUTATION_TOOLS.has(toolName)) {
    return { kind: 'deny', reason: `read-only session: ${toolName} mutations are blocked`, source: 'session:read-only' }
  }

  if (toolName === 'bash') {
    if (command === undefined || command.trim().length === 0) {
      return { kind: 'deny', reason: 'empty bash command', source: 'policy:empty' }
    }
    return evaluateCommandPolicy(command, input)
  }

  // Custom tools: the rendered command runs through the IDENTICAL sub-command
  // danger evaluation as bash (dangerous verbs, wrappers, interpreters), and
  // the tool's own matrix row decides the tool tier (defaults.unknownTools,
  // shipped 'ask'). Deny wins; either ask is surfaced with its own grant tier.
  if (input.customCommand !== undefined) {
    const commandDecision = evaluateCommandPolicy(input.customCommand, input)
    const toolDecision = resolveToolPolicy(toolName, input)
    if (commandDecision.kind === 'deny') return commandDecision
    if (toolDecision.kind === 'deny') return toolDecision
    if (commandDecision.kind === 'ask') {
      return { ...commandDecision, reason: `custom tool ${toolName}: ${commandDecision.reason}` }
    }
    if (toolDecision.kind === 'ask') return toolDecision
    return { kind: 'allow', source: commandDecision.source ?? toolDecision.source }
  }

  // The dedicated read-only test-run capability (reviewer-exec): a reviewer
  // seat never has to ask — the capability itself is the narrow, fixed surface.
  // Every other role is denied outright, so this grants nothing to workers.
  if (toolName === REVIEW_RUN_TOOL) {
    return input.reviewer === true || REVIEW_ROLES.has(agent)
      ? { kind: 'allow', source: 'review:seat' }
      : { kind: 'deny', reason: `review_run is available only to reviewer/oracle seats (role ${agent})`, source: 'review:seat' }
  }

  // Non-bash: agent override → global table → MCP wildcard ladder → default.
  return resolveToolPolicy(toolName, input)
}

/**
 * The sub-command danger evaluation shared by bash and custom tools: split the
 * compound command, evaluate every part, deny on the first deny, surface the
 * first ask (with its grant tier), and honor standing grants exactly as the
 * bash path always has.
 * @param command - the raw command string.
 * @param input - the resolution input (config, agent, grants).
 * @returns the command-level decision.
 */
export function evaluateCommandPolicy(command: string, input: PolicyResolutionInput): PolicyDecision {
  const subs = splitCompoundCommand(command)
  if (subs.length === 0) return { kind: 'deny', reason: 'empty command', source: 'policy:empty' }
  const evalCtx: BashEvaluationContext = { config: input.config, agent: input.agent, rawCommand: command }

  let sawAsk: PolicyDecision | null = null
  let firstAllow: PolicyDecision | null = null
  for (const raw of subs) {
    const sub = stripEnvPrefixes(raw)
    const subDecision = evaluateSubCommand(sub, 0, evalCtx)
    if (subDecision.kind === 'deny') {
      const suffix = subs.length > 1 ? ' (part of compound command)' : ''
      return { kind: 'deny', reason: `${subDecision.reason}${suffix}`, source: subDecision.source }
    }
    if (subDecision.kind === 'ask' && sawAsk === null) sawAsk = subDecision
    if (subDecision.kind === 'allow' && firstAllow === null) firstAllow = subDecision
  }
  if (sawAsk !== null) {
    const who = input.agent
    // A delegated child's ask is never absorbed by a config standing grant: it
    // must surface to the forwarder, which applies the rails and the parent's
    // own policy or card. A main session keeps the grant short-circuit.
    if (input.delegated !== true) {
      if (sawAsk.grantTier === 'pattern' && sawAsk.pattern !== undefined) {
        // A danger-list ask's default "always allow" pins the exact raw command
        // (broadAllow present); that exact pin re-allows exactly this command.
        if (sawAsk.broadAllow !== undefined
          && grantsShortCircuit(input.toolName, who, input.config.grants, 'pattern', command)) {
          return { kind: 'allow', source: 'grant:command' }
        }
        // The explicit broad action pins the rule-level pattern.
        if (grantsShortCircuit(input.toolName, who, input.config.grants, 'pattern', sawAsk.pattern)) {
          return { kind: 'allow', source: `grant:pattern:${sawAsk.pattern}` }
        }
      }
      if (sawAsk.grantTier === 'tool' && grantsShortCircuit(input.toolName, who, input.config.grants, 'tool', undefined)) {
        return { kind: 'allow', source: 'grant:tool' }
      }
    }
    return sawAsk
  }
  return { kind: 'allow', source: firstAllow?.source ?? 'policy:all-subcommands-allowed' }
}

/**
 * The non-bash tool-tier resolution: agent override → global table → MCP
 * wildcard ladder → `defaults.unknownTools` (shipped 'ask').
 * @param toolName - the tool being resolved.
 * @param input - the resolution input.
 * @returns the tool-tier decision.
 */
export function resolveToolPolicy(toolName: string, input: PolicyResolutionInput): PolicyDecision {
  const agent = input.agent ?? '(unknown)'
  const agentCfg = input.agent !== undefined ? input.config.agents?.[input.agent] : undefined
  const agentPolicy = agentCfg?.tools?.[toolName]
  if (agentPolicy !== undefined) {
    if (agentPolicy === 'deny') return { kind: 'deny', reason: `agent policy denies ${toolName}`, source: `agent:${agent}` }
    if (agentPolicy === 'ask') {
      if (input.delegated !== true && grantsShortCircuit(toolName, input.agent, input.config.grants, 'tool', undefined)) {
        return { kind: 'allow', source: 'grant:tool' }
      }
      return { kind: 'ask', reason: `agent policy asks for ${toolName}`, source: `agent:${agent}`, grantTier: 'tool' }
    }
    return { kind: 'allow', source: `agent:${agent}` }
  }
  // Agent-tier MCP wildcard ladder (e.g. if the agent has mcp__plane__* set).
  if (isMcpToolName(toolName) && agentCfg?.tools !== undefined) {
    const agentLadder = mcpLadder(toolName, agentCfg.tools, input.mcpServerNames)
    if (agentLadder !== null) return agentLadder
  }
  const operatorPolicy = input.config.tools?.[toolName]
  // A shipped seat default applies only to a main (non-delegated) seat the
  // operator has not overridden: operator rows outrank it, and a delegated
  // child's ask keeps its parent-forwarding path.
  const seatPolicy = input.delegated === true || input.agent === undefined
    ? undefined
    : SHIPPED_SEAT_TOOL_POLICY[input.agent]?.[toolName]
  const globalPolicy = operatorPolicy ?? seatPolicy ?? SHIPPED_TOOL_DEFAULTS[toolName]
  if (globalPolicy !== undefined) {
    const shippedSeat = seatPolicy !== undefined
    const source = shippedSeat ? `seat:${String(input.agent)}` : 'matrix:global'
    if (globalPolicy === 'deny') return { kind: 'deny', reason: shippedSeat ? `shipped seat policy denies ${toolName}` : `operator policy denies ${toolName}`, source }
    if (globalPolicy === 'ask') {
      if (input.delegated !== true && grantsShortCircuit(toolName, input.agent, input.config.grants, 'tool', undefined)) {
        return { kind: 'allow', source: 'grant:tool' }
      }
      return { kind: 'ask', reason: shippedSeat ? `shipped seat policy asks for ${toolName}` : `operator policy asks for ${toolName}`, source, grantTier: 'tool' }
    }
    return { kind: 'allow', source }
  }
  // MCP wildcard ladder at the global tier. When unconfigured, mounted MCP tools default to allow!
  if (isMcpToolName(toolName)) {
    const ladder = mcpLadder(toolName, input.config.tools, input.mcpServerNames)
    if (ladder !== null) return ladder
    return { kind: 'allow', source: 'defaults:mcp' }
  }
  const fallback: PermissionPolicy = input.config.defaults?.unknownTools ?? 'ask'
  if (fallback === 'deny') return { kind: 'deny', reason: `unconfigured tool ${toolName} denied by default`, source: 'defaults' }
  if (fallback === 'ask') {
    if (input.delegated !== true && grantsShortCircuit(toolName, input.agent, input.config.grants, 'tool', undefined)) {
      return { kind: 'allow', source: 'grant:tool' }
    }
    return { kind: 'ask', reason: `unconfigured tool ${toolName} requires approval (default)`, source: 'defaults', grantTier: 'tool' }
  }
  return { kind: 'allow', source: 'defaults' }
}

/**
 * The tool names an agent's model-facing surface keeps under its permission
 * policy. Only a tool that can never run is dropped: a `deny` resolution is
 * final — no user can answer it and the executor hard-denies every call — so
 * an explicitly denied tool is absent from the advertised surface rather than
 * shown and refused (the corrected model, 2026-09-28). An `ask` stays
 * visible because it is answerable: by the human card, by the parent (the
 * doc-55 forwarding path for a delegated child), or by the session's own
 * Full-access mode (the operator's standing consent). A grant resolves the
 * tool to `allow` in {@link resolvePolicy} and keeps it visible; `allow` tools
 * are out of scope here.
 * @param toolNames - the assembled wire tool names.
 * @param approvalPolicy - the agent's effective approval policy. Retained for
 * call-site clarity and future mode-specific rules; the deny filter above
 * applies under every mode (a deny is never answerable).
 * @param input - resolution context (agent role, permission config, sandbox, MCP catalog).
 * @returns the names to advertise, in input order.
 */
export function advertisedToolNames(
  toolNames: readonly string[],
  approvalPolicy: string | undefined,
  input: {
    agent?: string
    config: PermissionPolicyConfig
    sandboxMode?: string
    mcpServerNames?: readonly string[]
  },
): string[] {
  void approvalPolicy
  return toolNames.filter(toolName => !neverRunsTool(toolName, input))
}

/**
 * Whether one tool can never run for an agent: only a decision that stays
 * `deny` is impossible — a tool-level deny row, the unknown-tools deny
 * default, the read-only session veto, or a role-gated deny — because an `ask`
 * is answerable (human card, forwarded parent ask, or the session's own
 * Full-access mode). bash is judged by its tool-level row: its command-less
 * resolution is the empty-command guard, not a policy on bash itself.
 * @param toolName - the assembled wire tool name.
 * @param input - resolution context (agent role, permission config, sandbox, MCP catalog).
 * @returns whether the tool has no runnable path for that agent.
 */
function neverRunsTool(
  toolName: string,
  input: {
    agent?: string
    config: PermissionPolicyConfig
    sandboxMode?: string
    mcpServerNames?: readonly string[]
  },
): boolean {
  if (toolName === 'bash') {
    const agentBash = input.agent !== undefined ? input.config.agents?.[input.agent]?.tools?.bash : undefined
    const policy = agentBash ?? input.config.tools?.bash ?? SHIPPED_TOOL_DEFAULTS.bash ?? 'ask'
    return policy === 'deny'
  }
  const decision = resolvePolicy({
    toolName,
    agent: input.agent,
    config: input.config,
    sandboxMode: input.sandboxMode,
    mcpServerNames: input.mcpServerNames,
  })
  return decision.kind === 'deny'
}

/** True when toolName is an MCP-namespaced tool (mcp__server__tool). */
export function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith('mcp__')
}

/** The grant a host-side "allow always" should write for one ask (proposal). */
export interface GrantProposal {
  tool: string
  /**
   * The DEFAULT always-allow pin. For danger-list verbs and the opaque/hidden
   * scans this is the exact raw command; for an ordinary bash rule ask it is
   * the matched rule pattern (historical behavior).
   */
  pattern?: string
  /**
   * Present only when the ask offered the explicit broad action
   * ({@link PolicyDecision.broadAllow}): the rule-level pattern that action
   * pins ("allow all rm"). The default outcome must never write it.
   */
  broadPattern?: string
  /** The requesting agent (recorded on the grant; does not scope it). */
  agent?: string
}

/**
 * Derive the standing-grant proposal from an ask decision + call context.
 * A danger-list ask offers two pins: the default exact raw command and the
 * explicit broad rule pattern. Every other ask keeps its historical single
 * proposal (the rule pattern, or the exact command for the scans).
 */
export function grantProposalFor(decision: PolicyDecision & { kind: 'ask' }, toolName: string, command: string | undefined, agent: string | undefined): GrantProposal {
  if (decision.grantTier === 'pattern' && decision.pattern !== undefined) {
    if (decision.broadAllow !== undefined && command !== undefined && command.trim() !== '') {
      return { tool: toolName, pattern: command, broadPattern: decision.pattern, agent }
    }
    return { tool: toolName, pattern: decision.pattern, agent }
  }
  return { tool: toolName, agent }
}

/**
 * The proposal one host-side always-allow decision writes: the explicit broad
 * action writes the broad rule pattern when the ask offered one; every other
 * outcome (including a broad answer to an ask that offers none) writes the
 * default proposal.
 * @param proposal - the ask's stashed dual proposal.
 * @param broad - whether the decided outcome was the explicit broad action.
 * @returns the proposal to persist.
 */
export function grantProposalForOutcome(proposal: GrantProposal, broad: boolean): GrantProposal {
  if (!broad || proposal.broadPattern === undefined) return proposal
  return { tool: proposal.tool, pattern: proposal.broadPattern, ...proposal.agent !== undefined ? { agent: proposal.agent } : {} }
}

/**
 * The grant record one host-side "allow always" writes: global (applies to
 * every agent, matching the approval card), with the requesting agent kept on
 * the record for auditability and future per-agent scoping.
 */
export function standingGrantRecord(id: string, proposal: GrantProposal, createdAt: string): StandingGrant {
  return {
    id,
    tool: proposal.tool,
    ...(proposal.pattern !== undefined ? { pattern: proposal.pattern } : {}),
    ...(proposal.agent !== undefined ? { agent: proposal.agent } : {}),
    global: true,
    createdAt,
  }
}
