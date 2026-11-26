/**
 * Session-bound ask registry: the race between a local answerer and a peer.
 *
 * One registry per serving host observes the scoped `approval/request` and
 * `user-questions/request` waterfalls. For asks raised inside a paired
 * Session it mints a `PeerAskId`, exposes the ask to peers, and races the
 * peer's answer against the normal chain — the local UI keeps receiving the
 * ask and whichever side answers first settles it; a late peer answer gets
 * `peer/conflict`.
 *
 * @module @deepseek-ai/dsh-api-peer/registry
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { PeerPairingsStore, ResolvedPeerPairing } from './pairings.ts'
import { AskStore, copyAskQuestions, type AskStoreOptions, type StoredAsk } from './ask-store.ts'
import type { PeerAnswer, PeerAnswerValue, PeerAskId, PeerAskRecord, PeerParticipant, PeerPendingAsk, PeerRequestId } from './types.ts'

type AskDescriptor =
  | { readonly kind: 'approval'; readonly toolName: string; readonly callId?: string; readonly reason?: string }
  | { readonly kind: 'question'; readonly questions: readonly AskUserQuestionItem[] }

/**
 * Tracks asks a peer may answer and resolves the local-versus-peer race.
 * The host owns the instance; `install` registers the waterfall listeners as
 * effects of the owning fiber.
 */
export class PeerAskRegistry {
  private readonly pending = new Map<PeerAskId, (answer: PeerAnswer) => void>()
  private readonly store: AskStore
  private disposed = false
  private readonly changeListeners = new Set<(sessionId: SessionId) => void>()

  /**
   * @param ctx - host context owning the waterfall listeners.
   * @param pairings - pairing table deciding which Sessions a peer may answer for.
   * @param options - bounds and identity of the private ask journal.
   */
  constructor(
    private readonly ctx: Context,
    private readonly pairings: PeerPairingsStore,
    options: AskStoreOptions,
  ) {
    this.store = new AskStore(options)
    try {
      this.store.open()
    } catch (error) {
      ctx.logger.warn('peer-api: ask journal unavailable: %s', String(error))
    }
  }

  /** Register the scoped ask listeners; disposal removes them. */
  install(): void {
    // Prepend: mint the ask before any local forwarding parks the waterfall, so
    // a peer answer can win without the browser ever having to delegate.
    this.ctx.effect(() => {
      const disposeApproval = this.ctx.on('approval/request', (request: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) =>
        this.raceApproval(request, next), { prepend: true })
      const disposeQuestion = this.ctx.on('user-questions/request', (request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>) =>
        this.raceQuestion(request, next), { prepend: true })
      return () => {
        disposeApproval()
        disposeQuestion()
        this.disposed = true
        this.pending.clear()
        this.changeListeners.clear()
      }
    }, 'peer-api: ask registry')
  }

  /**
   * Observe pending-ask membership changes (mint and settle). An ask minted
   * mid-tool-call has no durable event, so a `peer.follow` generation uses this
   * push to re-read the state instead of waiting for the next durable event.
   * The listener runs synchronously on the mutating call and must not call back
   * into the registry.
   * @param listener - called with the Session whose pending-ask set changed.
   * @returns disposer removing the listener.
   */
  onChange(listener: (sessionId: SessionId) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  /**
   * List asks still waiting for an answer on one session.
   * @param sessionId - target Session.
   * @param resolved - authenticated pairing, or absent for an internal observation.
   * @returns pending descriptors, oldest first.
   */
  pendingFor(sessionId: SessionId, resolved?: ResolvedPeerPairing): readonly PeerPendingAsk[] {
    if (!this.isAvailable()) return []
    const asks: PeerPendingAsk[] = []
    for (const ask of this.store.all()) {
      if (ask.sessionId !== sessionId || !this.pending.has(ask.askId)
        || (resolved !== undefined && !belongsTo(ask, resolved))) continue
      asks.push(ask.kind === 'approval'
        ? {
          kind: 'approval',
          askId: ask.askId,
          toolName: ask.toolName,
          ...(ask.callId === undefined ? {} : { callId: ask.callId }),
          ...(ask.reason === undefined ? {} : { reason: ask.reason }),
          since: ask.since,
        }
        : {
          kind: 'question',
          askId: ask.askId,
          questions: ask.questions,
          since: ask.since,
        })
    }
    return asks
  }

  /**
   * Report whether the ask journal can serve records.
   * @returns whether the ask journal opened and can serve bounded records.
   */
  isAvailable(): boolean { return this.store.available && !this.disposed }

  /**
   * List the retained ask records an authenticated pairing may see.
   * @param resolved - authenticated pairing.
   * @returns its retained ask records.
   */
  list(resolved: ResolvedPeerPairing): readonly PeerAskRecord[] {
    this.requireAvailable()
    const asks: PeerAskRecord[] = []
    for (const ask of this.store.all()) {
      if (!belongsTo(ask, resolved)) continue
      const { device: _device, ...visible } = ask
      asks.push(visible)
    }
    return asks.sort((left, right) => left.createdAt - right.createdAt)
  }

  /**
   * Settle the ask behind one peer answer.
   * @param resolved - pairing/session the request resolved to.
   * @param askId - host-minted ask identity from a state or follow frame.
   * @param answer - approval outcome or structured question answer.
   * @param requestId - required retry identity, scoped to the alias.
   * @param participant - authenticated attribution for payload identity.
   * @returns acceptance after the ask settled.
   * @throws {@link RemoteError} `peer/not-found`, `peer/forbidden`, or `peer/conflict`.
   */
  answer(
    resolved: ResolvedPeerPairing,
    askId: PeerAskId,
    answer: PeerAnswer,
    requestId: PeerRequestId,
    participant?: PeerParticipant,
  ): PeerAnswerValue {
    this.requireAvailable()
    const ask = this.store.get(askId)
    const normalized: PeerAnswer = answer.kind === 'approval'
      ? { kind: 'approval', outcome: validateApprovalOutcome(askId, answer.outcome) }
      : { kind: 'question', answer: normalizeQuestionAnswer(askId, answer.answer) }
    const payloadHash = createHash('sha256').update(JSON.stringify([
      resolved.pairing.alias, resolved.sessionId, askId, participant?.name ?? null, participant?.device ?? null, normalized,
    ])).digest('hex')
    for (const candidate of this.store.all()) {
      if (candidate.alias !== resolved.pairing.alias || candidate.device !== resolved.pairing.peer
        || candidate.answeredBy?.requestId !== requestId) continue
      if (candidate.answeredBy.payloadHash !== payloadHash) throw conflict(askId, 'request-id-reuse')
      return { accepted: true, settled: true, replayed: true, payloadHash, instanceId: candidate.instanceId }
    }
    if (ask === undefined) {
      throw new RemoteError('peer/not-found', `no pending ask ${JSON.stringify(askId)}`, { askId, reason: 'ask-not-found' })
    }
    if (!belongsTo(ask, resolved)) {
      throw new RemoteError(
        'peer/forbidden',
        `ask ${JSON.stringify(askId)} does not belong to the resolved session`,
        { reason: 'ask-session-mismatch' },
      )
    }
    if (ask.instanceId !== this.store.options.instanceId) throw conflict(askId, 'stale-generation')
    if (ask.state === 'expired') throw conflict(askId, 'ask-expired')
    if (ask.state !== 'pending') throw conflict(askId, 'ask-already-settled')
    const settle = this.pending.get(askId)
    if (settle === undefined) throw conflict(askId, 'ask-expired')
    if (ask.kind !== normalized.kind) throw new RemoteError('gateway/bad-request', 'answer kind does not match the ask', {})
    try {
      this.store.set({ ...ask, state: 'answered', settledAt: Date.now(), answeredBy: { requestId, payloadHash } })
    } catch (error) {
      throw new RemoteError('peer/unavailable', 'unable to persist peer answer', { reason: 'ask-write-failed' }, { cause: error })
    }
    this.pending.delete(askId)
    settle(normalized)
    this.notify(ask.sessionId)
    return { accepted: true, settled: true, replayed: false, payloadHash, instanceId: ask.instanceId }
  }

  private raceApproval(
    request: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    // Delegate immediately so a peer answer never delays the local chain.
    const local = next()
    return this.race(request.agent, local, request.signal, () => ({
      kind: 'approval',
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    }), answer => answer.kind === 'approval' ? answer.outcome : undefined)
  }

  private raceQuestion(
    request: AskUserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const local = next()
    // An ask that cannot be attributed to an agent stays local (§9.1 fallback).
    if (request.agent === undefined) return local
    return this.race(request.agent, local, request.signal,
      () => ({ kind: 'question', questions: request.questions }), answer => answer.kind === 'question' ? answer.answer : undefined)
  }

  private async race<T>(
    agent: Agent,
    local: Promise<T>,
    signal: AbortSignal | undefined,
    describe: () => AskDescriptor,
    accepted: (answer: PeerAnswer) => T | undefined,
  ): Promise<T> {
    // Attach before asynchronous ancestry lookup so a local rejection remains handled.
    let localFinished = false
    const finishedLocally = (): boolean => localFinished
    const localResult = local.then((value) => {
      localFinished = true
      return { ok: true, value } as const
    }, (error: unknown) => {
      localFinished = true
      return { ok: false, error } as const
    })
    const sessionId = await this.rootSessionOf(agent)
    if (finishedLocally() || sessionId === undefined || !this.isAvailable() || signal?.aborted === true) return local
    const resolved = this.pairings.exposed(sessionId)
    if (resolved === undefined) return local
    const descriptor = describe()
    const settled = Promise.withResolvers<T>()
    const askId = brandString<PeerAskId>(randomUUID())
    const now = Date.now()
    let ask: StoredAsk
    try {
      const safe = descriptor.kind === 'question'
        ? { kind: descriptor.kind, questions: copyAskQuestions(descriptor.questions, this.store.options.maxRecordBytes) }
        : descriptor
      ask = { ...safe, askId, sessionId, alias: resolved.pairing.alias, device: resolved.pairing.peer,
        instanceId: this.store.options.instanceId, createdAt: now, since: now, state: 'pending' }
      if ((descriptor.kind === 'approval' && descriptor.toolName.length + (descriptor.reason?.length ?? 0)
        + (descriptor.callId?.length ?? 0) > this.store.options.maxRecordBytes)
        || Buffer.byteLength(JSON.stringify(ask)) > this.store.options.maxRecordBytes) throw new Error('ask record exceeds byte limit')
      this.store.set(ask)
    } catch (error) {
      this.ctx.logger.warn('peer-api: ask kept local: %s', String(error))
      return local
    }
    this.pending.set(askId, (answer) => {
      const value = accepted(answer)
      if (value !== undefined) settled.resolve(value)
    })
    const onAbort = (): void => {
      if (this.retire(ask, false)) settled.reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    this.notify(sessionId)
    void localResult.then((result) => {
      // Resolve through the same ownership check as peer settlement; Promise.race
      // with separately chained answers can otherwise acknowledge a losing peer.
      if (!this.disposed && !this.pending.has(askId) && signal?.aborted !== true) return
      this.retire(ask, result.ok && result.value !== 'cancelled' && result.value !== 'unavailable')
      if (result.ok) settled.resolve(result.value)
      else settled.reject(result.error)
    })
    try {
      return await settled.promise
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Walk the subagent parent chain to the Session a peer actually follows (D1). */
  private async rootSessionOf(agent: Agent): Promise<SessionId | undefined> {
    let current: SessionId = agent.session.id
    for (let depth = 0; depth < 32; depth += 1) {
      const live: Session | undefined = this.ctx.agents.get(current)?.session
      let header: SessionHeader | undefined = live?.header
      if (header === undefined) {
        try {
          using observation = await this.ctx.sessionQuery.observeSession(current, { projectionMode: 'none' })
          header = observation.header
        } catch {
          return undefined
        }
      }
      if (header.parentSession === undefined) return current
      current = header.parentSession
    }
    return undefined
  }

  private retire(ask: StoredAsk, answered: boolean): boolean {
    if (!this.pending.delete(ask.askId)) return false
    try {
      this.store.set({ ...ask, state: answered ? 'answered' : 'cancelled', settledAt: Date.now(),
        settlementReason: answered ? 'local-answer' : 'local-cancelled' })
    } catch (error) {
      this.store.available = false
      this.ctx.logger.warn('peer-api: ask journal disabled after local settlement write failed: %s', String(error))
    }
    this.notify(ask.sessionId)
    return true
  }

  private notify(sessionId: SessionId): void {
    for (const listener of this.changeListeners) {
      try { listener(sessionId) } catch (error) { this.ctx.logger.warn('peer-api: ask listener failed: %s', String(error)) }
    }
  }

  private requireAvailable(): void {
    if (!this.isAvailable()) throw new RemoteError('peer/unavailable', 'peer ask journal unavailable', { reason: 'ask-store-unavailable' })
  }
}

function belongsTo(ask: StoredAsk, resolved: ResolvedPeerPairing): boolean {
  return ask.sessionId === resolved.sessionId && ask.alias === resolved.pairing.alias && ask.device === resolved.pairing.peer
}

function conflict(askId: PeerAskId, reason: 'ask-already-settled' | 'ask-expired' | 'request-id-reuse' | 'stale-generation'): RemoteError<'peer/conflict'> {
  return new RemoteError('peer/conflict', `ask ${JSON.stringify(askId)}: ${reason}`, { askId, reason })
}

/** Validate one peer approval outcome; a peer may not grant standing access. */
function validateApprovalOutcome(askId: PeerAskId, outcome: ApprovalOutcome): Extract<ApprovalOutcome, 'allowed-once' | 'rejected'> {
  if (outcome !== 'allowed-once' && outcome !== 'rejected') {
    throw new RemoteError(
      'peer/forbidden',
      `ask ${JSON.stringify(askId)} allows allowed-once or rejected only`,
      { reason: 'approval-outcome' },
    )
  }
  return outcome
}

/** Malformed structured answer item at the peer wire boundary. */
function malformedItem(askId: PeerAskId): RemoteError<'peer/not-found'> {
  return new RemoteError('peer/not-found', `answer for ask ${JSON.stringify(askId)} has a malformed item`, { askId })
}

/** Validate and normalize one structured answer at the peer wire boundary. */
function normalizeQuestionAnswer(askId: PeerAskId, value: unknown): AskUserQuestionAnswer {
  const answers = typeof value === 'object' && value !== null
    ? (value as { readonly answers?: unknown }).answers
    : undefined
  if (!Array.isArray(answers)) {
    throw new RemoteError('peer/not-found', `answer for ask ${JSON.stringify(askId)} must carry answers[]`, { askId })
  }
  const items = answers.map((raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw malformedItem(askId)
    const item = raw as { readonly id?: unknown; readonly selected?: unknown; readonly custom?: unknown }
    if (typeof item.id !== 'string' || !Array.isArray(item.selected)
      || !item.selected.every((choice: unknown) => typeof choice === 'string')) {
      throw malformedItem(askId)
    }
    return {
      id: item.id,
      selected: [...item.selected] as string[],
      ...typeof item.custom === 'string' && item.custom.length > 0 ? { custom: item.custom } : {},
    }
  })
  return { answers: items }
}
