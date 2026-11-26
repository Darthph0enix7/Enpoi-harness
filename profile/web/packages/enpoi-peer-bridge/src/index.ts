/**
 * enpoi-peer-bridge — the caller side of the device-to-device peer API
 * (doc 69 P2, doc 70, doc 27's thin bridge).
 *
 * A local agent uses eight tools to work with a *remote* harness session:
 * `peer_status` (handshake + latch + model), `peer_sessions` (discover bound
 * sessions across the caller-role pairings), `peer_models` (the routes the
 * peer lets this caller select), `peer_switch_model` (move an idle remote
 * session to another route), `peer_ask` (prompt the remote as an attributed
 * peer turn, follow to a terminal state, return the answer), `peer_asks`
 * (pending remote asks), `peer_answer` (settle one), and `peer_cancel`. A remote approval ask raised while following is surfaced to
 * the local operator through the local approval service when that is usable,
 * and the local decision is relayed back with `peer.answer` — first answer
 * wins; a `peer/conflict` is reported, never retried blind. When the remote
 * ask settles elsewhere first, the follow's next `state` frame withdraws the
 * local card instead of leaving it answerable. A followed turn that enters
 * `waiting_approval` returns EARLY with `status: 'waiting_approval'` and its
 * pending asks, so a non-interactive caller can decide with
 * `peer_asks`/`peer_answer` instead of blocking until `waitMs`; `peer_ask`
 * called again with `resume: <requestId>` continues that same turn to its
 * terminal state without re-prompting. A host that stops answering mid-follow
 * (a sleeping laptop, a cut link) is detected by a reachability probe after
 * `probeIntervalMs` of follow silence and surfaces as
 * `status: 'host_unreachable'`, again without cancelling the remote turn.
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
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
import type { PeerHandshakeValue, PeerInputReceiptKind, PeerPromptValue, PeerStopIntent } from './peer-client.js'
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
  /** Idle interval before `peer_ask` probes a silent host for reachability (default 30000; 0 disables). */
  probeIntervalMs?: Volatile<number>
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
  probeIntervalMs: live(Schema.number()),
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
  probeIntervalMs?: number
}

/** Test seams: replace the carrier without touching a real socket. */
export interface BridgeDeps {
  /** `fetch` replacement for the unary envelope. */
  readonly fetch?: typeof fetch
  /** WebSocket factory for `peer/follow`. */
  readonly webSocket?: (url: string) => PeerWebSocket
  /** Receives a durable-repair hole; defaults to a context warning. */
  readonly onWarning?: (hole: PeerRepairHole) => void
  /** Receives compatibility warnings without stopping ordinary peer calls. */
  readonly onCompatibilityWarning?: (message: string) => void
}

const DEFAULT_WAIT_MS = 300_000
/** Idle interval before the follow probes a silent host; 0 disables the probe. */
const DEFAULT_PROBE_INTERVAL_MS = 30_000
/** Deadline for one reachability probe; a host that cannot answer this stays "unreachable". */
const HOST_PROBE_TIMEOUT_MS = 4_000
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
  answerRequestId?: string
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
 * Register the eight bridge tools.
 * @param ctx - context providing `tools` (and optionally `approval`).
 * @param config - plugin configuration.
 * @param deps - carrier replacements for tests.
 */
export function registerTools(ctx: Context, config: ResolvedConfig, deps: BridgeDeps = {}): void {
  const pairingsPath = config.pairingsPath ?? defaultPairingsPath()
  const noticesPath = config.noticesPath ?? defaultNoticesPath(dirname(pairingsPath))
  const waitMs = config.waitMs ?? DEFAULT_WAIT_MS
  const settleMs = config.settleMs ?? DEFAULT_SETTLE_QUIET_MS
  const probeIntervalMs = config.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS
  const effectiveDeps: BridgeDeps = {
    ...deps,
    onWarning: deps.onWarning ?? ((hole: PeerRepairHole): void => {
      ctx.logger?.warn?.(`enpoi-peer-bridge: peer follow history hole [${String(hole.from)}, ${String(hole.to)}) — records in that range are missing locally`)
    }),
    onCompatibilityWarning: deps.onCompatibilityWarning ?? ((message: string): void => {
      ctx.logger?.warn?.(`enpoi-peer-bridge: ${message}`)
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
              instanceId: { type: 'string' },
              schemaDigest: { type: 'string' },
              methodsDigest: { type: 'string' },
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
          stopIntent: stopIntentSchema(),
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
        warnAskCapabilities(handshake, effectiveDeps, ['stop-intent'])
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
            instanceId: handshake.instanceId,
            schemaDigest: handshake.schemaDigest,
            methodsDigest: handshake.methodsDigest,
            capabilities: [...handshake.capabilities],
          },
          exposure: stateValue?.target.exposure ?? pairing.exposure ?? 'unknown',
          sessionId: stateValue?.target.sessionId ?? pairing.remoteSessionId ?? '',
          bound,
          latch: state?.latch ?? 'unknown',
          latchSource: state?.source ?? 'unknown',
          activeDescendants: state?.activeDescendants ?? 0,
          descendantsExact: state?.descendantsExact ?? false,
          stopIntent: state?.stopIntent,
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
    name: 'peer_models',
    description: [
      'List the models and chains a paired peer lets you select for its sessions, with each route\'s',
      'capabilities (tool calling, vision, context window, zero price, gating, whether prompts train on',
      'it, and the reasoning efforts it accepts) and each chain member\'s live state (ready, cooling',
      'down until a time, or retired). Read-only. Use it before choosing a route for peer_ask or',
      'peer_switch_model. The peer enforces its own allow list, so the result already excludes what you',
      'may not use; when the peer cannot offer model choice at all, the result says to upgrade the host.',
      'The alias names the pairing (the member device in the fleet convention) and is the same string',
      'on both devices — it is NOT the target host name.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Pairing alias of the peer session.' },
        limit: { type: 'number', description: 'Maximum rows in this page; the peer clamps it.' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous page\'s nextCursor.' },
        zeroPrice: { type: 'boolean', description: 'Only routes the peer can prove are free of charge.' },
        tools: { type: 'boolean', description: 'Only routes the peer can prove support tool calling.' },
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
          chains: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                dynamic: { type: 'boolean' },
                members: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      provider: { type: 'string' },
                      model: { type: 'string' },
                      state: { type: 'string', enum: ['ready', 'cooldown', 'deprecated'] },
                      cooldownUntil: { type: 'number' },
                    },
                    required: ['provider', 'model', 'state'],
                  },
                },
              },
              required: ['id', 'dynamic', 'members'],
            },
          },
          models: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string' },
                model: { type: 'string' },
                tools: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
                vision: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
                contextWindow: { type: 'number' },
                zeroPrice: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
                gated: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
                trainsOnData: { type: 'string', enum: ['yes', 'no', 'unknown'] },
                reasoningEfforts: { type: 'array', items: { type: 'string' } },
              },
              required: ['provider', 'model', 'tools', 'vision', 'zeroPrice', 'gated', 'trainsOnData', 'reasoningEfforts'],
            },
          },
          nextCursor: { type: 'string' },
          selectable: {
            type: 'object',
            additionalProperties: false,
            properties: {
              chains: { type: 'array', items: { type: 'string' } },
              models: { type: 'array', items: { type: 'string' } },
              reasoningEfforts: { type: 'array', items: { type: 'string' } },
              requireZeroPrice: { type: 'boolean' },
              requireNoTraining: { type: 'boolean' },
              requireTools: { type: 'boolean' },
              allowSwitch: { type: 'string', enum: ['never', 'idle-only'] },
            },
            required: ['chains', 'models', 'requireZeroPrice', 'requireNoTraining', 'requireTools', 'allowSwitch'],
          },
          error: failureSchema(),
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderModels(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const request = narrow(args)
      const alias = requireAlias(request.alias)
      const filter = modelsFilterOf(request)
      if (filter !== undefined && !filter.ok) return badRequest(filter.message)
      const limit = positiveIntegerOf('limit', request.limit)
      if (limit !== undefined && !limit.ok) return badRequest(limit.message)
      const cursor = nonEmptyTextOf('cursor', request.cursor)
      if (cursor !== undefined && !cursor.ok) return badRequest(cursor.message)
      const { pairing, document } = resolveEntry(pairingsPath, alias)
      const client = makeClient(pairing, config, document.device, effectiveDeps)
      try {
        const handshake = await client.handshake()
        const gap = capabilityGap(handshake.capabilities, 'model-discovery')
        if (gap !== undefined) return gap
        const value = await client.models({
          alias,
          participant: participantOf(config, document),
          ...(filter === undefined ? {} : { filter: filter.value }),
          ...(cursor === undefined ? {} : { cursor: cursor.value }),
          ...(limit === undefined ? {} : { limit: limit.value }),
        })
        return {
          ok: true,
          alias,
          chains: value.chains,
          models: value.models,
          ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
          selectable: value.selectableByThisAlias,
        }
      } catch (error) {
        return failureFrom(error, pairing.endpoint)
      }
    },
  })

  ctx.tools.register({
    name: 'peer_switch_model',
    description: [
      'Move a paired peer session to another model or chain for its next turn. The session must be',
      'idle; a running or waiting session refuses the switch. Name provider and model, or a chain id',
      '(a chain alone runs its first ready member), optionally with a reasoning effort. The peer',
      'enforces its own allow list, so a refusal names the reason and the refused route; read',
      'peer_models first to see what is selectable. Mutating: this changes the remote session, not',
      'this one. The result reports the applied route, the previous one when known, and whether this',
      'call was an already-applied retry.',
      'The alias names the pairing (the member device in the fleet convention) and is the same string',
      'on both devices — it is NOT the target host name.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Pairing alias of the peer session.' },
        provider: { type: 'string', description: 'Provider id of the route to run (with model).' },
        model: { type: 'string', description: 'Model id of the route to run (with provider).' },
        chain: { type: 'string', description: 'Chain id to run instead of, or narrowing, an explicit route.' },
        reasoningEffort: { type: 'string', description: 'Adapter-supported reasoning effort for the chosen route.' },
        requestId: {
          type: 'string',
          description: 'Optional retry key: reuse the value from a failed attempt to replay it instead of switching twice.',
        },
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
          requestId: { type: 'string' },
          selection: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              chain: { type: 'string' },
              reasoningEffort: { type: 'string' },
            },
            required: ['provider', 'model'],
          },
          previous: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              chain: { type: 'string' },
              reasoningEffort: { type: 'string' },
            },
            required: ['provider', 'model'],
          },
          replayed: { type: 'boolean' },
          note: { type: 'string' },
          error: failureSchema(),
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderSwitch(value) }],
    },
    async execute(args) {
      const request = narrow(args)
      const alias = requireAlias(request.alias)
      const route = switchRouteOf(request)
      if (!route.ok) return badRequest(route.message)
      const requestId = nonEmptyTextOf('requestId', request.requestId)
      if (requestId !== undefined && !requestId.ok) return badRequest(requestId.message)
      const { pairing, document } = resolveEntry(pairingsPath, alias)
      const client = makeClient(pairing, config, document.device, effectiveDeps)
      const id = requestId === undefined ? `peer-bridge-${randomUUID()}` : requestId.value
      try {
        const handshake = await client.handshake()
        const gap = capabilityGap(handshake.capabilities, 'model-switch')
        if (gap !== undefined) return gap
        const value = await client.selectModel({
          target: targetOf(pairing),
          participant: participantOf(config, document),
          requestId: id,
          provider: route.value.provider ?? '',
          model: route.value.model ?? '',
          ...(route.value.chain === undefined ? {} : { chain: route.value.chain }),
          ...(route.value.reasoningEffort === undefined ? {} : { reasoningEffort: route.value.reasoningEffort }),
        })
        return {
          ok: true,
          alias,
          requestId: id,
          selection: value.selected,
          ...(value.previous === undefined ? {} : { previous: value.previous }),
          replayed: value.replayed === true,
          note: value.replayed === true
            ? 'this switch was already applied; the result is the original one'
            : 'the remote session will run the selected route on its next turn',
        }
      } catch (error) {
        const failure = failureFrom(error, pairing.endpoint)
        return { ...failure, alias, requestId: id }
      }
    },
  })

  ctx.tools.register({
    name: 'peer_ask',
    description: [
      'Send a message to a paired peer session as an attributed peer turn, then follow the remote',
      'session until the turn reaches a terminal state and return the remote answer (or the structured',
      'failure when the turn failed). If the followed turn enters waiting_approval, the call returns',
      'EARLY with status "waiting_approval" and the pending ask(s) (askId, kind, toolName, reason)',
      'instead of blocking: decide each with peer_asks/peer_answer, then call peer_ask again with',
      'resume set to the returned requestId to follow the same turn to completion. A host that goes',
      'silent mid-follow (for example a sleeping laptop) is detected by a reachability probe after',
      'the configured probeIntervalMs and returns status "host_unreachable" without cancelling the',
      'remote turn. Remote asks that',
      'appear while following are surfaced locally for the operator to answer. The remote runs with',
      'its OWN tools, workspace, and approvals.',
      'The alias names the pairing (the member device in the fleet convention) and is the same string',
      'on both devices — it is NOT the target host name.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Pairing alias of the peer session to prompt.' },
        message: { type: 'string', description: 'The message to send (plain text); omit when resuming.' },
        waitMs: { type: 'number', description: `How long to follow, in milliseconds (default ${String(waitMs)}).` },
        resume: {
          type: 'string',
          description: [
            'A requestId from a prior peer_ask result (waiting_approval or pending): continues',
            'following that same remote turn to its terminal state without sending the message again.',
          ].join(' '),
        },
        requestId: { type: 'string', description: 'Retry key from a lost reply. Retry with the same message and create options; use resume to follow without resending.' },
        provider: { type: 'string', description: 'When this call creates the session: provider of the route it starts on (with model).' },
        model: { type: 'string', description: 'When this call creates the session: model it starts on (with provider).' },
        chain: { type: 'string', description: 'When this call creates the session: chain id it starts on (its first ready member runs).' },
        reasoningEffort: { type: 'string', description: 'When this call creates the session: reasoning effort for the chosen route or chain.' },
        maxTotalTokens: { type: 'number', description: 'When this call creates the session: token ceiling; the peer stops the session when it is reached.' },
      },
      required: ['alias'],
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
          createRequestId: { type: 'string' },
          disposition: { type: 'string' },
          terminalState: { type: 'string' },
          instanceId: { type: 'string' },
          replayed: { type: 'boolean' },
          admitted: { type: 'boolean' },
          resumed: { type: 'boolean' },
          status: { type: 'string' },
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
          pendingAsks: { type: 'array', items: askItemSchema() },
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
      const resumeRaw = request.resume
      if (resumeRaw !== undefined && (typeof resumeRaw !== 'string' || resumeRaw === '')) {
        return { ok: false, error: { code: 'gateway/bad-request', message: 'resume must be the requestId string from a prior peer_ask result' } }
      }
      const resume = typeof resumeRaw === 'string' ? resumeRaw : undefined
      const requestId = nonEmptyTextOf('requestId', request.requestId)
      if (requestId !== undefined && !requestId.ok) return badRequest(requestId.message)
      if (resume !== undefined && requestId !== undefined) return badRequest('peer_ask takes either resume or requestId, not both')
      if (resume !== undefined && message.trim() !== '') {
        return { ok: false, error: { code: 'gateway/bad-request', message: 'resume continues a followed turn; drop message (the first peer_ask already sent it)' } }
      }
      if (resume === undefined && message.trim() === '') return { ok: false, error: { code: 'gateway/bad-request', message: 'peer_ask needs a non-empty message' } }
      if (message.length > MAX_MESSAGE_CHARS) {
        return { ok: false, error: { code: 'gateway/bad-request', message: `peer_ask message exceeds ${String(MAX_MESSAGE_CHARS)} characters` } }
      }
      const createRouting = askCreateRoutingOf(request)
      if (!createRouting.ok) return badRequest(createRouting.message)
      const requestedWait = typeof request.waitMs === 'number' && Number.isFinite(request.waitMs) && request.waitMs > 0
        ? Math.trunc(request.waitMs)
        : waitMs
      return runAsk(ctx, {
        pairingsPath,
        noticesPath,
        waitMs: requestedWait,
        settleMs,
        probeIntervalMs,
        config,
        signal: exec.signal,
        agent: exec.agent,
        alias,
        message,
        ...(resume === undefined ? {} : { resume }),
        ...(requestId === undefined ? {} : { requestId: requestId.value }),
        ...(exec.agent?.session === undefined ? {} : { toolCallKey: JSON.stringify([exec.agent.session.id, exec.callId]) }),
        createRouting: createRouting.value,
        allowCreate: true,
        deps: effectiveDeps,
      })
    },
  })

  ctx.tools.register({
    name: 'peer_asks',
    description: 'List retained asks on a paired peer session, including expired asks. Only pending approvals and questions can take a new decision with peer_answer.',
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
          instanceId: { type: 'string' },
          asks: {
            type: 'array',
            items: askItemSchema(),
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
      const { pairing, document } = resolveEntry(pairingsPath, alias)
      const client = makeClient(pairing, config, document.device, effectiveDeps)
      try {
        const handshake = await client.handshake()
        if (handshake.capabilities.includes('durable-asks')) {
          const value = await client.asks({ alias, sessionId: pairing.remoteSessionId })
          return { ok: true, alias, instanceId: value.instanceId, sessionId: pairing.remoteSessionId ?? value.asks[0]?.sessionId,
            asks: value.asks.map(ask => ({ ...askPayload(ask), state: ask.state, settlementReason: ask.settlementReason, answeredBy: ask.answeredBy })) }
        }
        warnAskCapabilities(handshake, effectiveDeps, ['durable-asks'])
        const value = await client.state(targetOf(pairing))
        return {
          ok: true,
          alias,
          sessionId: value.target.sessionId,
          latch: value.state.latch,
          asks: value.state.pendingAsks.map(ask => ({ ...askPayload(ask), state: 'pending' })),
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
      'the ids and options). Reuse requestId and the same decision after a lost reply; an expired ask',
      'cannot take a new decision. A malformed selection is rejected here with the',
      'reason and never reaches the host.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Pairing alias of the peer session.' },
        askId: { type: 'string', description: 'Remote ask id from peer_asks or a peer_ask result.' },
        requestId: { type: 'string', description: 'Retry ID from an earlier answer; reuse only with the same decision.' },
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
          requestId: { type: 'string' },
          replayed: { type: 'boolean' },
          payloadHash: { type: 'string' },
          instanceId: { type: 'string' },
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
      const retry = nonEmptyTextOf('requestId', request.requestId)
      if (retry !== undefined && !retry.ok) return badRequest(retry.message)
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
      const participant = participantOf(config, document)
      let target = targetOf(pairing)
      let answer: Parameters<PeerClient['answer']>[0]['answer']
      let durableAsks = false
      try {
        const handshake = await client.handshake()
        warnAskCapabilities(handshake, effectiveDeps, ['ask-idempotent-answer'])
        durableAsks = handshake.capabilities.includes('durable-asks')
      } catch (error) {
        return failureFrom(error, pairing.endpoint)
      }
      if (outcome !== undefined) {
        answer = { kind: 'approval', outcome }
      } else {
        const parsed = parseQuestionSelections(rawAnswers ?? [])
        if (!parsed.ok) return badRequest(parsed.message)
        let pending: PeerPendingAsk | undefined
        try {
          if (durableAsks) {
            const value = await client.asks({ alias, sessionId: pairing.remoteSessionId })
            const retained = value.asks.find(candidate => candidate.askId === askId)
            pending = retained
            if (retained !== undefined) target = { kind: 'session', sessionId: retained.sessionId }
          } else {
            const value = await client.state(target)
            pending = value.state.pendingAsks.find(candidate => candidate.askId === askId)
          }
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
      let requestId: string
      try {
        requestId = retry?.value ?? recordAnswerId(dirname(noticesPath), pairing, participant, askId)
      } catch {
        return { ok: false, settled: false, error: { code: 'peer/unavailable', message: 'Could not record the local answer retry ID; no answer was sent.' } }
      }
      try {
        const value = await client.answer({
          target,
          participant,
          askId,
          requestId,
          answer,
        })
        return {
          ok: value.accepted === true && value.settled === true,
          alias,
          askId,
          requestId,
          settled: value.settled === true,
          replayed: value.replayed,
          payloadHash: value.payloadHash,
          instanceId: value.instanceId,
          confirmation: 'confirmed',
          note: value.replayed === true ? 'The host replayed the recorded answer; no new decision was delivered.' : answer.kind === 'question'
            ? 'question settled; the first answer won'
            : 'ask settled; the first answer won',
        }
      } catch (error) {
        const conflict = error instanceof PeerBridgeError && error.code === 'peer/conflict'
        if (error instanceof PeerBridgeError && (error.code === 'peer/target-unreachable' || error.details.reason === 'missing-result-envelope')) {
          const reread = await client.state(target).catch(() => undefined)
          const gone = reread !== undefined && !reread.state.pendingAsks.some(candidate => candidate.askId === askId)
          const message = gone
            ? 'The answer reply was lost and the ask is no longer pending. This does not establish who answered or whether it expired; reuse the same request ID and decision to check for replay.'
            : 'The answer reply was lost; reuse the same request ID and decision to check for replay.'
          return { ok: false, alias, askId, requestId, settled: false, confirmation: 'lost', note: message, error: { code: 'peer/target-unreachable', message } }
        }
        const refusal = answerRefusal(error)
        const failure = failureFrom(error, pairing.endpoint)
        return {
          ok: false,
          alias,
          askId,
          requestId,
          settled: false,
          note: refusal ?? (conflict
            ? 'another participant already answered this ask (peer/conflict) — report it; do not retry blind'
            : failure.error.message),
          error: refusal === undefined ? failure.error : { ...failure.error, message: refusal },
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
          stopIntent: stopIntentSchema(),
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
            ? `${record.cancelled === true ? 'Stop requested on' : 'No active turn reported on'} ${String(record.alias)} — ${String(record.note ?? '')}${record.stopIntent === undefined ? '' : `\n${stopIntentText(record.stopIntent)}`}`
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
        if (value.stopIntent === undefined) effectiveDeps.onCompatibilityWarning?.('peer cancel did not report stop-intent')
        return {
          ok: true,
          alias,
          cancelled: value.cancelled,
          stopIntent: value.stopIntent,
          confirmation: 'confirmed',
          note: value.cancelled ? 'remote Stop was requested; this does not prove teardown' : 'remote session had no active turn',
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
              stopIntent: reread.state.stopIntent,
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
  /** Idle interval before a silent host is probed for reachability; 0 disables. */
  readonly probeIntervalMs: number
  readonly config: ResolvedConfig
  readonly signal: AbortSignal
  readonly agent?: Agent
  readonly alias: string
  readonly message: string
  /** RequestId of a prior result to resume; no prompt is sent when set. */
  readonly resume?: string
  readonly requestId?: string
  readonly toolCallKey?: string
  /** Create-time routing and ceiling; only ever applied when this call creates the session. */
  readonly createRouting: {
    readonly provider?: string
    readonly model?: string
    readonly chain?: string
    readonly reasoningEffort?: string
    readonly maxTotalTokens?: number
  }
  readonly allowCreate: boolean
  readonly deps: BridgeDeps
}

function warnAskCapabilities(host: PeerHandshakeValue, deps: BridgeDeps, capabilities: readonly string[]): void {
  for (const capability of capabilities) {
    if (!host.capabilities.includes(capability)) deps.onCompatibilityWarning?.(`peer host does not advertise ${capability}`)
  }
}

function lostInputReply(client: PeerClient, kind: PeerInputReceiptKind, alias: string, requestId: string, createRequestId: string, error: unknown): Promise<unknown> | undefined {
  if (!(error instanceof PeerBridgeError)) return undefined
  const reason = error.details.reason
  if (error.code !== 'peer/target-unreachable' && reason !== 'missing-result-envelope'
    && !(error.code === 'peer/unavailable' && reason === 'receipt-finalize-failed')) return undefined
  return (async () => {
    const receipt = await client.receipt({ alias, requestId: kind === 'create' ? createRequestId : requestId, kind }, AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS)).catch(() => undefined)
    const dispositions = kind === 'create' ? ['created', 'adopted'] : ['queued', 'claimed', 'cancelled_before_dispatch', 'terminal']
    const disposition = receipt?.found === true && dispositions.includes(receipt.disposition) ? receipt.disposition : 'unknown'
    return {
      ok: false, alias, requestId, ...(kind === 'create' ? { createRequestId } : {}), disposition,
      sessionId: receipt?.sessionId, instanceId: receipt?.instanceId, terminalState: receipt?.terminalState,
      error: { code: error.code, message: `Peer ${kind} reply could not be confirmed; receipt disposition: ${disposition}.` },
    }
  })()
}

async function runAsk(ctx: Context, options: AskRunOptions): Promise<unknown> {
  const { pairing, document } = resolveEntry(options.pairingsPath, options.alias)
  const client = makeClient(pairing, options.config, document.device, options.deps)
  const participant = participantOf(options.config, document)
  // Resume continues a turn whose prompt was already admitted: no new message,
  // no create, and the original requestId keeps record attribution exact (the
  // resumed follow may replay the admission and even the turn's terminal in
  // its opening snapshot).
  const resumed = options.resume !== undefined && options.resume !== ''
  const requestId = options.resume ?? options.requestId ?? (options.toolCallKey === undefined
    ? `peer-bridge-${randomUUID()}`
    : `peer-bridge-${createHash('sha256').update(options.toolCallKey).digest('hex')}`)
  const createRequestId = `peer-bridge-create-${createHash('sha256').update(requestId).digest('hex')}`
  let created = false
  let createAttempted = false
  let handshake: PeerHandshakeValue
  try {
    handshake = await client.handshake()
    warnAskCapabilities(handshake, options.deps, ['bounded-follow', 'ask-idempotent-answer'])
  } catch (error) {
    return failureFrom(error, pairing.endpoint)
  }
  let requestedTarget = targetOf(pairing)
  let baseline: Awaited<ReturnType<PeerClient['state']>>
  const createOrReplay = async () => {
    createAttempted = true
    const defaults = pairing.create ?? {}
    const routeOverride = options.createRouting.provider !== undefined || options.createRouting.chain !== undefined
    const routing = { ...(routeOverride ? {} : pairing.createRouting ?? {}), ...options.createRouting }
    warnAskCapabilities(handshake, options.deps, [
      'session-create', 'create-receipts',
      ...(routing.provider !== undefined || routing.chain !== undefined ? ['model-routing-at-create'] : []),
      ...(routing.maxTotalTokens === undefined ? [] : ['token-ceiling']),
    ])
    const value = await client.create({
      alias: pairing.alias, participant, requestId: createRequestId,
      ...(typeof defaults.cwd === 'string' ? { cwd: defaults.cwd } : {}),
      ...(typeof defaults.agentPreset === 'string' ? { agentPreset: defaults.agentPreset } : {}),
      ...routing,
    })
    created = value.created
    // Use the session this receipt names, not a potentially rebound alias.
    requestedTarget = { kind: 'session', sessionId: value.target.sessionId }
    return client.state(requestedTarget)
  }
  try {
    baseline = await client.state(requestedTarget)
  } catch (error) {
    const code = error instanceof PeerBridgeError ? error.code : ''
    if (resumed || !options.allowCreate || requestedTarget.kind !== 'alias' || (code !== 'peer/not-paired' && code !== 'peer/not-found')) {
      return failureFrom(error, pairing.endpoint)
    }
    try {
      baseline = await createOrReplay()
    } catch (createError) {
      return lostInputReply(client, 'create', pairing.alias, requestId, createRequestId, createError)
        ?? { ...failureFrom(createError, pairing.endpoint), requestId, createRequestId }
    }
  }
  if (!resumed && !createAttempted && requestedTarget.kind === 'alias' && handshake.capabilities.includes('input-disposition')
    && (options.requestId !== undefined || Object.keys(options.createRouting).length > 0)) {
    try {
      const prior = await client.receipt({ alias: pairing.alias, requestId: createRequestId, kind: 'create' }, AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS))
      if (prior.found) baseline = await createOrReplay()
    } catch (error) {
      return (createAttempted ? lostInputReply(client, 'create', pairing.alias, requestId, createRequestId, error) : undefined)
        ?? { ...failureFrom(error, pairing.endpoint), requestId, createRequestId }
    }
  }
  if (!createAttempted && Object.keys(options.createRouting).length > 0) {
    return badRequest(resumed
      ? 'peer_ask resume cannot change the model; call peer_switch_model first if the turn needs another route'
      : 'peer_ask model options apply only when this call creates the session; this session already exists — use peer_switch_model to change its model')
  }
  let prompt: PeerPromptValue | undefined
  if (!resumed) {
    warnAskCapabilities(handshake, options.deps, ['prompt-receipts', 'input-disposition'])
    try {
      if (requestedTarget.kind === 'alias') {
        let sessionId = baseline.target.sessionId
        if (options.requestId !== undefined && handshake.capabilities.includes('input-disposition')) {
          const prior = await client.receipt({ alias: pairing.alias, requestId, kind: 'prompt' }, AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS))
          if (prior.found && prior.sessionId !== undefined && prior.sessionId !== sessionId) {
            requestedTarget = { kind: 'session', sessionId: prior.sessionId }
            baseline = await client.state(requestedTarget)
            sessionId = baseline.target.sessionId
          }
        }
        requestedTarget = { kind: 'session', sessionId }
      }
    } catch (error) {
      return { ...failureFrom(error, pairing.endpoint), requestId }
    }
    try {
      prompt = await client.prompt({
        target: requestedTarget,
        participant,
        requestId,
        content: [{ type: 'text', text: options.message }],
        hopCount: 0,
      })
    } catch (error) {
      return lostInputReply(client, 'prompt', pairing.alias, requestId, createRequestId, error)
        ?? { ...failureFrom(error, pairing.endpoint), requestId }
    }
  }
  const input = {
    ...(createAttempted ? { createRequestId } : {}),
    ...(prompt?.disposition === undefined ? {} : { disposition: prompt.disposition }),
    ...(prompt?.terminalState === undefined ? {} : { terminalState: prompt.terminalState }),
    ...(prompt?.replayed === undefined ? {} : { replayed: prompt.replayed }),
    instanceId: prompt?.instanceId ?? handshake.instanceId,
  }
  const baselineTurn = options.requestId !== undefined || prompt?.replayed === true ? 0 : (baseline.state.lastTurnEnd?.turn ?? 0)
  if (prompt?.disposition === 'cancelled_before_dispatch') {
    return { ...input, ok: false, alias: pairing.alias, sessionId: baseline.target.sessionId, requestId, created, admitted: true }
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.waitMs)
  const relayAbort = (): void => { controller.abort() }
  options.signal.addEventListener('abort', relayAbort, { once: true })

  // Mid-follow host death (a sleeping laptop, a cut link) leaves the follow
  // socket open and silent, so no frame ever arrives and the loop would wait
  // out waitMs. The watchdog checks REACHABILITY, never silence: after
  // probeIntervalMs without a frame it makes one cheap unary call; only a host
  // that fails to answer at all ends the follow early. A reachable host that is
  // merely generating keeps the follow alive, and the remote turn is never
  // cancelled — the abort below only tears down this local follow generation.
  let lastFrameAt = Date.now()
  let hostSilent = false
  const watchdog = options.probeIntervalMs > 0
    ? (async (): Promise<void> => {
      while (!controller.signal.aborted) {
        await delay(options.probeIntervalMs, controller.signal)
        if (controller.signal.aborted) return
        if (Date.now() - lastFrameAt < options.probeIntervalMs) continue
        const reachable = await client.probe(requestedTarget, { timeoutMs: HOST_PROBE_TIMEOUT_MS, signal: controller.signal })
        if (controller.signal.aborted) return
        if (!reachable) {
          hostSilent = true
          controller.abort()
          return
        }
      }
    })()
    : undefined

  const asks = new Map<string, AskBridgeRecord>()
  let latch = baseline.state.latch
  let cursor = baseline.cursor
  // The prompt response already proved the host recorded this prompt; the
  // durable `user/message` below only marks which turn carried it.
  const admitted = !resumed
  let terminal: ReturnType<typeof recordTerminal>
  let detached = false
  let approvalPause = false
  let activeDescendants = baseline.state.activeDescendants
  let descendantsExact = baseline.state.descendantsExact
  let pendingNow: readonly PeerPendingAsk[] = baseline.state.pendingAsks
  let pendingAskCount = pendingNow.length
  const answerParts: string[] = []
  let answerTurn: number | undefined
  // Durable seqs already folded: a reconnect snapshot replay must never append
  // the same assistant text twice.
  const seenSeqs = new Set<number>()
  // Causal attribution: assistant text and terminals count only for the turn
  // that carried our admitted prompt (or a later one). A concurrent
  // third-party turn that ends before our `user/message` appears is ignored,
  // and a later turn opened by a different operator's prompt cannot replace
  // our own result (`abandoned`). A resume seeds the floor with the first turn
  // after the resumed baseline; the replayed admission record refines it when
  // the opening snapshot still carries it (the turn may even have ended before
  // the resume, in which case the admission and its terminal arrive together).
  let admittedTurn: number | undefined = resumed ? baselineTurn + 1 : undefined
  let observedTurn: number | undefined
  let admissionSeen = false
  let abandoned = false
  let quietExpired = false
  let repairing = false
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
  const settledNow = (): boolean => !repairing && isPeerSessionSettled({
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
    // The floor is the admitted turn; before admission the resume seed already
    // names the first candidate, and normal follows reject everything.
    const floor = admittedTurn ?? baselineTurn + 1
    const attributed = admittedTurn !== undefined && turn !== undefined && turn >= admittedTurn
      && (!abandoned || turn <= admittedTurn)
    if (!attributed) return
    if (record.type === 'assistant/message' && turn !== undefined && turn >= floor) {
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
    if (end !== undefined && end.turn >= floor) {
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
      lastFrameAt = Date.now()
      if (frame.type === 'gap') {
        repairing = true
        clearQuiet()
        continue
      }
      if (frame.type === 'snapshot') {
        repairing = false
        cursor = frame.cursor
        latch = frame.state.latch
        activeDescendants = frame.state.activeDescendants
        descendantsExact = frame.state.descendantsExact
        pendingNow = frame.state.pendingAsks
        pendingAskCount = pendingNow.length
        for (const record of frame.records) absorb(record)
        await surfaceFrame(pendingNow)
      } else if (frame.type === 'state') {
        cursor = frame.cursor
        latch = frame.state.latch
        activeDescendants = frame.state.activeDescendants
        descendantsExact = frame.state.descendantsExact
        pendingNow = frame.state.pendingAsks
        pendingAskCount = pendingNow.length
        await surfaceFrame(pendingNow)
      } else if (frame.type === 'event') {
        cursor = Math.max(cursor, frame.record.seq)
        absorb(frame.record)
      } else if (frame.type === 'end' && frame.reason === 'target-detached') {
        detached = true
        break
      }
      if (repairing) continue
      // A followed turn blocked on an ask: return the pending asks now instead
      // of holding the caller until waitMs. The caller (or its operator)
      // decides with peer_asks/peer_answer and resumes with the requestId.
      if (latch === 'waiting_approval' && pendingNow.length > 0) {
        approvalPause = true
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
    if (!timedOut && !controller.signal.aborted) return { ...failureFrom(error, pairing.endpoint), ...input, requestId, admitted, alias: pairing.alias, sessionId: baseline.target.sessionId }
  } finally {
    clearTimeout(timer)
    clearQuiet()
    options.signal.removeEventListener('abort', relayAbort)
    // The follower is gone (terminal, waitMs, exec abort, or a dead socket):
    // withdraw any local card still open for it and let the contained tasks
    // settle, so the result below reports their final decisions.
    controller.abort()
    await Promise.allSettled([...inFlight, ...(watchdog === undefined ? [] : [watchdog])])
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

  if (hostSilent) {
    return {
      ...input,
      ok: false,
      pending: true,
      status: 'host_unreachable',
      settled: false,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...(resumed ? { resumed: true } : {}),
      answer: answerParts.join('\n').trim(),
      asks: askLines(asks),
      pendingAsks: pendingNow.map(askPayload),
      latch,
      cursor,
      note: [
        `the remote host stopped answering mid-turn (no frame for ${String(options.probeIntervalMs)}ms and the reachability probe failed) — it may be asleep`,
        'the remote turn was NOT cancelled and may resume if the host wakes',
        `call peer_ask again with resume: ${JSON.stringify(requestId)} to re-follow`,
      ].join(' — '),
    }
  }

  if (detached) {
    return {
      ...input,
      ok: false,
      pending: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...(resumed ? { resumed: true } : {}),
      asks: askLines(asks),
      latch,
      cursor,
      note: 'the remote pairing/session binding disappeared (target-detached)',
    }
  }

  if (approvalPause) {
    const ids = pendingNow.map(ask => ask.askId)
    return {
      ...input,
      ok: false,
      pending: true,
      status: 'waiting_approval',
      settled: false,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...(resumed ? { resumed: true } : {}),
      asks: askLines(asks),
      pendingAsks: pendingNow.map(askPayload),
      latch,
      cursor,
      note: [
        `the remote turn is waiting_approval on ${String(ids.length)} ask(s): ${ids.join(', ')}`,
        `decide each with peer_asks/peer_answer, then call peer_ask again with resume: ${JSON.stringify(requestId)}`,
        'to follow the same turn to completion (no message is re-sent)',
      ].join(' — '),
    }
  }

  const answer = answerParts.join('\n').trim()
  if (terminal === undefined) {
    return {
      ...input,
      ok: false,
      pending: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...(resumed ? { resumed: true } : {}),
      answer,
      asks: askLines(asks),
      latch,
      cursor,
      note: `no terminal within ${String(options.waitMs)}ms — the remote turn is still live (follow it again with peer_ask resume: ${JSON.stringify(requestId)}, or ds peer follow)`,
    }
  }
  if (abandoned && !repairing) {
    return {
      ...input,
      ok: terminal.reason === 'completed',
      settled: true,
      superseded: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...(resumed ? { resumed: true } : {}),
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
      ...input,
      ok: false,
      pending: true,
      settled: false,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...(resumed ? { resumed: true } : {}),
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
      note: repairing ? 'Peer follow lost continuity; history repair did not finish. Follow again to collect the remainder.'
        : `remote turn ${String(terminal.turn)} ended: ${terminal.reason} but the session was not settled when following stopped (${unsettledSummary(latch, activeDescendants, pendingAskCount)}) — follow again to collect the remainder`,
    }
  }
  if (terminal.reason !== 'completed') {
    return {
      ...input,
      ok: false,
      settled: true,
      alias: pairing.alias,
      sessionId: baseline.target.sessionId,
      created,
      requestId,
      admitted,
      ...(resumed ? { resumed: true } : {}),
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
    ...input,
    ok: true,
    settled: true,
    alias: pairing.alias,
    sessionId: baseline.target.sessionId,
    created,
    requestId,
    admitted,
    ...(resumed ? { resumed: true } : {}),
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
      await relayAnswer(client, noticesPath, pairing, target, participant, ask.askId, { kind: 'approval', outcome: mapped.outcome }, record, mapped.note)
    } catch (error) {
      const code = error instanceof PeerBridgeError ? error.code : 'unknown'
      record.relay = code === 'peer/conflict' ? 'conflict' : code === 'peer/not-found' ? 'not-found' : 'failed'
      record.note = answerRefusal(error) ?? (code === 'peer/conflict'
        ? 'another participant answered first (peer/conflict) — not retried'
        : `relay failed [${code}]${record.answerRequestId === undefined ? '' : '; reuse the answer request ID with the same decision'}`)
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
    await relayAnswer(client, noticesPath, pairing, target, participant, ask.askId, { kind: 'question', answer }, record, 'local question answered → relayed')
  } catch (error) {
    const code = error instanceof PeerBridgeError ? error.code : 'unknown'
    record.relay = code === 'peer/conflict' ? 'conflict' : code === 'peer/not-found' ? 'not-found' : 'failed'
    record.note = answerRefusal(error) ?? (code === 'peer/conflict'
      ? 'another participant answered first (peer/conflict) — not retried'
      : `relay failed [${code}]${record.answerRequestId === undefined ? '' : '; reuse the answer request ID with the same decision'}`)
  }
}

async function relayAnswer(client: PeerClient, noticesPath: string, pairing: DialablePairing, target: ReturnType<typeof targetOf>, participant: PeerParticipant,
  askId: string, answer: Parameters<PeerClient['answer']>[0]['answer'], record: AskBridgeRecord, note: string): Promise<void> {
  const requestId = recordAnswerId(dirname(noticesPath), pairing, participant, askId)
  record.answerRequestId = requestId
  const result = await client.answer({ target, participant, askId, requestId, answer })
  if (result.accepted !== true || result.settled !== true) {
    record.relay = 'failed'
    record.note = 'The host did not confirm answer settlement.'
    return
  }
  record.relay = 'settled'
  record.note = result.replayed === true ? 'the host replayed the recorded answer; no new decision was delivered' : note
}

function recordAnswerId(directory: string, pairing: DialablePairing, participant: PeerParticipant, askId: string): string {
  const fingerprint = createHash('sha256').update(JSON.stringify([pairing.endpoint, pairing.alias, participant.device, participant.name, askId])).digest('hex')
  const requestId = `peer-bridge-answer-${fingerprint}`
  const store = join(directory, 'answer-requests')
  mkdirSync(store, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(join(store, fingerprint), `${requestId}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  return requestId
}

function answerRefusal(error: unknown): string | undefined {
  if (!(error instanceof PeerBridgeError)) return undefined
  switch (error.details.reason) {
    case 'request-id-reuse': return 'This answer request ID belongs to a different decision. Do not retry with changed answers.'
    case 'ask-already-settled': return 'The ask was already settled; this answer did not settle it.'
    case 'stale-generation': return 'The worker restarted; this ask is no longer answerable. Do not retry.'
    case 'ask-expired': return 'The ask expired (including after a worker restart) and is no longer answerable. Do not retry.'
    case 'ask-not-found': return 'The host no longer has this ask for the selected session. Read peer_asks before taking another action.'
    case 'ask-store-unavailable': return 'The host ask journal is unavailable; no answer was confirmed.'
    case 'ask-write-failed': return 'The host could not persist the answer; reuse the same request ID and decision if retrying.'
    default: return undefined
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
  const headers: Record<string, string> = pairing.outboundToken === undefined
    ? {}
    : { authorization: `Bearer ${pairing.outboundToken}` }
  return new PeerClient({
    endpoint: pairing.endpoint,
    device: config.device ?? device ?? pairing.peer,
    headers,
    ...(config.maxReconnects === undefined ? {} : { maxReconnects: config.maxReconnects }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.webSocket === undefined ? {} : { webSocket: deps.webSocket }),
    ...(deps.onWarning === undefined ? {} : { onWarning: deps.onWarning }),
    ...(deps.onCompatibilityWarning === undefined ? {} : { onCompatibilityWarning: deps.onCompatibilityWarning }),
  })
}

function narrow(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
}

/**
 * The failure value a capability-gated tool returns when the peer host does not
 * advertise what the call needs, instead of forwarding an opaque refusal.
 * @param capabilities - the host's advertised capabilities.
 * @param capability - the capability the tool needs (`model-discovery` / `model-switch`).
 * @returns the failure value, or undefined when the host advertises it.
 */
function capabilityGap(capabilities: readonly string[], capability: string): ToolFailure | undefined {
  if (capabilities.includes(capability)) return undefined
  return { ok: false, error: { code: 'peer/capability-missing', message: `host does not advertise ${capability}; upgrade the host` } }
}

/** One validated tool argument: the value, or the reason it is malformed. */
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/**
 * Read an optional non-empty string argument.
 * @param name - argument name for the failure text.
 * @param value - the raw tool argument.
 * @returns the parsed value, undefined when absent, or the malformed reason.
 */
function nonEmptyTextOf(name: string, value: unknown): Parsed<string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, message: `${name} must be a non-empty string` }
  return { ok: true, value: value.trim() }
}

/**
 * Read an optional positive-integer argument; the peer clamps an oversized one.
 * @param name - argument name for the failure text.
 * @param value - the raw tool argument.
 * @returns the parsed value, undefined when absent, or the malformed reason.
 */
function positiveIntegerOf(name: string, value: unknown): Parsed<number> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return { ok: false, message: `${name} must be a positive integer` }
  return { ok: true, value }
}

/**
 * Build the optional discovery filter from the raw arguments.
 * @param request - the raw tool arguments.
 * @returns the filter (absent when neither flag was set) or the malformed reason.
 */
function modelsFilterOf(request: Record<string, unknown>): Parsed<{ readonly zeroPrice?: boolean; readonly tools?: boolean }> | undefined {
  const filter: { zeroPrice?: boolean; tools?: boolean } = {}
  for (const name of ['zeroPrice', 'tools'] as const) {
    const raw = request[name]
    if (raw === undefined) continue
    if (typeof raw !== 'boolean') return { ok: false, message: `${name} must be a boolean` }
    if (raw) filter[name] = true
  }
  return Object.keys(filter).length === 0 ? undefined : { ok: true, value: filter }
}

/**
 * Validate the switch tool's route arguments: provider and model travel
 * together, and at least one of a route or a chain is required.
 * @param request - the raw tool arguments.
 * @returns the route fields, or the malformed reason.
 */
function switchRouteOf(request: Record<string, unknown>):
  Parsed<{ readonly provider?: string; readonly model?: string; readonly chain?: string; readonly reasoningEffort?: string }> {
  const provider = nonEmptyTextOf('provider', request.provider)
  const model = nonEmptyTextOf('model', request.model)
  const chain = nonEmptyTextOf('chain', request.chain)
  const effort = nonEmptyTextOf('reasoningEffort', request.reasoningEffort)
  for (const parsed of [provider, model, chain, effort]) {
    if (parsed !== undefined && !parsed.ok) return parsed
  }
  const providerValue = provider?.ok === true ? provider.value : undefined
  const modelValue = model?.ok === true ? model.value : undefined
  const chainValue = chain?.ok === true ? chain.value : undefined
  const effortValue = effort?.ok === true ? effort.value : undefined
  if ((providerValue === undefined) !== (modelValue === undefined)) {
    return { ok: false, message: 'peer_switch_model needs provider and model together' }
  }
  if (providerValue === undefined && chainValue === undefined) {
    return { ok: false, message: 'peer_switch_model needs provider+model or a chain' }
  }
  if (effortValue !== undefined && providerValue === undefined && chainValue === undefined) {
    return { ok: false, message: 'a reasoning effort needs a route or a chain to apply to' }
  }
  return {
    ok: true,
    value: {
      ...(providerValue === undefined ? {} : { provider: providerValue }),
      ...(modelValue === undefined ? {} : { model: modelValue }),
      ...(chainValue === undefined ? {} : { chain: chainValue }),
      ...(effortValue === undefined ? {} : { reasoningEffort: effortValue }),
    },
  }
}

/**
 * Validate the optional create-time routing arguments `peer_ask` forwards when
 * it creates a session.
 * @param request - the raw tool arguments.
 * @returns the create fields (empty when none were named), or the malformed reason.
 */
function askCreateRoutingOf(request: Record<string, unknown>):
  Parsed<{ readonly provider?: string; readonly model?: string; readonly chain?: string; readonly reasoningEffort?: string; readonly maxTotalTokens?: number }> {
  const provider = nonEmptyTextOf('provider', request.provider)
  const model = nonEmptyTextOf('model', request.model)
  const chain = nonEmptyTextOf('chain', request.chain)
  const effort = nonEmptyTextOf('reasoningEffort', request.reasoningEffort)
  const ceiling = positiveIntegerOf('maxTotalTokens', request.maxTotalTokens)
  for (const parsed of [provider, model, chain, effort, ceiling]) {
    if (parsed !== undefined && !parsed.ok) return parsed
  }
  const providerValue = provider?.ok === true ? provider.value : undefined
  const modelValue = model?.ok === true ? model.value : undefined
  const chainValue = chain?.ok === true ? chain.value : undefined
  const effortValue = effort?.ok === true ? effort.value : undefined
  const ceilingValue = ceiling?.ok === true ? ceiling.value : undefined
  if ((providerValue === undefined) !== (modelValue === undefined)) {
    return { ok: false, message: 'peer_ask needs provider and model together' }
  }
  if (effortValue !== undefined && providerValue === undefined && chainValue === undefined) {
    return { ok: false, message: 'a reasoning effort needs provider+model or a chain to apply to' }
  }
  return {
    ok: true,
    value: {
      ...(providerValue === undefined ? {} : { provider: providerValue }),
      ...(modelValue === undefined ? {} : { model: modelValue }),
      ...(chainValue === undefined ? {} : { chain: chainValue }),
      ...(effortValue === undefined ? {} : { reasoningEffort: effortValue }),
      ...(ceilingValue === undefined ? {} : { maxTotalTokens: ceilingValue }),
    },
  }
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
    const reason = error.details.reason
    const safeMessage = error.code === 'peer/conflict' && reason === 'request-id-reuse'
      ? 'This request ID already belongs to a different payload. Reuse the original payload, or use a new ID for new work.'
      : error.code === 'peer/unavailable' && typeof reason === 'string' && reason.startsWith('receipt-')
        ? reason === 'receipt-write-failed' ? 'The host could not persist the input receipt.' : 'The host receipt store could not confirm this request.'
        : error.message
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.code === 'peer/target-unreachable'
          ? `REMOTE TARGET UNREACHABLE: ${error.endpoint}`
          : safeMessage,
        endpoint: error.endpoint,
        ...(error.code === 'peer/target-unreachable'
          ? { hint: 'the peer device did not answer; the caller owns backoff' }
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

/** Abortable delay used by the follow's reachability watchdog. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
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

/** Schema of one pending ask as `peer_asks` and a waiting_approval `peer_ask` result report it. */
function askItemSchema(): Record<string, unknown> {
  return {
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
      state: { type: 'string' },
      settlementReason: { type: 'string' },
      answeredBy: { type: 'object', additionalProperties: false, properties: { requestId: { type: 'string' }, payloadHash: { type: 'string' } } },
    },
    required: ['askId', 'kind', 'since'],
  }
}

/** One pending ask as a structured tool-output row. */
function askPayload(ask: PeerPendingAsk): Record<string, unknown> {
  return {
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
  }
}

function askLines(asks: Map<string, AskBridgeRecord>): string[] {
  return [...asks.values()].map(record => {
    const parts = [record.summary]
    if (record.decision !== undefined) parts.push(`decision=${record.decision}`)
    if (record.selected !== undefined && record.selected.length > 0) parts.push(`selected=${record.selected.join(',')}`)
    if (record.relay !== undefined) parts.push(`relay=${record.relay}`)
    if (record.answerRequestId !== undefined) parts.push(`answer requestId=${record.answerRequestId}`)
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
    `peer ${String(record.alias)} → ${String(host.device ?? '')} @ ${String(record.endpoint)}${host.instanceId === undefined ? '' : ` (instance ${String(host.instanceId)})`}`,
    `session ${String(record.sessionId)} (${String(record.exposure)}) bound=${String(record.bound)}`,
    `latch ${String(record.latch)} (${String(record.latchSource)}), descendants ${String(record.activeDescendants)}, model ${String(record.model)}`,
    ...(record.stopIntent === undefined ? [] : [stopIntentText(record.stopIntent)]),
    pendingAsks.length === 0 ? 'no pending asks' : `pending: ${pendingAsks.join('; ')}`,
  ].join('\n')
}

function stopIntentSchema(): Record<string, unknown> {
  const keys: Readonly<Record<keyof PeerStopIntent, 'number' | 'boolean' | 'string'>> = {
    requestedAt: 'number', keepInbox: 'boolean', turnState: 'string', activeDescendants: 'number', descendantsExact: 'boolean',
    inFlightTools: 'number', quiescence: 'string',
  }
  return { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(keys).map(([key, type]) => [key, { type }])) }
}

function stopIntentText(value: unknown): string {
  const stop = narrow(value)
  const tools = stop.inFlightTools === undefined ? '' : `, in-flight tools ${String(stop.inFlightTools)}`
  return `Stop ${stop.requestedAt === undefined ? 'not recorded' : 'requested'}; inbox kept; turn ${String(stop.turnState)}, descendants ${String(stop.activeDescendants)} (exact=${String(stop.descendantsExact)})${tools}; quiescence ${stop.quiescence === 'observed' ? 'observed, not proof of teardown' : 'unknown'}.`
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

/** One route's capability facts as a compact human line. */
function routeFacts(model: Record<string, unknown>): string {
  const known = (value: unknown): string => value === true ? 'yes' : value === 'unknown' ? 'unknown' : 'no'
  const facts = [
    `tools=${known(model.tools)}`,
    `vision=${known(model.vision)}`,
    `free=${known(model.zeroPrice)}`,
    `gated=${known(model.gated)}`,
    `trains=${String(model.trainsOnData ?? 'unknown')}`,
  ]
  if (typeof model.contextWindow === 'number') facts.push(`context=${String(model.contextWindow)}`)
  const efforts = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts as string[] : []
  if (efforts.length > 0) facts.push(`efforts=${efforts.join(',')}`)
  return facts.join(', ')
}

/** Render one string list, or a dash when empty. */
function listOrNone(value: unknown): string {
  const items = Array.isArray(value) ? value.map(item => String(item)) : []
  return items.length === 0 ? 'none' : items.join(', ')
}

function renderModels(value: unknown): string {
  const record = narrow(value)
  if (record.ok !== true) {
    const error = narrow(record.error)
    return `peer_models failed [${String(error.code ?? 'unknown')}]: ${String(error.message ?? '')}`
  }
  const chains = Array.isArray(record.chains) ? record.chains as Record<string, unknown>[] : []
  const models = Array.isArray(record.models) ? record.models as Record<string, unknown>[] : []
  const lines = [`peer ${String(record.alias)} — ${String(models.length)} route(s), ${String(chains.length)} chain(s)`]
  for (const chain of chains) {
    const members = Array.isArray(chain.members) ? chain.members as Record<string, unknown>[] : []
    const rendered = members.map(member => {
      const until = member.state === 'cooldown' && typeof member.cooldownUntil === 'number'
        ? ` until ${new Date(member.cooldownUntil).toISOString()}`
        : ''
      return `${String(member.provider)}/${String(member.model)} ${String(member.state)}${until}`
    })
    lines.push(`chain ${String(chain.id)}${chain.dynamic === true ? ' (dynamic)' : ''}: ${rendered.join('; ')}`)
  }
  if (models.length === 0 && chains.length === 0) lines.push('no route is selectable on this peer')
  for (const model of models) lines.push(`• ${String(model.provider)}/${String(model.model)} — ${routeFacts(model)}`)
  const selectable = narrow(record.selectable)
  lines.push([
    `selectable: chains ${listOrNone(selectable.chains)}`,
    `models ${listOrNone(selectable.models)}`,
    `switching ${String(selectable.allowSwitch ?? 'never')}`,
    selectable.requireZeroPrice === true ? 'free routes only' : '',
    selectable.requireNoTraining === true ? 'no-training routes only' : '',
    selectable.requireTools === true ? 'tool-calling routes only' : '',
  ].filter(part => part !== '').join(', '))
  if (typeof record.nextCursor === 'string') {
    lines.push(`more routes available — call again with cursor ${JSON.stringify(record.nextCursor)}`)
  }
  return lines.join('\n')
}

function renderSwitch(value: unknown): string {
  const record = narrow(value)
  if (record.ok !== true) {
    const error = narrow(record.error)
    return `peer_switch_model failed [${String(error.code ?? 'unknown')}]: ${String(error.message ?? '')}`
  }
  const selection = narrow(record.selection)
  const details = [
    selection.chain === undefined ? undefined : `chain ${String(selection.chain)}`,
    selection.reasoningEffort === undefined ? undefined : `effort ${String(selection.reasoningEffort)}`,
  ].filter((part): part is string => part !== undefined)
  const lines = [`switched ${String(record.alias)} to ${String(selection.provider)}/${String(selection.model)}${details.length === 0 ? '' : ` (${details.join(', ')})`}`]
  const previous = record.previous === undefined ? undefined : narrow(record.previous)
  if (previous !== undefined) {
    lines.push(`previous route ${String(previous.provider)}/${String(previous.model)}${previous.chain === undefined ? '' : ` (chain ${String(previous.chain)})`}`)
  }
  if (record.replayed === true) lines.push('this exact switch was already applied; the session is unchanged')
  else if (typeof record.note === 'string' && record.note !== '') lines.push(record.note)
  return lines.join('\n')
}

function renderAsk(value: unknown): string {
  const record = narrow(value)
  if (record.disposition !== undefined && (record.error !== undefined || record.disposition === 'cancelled_before_dispatch')) {
    const outcome = record.terminalState === undefined ? '' : ` (${String(record.terminalState)})`
    const create = record.createRequestId === undefined ? '' : `; create requestId ${String(record.createRequestId)}`
    const error = narrow(record.error)
    const detail = typeof error.message === 'string' ? ` ${error.message}` : ''
    return `Remote input disposition: ${String(record.disposition)}${outcome} — requestId ${String(record.requestId)}${create}.${detail} No automatic resend.`
  }
  // Only a structured failure carries `error`; settled non-completed results
  // (terminal cancelled/aborted/error) and superseded turns carry `terminal`
  // instead and must render their reason below, never as an empty failure.
  if (record.error !== undefined && record.ok !== true && record.pending !== true) {
    const error = narrow(record.error)
    if (error.code === 'peer/target-unreachable') {
      // `failureFrom` already prefixes the message; never double it here.
      const message = String(error.message ?? '')
      return message.startsWith('REMOTE TARGET UNREACHABLE')
        ? message
        : `REMOTE TARGET UNREACHABLE: ${message}`
    }
    return `peer_ask failed [${String(error.code ?? 'unknown')}]: ${String(error.message ?? '')}`
  }
  const lines: string[] = []
  if (record.status === 'waiting_approval') {
    const pendingAsks = Array.isArray(record.pendingAsks) ? record.pendingAsks as Record<string, unknown>[] : []
    lines.push(`REMOTE TURN WAITING FOR APPROVAL on ${String(record.alias)} (session ${String(record.sessionId)}).`)
    lines.push(renderAsks({ ok: true, alias: record.alias, latch: record.latch, asks: pendingAsks }))
    lines.push(`decide with peer_asks/peer_answer, then call peer_ask again with resume: ${JSON.stringify(String(record.requestId))} to follow the same turn to completion.`)
    if (Array.isArray(record.asks) && record.asks.length > 0) lines.push(`asks: ${(record.asks as string[]).join('; ')}`)
    return lines.join('\n')
  }
  if (record.status === 'host_unreachable') {
    lines.push(`REMOTE TARGET WENT SILENT (unreachable) mid-turn on ${String(record.alias)} (session ${String(record.sessionId)}, latch ${String(record.latch ?? 'unknown')}, cursor ${String(record.cursor ?? 0)}).`)
    lines.push(`It may be asleep; the remote turn was NOT cancelled and may resume if the host wakes — call peer_ask again with resume: ${JSON.stringify(String(record.requestId))} to re-follow.`)
    if (typeof record.answer === 'string' && record.answer !== '') lines.push(record.answer)
    if (Array.isArray(record.asks) && record.asks.length > 0) lines.push(`asks: ${(record.asks as string[]).join('; ')}`)
    return lines.join('\n')
  }
  if (record.pending === true) {
    lines.push(`REMOTE TURN STILL RUNNING on ${String(record.alias)} (${String(record.note ?? '')}).`)
    if (Array.isArray(record.asks) && record.asks.length > 0) lines.push(`asks: ${(record.asks as string[]).join('; ')}`)
    return lines.join('\n')
  }
  const remoteError = record.remoteError === undefined ? undefined : narrow(record.remoteError)
  if (record.terminal === 'cancelled' || record.terminal === 'aborted') {
    // A cancelled/aborted turn is not an infrastructure failure: report the
    // terminal reason, the session, and any answer text committed before the
    // cancellation instead of an empty `peer_ask failed` line.
    lines.push(`REMOTE TURN ${String(record.terminal).toUpperCase()} on ${String(record.alias)} (session ${String(record.sessionId)}, turn ${String(record.turn)}).`)
    if (remoteError !== undefined) lines.push(`remote error [${String(remoteError.code)}] ${String(remoteError.message)}`)
  } else if (record.terminal !== 'completed') {
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
  if (asks.length === 0) return record.instanceId === undefined ? `no pending asks on ${String(record.alias)} (latch ${String(record.latch)})` : `no retained asks on ${String(record.alias)}`
  return [
    `${String(asks.length)} ${record.instanceId === undefined ? 'pending' : 'retained'} ask(s) on ${String(record.alias)}:`,
    ...asks.map(ask => {
      if (ask.state !== undefined && ask.state !== 'pending') return `• ${String(ask.askId)} ${String(ask.kind)}: ${String(ask.state)}${ask.settlementReason === 'host-restarted' ? ' (worker restarted)' : ''} — not answerable`
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
  const retry = typeof record.requestId === 'string' ? ` (requestId ${record.requestId})` : ''
  if (record.ok === true) return `${record.settled === true ? 'Answer settled' : 'Answer not confirmed'} for ${String(record.askId)} on ${String(record.alias)} — ${String(record.note ?? '')}${retry}`
  const error = narrow(record.error)
  const detail = typeof record.note === 'string' && record.note !== '' ? record.note : String(error.message ?? '')
  return `peer_answer failed [${String(error.code ?? 'unknown')}] ${String(record.askId ?? '')}: ${detail}${retry}`
}
