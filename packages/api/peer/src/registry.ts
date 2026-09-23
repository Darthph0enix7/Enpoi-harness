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

import { randomUUID } from 'node:crypto'
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
import type { PeerAnswer, PeerAnswerValue, PeerAskId, PeerPendingAsk } from './types.ts'

interface PendingApprovalAsk {
  readonly askId: PeerAskId
  readonly sessionId: SessionId
  readonly kind: 'approval'
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly since: number
  readonly settle: (outcome: ApprovalOutcome) => void
}

interface PendingQuestionAsk {
  readonly askId: PeerAskId
  readonly sessionId: SessionId
  readonly kind: 'question'
  readonly questions: readonly AskUserQuestionItem[]
  readonly since: number
  readonly settle: (answer: AskUserQuestionAnswer) => void
}

type PendingAsk = PendingApprovalAsk | PendingQuestionAsk

type AskDescriptor =
  | { readonly kind: 'approval'; readonly toolName: string; readonly callId?: string; readonly reason?: string }
  | { readonly kind: 'question'; readonly questions: readonly AskUserQuestionItem[] }

/**
 * Tracks asks a peer may answer and resolves the local-versus-peer race.
 * The host owns the instance; `install` registers the waterfall listeners as
 * effects of the owning fiber.
 */
export class PeerAskRegistry {
  private readonly pending = new Map<string, PendingAsk>()
  private readonly bySession = new Map<SessionId, Set<string>>()
  private readonly settled = new Map<string, number>()

  /**
   * @param ctx - host context owning the waterfall listeners.
   * @param pairings - pairing table deciding which Sessions a peer may answer for.
   */
  constructor(
    private readonly ctx: Context,
    private readonly pairings: PeerPairingsStore,
  ) {}

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
      }
    }, 'peer-api: ask registry')
  }

  /** Pending asks currently exposed for one Session, oldest first. */
  pendingFor(sessionId: SessionId): readonly PeerPendingAsk[] {
    const ids = this.bySession.get(sessionId)
    if (ids === undefined) return []
    const asks: PeerPendingAsk[] = []
    for (const id of ids) {
      const ask = this.pending.get(id)
      if (ask === undefined) continue
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
   * Settle the ask behind one peer answer.
   * @param resolved - pairing/session the request resolved to.
   * @param askId - host-minted ask identity from a state or follow frame.
   * @param answer - approval outcome or structured question answer.
   * @returns acceptance after the ask settled.
   * @throws {@link RemoteError} `peer/not-found`, `peer/forbidden`, or `peer/conflict`.
   */
  answer(resolved: ResolvedPeerPairing, askId: PeerAskId, answer: PeerAnswer): PeerAnswerValue {
    const ask = this.pending.get(askId)
    if (ask === undefined) {
      if (this.settled.has(askId)) {
        throw new RemoteError('peer/conflict', `ask ${JSON.stringify(askId)} was already settled`, { askId })
      }
      throw new RemoteError('peer/not-found', `no pending ask ${JSON.stringify(askId)}`, { askId })
    }
    if (ask.sessionId !== resolved.sessionId) {
      throw new RemoteError(
        'peer/forbidden',
        `ask ${JSON.stringify(askId)} does not belong to the resolved session`,
        { reason: 'ask-session-mismatch' },
      )
    }
    if (ask.kind !== answer.kind) {
      throw new RemoteError('peer/not-found', `ask ${JSON.stringify(askId)} is a ${ask.kind} ask`, { askId })
    }
    // Validate and normalize before claiming: a malformed answer must leave the
    // ask pending, while a valid answer claims it so a second one loses.
    const settled = ask.kind === 'approval' && answer.kind === 'approval'
      ? validateApprovalOutcome(askId, answer.outcome)
      : ask.kind === 'question' && answer.kind === 'question'
        ? normalizeQuestionAnswer(askId, answer.answer)
        : undefined
    if (settled === undefined) {
      throw new RemoteError('peer/not-found', `ask ${JSON.stringify(askId)} kind mismatch`, { askId })
    }
    this.retire(ask)
    if (ask.kind === 'approval') ask.settle(settled as ApprovalOutcome)
    else ask.settle(settled as AskUserQuestionAnswer)
    return { accepted: true, settled: true }
  }

  private raceApproval(
    request: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    // Delegate immediately so a peer answer never delays the local chain.
    const local = next()
    return this.race(request.agent, local, () => ({
      kind: 'approval',
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    }))
  }

  private raceQuestion(
    request: AskUserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const local = next()
    // An ask that cannot be attributed to an agent stays local (§9.1 fallback).
    if (request.agent === undefined) return local
    return this.race(request.agent, local, () => ({ kind: 'question', questions: request.questions }))
  }

  private async race<T>(
    agent: Agent,
    local: Promise<T>,
    describe: () => AskDescriptor,
  ): Promise<T> {
    const sessionId = await this.rootSessionOf(agent)
    if (sessionId === undefined) return local
    // Isolation: only Sessions this host exposes through a pairing are audible.
    if (this.pairings.exposed(sessionId) === undefined) return local
    const descriptor = describe()
    const settled = Promise.withResolvers<T>()
    const askId = brandString<PeerAskId>(randomUUID())
    // D1 evidence trail: the ask (possibly raised by a subagent child) is bound
    // to the root session a peer follows, and only that session's peers see it.
    this.ctx.logger.debug(
      `peer-api: ${descriptor.kind} ask ${askId} bound to session ${sessionId}`,
    )
    const ask: PendingAsk = descriptor.kind === 'approval'
      ? {
        askId,
        sessionId,
        kind: 'approval',
        toolName: descriptor.toolName,
        ...(descriptor.callId === undefined ? {} : { callId: descriptor.callId }),
        ...(descriptor.reason === undefined ? {} : { reason: descriptor.reason }),
        since: Date.now(),
        settle: (value) => { settled.resolve(value as T) },
      }
      : {
        askId,
        sessionId,
        kind: 'question',
        questions: descriptor.questions,
        since: Date.now(),
        settle: (value) => { settled.resolve(value as T) },
      }
    this.publish(ask)
    const outcome = await Promise.race([
      settled.promise.then(value => ({ from: 'peer' as const, value })),
      local.then(value => ({ from: 'local' as const, value })),
    ])
    this.retire(ask)
    return outcome.value
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

  private publish(ask: PendingAsk): void {
    this.pending.set(ask.askId, ask)
    const ids = this.bySession.get(ask.sessionId) ?? new Set<string>()
    ids.add(ask.askId)
    this.bySession.set(ask.sessionId, ids)
  }

  private retire(ask: PendingAsk): void {
    this.pending.delete(ask.askId)
    this.settled.set(ask.askId, Date.now())
    if (this.settled.size > SETTLED_TOMBSTONE_LIMIT) {
      const oldest = this.settled.keys().next().value
      if (oldest !== undefined) this.settled.delete(oldest)
    }
    const ids = this.bySession.get(ask.sessionId)
    if (ids === undefined) return
    ids.delete(ask.askId)
    if (ids.size === 0) this.bySession.delete(ask.sessionId)
  }
}

/** Bounded recent-settlement memory so a raced answer reports `peer/conflict`. */
const SETTLED_TOMBSTONE_LIMIT = 256

/** Validate one peer approval outcome; a peer may not grant standing access. */
function validateApprovalOutcome(askId: PeerAskId, outcome: ApprovalOutcome): ApprovalOutcome {
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
