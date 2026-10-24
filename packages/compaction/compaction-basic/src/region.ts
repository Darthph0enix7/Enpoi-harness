/**
 * Surface retention selection and the shared log-recorded compaction
 * transaction for automatic open-turn and manual idle-session compaction.
 *
 * @module @deepseek-ai/dsh-compaction-basic/region
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage, errorChain, isRequestSizeFailure } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  frameMechanicalOmission,
  frameSummary,
  MECHANICAL_SUMMARY_TEXT,
  SummarizationReplayError,
  summarizationFailureCause,
} from './summarizer.ts'
import type { SummarizationFailure, SummarizationInput, SummaryResult } from './summarizer.ts'
interface RegionDependencies {
  readonly meter: TokenMeter
  summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>
  recover(error: unknown, agent: Agent, sourceEventSeqs: readonly SessionSeq[], signal?: AbortSignal): boolean
  /** Warn-level diagnostic sink; the engine binds it to the plugin logger. */
  warn(line: string): void
  /** Recall wording and footer resolved against the compacting agent's visible tools. */
  framing(agent: Agent): RecallFraming
  /** Summariser resilience bounds resolved from plugin configuration. */
  readonly summarizerPolicy: SummarizerRegionPolicy
}

/**
 * Bounds the compaction transaction applies when the summarizer rejects its
 * request or cannot run. Every value is a validated `BasicCompactionConfig`
 * field on the owning plugin.
 */
export interface SummarizerRegionPolicy {
  /** Extra attempts with a smaller replay region after a size-class rejection. */
  readonly frameRetries: number
  /** Fraction of the rejected region kept for the retry, in (0, 1). */
  readonly frameShrinkRatio: number
  /** Share of the selected region the mechanical omission must free, in (0, 1]. */
  readonly mechanicalFreeShare: number
}

/** Deterministic recall wording for the compacting agent's tool scope. */
export interface RecallFraming {
  /** Whether `session_event_search` and `session_event_read` both resolve in this scope. */
  readonly searchRead: boolean
  /** Configured footer text; present only when every configured footer tool resolves. */
  readonly footer?: string
}

/** Leading `user/message` surface nodes to keep verbatim after the system head. */
export interface PinLeadingOptions {
  /** Maximum number of leading user messages to pin; `0` disables pinning. */
  readonly count: number
  /** Per-message price ceiling; the first failing message stops the pin run. */
  readonly maxTokens: number
}

/** One validated inclusive span of current surface positions. */
interface SurfaceSelection {
  readonly start: SessionSeq
  readonly end: SessionSeq
  readonly startIdx: number
  readonly endIdx: number
  readonly shadowedSeqs: readonly SessionSeq[]
}

/** A selection with its priced snapshot and the replay input built from it. */
interface PreparedCompaction extends SurfaceSelection {
  readonly measurement: TokenMeasurement
  readonly selectedNodes: TokenMeasurement['nodes']
  readonly shadowedTokenCount: number
  /** Route-priced total of the selected span; the shrink comparison's unit. */
  readonly shadowedRouteTokenCount: number
  /** Surface seqs replayed as leading context before the region, in order. */
  readonly replayLeadingSeqs: readonly SessionSeq[]
  readonly input: SummarizationInput
}

type SummarizedCompaction = PreparedCompaction & SummaryResult & {
  readonly checkpointMessage: UserMessage
  /** Bounded cause recorded when a summarization failure forced the mechanical stub. */
  readonly summarizationFailure?: SummarizationFailure
}

interface CompactionTransactionOptions {
  /** `current-turn` derives a numbered owner; `null` writes a standalone bracket. */
  readonly owner: 'current-turn' | null
  /** Surface relationship that must survive asynchronous summarization. */
  readonly stability: 'whole-surface' | 'selected-span'
  /**
   * Automatic transactions land the deterministic model-free omission when the
   * summary path fails (doc 66 invariant: a deterministic fallback always
   * exists). Manual transactions stay fail-loud so the operator sees the cause.
   */
  readonly allowMechanicalFallback: boolean
  /** Optional durability checkpoint after a successfully closed bracket. */
  readonly flush?: () => Promise<void>
  /** Manual command that initiated this transaction, when present. */
  readonly sourceCommandId?: CommandId
}

interface CompactionEntryState {
  readonly openTurn: number | null
  readonly unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  readonly latestEndSeedSeq: SessionSeq | undefined
}

/**
 * Rejects a summary whose replacement boundaries are no longer the ones it was
 * built from, distinguished from summarizer and shrink failures so a manual
 * caller can report the two causes differently.
 */
class SurfaceChangedError extends Error {}

/** Whether the summary may still replace the span it was built from. */
type StabilityCheck = (
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
) => void

/** Failure captured after `compaction/start` has committed. */
interface TransactionFailure {
  readonly error: unknown
  readonly stage: 'summary' | 'commit'
}

/** A framed model summary is not smaller than the span it would replace. */
class SummaryNotSmallerError extends Error {
  constructor(message: string) {
    super(message)
    // Match the HarnessError convention so the class survives as the recorded
    // failure code when the shrink guard selects the mechanical fallback.
    this.name = 'SummaryNotSmallerError'
  }
}

/**
 * The `system/message` holding surface node 0, or `undefined` when another
 * message-producing event starts the surface.
 * @param session - session supplying the log behind the current surface.
 * @param headSeq - seq at surface node 0 of a non-empty surface.
 * @returns the system head event, or `undefined` without one.
 */
function systemHead(session: Session, headSeq: SessionSeq): SessionEvent<'system/message'> | undefined {
  // Surface nodes are current log seqs, so the event exists.
  // Existing Session history read; migration deferred.
  // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
  const head = session.eventAt(headSeq)!
  return head.type === 'system/message' ? head : undefined
}

/**
 * Resolve the next range starting at the first non-system, non-pinned surface
 * node while retaining a priced recent tail and never splitting an assistant
 * tool-call/result pair. A `system/message` at surface node 0 is never inside
 * the range; without one the range starts at node 0. Pinned messages are the
 * contiguous `user/message` run directly after the system head whose price is
 * at most `pin.maxTokens`; a checkpoint or any other node ends the run.
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement from the conversation meter.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @param pin - leading user messages to keep verbatim; `0` restores the pre-pin selection exactly.
 * @returns the inclusive positional seq range to compact, or `null`.
 */
export function selectCompactableRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
  pin: PinLeadingOptions = { count: 0, maxTokens: 0 },
): { start: SessionSeq; end: SessionSeq } | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null

  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const firstIdx = systemHead(session, surfaceNodes[0]!) === undefined ? 0 : 1

  // Pinned nodes are surface nodes the next request keeps byte-identical, so
  // the summarizer's replay can reuse their cache prefix.
  let pinned = 0
  for (let index = firstIdx; index < pricedNodes.length && pinned < pin.count; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const seq = surfaceNodes[index]!
    // Existing Session history read; migration deferred.
    // oxlint-disable-next-line typescript/no-deprecated
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') break
    if (isCheckpointMessage(event.data)) break
    // oxlint-disable-next-line typescript/no-non-null-assertion
    if (pricedNodes[index]!.tokens > pin.maxTokens) break
    pinned += 1
  }
  const firstCompactableIdx = firstIdx + pinned

  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    accumulated += pricedNodes[index]!.tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstCompactableIdx) return null

  while (keepFromIdx > firstCompactableIdx) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx]!)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstCompactableIdx) return null

  // oxlint-disable-next-line typescript/no-non-null-assertion
  const first = surfaceNodes[firstCompactableIdx]!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const cutoff = surfaceNodes[keepFromIdx - 1]!
  return { start: first, end: cutoff }
}

/** Whether one `user/message` is a compaction-produced replacement checkpoint. */
function isCheckpointMessage(data: { readonly source?: { readonly kind?: string } }): boolean {
  return data.source?.kind === 'compact-checkpoint'
}

/**
 * Run the single compaction transaction over one selected positional span.
 * Selection and validation are read-only. Idle/log validation and
 * `compaction/start` are synchronously adjacent, so the durable opening marker is
 * the compaction lock before summarization yields. Every later failure makes
 * exactly one `compaction/end` attempt; a failed close deliberately leaves the
 * unmatched start detectable.
 * @param dependencies - conversation meter and dynamically dispatched summarizer hook.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @param agent - agent used by the summarizer.
 * @param options - bracket owner, stability rule, and optional durability checkpoint.
 * @param signal - optional summarization cancellation signal.
 * @returns the successful durable compaction result.
 */
export async function compactSurfaceRegion(
  dependencies: RegionDependencies,
  session: Session,
  start: SessionSeq,
  end: SessionSeq,
  agent: Agent,
  options: CompactionTransactionOptions,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  if (options.owner === null) signal?.throwIfAborted()
  const selection = validateSurfaceRegion(session, start, end)
  const entryState = inspectCompactionEntryState(session)
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    'compaction',
  )

  let owner: number | null
  if (options.owner === null) {
    if (entryState.openTurn !== null) {
      throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
    }
    owner = null
  } else {
    if (entryState.openTurn === null) {
      throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
    }
    owner = entryState.openTurn
  }

  const compactionId = CompactionId(randomUUID())
  const lifecycle = {
    compactionId,
    ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
    turn: owner,
  }
  const startEvent = session.append('compaction/start', lifecycle)
  const assertStable: StabilityCheck = options.stability === 'whole-surface'
    ? assertWholeSurfaceUnchanged
    : assertSelectedSpanStable
  let failure: TransactionFailure | undefined
  let flushFailure: unknown
  let result: CompactionResult | undefined
  let closed = false
  let closing = false
  let stage: TransactionFailure['stage'] = 'summary'

  try {
    const prepared = prepareCompaction(dependencies, session, selection)
    const summarized = await summarizeCompaction(
      dependencies,
      prepared,
      agent,
      compactionId,
      options.sourceCommandId,
      assertStable,
      options.allowMechanicalFallback,
      signal,
    )
    if (options.owner === null) signal?.throwIfAborted()
    assertStable(dependencies, session, summarized)
    stage = 'commit'
    const pending = commitCompactionBody(session, startEvent, summarized)
    closing = true
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    result = completeCompaction(pending, endEvent)
  } catch (error: unknown) {
    failure = { error, stage: closing ? 'commit' : stage }
    if (!closing) {
      closing = true
      try {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
        closed = true
      } catch (closeError: unknown) {
        failure = { error: closeError, stage: 'commit' }
      }
    }
  }

  if (closed && options.flush !== undefined) {
    try {
      await options.flush()
    } catch (error: unknown) {
      flushFailure = error
    }
  }

  if (options.owner === null) signal?.throwIfAborted()
  if (failure !== undefined) {
    if (options.owner === null) throwManualFailure(failure)
    throw failure.error
  }
  if (flushFailure !== undefined) {
    throw new ManualCompactionError(
      'persistence',
      'manual compaction durability checkpoint failed',
      { cause: flushFailure },
    )
  }
  /* v8 ignore next -- every path without a result records and throws a failure above. */
  if (result === undefined) throw new Error('compaction committed without a result')
  return result
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure: TransactionFailure): never {
  if (failure.stage === 'commit') {
    throw new ManualCompactionError(
      'commit',
      'manual compaction did not commit cleanly',
      { cause: failure.error },
    )
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError(
      'changed',
      'the compacted history changed during manual compaction',
      { cause: failure.error },
    )
  }
  throw new ManualCompactionError(
    'summary',
    'manual compaction could not produce a smaller summary',
    { cause: failure.error },
  )
}

/**
 * Reject a durable unmatched compaction marker unless a later constructor-seed
 * boundary proves that its owner belongs to an earlier session lifecycle.
 * @param unmatchedCompactionStart - latest unmatched opening marker, if any.
 * @param latestEndSeedSeq - newest constructor-seed boundary, if any.
 * @param stage - operation label included in the busy diagnostic.
 */
function assertCompactionInactive(
  unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined,
  latestEndSeedSeq: SessionSeq | undefined,
  stage: string,
): void {
  if (unmatchedCompactionStart === undefined
    || (latestEndSeedSeq !== undefined
      && latestEndSeedSeq > unmatchedCompactionStart.seq)) return
  throw new ManualCompactionError(
    'busy',
    `${stage}: compaction already in progress; the session compaction lock is already active`,
  )
}

/**
 * Recheck the durable compaction lock after an asynchronous policy decision.
 * @param session - session whose latest marker state is inspected.
 * @param stage - operation label included in the busy diagnostic.
 */
export function assertNoActiveCompaction(session: Session, stage: string): void {
  const entryState = inspectCompactionEntryState(session)
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    stage,
  )
}

/** Validate one requested surface-position span before asynchronous work begins. */
function validateSurfaceRegion(session: Session, start: SessionSeq, end: SessionSeq): SurfaceSelection {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(
      `compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    )
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion
  if (!toolPairingBalancedBefore(session, nodes[startIdx]!)) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion
  if (!toolPairingBalancedAfter(session, nodes[endIdx]!)) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  }

  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/**
 * Snapshot pricing and replay input for a validated surface range.
 * @param dependencies - meter and summariser policy.
 * @param session - session supplying surface positions and derivation.
 * @param selection - the validated span the replacement will shadow.
 * @param replayLeadingSeqs - surface seqs to replay before the region.
 *   Defaults to the nodes between the system head and the selection start; a
 *   shrunk retry passes the frame's original leading seqs so the nodes it
 *   dropped from the oldest end are not replayed as leading context (which
 *   would keep the request exactly as large as the refused one).
 */
function prepareCompaction(
  dependencies: RegionDependencies,
  session: Session,
  selection: SurfaceSelection,
  replayLeadingSeqs?: readonly SessionSeq[],
): PreparedCompaction {
  const measurement = dependencies.meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length
    || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new SurfaceChangedError('compaction: selected surface changed before summarization began')
  }
  const surfaceNodes = session.surface.nodes
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const headIdx = systemHead(session, surfaceNodes[0]!) === undefined ? 0 : 1
  const leadingSeqs = replayLeadingSeqs ?? surfaceNodes.slice(headIdx, selection.startIdx)
  return {
    ...selection,
    measurement,
    selectedNodes,
    // The shadow-price protocol prices replacements with the fixed heuristic
    // so the O(1) projection fold stays in agreement with its own appends;
    // retention, range selection, and the shrink comparison read the
    // route-priced `tokens` instead.
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    replayLeadingSeqs: leadingSeqs,
    input: buildSummarizationInput(session, leadingSeqs, selection.shadowedSeqs),
  }
}

/**
 * Run the summarizer and frame its replacement checkpoint. When the summary
 * path fails (or produces a non-shrinking frame) and the transaction is
 * automatic, the deterministic model-free omission is attempted before the
 * error is allowed to escape — the session remains promptable either way, and
 * the bounded failure cause lands on the mechanical summary event so a
 * post-hoc reader can explain the stub without the live journal.
 */
async function summarizeCompaction(
  dependencies: RegionDependencies,
  prepared: PreparedCompaction,
  agent: Agent,
  compactionId: CompactionResult['compactionId'],
  sourceCommandId: CommandId | undefined,
  assertStable: StabilityCheck,
  allowMechanicalFallback: boolean,
  signal?: AbortSignal,
): Promise<SummarizedCompaction> {
  let frameRetriesLeft = dependencies.summarizerPolicy.frameRetries
  for (;;) {
    signal?.throwIfAborted()
    try {
      const summaryResult = await dependencies.summarize(prepared.input, agent, signal)
      return frameSummarizedCompaction(
        dependencies,
        prepared,
        summaryResult,
        agent,
        compactionId,
        sourceCommandId,
      )
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      assertStable(dependencies, agent.session, prepared)
      // Recover against the exact request that failed: a window-clipped replay
      // offloads from the messages it carried, not from a superset that could
      // leave the retried request over its image cap.
      const replayedSeqs = error instanceof SummarizationReplayError
        ? error.replayedSourceSeqs
        : prepared.shadowedSeqs
      if (!dependencies.recover(error, agent, replayedSeqs, signal)) {
        // A request-size rejection is the summariser telling us the frame is
        // too large for what it can actually accept. Retry the SAME compaction
        // with a smaller but never empty region and keep the retained tail, so
        // the reduction still shadows the oldest part of the span. Image
        // recovery owns its own ladder and is never shrunk here.
        if (frameRetriesLeft > 0
          && !(error instanceof SummarizationReplayError)
          && isRequestSizeFailure(error)) {
          const smaller = shrinkReplayRegion(
            dependencies,
            agent.session,
            prepared,
            dependencies.summarizerPolicy.frameShrinkRatio,
          )
          if (smaller !== null) {
            frameRetriesLeft -= 1
            const cause = summarizationFailureCause(error)
            dependencies.warn(
              `compaction ${compactionId}: summariser rejected the frame `
              + `(${cause.code}: ${cause.message}); retrying with `
              + `${smaller.shadowedSeqs.length} of ${prepared.shadowedSeqs.length} shadowed nodes`,
            )
            prepared = smaller
            continue
          }
        }
        if (allowMechanicalFallback) {
          const failure = summarizationFailureCause(error)
          const mechanical = mechanicalCompaction(
            dependencies,
            agent.session,
            prepared,
            agent,
            compactionId,
            sourceCommandId,
            failure,
          )
          if (mechanical !== null) {
            dependencies.warn(
              `compaction ${compactionId}: summarization failed `
              + `(${failure.code}: ${failure.message}); replaced with the mechanical omission stub`,
            )
            return mechanical
          }
        }
        throw error
      }
      prepared = prepareCompaction(dependencies, agent.session,
        validateSurfaceRegion(agent.session, prepared.start, prepared.end))
    }
  }
}

/** Frame one successful model summary and enforce the shrink guarantee. */
function frameSummarizedCompaction(
  dependencies: RegionDependencies,
  prepared: PreparedCompaction,
  summaryResult: SummaryResult,
  agent: Agent,
  compactionId: CompactionResult['compactionId'],
  sourceCommandId: CommandId | undefined,
): SummarizedCompaction {
  const framing = dependencies.framing(agent)
  const clippedCause = summaryResult.conservativeWindowClip === true
    ? "the summariser's context window could not be resolved, so the replay was capped to a conservative budget"
    : "the summariser's context window was smaller than this span"
  const coverageNote = summaryResult.windowClipped === true
    ? framing.searchRead
      ? `${clippedCause}, so only its newest messages were condensed; seqs ${prepared.start}–${prepared.end} remain retrievable with session_event_search / session_event_read`
      : `${clippedCause}, so only its newest messages were condensed; seqs ${prepared.start}–${prepared.end}. The complete transcript is preserved in the session log.`
    : undefined
  const checkpointMessage = createUserMessage({
    content: frameSummary(summaryResult.summary, coverageNote, framing.footer),
    source: compactCheckpointSource(compactionId, sourceCommandId),
  })
  // The checkpoint is text-only, so its fixed-heuristic price IS its route
  // price; comparing it against the span's route price asks the real
  // question — does the replacement lower the next request's pressure.
  const framedSummaryTokenCount = dependencies.meter.estimateMessage(checkpointMessage)
  if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) {
    throw new SummaryNotSmallerError(
      `summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`,
    )
  }
  return {
    ...prepared,
    ...summaryResult,
    checkpointMessage,
  }
}

/**
 * Re-derive the same compaction from its newest messages only: keep the
 * retained tail and the newest suffix of the selected span, dropping the oldest
 * part that made the request too large. The selection never becomes empty and
 * always advances past the previous start, so a retry cannot repeat the exact
 * frame that was just rejected and cannot loop with no effect. The replay's
 * shared system head and pinned leading messages stay byte-identical, so the
 * provider can still serve the cached prefix up to where the frames diverge.
 * @param dependencies - meter and summariser policy.
 * @param session - session whose surface supplies current positions and prices.
 * @param prepared - the frame that was rejected for its size.
 * @param shrinkRatio - fraction of the rejected region's tokens to keep, in (0, 1).
 * @returns the smaller prepared compaction, or `null` when no strictly smaller
 *   balanced region exists (the caller then selects its fallback).
 */
function shrinkReplayRegion(
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
  shrinkRatio: number,
): PreparedCompaction | null {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(prepared.start)
  const endIdx = nodes.indexOf(prepared.end)
  if (startIdx === -1 || endIdx <= startIdx) return null
  const prices = new Map(
    dependencies.meter.measure(session).nodes.map(node => [node.seq, node.tokens]),
  )
  const targetTokens = Math.max(1, Math.ceil(prepared.shadowedRouteTokenCount * shrinkRatio))
  let spent = 0
  let keepFromIdx = endIdx
  for (let index = endIdx; index >= startIdx; index -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a valid surface position.
    spent += prices.get(nodes[index]!) ?? 0
    keepFromIdx = index
    if (spent >= targetTokens) break
  }
  // Strictly smaller than the rejected frame: at least one older node is gone.
  if (keepFromIdx <= startIdx) keepFromIdx = startIdx + 1
  // The start must be a balanced boundary; `end` was already validated.
  // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a valid surface position.
  while (keepFromIdx < endIdx && !toolPairingBalancedBefore(session, nodes[keepFromIdx]!)) {
    keepFromIdx += 1
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a valid surface position.
  if (keepFromIdx > endIdx || !toolPairingBalancedBefore(session, nodes[keepFromIdx]!)) return null
  // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a valid surface position.
  const selection = validateSurfaceRegion(session, nodes[keepFromIdx]!, prepared.end)
  // Replay only the smaller region: the nodes dropped from the oldest end are
  // not leading context, or the request would stay exactly as large as the one
  // the provider just refused.
  return prepareCompaction(dependencies, session, selection, prepared.replayLeadingSeqs)
}

/**
 * The deterministic model-free fallback: drop the oldest balanced prefix of
 * the selected span and replace exactly that prefix with one pointer/omission
 * stub citing the session log and the recall tools. The rest of the selected
 * span stays verbatim; the removed events stay in the log (surface `replace`
 * only), so the transcript is intact and the session is promptable.
 * @param agent - compacting agent whose tool scope gates the recall wording.
 * @param failure - bounded cause of the failure that selected this fallback.
 * @returns the committed replacement carrying its failure record, or `null`
 *   when even the whole span is no larger than the stub (nothing can be freed;
 *   the caller rethrows).
 */
function mechanicalCompaction(
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
  agent: Agent,
  compactionId: CompactionResult['compactionId'],
  sourceCommandId: CommandId | undefined,
  failure: SummarizationFailure,
): SummarizedCompaction | null {
  const framing = dependencies.framing(agent)
  const probe = createUserMessage({
    content: frameMechanicalOmission(
      prepared.start,
      prepared.end,
      prepared.shadowedSeqs.length,
      framing.searchRead,
    ),
    source: compactCheckpointSource(compactionId, sourceCommandId),
  })
  const stubTokenCount = dependencies.meter.estimateMessage(probe)

  // Free at least the configured share of the selected span, not merely enough
  // to beat the stub's own price: a stub that frees 0.5k of a 590k region is a
  // "success" that cannot relieve pressure and invites another identical pass.
  // The stub price is still the hard floor (a replacement must shrink its
  // source) and the whole selected span is the clamp — the retained tail lies
  // outside it.
  const targetTokens = Math.max(
    stubTokenCount + 1,
    Math.ceil(prepared.shadowedRouteTokenCount * dependencies.summarizerPolicy.mechanicalFreeShare)
      + stubTokenCount,
  )
  let droppedTokens = 0
  let cut: SessionSeq | undefined
  for (const [index, node] of prepared.selectedNodes.entries()) {
    droppedTokens += node.tokens
    // oxlint-disable-next-line typescript/no-non-null-assertion -- selectedNodes and shadowedSeqs are parallel.
    const seq = prepared.shadowedSeqs[index]!
    if (droppedTokens >= targetTokens && toolPairingBalancedAfter(session, seq)) {
      cut = seq
      break
    }
  }
  if (cut === undefined) {
    // Clamp to the whole selected span: the newest balanced boundary at or
    // before its end. Nothing beyond the span is ever removed, so the retained
    // tail keeps its verbatim budget.
    for (let index = prepared.shadowedSeqs.length - 1; index >= 0; index -= 1) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- index is a valid position.
      const seq = prepared.shadowedSeqs[index]!
      if (toolPairingBalancedAfter(session, seq)) {
        cut = seq
        break
      }
    }
  }
  if (cut === undefined) return null

  const selection = validateSurfaceRegion(session, prepared.start, cut)
  const dropped = prepareCompaction(dependencies, session, selection)
  const checkpointMessage = createUserMessage({
    content: frameMechanicalOmission(
      dropped.start,
      dropped.end,
      dropped.shadowedSeqs.length,
      framing.searchRead,
    ),
    source: compactCheckpointSource(compactionId, sourceCommandId),
  })
  if (dependencies.meter.estimateMessage(checkpointMessage) >= dropped.shadowedRouteTokenCount) {
    return null
  }
  return {
    ...dropped,
    summary: [{ type: 'text', text: MECHANICAL_SUMMARY_TEXT }],
    // No model wrote this checkpoint; the empty route is the durable answer.
    provider: '',
    model: '',
    // Why this level of the failure ladder ran outlives the live journal.
    summarizationFailure: failure,
    checkpointMessage,
  }
}

/** Reject a summary prepared against any earlier surface generation. */
function assertWholeSurfaceUnchanged(
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
): void {
  const current = dependencies.meter.measure(session)
  if (!isDeepStrictEqual(current.nodes, prepared.measurement.nodes)) {
    throw new SurfaceChangedError('compaction: session surface changed during summarization')
  }
}

/**
 * Require only that the selected span remain the same present, contiguous,
 * equally priced, balanced replacement target. Nodes added outside it remain
 * visible and do not invalidate the summary.
 */
function assertSelectedSpanStable(
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
): void {
  let current: SurfaceSelection
  try {
    current = validateSurfaceRegion(session, prepared.start, prepared.end)
  } catch (error: unknown) {
    throw new SurfaceChangedError(
      'compaction: the selected span is no longer a valid replacement target',
      { cause: error },
    )
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) {
    throw new SurfaceChangedError('compaction: the selected span changed during summarization')
  }
  const measured = dependencies.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1)
  if (!isDeepStrictEqual(measured, prepared.selectedNodes)) {
    throw new SurfaceChangedError('compaction: the selected span was rewritten during summarization')
  }
}

/** Append one completed summary record and replacement body without yielding. */
function commitCompactionBody(
  session: Session,
  startEvent: SessionEvent<'compaction/start'>,
  summarized: SummarizedCompaction,
): Omit<CompactionResult, 'endSeq'> {
  const {
    start,
    end,
    shadowedSeqs,
    shadowedTokenCount,
    summary,
    provider,
    model,
    maxTokens,
    usage,
    summarizationFailure,
    checkpointMessage,
  } = summarized
  const callRecord = summarized.llmStreamCall === true
    ? { rawOutput: summarized.rawOutput, llmStreamCall: true as const }
    : summarized.rawOutput === undefined ? {} : { rawOutput: summarized.rawOutput }
  const summaryEvent = session.append('compaction/summary', {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    summary,
    ...callRecord,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider,
    model,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...usage === undefined ? {} : { usage },
    ...summarizationFailure === undefined ? {} : { summarizationFailure },
  })
  session.append('user/message', checkpointMessage, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  return {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
  }
}

/** Attach the successfully appended close event to a pending result. */
function completeCompaction(
  pending: Omit<CompactionResult, 'endSeq'>,
  endEvent: SessionEvent<'compaction/end'>,
): CompactionResult {
  return { ...pending, endSeq: endEvent.seq }
}

/**
 * Reconstruct the last routed request's cacheable prefix for the shadowed
 * region: the system prompt held by the `system/message` at surface node 0,
 * the header's tool schemas, the pinned leading messages between the head and
 * the region, then the region's own derived messages in surface order. The
 * summarizer appends only the compaction instruction after this, so the call
 * is a genuine prefix of the conversation and reuses the provider's KV cache.
 * A surface without a system head, or whose head projects to no message,
 * contributes no leading system message.
 * @param session - session supplying the surface head, request header, and per-node projection.
 * @param leadingSeqs - surface-node seqs between the system head and the range start, in order.
 * @param shadowedSeqs - the surface-node seqs, in order, being compacted.
 * @returns the replayed conversation prefix to condense.
 */
function buildSummarizationInput(
  session: Session,
  leadingSeqs: readonly SessionSeq[],
  shadowedSeqs: readonly SessionSeq[],
): SummarizationInput {
  const header = session.requestHeader()
  // shadowedSeqs are current surface seqs, so the surface has a node 0.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const head = systemHead(session, session.surface.nodes[0]!)
  const system = head === undefined ? null : session.deriveEventMessage(head)
  const derived = (seq: SessionSeq): Message | null => {
    // Surface seqs are current log indexes; a missing event means a stale
    // selection, which the surface-stability check already rejects earlier.
    // Existing Session history read; migration deferred.
    // oxlint-disable-next-line typescript/no-deprecated
    const event = session.eventAt(seq)
    return event === undefined ? null : session.deriveEventMessage(event)
  }
  const leading = leadingSeqs
    .map(seq => ({ seq, message: derived(seq) }))
    .filter((entry): entry is { seq: SessionSeq; message: Message } => entry.message !== null)
  const region = shadowedSeqs
    .map(seq => ({ seq, message: derived(seq) }))
    .filter((entry): entry is { seq: SessionSeq; message: Message } => entry.message !== null)
  return {
    ...header?.tools === undefined ? {} : { tools: header.tools },
    messages: [
      ...(system === null ? [] : [system]),
      ...leading.map(entry => entry.message),
      ...region.map(entry => entry.message),
    ],
    ...leading.length === 0 ? {} : { leadingCount: leading.length },
    regionSeqs: region.map(entry => entry.seq),
  }
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state independently. */
function inspectCompactionEntryState(session: Session): CompactionEntryState {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: SessionSeq | undefined
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // Existing Session history read; migration deferred.
    // oxlint-disable-next-line typescript/no-non-null-assertion, typescript/no-deprecated
    const event = session.eventAt(SessionSeq(seq))!
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown
      && compactionEntryStateKnown
      && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}
