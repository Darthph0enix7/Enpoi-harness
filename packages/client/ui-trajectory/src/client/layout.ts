/**
 * Trajectory list fold: expand assistant blocks, attach usage to Message,
 * own-duration times, in-flight partial/runningCalls, and group descriptions.
 */
import type {
  AssistantBlock,
  AssistantMessageNode,
  ConversationLocation,
  RequestInspectionSnapshot,
  RequestPromptChange,
  RequestView,
  ToolCallBlock,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  TrajectoryCellProps,
  TrajectorySourceBlock,
} from './trajectory-record.ts'
import type {
  TrajectoryRevertBoundary, TrajectoryRevertConflict, TrajectoryRevertFileResult,
  TrajectoryRevertView, TrajectorySnapshot,
} from './trajectory-contract.ts'
import type { SessionRevertShadowRange } from '@deepseek-ai/dsh-api-session-controller/client'
import { formatElapsedSeconds } from './trajectory-record.ts'
import type { TrajectoryKey, TrajectoryTranslate } from './locales.ts'
import { COMPACTION_INTERRUPTED_ERROR } from './copy-codes.ts'

/** One Message or Step group inside a turn. */
export interface TrajectoryGroupModel {
  title: string
  description?: string
  cells: readonly TrajectoryCellProps[]
}

/** One sticky turn, or a standalone compaction section between turns. */
export interface TrajectoryTurnModel {
  turn: number | null
  groups: readonly TrajectoryGroupModel[]
}

/** Snapshot slice the trajectory view folds. */
export interface TrajectoryLayoutInput {
  systemPrompts?: TrajectorySnapshot['systemPrompts']
  nodes: TrajectorySnapshot['eventNodes']
  eventLocations?: ReadonlyMap<number, ConversationLocation>
  partial: TrajectorySnapshot['partial']
  runningCalls: TrajectorySnapshot['runningCalls']
  requests?: readonly RequestView[]
  callSchemas?: RequestInspectionSnapshot['callSchemas']
  /** Durable revert boundaries in window order, oldest first. */
  reverts?: TrajectorySnapshot['reverts']
  /** Durable per-file revert outcome batches in window order. */
  revertFiles?: TrajectorySnapshot['revertFiles']
  /** Durable file-revert conflicts awaiting resolution, in window order. */
  revertConflicts?: TrajectorySnapshot['revertConflicts']
  /** Revert fold shared with the Session: live truth for the active batch. */
  revert?: TrajectoryRevertView
}

interface UsageLike {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

/** Cell plus absolute ms for group wall-span descriptions. */
interface LaidCell {
  cell: TrajectoryCellProps
  absTime: number | null
  toolName?: string
  callId?: string
  subCalls?: readonly ToolCallBlock[]
}

interface LaidGroup {
  title: string
  laid: LaidCell[]
}

interface TurnBucket {
  groups: LaidGroup[]
}

type AssistantRequestView = Extract<RequestView, { purpose: 'assistant' }>
type CompactionRequestView = Extract<RequestView, { purpose: 'compaction' }>

type InputNode = Extract<
  TrajectorySnapshot['eventNodes'][number],
  { kind: 'user' | 'steering' | 'context' }
>

type OrderedLayoutEntry =
  | {
    kind: 'node'
    seq: number
    node: TrajectorySnapshot['eventNodes'][number]
    nodeIndex: number
  }
  | {
    kind: 'compaction'
    seq: number
    request: CompactionRequestView
  }
  | {
    kind: 'system'
    seq: number
    request?: AssistantRequestView
    systemPrompt?: string
    change: RequestPromptChange
  }
  | {
    kind: 'request'
    seq: number
    request: AssistantRequestView
  }
  | {
    kind: 'revert'
    seq: number
    revert: TrajectoryRevertBoundary
  }

/** One revert file row rendered by the ledger. */
interface RevertFileRow {
  readonly path: string
  readonly status: string
  readonly dest?: string
}

/** Statuses the revert tray omits because the file was never affected. */
const REVERT_HIDDEN_STATUSES: ReadonlySet<string> = new Set(['no_op', 'already_clean'])

/** Display labels for the statuses the file-revert plugin seals. */
const REVERT_STATUS_KEYS: Readonly<Record<string, TrajectoryKey>> = {
  restored: 'revert.statusRestored',
  trashed: 'revert.statusTrashed',
  kept: 'revert.statusKept',
  overridden: 'revert.statusOverridden',
  saved_beside: 'revert.statusSavedBeside',
  pending_conflict: 'revert.statusConflictPending',
  conflict_escalated: 'revert.statusConflictEscalated',
  error: 'revert.statusError',
}

function revertFileRow(path: string, status: string, dest: string | undefined): RevertFileRow {
  return { path, status, ...(dest === undefined || dest === '' ? {} : { dest }) }
}

/**
 * Attribute one durable batch record to its revert boundary: the nearest
 * boundary whose anchor the record cites, else the nearest preceding boundary.
 */
function revertBatchOwner(
  boundaries: readonly TrajectoryRevertBoundary[],
  seq: number,
  revertSeq: number | undefined,
): number | undefined {
  let fallback: number | undefined
  for (let index = boundaries.length - 1; index >= 0; index--) {
    const boundary = boundaries[index]
    if (boundary === undefined || boundary.seq >= seq) continue
    fallback ??= boundary.seq
    if (revertSeq !== undefined && boundary.fromSeq === revertSeq) return boundary.seq
    if (revertSeq === -1 && boundary.cause === 'restore') return boundary.seq
  }
  return fallback
}

/**
 * Group durable file records under their boundary with last-write-per-path
 * semantics (the client fold's truth), keeping conflicts with no sealed outcome.
 */
function groupRevertFileRows(
  boundaries: readonly TrajectoryRevertBoundary[],
  files: readonly TrajectoryRevertFileResult[],
  conflicts: readonly TrajectoryRevertConflict[],
): ReadonlyMap<number, readonly RevertFileRow[]> {
  const rows = new Map<number, Map<string, RevertFileRow>>()
  const pending = new Map<number, Map<string, RevertFileRow>>()
  const rowsFor = (
    target: Map<number, Map<string, RevertFileRow>>, owner: number,
  ): Map<string, RevertFileRow> => {
    let entry = target.get(owner)
    if (entry === undefined) {
      entry = new Map()
      target.set(owner, entry)
    }
    return entry
  }
  for (const batch of files) {
    const owner = revertBatchOwner(boundaries, batch.seq, batch.revertSeq)
    if (owner === undefined) continue
    const entry = rowsFor(rows, owner)
    for (const [path, value] of Object.entries(batch.outcomes)) {
      // Durable log data: validate the status before trusting the typed fold.
      const outcome = value as { readonly status?: unknown; readonly dest?: unknown }
      if (typeof outcome.status !== 'string') continue
      if (REVERT_HIDDEN_STATUSES.has(outcome.status)) {
        entry.delete(path)
        continue
      }
      entry.set(path, revertFileRow(
        path,
        outcome.status,
        typeof outcome.dest === 'string' ? outcome.dest : undefined,
      ))
    }
  }
  for (const conflict of conflicts) {
    const owner = revertBatchOwner(
      boundaries,
      conflict.seq,
      typeof conflict.boundarySeq === 'number' ? conflict.boundarySeq : undefined,
    )
    if (owner === undefined) continue
    rowsFor(pending, owner).set(
      conflict.targetKey,
      revertFileRow(conflict.displayPath || conflict.targetKey, 'pending_conflict', undefined),
    )
  }
  for (const [owner, conflictsOfBatch] of pending) {
    const entry = rowsFor(rows, owner)
    for (const [targetKey, row] of conflictsOfBatch) {
      // A sealed outcome in the same batch supersedes the pending conflict.
      if (!entry.has(targetKey) && !entry.has(row.path)) entry.set(targetKey, row)
    }
  }
  return new Map([...rows].map(([owner, entry]) => [owner, [...entry.values()]]))
}

/** File rows for the active batch, read from the Session fold the tray reads. */
function liveRevertFileRows(revert: TrajectoryRevertView | undefined): readonly RevertFileRow[] {
  if (revert === undefined) return []
  const rows: RevertFileRow[] = []
  const covered = new Set<string>()
  for (const [path, value] of Object.entries(revert.outcomes)) {
    // Durable log data: validate the status before trusting the typed fold.
    const outcome = value as { readonly status?: unknown; readonly dest?: unknown }
    if (typeof outcome.status !== 'string') continue
    if (REVERT_HIDDEN_STATUSES.has(outcome.status)) continue
    rows.push(revertFileRow(
      path,
      outcome.status,
      typeof outcome.dest === 'string' ? outcome.dest : undefined,
    ))
    covered.add(path)
  }
  for (const conflict of revert.conflicts) {
    if (covered.has(conflict.targetKey)) continue
    rows.push(revertFileRow(conflict.displayPath || conflict.targetKey, 'pending_conflict', undefined))
  }
  return rows
}

function revertFileText(row: RevertFileRow, t: TrajectoryTranslate): string {
  const key = REVERT_STATUS_KEYS[row.status]
  const status = key === undefined ? row.status : t(key)
  return row.dest === undefined
    ? t('revert.fileRow', { path: row.path, status })
    : t('revert.fileRowDest', { path: row.path, status, dest: row.dest })
}

/**
 * Name one revert boundary: the trigger, the reverted span (turns or seq
 * range), how many messages it contains, and whether the span is still live.
 */
function revertBoundaryText(
  revert: TrajectoryRevertBoundary,
  boundaries: readonly TrajectoryRevertBoundary[],
  shadowRanges: readonly SessionRevertShadowRange[],
  nodes: TrajectorySnapshot['eventNodes'],
  activeFromSeq: number | null,
  t: TrajectoryTranslate,
): string {
  if (revert.cause === 'commit') return t('revert.rowCommit')
  if (revert.cause === 'restore') {
    return revert.fromSeq === null
      ? t('revert.rowRestoreAll')
      : t('revert.rowRestore', { from: revert.fromSeq })
  }
  const fromSeq = revert.fromSeq
  if (fromSeq === null) return t('revert.rowRevertUnknown')
  const parts = [t('revert.rowRevert', { from: fromSeq })]
  const replacement = shadowRanges.find(range => range.start === fromSeq)
  const next = boundaries.find(boundary => boundary.seq > revert.seq)
  const endSeq = replacement?.end ?? next?.seq
  let firstTurn = Number.POSITIVE_INFINITY
  let lastTurn = 0
  let messages = 0
  for (const node of nodes) {
    if (node.seq < fromSeq) continue
    if (endSeq !== undefined && node.seq >= endSeq) continue
    if (node.kind === 'assistant' && node.turn > 0) {
      firstTurn = Math.min(firstTurn, node.turn)
      lastTurn = Math.max(lastTurn, node.turn)
    }
    if (node.kind === 'user' || node.kind === 'steering') messages += 1
  }
  if (firstTurn !== Number.POSITIVE_INFINITY) {
    parts.push(firstTurn === lastTurn
      ? t('revert.spanTurn', { turn: firstTurn })
      : t('revert.spanTurns', { from: firstTurn, to: lastTurn }))
  } else if (endSeq !== undefined) {
    parts.push(t('revert.spanSeqs', { from: fromSeq, to: endSeq - 1 }))
  }
  if (messages > 0) parts.push(t('revert.spanMessages', { count: messages }))
  parts.push(replacement === undefined && activeFromSeq === fromSeq
    ? t('revert.pendingHidden')
    : t('revert.spanShadowed'))
  return parts.join(' · ')
}

/** Next assistant at or after a seq, for turn placement of a log-only record. */
function nextAssistantAfter(
  nodes: TrajectorySnapshot['eventNodes'],
  seq: number,
): AssistantMessageNode | undefined {
  for (const node of nodes) {
    if (node.seq > seq && node.kind === 'assistant') return node
  }
  return undefined
}

/** Mark one laid cell as part of a shadowed span or as its replacement commit. */
function markRevertCell(cell: TrajectoryCellProps, ranges: readonly SessionRevertShadowRange[]): void {
  const seq = cell.sourceSeq
  if (cell.kind === 'revert' || seq === undefined) return
  if (ranges.some(range => seq >= range.start && seq < range.end)) {
    cell.shadowed = true
    return
  }
  if (ranges.some(range => range.end === seq)) cell.revertRole = 'replacement'
}

/**
 * Mark a group's cells. Tool cells carry no event seq (their call seq lives on
 * the assistant message), so they inherit the shadow state of the message that
 * requested them.
 */
function markRevertCells(laid: readonly LaidCell[], ranges: readonly SessionRevertShadowRange[]): void {
  let messageShadowed = false
  for (const entry of laid) {
    const cell = entry.cell
    if (cell.kind === 'revert') continue
    markRevertCell(cell, ranges)
    if (cell.kind === 'message') messageShadowed = cell.shadowed === true
    else if (messageShadowed && (cell.kind === 'tool' || cell.kind === 'subtool')) {
      cell.shadowed = true
    }
  }
}

function layoutEntryOrder(entry: OrderedLayoutEntry): number {
  return entry.kind === 'system' && entry.change.kind === 'initial'
    ? Number.NEGATIVE_INFINITY
    : entry.seq
}

function inputCellDetail(node: InputNode, t: TrajectoryTranslate): Pick<
  TrajectoryCellProps,
  | 'text'
  | 'previewMarkdown'
  | 'sourceSeq'
  | 'messageSource'
  | 'inputDetail'
  | 'sourceBlocks'
  | 'timeSeconds'
  | 'startedAt'
> {
  if (node.kind === 'context' && node.content.length > 0
    && node.content.every(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
    const added = node.content.flatMap(block => block.type === 'tool-addition' ? [block.toolName] : [])
    const removed = node.content.flatMap(block => block.type === 'tool-removal' ? [block.toolName] : [])
    const single = node.content.length === 1 ? node.content[0] : undefined
    const summary = added.length > 0 && removed.length > 0
      ? t('layout.toolsChanged', { added: added.length, removed: removed.length })
      : added.length > 0 ? t('layout.toolsAddedCount', { count: added.length })
        : t('layout.toolsRemovedCount', { count: removed.length })
    return {
      text: single !== undefined
        ? t(single.type === 'tool-addition' ? 'layout.toolAdded' : 'layout.toolRemoved', { name: single.toolName })
        : `${t('layout.toolUpdateNotice')} · ${summary}`,
      sourceSeq: node.seq,
      sourceBlocks: node.content.map(block => ({ type: block.type, content: block.toolName })),
      ...(single !== undefined ? {} : { inputDetail: [
        ...added.length > 0 ? [t('layout.toolsAdded', { names: added.join(', ') })] : [],
        ...removed.length > 0 ? [t('layout.toolsRemoved', { names: removed.join(', ') })] : [],
      ].join('\n') }),
      timeSeconds: 0,
      startedAt: finiteTime(node.time),
    }
  }
  const preview = previewContent(node.content)
  const previewMarkdown = preview === '' ? undefined : preview
  const images = imageBlockCount(node.content)
  const files = fileBlockCount(node.content)
  const attachmentSummary = [
    images > 0
      ? t('layout.imageCount', { count: images })
      : undefined,
    files > 0 ? t('layout.fileAttachments', { count: files }) : undefined,
  ].filter((value): value is string => value !== undefined).join(' · ')
  return {
    text: attachmentSummary,
    ...(previewMarkdown === undefined ? {} : { previewMarkdown }),
    sourceSeq: node.seq,
    messageSource: node.source,
    inputDetail: detailContent(node.content),
    sourceBlocks: node.content.map(block => sourceBlock(block)),
    timeSeconds: 0,
    startedAt: finiteTime(node.time),
  }
}

/**
 * Fold a snapshot into turn → Message/Step groups with expanded cells.
 * @param input - nodes plus in-flight partial/runningCalls.
 * @param t - Trajectory locale translator.
 * @returns turns ordered by first appearance.
 */
export function deriveTrajectoryLayout(
  input: TrajectoryLayoutInput,
  t: TrajectoryTranslate,
): readonly TrajectoryTurnModel[] {
  const {
    nodes, eventLocations, partial, runningCalls, requests = [], callSchemas,
  } = input
  const reverts = input.reverts ?? []
  const shadowRanges = input.revert?.shadowRanges ?? []
  const revertFileRows = groupRevertFileRows(
    reverts,
    input.revertFiles ?? [],
    input.revertConflicts ?? [],
  )
  const liveRevertRows = liveRevertFileRows(input.revert)
  const activeFromSeq = input.revert?.fromSeq ?? null
  const latestRevert = reverts.at(-1)
  const liveRevertRowsApply = liveRevertRows.length > 0
    && (activeFromSeq === null || latestRevert?.fromSeq === activeFromSeq)
  const resultByCall = indexResults(nodes)
  const callById = new Map<string, ToolCallBlock>(resultByCall)
  for (const call of runningCalls) callById.set(call.callId, call)
  const emittedCallIds = indexAssistantCallIds(nodes)
  const followingAssistants = indexFollowingAssistants(nodes)
  const callStartById = new Map<string, number>()
  for (const result of resultByCall.values()) {
    const startedAt = finiteTime(result.callTime)
    if (startedAt !== null) callStartById.set(result.callId, startedAt)
  }
  for (const call of runningCalls) {
    if (call.phase === 'preparing') continue
    const startedAt = finiteTime(call.time)
    if (startedAt !== null) callStartById.set(call.callId, startedAt)
  }
  const turns = new Map<number, TurnBucket>()
  const standaloneCompactions: TurnBucket[] = []
  let index = 0
  let prevAbsTime: number | null = null
  let lastAssistantTurn: number | null = null

  const bucket = (turn: number) => {
    let entry = turns.get(turn)
    if (entry === undefined) {
      entry = { groups: [] }
      turns.set(turn, entry)
    }
    return entry
  }

  const pushMessage = (turn: number, laid: LaidCell) => {
    const groups = bucket(turn).groups
    const last = groups.at(-1)
    if (last?.title === t('group.message')) {
      last.laid.push(laid)
      return
    }
    groups.push({ title: t('group.message'), laid: [laid] })
  }
  const pushStep = (turn: number, step: number, laid: readonly LaidCell[]) => {
    if (laid.length === 0) return
    const groups = bucket(turn).groups
    const title = t('group.step', { step })
    const existing = groups.find(group => group.title === title)
    if (existing !== undefined) {
      existing.laid.push(...laid)
      return
    }
    groups.push({ title, laid: [...laid] })
  }
  const pushStepInput = (turn: number, step: number, laid: readonly LaidCell[]) => {
    if (laid.length === 0) return
    const groups = bucket(turn).groups
    const title = t('group.step', { step })
    const existing = groups.find(group => group.title === title)
    if (existing === undefined) {
      groups.push({ title, laid: [...laid] })
      return
    }
    const request = existing.laid.findIndex(entry => entry.cell.requestOnly === true)
    if (request === -1) existing.laid.push(...laid)
    else existing.laid.splice(request, 0, ...laid)
  }
  const pushRevert = (turn: number, laid: readonly LaidCell[]) => {
    if (laid.length === 0) return
    const groups = bucket(turn).groups
    const title = t('group.revert')
    const existing = groups.find(group => group.title === title)
    if (existing !== undefined) {
      existing.laid.push(...laid)
      return
    }
    groups.push({ title, laid: [...laid] })
  }

  const representedRequests = new Set<string>()
  for (const node of nodes) {
    if (node.kind === 'assistant' && node.step > 0) {
      representedRequests.add(`${node.turn}\u0000${node.step}`)
    }
  }
  if (partial !== null && partial.step > 0) {
    representedRequests.add(`${partial.turn}\u0000${partial.step}`)
  }
  for (const call of runningCalls) {
    if (call.step > 0) representedRequests.add(`${call.turn}\u0000${call.step}`)
  }

  const entries: OrderedLayoutEntry[] = [
    ...(input.systemPrompts ?? []).map(prompt => ({
      kind: 'system' as const, seq: prompt.seq, systemPrompt: prompt.text,
      change: { seq: prompt.seq, time: prompt.time, kind: prompt.update ? 'system' as const : 'initial' as const },
    })),
    ...nodes.map((node, nodeIndex) => ({
      kind: 'node' as const,
      seq: node.seq,
      node,
      nodeIndex,
    })),
    ...requests
      .filter((request): request is CompactionRequestView =>
        request.purpose === 'compaction')
      .map(request => ({
        kind: 'compaction' as const,
        seq: request.startSeq,
        request,
      })),
    ...requests.flatMap(request => request.purpose !== 'assistant'
      || request.promptChange === undefined
      || request.prompt === undefined
      ? []
      : [{
        kind: 'system' as const,
        seq: request.promptChange.seq,
        request,
        change: request.promptChange,
      }]),
    ...requests
      .filter((request): request is AssistantRequestView =>
        request.purpose === 'assistant')
      .filter(request =>
        !representedRequests.has(`${request.turn}\u0000${request.step}`),
      )
      .map(request => ({
        kind: 'request' as const,
        seq: request.startSeq,
        request,
      })),
    ...reverts.map(revert => ({
      kind: 'revert' as const,
      seq: revert.seq,
      revert,
    })),
  ].sort((left, right) => layoutEntryOrder(left) - layoutEntryOrder(right))

  for (const entry of entries) {
    if (entry.kind === 'revert') {
      const { revert } = entry
      const turn = enclosingUserTurn(nextAssistantAfter(nodes, revert.seq), partial, lastAssistantTurn)
      const laid: LaidCell[] = [{
        absTime: finiteTime(revert.time),
        cell: {
          index: ++index,
          kind: 'revert',
          revertRole: 'boundary',
          sourceSeq: revert.seq,
          text: revertBoundaryText(revert, reverts, shadowRanges, nodes, activeFromSeq, t),
          inputDetail: JSON.stringify(revert, null, 2),
          timeSeconds: 0,
          startedAt: finiteTime(revert.time),
        },
      }]
      const rows = revert.seq === latestRevert?.seq && liveRevertRowsApply
        ? liveRevertRows
        : revertFileRows.get(revert.seq) ?? []
      for (const row of rows) {
        laid.push({
          absTime: null,
          cell: {
            index: ++index,
            kind: 'revert',
            revertRole: 'file',
            text: revertFileText(row, t),
            timeSeconds: null,
          },
        })
      }
      pushRevert(turn, laid)
      prevAbsTime = finiteTime(revert.time) ?? prevAbsTime
      continue
    }
    if (entry.kind === 'request') {
      const { request } = entry
      pushStep(request.turn, request.step, [{
        absTime: finiteTime(request.startedAt),
        cell: {
          index: ++index,
          kind: 'message',
          text: '',
          sourceSeq: request.startSeq,
          requestOnly: true,
          timeSeconds: request.completedAt === null
            ? null
            : durationSeconds(request.completedAt, request.startedAt),
          startedAt: finiteTime(request.startedAt),
          ...(request.status === 'error' ? { isError: true } : {}),
        },
      }])
      prevAbsTime = finiteTime(request.completedAt)
        ?? finiteTime(request.startedAt)
        ?? prevAbsTime
      continue
    }
    if (entry.kind === 'system') {
      const { change, request } = entry
      const turn = change.kind === 'initial'
        ? firstVisibleTurn(nodes, partial)
        : enclosingPromptTurn(nodes, change.seq, partial)
      pushMessage(turn, {
        absTime: finiteTime(change.time),
        cell: {
          index: ++index,
          kind: 'system',
          text: promptChangeLabel(change, t),
          sourceSeq: change.seq,
          ...(request?.prompt === undefined ? {} : { promptDetail: request.prompt }),
          ...(entry.systemPrompt === undefined ? {} : { systemPromptDetail: entry.systemPrompt }),
          ...(change.previous === undefined
            ? {}
            : { previousPromptDetail: change.previous }),
          timeSeconds: 0,
          startedAt: finiteTime(change.time),
        },
      })
      prevAbsTime = finiteTime(change.time) ?? prevAbsTime
      continue
    }
    if (entry.kind === 'compaction') {
      const request = entry.request
      const rawOutput = request.rawOutput ?? request.summary
      const thinkingDetail = rawOutput === undefined
        ? ''
        : detailReasoning(rawOutput)
      const cell: TrajectoryCellProps = {
        index: ++index,
        kind: 'compacted',
        text: request.status === 'running'
          ? t('layout.compacting')
          : request.status === 'error'
            ? request.error === COMPACTION_INTERRUPTED_ERROR
              ? t('layout.compactionInterrupted')
              : request.error ?? t('layout.compactionFailed')
            : request.summary === undefined
              ? t('layout.compacted')
              : '',
        ...(request.status === 'complete' && request.summary !== undefined
          ? previewContentProperty(request.summary)
          : {}),
        sourceSeq: request.startSeq,
        ...(request.summary === undefined
          ? {}
          : {
            outputDetail: detailContent(request.summary),
            outputBlocks: request.summary.map(block => sourceBlock(block)),
          }),
        ...(thinkingDetail === '' ? {} : { thinkingDetail }),
        ...(rawOutput === undefined
          ? {}
          : { sourceBlocks: rawOutput.map(block => sourceBlock(block)) }),
        ...(request.status === 'error' ? { isError: true } : {}),
        timeSeconds: request.completedAt === null
          ? null
          : durationSeconds(request.completedAt, request.startedAt),
        startedAt: finiteTime(request.startedAt),
      }
      attachUsage(cell, request.usage as UsageLike | undefined)
      const compaction: TurnBucket = {
        groups: [{
          title: t('group.compaction', { seq: request.startSeq }),
          laid: [{
            absTime: finiteTime(request.startedAt),
            cell,
          }],
        }],
      }
      if (request.turn === null) standaloneCompactions.push(compaction)
      else bucket(request.turn).groups.push(...compaction.groups)
      prevAbsTime = finiteTime(request.completedAt) ?? finiteTime(request.startedAt) ?? prevAbsTime
      continue
    }
    const { node, nodeIndex: i } = entry
    if (node.kind === 'user') {
      // user/message has no turn on the wire; enclose it in the next assistant
      // (or partial) turn, else open the turn after the last assistant.
      const turn = enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn)
      pushMessage(turn, {
        absTime: finiteTime(node.time),
        cell: {
          index: ++index,
          kind: 'user',
          ...inputCellDetail(node, t),
          opensTurn: true,
        },
      })
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'steering') {
      const placement = steeringPlacement(
        followingAssistants[i],
        partial,
        lastAssistantTurn,
        eventLocations?.get(node.seq),
      )
      const laid = {
        absTime: finiteTime(node.time),
        cell: {
          index: ++index,
          kind: 'user' as const,
          ...inputCellDetail(node, t),
        },
      }
      if (placement.step === undefined) pushMessage(placement.turn, laid)
      else pushStepInput(placement.turn, placement.step, [laid])
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'assistant') {
      const laidList = withSubCalls(
        expandAssistant(node, index + 1, prevAbsTime, resultByCall, callStartById, callById, t),
        t,
      )
      if (node.step > 0) pushStep(node.turn, node.step, laidList)
      else for (const laid of laidList) pushMessage(node.turn, laid)
      const last = laidList[laidList.length - 1]
      if (last !== undefined) index = last.cell.index
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      lastAssistantTurn = node.turn
      continue
    }
    if (node.kind === 'context') {
      const turn = enclosingUserTurn(followingAssistants[i], partial, lastAssistantTurn)
      pushMessage(turn, {
        absTime: finiteTime(node.time),
        cell: {
          index: ++index,
          kind: 'context',
          ...inputCellDetail(node, t),
        },
      })
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'compaction') {
      // Chat owns the human-facing compaction marker. It contributes no
      // duplicate trajectory cell, but still advances the duration cursor.
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
      continue
    }
    if (node.kind === 'tool-result') {
      if (!emittedCallIds.has(node.callId)) {
        const toolName = node.call?.name
        const resultPreview = summarizeResult(node, t)
        const laidList: LaidCell[] = [{
          absTime: finiteTime(node.callTime ?? node.time),
          ...(toolName !== undefined ? { toolName } : {}),
          callId: node.callId,
          subCalls: node.subCalls,
          cell: {
            index: ++index,
            kind: 'tool',
            sourceSeq: node.seq,
            ...(node.call !== null
              ? summarizeCall(node.call.name, node.call.argsRaw)
              : resultAsText(resultPreview)),
            ...(node.call !== null ? { inputDetail: node.call.argsRaw } : {}),
            outputDetail: detailResult(node, t),
            outputBlocks: node.content.map(block => sourceBlock(block)),
            ...resultPreview,
            callId: node.callId,
            isError: node.isError,
            timeSeconds: durationSeconds(node.time, node.callTime),
            startedAt: finiteTime(node.callTime),
          },
        }]
        for (const laid of expandSubCalls(node.subCalls, index, t)) {
          laidList.push(laid)
          index = laid.cell.index
        }
        pushStep(0, 1, laidList)
      }
      prevAbsTime = finiteTime(node.time) ?? prevAbsTime
    }
  }

  if (partial !== null) {
    const fake: AssistantMessageNode = {
      kind: 'assistant', seq: Number.MAX_SAFE_INTEGER, time: 0,
      turn: partial.turn, step: partial.step, blocks: partial.blocks,
    }
    const laidList = withSubCalls(expandAssistant(
      fake,
      index + 1,
      prevAbsTime,
      resultByCall,
      callStartById,
      callById,
      t,
      { streaming: true },
    ), t)
    if (partial.step > 0) pushStep(partial.turn, partial.step, laidList)
    else for (const laid of laidList) pushMessage(partial.turn, laid)
    const last = laidList[laidList.length - 1]
    if (last !== undefined) index = last.cell.index
  }

  const seenCalls = collectCallIds(turns)
  for (const call of runningCalls) {
    if (call.phase === 'preparing' || seenCalls.has(call.callId)) continue
    const laidList: LaidCell[] = [{
      absTime: null,
      toolName: call.name,
      callId: call.callId,
      subCalls: call.subCalls,
      cell: {
        index: ++index,
        kind: 'tool',
        ...summarizeCall(call.name, call.argsRaw),
        inputDetail: call.argsRaw,
        callId: call.callId,
        timeSeconds: null,
        startedAt: finiteTime(call.time),
      },
    }]
    for (const laid of expandSubCalls(call.subCalls, index, t)) {
      laidList.push(laid)
      index = laid.cell.index
    }
    if (call.step > 0) pushStep(call.turn, call.step, laidList)
    else for (const laid of laidList) pushMessage(call.turn, laid)
  }

  // Orphan turn-0 cells (orphaned tools) fold into Turn 1.
  const prologue = turns.get(0)
  if (prologue !== undefined) {
    turns.delete(0)
    const emptyTurn = (): TurnBucket => ({ groups: [] })
    const first = turns.get(1) ?? emptyTurn()
    first.groups = [...prologue.groups, ...first.groups]
    turns.set(1, first)
  }

  for (const entry of [...turns.values(), ...standaloneCompactions]) {
    for (const group of entry.groups) {
      for (const laid of group.laid) attachToolSchema(laid, callSchemas)
    }
  }

  if (shadowRanges.length > 0) {
    for (const entry of [...turns.values(), ...standaloneCompactions]) {
      for (const group of entry.groups) {
        markRevertCells(group.laid, shadowRanges)
      }
    }
  }

  return [
    ...[...turns.entries()].map(([turn, entry]) => toTurnModel(turn, entry, t)),
    ...standaloneCompactions.map(entry => toTurnModel(null, entry, t)),
  ].sort((left, right) => firstCellIndex(left) - firstCellIndex(right))
}

/**
 * Append the changing in-flight assistant cells to a stable finalized layout.
 * @param turns - Finalized layout derived with an empty-block partial anchor.
 * @param partial - Current in-flight assistant projection.
 * @param lastIndex - Highest cell index in the finalized layout.
 * @param t - Trajectory locale translator.
 * @returns The original layout without a partial, otherwise a layout sharing every unaffected turn.
 */
export function appendTrajectoryPartialLayout(
  turns: readonly TrajectoryTurnModel[],
  partial: TrajectorySnapshot['partial'],
  lastIndex: number,
  t: TrajectoryTranslate,
): readonly TrajectoryTurnModel[] {
  if (partial === null) return turns
  const partialTurn = deriveTrajectoryLayout({
    nodes: [],
    partial,
    runningCalls: [],
  }, t).at(0)
  if (partialTurn === undefined) return turns
  const streamed: TrajectoryTurnModel = {
    ...partialTurn,
    groups: partialTurn.groups.map(group => ({
      ...group,
      cells: group.cells.map(cell => ({ ...cell, index: cell.index + lastIndex })),
    })),
  }
  const turnIndex = turns.findIndex(turn => turn.turn === streamed.turn)
  if (turnIndex === -1) return [...turns, streamed]
  const current = turns[turnIndex]
  /* v8 ignore next -- findIndex proved the dense array position exists. */
  if (current === undefined) return turns
  const groups = [...current.groups]
  for (const streamedGroup of streamed.groups) {
    const groupIndex = groups.findIndex(group => group.title === streamedGroup.title)
    if (groupIndex === -1) {
      groups.push(streamedGroup)
      continue
    }
    const group = groups[groupIndex]
    /* v8 ignore next -- findIndex proved the dense array position exists. */
    if (group === undefined) continue
    const streamedCallIds = new Set(
      streamedGroup.cells.flatMap(cell => cell.callId === undefined ? [] : [cell.callId]),
    )
    groups[groupIndex] = {
      ...streamedGroup,
      cells: [
        ...group.cells.filter(cell =>
          cell.requestOnly !== true
          && (cell.callId === undefined || !streamedCallIds.has(cell.callId)),
        ),
        ...streamedGroup.cells,
      ],
    }
  }
  const updated = [...turns]
  updated[turnIndex] = { ...current, groups }
  return updated
}

function attachToolSchema(
  laid: LaidCell,
  callSchemas: RequestInspectionSnapshot['callSchemas'] | undefined,
): void {
  if (laid.callId === undefined || callSchemas === undefined) return
  const schema = callSchemas.get(laid.callId)
  if (schema === undefined) return
  laid.cell.schemaDetail = JSON.stringify(schema, null, 2)
}

function toTurnModel(
  turn: number | null,
  entry: TurnBucket,
  t: TrajectoryTranslate,
): TrajectoryTurnModel {
  const groups = entry.groups.map(({ title, laid }): TrajectoryGroupModel => {
    const description = groupDescription(laid, t)
    return {
      title,
      ...(description !== undefined ? { description } : {}),
      cells: laid.map(l => l.cell),
    }
  })
  return { turn, groups }
}

/** Chronological section position from the fold's monotonically assigned cell indexes. */
function firstCellIndex(turn: TrajectoryTurnModel): number {
  return Math.min(
    ...turn.groups.flatMap(group => group.cells.map(cell => cell.index)),
    Number.POSITIVE_INFINITY,
  )
}

/** Wall-span duration + tool histogram, e.g. `1.5 s bash×6`. */
function groupDescription(
  laid: readonly LaidCell[],
  t: TrajectoryTranslate,
): string | undefined {
  const parts: string[] = []
  // Tool rows contribute start (absTime) and end (start + own duration) so a
  // single Tool cell still spans call→result for the group wall clock.
  const times: number[] = []
  for (const l of laid) {
    if (l.absTime === null || !Number.isFinite(l.absTime)) continue
    times.push(l.absTime)
    if (l.cell.kind === 'tool' && l.cell.timeSeconds !== null && Number.isFinite(l.cell.timeSeconds)) {
      times.push(l.absTime + l.cell.timeSeconds * 1000)
    }
  }
  if (times.length >= 2) {
    const span = formatGroupDuration((Math.max(...times) - Math.min(...times)) / 1000, t)
    if (span !== undefined) parts.push(span)
  } else if (times.length === 1) {
    const own = laid.find(l => l.absTime === times[0])?.cell.timeSeconds
    const span = own !== null && own !== undefined ? formatGroupDuration(own, t) : undefined
    if (span !== undefined) parts.push(span)
  }
  const tools = new Map<string, number>()
  for (const l of laid) {
    if (l.toolName === undefined || l.cell.kind !== 'tool') continue
    tools.set(l.toolName, (tools.get(l.toolName) ?? 0) + 1)
  }
  for (const [name, count] of tools) {
    parts.push(count > 1 ? `${name}×${count}` : name)
  }
  return parts.length === 0 ? undefined : parts.join(' ')
}

function formatGroupDuration(
  seconds: number,
  t: TrajectoryTranslate,
): string | undefined {
  if (!Number.isFinite(seconds)) return undefined
  return formatElapsedSeconds(seconds, t)
}

/** Own-duration seconds from two epoch-ms stamps; null when either is unusable. */
function durationSeconds(later: number, earlier: number | null): number | null {
  if (earlier === null || !Number.isFinite(later) || !Number.isFinite(earlier)) return null
  return Math.max(0, (later - earlier) / 1000)
}

/** Epoch-ms usable as an absolute time, else null. */
function finiteTime(time: number | null | undefined): number | null {
  return typeof time === 'number' && Number.isFinite(time) ? time : null
}

function expandAssistant(
  node: AssistantMessageNode,
  startIndex: number,
  prevAbsTime: number | null,
  results: Map<string, ToolResultNode>,
  callStarts: ReadonlyMap<string, number>,
  calls: ReadonlyMap<string, ToolCallBlock>,
  t: TrajectoryTranslate,
  opts?: { streaming?: boolean },
): LaidCell[] {
  if (opts?.streaming === true && node.blocks.length === 0) return []
  const out: LaidCell[] = []
  let index = startIndex - 1
  const usage = node.usage as UsageLike | undefined
  const streaming = opts?.streaming === true
  const recordedStart = finiteTime(node.timing?.stepStartTime)
  const messageDuration = streaming
    ? null
    : durationSeconds(node.time, recordedStart ?? prevAbsTime)
  const nodeAbs = streaming ? null : finiteTime(node.time)
  const messageText = node.blocks
    .filter(block => block.kind === 'text' && (!streaming || block.text !== ''))
    .map(block => block.kind === 'text' ? block.text : '')
    .join('\n\n')
  const thinkingText = node.blocks
    .filter(block => block.kind === 'reasoning' && (!streaming || block.text !== ''))
    .map(block => block.kind === 'reasoning' ? block.text : '')
    .join('\n\n')
  const message: TrajectoryCellProps = {
    index: ++index,
    recordId: `assistant\u0000${node.turn}\u0000${node.step}`,
    kind: 'message',
    sourceSeq: node.seq,
    text: messageText !== '' || thinkingText !== ''
      ? ''
      : summarizeAssistantActivity(node.blocks, t),
    ...(messageText !== ''
      ? { previewMarkdown: messageText }
      : thinkingText !== ''
        ? { previewMarkdown: thinkingText }
        : {}),
    ...(messageText !== '' ? { outputDetail: messageText } : {}),
    ...(thinkingText !== '' ? { thinkingDetail: thinkingText } : {}),
    sourceBlocks: node.blocks.map(block => assistantSourceBlock(block)),
    timeSeconds: messageDuration,
    startedAt: recordedStart,
  }
  attachUsage(message, usage)
  message.assistantMetrics = {
    timingRecorded: node.timing !== undefined,
    stepStartTime: node.timing?.stepStartTime ?? null,
    firstTokenTime: node.timing?.firstTokenTime ?? null,
    completedTime: streaming ? null : finiteTime(node.time),
    usageProvided: usage !== undefined,
    outputTokens: Number.isFinite(usage?.outputTokens) ? usage?.outputTokens ?? null : null,
  }
  out.push({ absTime: nodeAbs, cell: message })

  for (const block of node.blocks) {
    // Text and reasoning belong to the one Assistant record emitted above.
    if (block.kind !== 'tool-call') continue
    const result = results.get(block.callId)
    const toolDuration = streaming || result === undefined
      ? null
      : durationSeconds(result.time, result.callTime)
    const callAbs = finiteTime(callStarts.get(block.callId))
    const call = calls.get(block.callId)
    const resultPreview = result === undefined ? undefined : summarizeResult(result, t)
    out.push({
      absTime: callAbs,
      toolName: block.name,
      callId: block.callId,
      ...(call === undefined ? {} : { subCalls: call.subCalls }),
      cell: {
        index: ++index, kind: 'tool',
        ...summarizeCall(block.name, block.argsRaw),
        inputDetail: block.argsRaw,
        callId: block.callId,
        ...(result !== undefined
          ? {
            outputDetail: detailResult(result, t),
            outputBlocks: result.content.map(block => sourceBlock(block)),
            ...resultPreview,
            isError: result.isError,
          }
          : {}),
        timeSeconds: toolDuration,
        startedAt: callAbs,
      },
    })
  }
  return out
}

function summarizeAssistantActivity(
  blocks: readonly AssistantBlock[],
  t: TrajectoryTranslate,
): string {
  const tools = new Map<string, number>()
  for (const block of blocks) {
    if (block.kind !== 'tool-call') continue
    tools.set(block.name, (tools.get(block.name) ?? 0) + 1)
  }
  if (tools.size > 0) {
    return t('layout.toolCallOnly')
  }
  const images = blocks.filter(block => block.kind === 'image').length
  if (images > 0) return t('layout.imageCount', { count: images })
  return ''
}

function promptChangeLabel(change: RequestPromptChange, t: TrajectoryTranslate): string {
  if (change.kind === 'initial') return t('layout.initialSystemPrompt')
  if (change.kind === 'system') return t('layout.systemPromptUpdated')
  if (change.kind === 'tools') return t('layout.toolsUpdated')
  return t('layout.systemPromptAndToolsUpdated')
}

function assistantSourceBlock(block: AssistantBlock): TrajectorySourceBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', content: block.text }
    case 'reasoning': return { type: 'thinking', content: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      content: block.argsRaw,
      callId: block.callId,
      toolName: block.name,
    }
    case 'image': return sourceBlock({ type: 'image', attachment: block.attachment })
    case 'other': return sourceBlock(block.block)
  }
}

function sourceBlock(value: unknown): TrajectorySourceBlock {
  if (typeof value !== 'object' || value === null) {
    return { type: 'unknown', content: stringifySourceValue(value) }
  }
  const block = value as Record<string, unknown>
  const type = typeof block.type === 'string' ? block.type : 'unknown'
  if (typeof block.text === 'string') {
    return { type: type === 'reasoning' ? 'thinking' : type, content: block.text }
  }
  if (
    (type === 'image' || type === 'file')
    && typeof block.attachment === 'object' && block.attachment !== null
    && typeof (block.attachment as Record<string, unknown>).attachmentId === 'string'
  ) {
    // Session-log content is validated into core ContentBlocks by the
    // Conversation node assembly; the `attachmentId` guard only keeps
    // wire-shaped 'other' blocks with an unrelated `attachment` member out.
    return {
      type,
      content: stringifySourceValue(value),
      ...(type === 'image'
        ? { attachment: block.attachment as ImageAttachmentRef }
        : { file: block.attachment as FileAttachmentRef }),
    }
  }
  return { type, content: stringifySourceValue(value) }
}

function imageBlockCount(content: readonly { type: string }[]): number {
  return content.filter(block => block.type === 'image').length
}

function fileBlockCount(content: readonly { type: string }[]): number {
  return content.filter(block => block.type === 'file').length
}

function stringifySourceValue(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
  return json || String(value)
}

/**
 * Turn that encloses a user/message: next assistant turn, else the
 * in-flight partial, else the turn after the last finalized assistant (or 1).
 */
function enclosingUserTurn(
  followingAssistant: AssistantMessageNode | undefined,
  partial: TrajectorySnapshot['partial'],
  lastAssistantTurn: number | null,
): number {
  if (followingAssistant !== undefined) return followingAssistant.turn
  if (partial !== null) return partial.turn
  if (lastAssistantTurn !== null) return lastAssistantTurn + 1
  return 1
}

function steeringPlacement(
  followingAssistant: AssistantMessageNode | undefined,
  partial: TrajectorySnapshot['partial'],
  lastAssistantTurn: number | null,
  location: ConversationLocation | undefined,
): { turn: number; step?: number } {
  if (location?.kind === 'step') {
    return { turn: location.turn.turn, step: location.step.step }
  }
  const locatedTurn = location?.kind === 'turn' ? location.turn.turn : undefined
  if (followingAssistant !== undefined
    && (locatedTurn === undefined || followingAssistant.turn === locatedTurn)) {
    return {
      turn: followingAssistant.turn,
      ...(followingAssistant.step > 0 ? { step: followingAssistant.step } : {}),
    }
  }
  if (partial !== null && (locatedTurn === undefined || partial.turn === locatedTurn)) {
    return { turn: partial.turn, ...(partial.step > 0 ? { step: partial.step } : {}) }
  }
  if (locatedTurn !== undefined) return { turn: locatedTurn }
  return { turn: lastAssistantTurn ?? 1 }
}

function indexFollowingAssistants(
  nodes: TrajectorySnapshot['eventNodes'],
): readonly (AssistantMessageNode | undefined)[] {
  const following = new Array<AssistantMessageNode | undefined>(nodes.length)
  let assistant: AssistantMessageNode | undefined
  for (let index = nodes.length - 1; index >= 0; index--) {
    following[index] = assistant
    const node = nodes[index]
    if (node?.kind === 'assistant') assistant = node
  }
  return following
}

function enclosingPromptTurn(
  nodes: TrajectorySnapshot['eventNodes'],
  seq: number,
  partial: TrajectorySnapshot['partial'],
): number {
  const next = nodes.find(node =>
    node.seq > seq && node.kind === 'assistant' && node.step > 0)
  if (next?.kind === 'assistant') return next.turn
  return partial?.turn ?? 1
}

/** Earliest raw turn represented by the selected trajectory branch. */
function firstVisibleTurn(
  nodes: TrajectorySnapshot['eventNodes'],
  partial: TrajectorySnapshot['partial'],
): number {
  const turns = nodes.flatMap(node =>
    node.kind === 'assistant' && node.turn > 0
      ? [node.turn]
      : [],
  )
  if (partial !== null && partial.turn > 0) turns.push(partial.turn)
  return turns.length === 0 ? 1 : Math.min(...turns)
}

/** Copy provider usage onto a Message cell when present. */
function attachUsage(cell: TrajectoryCellProps, usage: UsageLike | undefined): void {
  if (usage === undefined) return
  if (usage.inputTokens !== undefined) cell.input = usage.inputTokens
  if (usage.cacheReadTokens !== undefined) cell.cacheRead = usage.cacheReadTokens
  if (usage.cacheWriteTokens !== undefined) cell.cacheWrite = usage.cacheWriteTokens
  if (usage.outputTokens !== undefined) cell.output = usage.outputTokens
  if (usage.reasoningTokens !== undefined) cell.think = usage.reasoningTokens
}

function indexResults(nodes: TrajectorySnapshot['eventNodes']): Map<string, ToolResultNode> {
  const map = new Map<string, ToolResultNode>()
  for (const node of nodes) {
    if (node.kind === 'tool-result') map.set(node.callId, node)
  }
  return map
}

function indexAssistantCallIds(nodes: TrajectorySnapshot['eventNodes']): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    for (const block of node.blocks) {
      if (block.kind === 'tool-call') ids.add(block.callId)
    }
  }
  return ids
}

function collectCallIds(
  turns: Map<number, TurnBucket>,
): Set<string> {
  const ids = new Set<string>()
  for (const entry of turns.values()) {
    for (const group of entry.groups) {
      for (const laid of group.laid) {
        if (laid.callId !== undefined) ids.add(laid.callId)
      }
    }
  }
  return ids
}



/** Interleave each tool cell's nested child calls right after it, reindexing followers. */
function withSubCalls(laidList: LaidCell[], t: TrajectoryTranslate): LaidCell[] {
  if (!laidList.some(laid => laid.subCalls !== undefined && laid.subCalls.length > 0)) return laidList
  const out: LaidCell[] = []
  let index = laidList[0] !== undefined ? laidList[0].cell.index - 1 : 0
  for (const laid of laidList) {
    out.push({ ...laid, cell: { ...laid.cell, index: ++index } })
    for (const sub of expandSubCalls(laid.subCalls, index, t)) {
      out.push(sub)
      index = sub.cell.index
    }
  }
  return out
}

/** Sub-dispatch cells for one run_code parent, in start order (running = null duration). */
function expandSubCalls(
  subs: readonly ToolCallBlock[] | undefined,
  startIndex: number,
  t: TrajectoryTranslate,
): LaidCell[] {
  if (subs === undefined || subs.length === 0) return []
  const out: LaidCell[] = []
  let index = startIndex
  for (const sub of subs) {
    if (!('kind' in sub) && sub.phase === 'preparing') continue
    const settled = 'kind' in sub
    const resultPreview = settled ? summarizeResult(sub, t) : undefined
    const laid: LaidCell = {
      absTime: settled ? finiteTime(sub.callTime ?? sub.time) : finiteTime(sub.time),
      toolName: settled ? sub.call?.name ?? sub.callId : sub.name,
      callId: sub.callId,
      cell: {
        index: ++index,
        kind: 'subtool',
        callId: sub.callId,
        ...(settled
          ? (sub.call !== null
            ? summarizeCall(sub.call.name, sub.call.argsRaw)
            : resultAsText(resultPreview))
          : summarizeCall(sub.name, sub.argsRaw)),
        ...(settled
          ? (sub.call !== null ? { inputDetail: sub.call.argsRaw } : {})
          : { inputDetail: sub.argsRaw }),
        ...(settled
          ? {
            outputDetail: detailResult(sub, t),
            outputBlocks: sub.content.map(block => sourceBlock(block)),
            ...resultPreview,
            isError: sub.isError,
          }
          : {}),
        // The code-dispatch start/settle pair carries per-sub-call wall time;
        // a running (unsettled) or pre-pair log entry shows the em dash.
        timeSeconds: settled ? durationSeconds(sub.time, sub.callTime) : null,
        startedAt: settled
          ? finiteTime(sub.callTime)
          : finiteTime(sub.time),
      },
    }
    out.push(laid)
    for (const child of expandSubCalls(sub.subCalls, index, t)) {
      out.push(child)
      index = child.cell.index
    }
  }
  return out
}

function summarizeCall(
  name: string,
  argsRaw: string,
): Pick<TrajectoryCellProps, 'text' | 'previewMarkdown' | 'toolName'> {
  return {
    toolName: name,
    text: name,
    ...(argsRaw === '' ? {} : { previewMarkdown: argsRaw }),
  }
}

function summarizeResult(
  node: ToolResultNode,
  t: TrajectoryTranslate,
): Pick<TrajectoryCellProps, 'result' | 'resultPreviewMarkdown'> {
  if (node.isError) {
    return { result: node.error?.code ?? 'error' }
  }
  for (const block of node.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      return { result: '', resultPreviewMarkdown: block.text }
    }
  }
  const images = imageBlockCount(node.content)
  if (images > 0) return { result: t('layout.imageCount', { count: images }) }
  return { result: t('record.noOutput') }
}

function resultAsText(
  result: Pick<TrajectoryCellProps, 'result' | 'resultPreviewMarkdown'> | undefined,
): Pick<TrajectoryCellProps, 'text' | 'previewMarkdown'> {
  return {
    text: result?.result ?? '',
    ...(result?.resultPreviewMarkdown === undefined
      ? {}
      : { previewMarkdown: result.resultPreviewMarkdown }),
  }
}

function detailResult(node: ToolResultNode, t: TrajectoryTranslate): string {
  if (node.isError) {
    return node.error === undefined
      ? 'error'
      : `${node.error.name}: ${node.error.code}`
  }
  const text = node.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
  if (text !== '') return text
  const images = imageBlockCount(node.content)
  if (images > 0) return t('layout.imageCount', { count: images })
  if (
    node.content.length === 0
    || node.content.every(block =>
      block.type === 'text' && (typeof block.text !== 'string' || block.text === ''))
  ) return t('record.noOutput')
  return JSON.stringify(node.content, null, 2)
}

function detailContent(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
}

function detailReasoning(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter(block => block.type === 'reasoning' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
}

function previewContent(
  content: readonly { type: string; text?: string }[],
): string | undefined {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return undefined
}

function previewContentProperty(
  content: readonly { type: string; text?: string }[],
): Pick<TrajectoryCellProps, 'previewMarkdown'> {
  const previewMarkdown = previewContent(content)
  return previewMarkdown === undefined ? {} : { previewMarkdown }
}
