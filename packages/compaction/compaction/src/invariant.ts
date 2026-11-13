/** Package-owned compaction log-stream invariants. @module @deepseek-ai/dsh-compaction/invariant */

import type { Context } from '@deepseek-ai/cordis'
import { isReplacementSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SurfaceOp } from '@deepseek-ai/dsh-session'
import { SurfaceManager, type SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { CompactionId } from './brand.ts'
import { isCompactCheckpointSource } from './checkpoint.ts'
import type { CompactionCheckpointSource } from './checkpoint.ts'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-compaction'

/** Cordis companion plugin name. */
export const name = 'compaction-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface CompactionTrace {
  compactionId: CompactionId
  sourceCommandId: string | undefined
  startSeq: SessionSeq
  turn: number | null
  summarized: boolean
}

interface SessionTrace {
  openTurn: number | null
  compaction: CompactionTrace | undefined
  surfaceEvents: SessionEvent[]
  surface: SurfaceManager
}

type CompactionTransition =
  | { kind: 'start'; compactionId: CompactionId; sourceCommandId: string | undefined; startSeq: SessionSeq; turn: number | null }
  | { kind: 'summary'; compactionId: CompactionId; sourceCommandId: string | undefined; startSeq: SessionSeq; turn: number | null }
  | { kind: 'end' }
  | { kind: 'end-seed' }

/** Require a durable opaque identity to be a non-empty string. */
function validateId(value: unknown, label: string, fail: InvariantFailure): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
}

/** Validate a durable event-sequence identity at this package's event boundary. */
function validateSeq(value: unknown, label: string, fail: InvariantFailure): SessionSeq {
  if (typeof value !== 'number') return fail(`${label} must be a non-negative safe integer event seq`)
  try {
    return SessionSeq(value)
  } catch {
    return fail(`${label} must be a non-negative safe integer event seq`)
  }
}

/** Validate one shadowed surface span and its complete ordered identity list. */
function validateShadowedSeqs(
  trace: SessionTrace,
  event: SessionEvent<'compaction/summary' | 'compaction/prune'>,
  fail: InvariantFailure,
): void {
  const eventType = event.type
  const { data } = event
  const start = validateSeq(data.shadowedRange.start, `${eventType} shadowedRange.start`, fail)
  const end = validateSeq(data.shadowedRange.end, `${eventType} shadowedRange.end`, fail)
  const seqs = data.shadowedSeqs.map((seq, index) => validateSeq(seq, `${eventType} shadowedSeqs[${index}]`, fail))
  if (seqs.length === 0) fail(`${eventType} shadowedSeqs must be non-empty`)
  if (seqs[0] !== start || seqs.at(-1) !== end) {
    fail(`${eventType} shadowedRange must match the first and last shadowedSeqs`)
  }
  const surface = trace.surface.nodes
  const startIndex = surface.indexOf(start)
  const endIndex = surface.indexOf(end)
  if (startIndex < 0 || endIndex < startIndex) {
    fail(`${eventType} shadowed seqs must name an earlier current surface span`)
  }
  const expected = surface.slice(startIndex, endIndex + 1)
  if (expected.length !== seqs.length
    || expected.some((seq, index) => seq !== seqs[index])) {
    fail(`${eventType} shadowedSeqs must list every node in the current surface span`)
  }
}

/** Keep the optional initiating command identity stable across one transaction. */
function validateSourceCommandId(
  eventType: string,
  value: unknown,
  expected: string | undefined,
  fail: InvariantFailure,
): void {
  if (value !== undefined) validateId(value, `${eventType} sourceCommandId`, fail)
  if (value !== expected) {
    fail(`${eventType} sourceCommandId ${String(value)} does not match compaction/start sourceCommandId ${String(expected)}`)
  }
}

type CheckpointReplacementEvent = SessionEvent<'user/message'> & {
  surfaceOp: Extract<SurfaceOp, { op: 'replace' }>
}

/**
 * Validate one corrective checkpoint amendment between turns. An amendment may
 * only replace the single current surface checkpoint node it cites, and it
 * must preserve that node's exact compaction identity and command identity.
 */
function validateCheckpointAmendment(
  trace: SessionTrace,
  event: CheckpointReplacementEvent,
  source: CompactionCheckpointSource,
  fail: InvariantFailure,
): void {
  if (trace.openTurn !== null) {
    fail('compaction checkpoint amendment is only allowed between turns')
  }
  const { startSeq, endSeq } = event.surfaceOp
  if (startSeq !== endSeq) {
    fail('compaction checkpoint amendment must replace exactly one current checkpoint node')
  }
  const targetSeq = startSeq
  const target = trace.surfaceEvents[targetSeq]
  if (target === undefined || target.seq !== targetSeq || !trace.surface.nodes.includes(targetSeq)) {
    fail('compaction checkpoint has no matching compaction/start and no current surface target to amend')
  }
  if (target.type !== 'user/message'
    || !isReplacementSurfaceEvent(target)
    || !isCompactCheckpointSource(target.data.source)) {
    fail('compaction checkpoint has no matching compaction/start and no existing checkpoint to amend')
  }
  validateId(target.data.source.compactionId, 'amended compaction checkpoint compactionId', fail)
  if (target.data.source.sourceCommandId !== undefined) {
    validateId(target.data.source.sourceCommandId, 'amended compaction checkpoint sourceCommandId', fail)
  }
  if (source.compactionId !== target.data.source.compactionId) {
    fail(`compaction checkpoint amendment id ${source.compactionId} does not match amended checkpoint id ${target.data.source.compactionId}`)
  }
  if (source.sourceCommandId !== target.data.source.sourceCommandId) {
    fail(`compaction checkpoint amendment sourceCommandId ${String(source.sourceCommandId)} does not match amended checkpoint sourceCommandId ${String(target.data.source.sourceCommandId)}`)
  }
  /* v8 ignore next 3 -- surface append/seed validation already requires every shadowed node citation. */
  if (event.sourceEventSeqs === undefined || !event.sourceEventSeqs.includes(targetSeq)) {
    fail('compaction checkpoint amendment must cite the amended checkpoint in sourceEventSeqs')
  }
}

/** Validate one replacement checkpoint against its open compaction transaction or a current amendment target. */
function validateCheckpoint(
  trace: SessionTrace,
  event: CheckpointReplacementEvent,
  source: CompactionCheckpointSource,
  fail: InvariantFailure,
): void {
  validateId(source.compactionId, 'compaction checkpoint compactionId', fail)
  if (source.sourceCommandId !== undefined) {
    validateId(source.sourceCommandId, 'compaction checkpoint sourceCommandId', fail)
  }
  const open = trace.compaction
  if (open === undefined) {
    validateCheckpointAmendment(trace, event, source, fail)
    return
  }
  if (source.compactionId !== open.compactionId) {
    fail(`compaction checkpoint id ${source.compactionId} does not match compaction/start id ${open.compactionId}`)
  }
  validateSourceCommandId('compaction checkpoint', source.sourceCommandId, open.sourceCommandId, fail)
}

/** Compaction starts still unmatched when a later seed boundary made them stale. */
function inheritedOrphanStartSeqs(
  events: readonly SessionEvent[],
): ReadonlySet<SessionSeq> {
  const stale = new Set<SessionSeq>()
  let openStartSeq: SessionSeq | undefined
  for (const event of events) {
    if (event.type === 'compaction/start') {
      openStartSeq = event.seq
    } else if (event.type === 'compaction/end') {
      openStartSeq = undefined
    } else if (event.type === 'session/end-seed') {
      if (openStartSeq !== undefined) stale.add(openStartSeq)
      openStartSeq = undefined
    }
  }
  return stale
}

/** Keep every live compaction bracket on one side of each turn boundary. */
function validateTurnBoundary(
  trace: SessionTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): void {
  if (
    (event.type !== 'turn/start' && event.type !== 'turn/end')
    || trace.compaction === undefined
  ) return
  const owner = trace.compaction.turn === null
    ? 'standalone compaction'
    : `compaction for turn ${trace.compaction.turn}`
  fail(`${event.type} cannot cross an open ${owner}`)
}

/** Advance the committed turn cursor after its boundary has been accepted. */
function applyTurnBoundary(trace: SessionTrace, event: SessionEvent): boolean {
  if (event.type === 'turn/start') {
    trace.openTurn = event.data.turn
    return true
  }
  if (event.type === 'turn/end') {
    trace.openTurn = null
    return true
  }
  return false
}

/** Require a numbered bracket inside its exact turn, or a standalone bracket between turns. */
function validateOwner(
  owner: number | null,
  openTurn: number | null,
  eventType: 'compaction/start' | 'compaction/summary' | 'compaction/end',
  fail: InvariantFailure,
): void {
  if (owner === null) {
    if (openTurn !== null) fail(`${eventType} is standalone but turn ${openTurn} is open`)
    return
  }
  if (openTurn === null) fail(`${eventType} for turn ${owner} appended outside any open turn`)
  if (owner !== openTurn) fail(`${eventType} names turn ${owner} but open turn is ${openTurn}`)
}

/** Validate one compaction event without advancing committed trace state. */
function validateCompactionEvent(
  trace: SessionTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): CompactionTransition | undefined {
  if (event.type === 'session/end-seed') return { kind: 'end-seed' }
  if (event.type === 'compaction/prune') {
    validateShadowedSeqs(trace, event, fail)
    return undefined
  }
  if (event.type === 'user/message'
    && isReplacementSurfaceEvent(event)
    && isCompactCheckpointSource(event.data.source)) {
    validateCheckpoint(trace, event, event.data.source, fail)
    return undefined
  }
  if (event.type !== 'compaction/start' && event.type !== 'compaction/summary' && event.type !== 'compaction/end') {
    return undefined
  }
  const open = trace.compaction
  if (event.type === 'compaction/start') {
    validateId(event.data.compactionId, 'compaction/start compactionId', fail)
    if (event.data.sourceCommandId !== undefined) {
      validateId(event.data.sourceCommandId, 'compaction/start sourceCommandId', fail)
    }
    if (open !== undefined) {
      const owner = open.turn === null ? 'standalone compaction' : `turn ${open.turn}`
      fail(`compaction/start while ${owner} is still compacting`)
    }
    validateOwner(event.data.turn, trace.openTurn, event.type, fail)
    return {
      kind: 'start',
      compactionId: event.data.compactionId,
      sourceCommandId: event.data.sourceCommandId,
      startSeq: event.seq,
      turn: event.data.turn,
    }
  }
  if (event.type === 'compaction/summary') {
    validateId(event.data.compactionId, 'compaction/summary compactionId', fail)
    if (event.data.sourceCommandId !== undefined) {
      validateId(event.data.sourceCommandId, 'compaction/summary sourceCommandId', fail)
    }
    if (open === undefined) fail('compaction/summary has no matching compaction/start')
    if (event.data.compactionId !== open.compactionId) {
      fail(`compaction/summary id ${event.data.compactionId} does not match compaction/start id ${open.compactionId}`)
    }
    validateSourceCommandId('compaction/summary', event.data.sourceCommandId, open.sourceCommandId, fail)
    validateOwner(open.turn, trace.openTurn, event.type, fail)
    if (open.summarized) fail('compaction/summary repeated within one compaction')
    validateShadowedSeqs(trace, event, fail)
    if (!Number.isSafeInteger(event.data.shadowedTokenCount) || event.data.shadowedTokenCount < 0) {
      fail('compaction/summary shadowedTokenCount must be a non-negative safe integer')
    }
    return {
      kind: 'summary',
      compactionId: open.compactionId,
      sourceCommandId: open.sourceCommandId,
      startSeq: open.startSeq,
      turn: open.turn,
    }
  }
  validateId(event.data.compactionId, 'compaction/end compactionId', fail)
  if (event.data.sourceCommandId !== undefined) {
    validateId(event.data.sourceCommandId, 'compaction/end sourceCommandId', fail)
  }
  if (open === undefined) fail('compaction/end has no matching compaction/start')
  if (event.data.compactionId !== open.compactionId) {
    fail(`compaction/end id ${event.data.compactionId} does not match compaction/start id ${open.compactionId}`)
  }
  validateSourceCommandId('compaction/end', event.data.sourceCommandId, open.sourceCommandId, fail)
  if (event.data.turn !== open.turn) {
    fail(`compaction/end owner ${String(event.data.turn)} does not match compaction/start owner ${String(open.turn)}`)
  }
  validateOwner(open.turn, trace.openTurn, event.type, fail)
  if (event.data.error === undefined && !open.summarized) {
    fail('successful compaction/end requires one compaction/summary')
  }
  return { kind: 'end' }
}

/** Apply one committed compaction transition. */
function applyCompactionTransition(
  transition: CompactionTransition,
): CompactionTrace | undefined {
  if (transition.kind === 'start') {
    return {
      compactionId: transition.compactionId,
      sourceCommandId: transition.sourceCommandId,
      startSeq: transition.startSeq,
      turn: transition.turn,
      summarized: false,
    }
  }
  if (transition.kind === 'summary') {
    return {
      compactionId: transition.compactionId,
      sourceCommandId: transition.sourceCommandId,
      startSeq: transition.startSeq,
      turn: transition.turn,
      summarized: true,
    }
  }
  return undefined
}

/** Create an empty trace over one replay event window. */
function createTrace(projections: readonly SessionMessageProjection[]): SessionTrace {
  const surfaceEvents: SessionEvent[] = []
  return {
    openTurn: null,
    compaction: undefined,
    surfaceEvents,
    surface: new SurfaceManager(surfaceEvents, undefined, projections),
  }
}

/** Replay one complete event stream through the compaction checks, advancing the trace. */
function replayEvents(
  trace: SessionTrace,
  events: readonly SessionEvent[],
  fail: InvariantFailure,
): void {
  const staleOrphanStartSeqs = inheritedOrphanStartSeqs(events)
  for (const event of events) {
    // Constructor-seed repair boundaries can precede the end-seed marker
    // that proves an inherited orphan stale. Replay that inherited prefix
    // without letting the soon-to-be-cleared bracket veto its repair.
    if (
      trace.compaction === undefined
      || !staleOrphanStartSeqs.has(trace.compaction.startSeq)
    ) {
      validateTurnBoundary(trace, event, fail)
    }
    const transition = validateCompactionEvent(trace, event, fail)
    if (transition !== undefined) trace.compaction = applyCompactionTransition(transition)
    applyTurnBoundary(trace, event)
    trace.surfaceEvents.push(event)
  }
}

/**
 * Validate one complete event stream without installing live listeners.
 * Callers planning a durable append use this to reject an invalid planned
 * stream before any event is committed.
 * @param events - contiguous Session events to replay from seq 0.
 * @param projections - message projections the replay's surface fold requires.
 * @param fail - package-attributed reporter that must throw.
 */
export function validateCompactionEvents(
  events: readonly SessionEvent[],
  projections: readonly SessionMessageProjection[],
  fail: InvariantFailure,
): void {
  replayEvents(createTrace(projections), events, fail)
}

/** Install compaction start/summary/end checks. */
// Event owners keep precommit staging local so their vocabularies never move into a central helper.
/* jscpd:ignore-start */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, SessionTrace>()
  const staged = new WeakMap<SessionEvent, { session: Session; transition: CompactionTransition }>()
  const seed = (session: Session): SessionTrace => {
    const trace = createTrace(ctx.sessions.messageProjections)
    traces.set(session, trace)
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    replayEvents(trace, session.snapshotEvents(), fail)
    return trace
  }
  const traceFor = (session: Session): SessionTrace => traces.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('session/event', (session, event) => {
    const trace = traceFor(session)
    validateTurnBoundary(trace, event, fail)
    const changedTurn = applyTurnBoundary(trace, event)
    if (!changedTurn && event.type !== 'session/end-seed'
      && event.type !== 'compaction/start'
      && event.type !== 'compaction/summary'
      && event.type !== 'compaction/end') {
      trace.surfaceEvents.push(event)
      return
    }
    if (!changedTurn) {
      const candidate = staged.get(event)
      /* v8 ignore next -- internal/dispatch stages every compaction event */
      if (candidate === undefined || candidate.session !== session) return fail('compaction event published without pre-commit validation')
      staged.delete(event)
      trace.compaction = applyCompactionTransition(candidate.transition)
    }
    trace.surfaceEvents.push(event)
  }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const trace = traceFor(session)
    validateTurnBoundary(trace, event, fail)
    const transition = validateCompactionEvent(trace, event, fail)
    if (transition !== undefined) staged.set(event, { session, transition })
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the compact invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
