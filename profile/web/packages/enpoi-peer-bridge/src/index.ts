/**
 * enpoi-peer-bridge — the caller side of the device-to-device peer API
 * (doc 69 P2, doc 70, doc 27's thin bridge).
 *
 * A local agent uses six tools to work with a *remote* harness session:
 * `peer_status` (handshake + latch + model), `peer_ask` (prompt the remote as
 * an attributed peer turn, follow to a terminal state, return the answer),
 * `peer_sessions` (discover bound sessions across the caller-role pairings),
 * `peer_asks` (pending remote asks), `peer_answer` (settle one), and
 * `peer_cancel`. A remote approval ask raised while following is surfaced to
 * the local operator through the local approval service when that is usable,
 * and the local decision is relayed back with `peer.answer` — first answer
 * wins; a `peer/conflict` is reported, never retried blind. When the remote
 * ask settles elsewhere first, the follow's next `state` frame withdraws the
 * local card instead of leaving it answerable.
 *
 * Pairings are read from `~/.dsh/pairings.yaml` by default; `pairingsPath`
 * points at another document (the live test uses a scratch file and never
 * touches the operator's real one). Follows reconnect with the client's
 * backoff and `peer.page` gap repair; `peer/target-unreachable` surfaces as a
 * tool failure naming the endpoint.
 *
 * @module dsh-enpoi-peer-bridge
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: load the `tools`, `approval`, and `userQuestions` Context augmentations.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import type { AskNotice, AskRecord, LocalAskDecision, QuestionSelection } from './asks.js'
import {
  appendAskNotice,
  askLabel,
  askSummary,
  defaultNoticesPath,
  localDecisionToPeerAnswer,
  normalizeQuestionSelections,
  renderQuestion,
} from './asks.js'
import type { PeerEventRecord, PeerParticipant, PeerPendingAsk, PeerQuestionAnswer, PeerQuestionItem, PeerRepairHole, PeerWebSocket } from './peer-client.js'
import { PeerBridgeError, PeerClient } from './peer-client.js'
import { DEFAULT_SETTLE_QUIET_MS, isPeerSessionSettled, recordAssistantText, recordRpcId, recordSourceKind, recordTerminal, recordTurn } from './follow.js'
import type { DialablePairing, PairingDocument } from './pairings.js'
import { callerPairings, defaultPairingsPath, describeCallerPairings, loadCallerPairing, readPairingDocument } from './pairings.js'

/** Cordis plugin name. */
export const name = 'enpoi-peer-bridge'

/** The tools service is required; the approval service is optional. */
export const inject = ['tools']

/** Mark a schema subtree live-editable; the pre-0.1.7 vendored schemastery build predates `.volatile()`. */
function live<T extends object>(schema: T): T {
  return (schema as T & { volatile?: () => T }).volatile?.() ?? schema
}

/** Detach every Config field into plain values (idempotent on pre-0.1.7 plain configs). */
function plainConfig<T extends object>(config: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(config)) {
    out[key] = typeof (field as { get?: () => unknown } | undefined)?.get === 'function'
      ? (field as { get: () => unknown }).get()
      : field
  }
  return out as T
}

/** Live-editable plugin configuration. */
export interface Config {
  /** Pairing document path; defaults to `$DSH_HOME/pairings.yaml`. */
  pairingsPath?: Volatile<string>
  /** Durable ask-notice file; defaults to `<pairing dir>/peer-bridge/asks.jsonl`. */
  noticesPath?: Volatile<string>
  /** Caller identity reported on the handshake and stamped on prompts. */
  device?: Volatile<string>
  /** Participant name stamped on peer-originated records; defaults to the pairing document's device. */
  participantName?: Volatile<string>
  /** Default `peer_ask` wait in milliseconds (default 300000). */
  waitMs?: Volatile<number>
  /** Quiet window after a terminal before `peer_ask` accepts the session as settled (default 2000). */
  settleMs?: Volatile<number>
  /** Maximum consecutive follow reconnects before `peer/target-unreachable`. */
  maxReconnects?: Volatile<number>
}

/** Schemastery validator for {@link Config}; volatile so the merged settings service derives a live form. */
export const Config = Schema.object({
  pairingsPath: live(Schema.string()),
  noticesPath: live(Schema.string()),
  device: live(Schema.string()),
  participantName: live(Schema.string()),
  waitMs: live(Schema.number()),
  settleMs: live(Schema.number()),
  maxReconnects: live(Schema.number()),
})

/** Defaulted plain values the bridge closes over. */
export interface ResolvedConfig {
  pairingsPath?: string
  noticesPath?: string
  device?: string
  participantName?: string
  waitMs?: number
  settleMs?: number
  maxReconnects?: number
}

/** Test seams: replace the carrier without touching a real socket. */
export interface BridgeDeps {
  /** `fetch` replacement for the unary envelope. */
  readonly fetch?: typeof fetch
  /** WebSocket factory for `peer/follow`. */
  readonly webSocket?: (url: string) => PeerWebSocket
  /** Receives a durable-repair hole; defaults to a context warning. */
  readonly onWarning?: (hole: PeerRepairHole) => void
}

const DEFAULT_WAIT_MS = 300_000
const MAX_MESSAGE_CHARS = 100_000
/** Cap on concurrent ask-surfacing tasks per follow; a frame waits at the cap. */
const MAX_SURFACE_TASKS = 4

/** Failure value the tools return instead of throwing into the model turn. */
interface ToolFailure {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly endpoint?: string
    readonly hint?: string
  }
}

interface AskBridgeRecord extends AskRecord {
  readonly summary: string
  /** Aborts only this ask's locally surfaced card when the remote ask settles elsewhere. */
  readonly card: AbortController
  /** Set when the remote state first showed the ask gone while its card was open. */
  withdrawn?: boolean
}

/**
 * Mount the bridge tools.
 * @param ctx - owning context.
 * @param config - optional plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = plainConfig(config) as ResolvedConfig
  try {
    registerTools(ctx, resolved)
  } catch (error) {
    // A bridge failure must never take the loader down; the reason stays visible.
    ctx.logger?.error(`enpoi-peer-bridge: tools not registered: ${errorText(error)}`)
  }
}

/**
 * Register the five bridge tools.
 * @param ctx - context providing `tools` (and optionally `approval`).
 * @param config - plugin configuration.
 * @param deps - carrier replacements for tests.
 */
export function registerTools(ctx: Context, config: ResolvedConfig, deps: BridgeDeps = {}): void {
  const pairingsPath = config.pairingsPath ?? defaultPairingsPath()
  const noticesPath = config.noticesPath ?? defaultNoticesPath(dirname(pairingsPath))
  const waitMs = config.waitMs ?? DEFAULT_WAIT_MS
  const settleMs = config.settleMs ?? DEFAULT_SETTLE_QUIET_MS
  const effectiveDeps: BridgeDeps = {
    ...deps,
    onWarning: deps.onWarning ?? ((hole: PeerRepairHole): void => {
      ctx.logger?.warn?.(`enpoi-peer-bridge: peer follow history hole [${String(hole.from)}, ${String(hole.to)}) — records in that range are missing locally`)
    }),
  }

  ctx.tools.register({
    name: 'peer_status',
    description: [
      'Handshake with a paired peer device and read its session latch: host identity, capabilities,',
      'exposure, target session id, execution state (latch, active descendants, pending remote asks),',
      'and current model. Use it before peer_ask to confirm the peer and the session are reachable.',
      'The alias names the pairing (the member device in the fleet convention) and is the same string',
      'on both devices — it is NOT the target host name.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Pairing alias from the caller-role entries in the pairings document.' },
      },
      required: ['alias'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          alias: { type: 'string' },
          peer: { type: 'string' },
          endpoint: { type: 'string' },
          host: {
            type: 'object',
            additionalProperties: false,
            properties: {
              device: { type: 'string' },
              harnessVersion: { type: 'string' },
              protocolVersion: { type: 'number' },
              capabilities: { type: 'array', items: { type: 'string' } },
            },
            required: ['device', 'harnessVersion', 'protocolVersion', 'capabilities'],
          },
          exposure: { type: 'string' },
          sessionId: { type: 'string' },
          bound: { type: 'boolean' },
          latch: { type: 'string' },
          latchSource: { type: 'string' },
          activeDescendants: { type: 'number' },
          descendantsExact: { type: 'boolean' },
          model: { type: 'string' },
          lastTurnEnd: { type: 'string' },
          pendingAsks: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
          error: failureSchema(),
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const request = narrow(args)
      const alias = requireAlias(request.alias)
      const { pairing, document } = resolveEntry(pairingsPath, alias)
      const client = makeClient(pairing, config, document.device, effectiveDeps)
      try {
        const handshake = await client.handshake()
        let bound = pairing.remoteSessionId !== undefined
        let stateValue: Awaited<ReturnType<PeerClient['state']>> | undefined
        try {
          stateValue = await client.state(targetOf(pairing))
          bound = true
        } catch (error) {
          if (!(error instanceof PeerBridgeError) || (error.code !== 'peer/not-paired' && error.code !== 'peer/not-found')) throw error
          bound = false
        }
        const state = stateValue?.state
        return {
          ok: true,
          alias,
          peer: pairing.peer,
          endpoint: pairing.endpoint,
          host: {
            device: handshake.hostDevice,
            harnessVersion: handshake.harnessVersion,
            protocolVersion: handshake.protocolVersion,
            capabilities: [...handshake.capabilities],
          },
          exposure: stateValue?.target.exposure ?? pairing.exposure ?? 'unknown',
          sessionId: stateValue?.target.sessionId ?? pairing.remoteSessionId ?? '',
          bound,
          latch: state?.latch ?? 'unknown',
          latchSource: state?.source ?? 'unknown',
          activeDescendants: state?.activeDescendants ?? 0,
          descendantsExact: state?.descendantsExact ?? false,
          model: state?.model === undefined ? '' : `${state.model.provider}/${state.model.model}${state.model.chain === undefined ? '' : ` (${state.model.chain})`}`,
          lastTurnEnd: state?.lastTurnEnd === undefined ? '' : `turn ${String(state.lastTurnEnd.turn)} ${state.lastTurnEnd.reason}`,
          pendingAsks: (state?.pendingAsks ?? []).map(askSummary),
          note: bound
            ? ''
            : 'alias is not bound to a session and the pairing pins no remoteSessionId — peer_ask creates one when the host pairing has a create block',
        }
      } catch (error) {
        return failureFrom(error, pairing.endpoint)
      }
    },
  })

  ctx.tools.register({
    name: 'peer_sessions',
    description: [
      'List paired peer sessions: for every caller-role pairing in the local document, the bound remote',
      'session id (the local remoteSessionId pin or the session the host reports), the latch summary, and',
      'last activity. Use it to discover which session an alias currently addresses before peer_ask or',
      'peer_asks. Read-only; an unreachable host appears as that row\'s error.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Limit the listing to one caller-role pairing alias.' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          device: { type: 'string' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string' },
                peer: { type: 'string' },
                endpoint: { type: 'string' },
                remoteSessionId: { type: 'string' },
                exposure: { type: 'string' },
                bound: { type: 'boolean' },
                latch: { type: 'string' },
                lastActivity: { type: 'string' },
                summary: { type: 'string' },
                error: failureSchema(),
              },
              required: ['alias', 'peer'],
            },
          },
          note: { type: 'string' },
          error: failureSchema(),
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderSessions(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const request = narrow(args)
      const filter = typeof request.alias === 'string' && request.alias !== '' ? request.alias : undefined
      let document: PairingDocument
      try {
        document = readPairingDocument(pairingsPath)
      } catch (error) {
        return { ok: false, device: '', sessions: [], error: badRequest(errorText(error)).error }
      }
      const callers = callerPairings(document)
      const dialable = callers.filter(pairing => filter === undefined || pairing.alias === filter)
      if (dialable.length === 0) {
        return {
          ok: false,
          device: document.device,
          sessions: [],
          error: badRequest(filter === undefined
            ? 'no caller-role pairings in the pairing document'
            : `no caller-role pairing with alias ${JSON.stringify(filter)}; ${describeCallerPairings(callers)}`).error,
        }
      }
      const sessions: Record<string, unknown>[] = []
      for (const pairing of dialable) {
        const base = {
          alias: pairing.alias,
          peer: pairing.peer,
          endpoint: pairing.endpoint,
          remoteSessionId: pairing.remoteSessionId ?? '',
          exposure: pairing.exposure ?? '',
        }
        try {
          const listed = await makeClient(pairing, config, document.device, effectiveDeps).list({})
          const entry = listed.pairings.find(candidate => candidate.alias === pairing.alias)
          sessions.push({
            ...base,
            remoteSessionId: pairing.remoteSessionId ?? entry?.sessionId ?? '',
            exposure: entry?.exposure ?? base.exposure,
            bound: entry?.bound ?? false,
            ...(entry?.latch === undefined ? {} : { latch: entry.latch }),
            ...(entry?.lastActivity === undefined ? {} : { lastActivity: new Date(entry.lastActivity).toISOString() }),
            summary: entry === undefined ? 'the host lists no pairing under this alias' : entry.summary,
          })
        } catch (error) {
          sessions.push({
            ...base,
            bound: false,
            summary: '',
            error: failureFrom(error, pairing.endpoint).error,
          })
        }
      }
      return { ok: true, device: document.device, sessions }
    },
  })

  ctx.tools.register({
    name: 'peer_ask',
    description: [
      'Send a message to a paired peer session as an attributed peer turn, then follow the remote',
      'session until the turn reaches a terminal state and return the remote answer (or the structured',
      'failure when the turn failed). Remote asks that appear while following are surfaced locally for',
      'the operator to answer. The remote runs with its OWN tools, workspace, and approvals.',
      'The alias names the pairing (the member device in the fleet convention) and is the same string',
      'on both devices — it is NOT the target host name.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Pairing alias of the peer session to prompt.' },
        message: { type: 'string', description: 'The message to send (plain text).' },
        waitMs: { type: 'number', description: `How long to follow, in milliseconds (default ${String(waitMs)}).` },
      },
      required: ['alias', 'message'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          pending: { type: 'boolean' },
          alias: { type: 'string' },
          sessionId: { type: 'string' },
          created: { type: 'boolean' },
          requestId: { type: 'string' },
          admitted: { type: 'boolean' },
          settled: { type: 'boolean' },
          superseded: { type: 'boolean' },
          turn: { type: 'number' },
          terminal: { type: 'string' },
          error: failureSchema(),
          remoteError: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
            },
            required: ['code', 'message'],
          },
          answer: { type: 'string' },
          asks: { type: 'array', items: { type: 'string' } },
          latch: { type: 'string' },
          cursor: { type: 'number' },
          note: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderAsk(value) }],
    },
    async execute(args, exec) {
      const request = narrow(args)
      const alias = requireAlias(request.alias)
      const message = typeof request.message === 'string' ? request.message : ''
      if (message.trim() === '') return { ok: false, error: { code: 'gateway/bad-request', message: 'peer_ask needs a non-empty message' } }
      if (message.length > MAX_MESSAGE_CHARS) {
        return { ok: false, error: { code: 'gateway/bad-request', message: `peer_ask message exceeds ${String(MAX_MESSAGE_CHARS)} characters` } }
      }
      const requestedWait = typeof request.waitMs === 'number' && Number.isFinite(request.waitMs) && request.waitMs > 0
        ? Math.trunc(request.waitMs)
        : waitMs
      return runAsk(ctx, {
        pairingsPath,
        noticesPath,
        waitMs: requestedWait,
        settleMs,
        config,
        signal: exec.signal,
        agent: exec.agent,
        alias,
        message,
        allowCreate: true,
        deps: effectiveDeps,
      })
    },
  })

  ctx.tools.register({
    name: 'peer_asks',
    description: 'List the pending asks (approvals and questions) on a paired peer session so the local operator can decide them with peer_answer.',
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Pairing alias of the peer session.' },
      },
      required: ['alias'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          alias: { type: 'string' },
          sessionId: { type: 'string' },
          latch: { type: 'string' },
          asks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                askId: { type: 'string' },
                kind: { type: 'string' },
                toolName: { type: 'string' },
                reason: { type: 'string' },
                questions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string' },
                      question: { type: 'string' },
                      multiSelect: { type: 'boolean' },
                      options: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['id', 'question', 'options'],
                  },
                },
                since: { type: 'number' },
              },
              required: ['askId', 'kind', 'since'],
            },
          },
          error: failureSchema(),
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderAsks(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const request = narrow(args)
      const alias = requireAlias(request.alias)
      const { pairing } = resolveEntry(pairingsPath, alias)
      const client = makeClient(pairing, config, undefined, effectiveDeps)
      try {
        const value = await client.state(targetOf(pairing))
        return {
          ok: true,
          alias,
          sessionId: value.target.sessionId,
          latch: value.state.latch,
          asks: value.state.pendingAsks.map(ask => ({
            askId: ask.askId,
            kind: ask.kind,
            toolName: ask.kind === 'approval' ? ask.toolName ?? '' : '',
            reason: ask.kind === 'approval' ? ask.reason ?? '' : '',
            questions: ask.kind === 'question'
              ? (ask.questions ?? []).map(question => ({
                id: question.id,
                question: question.question,
                multiSelect: question.multiSelect === true,
                options: (question.options ?? []).map(option => option.label),
              }))
              : [],
            since: ask.since,
          })),
        }
      } catch (error) {
        return failureFrom(error, pairing.endpoint)
      }
    },
  })

  ctx.tools.register({
    name: 'peer_answer',
    description: [
      'Answer one pending ask on a paired peer session. Approvals take outcome allowed-once or rejected;',
      'questions take answers[] naming each question id and the selected option labels (see peer_asks for',
      'the ids and options). First answer wins — a peer/conflict means another participant already settled',
      'it and the answer must not be retried blindly. A malformed selection is rejected here with the',
      'reason and never reaches the host.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Pairing alias of the peer session.' },
        askId: { type: 'string', description: 'Remote ask id from peer_asks or a peer_ask result.' },
        outcome: { type: 'string', enum: ['allowed-once', 'rejected'], description: 'Approval outcome (allowed-always is not grantable from a peer).' },
        answers: {
          type: 'array',
          description: 'Question-ask answer: one entry per remote question id with the selected option labels.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: 'Question id from peer_asks.' },
              selected: { type: 'array', items: { type: 'string' }, description: 'Selected option labels.' },
              custom: { type: 'string', description: 'Optional free-text answer.' },
            },
            required: ['id', 'selected'],
          },
        },
      },
      required: ['alias', 'askId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          alias: { type: 'string' },
          askId: { type: 'string' },
          settled: { type: 'boolean' },
          confirmation: { type: 'string' },
          note: { type: 'string' },
          error: failureSchema(),
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderAnswer(value) }],
    },
    async execute(args) {
      const request = narrow(args)
      const alias = requireAlias(request.alias)
      const askId = typeof request.askId === 'string' && request.askId !== '' ? request.askId : undefined
      if (askId === undefined) return { ok: false, error: { code: 'gateway/bad-request', message: 'peer_answer needs an askId' } }
      const outcome = request.outcome
      const rawAnswers = Array.isArray(request.answers) ? request.answers : undefined
      if (outcome !== undefined && rawAnswers !== undefined) {
        return badRequest('peer_answer takes either outcome (approval) or answers (question), not both')
      }
      if (outcome === undefined && rawAnswers === undefined) {
        return badRequest('peer_answer needs outcome for an approval ask or answers[] for a question ask')
      }
      if (outcome !== undefined && outcome !== 'allowed-once' && outcome !== 'rejected') {
        return badRequest('peer_answer outcome must be allowed-once or rejected (allowed-always is not grantable from a peer)')
      }
      const { pairing, document } = resolveEntry(pairingsPath, alias)
      const client = makeClient(pairing, config, document.device, effectiveDeps)
      let answer: { readonly kind: 'approval'; readonly outcome: 'allowed-once' | 'rejected' } | { readonly kind: 'question'; readonly answer: PeerQuestionAnswer }
      if (outcome !== undefined) {
        answer = { kind: 'approval', outcome }
      } else {
        const parsed = parseQuestionSelections(rawAnswers ?? [])
        if (!parsed.ok) return badRequest(parsed.message)
        let pending: PeerPendingAsk | undefined
        try {
          const value = await client.state(targetOf(pairing))
          pending = value.state.pendingAsks.find(candidate => candidate.askId === askId)
        } catch (error) {
          return failureFrom(error, pairing.endpoint)
        }
        if (pending === undefined) {
          return badRequest(`no pending ask ${askId} on ${alias} — it may have settled or the session changed; re-run peer_asks`)
        }
        if (pending.kind !== 'question') {
          return badRequest(`ask ${askId} is an approval ask; answer it with outcome allowed-once or rejected`)
        }
        const normalized = normalizeQuestionSelections(pending.questions ?? [], parsed.selections)
        if (!normalized.ok) return badRequest(normalized.message)
        answer = { kind: 'question', answer: normalized.answer }
      }
      const target = targetOf(pairing)
      try {
        await client.answer({
          target,
          participant: participantOf(config, document),
          askId,
          answer,
        })
        return {
          ok: true,
          alias,
          askId,
          settled: true,
          confirmation: 'confirmed',
          note: answer.kind === 'question'
            ? 'question settled; the first answer won'
            : 'ask settled; the first answer won',
        }
      } catch (error) {
        const conflict = error instanceof PeerBridgeError && error.code === 'peer/conflict'
        if (!conflict && error instanceof PeerBridgeError && error.code === 'peer/target-unreachable') {
          // The answer may have settled before the confirmation was lost; a
          // fresh read distinguishes "applied" from "never reached".
          const reread = await client.state(target).catch(() => undefined)
          if (reread !== undefined && !reread.state.pendingAsks.some(candidate => candidate.askId === askId)) {
            return {
              ok: true,
              alias,
              askId,
              settled: false,
              confirmation: 'lost',
              note: 'the answer transport failed with no confirmation, but the remote ask is no longer pending — it was settled remotely (by this answer or another participant); re-run peer_asks before resending',
            }
          }
        }
        return {
          ok: false,
          alias,
          askId,
          settled: false,
          note: conflict
            ? 'another participant already answered this ask (peer/conflict) — report it; do not retry blind'
            : errorText(error),
          error: failureFrom(error, pairing.endpoint).error,
        }
      }
    },
  })

  ctx.tools.register({
    name: 'peer_cancel',
    description: 'Cancel the active turn on a paired peer session, attributed to this caller. A human on the remote preempts peers; this asks the remote to stop.',
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Pairing alias of the peer session.' },
      },
      required: ['alias'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          alias: { type: 'string' },
          cancelled: { type: 'boolean' },
          confirmation: { type: 'string' },
          note: { type: 'string' },
          error: failureSchema(),
        },
        required: ['ok'],
      },
      render: (_args, value) => {
        const record = narrow(value)
        return [{
          type: 'text',
          text: record.ok === true
            ? `${record.cancelled === true ? 'Cancelled' : 'Nothing to cancel on'} ${String(record.alias)} — ${String(record.note ?? '')}`
            : `peer_cancel failed: ${String(narrow(record.error).message ?? '')}`,
        }]
      },
    },
    async execute(args) {
      const request = narrow(args)
      const alias = requireAlias(request.alias)
      const { pairing, document } = resolveEntry(pairingsPath, alias)
      const client = makeClient(pairing, config, document.device, effectiveDeps)
      try {
        const value = await client.cancel({ target: targetOf(pairing), participant: participantOf(config, document) })
        return {
          ok: true,
          alias,
          cancelled: value.cancelled,
          confirmation: 'confirmed',
          note: value.cancelled ? 'remote turn cancelled' : 'remote session had no active turn',
        }
      } catch (error) {
        if (error instanceof PeerBridgeError && error.code === 'peer/target-unreachable') {
          // The cancel may have preempted the turn before the confirmation was
          // lost; a fresh latch read distinguishes that from "never reached".
          const reread = await client.state(targetOf(pairing)).catch(() => undefined)
          if (reread !== undefined && reread.state.latch !== 'running') {
            return {
              ok: true,
              alias,
              cancelled: false,
              confirmation: 'lost',
              note: 'the cancel confirmation was lost (transport failure); the remote reports no active turn — it may have completed or been cancelled',
            }
          }
        }
        return failureFrom(error, pairing.endpoint)
      }
    },
  })
}

interface AskRunOptions {
  readonly pairingsPath: string
  readonly noticesPath: string
  readonly waitMs: number
  /** Quiet window after a terminal before the session is accepted as settled. */
  readonly settleMs: number
  readonly config: ResolvedConfig
  readonly signal: AbortSignal
  readonly agent?: Agent
  readonly alias: string
  readonly message: string
  readonly allowCreate: boolean
  readonly deps: BridgeDeps
}

async function runAsk(ctx: Context, options: AskRunOptions): Promise<unknown> {
  const { pairing, document } = resolveEntry(options.pairingsPath, options.alias)
  const client = makeClient(pairing, options.config, document.device, options.deps)
  const participant = participantOf(options.config, document)
  let created = false
  try {
    await client.handshake()
  } catch (error) {
    return failureFrom(error, pairing.endpoint)
  }
  const requestedTarget = targetOf(pairing)
  let baseline: Awaited<ReturnType<PeerClient['state']>>
  try {
    baseline = await client.state(requestedTarget)
  } catch (error) {
    const code = error instanceof PeerBridgeError ? error.code : ''
    if (!options.allowCreate || requestedTarget.kind !== 'alias' || (code !== 'peer/not-paired' && code !== 'peer/not-found')) {
      return failureFrom(error, pairing.endpoint)
    }
    try {
      const defaults = pairing.create ?? {}
      await client.create({
        alias: pairing.alias,
        participant,
        ...(typeof defaults.cwd === 'string' ? { cwd: defaults.cwd } : {}),
        ...(typeof defaults.agentPreset === 'string' ? { agentPreset: defaults.agentPreset } : {}),
        // The host pins this route on the created Session only; the parser
        // already guarantees provider+model travel together.
        ...(pairing.createRouting ?? {}),
      })
      created = true
      baseline = await client.state(requestedTarget)
    } catch (createError) {
      return failureFrom(createError, pairing.endpoint)
    }
  }
  const baselineTurn = baseline.state.lastTurnEnd?.turn ?? 0
  const requestId = `peer-bridge-${randomUUID()}`
  try {
    await client.prompt({
      target: requestedTarget,
      participant,
      requestId,
      content: [{ type: 'text', text: options.message }],
      hopCount: 0,
    })
  } catch (error) {
    return failureFrom(error, pairing.endpoint)
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.waitMs)
  const relayAbort = (): void => { controller.abort() }
  options.signal.addEventListener('abort', relayAbort, { once: true })

  const asks = new Map<string, AskBridgeRecord>()
  let latch = baseline.state.latch
  let cursor = baseline.cursor
  // The prompt response already proved the host recorded this prompt; the
  // durable `user/message` below only marks which turn carried it.
  const admitted = true
  let terminal: ReturnType<typeof recordTerminal>
  let detached = false
  let activeDescendants = baseline.state.activeDescendants
  let descendantsExact = baseline.state.descendantsExact
  let pendingAskCount = baseline.state.pendingAsks.length
  const answerParts: string[] = []
  let answerTurn: number | undefined
  // Durable seqs already folded: a reconnect snapshot replay must never append
  // the same assistant text twice.
  const seenSeqs = new Set<number>()
  // Causal attribution: assistant text and terminals count only for the turn
  // that carried our admitted prompt (or a later one). A concurrent
  // third-party turn that ends before our `user/message` appears is ignored,
  // and a later turn opened by a different operator's prompt cannot replace
  // our own result (`abandoned`).
  let admittedTurn: number | undefined
  let observedTurn: number | undefined
  let admissionSeen = false
  let abandoned = false
  let quietExpired = false
  let quietTimer: ReturnType<typeof setTimeout> | undefined
  const clearQuiet = (): void => {
    if (quietTimer !== undefined) { clearTimeout(quietTimer); quietTimer = undefined }
  }
  const armQuiet = (): void => {
    clearQuiet()
    quietTimer = setTimeout(() => {
      quietExpired = true
      controller.abort()
    }, options.settleMs)
  }
  const settledNow = (): boolean => isPeerSessionSettled({
    terminal, latch, activeDescendants, descendantsExact, pendingAskCount,
  })

  // Surface remote asks concurrently: the follow loop keeps processing frames
  // (and therefore notices a terminal, a timeout, or a dead socket) while a
  // local card is open. The in-flight set is capped, and each task's failure
  // is contained so a broken answerer never takes the follow down.
  const inFlight = new Set<Promise<void>>()
  // A remote ask can settle on the peer (another device answered) while its
  // local card is open. The registry pushes a state frame on every settle, so
  // a card whose ask vanished from pendingAsks is withdrawn here instead of
  // staying answerable behind a settled ask.
  const withdrawMissing = (pending: readonly PeerPendingAsk[]): void => {
    const present = new Set(pending.map(ask => ask.askId))
    for (const record of asks.values()) {
      if (present.has(record.askId) || record.withdrawn === true) continue
      if (record.decision !== undefined || record.relay !== undefined) continue
      record.withdrawn = true
      record.note = 'settled elsewhere first (another device answered) — local card dismissed'
      record.card.abort(new Error('remote ask settled before the local answer'))
    }
  }
  const surface = (pending: readonly PeerPendingAsk[]): void => {
    const task = surfacePending(
      ctx, client, options.noticesPath, pairing, participant, requestedTarget, pending, asks,
      AbortSignal.any([options.signal, controller.signal]), options.agent,
    ).catch((error: unknown) => {
      ctx.logger?.warn?.(`enpoi-peer-bridge: surfacing remote asks failed: ${errorText(error)}`)
    }).finally(() => { inFlight.delete(task) })
    inFlight.add(task)
  }
  const surfaceFrame = async (pending: readonly PeerPendingAsk[]): Promise<void> => {
    withdrawMissing(pending)
    // At the cap, wait for a slot; every task settles on answer, abort, or
    // timeout, so this cannot park the follow indefinitely.
    while (inFlight.size >= MAX_SURFACE_TASKS) await Promise.race(inFlight)
    surface(pending)
  }
  const absorb = (record: PeerEventRecord): void => {
    if (recordRpcId(record) === requestId) {
      if (!admissionSeen) {
        admissionSeen = true
        const turn = recordTurn(record) ?? observedTurn
        if (turn !== undefined) admittedTurn = turn
      }
    }
    if (typeof record.seq === 'number') {
      if (seenSeqs.has(record.seq)) return
      seenSeqs.add(record.seq)
    }
    const turn = recordTurn(record)
    // A different operator's prompt claims a later turn: what that turn
    // answers belongs to their run, not ours.
    if (record.type === 'user/message' && admittedTurn !== undefined && recordRpcId(record) !== requestId) {
      const promptTurn = turn ?? observedTurn
      if (promptTurn !== undefined && promptTurn !== admittedTurn && recordSourceKind(record) === 'user') abandoned = true
    }
    if (record.type === 'turn/start' && turn !== undefined) {
      observedTurn = turn
      if (admissionSeen && admittedTurn === undefined) admittedTurn = turn
      return
    }
    // The first turn-bound record after admission is the turn carrying our
    // prompt when the snapshot window cut its `turn/start`.
    if (admittedTurn === undefined && admissionSeen && turn !== undefined) admittedTurn = turn
    const attributed = admittedTurn !== undefined && turn !== undefined && turn >= admittedTurn
      && (!abandoned || turn <= admittedTurn)
    if (!attributed) return
    if (record.type === 'assistant/message' && turn > baselineTurn) {
      const text = recordAssistantText(record)
      if (text !== '') {
        // A later turn REPLACES the previous turn's text, so a fan-out
        // dispatch announcement is superseded by the settled summary.
        if (answerTurn === undefined || turn > answerTurn) {
          answerTurn = turn
          answerParts.length = 0
        }
        if (turn === answerTurn) answerParts.push(text)
      }
      return
    }
    const end = recordTerminal(record)
    if (end !== undefined && end.turn > baselineTurn) {
      // A terminal owns only the text committed for its own turn: a later turn
      // that produced no answer must not report the previous turn's text.
      if (answerTurn !== undefined && answerTurn !== end.turn) {
        answerTurn = undefined
        answerParts.length = 0
      }
      terminal = end
    }
  }
  try {
    for await (const frame of client.follow({ target: requestedTarget }, controller.signal)) {
      if (frame.type === 'snapshot') {
        cursor = frame.cursor
        latch = frame.state.latch
        activeDescendants = frame.state.activeDescendants
        descendantsExact = frame.state.descendantsExact
        pendingAskCount = frame.state.pendingAsks.length
        for (const record of frame.records) absorb(record)
        await surfaceFrame(frame.state.pendingAsks)
      } else if (frame.type === 'state') {
        cursor = frame.cursor
        latch = frame.state.latch
        activeDescendants = frame.state.activeDescendants
        descendantsExact = frame.state.descendantsExact
        pendingAskCount = frame.state.pendingAsks.length
        await surfaceFrame(frame.state.pendingAsks)
      } else if (frame.type === 'event') {
        cursor = Math.max(cursor, frame.record.seq)
        absorb(frame.record)
      } else if (frame.type === 'end' && frame.reason === 'target-detached') {
        detached = true
        break
      }
      // A different operator's prompt opened a later turn after our admitted
      // turn already had its terminal: our result is complete, and continuing
      // would return their answer as ours.
      if (abandoned && terminal !== undefined) break
      if (terminal !== undefined) {
        // Keep following while a child, an ask, or a follow-up turn can still
        // move the session; only a settled state starts the quiet clock.
        if (settledNow()) armQuiet()
        else clearQuiet()
      }
    }
  } catch (error) {
    if (!timedOut && !controller.signal.aborted) return failureFrom(error, pairing.endpoint)
  } finally {
    clearTimeout(timer)
    clearQuiet()
    options.signal.removeEventListener('abort', relayAbort)
    // The follower is gone (terminal, waitMs, exec abort, or a dead socket):
    // withdraw any local card still open for it and let the contained tasks
    // settle, so the result below reports their final decisions.
    controller.abort()
    await Promise.allSettled([...inFlight])
  }

  // The quiet window aborts the follow, so a frame in flight at the cut can be
  // lost. Confirm the session is still quiet before accepting the terminal.
  if (quietExpired) {
    try {
      const confirmed = await client.state(requestedTarget)
      latch = confirmed.state.latch
      activeDescendants = confirmed.state.activeDescendants
      descendantsExact = confirmed.state.descendantsExact
      pendingAskCount = confirmed.state.pendingAsks.length
      cursor = Math.max(cursor, confirmed.cursor)
    } catch {
      // Without the confirming read the last observed settled signals stand.
    }
  }

  if (detached) {
    return {
      ok: false,
      pending: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      asks: askLines(asks),
      latch,
      cursor,
      note: 'the remote pairing/session binding disappeared (target-detached)',
    }
  }

  const answer = answerParts.join('\n').trim()
  if (terminal === undefined) {
    return {
      ok: false,
      pending: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      answer,
      asks: askLines(asks),
      latch,
      cursor,
      note: `no terminal within ${String(options.waitMs)}ms — the remote turn is still live (follow it again with peer_ask or ds peer follow)`,
    }
  }
  if (abandoned) {
    return {
      ok: terminal.reason === 'completed',
      settled: true,
      superseded: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      turn: terminal.turn,
      terminal: terminal.reason,
      ...(terminal.error === undefined ? {} : {
        remoteError: {
          code: terminal.error.code ?? 'unknown',
          message: terminal.error.message ?? '',
          provider: terminal.error.provider ?? '',
          model: terminal.error.model ?? '',
        },
      }),
      answer,
      asks: askLines(asks),
      cursor,
      note: `a different operator's prompt opened a later turn after turn ${String(terminal.turn)} ended; returning this turn's own result — follow the alias again to collect the remainder`,
    }
  }
  if (!settledNow()) {
    return {
      ok: false,
      pending: true,
      settled: false,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      turn: terminal.turn,
      terminal: terminal.reason,
      ...(terminal.error === undefined ? {} : {
        remoteError: {
          code: terminal.error.code ?? 'unknown',
          message: terminal.error.message ?? '',
          provider: terminal.error.provider ?? '',
          model: terminal.error.model ?? '',
        },
      }),
      answer,
      asks: askLines(asks),
      latch,
      cursor,
      note: `remote turn ${String(terminal.turn)} ended: ${terminal.reason} but the session was not settled when following stopped (${unsettledSummary(latch, activeDescendants, pendingAskCount)}) — follow again to collect the remainder`,
    }
  }
  if (terminal.reason !== 'completed') {
    return {
      ok: false,
      settled: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      turn: terminal.turn,
      terminal: terminal.reason,
      ...(terminal.error === undefined ? {} : {
        remoteError: {
          code: terminal.error.code ?? 'unknown',
          message: terminal.error.message ?? '',
          provider: terminal.error.provider ?? '',
          model: terminal.error.model ?? '',
        },
      }),
      answer,
      asks: askLines(asks),
      cursor,
      note: `remote turn ${String(terminal.turn)} ended: ${terminal.reason}`,
    }
  }
  return {
    ok: true,
    settled: true,
    alias: pairing.alias,
    sessionId: baseline.target.sessionId,
    created,
    requestId,
    admitted,
    turn: terminal.turn,
    terminal: 'completed',
    answer,
    asks: askLines(asks),
    cursor,
    note: asks.size === 0 ? '' : 'remote asks were raised locally; see asks[] for the decisions relayed',
  }
}

/** Human summary of why the latest terminal did not settle the session. */
function unsettledSummary(latch: string, activeDescendants: number, pendingAskCount: number): string {
  if (activeDescendants > 0) return `${String(activeDescendants)} live descendant(s)`
  if (pendingAskCount > 0) return `${String(pendingAskCount)} pending ask(s)`
  if (latch === 'running') return 'a turn is still running'
  if (latch === 'waiting_subagents') return 'descendants are still settling'
  if (latch === 'waiting_approval') return 'an ask is pending'
  return 'the quiet window had not elapsed'
}

async function surfacePending(
  ctx: Context,
  client: PeerClient,
  noticesPath: string,
  pairing: DialablePairing,
  participant: PeerParticipant,
  target: ReturnType<typeof targetOf>,
  pending: readonly PeerPendingAsk[],
  asks: Map<string, AskBridgeRecord>,
  signal: AbortSignal,
  agent: Agent | undefined,
): Promise<void> {
  const sessionLabel = target.kind === 'session' ? target.sessionId : pairing.remoteSessionId ?? pairing.alias
  for (const ask of pending) {
    if (asks.has(ask.askId)) continue
    const record: AskBridgeRecord = {
      askId: ask.askId,
      kind: ask.kind,
      ...(ask.kind === 'approval' && ask.toolName !== undefined ? { toolName: ask.toolName } : {}),
      ...(ask.kind === 'approval' && ask.reason !== undefined ? { reason: ask.reason } : {}),
      surfaced: 'notice',
      summary: askSummary(ask),
      card: new AbortController(),
    }
    asks.set(ask.askId, record)
    // The card's lifetime: the follow generation and this one ask. A remote
    // settle aborts only this controller (withdrawMissing), so one settled
    // ask never tears down a sibling card.
    const askSignal = AbortSignal.any([signal, record.card.signal])

    if (ask.kind === 'question') {
      await surfaceQuestion(ctx, client, noticesPath, pairing, participant, target, ask, record, askSignal, agent)
      continue
    }
    const approval = ctx.get('approval')
    if (approval === undefined || agent === undefined) {
      record.decision = 'unsurfaced'
      record.note = 'local approval service unavailable; ask recorded as a durable notice and answerable via peer_answer'
      recordAskNotice(noticesPath, pairing.alias, sessionLabel, ask, record.note)
      continue
    }
    let decision: LocalAskDecision
    try {
      const outcome = await approval.request({
        agent,
        toolName: ask.toolName ?? 'peer.ask',
        reason: askLabel(pairing.alias, sessionLabel, ask),
        signal: askSignal,
      })
      if (record.withdrawn === true) {
        // The remote settled while the local card was open: no relay (it would
        // only race a decided ask) and no notice (settlement is not a refusal).
        record.decision = 'cancelled'
        continue
      }
      // A peer answer is one-shot by contract: both standing outcomes degrade
      // to `allowed-once` (never a peer-granted durable grant).
      decision = outcome === 'allowed-always' || outcome === 'allowed-always-broad' ? 'allowed-once' : outcome
      record.surfaced = 'approval'
    } catch {
      if (record.withdrawn === true) {
        record.decision = 'cancelled'
        continue
      }
      // No open local turn, no answerer, or a withdrawn ask: the remote ask
      // stays answerable through peer_answer and gets a durable notice.
      decision = 'unsurfaced'
    }
    const mapped = localDecisionToPeerAnswer(decision)
    record.decision = decision
    if (mapped.outcome === undefined) {
      record.note = mapped.note
      recordAskNotice(noticesPath, pairing.alias, sessionLabel, ask, mapped.note)
      continue
    }
    try {
      await client.answer({
        target,
        participant,
        askId: ask.askId,
        answer: { kind: 'approval', outcome: mapped.outcome },
      })
      record.relay = 'settled'
      record.note = mapped.note
    } catch (error) {
      const code = error instanceof PeerBridgeError ? error.code : 'unknown'
      record.relay = code === 'peer/conflict' ? 'conflict' : code === 'peer/not-found' ? 'not-found' : 'failed'
      record.note = code === 'peer/conflict'
        ? 'another participant answered first (peer/conflict) — not retried'
        : `relay failed: ${errorText(error)}`
    }
  }
}

async function surfaceQuestion(
  ctx: Context,
  client: PeerClient,
  noticesPath: string,
  pairing: DialablePairing,
  participant: PeerParticipant,
  target: ReturnType<typeof targetOf>,
  ask: PeerPendingAsk,
  record: AskBridgeRecord,
  signal: AbortSignal,
  agent: Agent | undefined,
): Promise<void> {
  const sessionLabel = target.kind === 'session' ? target.sessionId : pairing.remoteSessionId ?? pairing.alias
  const questions = ask.kind === 'question' ? ask.questions ?? [] : []
  const userQuestions = ctx.get('userQuestions')
  if (userQuestions === undefined || questions.length === 0) {
    record.decision = 'unsurfaced'
    record.note = 'local user-questions service unavailable; question ask recorded with its options and answerable via peer_answer'
    recordAskNotice(noticesPath, pairing.alias, sessionLabel, ask, record.note)
    return
  }
  let answer: PeerQuestionAnswer
  try {
    // Mirror the approval path: surface the remote question through the local
    // answerer (the following turn's agent when one exists, so a UI scoped to
    // that agent can render it). No answerer or an abort → durable notice.
    answer = await userQuestions.ask({
      questions: questions.map(question => ({
        id: question.id,
        question: question.question,
        ...(question.detail === undefined ? {} : { detail: question.detail }),
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(question.options === undefined
          ? {}
          : { options: question.options.map(option => ({ label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })) }),
        ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
      })),
      ...(agent === undefined ? {} : { agent }),
      signal,
    })
    if (record.withdrawn === true) {
      // The remote settled while the local question was open: no relay and no
      // notice; settlement is not a local refusal.
      record.decision = 'cancelled'
      return
    }
    record.surfaced = 'question'
    record.selected = answer.answers.flatMap(item => item.selected)
  } catch (error) {
    if (record.withdrawn === true) {
      record.decision = 'cancelled'
      return
    }
    record.decision = 'unsurfaced'
    record.note = `local question answerer declined (${errorText(error)}); question ask recorded with its options and answerable via peer_answer`
    recordAskNotice(noticesPath, pairing.alias, sessionLabel, ask, record.note)
    return
  }
  try {
    await client.answer({ target, participant, askId: ask.askId, answer: { kind: 'question', answer } })
    record.relay = 'settled'
    record.note = 'local question answered → relayed'
  } catch (error) {
    const code = error instanceof PeerBridgeError ? error.code : 'unknown'
    record.relay = code === 'peer/conflict' ? 'conflict' : code === 'peer/not-found' ? 'not-found' : 'failed'
    record.note = code === 'peer/conflict'
      ? 'another participant answered first (peer/conflict) — not retried'
      : `relay failed: ${errorText(error)}`
  }
}

function recordAskNotice(path: string, alias: string, sessionId: string, ask: PeerPendingAsk, note: string): void {
  const notice: AskNotice = {
    at: Date.now(),
    alias,
    sessionId,
    askId: ask.askId,
    kind: ask.kind,
    ...(ask.kind === 'approval' && ask.toolName !== undefined ? { toolName: ask.toolName } : {}),
    ...(ask.kind === 'approval' && ask.reason !== undefined ? { reason: ask.reason } : {}),
    ...(ask.kind === 'question' ? { questions: ask.questions ?? [] } : {}),
    note,
  }
  appendAskNotice(path, notice)
}

// ── Resolution helpers ───────────────────────────────────────────────────────

function resolveEntry(pairingsPath: string, alias: string): { readonly pairing: DialablePairing; readonly document: PairingDocument } {
  return loadCallerPairing(pairingsPath, alias)
}

function targetOf(pairing: DialablePairing): { readonly kind: 'alias'; readonly alias: string } | { readonly kind: 'session'; readonly sessionId: string } {
  return pairing.remoteSessionId === undefined
    ? { kind: 'alias', alias: pairing.alias }
    : { kind: 'session', sessionId: pairing.remoteSessionId }
}

function participantOf(config: ResolvedConfig, document: PairingDocument): PeerParticipant {
  const device = config.device ?? document.device
  return { kind: 'peer', name: config.participantName ?? device, device }
}

function makeClient(pairing: DialablePairing, config: ResolvedConfig, device?: string, deps: BridgeDeps = {}): PeerClient {
  const headers: Record<string, string> = pairing.token === undefined ? {} : { authorization: `Bearer ${pairing.token}` }
  return new PeerClient({
    endpoint: pairing.endpoint,
    device: config.device ?? device ?? pairing.peer,
    headers,
    ...(config.maxReconnects === undefined ? {} : { maxReconnects: config.maxReconnects }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.webSocket === undefined ? {} : { webSocket: deps.webSocket }),
    ...(deps.onWarning === undefined ? {} : { onWarning: deps.onWarning }),
  })
}

function narrow(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
}

function badRequest(message: string): ToolFailure {
  return { ok: false, error: { code: 'gateway/bad-request', message } }
}

/**
 * Validate the raw `answers[]` tool argument into selections.
 * @param raw - array of `{id, selected, custom?}` entries.
 * @returns the selections, or the reason the argument is malformed.
 */
function parseQuestionSelections(raw: readonly unknown[]): { readonly ok: true; readonly selections: readonly QuestionSelection[] } | { readonly ok: false; readonly message: string } {
  if (raw.length === 0) return { ok: false, message: 'answers[] is empty; name at least one question id with its selected labels' }
  const selections: QuestionSelection[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, message: 'every answers[] entry must be an object {id, selected[]}' }
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string' || item.id === '') return { ok: false, message: 'every answers[] entry needs a string question id' }
    if (!Array.isArray(item.selected) || !item.selected.every(label => typeof label === 'string')) {
      return { ok: false, message: `answers[] entry ${JSON.stringify(item.id)} needs selected[] as an array of option labels` }
    }
    if (item.custom !== undefined && typeof item.custom !== 'string') {
      return { ok: false, message: `answers[] entry ${JSON.stringify(item.id)} has a non-string custom value` }
    }
    selections.push({
      id: item.id,
      selected: [...item.selected] as string[],
      ...(typeof item.custom === 'string' ? { custom: item.custom } : {}),
    })
  }
  return { ok: true, selections }
}

function requireAlias(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new PeerBridgeError('gateway/bad-request', 'alias must be a non-empty string', '')
  }
  return value
}

function failureFrom(error: unknown, endpoint: string): ToolFailure {
  if (error instanceof PeerBridgeError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.code === 'peer/target-unreachable'
          ? `REMOTE TARGET UNREACHABLE: ${error.endpoint}`
          : error.message,
        endpoint: error.endpoint,
        ...(error.code === 'peer/target-unreachable'
          ? { hint: 'the peer device is offline or the endpoint is wrong; the caller owns backoff and no turn was queued remotely' }
          : {}),
      },
    }
  }
  const code = (error as { code?: unknown } | undefined)?.code
  return {
    ok: false,
    error: {
      code: typeof code === 'string' ? code : 'gateway/internal',
      message: errorText(error),
      endpoint,
    },
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function failureSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
      endpoint: { type: 'string' },
      hint: { type: 'string' },
    },
    required: ['code', 'message'],
  }
}

function askLines(asks: Map<string, AskBridgeRecord>): string[] {
  return [...asks.values()].map(record => {
    const parts = [record.summary]
    if (record.decision !== undefined) parts.push(`decision=${record.decision}`)
    if (record.selected !== undefined && record.selected.length > 0) parts.push(`selected=${record.selected.join(',')}`)
    if (record.relay !== undefined) parts.push(`relay=${record.relay}`)
    if (record.note !== undefined && record.note !== '') parts.push(record.note)
    return parts.join(' — ')
  })
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderStatus(value: unknown): string {
  const record = narrow(value)
  if (record.ok !== true) {
    const error = narrow(record.error)
    return `peer_status failed [${String(error.code ?? 'unknown')}]: ${String(error.message ?? '')}${error.endpoint === undefined ? '' : ` (${String(error.endpoint)})`}`
  }
  const host = narrow(record.host)
  const pendingAsks = Array.isArray(record.pendingAsks) ? record.pendingAsks as unknown[] : []
  return [
    `peer ${String(record.alias)} → ${String(host.device ?? '')} @ ${String(record.endpoint)}`,
    `session ${String(record.sessionId)} (${String(record.exposure)}) bound=${String(record.bound)}`,
    `latch ${String(record.latch)} (${String(record.latchSource)}), descendants ${String(record.activeDescendants)}, model ${String(record.model)}`,
    pendingAsks.length === 0 ? 'no pending asks' : `pending: ${pendingAsks.join('; ')}`,
  ].join('\n')
}

function renderSessions(value: unknown): string {
  const record = narrow(value)
  const sessions = Array.isArray(record.sessions) ? record.sessions as Record<string, unknown>[] : []
  if (record.ok !== true && sessions.length === 0) {
    const error = narrow(record.error)
    return `peer_sessions failed [${String(error.code ?? 'unknown')}]: ${String(error.message ?? '')}`
  }
  if (sessions.length === 0) return `no caller-role pairings on ${String(record.device ?? '')}`
  return [
    `device ${String(record.device ?? '')} · ${String(sessions.length)} pairing(s)`,
    ...sessions.map(session => {
      const error = session.error === undefined ? undefined : narrow(session.error)
      const state = error !== undefined
        ? `unreachable [${String(error.code ?? 'unknown')}] ${String(error.message ?? '')}`
        : `${session.remoteSessionId === '' ? 'not bound' : `session ${String(session.remoteSessionId)}`}`
          + ` (${String(session.exposure ?? '')}) bound=${String(session.bound === true)} latch=${String(session.latch ?? 'unknown')}`
          + `${session.summary === '' ? '' : ` — ${String(session.summary)}`}`
      return `• ${String(session.alias)} → ${String(session.peer)} @ ${String(session.endpoint)} · ${state}`
    }),
  ].join('\n')
}

function renderAsk(value: unknown): string {
  const record = narrow(value)
  if (record.ok !== true && record.pending !== true) {
    const error = narrow(record.error)
    if (error.code === 'peer/target-unreachable') {
      return `REMOTE TARGET UNREACHABLE: ${String(error.message)}`
    }
    return `peer_ask failed [${String(error.code ?? 'unknown')}]: ${String(error.message ?? '')}`
  }
  const lines: string[] = []
  if (record.pending === true) {
    lines.push(`REMOTE TURN STILL RUNNING on ${String(record.alias)} (${String(record.note ?? '')}).`)
    if (Array.isArray(record.asks) && record.asks.length > 0) lines.push(`asks: ${(record.asks as string[]).join('; ')}`)
    return lines.join('\n')
  }
  if (record.terminal !== 'completed') {
    const remoteError = record.remoteError === undefined ? undefined : narrow(record.remoteError)
    lines.push(`REMOTE TURN FAILED on ${String(record.alias)}: ${String(record.terminal)}${remoteError === undefined ? '' : ` [${String(remoteError.code)}] ${String(remoteError.message)}`}`)
  } else {
    lines.push(`remote answer from ${String(record.alias)} (session ${String(record.sessionId)}):`)
  }
  if (typeof record.answer === 'string' && record.answer !== '') lines.push(record.answer)
  if (Array.isArray(record.asks) && record.asks.length > 0) lines.push(`asks: ${(record.asks as string[]).join('; ')}`)
  if (record.created === true) lines.push('(a new remote session was created for this alias)')
  if (record.superseded === true) lines.push('(a different operator prompted the session after this turn ended; the result above is our own turn)')
  return lines.join('\n')
}

function renderAsks(value: unknown): string {
  const record = narrow(value)
  if (record.ok !== true) return `peer_asks failed: ${String(narrow(record.error).message ?? '')}`
  const asks = Array.isArray(record.asks) ? record.asks as Record<string, unknown>[] : []
  if (asks.length === 0) return `no pending asks on ${String(record.alias)} (latch ${String(record.latch)})`
  return [
    `${String(asks.length)} pending ask(s) on ${String(record.alias)}:`,
    ...asks.map(ask => {
      if (String(ask.kind) === 'question') {
        const questions = Array.isArray(ask.questions) ? ask.questions as Record<string, unknown>[] : []
        const rendered = questions.map(question => renderQuestion({
          id: String(question.id),
          question: String(question.question),
          options: Array.isArray(question.options) ? (question.options as string[]).map(label => ({ label })) : [],
          multiSelect: question.multiSelect === true,
        })).join('; ')
        return `• ${String(ask.askId)} question ${rendered} — answer with peer_answer answers[]`
      }
      return `• ${String(ask.askId)} ${String(ask.kind)} ${String(ask.toolName ?? '')} ${String(ask.reason ?? '')}`.trim()
    }),
  ].join('\n')
}

function renderAnswer(value: unknown): string {
  const record = narrow(value)
  if (record.ok === true) return `answered ${String(record.askId)} on ${String(record.alias)} — ${String(record.note ?? 'settled')}`
  const error = narrow(record.error)
  const detail = typeof record.note === 'string' && record.note !== '' ? record.note : String(error.message ?? '')
  return `peer_answer failed [${String(error.code ?? 'unknown')}] ${String(record.askId ?? '')}: ${detail}`
}
