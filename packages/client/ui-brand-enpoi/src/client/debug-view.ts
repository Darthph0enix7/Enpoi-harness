/**
 * Watchtower Live Debug — the browser reads behind the debug card.
 *
 * Wire contract (doc 70 §2): unary RPC `POST /api/<ns>/<method>` with
 * `{type:'client-request', rpcId, method, payload:{args:{request}}}`. The card
 * reads the same three surfaces `dsh-debug` reads: `session.digest`,
 * `session.requestSnapshot` (summary only; bodies never leave the host from
 * here), and `diagnostics.list`.
 *
 * The report builder below mirrors `~/.local/bin/dsh-debug.mjs`'s
 * `buildDebugReport` section-for-section so "Copy debug report" produces the
 * same markdown the CLI writes to disk.
 */

/** Bounded digest shape (structural subset of `session.digest`). */
export interface DebugTurnTerminal {
  readonly turn: number
  readonly reason: string
  readonly at: number
  readonly error?: { readonly code: string; readonly message: string }
}

export interface DebugPendingAsk {
  readonly kind: 'approval' | 'question'
  readonly askId: string
  readonly toolName?: string
  readonly reason?: string
  readonly since: number
  readonly questions?: readonly {
    readonly id: string
    readonly question: string
    readonly options?: readonly { readonly label: string; readonly description?: string }[]
  }[]
}

export interface DebugFailure {
  readonly seq: number
  readonly provider: string
  readonly model: string
  readonly code: string
  readonly message: string
  readonly link?: number
  readonly identity?: string
  readonly next?: { readonly provider: string; readonly model: string }
}

export interface DebugDigest {
  readonly sessionId: string
  readonly state: {
    readonly latch: string
    readonly since: number
    readonly source: string
    readonly activeDescendants: number
    readonly descendantsExact: boolean
    readonly lastTurnEnd?: DebugTurnTerminal
    readonly lastParticipantAction?: { readonly action: string; readonly actor: unknown; readonly at: number }
  }
  readonly model?: { readonly provider: string; readonly model: string; readonly chain?: string }
  /** Newer hosts send durable attempt failures; older ones omit the field. */
  readonly recentFailures?: readonly DebugFailure[]
  readonly recentToolCalls: readonly {
    readonly tool: string
    readonly status: string
    readonly argumentPreview?: string
    readonly resultPreview?: string
    readonly error?: { readonly name: string; readonly code: string; readonly reason?: string }
  }[]
  readonly injectionIndex: readonly { readonly kind: string; readonly label?: string; readonly chars: number; readonly seq: number }[]
  readonly subagentTree: readonly {
    readonly childSessionId: string
    readonly mode: string
    readonly quiet: boolean
    readonly status: string
    readonly queryPreview?: string
  }[]
  readonly pendingInteractions: readonly DebugPendingAsk[]
}

/** Request-snapshot summary shape (`session.requestSnapshot`, no bodies). */
export interface DebugSnapshot {
  readonly capturedAt: number
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly system: { readonly chars: number; readonly sha256: string } | null
  readonly tools: readonly string[]
  readonly messages: readonly { readonly role: string; readonly chars: number }[]
  readonly bodiesIncluded: boolean
}

/** One diagnostics incident row. */
export interface DebugIncident {
  readonly at: number
  readonly severity: string
  readonly source: string
  readonly kind: string
  readonly code: string
  readonly message: string
  readonly sessionId?: string
}

export interface DebugIncidentList {
  readonly generatedAt: number
  readonly items: readonly DebugIncident[]
}

/** One section's read outcome; the card degrades per section. */
export type DebugRead<T> =
  | { readonly phase: 'ready'; readonly value: T }
  | { readonly phase: 'error'; readonly code: string; readonly message: string }

/** Gateway error surfaced by an RPC call. */
export class DebugRpcError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'DebugRpcError'
  }
}

/** One unary Remote RPC; throws the gateway's code on failure. */
export async function debugRpc<T>(method: string, request: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `watchtower-debug-${method.replaceAll('/', '-')}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload: { args: { request } },
    }),
  })
  const text = await response.text()
  let frame: {
    result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
  }
  try {
    frame = JSON.parse(text) as typeof frame
  } catch {
    throw new DebugRpcError(`${method} returned non-JSON (HTTP ${String(response.status)})`, 'gateway/bad-response')
  }
  if (frame.result?.ok !== true) {
    throw new DebugRpcError(frame.result?.error?.message ?? `${method} failed`, frame.result?.error?.code ?? 'gateway/error')
  }
  return frame.result.value as T
}

/** Normalize one failed read into the card's error row. */
export function debugError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof DebugRpcError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'gateway/error', message: error.message }
  return { code: 'gateway/error', message: String(error) }
}

export async function readSessionDigest(sessionId: string, recentTools = 10): Promise<DebugDigest> {
  return await debugRpc<DebugDigest>('session.digest', { sessionId, recentTools })
}

export async function readRequestSnapshot(sessionId: string): Promise<DebugSnapshot> {
  return await debugRpc<DebugSnapshot>('session.requestSnapshot', { sessionId })
}

export async function readDiagnosticsIncidents(limit = 10): Promise<DebugIncidentList> {
  return await debugRpc<DebugIncidentList>('diagnostics.list', { limit })
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function escapeCell(value: unknown): string {
  const text = String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
  return text.length <= 180 ? text : `${text.slice(0, 180)}…`
}

/** The report document shared with `dsh-debug report` (same sections/order). */
export function buildDebugReportMarkdown(input: {
  readonly sessionId: string
  readonly generatedAt: number
  readonly digest: DebugDigest | null
  readonly snapshot: DebugSnapshot | null
  readonly incidents: DebugIncidentList | null
  readonly errors: readonly string[]
}): string {
  const { sessionId, generatedAt, digest, snapshot, incidents, errors } = input
  const lines: string[] = []
  lines.push('# Session debug report')
  lines.push('')
  lines.push(`- Session: \`${sessionId}\``)
  lines.push(`- Generated: ${iso(generatedAt)}`)
  lines.push('- Source: dsh-debug (doc 69 §9.1 read surface)')
  if (errors.length > 0) {
    lines.push('')
    for (const error of errors) lines.push(`> ERROR ${error}`)
  }
  lines.push('')
  if (digest === null) {
    lines.push('## Digest')
    lines.push('')
    lines.push('unavailable')
    return `${lines.join('\n')}\n`
  }
  const state = digest.state
  lines.push('## Execution state')
  lines.push('')
  lines.push(`- Latch: **${state.latch}** (since ${iso(state.since)})`)
  lines.push(`- Descendants: ${String(state.activeDescendants)}${state.descendantsExact ? ' (exact)' : ' (inexact)'}`)
  if (digest.model !== undefined) {
    const model = digest.model
    const chain = model.chain === undefined ? '' : ` (chain ${model.chain})`
    lines.push(`- Model: \`${model.provider}/${model.model}\`${chain}`)
  }
  if (state.lastParticipantAction !== undefined) {
    const action = state.lastParticipantAction
    const actor = JSON.stringify(action.actor)
    lines.push(`- Last participant action: ${action.action} by \`${actor}\` at ${iso(action.at)}`)
  }
  lines.push('')
  lines.push('## Last turn end')
  lines.push('')
  const last = state.lastTurnEnd
  if (last === undefined) lines.push('- none')
  else {
    lines.push(`- Turn ${String(last.turn)} \`${last.reason}\` at ${iso(last.at)}`)
    if (last.error !== undefined) lines.push(`- Error: \`${last.error.code}\` — ${last.error.message}`)
  }
  lines.push('')
  lines.push('## Pending asks')
  lines.push('')
  if (digest.pendingInteractions.length === 0) lines.push('- none')
  for (const ask of digest.pendingInteractions) {
    if (ask.kind === 'approval') {
      const tool = ask.toolName ?? '?'
      const reason = ask.reason === undefined ? '' : ` · ${ask.reason}`
      lines.push(`- \`approval\` ${ask.askId} · tool \`${tool}\`${reason} · since ${iso(ask.since)}`)
    } else {
      const questions = (ask.questions ?? []).map(question => question.question).join(' | ')
      lines.push(`- \`question\` ${ask.askId} · ${questions} · since ${iso(ask.since)}`)
    }
  }
  lines.push('')
  const failures = digest.recentFailures ?? []
  if (failures.length > 0) {
    lines.push(`## Recent failures (${String(failures.length)})`)
    lines.push('')
    for (const failure of failures) {
      const link = failure.link === undefined ? '' : ` link ${String(failure.link)}`
      const identity = failure.identity === undefined ? '' : ` identity ${failure.identity}`
      const next = failure.next === undefined ? '' : ` → next \`${failure.next.provider}/${failure.next.model}\``
      lines.push(`- \`${failure.provider}/${failure.model}\` \`${failure.code}\`${link}${identity}${next} — ${failure.message}`)
    }
    lines.push('')
  }
  lines.push(`## Recent tool calls (${String(digest.recentToolCalls.length)})`)
  lines.push('')
  lines.push('| # | tool | status | argument | result / error |')
  lines.push('|---|------|--------|----------|----------------|')
  for (const [index, call] of digest.recentToolCalls.entries()) {
    const outcome = call.status === 'error' && call.error !== undefined
      ? `\`${call.error.name}:${call.error.code}\` ${call.error.reason ?? ''}`
      : call.resultPreview ?? ''
    const cells = [String(index + 1), `\`${call.tool}\``, call.status, escapeCell(call.argumentPreview), escapeCell(outcome)]
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('')
  lines.push(`## Injection index (${String(digest.injectionIndex.length)})`)
  lines.push('')
  if (digest.injectionIndex.length === 0) lines.push('- none')
  else {
    lines.push('| seq | kind | label | chars |')
    lines.push('|-----|------|-------|-------|')
    for (const entry of digest.injectionIndex) {
      const cells = [String(entry.seq), `\`${entry.kind}\``, escapeCell(entry.label), String(entry.chars)]
      lines.push(`| ${cells.join(' | ')} |`)
    }
  }
  lines.push('')
  lines.push(`## Subagent tree (${String(digest.subagentTree.length)})`)
  lines.push('')
  if (digest.subagentTree.length === 0) lines.push('- none')
  for (const child of digest.subagentTree) {
    const query = child.queryPreview === undefined ? '' : ` — ${child.queryPreview}`
    lines.push(`- \`${child.childSessionId}\` mode=${child.mode} quiet=${String(child.quiet)} status=${child.status}${query}`)
  }
  lines.push('')
  lines.push('## Request snapshot')
  lines.push('')
  if (snapshot === null) lines.push('unavailable')
  else {
    lines.push(`- Captured: ${iso(snapshot.capturedAt)}`)
    lines.push(`- Provider/model: \`${snapshot.provider}/${snapshot.model}\``)
    const system = snapshot.system === null
      ? 'none'
      : `${String(snapshot.system.chars)} chars, sha256 \`${snapshot.system.sha256}\``
    lines.push(`- System: ${system}`)
    lines.push(`- Tools (${String(snapshot.tools.length)}): ${snapshot.tools.map(name => `\`${name}\``).join(', ')}`)
    const total = snapshot.messages.reduce((sum, message) => sum + message.chars, 0)
    lines.push(`- Messages: ${String(snapshot.messages.length)} (${String(total)} chars)`)
    const tail = snapshot.messages.slice(-12)
    lines.push('')
    lines.push('| # | role | chars |')
    lines.push('|---|------|-------|')
    for (const [index, message] of tail.entries()) {
      lines.push(`| ${String(snapshot.messages.length - tail.length + index)} | ${message.role} | ${String(message.chars)} |`)
    }
  }
  lines.push('')
  lines.push(`## Incidents (${String(incidents?.items.length ?? 0)})`)
  lines.push('')
  if (incidents === null) lines.push('unavailable')
  else if (incidents.items.length === 0) lines.push('- none')
  for (const incident of incidents?.items ?? []) {
    lines.push(`- [${incident.severity}] \`${incident.code}\` (${incident.source}/${incident.kind}) — ${incident.message}`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}
