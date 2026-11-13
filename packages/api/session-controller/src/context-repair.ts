/**
 * Operator context-repair planning, detached validation, and private backup artifacts.
 *
 * The capability corrects one existing single-line text block inside a
 * model-generated `user/message` (a compaction checkpoint or an Enpoi keeper
 * checkpoint). It never appends a generic event or exposes a model tool: the
 * validated replacement is planned on detached Sessions, then applied through
 * the owning live Session under `Agent.runMaintenance`.
 *
 * @module @deepseek-ai/dsh-api-session-controller/context-repair
 */

import { constants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { validateCompactionEvents } from '@deepseek-ai/dsh-compaction/invariant'
import { canonicalizeWatchPath, dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionMessageProjection,
} from '@deepseek-ai/dsh-session'
import type {
  ContextRepairFingerprint,
  ContextRepairPreviewId,
  ContextRepairProjection,
  ContextRepairProjectionMessage,
  SessionContextRepairPreviewValue,
  SessionContextRepairTarget,
} from './types.ts'

/** Source kinds a repair may target; every other source is refused. */
function isGeneratedContextSourceKind(kind: string): kind is 'compact-checkpoint' | 'enpoi-keeper' {
  return kind === 'compact-checkpoint' || kind === 'enpoi-keeper'
}

/** Default private backup root under the harness home, beside Session logs.
 * @returns absolute `$DSH_HOME/backups/context-repair` path.
 */
export function defaultContextRepairBackupRoot(): string {
  return dshHomePath('backups', 'context-repair')
}

/** Default lifetime of one prepared preview plan. */
export const DEFAULT_CONTEXT_REPAIR_PREVIEW_TTL_MS = 5 * 60 * 1000

/** Default retained prepared preview plans per controller. */
export const DEFAULT_CONTEXT_REPAIR_PREVIEW_MAX_PLANS = 32

/** Default maximum canonical artifact bytes copied by one backup. */
export const DEFAULT_CONTEXT_REPAIR_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024

/** Default maximum replacement code units. */
export const DEFAULT_CONTEXT_REPAIR_MAX_REPLACEMENT_CHARS = 16 * 1024

/** Default maximum serialized preview bytes returned to the operator. */
export const DEFAULT_CONTEXT_REPAIR_MAX_PREVIEW_BYTES = 512 * 1024

/** Complete resource limits for preview, replacement, and backup. */
export interface ContextRepairLimits {
  readonly maxArtifactBytes: number
  readonly maxReplacementChars: number
  readonly maxPreviewBytes: number
}

/** Deployment defaults for the three context-repair resource bounds. */
export const DEFAULT_CONTEXT_REPAIR_LIMITS: ContextRepairLimits = Object.freeze({
  maxArtifactBytes: DEFAULT_CONTEXT_REPAIR_MAX_ARTIFACT_BYTES,
  maxReplacementChars: DEFAULT_CONTEXT_REPAIR_MAX_REPLACEMENT_CHARS,
  maxPreviewBytes: DEFAULT_CONTEXT_REPAIR_MAX_PREVIEW_BYTES,
})

/** Receipt files are immutable snapshots of one apply attempt. */
export type ContextRepairReceiptStatus = 'prepared' | 'applied' | 'partial' | 'failed'

/** Canonical artifact metadata verified before and after a byte copy. */
export interface ContextRepairArtifactSnapshot {
  /** Canonical Session log artifact path at backup time. */
  readonly path: string
  /** SHA-256 of the copied bytes. */
  readonly sha256: string
  readonly sizeBytes: number
  readonly mode: number
  readonly dev: number
  readonly ino: number
  readonly mtimeMs: number
}

/** One prepared backup artifact written beside the receipt. */
export interface ContextRepairBackupSnapshot {
  readonly path: string
  readonly sha256: string
  readonly sizeBytes: number
}

/** Thin durable plan retained by the preview cache. */
export interface ContextRepairPlan {
  readonly previewId: ContextRepairPreviewId
  readonly fingerprint: ContextRepairFingerprint
  readonly sessionId: SessionId
  readonly headSeq: number
  readonly headSha256: string
  readonly targetSeq: number
  readonly sourceKind: 'compact-checkpoint' | 'enpoi-keeper'
  readonly blockIndex: number
  readonly blockSha256: string
  readonly oldLineSha256: string
  readonly oldLine: string
  readonly oldBlockText: string
  readonly newBlockText: string
  readonly replacementLine: string
  readonly repairedMessage: UserMessage
  readonly previousSourceEventSeqs: readonly number[]
  readonly sourceEventSeqs: readonly number[]
}

/** Inputs required to plan one preview against a detached replay. */
export interface ContextRepairPlanInput {
  readonly sessionId: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
  readonly projections: readonly SessionMessageProjection[]
  readonly target: SessionContextRepairTarget
  readonly limits: ContextRepairLimits
  readonly expectedHeadSeq?: number
  readonly expectedHeadSha256?: string
}

/** Detached preview result plus the thin plan retained for apply. */
export interface ContextRepairPlanResult {
  readonly plan: ContextRepairPlan
  readonly preview: SessionContextRepairPreviewValue
}

/** One validation refusal with a stable operator-facing reason. */
export class ContextRepairRefusal extends Error {
  /**
   * @param reason - stable machine-readable refusal reason.
   * @param message - complete operator-facing explanation.
   * @param head - provider-decoded head when a logical head mismatch supplied one.
   */
  constructor(
    readonly reason: string,
    message: string,
    readonly head?: { readonly seq: number; readonly sha256: string },
  ) {
    super(message)
    this.name = 'ContextRepairRefusal'
  }
}

/** Hash one UTF-8 string with SHA-256.
 * @param value - exact UTF-8 text.
 * @returns lowercase hexadecimal SHA-256 digest.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Hash exact artifact bytes with SHA-256.
 * @param value - exact artifact bytes.
 * @returns lowercase hexadecimal SHA-256 digest.
 */
export function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Serialize JSON data with recursively sorted object keys so equal values
 * always hash identically across live and detached observations.
 * @param value - lossless JSON value.
 * @returns canonical compact JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON refuses non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new Error(`canonical JSON refuses ${typeof value}`)
}

/** Whether a supplied digest is one lowercase or uppercase SHA-256 hex string. */
function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value)
}

/** Admit one exact non-negative integer wire value. */
function exactInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new ContextRepairRefusal('invalid-target', `${label} must be a non-negative safe integer`)
  }
  return value
}

/** Admit one non-empty, size-bounded, single-line replacement. */
function singleLine(value: unknown, maxChars: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContextRepairRefusal('invalid-replacement', 'replacementLine must be one non-empty line')
  }
  if (value.length > maxChars) {
    throw new ContextRepairRefusal(
      'replacement-too-large',
      `replacementLine exceeds the configured ${String(maxChars)}-character limit`,
    )
  }
  if (/[\n\r\u2028\u2029\u0085]/u.test(value)) {
    throw new ContextRepairRefusal(
      'invalid-replacement',
      'replacementLine must not contain CR, LF, NEL, or a Unicode line separator',
    )
  }
  return value
}

/** Derive the canonical head identity of one event.
 * @param event - committed Session event.
 * @returns event seq and the SHA-256 of its canonical envelope and data.
 */
export function canonicalEventHead(event: SessionEvent): { readonly seq: number; readonly sha256: string } {
  return {
    seq: event.seq,
    sha256: sha256Hex(canonicalJson({ seq: event.seq, event })),
  }
}

/** Derive the canonical head identity from a log snapshot.
 * @param events - contiguous log snapshot.
 * @returns inclusive head seq and the SHA-256 of the canonical head event.
 */
export function sessionHead(events: readonly SessionEvent[]): { readonly seq: number; readonly sha256: string } {
  const seq = events.length - 1
  const head = seq < 0 ? null : events[seq]
  return {
    seq,
    sha256: sha256Hex(canonicalJson({ seq, event: head ?? null })),
  }
}

/**
 * Derive the model context hash, active surface seqs, and per-message labels
 * without reading request bodies or calling a model.
 * @param session - live or detached Session.
 * @param headSeq - inclusive log head the projection covers.
 * @returns deterministic context metadata.
 */
export function projectSessionContext(session: Session, headSeq: number): ContextRepairProjection {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = session.snapshotEvents()
  const messages: ContextRepairProjectionMessage[] = []
  for (const seq of session.surface.nodes) {
    const event = events[seq]
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    messages.push({
      seq,
      role: message.role,
      sourceKind: message.source.kind,
      sha256: sha256Hex(canonicalJson({
        role: message.role,
        source: message.source,
        content: message.content,
      })),
    })
  }
  const activeSeqs = Object.freeze([...session.surface.nodes])
  const frozenMessages = Object.freeze(messages.map(message => Object.freeze(message)))
  return Object.freeze({
    headSeq,
    activeSeqs,
    messages: frozenMessages,
    sha256: sha256Hex(canonicalJson({
      headSeq,
      activeSeqs,
      messages: frozenMessages.map(message => ({
        seq: message.seq,
        role: message.role,
        sourceKind: message.sourceKind,
        sha256: message.sha256,
      })),
    })),
  })
}

/** Build one detached replay through the same validator a durable seed uses. */
function detachedSession(input: {
  readonly sessionId: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
  readonly projections: readonly SessionMessageProjection[]
}): Session {
  try {
    return Session.create(
      input.sessionId,
      input.events,
      input.header,
      SessionLogOffset(input.inheritedEventCount),
      input.projections,
    )
  } catch (error: unknown) {
    throw new ContextRepairRefusal(
      'detached-replay-rejected',
      `the detached Session replay rejected the candidate log: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** Read the target's prior citations after checking they are all earlier and unique. */
function previousSourceEventSeqs(event: SessionEvent<'user/message'>, targetSeq: number): number[] {
  const prior = event.sourceEventSeqs
  if (prior === undefined) return []
  const seen = new Set<number>()
  const result: number[] = []
  for (const seq of prior) {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= targetSeq) {
      throw new ContextRepairRefusal('invalid-source', 'the target cites a non-earlier source event')
    }
    if (seen.has(seq)) throw new ContextRepairRefusal('invalid-source', 'the target cites a duplicate source event')
    seen.add(seq)
    result.push(seq)
  }
  return result
}

/** Validate one target block and build the repaired message without touching a live Session. */
function repairedMessageOf(
  events: readonly SessionEvent[],
  target: SessionContextRepairTarget,
  maxReplacementChars: number,
): {
  readonly targetSeq: number
  readonly sourceKind: 'compact-checkpoint' | 'enpoi-keeper'
  readonly blockIndex: number
  readonly blockSha256: string
  readonly oldLineSha256: string
  readonly oldLine: string
  readonly oldBlockText: string
  readonly newBlockText: string
  readonly replacementLine: string
  readonly repairedMessage: UserMessage
  readonly previousSourceEventSeqs: readonly number[]
} {
  const targetSeq = exactInteger(target.seq, 'target.seq')
  const blockIndex = exactInteger(target.blockIndex, 'target.blockIndex')
  if (!isSha256Hex(target.expectedBlockSha256)) {
    throw new ContextRepairRefusal('invalid-hash', 'expectedBlockSha256 must be a SHA-256 hex digest')
  }
  if (!isSha256Hex(target.expectedOldLineSha256)) {
    throw new ContextRepairRefusal('invalid-hash', 'expectedOldLineSha256 must be a SHA-256 hex digest')
  }
  const replacementLine = singleLine(target.replacementLine, maxReplacementChars)

  const event = events[targetSeq]
  if (event === undefined) {
    throw new ContextRepairRefusal('missing-target', `event ${String(targetSeq)} does not exist`)
  }
  if (event.type !== 'user/message') {
    throw new ContextRepairRefusal('invalid-target', `event ${String(targetSeq)} is "${event.type}", not a user/message`)
  }
  const sourceKind = event.data.source.kind
  if (!isGeneratedContextSourceKind(sourceKind)) {
    throw new ContextRepairRefusal(
      'invalid-source',
      `event ${String(targetSeq)} source kind "${sourceKind}" is not a generated context source`,
    )
  }
  if (sourceKind === 'compact-checkpoint') {
    const compactionId = (event.data.source as { readonly compactionId?: unknown }).compactionId
    if (typeof compactionId !== 'string' || compactionId.length === 0) {
      throw new ContextRepairRefusal('invalid-source', 'the compaction-checkpoint source has no compactionId')
    }
  }
  const priorSources = previousSourceEventSeqs(event, targetSeq)
  const content = event.data.content
  const block = content[blockIndex]
  if (block === undefined) {
    throw new ContextRepairRefusal('invalid-block', `event ${String(targetSeq)} has no content block ${String(blockIndex)}`)
  }
  if (block.type !== 'text') {
    throw new ContextRepairRefusal('invalid-block', `content block ${String(blockIndex)} is "${block.type}", not text`)
  }
  const oldBlockText = block.text
  const blockSha256 = sha256Hex(oldBlockText)
  const expectedBlockSha256 = target.expectedBlockSha256.toLowerCase()
  if (blockSha256 !== expectedBlockSha256) {
    throw new ContextRepairRefusal(
      'block-hash-mismatch',
      `content block ${String(blockIndex)} does not match expectedBlockSha256`,
    )
  }

  const lines = oldBlockText.split('\n')
  const expectedOldLineSha256 = target.expectedOldLineSha256.toLowerCase()
  const matches: number[] = []
  for (const [index, line] of lines.entries()) {
    if (sha256Hex(line) === expectedOldLineSha256) matches.push(index)
  }
  if (matches.length === 0) {
    throw new ContextRepairRefusal('line-hash-mismatch', 'no line matches expectedOldLineSha256')
  }
  if (matches.length > 1) {
    throw new ContextRepairRefusal('line-not-unique', 'more than one line matches expectedOldLineSha256')
  }
  const lineIndex = matches[0]
  if (lineIndex === undefined) {
    throw new ContextRepairRefusal('line-hash-mismatch', 'no line matches expectedOldLineSha256')
  }
  const oldLine = lines[lineIndex] ?? ''
  if (oldLine.length === 0) {
    throw new ContextRepairRefusal('empty-line', 'the matched line is empty; a repair cannot target a blank line')
  }
  if (oldLine === replacementLine) {
    throw new ContextRepairRefusal('no-change', 'replacementLine equals the existing line')
  }
  const nextLines = [...lines]
  nextLines[lineIndex] = replacementLine
  const newBlockText = nextLines.join('\n')

  const nextContent = content.map((existing, index) => {
    if (index !== blockIndex) return existing
    if (existing.type !== 'text') {
      throw new ContextRepairRefusal('invalid-block', `content block ${String(blockIndex)} could not be copied`)
    }
    return { ...existing, text: newBlockText }
  })
  const repairedMessage: UserMessage = {
    ...structuredClone(event.data),
    content: nextContent,
  }
  return {
    targetSeq,
    sourceKind,
    blockIndex,
    blockSha256,
    oldLineSha256: expectedOldLineSha256,
    oldLine,
    oldBlockText,
    newBlockText,
    replacementLine,
    repairedMessage,
    previousSourceEventSeqs: priorSources,
  }
}

/** Create one unpredictable preview token.
 * @returns a 256-bit random opaque preview identity.
 */
export function createContextRepairPreviewId(): ContextRepairPreviewId {
  return brandString<ContextRepairPreviewId>(randomBytes(32).toString('base64url'))
}

/** Hash the changeable plan fields a preview and apply must agree on. */
function fingerprintOf(input: {
  readonly sessionId: SessionId
  readonly headSeq: number
  readonly headSha256: string
  readonly targetSeq: number
  readonly sourceKind: string
  readonly blockIndex: number
  readonly blockSha256: string
  readonly oldLineSha256: string
  readonly replacementLine: string
  readonly previousSourceEventSeqs: readonly number[]
  readonly sourceEventSeqs: readonly number[]
}): ContextRepairFingerprint {
  return brandString<ContextRepairFingerprint>(sha256Hex(canonicalJson(input)))
}

/**
 * Plan one repair from a detached replay. No live Session or persistence write
 * occurs here; the returned plan carries the exact replacement the caller saw.
 * @param input - current log snapshot, projections, limits, and requested target.
 * @returns the thin durable plan and its read-only preview value.
 */
export function planContextRepair(input: ContextRepairPlanInput): ContextRepairPlanResult {
  const before = detachedSession(input)
  const beforeHead = sessionHead(input.events)
  const target = repairedMessageOf(input.events, input.target, input.limits.maxReplacementChars)

  const targetIndex = before.surface.nodes.indexOf(SessionSeq(target.targetSeq))
  if (targetIndex === -1) {
    throw new ContextRepairRefusal(
      'target-not-active',
      `event ${String(target.targetSeq)} is not an active surface node`,
    )
  }

  if (input.expectedHeadSeq !== undefined || input.expectedHeadSha256 !== undefined) {
    if (input.expectedHeadSeq === undefined || input.expectedHeadSha256 === undefined) {
      throw new ContextRepairRefusal('invalid-head', 'expectedHeadSeq and expectedHeadSha256 must be supplied together')
    }
    if (!isSha256Hex(input.expectedHeadSha256)) {
      throw new ContextRepairRefusal('invalid-head', 'expectedHeadSha256 must be a SHA-256 hex digest')
    }
    if (exactInteger(input.expectedHeadSeq, 'expectedHeadSeq') !== beforeHead.seq
      || input.expectedHeadSha256.toLowerCase() !== beforeHead.sha256) {
      throw new ContextRepairRefusal('stale-head', 'the Session head no longer matches the expected seq and hash')
    }
  }

  const sourceEventSeqs = [
    target.targetSeq,
    ...target.previousSourceEventSeqs.filter(seq => seq !== target.targetSeq),
  ]
  const proposed: SessionEvent<'user/message'> = {
    type: 'user/message',
    seq: SessionSeq(input.events.length),
    time: 0,
    data: target.repairedMessage,
    surfaceOp: { op: 'replace', startSeq: SessionSeq(target.targetSeq), endSeq: SessionSeq(target.targetSeq) },
    sourceEventSeqs: sourceEventSeqs.map(seq => SessionSeq(seq)),
  }
  try {
    validateCompactionEvents([...input.events, proposed], input.projections, (message) => {
      throw new Error(message)
    })
  } catch (error: unknown) {
    throw new ContextRepairRefusal(
      'detached-replay-rejected',
      `the planned compaction event stream violates its invariants: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const after = detachedSession({ ...input, events: [...input.events, proposed] })
  const afterNodes = after.surface.nodes
  if (afterNodes[targetIndex] !== proposed.seq) {
    throw new ContextRepairRefusal('invalid-plan', 'the detached replacement did not occupy the target surface position')
  }
  for (const [index, seq] of before.surface.nodes.entries()) {
    if (index !== targetIndex && afterNodes[index] !== seq) {
      throw new ContextRepairRefusal('invalid-plan', 'the detached replacement changed another surface node')
    }
  }

  const beforeProjection = projectSessionContext(before, beforeHead.seq)
  const afterProjection = projectSessionContext(after, input.events.length)
  const previewId = createContextRepairPreviewId()
  const fingerprint = fingerprintOf({
    sessionId: input.sessionId,
    headSeq: beforeHead.seq,
    headSha256: beforeHead.sha256,
    targetSeq: target.targetSeq,
    sourceKind: target.sourceKind,
    blockIndex: target.blockIndex,
    blockSha256: target.blockSha256,
    oldLineSha256: target.oldLineSha256,
    replacementLine: target.replacementLine,
    previousSourceEventSeqs: target.previousSourceEventSeqs,
    sourceEventSeqs,
  })
  const preview: SessionContextRepairPreviewValue = {
    previewId,
    fingerprint,
    sessionId: input.sessionId,
    head: beforeHead,
    target: {
      seq: target.targetSeq,
      sourceKind: target.sourceKind,
      blockIndex: target.blockIndex,
      blockSha256: target.blockSha256,
      oldLineSha256: target.oldLineSha256,
    },
    before: beforeProjection,
    after: afterProjection,
    diff: {
      targetSeq: target.targetSeq,
      blockIndex: target.blockIndex,
      oldLine: target.oldLine,
      replacementLine: target.replacementLine,
      oldBlockSha256: target.blockSha256,
      newBlockSha256: sha256Hex(target.newBlockText),
      surfaceOp: { op: 'replace', startSeq: target.targetSeq, endSeq: target.targetSeq },
      sourceEventSeqs,
    },
  }
  if (Buffer.byteLength(JSON.stringify(preview), 'utf8') > input.limits.maxPreviewBytes) {
    throw new ContextRepairRefusal(
      'preview-too-large',
      `the preview exceeds the configured ${String(input.limits.maxPreviewBytes)}-byte limit`,
    )
  }
  return {
    plan: {
      previewId,
      fingerprint,
      sessionId: input.sessionId,
      headSeq: beforeHead.seq,
      headSha256: beforeHead.sha256,
      targetSeq: target.targetSeq,
      sourceKind: target.sourceKind,
      blockIndex: target.blockIndex,
      blockSha256: target.blockSha256,
      oldLineSha256: target.oldLineSha256,
      oldLine: target.oldLine,
      oldBlockText: target.oldBlockText,
      newBlockText: target.newBlockText,
      replacementLine: target.replacementLine,
      repairedMessage: target.repairedMessage,
      previousSourceEventSeqs: target.previousSourceEventSeqs,
      sourceEventSeqs,
    },
    preview,
  }
}

/**
 * Cheaply revalidate a plan against the current log: exact head, target block
 * hashes, preserved citations, and active surface presence only. No projection
 * fold runs here.
 * @param session - live Session.
 * @param plan - prepared thin plan.
 */
export function revalidateContextRepairPlan(session: Session, plan: ContextRepairPlan): void {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = session.snapshotEvents()
  const head = sessionHead(events)
  if (head.seq !== plan.headSeq || head.sha256 !== plan.headSha256) {
    throw new ContextRepairRefusal('stale-head', 'the Session head changed after preview')
  }
  const targetEvent = events[plan.targetSeq]
  const targetSourceKind: string | undefined = targetEvent?.type === 'user/message'
    ? targetEvent.data.source.kind
    : undefined
  if (targetEvent?.type !== 'user/message'
    || !isGeneratedContextSourceKind(targetSourceKind ?? '')
    || targetSourceKind !== plan.sourceKind
    || !sameNumberList(targetEvent.sourceEventSeqs, plan.previousSourceEventSeqs)) {
    throw new ContextRepairRefusal('target-changed', 'the target event metadata changed after preview')
  }
  const target = repairedMessageOf(events, {
    seq: plan.targetSeq,
    blockIndex: plan.blockIndex,
    expectedBlockSha256: plan.blockSha256,
    expectedOldLineSha256: plan.oldLineSha256,
    replacementLine: plan.replacementLine,
  }, plan.replacementLine.length)
  if (target.sourceKind !== plan.sourceKind
    || target.blockSha256 !== plan.blockSha256
    || target.oldLineSha256 !== plan.oldLineSha256
    || target.newBlockText !== plan.newBlockText
    || !sameNumberList(target.previousSourceEventSeqs, plan.previousSourceEventSeqs)) {
    throw new ContextRepairRefusal('target-changed', 'the target block changed after preview')
  }
  if (!session.surface.nodes.includes(SessionSeq(plan.targetSeq))) {
    throw new ContextRepairRefusal('target-not-active', 'the target is no longer an active surface node')
  }
}

/** Compare two sequence lists exactly. */
function sameNumberList(left: readonly number[] | undefined, right: readonly number[]): boolean {
  if (left === undefined) return right.length === 0
  return left.length === right.length && left.every((seq, index) => seq === right[index])
}

/** Resolve the configured backup root, expanding only supported home prefixes.
 * @param configured - optional absolute or `~/`-prefixed backup root.
 * @returns normalized absolute backup root.
 */
export function resolveContextRepairBackupRoot(configured?: string): string {
  const selected = configured === undefined ? defaultContextRepairBackupRoot() : expandHomePath(configured)
  if (selected.trim().length === 0) {
    throw new ContextRepairRefusal('backup-root-invalid', 'the context-repair backup root must not be empty')
  }
  if (selected.startsWith('~')) {
    throw new ContextRepairRefusal(
      'backup-root-invalid',
      'the context-repair backup root supports only `~`, `~/`, or `~\\\\` home prefixes',
    )
  }
  if (!isAbsolute(selected)) {
    throw new ContextRepairRefusal('backup-root-invalid', 'the context-repair backup root must be absolute')
  }
  return resolve(selected)
}

/** fsync a POSIX directory so a just-created entry is crash-durable. */
async function syncDirectory(path: string): Promise<void> {
  /* v8 ignore next -- Windows cannot open directory handles; NTFS journaling owns entry durability. */
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Create one private random backup directory under a private root.
 * @param root - resolved absolute backup root.
 * @returns canonical absolute path of the new private directory.
 */
export async function createContextRepairBackupDirectory(root: string): Promise<string> {
  const absoluteRoot = resolve(root)
  let info
  try {
    info = await lstat(absoluteRoot)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(absoluteRoot, { recursive: true, mode: 0o700 })
    await syncDirectory(dirname(absoluteRoot))
    info = await lstat(absoluteRoot)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ContextRepairRefusal('backup-failed', 'the repair backup root is not a real directory')
  }
  const canonicalRoot = await realpath(absoluteRoot)
  const canonicalInfo = await stat(canonicalRoot)
  if (!canonicalInfo.isDirectory()) {
    throw new ContextRepairRefusal('backup-failed', 'the repair backup root is not a directory')
  }
  if (process.platform !== 'win32') {
    if ((canonicalInfo.mode & 0o077) !== 0) {
      throw new ContextRepairRefusal('backup-failed', 'the repair backup root is not owner-private')
    }
    if (typeof process.getuid === 'function' && canonicalInfo.uid !== process.getuid()) {
      throw new ContextRepairRefusal('backup-failed', 'the repair backup root belongs to another user')
    }
  }
  const directory = await mkdtemp(join(canonicalRoot, 'context-repair-'))
  const directoryInfo = await stat(directory)
  if (process.platform !== 'win32' && (directoryInfo.mode & 0o077) !== 0) {
    throw new ContextRepairRefusal('backup-failed', 'the repair backup directory is not owner-private')
  }
  await syncDirectory(canonicalRoot)
  return await realpath(directory)
}

/**
 * Assert both the configured backup root and the canonical Session log tree
 * are disjoint private locations before a backup directory is created.
 * @param input - backup root, session log root, canonical artifact, and harness home.
 * @returns the canonical artifact path after location checks.
 */
export async function assertContextRepairBackupLocation(input: {
  readonly backupRoot: string
  readonly sessionLogRoot: string
  readonly artifactPath: string
  readonly dshHome: string
}): Promise<{ readonly artifactPath: string }> {
  let backupRoot: string
  let sessionLogRoot: string
  let artifactPath: string
  let dshHome: string
  try {
    backupRoot = await canonicalizeWatchPath(input.backupRoot)
    sessionLogRoot = await canonicalizeWatchPath(input.sessionLogRoot)
    artifactPath = await realpath(input.artifactPath)
    dshHome = await canonicalizeWatchPath(input.dshHome)
  } catch (error: unknown) {
    throw new ContextRepairRefusal(
      'backup-failed',
      `the repair backup location could not be canonicalized: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (backupRoot === dshHome || isWithinDirectory(dshHome, backupRoot)) {
    throw new ContextRepairRefusal('backup-failed', 'the shared harness home cannot be the repair backup root')
  }
  if (isWithinDirectory(backupRoot, sessionLogRoot) || isWithinDirectory(sessionLogRoot, backupRoot)) {
    throw new ContextRepairRefusal('backup-failed', 'the repair backup root and Session log tree must be separate')
  }
  if (isWithinDirectory(artifactPath, backupRoot) || isWithinDirectory(backupRoot, dirname(artifactPath))) {
    throw new ContextRepairRefusal('backup-failed', 'the repair backup root overlaps the Session artifact')
  }
  return { artifactPath }
}

/**
 * Copy the canonical artifact into a private backup file with one no-follow
 * source descriptor, before/after identity checks, and bounded streaming.
 * @param input - canonical source, private destination directory, limit, and cancellation.
 * @returns verified canonical metadata and the backup copy.
 */
export async function copyContextRepairArtifact(input: {
  readonly sourcePath: string
  readonly directory: string
  readonly maxBytes: number
  readonly signal?: AbortSignal
}): Promise<{ readonly artifact: ContextRepairArtifactSnapshot; readonly backup: ContextRepairBackupSnapshot }> {
  const signal = input.signal
  signal?.throwIfAborted()
  if (!isAbsolute(input.sourcePath)) {
    throw new ContextRepairRefusal('invalid-artifact', 'the provider returned a non-absolute artifact path')
  }
  const linkInfo = await lstat(input.sourcePath)
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    throw new ContextRepairRefusal('invalid-artifact', 'the provider artifact is not a real regular file')
  }
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  const source = await open(input.sourcePath, flags)
  let backup: string | undefined
  let temporary: string | undefined
  try {
    const before = await source.stat()
    signal?.throwIfAborted()
    if (!before.isFile()) throw new ContextRepairRefusal('invalid-artifact', 'the provider artifact is not a regular file')
    if (before.size > input.maxBytes) {
      throw new ContextRepairRefusal(
        'artifact-too-large',
        `the canonical artifact exceeds the configured ${String(input.maxBytes)}-byte backup limit`,
      )
    }
    backup = join(input.directory, 'artifact.backup')
    temporary = join(input.directory, `.artifact.${randomBytes(6).toString('hex')}.tmp`)
    const destination = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256')
    let bytes = 0
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    try {
      while (true) {
        signal?.throwIfAborted()
        const read = await source.read(chunk, 0, chunk.length, null)
        if (read.bytesRead === 0) break
        bytes += read.bytesRead
        if (bytes > input.maxBytes) {
          throw new ContextRepairRefusal(
            'artifact-too-large',
            `the canonical artifact exceeds the configured ${String(input.maxBytes)}-byte backup limit`,
          )
        }
        const slice = chunk.subarray(0, read.bytesRead)
        hash.update(slice)
        await destination.writeFile(slice)
      }
      await destination.sync()
    } finally {
      await destination.close()
    }
    signal?.throwIfAborted()
    const after = await source.stat()
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes !== after.size) {
      throw new ContextRepairRefusal('artifact-changed', 'the canonical artifact changed during the backup copy')
    }
    await link(temporary, backup)
    await rm(temporary, { force: true }).catch(() => undefined)
    const sha256 = hash.digest('hex')
    await syncDirectory(input.directory)
    return {
      artifact: {
        path: input.sourcePath,
        sha256,
        sizeBytes: bytes,
        mode: before.mode,
        dev: before.dev,
        ino: before.ino,
        mtimeMs: before.mtimeMs,
      },
      backup: { path: backup, sha256, sizeBytes: bytes },
    }
  } catch (error) {
    if (backup !== undefined) await rm(backup, { force: true }).catch(() => undefined)
    if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await source.close()
  }
}

/** Write one immutable receipt file with exclusive creation, owner-only mode, and directory fsync.
 * @param directory - private repair directory.
 * @param status - receipt phase named in the file.
 * @param receipt - lossless JSON receipt body.
 * @returns absolute path of the new receipt file.
 */
export async function writeContextRepairReceipt(
  directory: string,
  status: ContextRepairReceiptStatus,
  receipt: Readonly<Record<string, unknown>>,
): Promise<string> {
  const path = join(directory, `receipt.${status}.json`)
  const temporary = join(directory, `.${status}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${canonicalJson(receipt)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temporary, path)
    await rm(temporary, { force: true }).catch(() => undefined)
    await syncDirectory(directory)
    return path
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Judge whether a candidate path lies inside a directory.
 * @param path - candidate absolute or relative path.
 * @param directory - directory to test against.
 * @returns whether the resolved path is the directory or one of its descendants.
 */
export function isWithinDirectory(path: string, directory: string): boolean {
  const candidate = relative(resolve(directory), resolve(path))
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate))
}
