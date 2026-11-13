/**
 * Input authority classification for the context keeper.
 *
 * The keeper reads one session log that mixes several producers on the same
 * `user` role: the human operator, compaction checkpoints, its own state
 * snapshots, and runtime-injected context. An explicit `participant.kind:
 * 'human'` in a root session is the only operator authority. A bare
 * `kind: 'user'` message is a public user-role request with an unverified
 * actor: it is preserved for display but is not operator evidence. Peer
 * messages, subagent-parent prompts, and every known non-`user` source kind
 * are derived; they are never human authority. This module names the
 * distinction once so the brief, claims, and checkpoint readers cannot
 * launder a synthetic message into operator text.
 *
 * Assistant extraction is deliberately public-text only: reasoning blocks are
 * never evidence, while public non-text blocks (images, files, tool requests)
 * survive as bounded markers so they are not silently dropped. A pre-fork
 * scalar `text` field is still readable, but is labelled unverified because it
 * did not come through the current content-block representation.
 *
 * Anchor validation reads the CURRENT model-visible surface, not the raw
 * append-only log: a reverted or replaced message is not authority just
 * because its event remains on disk. A raw `tool/call` is active only when an
 * active assistant message names its call id, and only the newest log-only
 * `state/checkpoint` is current.
 *
 * @module dsh-enpoi-context-keeper/authority
 */

import { SessionLogOffset, SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'

/** What one logged message is evidence OF. */
export type InputAuthority =
  | 'operator'
  | 'user-unverified'
  | 'derived-history'
  | 'derived-state'
  | 'derived-context'
  | 'assistant-public'
  | 'assistant-legacy'
  | 'tool-observed'
  | 'unattributed'

/**
 * The authority a `user/message` source resolves to.
 *
 * `operator` requires an explicit human participant in a root session.
 * `user-unverified` is a public user-role request whose actor was not
 * declared; keep it visible, but never quote it as operator authority.
 * Derived states are synthetic context; `unattributed` is a missing or
 * malformed source.
 */
export type UserMessageAuthority =
  | 'operator'
  | 'user-unverified'
  | 'derived-history'
  | 'derived-state'
  | 'derived-context'
  | 'unattributed'

/** Stable frame label for one classified `user/message` authority. */
const USER_AUTHORITY_LABELS: Readonly<Record<UserMessageAuthority, string>> = {
  'operator': 'OPERATOR',
  'user-unverified': 'USER_ROLE_UNVERIFIED',
  'derived-history': 'DERIVED_HISTORY',
  'derived-state': 'DERIVED_STATE',
  'derived-context': 'DERIVED_CONTEXT',
  'unattributed': 'UNATTRIBUTED_USER',
}

/**
 * Display label for one `user/message` authority.
 * @param authority - classified authority.
 * @returns the stable frame label.
 */
export function userAuthorityLabel(authority: UserMessageAuthority): string {
  return USER_AUTHORITY_LABELS[authority]
}

/** Classified `user/message` producer and participant facts. */
export interface UserSourceClass {
  authority: UserMessageAuthority
  /** Declared `source.kind`, or `unknown` when absent/malformed. */
  kind: string
  /** Participant kind when the producer declared one. */
  participant?: 'human' | 'peer'
}

/** Session-level facts that change who a `kind: 'user'` message speaks for. */
export interface UserSourceContext {
  /** A subagent child receives its task prompt from its parent, not the operator. */
  subagent?: boolean
}

/** Whether one session is a subagent child (its parent-authored prompts are derived context). */
export function isSubagentSession(session: Session): boolean {
  const header = session.header as { origin?: unknown } | undefined
  return header?.origin === 'subagent'
}

/** Result of public assistant-text extraction. */
export interface AssistantExtraction {
  /** Public text blocks joined with newlines; never reasoning text. */
  text: string
  /** True when the text came from the legacy scalar `text` field. */
  unverifiedLegacy: boolean
  /** Markers for public non-text blocks that must remain visible. */
  markers: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Classify one `user/message` source.
 *
 * An explicit `human` participant in a root session is operator authority. A
 * bare `user` producer is a public user-role request with an unverified actor:
 * it is preserved for display but is not operator authority. A `peer`
 * participant is another agent addressing this session, and a subagent child
 * receives parent-authored prompts, so both are derived context. Every
 * declared non-`user` producer kind is derived, never human. Missing or
 * malformed sources stay `unattributed` instead of defaulting to the human.
 * @param source - the logged `source` value (validated here because durable
 *   logs and pre-fork fixtures may carry legacy spellings).
 * @returns the classified producer and participant facts.
 */
export function classifyUserSource(source: unknown, context: UserSourceContext = {}): UserSourceClass {
  if (!isRecord(source)) return { authority: 'unattributed', kind: 'unknown' }
  const kind = typeof source['kind'] === 'string' ? source['kind'] : ''
  const participant = source['participant']
  let participantKind: 'human' | 'peer' | undefined
  if (isRecord(participant)) {
    const raw = participant['kind']
    if (raw === 'human' || raw === 'peer') participantKind = raw
  }
  const withParticipant = participantKind === undefined ? {} : { participant: participantKind }
  if (kind === 'user') {
    // A child session's user-role prompts come from the parent/synthetic
    // context, never from a human operator, even when a declared participant
    // says otherwise.
    if (context.subagent === true) return { authority: 'derived-context', kind, ...withParticipant }
    if (participantKind === 'human') return { authority: 'operator', kind, ...withParticipant }
    if (participantKind === 'peer') return { authority: 'derived-context', kind, ...withParticipant }
    return { authority: 'user-unverified', kind }
  }
  if (kind === 'compact-checkpoint') return { authority: 'derived-history', kind }
  if (kind === 'enpoi-keeper') return { authority: 'derived-state', kind }
  if (kind.length > 0) return { authority: 'derived-context', kind }
  return { authority: 'unattributed', kind: 'unknown' }
}

/** Whether a logged `user/message` source is a direct human operator message. */
export function isOperatorSource(source: unknown, context: UserSourceContext = {}): boolean {
  return classifyUserSource(source, context).authority === 'operator'
}

/**
 * Exact text blocks from one user-message content value.
 *
 * Each block stays a separate string so quote verification can be exact even
 * when a message carries several text blocks. No trimming, normalization, or
 * joining happens here — this is the data used to verify an operator quote.
 * @param content - the logged content (legacy string or content-block array).
 * @returns one entry per text block, in order.
 */
export function userTextParts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
  }
  return parts
}

/** One public non-text block marker, or '' for reasoning/unknown values. */
function publicBlockMarker(block: Record<string, unknown>): string {
  switch (block['type']) {
    case 'image':
      return '[image attachment]'
    case 'file':
      return '[file attachment]'
    case 'tool-call':
      return typeof block['name'] === 'string' ? `[tool call: ${block['name']}]` : '[tool call]'
    case 'tool-addition':
      return typeof block['toolName'] === 'string' ? `[tool addition: ${block['toolName']}]` : '[tool addition]'
    case 'tool-removal':
      return typeof block['toolName'] === 'string' ? `[tool removal: ${block['toolName']}]` : '[tool removal]'
    case 'reasoning':
      return ''
    default:
      return typeof block['type'] === 'string' ? `[${block['type']} block]` : ''
  }
}

/**
 * Display text for one user-message content value: text blocks plus markers for
 * public attachments/tool blocks. Operator quote verification uses
 * {@link userTextParts}, never this display form.
 * @param content - the logged content.
 * @returns display text (possibly empty).
 */
export function userDisplayText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text'])
      continue
    }
    const marker = publicBlockMarker(block)
    if (marker.length > 0) parts.push(marker)
  }
  return parts.join('\n').trim()
}

/** Normalize line endings for whole-line quote comparison. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Whether an operator quote is a complete source block or a complete line run
 * from ONE operator text block.
 *
 * A one-character line is valid when it is the whole line ("Go" is allowed); a
 * substring of a line is not ("e" inside "deploy now" is rejected). Separate
 * content blocks are never joined: a quote cannot be manufactured across a
 * block boundary. Line endings are normalized before comparison, but no other
 * whitespace normalization is applied.
 * @param parts - exact operator text blocks at one sequence.
 * @param quote - model-supplied quote.
 * @returns true only for a complete block or a contiguous complete-line run.
 */
export function operatorQuoteMatches(parts: readonly string[], quote: string): boolean {
  if (quote.trim().length === 0) return false
  const candidate = normalizeLineEndings(quote)
  for (const part of parts) {
    const source = normalizeLineEndings(part)
    if (source === candidate) return true
    const sourceLines = source.split('\n')
    const candidateLines = candidate.split('\n')
    if (candidateLines.length > sourceLines.length) continue
    for (let start = 0; start + candidateLines.length <= sourceLines.length; start += 1) {
      let matches = true
      for (let offset = 0; offset < candidateLines.length; offset += 1) {
        if (sourceLines[start + offset] !== candidateLines[offset]) {
          matches = false
          break
        }
      }
      if (matches) return true
    }
  }
  return false
}

/**
 * Extract only public assistant text from an `assistant/message` payload.
 *
 * The durable payload carries `{ message: { content } }`; the pre-fork fixture
 * spelling carries a scalar `text`. Public non-text blocks become markers, so
 * attachments and requested tool calls are not dropped. Reasoning blocks are
 * always absent.
 * @param data - the `assistant/message` event data.
 * @returns public text, the legacy flag, and public block markers.
 */
export function assistantPublicText(data: unknown): AssistantExtraction {
  if (!isRecord(data)) return { text: '', unverifiedLegacy: false, markers: [] }
  const message = data['message']
  if (isRecord(message) && Array.isArray(message['content'])) {
    const parts: string[] = []
    const markers: string[] = []
    for (const block of message['content']) {
      if (!isRecord(block)) continue
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        parts.push(block['text'])
        continue
      }
      const marker = publicBlockMarker(block)
      if (marker.length > 0) markers.push(marker)
    }
    const text = parts.join('\n').trim()
    if (text.length > 0 || markers.length > 0) return { text, unverifiedLegacy: false, markers }
  }
  if (typeof data['text'] === 'string' && data['text'].trim().length > 0) {
    return { text: data['text'].trim(), unverifiedLegacy: true, markers: [] }
  }
  return { text: '', unverifiedLegacy: false, markers: [] }
}

/**
 * Call ids named by one assistant message's public tool-call blocks.
 *
 * Only the canonical `tool-call` block type and its `id` field are read;
 * unknown block spellings or keys are not guessed.
 * @param data - the `assistant/message` event data.
 * @returns declared call ids in message order.
 */
export function assistantToolCallIds(data: unknown): string[] {
  if (!isRecord(data)) return []
  const message = data['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return []
  const ids: string[] = []
  for (const block of message['content']) {
    if (!isRecord(block) || block['type'] !== 'tool-call') continue
    const id = block['id']
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}

/** Canonical tool-result call id from the durable `message.toolCallId` field. */
function canonicalToolResultCallId(data: unknown): string | null {
  if (!isRecord(data)) return null
  const message = data['message']
  if (!isRecord(message)) return null
  const callId = message['toolCallId']
  return typeof callId === 'string' && callId.length > 0 ? callId : null
}

/**
 * Read one event by sequence without materializing the log.
 * @param session - the session to read.
 * @param seq - non-negative event sequence.
 * @returns the event, or undefined when the sequence is out of range.
 */
export function eventAtSeq(session: Session, seq: number): SessionEvent | undefined {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= session.seq) return undefined
  return session.eventAt(SessionSeq(seq))
}

/** One current-surface user-role message exposed for framing. */
export interface ActiveUserAnchor {
  /** Current surface event sequence. */
  readonly seq: number
  /** Classified authority; `user-unverified` is visible but not operator. */
  readonly authority: UserMessageAuthority
  /** Declared source kind, or `unknown`. */
  readonly kind: string
  /** Exact text blocks for quote verification. */
  readonly parts: readonly string[]
  /** Display text with public markers, for model input only. */
  readonly display: string
  /** Participant when the producer declared one. */
  readonly participant?: 'human' | 'peer'
}

/**
 * Authority-safe view of the CURRENT model-visible surface.
 *
 * Surface message nodes are active. A raw `tool/call` is active only when an
 * active assistant message names its call id, so calls from reverted branches
 * cannot anchor a draft. Only the newest log-only `state/checkpoint` is
 * current; older checkpoint events are abandoned history. First/last active
 * user anchors are bounded to one each and are intended for a partial-window
 * frame, not as a guarantee that all older context is carried.
 */
export interface ActiveAuthorityView {
  /** Current surface event sequences in model-visible order. */
  readonly activeSeqs: readonly number[]
  /** Newest `state/checkpoint` log sequence, or null. */
  readonly latestCheckpointSeq: number | null
  /** Earliest current-surface user-role message. */
  readonly firstUser: ActiveUserAnchor | null
  /** Newest current-surface user-role message. */
  readonly lastUser: ActiveUserAnchor | null
  /** Earliest current-surface known-human operator message. */
  readonly firstOperator: ActiveUserAnchor | null
  /** Newest current-surface known-human operator message. */
  readonly lastOperator: ActiveUserAnchor | null
  /**
   * Whether an anchor is current: a surface node, a paired raw tool call, or
   * the newest checkpoint.
   * @param seq - candidate event sequence.
   * @returns whether the sequence may anchor a draft.
   */
  isActive(seq: number): boolean
  /**
   * Current event for an anchor, or undefined for abandoned/unknown events.
   * @param seq - candidate event sequence.
   * @returns the active event.
   */
  eventAt(seq: number): SessionEvent | undefined
  /**
   * Exact operator text blocks at an active human-operator sequence.
   * @param seq - candidate event sequence.
   * @returns exact text blocks, or null for non-operator/inactive sequences.
   */
  operatorPartsAt(seq: number): readonly string[] | null
  /**
   * Active tool-result sequence for a call id.
   * @param callId - declared tool call id.
   * @returns the current surface result sequence, or undefined.
   */
  toolResultSeq(callId: string): number | undefined
}

/**
 * Build the current-surface authority view.
 *
 * The view scans the surface once; it does not reconstruct authority from raw
 * abandoned events. Unknown source keys or block spellings are not guessed.
 * A read failure propagates so the caller can fall back to the deterministic
 * template instead of accepting a partial authority view.
 * @param session - session whose current surface is read.
 * @param toExclusive - causal snapshot; only surface events before it are active.
 * @returns the active authority view.
 */
export function buildActiveAuthorityView(session: Session, toExclusive: number = session.seq): ActiveAuthorityView {
  const end = Number.isFinite(toExclusive) ? Math.max(0, Math.min(session.seq, Math.floor(toExclusive))) : session.seq
  const subagent = isSubagentSession(session)
  const activeSeqs: number[] = []
  const events = new Map<number, SessionEvent>()
  const assistantCalls = new Map<string, number>()
  const toolResults = new Map<string, number>()
  let firstUser: ActiveUserAnchor | null = null
  let lastUser: ActiveUserAnchor | null = null
  let firstOperator: ActiveUserAnchor | null = null
  let lastOperator: ActiveUserAnchor | null = null

  for (const rawSeq of session.surface.nodes) {
    const seq = Number(rawSeq)
    if (seq >= end) continue
    const event = eventAtSeq(session, seq)
    if (event === undefined) continue
    activeSeqs.push(seq)
    events.set(seq, event)
    if (event.type === 'user/message') {
      const data = event.data as { content?: unknown; source?: unknown }
      const source = classifyUserSource(data.source, { subagent })
      const anchor: ActiveUserAnchor = {
        seq,
        authority: source.authority,
        kind: source.kind,
        parts: userTextParts(data.content),
        display: userDisplayText(data.content),
        ...(source.participant === undefined ? {} : { participant: source.participant }),
      }
      if (firstUser === null) firstUser = anchor
      lastUser = anchor
      if (source.authority === 'operator') {
        if (firstOperator === null) firstOperator = anchor
        lastOperator = anchor
      }
    } else if (event.type === 'assistant/message') {
      for (const callId of assistantToolCallIds(event.data)) assistantCalls.set(callId, seq)
    } else if (event.type === 'tool/result') {
      const callId = canonicalToolResultCallId(event.data)
      if (callId !== null) toolResults.set(callId, seq)
    }
  }

  let latestCheckpointSeq: number | null = null
  for (let seq = end - 1; seq >= 0; seq -= 1) {
    const event = eventAtSeq(session, seq)
    if (String(event?.type) === 'state/checkpoint') {
      latestCheckpointSeq = seq
      break
    }
  }

  const pairedToolCall = (seq: number): SessionEvent | undefined => {
    const event = eventAtSeq(session, seq)
    if (event?.type !== 'tool/call') return undefined
    const callId = (event.data as { callId?: unknown }).callId
    return typeof callId === 'string' && assistantCalls.has(callId) ? event : undefined
  }
  const eventAt = (seq: number): SessionEvent | undefined => {
    if (seq >= end) return undefined
    const active = events.get(seq)
    if (active !== undefined) return active
    if (seq === latestCheckpointSeq) return eventAtSeq(session, seq)
    return pairedToolCall(seq)
  }

  return {
    activeSeqs,
    latestCheckpointSeq,
    firstUser,
    lastUser,
    firstOperator,
    lastOperator,
    isActive: (seq) => eventAt(seq) !== undefined,
    eventAt,
    operatorPartsAt: (seq) => {
      const event = events.get(seq)
      if (event === undefined || event.type !== 'user/message') return null
      const data = event.data as { content?: unknown; source?: unknown }
      if (classifyUserSource(data.source, { subagent }).authority !== 'operator') return null
      const parts = userTextParts(data.content)
      return parts.length === 0 ? null : parts
    },
    toolResultSeq: (callId) => toolResults.get(callId),
  }
}

/**
 * Exact operator text blocks from one visible input window.
 *
 * Use this to build `FramedInput.operatorMessages` from the same active view
 * and the same window sequences the model was shown. It never joins blocks or
 * guesses an inactive event.
 * @param view - active surface authority view.
 * @param windowSeqs - sequences in the model-visible input window.
 * @returns exact operator blocks keyed by sequence.
 */
export function activeOperatorMessages(
  view: ActiveAuthorityView,
  windowSeqs: Iterable<number>,
): ReadonlyMap<number, readonly string[]> {
  const out = new Map<number, readonly string[]>()
  for (const seq of windowSeqs) {
    const parts = view.operatorPartsAt(seq)
    if (parts !== null) out.set(seq, parts)
  }
  return out
}

/**
 * Exact operator text blocks at one sequence.
 * @param session - the session to read.
 * @param seq - the cited event sequence.
 * @param view - active-surface view; when supplied, abandoned events are
 *   rejected. Omit only for legacy callers that cannot yet build the view.
 * @returns the text blocks of a human operator `user/message`, or null for any
 *   other source, role, inactive event, or out-of-range sequence.
 */
export function operatorTextPartsAt(
  session: Session,
  seq: number,
  view?: ActiveAuthorityView,
): readonly string[] | null {
  if (view !== undefined) return view.operatorPartsAt(seq)
  const event = eventAtSeq(session, seq)
  if (event === undefined || event.type !== 'user/message') return null
  const data = event.data as { content?: unknown; source?: unknown }
  if (!isOperatorSource(data.source, { subagent: isSubagentSession(session) })) return null
  const parts = userTextParts(data.content)
  return parts.length === 0 ? null : parts
}

/**
 * The newest derived-state text (state checkpoint or prose update) up to a
 * causal snapshot sequence.
 *
 * A cursor makes the hot path read only the appended tail; the cold first read
 * is the single full scan. When a concurrent append pushed the cursor past the
 * requested snapshot, the bounded prefix is re-folded once so the caller never
 * receives a snapshot newer than its own call.
 * @param session - the session to read.
 * @param toExclusive - snapshot sequence captured before the caller's model call.
 * @returns the newest derived text with the sequence that produced it, or null.
 */
export function latestDerivedState(
  session: Session,
  toExclusive: number = session.seq,
): { text: string; seq: number } | null {
  const requested = Number.isFinite(toExclusive) ? Math.max(0, Math.floor(toExclusive)) : session.seq
  const limit = Math.min(session.seq, requested)
  const known = derivedStateCursors.get(session)
  if (known !== undefined && known.seq <= limit) {
    // The cache already covers the requested prefix; fold its tail if needed.
    if (known.seq === limit || known.seq > session.seq) return known.text.length > 0 ? known : null
  }
  const from = known !== undefined && known.seq < limit ? known.seq : 0
  let text = from === 0 ? '' : known?.text ?? ''
  let seq = from === 0 ? 0 : known?.seq ?? 0
  try {
    for (const event of session.snapshotEvents(SessionLogOffset(from), SessionLogOffset(limit))) {
      if (event.seq >= limit) break
      const eventType = String(event.type)
      if (eventType !== 'state/checkpoint' && eventType !== 'brief/prose-updated') continue
      const candidate = (event.data as Record<string, unknown>)['text']
      if (typeof candidate === 'string' && candidate.length > 0) {
        text = candidate
        seq = event.seq
      }
    }
  } catch {
    return known !== undefined && known.text.length > 0 ? known : null
  }
  derivedStateCursors.set(session, { seq: limit, text })
  return text.length > 0 ? { text, seq } : null
}

/** Per-session incremental cursor for {@link latestDerivedState}. */
const derivedStateCursors = new WeakMap<Session, { seq: number; text: string }>()

/**
 * Bounded event window used by the keeper's model input.
 * @param session - the session to read.
 * @param maxEvents - maximum events retained.
 * @param toExclusive - snapshot sequence captured before the model call.
 * @returns the window events and its half-open sequence range.
 */
export function boundedWindow(
  session: Session,
  maxEvents: number,
  toExclusive: number = session.seq,
): { events: readonly SessionEvent[]; startSeq: number; endSeq: number } {
  const requested = Number.isFinite(toExclusive) ? Math.max(0, Math.floor(toExclusive)) : session.seq
  const endSeq = Math.min(session.seq, requested)
  const size = Number.isFinite(maxEvents) ? Math.max(1, Math.floor(maxEvents)) : 80
  const startSeq = Math.max(0, endSeq - size)
  let events: readonly SessionEvent[] = []
  try {
    events = session.snapshotEvents(SessionLogOffset(startSeq), SessionLogOffset(endSeq))
      .filter((event) => event.seq >= startSeq && event.seq < endSeq)
  } catch {
    events = []
  }
  return { events, startSeq, endSeq }
}
