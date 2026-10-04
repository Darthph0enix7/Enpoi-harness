/**
 * dsh-enpoi-debug — bounded folds for the `session_debug` tool.
 *
 * Every preview the host already truncated is truncated again to the tool's
 * own budget, every list has a hard cap, and no fold copies a credential:
 * the digest carries none by contract, and the request-snapshot bodies are
 * read only behind the explicit `includeBodies` opt-in.
 *
 * @module dsh-enpoi-debug/fold
 */

import type {
  DigestFailure,
  DigestToolCall,
  DigestValue,
  IncidentListValue,
  PendingAsk,
  SnapshotValue,
} from './types.js'

/** Preview bound for one text field in the tool result. */
export const PREVIEW_CHARS = 240

/** Body bound when the caller explicitly opts into secret-bearing bodies. */
export const BODY_SYSTEM_CHARS = 4_000
/** Per-message body bound (last messages only). */
export const BODY_MESSAGE_CHARS = 600
/** How many trailing message bodies the opt-in returns. */
export const BODY_MESSAGE_COUNT = 6

/** Hard caps per section, independent of what the host returned. */
export const CAPS = Object.freeze({
  recentFailures: 5,
  recentTools: 10,
  injections: 15,
  subagents: 20,
  asks: 10,
  incidents: 10,
  snapshotMessages: 20,
  snapshotTools: 60,
})

/** Clamp `recentTools` into the host-supported 1..50 window (default 10). */
export function clampRecentTools(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 10
  return Math.min(Math.max(Math.trunc(numeric), 1), 50)
}

/** Truncate one preview, keeping whitespace collapsed and the mark explicit. */
export function preview(value: unknown, max = PREVIEW_CHARS): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const text = value.replaceAll(/\s+/g, ' ').trim()
  if (text === '') return undefined
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** One bounded tool-call row. */
export function foldToolCall(call: DigestToolCall): Readonly<Record<string, unknown>> {
  return {
    tool: call.tool,
    status: call.status,
    ...call.argumentPreview === undefined ? {} : { argumentPreview: preview(call.argumentPreview) },
    ...call.resultPreview === undefined ? {} : { resultPreview: preview(call.resultPreview) },
    ...call.error === undefined
      ? {}
      : {
        error: {
          name: call.error.name,
          code: call.error.code,
          ...call.error.reason === undefined ? {} : { reason: preview(call.error.reason) },
        },
      },
  }
}

/** One bounded pending-ask row. */
export function foldAsk(ask: PendingAsk): Readonly<Record<string, unknown>> {
  if (ask.kind === 'approval') {
    return {
      kind: 'approval',
      askId: ask.askId,
      toolName: ask.toolName,
      ...ask.callId === undefined ? {} : { callId: ask.callId },
      ...ask.reason === undefined ? {} : { reason: preview(ask.reason) },
      since: ask.since,
    }
  }
  return {
    kind: 'question',
    askId: ask.askId,
    since: ask.since,
    questions: ask.questions.slice(0, 5).map(question => ({
      id: question.id,
      question: preview(question.question),
      ...question.header === undefined ? {} : { header: preview(question.header, 80) },
      ...question.options === undefined
        ? {}
        : { options: question.options.slice(0, 8).map(option => ({ label: preview(option.label, 80) })) },
    })),
  }
}

/** One bounded attempt-failure row. */
export function foldFailure(failure: DigestFailure): Readonly<Record<string, unknown>> {
  return {
    seq: failure.seq,
    provider: failure.provider,
    model: failure.model,
    code: failure.code,
    message: preview(failure.message, 200),
    ...failure.link === undefined ? {} : { link: failure.link },
    ...failure.identity === undefined ? {} : { identity: preview(failure.identity, 60) },
    ...failure.next === undefined ? {} : { next: `${failure.next.provider}/${failure.next.model}` },
  }
}

/** One bounded digest projection. */
export function foldDigest(digest: DigestValue): Readonly<Record<string, unknown>> {
  const state = digest.state
  return {
    sessionId: digest.sessionId,
    latch: state.latch,
    since: state.since,
    source: state.source,
    activeDescendants: state.activeDescendants,
    descendantsExact: state.descendantsExact,
    model: digest.model ?? state.model ?? null,
    lastTurnEnd: state.lastTurnEnd ?? null,
    lastParticipantAction: state.lastParticipantAction ?? digest.lastParticipantAction ?? null,
    pendingInteractions: (digest.pendingInteractions ?? state.pendingAsks ?? [])
      .slice(0, CAPS.asks)
      .map(foldAsk),
    pendingAskCount: (digest.pendingInteractions ?? state.pendingAsks ?? []).length,
    recentFailures: (digest.recentFailures ?? []).slice(0, CAPS.recentFailures).map(foldFailure),
    recentFailureCount: (digest.recentFailures ?? []).length,
    recentToolCalls: digest.recentToolCalls.slice(0, CAPS.recentTools).map(foldToolCall),
    recentToolCallCount: digest.recentToolCalls.length,
    injectionIndex: digest.injectionIndex.slice(0, CAPS.injections).map(entry => ({
      kind: entry.kind,
      ...entry.label === undefined ? {} : { label: preview(entry.label, 120) },
      chars: entry.chars,
      seq: entry.seq,
    })),
    injectionCount: digest.injectionIndex.length,
    subagentTree: digest.subagentTree.slice(0, CAPS.subagents).map(child => ({
      childSessionId: child.childSessionId,
      mode: child.mode,
      quiet: child.quiet,
      status: child.status,
      ...child.queryPreview === undefined ? {} : { queryPreview: preview(child.queryPreview) },
    })),
    subagentCount: digest.subagentTree.length,
  }
}

/** One bounded snapshot projection; bodies only when already opted in. */
export function foldSnapshot(snapshot: SnapshotValue, includeBodies: boolean): Readonly<Record<string, unknown>> {
  const messages = snapshot.messages ?? []
  const totalChars = messages.reduce((sum, message) => sum + (message.chars ?? 0), 0)
  const tail = messages.slice(-CAPS.snapshotMessages)
  const bodyMessages = includeBodies && snapshot.bodies !== undefined
    ? snapshot.bodies.messages.slice(-BODY_MESSAGE_COUNT).map(message => preview(JSON.stringify(message), BODY_MESSAGE_CHARS))
    : undefined
  return {
    capturedAt: snapshot.capturedAt,
    provider: snapshot.provider,
    model: snapshot.model,
    bodiesIncluded: snapshot.bodiesIncluded,
    ...snapshot.bodiesOmitted === undefined ? {} : { bodiesOmitted: snapshot.bodiesOmitted },
    system: snapshot.system,
    tools: snapshot.tools.slice(0, CAPS.snapshotTools),
    toolCount: snapshot.tools.length,
    messageCount: messages.length,
    messageChars: totalChars,
    messageTail: tail.map(message => ({ role: message.role, chars: message.chars })),
    ...!includeBodies || snapshot.bodies === undefined
      ? {}
      : {
        bodies: {
          system: preview(snapshot.bodies.system ?? '', BODY_SYSTEM_CHARS) ?? null,
          tools: snapshot.bodies.tools.length,
          messages: bodyMessages,
        },
      },
  }
}

/** One bounded incidents projection, session-matching rows first. */
export function foldIncidents(incidents: IncidentListValue | undefined, sessionId: string): Readonly<Record<string, unknown>> | null {
  if (incidents === undefined) return null
  const items = incidents.items ?? []
  const matching = items.filter(item => item.sessionId === sessionId)
  const ordered = [...matching, ...items.filter(item => item.sessionId !== sessionId)]
  return {
    generatedAt: incidents.generatedAt,
    total: items.length,
    sessionMatches: matching.length,
    items: ordered.slice(0, CAPS.incidents).map(item => ({
      at: item.at,
      severity: item.severity,
      source: item.source,
      kind: item.kind,
      code: item.code,
      message: preview(item.message, 300),
      ...item.sessionId === undefined ? {} : { sessionId: item.sessionId },
    })),
  }
}

/** Normalize one thrown value into the gateway-shaped error the tool returns. */
export function errorFacts(error: unknown): { readonly code: string; readonly message: string } {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown; name?: unknown }
    const code = typeof candidate.code === 'string' && candidate.code !== '' ? candidate.code : undefined
    const message = typeof candidate.message === 'string' && candidate.message !== ''
      ? candidate.message
      : String(error)
    return { code: code ?? 'tool/error', message: preview(message, 400) ?? 'unknown failure' }
  }
  return { code: 'tool/error', message: preview(String(error), 400) ?? 'unknown failure' }
}
