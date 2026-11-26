/**
 * The serving side of the peer API: one narrow Typert namespace that maps
 * `peer.*` methods onto `session.*` operations behind a closed dispatch table.
 *
 * Everything a peer may do passes through `resolveTarget` first, so only
 * sessions named by the pairing table are audible; exposure filtering,
 * participant validation, the hop ceiling, and the orphan watchdog are applied
 * here, never in the caller (doc 69 §8, §9.2, §9.3, §10, §11, §12).
 *
 * @module @deepseek-ai/dsh-api-peer/host
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { Remote, RemoteError, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller'
// Type-only: the `ctx.tokenMeter` Context merge for the usage-seam probe.
import type {} from '@deepseek-ai/dsh-token-meter'
import type {
  SessionCreateRequest,
  SessionHistoryRecord,
  SessionPromptRequest,
  SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller/types'
import z from '@deepseek-ai/schemastery'
import { derivePromptDisposition, type PeerPromptDispositionResult } from './disposition.ts'
import { toPeerRecords } from './exposure.ts'
import {
  PEER_BUDGET_STOP_REASON,
  PeerLatchFold,
  readExecutionStateValue,
  readHostLatch,
  readModelSelectionProjection,
  readTokenUsageProjection,
  tokenBudgetOf,
  type HostLatchFacts,
  type PeerFoldEvent,
} from './latch.ts'
import {
  DEFAULT_BINDINGS_PATH,
  DEFAULT_PAIRINGS_PATH,
  DEFAULT_WATCHDOG_MS,
  PeerPairingsStore,
  dummyVerifyToken,
  parseBearerAuthorization,
  verifyPairingToken,
  type LoadedPeerPairings,
  type ResolvedPeerPairing,
} from './pairings.ts'
import {
  DEFAULT_INPUT_RECEIPTS_PATH,
  DEFAULT_RECEIPTS_PATH,
  PeerInputReceiptStore,
  PeerReceiptStore,
  createPayloadHash,
  deterministicCreateSessionId,
  inputReceiptKey,
  promptPayloadHash,
  receiptKey,
  type PeerInputReceipt,
} from './receipts.ts'
import {
  DEFAULT_EXPORT_ROOT,
  checkExportRootAvailable,
  ensureSessionExportDir,
  exportIoError,
  fetchSessionExport,
  listSessionExports,
} from './export-root.ts'
import {
  DEFAULT_JOB_BINDINGS_PATH,
  PeerJobBindingStore,
  requireValidJobId,
  validateCreateJob,
  validateExpiryWindow,
  type ValidatedCreateJob,
} from './job-bindings.ts'
import { clampTokenCeiling } from './routing-policy.ts'
import { HARNESS_VERSION } from './version.ts'
import { PeerAskRegistry } from './registry.ts'
import { BoundedFollow, FollowAdmission, followDefaults, untilAborted } from './follow.ts'
import {
  PEER_METHODS_DIGEST,
  PEER_SCHEMA_DIGEST,
  WIRE_PROTOCOL_VERSION,
} from './wire-schema.ts'
import type {
  PeerAlias,
  PeerAnswer,
  PeerAnswerRequest,
  PeerAnswerValue,
  PeerAskId,
  PeerAsksRequest,
  PeerAsksValue,
  PeerCancelRequest,
  PeerCancelValue,
  PeerCapability,
  PeerCreateDefaults,
  PeerCreateDisposition,
  PeerCreateRequest,
  PeerCreateValue,
  PeerDeviceName,
  PeerExecutionState,
  PeerExportFetchRequest,
  PeerExportFetchValue,
  PeerExportListRequest,
  PeerExportListValue,
  PeerFollowFrame,
  PeerFollowAck,
  PeerFollowRequest,
  PeerHandshakeRequest,
  PeerHandshakeValue,
  PeerJobBinding,
  PeerJobBindingsService,
  PeerJobUpdateRequest,
  PeerJobUpdateValue,
  PeerListEntry,
  PeerListRequest,
  PeerListValue,
  PeerModelSelection,
  PeerModelsRequest,
  PeerModelsValue,
  PeerPageRequest,
  PeerPageValue,
  PeerPairing,
  PeerPairingSummary,
  PeerParticipant,
  PeerParticipantAction,
  PeerProfileIdentityService,
  PeerProfileSummary,
  PeerPromptRequest,
  PeerPromptValue,
  PeerProtocolVersion,
  PeerReadyRequest,
  PeerReadyValue,
  PeerReceiptRequest,
  PeerReceiptValue,
  PeerRequestId,
  PeerRoutingPolicy,
  PeerRoutingService,
  PeerRoutingVerdict,
  PeerSelectModelRequest,
  PeerSelectModelValue,
  PeerStateRequest,
  PeerStateValue,
  PeerStopIntent,
  PeerTarget,
  PeerWaitQuiescentRequest,
  PeerWaitQuiescentValue,
} from './types.ts'

/** Incoming transport credential carried into peer RPC execution. */
export interface PeerAuthContext {
  readonly authorization?: string
}

/** Verified device identity bound after pairing credential check succeeds. */
export interface AuthenticatedPeerContext {
  readonly device: PeerDeviceName
  readonly via: 'bearer' | 'insecure'
  readonly alias?: PeerAlias
}

const peerAuthStorage = new AsyncLocalStorage<PeerAuthContext>()
const authenticatedContextStorage = new AsyncLocalStorage<AuthenticatedPeerContext>()
const STREAM_AUTHORIZATION_SYMBOL = Symbol.for('dsh.gateway.streamAuthorization')

function readAuthorizationHeader(): string | undefined {
  const peerStore = peerAuthStorage.getStore()
  if (peerStore !== undefined) return peerStore.authorization
  const candidate = (globalThis as Record<PropertyKey, unknown>)[STREAM_AUTHORIZATION_SYMBOL]
  if (candidate instanceof AsyncLocalStorage) {
    const value: unknown = candidate.getStore()
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/**
 * Run one peer operation with an explicit `Authorization` header value bound
 * to the async execution context. HTTP requests populate this automatically via
 * the `connection/request` waterfall; in-process callers and tests use it directly.
 * @param authorization - raw `Authorization` header (e.g. `Bearer <token>`), or `undefined`.
 * @param fn - callback executing the peer call.
 * @returns the callback's return value.
 */
export function withPeerAuth<T>(authorization: string | undefined, fn: () => T): T {
  return peerAuthStorage.run(authorization === undefined ? {} : { authorization }, fn)
}

/**
 * Read the authenticated peer device context bound by the currently executing
 * `PeerService` method, or `undefined` outside an authenticated peer call.
 * @returns the active authenticated context, if any.
 */
export function currentPeerAuth(): AuthenticatedPeerContext | undefined {
  return authenticatedContextStorage.getStore()
}

/** Peer protocol generation this build serves. */
export const PEER_PROTOCOL_VERSION: PeerProtocolVersion = WIRE_PROTOCOL_VERSION

/**
 * Version reported in the handshake when the deployment configures none. It is
 * the running package manifest's version, the runtime version plugin
 * compatibility reads through `getDshRuntimeVersion()`; a managed `dsh
 * --version` line adds the installer's release identity around it. The
 * handshake therefore identifies the shipped build without a drifting literal.
 */
export const DEFAULT_HARNESS_VERSION = HARNESS_VERSION

export { PEER_METHODS_DIGEST, PEER_SCHEMA_DIGEST }

const FOLLOW_SNAPSHOT_MAX_MESSAGES = 50

/**
 * Capability ledger: every `PeerCapability` the contract names, marked with
 * whether this build serves it. The `Record` key set is the union, so a new
 * union member fails the build here until it is explicitly marked; the
 * handshake advertises the `served` entries this deployment can actually
 * answer.
 *
 * `assistant-stream` is served: `peer.follow` yields
 * `assistant-stream` frames when the pairing's exposure is `debug` and the
 * caller opts in, and refuses the opt-in otherwise with `peer/forbidden`.
 * The routing three are served only while a `peerRouting` service is mounted
 * (see {@link ROUTING_CAPABILITIES}); `token-ceiling` is served only while the
 * host can read the durable usage projection (see
 * {@link TOKEN_CEILING_CAPABILITIES}); model-attribution is served by this
 * build's contract whenever a create carries it.
 */
export const PEER_CAPABILITY_LEDGER: Readonly<Record<PeerCapability, 'served' | 'planned'>> = {
  'state-latch': 'served',
  'derived-latch': 'served',
  'assistant-stream': 'served',
  'answer-routing': 'served',
  'runaway-ceiling': 'served',
  'session-create': 'served',
  'model-discovery': 'served',
  'model-routing-at-create': 'served',
  'model-switch': 'served',
  'model-attribution': 'served',
  'token-ceiling': 'served',
  'create-receipts': 'served',
  'prompt-receipts': 'served',
  'input-disposition': 'served',
  'fresh-only-create': 'served',
  'job-binding': 'served',
  'profile-identity': 'served',
  'ready': 'served',
  'export-root': 'served',
  'shape-digest': 'served',
  'durable-asks': 'served',
  'ask-idempotent-answer': 'served',
  'stop-intent': 'served',
  'cancel-drop-queued': 'served',
  'wait-quiescent': 'served',
  'bounded-follow': 'served',
  'follow-gap-frames': 'served',
}

/**
 * Capabilities that need a mounted `peerRouting` service at handshake time.
 * Without it the host refuses every routing request, so advertising these
 * would promise a switch it cannot serve.
 */
const ROUTING_CAPABILITIES: readonly PeerCapability[] = [
  'model-discovery',
  'model-routing-at-create',
  'model-switch',
]

/**
 * Capabilities that need the durable token-usage seam at handshake time.
 * Without it the host cannot report `budget.metered`, cannot enforce a
 * ceiling, and refuses a create that asks for one, so advertising
 * `token-ceiling` would promise a cost guard that silently does nothing.
 */
const TOKEN_CEILING_CAPABILITIES: readonly PeerCapability[] = ['token-ceiling']

/**
 * Capabilities that need the write-ahead input receipt store (`peer-input-receipts.json`)
 * to have opened cleanly at startup.
 */
const RECEIPT_CAPABILITIES: readonly PeerCapability[] = [
  'create-receipts',
  'prompt-receipts',
  'input-disposition',
  'fresh-only-create',
]

const JOB_BINDING_CAPABILITIES: readonly PeerCapability[] = ['job-binding']
const PROFILE_IDENTITY_CAPABILITIES: readonly PeerCapability[] = ['profile-identity']
const EXPORT_ROOT_CAPABILITIES: readonly PeerCapability[] = ['export-root']

/**
 * Capabilities this build serves. The handshake advertises this set minus the
 * members whose seam is not mounted on the current host.
 */
export const PEER_CAPABILITIES: readonly PeerCapability[] =
  (Object.keys(PEER_CAPABILITY_LEDGER) as PeerCapability[])
    .filter(capability => PEER_CAPABILITY_LEDGER[capability] === 'served')

/**
 * Capabilities the contract defines but this build does not serve yet. The
 * capability gate test requires every ledger entry to be served or planned,
 * and exactly one of the two.
 */
export const PLANNED_PEER_CAPABILITIES: readonly PeerCapability[] =
  (Object.keys(PEER_CAPABILITY_LEDGER) as PeerCapability[])
    .filter(capability => PEER_CAPABILITY_LEDGER[capability] === 'planned')

/** Peer API deployment policy. */
export interface Config {
  /** Ask journal; defaults to `peer-asks.json` beside the input receipts. */
  readonly asksPath?: string
  /** Maximum retained asks; settled records are evicted first. */
  readonly askLimit?: number
  /** Maximum UTF-8 serialized ask journal bytes. */
  readonly askMaxBytes?: number
  /** Maximum UTF-8 bytes in one pending ask record; oversized asks stay local. */
  readonly askRecordMaxBytes?: number
  /** Maximum milliseconds one `peer.waitQuiescent` may poll. */
  readonly waitQuiescentMaxMs?: number
  /** Poll interval in milliseconds for `peer.waitQuiescent`. */
  readonly waitQuiescentPollMs?: number
  /** Maximum pending and unacknowledged follow frames per generation. */
  readonly followQueueMaxItems?: number
  /** Maximum serialized UTF-8 bytes of pending and unacknowledged peer follow frames. */
  readonly followQueueMaxBytes?: number
  /** Maximum milliseconds to produce the opening follow frame. */
  readonly followOpenMs?: number
  /** Maximum milliseconds waiting for a frame or its consumption acknowledgement. */
  readonly followIdleMs?: number
  /** Absolute follow generation lifetime in milliseconds. */
  readonly followLifetimeMs?: number
  /** Maximum concurrent follow generations per authenticated alias. */
  readonly followMaxPerAlias?: number
  /** Maximum concurrent follow generations on this host. */
  readonly followMaxPerHost?: number
  /** Maximum admitted follow opens per alias in one rolling window. */
  readonly followOpensPerWindow?: number
  /** Length of the follow-open rate-limit window in milliseconds. */
  readonly followOpenWindowMs?: number
  /** Pairing document path; defaults to `~/.dsh/pairings.yaml`. */
  readonly pairingsPath?: string
  /** Created-session binding path; defaults to `~/.dsh/peer-state.json`. */
  readonly bindingsPath?: string
  /** Orphan watchdog in milliseconds; defaults to 15 minutes. */
  readonly watchdogMs?: number
  /** Harness version reported by `peer.handshake`; defaults to the running package manifest version. */
  readonly harnessVersion?: string
  /** Schema digest reported by `peer.handshake`. */
  readonly schemaDigest?: string
  /** Idempotency receipt document path; defaults to `~/.dsh/peer-receipts.json`. */
  readonly receiptsPath?: string
  /** Most `peer.selectModel` receipts retained; oldest evicted first. */
  readonly receiptLimit?: number
  /** Write-ahead receipt document path for `peer.create` and `peer.prompt`; defaults to `~/.dsh/peer-input-receipts.json`. */
  readonly inputReceiptsPath?: string
  /** Most `peer.create`/`peer.prompt` receipts retained; oldest evicted first. */
  readonly inputReceiptLimit?: number
  /** Maximum serialized UTF-8 byte size of the write-ahead receipt document. */
  readonly inputReceiptMaxBytes?: number
  /** Maximum code-unit length admitted for a caller-supplied `requestId`. */
  readonly requestIdMaxLength?: number
  /** `peer.models` page size when the caller names none. */
  readonly modelsLimit?: number
  /** Hard `peer.models` page cap, whatever the caller asks for. */
  readonly modelsLimitMax?: number
  /** Persisted worker job-binding path; defaults to `~/.dsh/peer-job-bindings.json` (or beside `bindingsPath`). */
  readonly jobBindingsPath?: string
  /** Maximum job bindings and update receipts retained; only receipts are evicted. */
  readonly jobBindingLimit?: number
  /** Maximum serialized UTF-8 byte size of the job-bindings document. */
  readonly jobBindingMaxBytes?: number
  /** Maximum length permitted for `jobId`. */
  readonly jobIdMaxLength?: number
  /** Maximum job TTL in milliseconds from creation or update time. */
  readonly jobMaxTtlMs?: number
  /** Maximum length permitted for capability names, tool names, MCP endpoint ids, and `credentialRef`. */
  readonly jobIdentifierMaxLength?: number
  /** Maximum entries in `job.capabilities`. */
  readonly jobCapabilitiesMax?: number
  /** Maximum entries in `job.allowedToolNames`. */
  readonly jobToolsMax?: number
  /** Parent directory holding `0700` per-session worker export directories; defaults under peer state dir. */
  readonly exportRoot?: string
  /** Maximum entries returned by `peer.exportList`. */
  readonly exportListMaxFiles?: number
  /** Maximum serialized UTF-8 metadata byte size of a `peer.exportList` response. */
  readonly exportListMaxBytes?: number
  /** Maximum directory entries inspected during one export listing, including skipped entries. */
  readonly exportListMaxScannedEntries?: number
  /** Maximum UTF-8 byte length of a requested export path. */
  readonly exportPathMaxBytes?: number
  /** Maximum byte size readable in one `peer.exportFetch` call (default 8 MiB). */
  readonly exportFetchMaxBytes?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Narrow device-to-device peer API surface (namespace `peer`). */
    peerService: PeerService
    /**
     * Optional routing seam the profile provides. The peer host reads it with
     * `ctx.get` at call time and never injects it, because a deployment without
     * a catalogue still serves the non-routing surface.
     */
    peerRouting: PeerRoutingService
    /** Persisted job-binding lookup and revocation seam registered by `PeerService`. */
    peerJobBindings: PeerJobBindingsService
    /** Optional profile identity attestation seam provided by the profile layer. */
    peerProfileIdentity: PeerProfileIdentityService
  }
}

interface ObservationView {
  readonly header: SessionObservation['header']
  readonly cursor: number
  readonly events: readonly PeerFoldEvent[]
  readonly projections: Readonly<Record<string, unknown>> | undefined
}

const askDefaults = { askLimit: 256, askMaxBytes: 1_048_576, askRecordMaxBytes: 16_384 }
const waitDefaults = { waitQuiescentMaxMs: 10_000, waitQuiescentPollMs: 100 }
const maxTimerDelayMs = 2_147_483_647

/**
 * Host service backing the generated `ctx.remote.peer` namespace.
 * @typert service peerService
 */
export class PeerService extends TypertRemoteService {
  static inject = ['agentDefaultModel', 'agents', 'sessionController', 'sessionQuery']

  static Config: z<Config> = z.object({
    asksPath: z.string(),
    askLimit: z.number().step(1).min(1).default(askDefaults.askLimit),
    askMaxBytes: z.number().step(1).min(1).default(askDefaults.askMaxBytes),
    askRecordMaxBytes: z.number().step(1).min(1).default(askDefaults.askRecordMaxBytes),
    waitQuiescentMaxMs: z.number().step(1).min(1).max(maxTimerDelayMs).default(waitDefaults.waitQuiescentMaxMs),
    waitQuiescentPollMs: z.number().step(1).min(1).max(maxTimerDelayMs).default(waitDefaults.waitQuiescentPollMs),
    followQueueMaxItems: z.number().step(1).min(1).default(followDefaults.followQueueMaxItems),
    followQueueMaxBytes: z.number().step(1).min(1).default(followDefaults.followQueueMaxBytes),
    followOpenMs: z.number().step(1).min(1).max(maxTimerDelayMs).default(followDefaults.followOpenMs),
    followIdleMs: z.number().step(1).min(1).max(maxTimerDelayMs).default(followDefaults.followIdleMs),
    followLifetimeMs: z.number().step(1).min(1).max(maxTimerDelayMs).default(followDefaults.followLifetimeMs),
    followMaxPerAlias: z.number().step(1).min(1).default(followDefaults.followMaxPerAlias),
    followMaxPerHost: z.number().step(1).min(1).default(followDefaults.followMaxPerHost),
    followOpensPerWindow: z.number().step(1).min(1).default(followDefaults.followOpensPerWindow),
    followOpenWindowMs: z.number().step(1).min(1).max(maxTimerDelayMs).default(followDefaults.followOpenWindowMs),
    pairingsPath: z.string(),
    bindingsPath: z.string(),
    watchdogMs: z.number().step(1).min(1).default(DEFAULT_WATCHDOG_MS),
    harnessVersion: z.string().default(DEFAULT_HARNESS_VERSION),
    schemaDigest: z.string().default(PEER_SCHEMA_DIGEST),
    receiptsPath: z.string(),
    receiptLimit: z.number().step(1).min(1).default(512),
    inputReceiptsPath: z.string(),
    inputReceiptLimit: z.number().step(1).min(1).default(1024),
    inputReceiptMaxBytes: z.number().step(1).min(1).default(1_048_576),
    requestIdMaxLength: z.number().step(1).min(1).default(256),
    modelsLimit: z.number().step(1).min(1).default(100),
    modelsLimitMax: z.number().step(1).min(1).default(500),
    jobBindingsPath: z.string(),
    jobBindingLimit: z.number().step(1).min(1).default(1024),
    jobBindingMaxBytes: z.number().step(1).min(1).default(1_048_576),
    jobIdMaxLength: z.number().step(1).min(1).default(128),
    jobMaxTtlMs: z.number().step(1).min(1).default(86_400_000),
    jobIdentifierMaxLength: z.number().step(1).min(1).default(128),
    jobCapabilitiesMax: z.number().step(1).min(1).default(64),
    jobToolsMax: z.number().step(1).min(1).default(256),
    exportRoot: z.string(),
    exportListMaxFiles: z.number().step(1).min(1).default(256),
    exportListMaxBytes: z.number().step(1).min(1).default(262_144),
    exportListMaxScannedEntries: z.number().step(1).min(1).default(4_096),
    exportPathMaxBytes: z.number().step(1).min(1).default(4_096),
    exportFetchMaxBytes: z.number().step(1).min(1).default(8_388_608),
  })

  /** Fresh host boot identity generated per `PeerService` instance. */
  readonly instanceId: string = randomUUID()
  /** Pairing table and created-session bindings. */
  readonly pairings: PeerPairingsStore
  /** Ask registry resolving the local-versus-peer answer race. */
  readonly registry: PeerAskRegistry
  /** Restart-safe idempotency receipts for `peer.selectModel`. */
  readonly receipts: PeerReceiptStore
  /** Restart-safe write-ahead receipts for `peer.create` and `peer.prompt`. */
  readonly inputReceipts: PeerInputReceiptStore
  /** Restart-safe non-secret worker job bindings and `peer.jobUpdate` receipts. */
  private readonly jobBindings: PeerJobBindingStore

  private readonly resolved: Required<Config>
  private readonly followAdmission: FollowAdmission
  private readonly lifetime = new AbortController()
  private readonly stopRequested = new Map<SessionId, number>()
  private readonly followers = new Map<SessionId, number>()
  private readonly peerActions = new Map<SessionId, PeerParticipantAction>()
  private readonly orphans = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly inputInFlight = new Map<string, Promise<unknown>>()
  /** Turn each Session was last stopped at for its ceiling; a later turn stops again. */
  private readonly budgetStopped = new Map<SessionId, number>()
  /** Single-flight guard for the ceiling observation, with the newest pending turn. */
  private readonly budgetChecks = new Map<SessionId, { again: boolean; turn: number; ceiling: number }>()
  /** In-memory reverse index of binding ceilings, rebuilt when the bindings change. */
  private ceilingIndex: {
    readonly bindings: LoadedPeerPairings['bindings']
    readonly ceilings: ReadonlyMap<SessionId, number>
  } | undefined

  /**
   * @param ctx - host context with agents, session query, and Session Controller active.
   * @param config - peer deployment policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'peerService', { namespace: 'peer' })
    const bindingsPath = config.bindingsPath ?? DEFAULT_BINDINGS_PATH
    const inputReceiptsPath = config.inputReceiptsPath
      ?? (config.bindingsPath === undefined
        ? DEFAULT_INPUT_RECEIPTS_PATH
        : join(dirname(bindingsPath), 'peer-input-receipts.json'))
    const jobBindingsPath = config.jobBindingsPath
      ?? (config.bindingsPath === undefined && config.inputReceiptsPath === undefined
        ? DEFAULT_JOB_BINDINGS_PATH
        : join(dirname(inputReceiptsPath), 'peer-job-bindings.json'))
    const exportRoot = config.exportRoot
      ?? (config.bindingsPath === undefined
        ? DEFAULT_EXPORT_ROOT
        : join(dirname(bindingsPath), 'peer-exports'))
    this.resolved = {
      asksPath: config.asksPath ?? join(dirname(inputReceiptsPath), 'peer-asks.json'),
      askLimit: config.askLimit ?? askDefaults.askLimit,
      askMaxBytes: config.askMaxBytes ?? askDefaults.askMaxBytes,
      askRecordMaxBytes: config.askRecordMaxBytes ?? askDefaults.askRecordMaxBytes,
      waitQuiescentMaxMs: config.waitQuiescentMaxMs ?? waitDefaults.waitQuiescentMaxMs,
      waitQuiescentPollMs: config.waitQuiescentPollMs ?? waitDefaults.waitQuiescentPollMs,
      followQueueMaxItems: config.followQueueMaxItems ?? followDefaults.followQueueMaxItems,
      followQueueMaxBytes: config.followQueueMaxBytes ?? followDefaults.followQueueMaxBytes,
      followOpenMs: config.followOpenMs ?? followDefaults.followOpenMs,
      followIdleMs: config.followIdleMs ?? followDefaults.followIdleMs,
      followLifetimeMs: config.followLifetimeMs ?? followDefaults.followLifetimeMs,
      followMaxPerAlias: config.followMaxPerAlias ?? followDefaults.followMaxPerAlias,
      followMaxPerHost: config.followMaxPerHost ?? followDefaults.followMaxPerHost,
      followOpensPerWindow: config.followOpensPerWindow ?? followDefaults.followOpensPerWindow,
      followOpenWindowMs: config.followOpenWindowMs ?? followDefaults.followOpenWindowMs,
      pairingsPath: config.pairingsPath ?? DEFAULT_PAIRINGS_PATH,
      bindingsPath,
      watchdogMs: config.watchdogMs ?? DEFAULT_WATCHDOG_MS,
      harnessVersion: config.harnessVersion ?? DEFAULT_HARNESS_VERSION,
      schemaDigest: config.schemaDigest ?? PEER_SCHEMA_DIGEST,
      receiptsPath: config.receiptsPath ?? DEFAULT_RECEIPTS_PATH,
      receiptLimit: config.receiptLimit ?? 512,
      inputReceiptsPath,
      inputReceiptLimit: config.inputReceiptLimit ?? 1024,
      inputReceiptMaxBytes: config.inputReceiptMaxBytes ?? 1_048_576,
      requestIdMaxLength: config.requestIdMaxLength ?? 256,
      modelsLimit: config.modelsLimit ?? 100,
      modelsLimitMax: config.modelsLimitMax ?? 500,
      jobBindingsPath,
      jobBindingLimit: config.jobBindingLimit ?? 1024,
      jobBindingMaxBytes: config.jobBindingMaxBytes ?? 1_048_576,
      jobIdMaxLength: config.jobIdMaxLength ?? 128,
      jobMaxTtlMs: config.jobMaxTtlMs ?? 86_400_000,
      jobIdentifierMaxLength: config.jobIdentifierMaxLength ?? 128,
      jobCapabilitiesMax: config.jobCapabilitiesMax ?? 64,
      jobToolsMax: config.jobToolsMax ?? 256,
      exportRoot,
      exportListMaxFiles: config.exportListMaxFiles ?? 256,
      exportListMaxBytes: config.exportListMaxBytes ?? 262_144,
      exportListMaxScannedEntries: config.exportListMaxScannedEntries ?? 4_096,
      exportPathMaxBytes: config.exportPathMaxBytes ?? 4_096,
      exportFetchMaxBytes: config.exportFetchMaxBytes ?? 8_388_608,
    }
    this.pairings = new PeerPairingsStore(this.resolved.pairingsPath, this.resolved.bindingsPath, {
      // A rejected reload keeps the previous valid snapshot; without this sink
      // the host would run a stale policy silently. The store dedupes by
      // diagnostic and strips parser code frames before the message arrives.
      onConfigError: (message) => { ctx.logger.warn(`peer-api: pairings reload rejected; previous snapshot kept: ${message}`) },
      onWarning: (message) => { ctx.logger.warn(message) },
    })
    this.receipts = new PeerReceiptStore(this.resolved.receiptsPath, this.resolved.receiptLimit)
    this.inputReceipts = new PeerInputReceiptStore(
      this.resolved.inputReceiptsPath,
      this.resolved.inputReceiptLimit,
      this.resolved.inputReceiptMaxBytes,
    )
    const openResult = this.inputReceipts.tryOpen()
    if (!openResult.ok) {
      ctx.logger.warn(`peer-api: input receipts disabled; store failed to open: ${String(openResult.error)}`)
    }
    this.jobBindings = new PeerJobBindingStore(
      this.resolved.jobBindingsPath,
      this.resolved.jobBindingLimit,
      this.resolved.jobBindingMaxBytes,
    )
    const jobOpenResult = this.jobBindings.tryOpen()
    if (!jobOpenResult.ok) {
      ctx.logger.warn(`peer-api: job bindings disabled; store failed to open: ${String(jobOpenResult.error)}`)
    }
    ctx.provide('peerJobBindings', {
      get: (sessionId: SessionId) => this.jobBindings.get(sessionId),
      revoke: (sessionId: SessionId) => this.jobBindings.revoke(sessionId),
    } satisfies PeerJobBindingsService)
    // Fail loud at load when the operator's pairing document is malformed.
    this.pairings.load()
    this.followAdmission = new FollowAdmission(this.resolved)
    this.registry = new PeerAskRegistry(ctx, this.pairings, {
      path: this.resolved.asksPath, maxCount: this.resolved.askLimit, maxBytes: this.resolved.askMaxBytes,
      maxRecordBytes: this.resolved.askRecordMaxBytes, maxRequestIdLength: this.resolved.requestIdMaxLength, instanceId: this.instanceId,
    })
    this.registry.install()
    ctx.effect(() => {
      const onConnectionRequest = (
        request: IncomingMessage,
        _response: ServerResponse,
        next: () => Promise<void>,
      ): Promise<void> => {
        if (!isPeerHttpUrl(request.url)) return next()
        const authorization = typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined
        return withPeerAuth(authorization, next)
      }
      return ctx.on('connection/request' as never, onConnectionRequest as never)
    }, 'peer-api: http auth context')
    ctx.effect(() => () => {
      this.lifetime.abort()
      for (const timer of this.orphans.values()) clearTimeout(timer)
      this.orphans.clear()
    }, 'peer-api: orphan watchdog')
    // The ceiling watcher is an effect like every other registration: it rides
    // this plugin's fiber and never survives its disposal.
    ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) })
    // Per-session ceiling bookkeeping must not outlive the Session or its
    // Agent: a detached agent cannot be stopped, and a later attach starts a
    // fresh turn sequence that must be allowed to stop again.
    ctx.on('agent/disposed', ({ agent }) => { this.forgetBudgetStop(agent.id) })
    ctx.on('session/disposed', (session) => {
      this.forgetBudgetStop(session.id)
      this.stopRequested.delete(session.id)
    })
  }

  /**
   * Negotiate protocol, capability, and pairing identity.
   * @param request - caller protocol, harness version, schema digest, and device name.
   * @returns the host identity, boot `instanceId`, capabilities, and authorized pairings for `request.device`.
   * @throws {@link RemoteError} `peer/forbidden` (`reason: 'unauthorized'`) when
   * credentials fail or `device` does not match the authenticated pairing,
   * `gateway/bad-request` when the request is absent or not an object,
   * `peer/version-skew` on protocol divergence.
   */
  @Remote('handshake')
  handshake(request: PeerHandshakeRequest): PeerHandshakeValue {
    const loaded = this.pairings.load()
    const { pairings: authorized, via } = this.authenticateAll(loaded)
    // SRC descriptors cannot see which parameters are required, so an empty
    // args object reaches the method as undefined; reject it as a clean input
    // error instead of the `request.protocolVersion` TypeError it would raise.
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      throw new RemoteError(
        'gateway/bad-request',
        'handshake requires a request object with protocolVersion, harnessVersion, schemaDigest, and device',
        {},
      )
    }
    if (request.protocolVersion !== PEER_PROTOCOL_VERSION) {
      throw new RemoteError(
        'peer/version-skew',
        `peer protocol ${String(request.protocolVersion)} is not supported`,
        { expected: PEER_PROTOCOL_VERSION, received: request.protocolVersion },
      )
    }
    if (typeof request.device !== 'string' || request.device.length === 0) {
      throw new RemoteError('gateway/bad-request', 'handshake device must be a non-empty string', {})
    }
    const forDevice = authorized.filter(pairing => pairing.peer === request.device)
    if (forDevice.length === 0) throw unauthorizedError()
    return authenticatedContextStorage.run({ device: request.device, via }, () => ({
      protocolVersion: PEER_PROTOCOL_VERSION,
      harnessVersion: this.resolved.harnessVersion,
      schemaDigest: this.resolved.schemaDigest,
      methodsDigest: PEER_METHODS_DIGEST,
      hostDevice: loaded.device,
      instanceId: this.instanceId,
      capabilities: [...this.advertisedCapabilities()],
      pairings: forDevice.map(pairing => this.describePairing(pairing)),
    }))
  }

  /**
   * Read the aggregate execution state for one paired Session. The host's
   * `session.executionState` latch wins when it answers (`source:'host-latch'`);
   * a cold Session or a host without that call keeps the derived fold.
   * @param request - resolved target.
   * @returns latch, descendants, pending asks, model selection, and cursor.
   */
  @Remote('state')
  async state(request: PeerStateRequest): Promise<PeerStateValue> {
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      this.authenticateAll(this.pairings.load())
      throw new RemoteError('gateway/bad-request', 'state requires a request object', {})
    }
    const { resolved, auth } = this.authenticateTarget(request.target)
    return authenticatedContextStorage.run(auth, () => this.stateOf(resolved))
  }

  private async stateOf(resolved: ResolvedPeerPairing, signal?: AbortSignal): Promise<PeerStateValue> {
    const observation = await this.observe(resolved.sessionId, signal)
    const fold = this.foldOf(resolved.sessionId, observation)
    const hostLatch = this.hostLatchOf(resolved.sessionId) ?? readHostLatch(observation.projections)
    return {
      target: this.pairings.describe(resolved),
      state: this.snapshotState(resolved, fold, hostLatch, observation.projections),
      cursor: brandNumber<SessionSeq>(observation.cursor),
    }
  }

  /**
   * Read retained pending and settled asks for an authenticated binding.
   * @param request - alias and optional current or retired Session id.
   * @returns retained ask records and the current host identity.
   */
  @Remote('asks')
  asks(request: PeerAsksRequest): PeerAsksValue {
    const { resolved, auth } = this.authenticateTarget({ kind: 'alias', alias: this.requiredAlias(request, 'asks') })
    const rawSessionId: unknown = request.sessionId
    if (rawSessionId !== undefined && (typeof rawSessionId !== 'string' || rawSessionId.length === 0)) {
      throw new RemoteError('gateway/bad-request', 'asks sessionId must be a non-empty string', {})
    }
    const sessionId = request.sessionId ?? resolved.sessionId
    if (sessionId !== resolved.sessionId && !this.pairings.isSessionBoundToAlias(resolved.pairing.alias, sessionId)) {
      throw unauthorizedError()
    }
    return authenticatedContextStorage.run(auth, () => ({
      instanceId: this.instanceId, asks: this.registry.list({ ...resolved, sessionId }),
    }))
  }

  private requiredAlias(request: unknown, method: string): string {
    if (typeof request === 'object' && request !== null && 'alias' in request && typeof request.alias === 'string') return request.alias
    this.authenticateAll(this.pairings.load())
    throw new RemoteError('gateway/bad-request', `${method} requires an alias`, {})
  }

  /**
   * Poll one binding for an observed quiet state; never certify descendant teardown.
   * @param request - alias and bounded polling timeout in milliseconds.
   * @param signal - carrier cancellation.
   * @returns last observed state and whether the deadline elapsed.
   */
  @Remote('waitQuiescent')
  async waitQuiescent(request: PeerWaitQuiescentRequest, signal: AbortSignal): Promise<PeerWaitQuiescentValue> {
    const { resolved, auth } = this.authenticateTarget({ kind: 'alias', alias: this.requiredAlias(request, 'waitQuiescent') })
    const { timeoutMs } = request
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.resolved.waitQuiescentMaxMs) {
      throw new RemoteError('gateway/bad-request', 'waitQuiescent timeoutMs is outside the configured bound', {})
    }
    const deadline = new AbortController()
    const cancel = AbortSignal.any([signal, this.lifetime.signal, deadline.signal])
    const timer = setTimeout(() => { deadline.abort() }, timeoutMs).unref()
    let last: PeerStateValue | undefined
    try {
      while (!cancel.aborted) {
        const current = this.authenticateTarget({ kind: 'alias', alias: request.alias }).resolved
        if (current.sessionId !== resolved.sessionId || current.pairing.peer !== resolved.pairing.peer) {
          throw new RemoteError('peer/conflict', 'waitQuiescent alias changed binding', { reason: 'stale-generation' })
        }
        last = await untilAborted(authenticatedContextStorage.run(auth, () => this.stateOf(current, cancel)), cancel)
        if (last.state.stopIntent?.quiescence === 'observed') return { observation: 'observed', timedOut: false, last }
        await sleep(this.resolved.waitQuiescentPollMs, undefined, { signal: cancel, ref: false })
      }
    } catch (error) {
      if (!deadline.signal.aborted || signal.aborted || this.lifetime.signal.aborted) throw error
    } finally {
      clearTimeout(timer)
    }
    return { observation: 'observed', timedOut: true, ...(last === undefined ? {} : { last }) }
  }

  /**
   * List the pairings this caller is authorized to see with a cheap live
   * summary. Discovery is read-only and reports each pairing at its own
   * exposure; a supplied target authenticates and resolves through the same
   * pairing gate as every other call.
   * @param request - optional target narrowing the answer to one pairing.
   * @returns the host device and one row per authorized pairing.
   * @throws {@link RemoteError} `peer/forbidden` (`reason: 'unauthorized'`) on
   * invalid credentials; `peer/not-paired` when an authenticated unbound alias
   * is targeted.
   */
  @Remote('list')
  list(request?: PeerListRequest): PeerListValue {
    const loaded = this.pairings.load()
    if (request?.target !== undefined) {
      const { resolved, auth } = this.authenticateTarget(request.target)
      return authenticatedContextStorage.run(auth, () => ({
        hostDevice: loaded.device,
        pairings: [this.describeListEntry(resolved.pairing)],
      }))
    }
    const { pairings: authorized, via } = this.authenticateAll(loaded)
    const first = authorized[0]
    const listAuth: AuthenticatedPeerContext = {
      device: first?.peer ?? loaded.device,
      via,
    }
    return authenticatedContextStorage.run(listAuth, () => ({
      hostDevice: loaded.device,
      pairings: authorized.map(pairing => this.describeListEntry(pairing)),
    }))
  }

  /** One `peer.list` row: binding facts plus the host latch when that read is cheap. */
  private describeListEntry(pairing: PeerPairing): PeerListEntry {
    const base = {
      alias: pairing.alias,
      peer: pairing.peer,
      exposure: pairing.exposure,
      ...(pairing.remoteSessionId === undefined ? {} : { remoteSessionId: pairing.remoteSessionId }),
    }
    const resolved = this.pairings.resolve({ kind: 'alias', alias: pairing.alias })
    if (resolved === undefined) {
      return { ...base, bound: false, summary: 'not bound to a session' }
    }
    const latch = this.hostLatchOf(resolved.sessionId)
    if (latch === undefined) {
      // A cold Session has no attached execution state; the row still reports
      // the binding without paying for a durable scan.
      return {
        ...base,
        bound: true,
        sessionId: resolved.sessionId,
        summary: 'bound; latch unavailable (cold session)',
      }
    }
    const pendingAsks = this.registry.pendingFor(resolved.sessionId, resolved).length
    const lastActivity = latch.lastParticipantAction?.at
      ?? latch.lastTurnEnd?.at
      ?? (latch.latch === 'idle' ? undefined : latch.since)
    return {
      ...base,
      bound: true,
      sessionId: resolved.sessionId,
      latch: latch.latch,
      ...(lastActivity === undefined ? {} : { lastActivity }),
      summary: latchSummary(latch, pendingAsks),
    }
  }

  /**
   * Create or explicitly adopt a Session and bind it to a pairing alias.
   *
   * Pairing `create.*` values (`workspaceId`, `cwd`, `agentPreset`,
   * `allowAgentPresets`) act as upper-bound limits: callers may narrow `cwd`
   * within the pinned directory or select a preset within the allowed set, and
   * any attempt to widen is refused with `peer/forbidden`. Adoption is
   * restricted to sessions already bound to or created by this alias (`reason:
   * 'session-adoption'`).
   *
   * When `requestId` is supplied, the host derives a deterministic session id
   * from `(alias, requestId)` when `sessionId` is omitted, writes a write-ahead
   * payload-bound receipt before creating/adopting, replays identical retries
   * with `replayed: true`, and rejects changed payloads under the same id with
   * `peer/conflict` (`reason: 'request-id-reuse'`). If the write-ahead receipt
   * cannot be persisted, creation is refused with `peer/unavailable` before any
   * session or binding side effect.
   *
   * A pairing with a `routing` policy is authoritative: every create (new or
   * adopt) must name a route, the policy is evaluated before any session or
   * selection exists, and the applied selection is the verdict's `selection`
   * (a chain-only request is resolved there). Without a policy the legacy
   * behavior is unchanged and `allowModelChange` gates adopt-time routing.
   * @param request - pairing alias, participant, optional requestId/session, routing, and token ceiling.
   * @returns the resolved target, whether a new Session was created, and receipt metadata when `requestId` was supplied.
   * @throws {@link RemoteError} `peer/not-paired`; `peer/forbidden` for auth,
   * scope limits (`workspace-not-allowed`, `cwd-not-allowed`,
   * `preset-not-allowed`, `session-adoption`), policy refusal, a missing
   * routing service, a ceiling on a host without the usage seam (reason
   * `budget-unmetered`), or an adopt without `allowModelChange`;
   * `peer/conflict` (`reason: 'request-id-reuse'`); `peer/unavailable` when
   * receipt persistence fails; `peer/not-found` for a deeper create failure.
   */
  @Remote('create')
  async create(request: PeerCreateRequest): Promise<PeerCreateValue> {
    const loaded = this.pairings.load()
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      this.authenticateAll(loaded)
      throw new RemoteError('gateway/bad-request', 'create requires a request object', {})
    }
    const alias = typeof request.alias === 'string' ? request.alias : undefined
    const pairing = alias === undefined
      ? undefined
      : loaded.pairings.find(candidate => candidate.alias === alias)
    const auth = this.authenticatePairing(pairing)
    return authenticatedContextStorage.run(auth, async () => {
      if (pairing === undefined || pairing.create === undefined) {
        throw new RemoteError('peer/not-paired', `alias ${JSON.stringify(request.alias)} exposes no create binding`, {
          alias: request.alias,
        })
      }
      const participant = requireParticipant(request.participant, auth.device)
      const freshOnly = pairing.create.freshOnly === true || pairing.worker !== undefined
      if (pairing.worker !== undefined && auth.via !== 'bearer') throw unauthorizedError()
      if (freshOnly && request.sessionId !== undefined) {
        throw new RemoteError(
          'peer/forbidden',
          'freshOnly pairing forbids caller-supplied sessionId',
          { reason: 'fresh-only-create' },
        )
      }
      if (freshOnly && request.requestId === undefined) {
        throw new RemoteError(
          'peer/forbidden',
          'freshOnly pairing requires requestId on peer.create',
          { reason: 'request-id-required' },
        )
      }
      const requestId = request.requestId === undefined
        ? undefined
        : requireRequestId(request.requestId, 'create', this.resolved.requestIdMaxLength)
      if (request.job !== undefined && pairing.worker === undefined) {
        throw new RemoteError(
          'peer/forbidden',
          'pairing has no worker policy for job binding',
          { reason: 'worker-policy-required' },
        )
      }
      if (pairing.worker !== undefined && request.job === undefined) {
        throw routingForbidden('job-required', 'worker pairing requires a job binding')
      }
      if (request.job !== undefined && !this.jobBindings.isAvailable()) {
        throw receiptUnavailableError('job-bindings-unavailable', 'job bindings are unavailable on this host')
      }
      if (requestId !== undefined && this.inputReceipts.isAvailable()) {
        const prior = this.inputReceipts.get('create', pairing.alias, requestId)
        if (prior !== undefined) {
          if (request.job !== undefined && pairing.worker !== undefined) {
            validateCreateJob(request.job, pairing.worker, this.jobValidationBounds(), Date.now(), {
              checkExpiryWindow: false, checkPolicy: false,
            })
          }
          if (prior.payloadHash !== createPayloadHash(pairing.alias, request)) {
            throw new RemoteError('peer/conflict', 'create requestId already has another payload', { reason: 'request-id-reuse' })
          }
        }
      }
      const validatedJob = request.job === undefined || pairing.worker === undefined
        ? undefined
        : validateCreateJob(request.job, pairing.worker, this.jobValidationBounds(), Date.now(), {
          checkExpiryWindow: false,
        })
      const createScope = resolveCreateScope(pairing.create, request)
      const policy = pairing.routing
      const routingRequested = request.provider !== undefined
        || request.model !== undefined
        || request.chain !== undefined
        || request.reasoningEffort !== undefined
      // Policy decisions run before any create/adopt/select: a refusal must leave
      // no Session and no selection event behind.
      const policySelection = policy === undefined
        ? undefined
        : await this.evaluateCreateRouting(policy, request)
      // A ceiling that is not a positive safe integer would disable enforcement
      // (negative, NaN) or make the stored binding unreadable on the next load.
      if (request.maxTotalTokens !== undefined
        && (!Number.isSafeInteger(request.maxTotalTokens) || request.maxTotalTokens <= 0)) {
        throw new RemoteError('gateway/bad-request', 'maxTotalTokens must be a positive integer', {})
      }
      if (request.maxTotalTokens !== undefined && pairing.worker !== undefined
        && (pairing.worker.maxLimits?.maxTotalTokens === undefined
          || request.maxTotalTokens > pairing.worker.maxLimits.maxTotalTokens)) {
        throw new RemoteError(
          'peer/forbidden',
          'maxTotalTokens exceeds or has no pairing worker policy limit',
          { reason: 'job-limit-exceeded', denied: 'maxTotalTokens' },
        )
      }
      if (request.maxTotalTokens !== undefined
        && request.job?.limits.maxTotalTokens !== undefined
        && request.maxTotalTokens !== request.job.limits.maxTotalTokens) {
        throw new RemoteError(
          'gateway/bad-request',
          'request.maxTotalTokens and job.limits.maxTotalTokens must match when both are provided',
          {},
        )
      }
      const workerTokenDefault = pairing.worker?.maxLimits?.maxTotalTokens
      const requestedCeiling = request.maxTotalTokens ?? request.job?.limits.maxTotalTokens
        ?? (workerTokenDefault === undefined ? undefined : Math.min(workerTokenDefault, policy?.maxTotalTokens ?? workerTokenDefault))
      const clamped = clampTokenCeiling(policy, requestedCeiling)
      if (clamped === 'over') {
        throw routingForbidden(
          'budget',
          `maxTotalTokens exceeds the pairing ceiling of ${String(policy?.maxTotalTokens)}`,
          String(requestedCeiling),
        )
      }
      const ceiling = clamped
      // A ceiling without the usage seam would record a guard that can never
      // read its own spend. Refuse before any Session exists so a caller never
      // believes it capped the worker.
      if (ceiling !== undefined && !this.hasTokenUsageSeam()) {
        throw routingForbidden(
          'budget-unmetered',
          'this host cannot read token usage, so it cannot enforce a token ceiling',
          String(ceiling),
        )
      }
      if (requestId === undefined) {
        return this.executeUnkeyedCreate(
          pairing,
          participant,
          request,
          createScope,
          policySelection,
          routingRequested,
          ceiling,
        )
      }
      if (!this.inputReceipts.isAvailable()) {
        throw receiptUnavailableError('receipt-store-unavailable', 'create receipts are unavailable on this host')
      }
      return this.serializeInputOperation(inputReceiptKey('create', pairing.alias, requestId), () =>
        this.executeKeyedCreate(
          pairing,
          participant,
          brandString<PeerRequestId>(requestId),
          request,
          createScope,
          policySelection,
          routingRequested,
          ceiling,
          validatedJob,
        ))
    })
  }

  private async executeUnkeyedCreate(
    pairing: PeerPairing,
    participant: PeerParticipant,
    request: PeerCreateRequest,
    createScope: { readonly workspaceId?: string; readonly cwd?: string; readonly agentPreset?: string },
    policySelection: PeerModelSelection | undefined,
    routingRequested: boolean,
    ceiling: number | undefined,
  ): Promise<PeerCreateValue> {
    let created = true
    let sessionId = request.sessionId
    try {
      if (sessionId !== undefined && await this.sessionExists(sessionId)) {
        if (!this.pairings.isSessionBoundToAlias(pairing.alias, sessionId)) {
          throw routingForbidden(
            'session-adoption',
            'this alias may only adopt sessions already bound to or created by it',
            sessionId,
          )
        }
        created = false
        if (pairing.routing === undefined && routingRequested && pairing.allowModelChange !== true) {
          throw new RemoteError(
            'peer/forbidden',
            'adopting an existing Session may not change its routing without allowModelChange',
            { reason: 'model-change' },
          )
        }
      } else {
        if (sessionId !== undefined && this.pairings.isSessionBoundToOtherAlias(pairing.alias, sessionId)) {
          throw routingForbidden(
            'session-adoption',
            'requested sessionId belongs to another pairing alias',
            sessionId,
          )
        }
        if (sessionId !== undefined && !this.pairings.isSessionBoundToAlias(pairing.alias, sessionId)) {
          throw routingForbidden(
            'session-adoption',
            'explicit sessionId adoption requires a session bound to or created by this alias',
            sessionId,
          )
        }
        const createRequest: SessionCreateRequest = {
          ...createScope.workspaceId === undefined
            ? {}
            : { workspaceId: brandString<NonNullable<SessionCreateRequest['workspaceId']>>(createScope.workspaceId) },
          ...createScope.cwd === undefined ? {} : { cwd: createScope.cwd },
          ...createScope.agentPreset === undefined ? {} : { agentPreset: createScope.agentPreset },
        }
        sessionId = (await this.ctx.sessionController.create(createRequest)).sessionId
      }
      if (policySelection !== undefined) {
        await this.applySelection(sessionId, policySelection)
      } else if (routingRequested) {
        await this.applySessionRouting(sessionId, request)
      }
    } catch (error) {
      throw createFailure(error, pairing.alias)
    }
    await this.pairings.bind(
      pairing.alias,
      pairing.peer,
      sessionId,
      ceiling === undefined ? {} : { maxTotalTokens: ceiling },
    )
    this.recordPeerAction(sessionId, { action: 'create', actor: participant, at: Date.now() })
    return {
      target: {
        device: pairing.peer,
        sessionId,
        exposure: pairing.exposure,
        alias: pairing.alias,
      },
      created,
    }
  }

  private async executeKeyedCreate(
    pairing: PeerPairing,
    participant: PeerParticipant,
    requestId: PeerRequestId,
    request: PeerCreateRequest,
    createScope: { readonly workspaceId?: string; readonly cwd?: string; readonly agentPreset?: string },
    policySelection: PeerModelSelection | undefined,
    routingRequested: boolean,
    ceiling: number | undefined,
    validatedJob: ValidatedCreateJob | undefined,
  ): Promise<PeerCreateValue> {
    const freshOnly = pairing.create?.freshOnly === true || pairing.worker !== undefined
    const payloadHash = createPayloadHash(pairing.alias, request)
    const existing = this.inputReceipts.get('create', pairing.alias, requestId)
    if (existing !== undefined) {
      if (existing.payloadHash !== payloadHash) {
        throw new RemoteError(
          'peer/conflict',
          `requestId ${JSON.stringify(requestId)} was already used with a different payload`,
          { reason: 'request-id-reuse' },
        )
      }
      if (existing.phase === 'finalized') {
        if (validatedJob !== undefined && this.jobBindings.get(existing.sessionId)?.jobId !== validatedJob.jobId) {
          throw receiptUnavailableError('job-binding-missing', 'worker create receipt has no matching job binding')
        }
        const profile = pairing.worker === undefined ? undefined : this.describeWorkerProfileOrThrow(existing.sessionId)
        if (existing.profile !== undefined && (profile?.hash !== existing.profile.hash
          || profile.presetId !== existing.profile.presetId)) {
          throw receiptUnavailableError('profile-identity-changed', 'worker profile differs from the create receipt')
        }
        return {
          target: {
            device: pairing.peer,
            sessionId: existing.sessionId,
            exposure: pairing.exposure,
            alias: pairing.alias,
          },
          created: existing.created ?? true,
          replayed: true,
          payloadHash: existing.payloadHash,
          instanceId: existing.instanceId,
          ...(profile === undefined ? {} : { profile }),
        }
      }
      // Crashed after write-ahead prepare: reconcile against the session store.
      if (this.pairings.isSessionBoundToOtherAlias(pairing.alias, existing.sessionId)) {
        throw routingForbidden(
          'session-adoption',
          'requested sessionId belongs to another pairing alias',
          existing.sessionId,
        )
      }
      const exists = await this.sessionExists(existing.sessionId)
      if (exists) {
        if (freshOnly && !this.pairings.isSessionBoundToAlias(pairing.alias, existing.sessionId)) {
          throw receiptUnavailableError('worker-create-unsettled', 'prepared receipt cannot prove ownership of an existing session')
        }
        if (validatedJob !== undefined && (this.jobBindings.get(existing.sessionId)?.jobId !== validatedJob.jobId
          || !this.pairings.isSessionBoundToAlias(pairing.alias, existing.sessionId))) {
          throw receiptUnavailableError('worker-create-unsettled', 'prepared worker receipt cannot prove a completed create')
        }
        if (request.sessionId !== undefined && !this.pairings.isSessionBoundToAlias(pairing.alias, existing.sessionId)) {
          throw routingForbidden(
            'session-adoption',
            'this alias may only adopt sessions already bound to or created by it',
            existing.sessionId,
          )
        }
        const created = request.sessionId === undefined
        let profile: PeerProfileSummary | undefined
        try {
          if (policySelection !== undefined) {
            const current = await this.currentSelectionOf(existing.sessionId)
            if (!sameModelSelection(current, policySelection)) {
              await this.applySelection(existing.sessionId, policySelection)
            }
          } else if (routingRequested) {
            await this.applySessionRouting(existing.sessionId, request)
          }
          if (pairing.worker !== undefined) {
            profile = this.describeWorkerProfileOrThrow(existing.sessionId)
            ensureSessionExportDir(this.resolved.exportRoot, existing.sessionId)
          }
        } catch (error) {
          throw createFailure(error, pairing.alias)
        }
        if (!this.pairings.isSessionBoundToAlias(pairing.alias, existing.sessionId)) {
          await this.pairings.bind(
            pairing.alias,
            pairing.peer,
            existing.sessionId,
            ceiling === undefined ? {} : { maxTotalTokens: ceiling },
          )
        }
        await this.finalizeInputReceipt({
          kind: 'create',
          alias: pairing.alias,
          requestId,
          payloadHash,
          instanceId: existing.instanceId,
          sessionId: existing.sessionId,
          created,
          ...(profile === undefined ? {} : { profile }),
        })
        return {
          target: {
            device: pairing.peer,
            sessionId: existing.sessionId,
            exposure: pairing.exposure,
            alias: pairing.alias,
          },
          created,
          replayed: true,
          payloadHash: existing.payloadHash,
          instanceId: existing.instanceId,
          ...(profile === undefined ? {} : { profile }),
        }
      }
    }

    if (validatedJob !== undefined) {
      validateExpiryWindow(validatedJob.expiresAt, Date.now(), this.resolved.jobMaxTtlMs)
      const existingJob = this.jobBindings.findByAliasAndJobId(pairing.alias, validatedJob.jobId)
      if (existingJob !== undefined && existingJob.sessionId !== existing?.sessionId) {
        throw new RemoteError(
          'peer/conflict',
          `jobId ${JSON.stringify(validatedJob.jobId)} is already bound`,
          { reason: 'job-id-reuse' },
        )
      }
    }
    if (pairing.worker !== undefined) {
      this.requireProfileIdentityService()
    }

    let created = true
    let targetSessionId: SessionId
    if (request.sessionId !== undefined) {
      if (this.pairings.isSessionBoundToOtherAlias(pairing.alias, request.sessionId)) {
        throw routingForbidden(
          'session-adoption',
          'requested sessionId belongs to another pairing alias',
          request.sessionId,
        )
      }
      if (!await this.sessionExists(request.sessionId)
        || !this.pairings.isSessionBoundToAlias(pairing.alias, request.sessionId)) {
        throw routingForbidden(
          'session-adoption',
          'this alias may only adopt sessions already bound to or created by it',
          request.sessionId,
        )
      }
      if (pairing.routing === undefined && routingRequested && pairing.allowModelChange !== true) {
        throw new RemoteError(
          'peer/forbidden',
          'adopting an existing Session may not change its routing without allowModelChange',
          { reason: 'model-change' },
        )
      }
      created = false
      targetSessionId = request.sessionId
    } else {
      targetSessionId = existing?.sessionId ?? deterministicCreateSessionId(pairing.alias, requestId)
      if (this.pairings.isSessionBoundToOtherAlias(pairing.alias, targetSessionId)) {
        throw routingForbidden(
          'session-adoption',
          'deterministic sessionId belongs to another pairing alias',
          targetSessionId,
        )
      }
      if (await this.sessionExists(targetSessionId)) {
        if (freshOnly) {
          throw new RemoteError(
            'peer/forbidden',
            'freshOnly pairing forbids reusing an existing session',
            { reason: 'fresh-only-create' },
          )
        }
        if (!this.pairings.isSessionBoundToAlias(pairing.alias, targetSessionId)) {
          throw routingForbidden(
            'session-adoption',
            'deterministic sessionId collides with an unbound session',
            targetSessionId,
          )
        }
        created = false
      } else if (freshOnly && this.pairings.isSessionBoundToAlias(pairing.alias, targetSessionId)) {
        throw new RemoteError(
          'peer/forbidden',
          'freshOnly pairing forbids reusing a bound session',
          { reason: 'fresh-only-create' },
        )
      }
    }

    try {
      await this.inputReceipts.prepare({
        kind: 'create',
        alias: pairing.alias,
        requestId,
        payloadHash,
        instanceId: this.instanceId,
        sessionId: targetSessionId,
        acceptedAt: Date.now(),
      })
    } catch (error) {
      throw receiptUnavailableError(
        'receipt-write-failed',
        `unable to persist peer.create receipt: ${error instanceof Error ? error.message : String(error)}`,
        error,
      )
    }

    let profile: PeerProfileSummary | undefined
    let sessionCreatedNow = false
    let jobPersisted = false
    try {
      if (created) {
        const createRequest: SessionCreateRequest = {
          sessionId: targetSessionId,
          ...createScope.workspaceId === undefined
            ? {}
            : { workspaceId: brandString<NonNullable<SessionCreateRequest['workspaceId']>>(createScope.workspaceId) },
          ...createScope.cwd === undefined ? {} : { cwd: createScope.cwd },
          ...createScope.agentPreset === undefined ? {} : { agentPreset: createScope.agentPreset },
        }
        targetSessionId = (await this.ctx.sessionController.create(createRequest)).sessionId
        sessionCreatedNow = true
      }
      if (policySelection !== undefined) {
        await this.applySelection(targetSessionId, policySelection)
      } else if (routingRequested) {
        await this.applySessionRouting(targetSessionId, request)
      }
      if (pairing.worker !== undefined) {
        ensureSessionExportDir(this.resolved.exportRoot, targetSessionId)
      }
      if (validatedJob !== undefined) {
        await this.persistJobBinding(pairing.alias, targetSessionId, validatedJob, ceiling)
        jobPersisted = true
        profile = this.describeWorkerProfileOrThrow(targetSessionId)
      }
    } catch (error) {
      if (sessionCreatedNow && validatedJob !== undefined) {
        if (jobPersisted) {
          await this.jobBindings.revoke(targetSessionId).catch(() => {
            this.ctx.logger.warn('peer-api: unable to persist revocation of a failed worker create')
          })
        }
        await this.disposeCreatedSession(targetSessionId)
      }
      if (!created || (sessionCreatedNow && validatedJob !== undefined) || !(await this.sessionExistsSafe(targetSessionId))) {
        await this.inputReceipts.abortPrepared('create', pairing.alias, requestId).catch(() => undefined)
      }
      throw createFailure(error, pairing.alias)
    }

    await this.pairings.bind(
      pairing.alias,
      pairing.peer,
      targetSessionId,
      ceiling === undefined ? {} : { maxTotalTokens: ceiling },
    )
    this.recordPeerAction(targetSessionId, { action: 'create', actor: participant, at: Date.now() })
    await this.finalizeInputReceipt({
      kind: 'create',
      alias: pairing.alias,
      requestId,
      payloadHash,
      instanceId: this.instanceId,
      sessionId: targetSessionId,
      created,
      ...(profile === undefined ? {} : { profile }),
    })
    return {
      target: {
        device: pairing.peer,
        sessionId: targetSessionId,
        exposure: pairing.exposure,
        alias: pairing.alias,
      },
      created,
      replayed: false,
      payloadHash,
      instanceId: this.instanceId,
      ...(profile === undefined ? {} : { profile }),
    }
  }

  /**
   * Evaluate one create request against a pairing's routing policy, before any
   * Session exists.
   * @param policy - the pairing's authoritative routing policy.
   * @param request - create request naming the route.
   * @returns the exact selection the verdict resolved.
   * @throws {@link RemoteError} `peer/forbidden` for a missing service, a
   * request that names no route, or a policy refusal.
   */
  private async evaluateCreateRouting(
    policy: PeerRoutingPolicy,
    request: PeerCreateRequest,
  ): Promise<PeerModelSelection> {
    const pinned = request.provider !== undefined || request.model !== undefined
    if (!pinned && request.chain === undefined) {
      throw routingForbidden(
        'routing-required',
        'this pairing requires provider/model or chain on every create',
      )
    }
    const routing = this.routingService()
    if (routing === undefined) {
      throw routingForbidden('routing-unavailable', 'this host has no model routing service')
    }
    if (pinned && (request.provider === undefined || request.model === undefined)) {
      throw new RemoteError('gateway/bad-request', 'provider and model must be provided together', {})
    }
    // A chain-only request uses the routing service's empty-route encoding
    // (`provider`/`model` empty); the verdict resolves the concrete selection.
    const selection: PeerModelSelection = {
      provider: request.provider ?? '',
      model: request.model ?? '',
      ...(request.chain === undefined ? {} : { chain: request.chain }),
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    }
    const verdict = await this.evaluateRoutes(routing, policy, selection)
    if (!verdict.allowed) {
      throw routingForbidden(
        verdict.reason,
        `routing policy refused the requested model (${verdict.reason})`,
        verdict.denied,
      )
    }
    return verdict.selection
  }

  /**
   * Policy-filtered model and chain discovery for one alias.
   * @param request - alias, participant, optional filter, cursor, and page limit.
   * @returns selectable chains/models with the policy echoed for the caller.
   * @throws {@link RemoteError} `peer/forbidden` (`reason: 'unauthorized'`) on
   * invalid credentials, `peer/forbidden` when the pairing configures no policy
   * or the host mounts no routing service, `gateway/bad-request` for an invalid
   * page cursor, and `peer/forbidden` reason `routing-unavailable` when the
   * service throws.
   */
  @Remote('models')
  async models(request: PeerModelsRequest): Promise<PeerModelsValue> {
    const loaded = this.pairings.load()
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      this.authenticateAll(loaded)
      throw new RemoteError('gateway/bad-request', 'models requires a request object', {})
    }
    const pairing = typeof request.alias === 'string'
      ? loaded.pairings.find(candidate => candidate.alias === request.alias)
      : undefined
    const auth = this.authenticatePairing(pairing)
    return authenticatedContextStorage.run(auth, async () => {
      if (pairing === undefined) throw unauthorizedError()
      requireParticipant(request.participant, auth.device)
      const policy = pairing.routing
      if (policy === undefined) {
        throw routingForbidden('routing-not-configured', 'this pairing configures no routing policy')
      }
      const routing = this.routingService()
      if (routing === undefined) {
        throw routingForbidden('routing-unavailable', 'this host has no model routing service')
      }
      const discovered = await this.discoverRoutes(routing, policy, request)
      return {
        ...discovered,
        selectableByThisAlias: {
          chains: policy.allowChains ?? [],
          models: policy.allowModels ?? [],
          ...(policy.allowReasoningEfforts === undefined
            ? {}
            : { reasoningEfforts: policy.allowReasoningEfforts }),
          requireZeroPrice: policy.requireZeroPrice === true,
          requireNoTraining: policy.requireNoTraining === true,
          requireTools: policy.requireTools === true,
          allowSwitch: policy.allowSwitch ?? 'never',
        },
      }
    })
  }

  /** Clamp one discovery page size to the deployment bounds. */
  private modelsLimitOf(requested: number | undefined): number {
    const max = this.resolved.modelsLimitMax
    const fallback = Math.min(this.resolved.modelsLimit, max)
    if (requested === undefined || !Number.isSafeInteger(requested) || requested <= 0) return fallback
    return Math.min(requested, max)
  }

  /**
   * Run one discovery call and translate the routing service's failures into
   * the peer vocabulary. The service signals an unusable cursor with a plain
   * `Error('invalid cursor')`; every other throw is a service fault and fails
   * closed without the raw message or stack reaching the caller.
   * @param routing - mounted routing seam.
   * @param policy - the pairing's routing policy.
   * @param request - caller filter, cursor, and clamped page limit.
   * @returns the service's discovery page.
   * @throws {@link RemoteError} `gateway/bad-request` for an invalid cursor,
   * `peer/forbidden` reason `routing-unavailable` for any other throw.
   */
  private async discoverRoutes(
    routing: PeerRoutingService,
    policy: PeerRoutingPolicy,
    request: PeerModelsRequest,
  ): Promise<{
    readonly chains: PeerModelsValue['chains']
    readonly models: PeerModelsValue['models']
    readonly nextCursor?: string
  }> {
    try {
      return await routing.discover(policy, {
        ...(request.filter === undefined ? {} : { filter: request.filter }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        limit: this.modelsLimitOf(request.limit),
      })
    } catch (error) {
      throw routingFailure(error)
    }
  }

  /**
   * Run one selection evaluation and translate a service throw like
   * {@link discoverRoutes}; a verdict, allowed or refused, is passed through.
   * @param routing - mounted routing seam.
   * @param policy - the pairing's routing policy.
   * @param selection - the requested route or chain.
   * @returns the service's verdict.
   * @throws {@link RemoteError} `peer/forbidden` reason `routing-unavailable`.
   */
  private async evaluateRoutes(
    routing: PeerRoutingService,
    policy: PeerRoutingPolicy,
    selection: PeerModelSelection,
  ): Promise<PeerRoutingVerdict> {
    try {
      return await routing.evaluate(policy, selection)
    } catch (error) {
      throw routingFailure(error)
    }
  }

  /**
   * Switch one idle Session's routing for its next turn. The policy decides the
   * exact selection; the caller's request is only an input.
   *
   * Durability and retry guarantees:
   * - A replay of the same `requestId` with the same payload while the receipt is
   *   retained returns the original value (`replayed: true`) before the idle
   *   check and without re-applying over any newer selection.
   * - If `receipts.put()` fails after applying, the host logs a warning and
   *   returns `receiptPersisted: false` (and in-memory replays also carry
   *   `receiptPersisted: false`) so callers know cross-restart idempotency is
   *   not guaranteed.
   * - On a post-restart retry without a persisted receipt, the host compares the
   *   Session's live selection to the resolved verdict selection before calling
   *   `sessionController.selectModel` and skips re-applying when they already
   *   match (no duplicate `model/selection` event).
   * @param request - target, participant, request id, and requested route.
   * @returns the applied selection, the previous one when known, replay status,
   * and `receiptPersisted: false` when durable receipt storage failed.
   * @throws {@link RemoteError} `peer/forbidden` for auth, a policy refusal, or
   * a disallowed switch, `peer/conflict` for a busy Session or a reused request
   * id, `peer/not-paired` for an unresolved target.
   */
  @Remote('selectModel')
  async selectModel(request: PeerSelectModelRequest): Promise<PeerSelectModelValue> {
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      this.authenticateAll(this.pairings.load())
      throw new RemoteError('gateway/bad-request', 'selectModel requires a request object', {})
    }
    const { resolved, auth } = this.authenticateTarget(request.target)
    return authenticatedContextStorage.run(auth, async () => {
      const participant = requireParticipant(request.participant, auth.device)
      const policy = resolved.pairing.routing
      if (policy === undefined) {
        throw routingForbidden('routing-not-configured', 'this pairing configures no routing policy')
      }
      const routing = this.routingService()
      if (routing === undefined) {
        throw routingForbidden('routing-unavailable', 'this host has no model routing service')
      }
      if (policy.allowSwitch !== 'idle-only') {
        throw routingForbidden('switch-not-allowed', 'this pairing does not allow mid-session switches')
      }
      const requestId = requireRequestId(request.requestId, 'selectModel', this.resolved.requestIdMaxLength)
      const key = receiptKey(resolved.sessionId, requestId)
      const hash = selectionHash(request)
      const receipt = this.receipts.get(key)
      if (receipt !== undefined) {
        if (receipt.hash !== hash) {
          throw new RemoteError(
            'peer/conflict',
            `requestId ${JSON.stringify(requestId)} was already used with a different payload`,
            { reason: 'request-id-reuse' },
          )
        }
        return {
          ...receipt.value,
          replayed: true,
          ...(this.receipts.isPersisted(key) ? {} : { receiptPersisted: false }),
        }
      }
      this.requireIdleForSwitch(resolved.sessionId)
      const verdict = await this.evaluateRoutes(routing, policy, {
        provider: request.provider,
        model: request.model,
        ...(request.chain === undefined ? {} : { chain: request.chain }),
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      })
      if (!verdict.allowed) {
        throw routingForbidden(
          verdict.reason,
          `routing policy refused the requested model (${verdict.reason})`,
          verdict.denied,
        )
      }
      const previous = await this.currentSelectionOf(resolved.sessionId)
      // The evaluation and the durable read awaited; a turn may have started in
      // that window, so re-prove idleness immediately before applying.
      this.requireIdleForSwitch(resolved.sessionId)
      const alreadyApplied = sameModelSelection(previous, verdict.selection)
      if (!alreadyApplied) {
        await this.applySelection(resolved.sessionId, verdict.selection)
      }
      const value: PeerSelectModelValue = {
        accepted: true,
        selected: verdict.selection,
        ...(previous === undefined ? {} : { previous }),
        replayed: alreadyApplied,
      }
      // In-memory attribution: the Session Controller's `model/selection` event
      // carries the selection but no participant, and widening that durable
      // payload would change the persisted format.
      this.recordPeerAction(resolved.sessionId, {
        action: 'model-change',
        actor: participant,
        at: Date.now(),
        detail: `${verdict.selection.provider}/${verdict.selection.model}`,
      })
      let receiptPersisted = true
      try {
        await this.receipts.put(key, hash, value)
      } catch (error) {
        receiptPersisted = false
        this.ctx.logger.warn(
          `peer-api: model selection applied but its receipt was not persisted: ${String(error)}`,
        )
      }
      return receiptPersisted ? value : { ...value, receiptPersisted: false }
    })
  }

  /**
   * The total-token ceiling recorded for one created Session, for the
   * enforcement lane that stops a Session at its budget.
   *
   * The answer comes from an in-memory reverse index so the per-append
   * watcher check never reads the pairing document; the index is rebuilt
   * whenever a `bind` republishes the binding snapshot. Ceilings themselves
   * only change through `peer.create`.
   * @param sessionId - Session to look up.
   * @returns the ceiling, or `undefined` when none was requested or clamped.
   */
  ceilingOf(sessionId: SessionId): number | undefined {
    const loaded = this.pairings.current()
    if (this.ceilingIndex?.bindings !== loaded.bindings) {
      this.ceilingIndex = { bindings: loaded.bindings, ceilings: ceilingsOf(loaded.bindings) }
    }
    return this.ceilingIndex.ceilings.get(sessionId)
  }

  /**
   * Watch one committed Session event for the token-ceiling enforcement lane.
   *
   * The durable `tokenUsage` projection advances only when an Assistant
   * message carrying provider usage commits, so checking on
   * `assistant/message` lets the in-flight request finish before the host
   * stops what follows. `turn/end` is the second trigger because a turn can
   * cross the ceiling on its final response with no later checkpoint. A
   * Session without a binding ceiling costs one in-memory lookup and returns
   * before any durable read.
   * @param session - the Session whose append produced the event.
   * @param event - the committed durable event.
   */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'assistant/message' && event.type !== 'turn/end') return
    const sessionId = session.id
    const ceiling = this.ceilingOf(sessionId)
    if (ceiling === undefined) return
    void this.checkBudget(sessionId, ceiling, event.data.turn)
  }

  /**
   * Enforce one Session's ceiling with at most one observation in flight.
   *
   * Events that arrive while the durable read is open collapse into one
   * trailing re-check, so a burst cannot multiply observations and the newest
   * read still decides. A turn already stopped is skipped, which keeps the
   * stop to one cancel per turn even when several events observe the same
   * over-budget state.
   * @param sessionId - Session to check.
   * @param ceiling - the Session's configured total-token ceiling.
   * @param turn - the turn the triggering event belongs to.
   */
  private async checkBudget(sessionId: SessionId, ceiling: number, turn: number): Promise<void> {
    if (this.budgetStopped.get(sessionId) === turn) return
    const inFlight = this.budgetChecks.get(sessionId)
    if (inFlight !== undefined) {
      inFlight.again = true
      inFlight.turn = turn
      return
    }
    const state = { again: true, turn, ceiling }
    this.budgetChecks.set(sessionId, state)
    try {
      while (state.again) {
        state.again = false
        await this.enforceBudget(sessionId, state.ceiling, state.turn)
      }
    } finally {
      this.budgetChecks.delete(sessionId)
    }
  }

  /**
   * Observe one Session's usage and stop its running turn when the ceiling is
   * reached. The stop is the Agent's own cancel with the durable
   * {@link PEER_BUDGET_STOP_REASON} hook cause, so the terminal it produces is
   * indistinguishable from a human stop only until the log is read: the fold
   * stamps `stop: 'budget'` solely from that marker.
   * @param sessionId - Session to check.
   * @param ceiling - the Session's configured total-token ceiling.
   * @param turn - the turn the triggering event belongs to.
   */
  private async enforceBudget(sessionId: SessionId, ceiling: number, turn: number): Promise<void> {
    if (this.budgetStopped.get(sessionId) === turn) return
    const budget = await this.budgetOf(sessionId, ceiling)
    if (budget?.exceeded !== true) return
    const agent = this.ctx.agents.get(sessionId)
    if (agent?.status !== 'running') return
    this.budgetStopped.set(sessionId, turn)
    try {
      agent.cancel({ kind: 'hook', reason: PEER_BUDGET_STOP_REASON }, { keepInbox: true })
    } catch {
      // The Agent detached between the status read and the stop: the turn is
      // already over, so there is nothing left to cancel.
      return
    }
    this.ctx.logger.warn(
      `peer-api: session ${sessionId} reached its token ceiling of ${String(ceiling)}; stopped turn ${String(turn)}`,
    )
  }

  /** Drop one Session's watcher bookkeeping when its Agent or Session is disposed. */
  private forgetBudgetStop(sessionId: SessionId): void {
    this.budgetStopped.delete(sessionId)
    this.budgetChecks.delete(sessionId)
  }

  /**
   * Read one Session's ceiling facts through a durable observation without
   * materializing its event log.
   * @param sessionId - Session to read.
   * @param ceiling - the Session's configured total-token ceiling.
   * @param signal - optional carrier cancellation for the read.
   * @returns the budget view, or `undefined` when the read or projection fails.
   */
  private async budgetOf(
    sessionId: SessionId,
    ceiling: number,
    signal?: AbortSignal,
  ): Promise<PeerExecutionState['budget']> {
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId, {
        projectionMode: 'all',
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      // The watcher guards committed appends and the prompt gate guards spend:
      // a transient observation failure must not become a host error. A prompt
      // falls through to the controller, which owns its own refusals.
      return undefined
    }
    try {
      return tokenBudgetOf(readTokenUsageProjection(observation.projections?.values), ceiling)
    } finally {
      observation[Symbol.dispose]()
    }
  }

  /** Install one resolved selection on a Session without touching the default. */
  private async applySelection(sessionId: SessionId, selection: PeerModelSelection): Promise<void> {
    await this.ctx.sessionController.selectModel({
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...(selection.chain === undefined ? {} : { chain: selection.chain }),
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      persistDefault: false,
    })
  }

  /**
   * Refuse a switch on a Session that is not provably idle. The host latch is
   * authoritative when it answers; a cold Session falls back to the agent's
   * live status, because a running agent is never a safe switch target.
   */
  private requireIdleForSwitch(sessionId: SessionId): void {
    const hostLatch = this.hostLatchOf(sessionId)
    if (hostLatch !== undefined) {
      if (hostLatch.latch === 'idle') return
      throw new RemoteError(
        'peer/conflict',
        `session is ${hostLatch.latch}; a model switch requires an idle session`,
        { reason: 'busy', latch: hostLatch.latch },
      )
    }
    if (this.ctx.agents.get(sessionId)?.status === 'running') {
      throw new RemoteError(
        'peer/conflict',
        'session is running; a model switch requires an idle session',
        { reason: 'busy', latch: 'running' },
      )
    }
  }

  /** The Session's durable selection, when its log records one. */
  private async currentSelectionOf(sessionId: SessionId): Promise<PeerModelSelection | undefined> {
    const observation = await this.observe(sessionId)
    return readModelSelectionProjection(observation.projections)
  }

  /**
   * Admit one queued peer turn into a paired Session with write-ahead payload-bound
   * receipt persistence.
   * @param request - target, participant, dedupe id, text content, and hop telemetry.
   * @param signal - carrier cancellation before prompt admission begins.
   * @returns acceptance, incremented hop count, receipt metadata, and disposition.
   * @throws {@link RemoteError} `peer/hop-limit` only when the pairing
   * configures a ceiling; `peer/forbidden` with reason `budget` once the
   * Session's token ceiling is reached; `peer/conflict` (`reason: 'request-id-reuse'`)
   * when `requestId` is reused with different content; `peer/unavailable` when
   * the write-ahead receipt cannot be persisted.
   */
  @Remote('prompt')
  async prompt(request: PeerPromptRequest, signal: AbortSignal): Promise<PeerPromptValue> {
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      this.authenticateAll(this.pairings.load())
      throw new RemoteError('gateway/bad-request', 'prompt requires a request object', {})
    }
    const { resolved, auth } = this.authenticateTarget(request.target)
    return authenticatedContextStorage.run(auth, async () => {
      const participant = requireParticipant(request.participant, auth.device)
      const requestId = brandString<PeerRequestId>(
        requireRequestId(request.requestId, 'prompt', this.resolved.requestIdMaxLength),
      )
      const hopCount = request.hopCount ?? 0
      const hopCeiling = resolved.pairing.runawayCeiling
      if (hopCeiling !== undefined && hopCount >= hopCeiling) {
        throw new RemoteError(
          'peer/hop-limit',
          `peer hop budget ${String(hopCount)} reached the configured ceiling ${String(hopCeiling)}`,
          { hopCount, ceiling: hopCeiling },
        )
      }
      const content = requirePromptContent(request.content)
      if (!this.inputReceipts.isAvailable()) {
        throw receiptUnavailableError('receipt-store-unavailable', 'prompt receipts are unavailable on this host')
      }
      return this.serializeInputOperation(inputReceiptKey('prompt', resolved.pairing.alias, requestId), async () => {
        const payloadHash = promptPayloadHash(resolved.sessionId, content)
        const existing = this.inputReceipts.get('prompt', resolved.pairing.alias, requestId)
        if (existing !== undefined) {
          if (existing.payloadHash !== payloadHash) {
            throw new RemoteError(
              'peer/conflict',
              `requestId ${JSON.stringify(requestId)} was already used with a different payload`,
              { reason: 'request-id-reuse' },
            )
          }
          const derived = await this.promptDispositionOf(resolved.sessionId, resolved.pairing.alias, requestId)
          if (existing.phase === 'finalized' || derived.disposition !== 'unknown') {
            if (existing.phase === 'prepared') {
              await this.finalizeInputReceipt({
                kind: 'prompt',
                alias: resolved.pairing.alias,
                requestId,
                payloadHash,
                instanceId: existing.instanceId,
                sessionId: resolved.sessionId,
                queued: existing.queued ?? true,
                hopCount: existing.hopCount ?? (hopCount + 1),
              })
            }
            return {
              accepted: true as const,
              queued: existing.queued ?? true,
              hopCount: existing.hopCount ?? (hopCount + 1),
              replayed: true,
              payloadHash: existing.payloadHash,
              instanceId: existing.instanceId,
              disposition: derived.disposition,
              ...(derived.terminalState === undefined ? {} : { terminalState: derived.terminalState }),
              ...(derived.terminal === undefined ? {} : { terminal: derived.terminal }),
            }
          }
        }
        if (resolved.pairing.worker !== undefined) {
          if (auth.via !== 'bearer') throw unauthorizedError()
          this.requireLiveJob(resolved)
          this.describeWorkerProfileOrThrow(resolved.sessionId)
        }
        // Refuse new peer spend once the binding's ceiling is reached. The check
        // costs one in-memory lookup for an uncapped Session; an unreadable
        // projection falls through to the Session Controller's own admission, so
        // the read can never become a second refusal authority.
        const ceiling = this.ceilingOf(resolved.sessionId)
        if (ceiling !== undefined) {
          const budget = await this.budgetOf(resolved.sessionId, ceiling, signal)
          if (budget?.exceeded === true) {
            throw new RemoteError('peer/forbidden', 'session token ceiling reached', {
              reason: 'budget',
              denied: String(ceiling),
            })
          }
        }
        try {
          await this.inputReceipts.prepare({
            kind: 'prompt',
            alias: resolved.pairing.alias,
            requestId,
            payloadHash,
            instanceId: this.instanceId,
            sessionId: resolved.sessionId,
            acceptedAt: Date.now(),
            queued: true,
            hopCount: hopCount + 1,
          })
        } catch (error) {
          throw receiptUnavailableError(
            'receipt-write-failed',
            `unable to persist peer.prompt receipt: ${error instanceof Error ? error.message : String(error)}`,
            error,
          )
        }
        const promptRequest: SessionPromptRequest = {
          requestId: peerPromptRpcId(resolved.pairing.alias, requestId),
          sessionId: resolved.sessionId,
          mode: 'queue',
          content,
          // Durable attribution: the target log's `user/message` carries the peer
          // tag, which is what the host latch's `lastParticipantAction` reports.
          participant,
        }
        try {
          if (resolved.pairing.worker !== undefined) this.requireLiveJob(resolved)
          await this.ctx.sessionController.prompt(promptRequest, signal)
        } catch (error) {
          const disp = await this.promptDispositionOf(resolved.sessionId, resolved.pairing.alias, requestId)
          if (disp.disposition === 'unknown') {
            await this.inputReceipts.abortPrepared('prompt', resolved.pairing.alias, requestId).catch(() => undefined)
          }
          throw error
        }
        await this.finalizeInputReceipt({
          kind: 'prompt',
          alias: resolved.pairing.alias,
          requestId,
          payloadHash,
          instanceId: this.instanceId,
          sessionId: resolved.sessionId,
          queued: true,
          hopCount: hopCount + 1,
        })
        this.recordPeerAction(resolved.sessionId, { action: 'prompt', actor: participant, at: Date.now() })
        this.scheduleWatchdog(resolved)
        return {
          accepted: true as const,
          queued: true,
          hopCount: hopCount + 1,
          replayed: false,
          payloadHash,
          instanceId: this.instanceId,
          disposition: 'queued' as const,
        }
      })
    })
  }

  /**
   * Look up a durable `peer.create` or `peer.prompt` receipt and derive its
   * current host-side disposition directly from the Session store / log.
   * @param request - pairing alias, caller request id, and optional kind disambiguator.
   * @returns receipt metadata, `replayedAcrossRestart`, and derived disposition.
   * @throws {@link RemoteError} `peer/forbidden` (`reason: 'unauthorized'`) on
   * invalid credentials or unknown alias, `gateway/bad-request` on malformed input
   * or ambiguous match without `kind`, `peer/unavailable` when the receipt store failed to open.
   */
  @Remote('receipt')
  async receipt(request: PeerReceiptRequest): Promise<PeerReceiptValue> {
    const loaded = this.pairings.load()
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      this.authenticateAll(loaded)
      throw new RemoteError('gateway/bad-request', 'receipt requires a request object', {})
    }
    const alias = typeof request.alias === 'string' && request.alias.length > 0 ? request.alias : undefined
    const pairing = alias === undefined
      ? undefined
      : loaded.pairings.find(candidate => candidate.alias === alias)
    const auth = this.authenticatePairing(pairing)
    return authenticatedContextStorage.run(auth, async () => {
      if (pairing === undefined) throw unauthorizedError()
      const requestId = requireRequestId(request.requestId, 'receipt', this.resolved.requestIdMaxLength)
      const rawKind: unknown = request.kind
      if (rawKind !== undefined && rawKind !== 'create' && rawKind !== 'prompt') {
        throw new RemoteError('gateway/bad-request', 'receipt kind must be "create" or "prompt"', {})
      }
      const kind = rawKind
      if (!this.inputReceipts.isAvailable()) {
        throw receiptUnavailableError('receipt-store-unavailable', 'receipt lookup is unavailable on this host')
      }
      const match = this.inputReceipts.find(pairing.alias, requestId, kind)
      if (match.ambiguous) {
        throw new RemoteError(
          'gateway/bad-request',
          'multiple receipts match requestId; specify kind ("create" or "prompt")',
          {},
        )
      }
      const entry = match.receipt
      if (entry === undefined) {
        return {
          found: false,
          ...(kind === undefined ? {} : { kind }),
          replayedAcrossRestart: false,
          disposition: 'unknown',
        }
      }
      const replayedAcrossRestart = entry.instanceId !== this.instanceId
      if (entry.kind === 'create') {
        const exists = await this.sessionExistsSafe(entry.sessionId)
        const disposition: PeerCreateDisposition = !exists
          ? 'unknown'
          : entry.created === false ? 'adopted' : 'created'
        return this.formatReceiptResult(entry, replayedAcrossRestart, { disposition })
      }
      const derived = await this.promptDispositionOf(entry.sessionId, entry.alias, entry.requestId)
      return this.formatReceiptResult(entry, replayedAcrossRestart, derived)
    })
  }

  /**
   * Update a bound worker job's fence, expiration timestamp, or revocation
   * state. Fence bumps are strictly monotonic and exposed only through this
   * authenticated method, with payload-bound idempotency receipts persisted
   * alongside the binding.
   * @param request - pairing alias, request id, job id, and mutation fields.
   * @returns the updated binding and receipt metadata.
   * @throws {@link RemoteError} `peer/forbidden` on auth failure or non-worker
   * pairing, `gateway/bad-request` on malformed input, `peer/not-found` when
   * the job binding is absent, `peer/conflict` on fence regression, expired
   * non-extended job, already-revoked job, or changed payload under the same
   * `requestId`, `peer/unavailable` when binding persistence is unavailable.
   */
  @Remote('jobUpdate')
  async jobUpdate(request: PeerJobUpdateRequest): Promise<PeerJobUpdateValue> {
    const loaded = this.pairings.load()
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
      this.authenticateAll(loaded)
      throw new RemoteError('gateway/bad-request', 'jobUpdate requires a request object', {})
    }
    const alias = typeof request.alias === 'string' && request.alias.length > 0 ? request.alias : undefined
    const pairing = alias === undefined
      ? undefined
      : loaded.pairings.find(candidate => candidate.alias === alias)
    const auth = this.authenticatePairing(pairing)
    return authenticatedContextStorage.run(auth, async () => {
      if (pairing === undefined || auth.via !== 'bearer') throw unauthorizedError()
      if (pairing.worker === undefined) {
        throw new RemoteError(
          'peer/forbidden',
          'pairing has no worker policy for jobUpdate',
          { reason: 'worker-policy-required' },
        )
      }
      for (const key of Object.keys(request)) {
        if (!JOB_UPDATE_KEYS.has(key)) {
          throw new RemoteError('gateway/bad-request', `jobUpdate contains unknown key ${JSON.stringify(key)}`, {})
        }
      }
      const requestId = brandString<PeerRequestId>(
        requireRequestId(request.requestId, 'jobUpdate', this.resolved.requestIdMaxLength),
      )
      const jobId = requireValidJobId(request.jobId, this.resolved.jobIdMaxLength)
      if (request.fence !== undefined
        && (typeof request.fence !== 'number' || !Number.isSafeInteger(request.fence) || request.fence <= 0)) {
        throw new RemoteError('gateway/bad-request', 'jobUpdate fence must be a positive safe integer', {})
      }
      if (request.expiresAt !== undefined
        && (typeof request.expiresAt !== 'number' || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= 0)) {
        throw new RemoteError('gateway/bad-request', 'jobUpdate expiresAt must be a positive safe integer', {})
      }
      if (request.revoked !== undefined && typeof request.revoked !== 'boolean') {
        throw new RemoteError('gateway/bad-request', 'jobUpdate revoked must be a boolean', {})
      }
      if (request.revoked === false) {
        throw new RemoteError('gateway/bad-request', 'jobUpdate cannot un-revoke a job', {})
      }
      if (request.fence === undefined && request.expiresAt === undefined && request.revoked === undefined) {
        throw new RemoteError('gateway/bad-request', 'jobUpdate requires at least one of fence, expiresAt, or revoked', {})
      }
      if (!this.jobBindings.isAvailable()) {
        throw receiptUnavailableError('job-bindings-unavailable', 'job bindings are unavailable on this host')
      }
      try {
        return await this.jobBindings.applyUpdate({
          alias: pairing.alias,
          request: {
            alias: pairing.alias,
            requestId,
            jobId,
            ...(request.fence === undefined ? {} : { fence: request.fence }),
            ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
            ...(request.revoked === undefined ? {} : { revoked: request.revoked }),
          },
          instanceId: this.instanceId,
          jobMaxTtlMs: this.resolved.jobMaxTtlMs,
        })
      } catch (error) {
        if (error instanceof RemoteError) throw error
        throw receiptUnavailableError('job-binding-write-failed', 'unable to persist worker job update', error)
      }
    })
  }

  /**
   * Probe authenticated host and pairing readiness before dispatching work.
   * @param request - pairing alias to check.
   * @returns readiness boolean, missing capability list, advertised capabilities,
   * optional attested profile summary when bound, boot `instanceId`, and harness `version`.
   * @throws {@link RemoteError} `peer/forbidden` (`reason: 'unauthorized'`) on
   * invalid credentials or unknown alias, `gateway/bad-request` on malformed input.
   */
  @Remote('ready')
  ready(request: PeerReadyRequest): PeerReadyValue {
    const loaded = this.pairings.load()
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
      this.authenticateAll(loaded)
      throw new RemoteError('gateway/bad-request', 'ready requires a request object', {})
    }
    const alias = typeof request.alias === 'string' && request.alias.length > 0 ? request.alias : undefined
    const pairing = alias === undefined
      ? undefined
      : loaded.pairings.find(candidate => candidate.alias === alias)
    const auth = this.authenticatePairing(pairing)
    return authenticatedContextStorage.run(auth, () => {
      if (pairing === undefined || (pairing.worker !== undefined && auth.via !== 'bearer')) throw unauthorizedError()
      if (Object.keys(request).some(key => key !== 'alias')) {
        throw new RemoteError('gateway/bad-request', 'ready accepts only alias', {})
      }
      const missing: string[] = []
      if (!this.inputReceipts.isAvailable()) {
        missing.push('create-receipts', 'prompt-receipts', 'input-disposition')
        if (pairing.create?.freshOnly === true) missing.push('fresh-only-create')
      }
      if (pairing.routing !== undefined && this.routingService() === undefined) {
        missing.push('model-discovery', 'model-routing-at-create', 'model-switch')
      }
      if ((pairing.routing?.maxTotalTokens !== undefined || pairing.worker?.maxLimits?.maxTotalTokens !== undefined)
        && !this.hasTokenUsageSeam()) {
        missing.push('token-ceiling')
      }
      let profile: PeerProfileSummary | undefined
      if (pairing.worker !== undefined) {
        if (pairing.create === undefined) missing.push('session-create')
        if (!this.jobBindings.isAvailable()) missing.push('job-binding')
        const identityService = this.ctx.get('peerProfileIdentity')
        if (identityService === undefined) {
          missing.push('profile-identity')
        } else {
          const resolved = this.pairings.resolve({ kind: 'alias', alias: pairing.alias })
          if (resolved !== undefined) {
            try {
              profile = this.describeWorkerProfileOrThrow(resolved.sessionId)
            } catch {
              missing.push('profile-identity')
            }
          }
        }
        if (!this.isExportRootAvailable()) missing.push('export-root')
      }
      return {
        ready: missing.length === 0,
        missing,
        capabilities: [...this.advertisedCapabilities()],
        ...(profile === undefined ? {} : { profile }),
        instanceId: this.instanceId,
        version: this.resolved.harnessVersion,
      }
    })
  }

  /**
   * List regular files inside the bound worker session's fixed export root.
   * Requires a live (non-expired, non-revoked) job binding.
   * @param request - pairing alias owning the worker session.
   * @returns bounded list of regular files with relative paths and truncation flag.
   */
  @Remote('exportList')
  exportList(request: PeerExportListRequest): PeerExportListValue {
    const { resolved, auth } = this.authenticateWorkerExportAlias(request, 'exportList')
    return authenticatedContextStorage.run(auth, () => {
      for (const key of Object.keys(request)) {
        if (key !== 'alias') {
          throw new RemoteError('gateway/bad-request', `exportList contains unknown key ${JSON.stringify(key)}`, {})
        }
      }
      try {
        return listSessionExports(this.resolved.exportRoot, resolved.sessionId, {
          maxFiles: this.resolved.exportListMaxFiles,
          maxBytes: this.resolved.exportListMaxBytes,
          maxScannedEntries: this.resolved.exportListMaxScannedEntries,
        })
      } catch (error) {
        throw exportIoError(error)
      }
    })
  }

  /**
   * Fetch one bounded regular file from the bound worker session's fixed export
   * root, refusing traversal, symlinks, non-regular files, oversize reads, and
   * size changes between stat and read. Requires a live job binding; the hub
   * must still independently re-verify returned bytes and SHA-256.
   * @param request - pairing alias, relative file path, and optional caller byte cap.
   * @returns relative path, exact byte length, SHA-256 over the returned bytes, and base64 content.
   */
  @Remote('exportFetch')
  exportFetch(request: PeerExportFetchRequest): PeerExportFetchValue {
    const { resolved, auth } = this.authenticateWorkerExportAlias(request, 'exportFetch')
    return authenticatedContextStorage.run(auth, () => {
      for (const key of Object.keys(request)) {
        if (key !== 'alias' && key !== 'path' && key !== 'maxBytes') {
          throw new RemoteError('gateway/bad-request', `exportFetch contains unknown key ${JSON.stringify(key)}`, {})
        }
      }
      if (request.maxBytes !== undefined
        && (typeof request.maxBytes !== 'number' || !Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0)) {
        throw new RemoteError('gateway/bad-request', 'exportFetch maxBytes must be a positive safe integer', {})
      }
      if (typeof request.path !== 'string' || Buffer.byteLength(request.path) > this.resolved.exportPathMaxBytes) {
        throw new RemoteError('gateway/bad-request', 'exportFetch path must be a string within the configured byte cap', {})
      }
      try {
        return fetchSessionExport(this.resolved.exportRoot, resolved.sessionId, request.path, {
          maxBytes: this.resolved.exportFetchMaxBytes,
          ...(request.maxBytes === undefined ? {} : { requestedMaxBytes: request.maxBytes }),
        })
      } catch (error) {
        throw exportIoError(error)
      }
    })
  }

  /**
   * Stop a paired Session and optionally discard the pairing's pending prompts.
   * @param request - target, participant, and optional queue removal intent.
   * @returns acceptance, whether a turn was active, the immediate stop observation, and the number removed.
   */
  @Remote('cancel')
  cancel(request: PeerCancelRequest): PeerCancelValue {
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      this.authenticateAll(this.pairings.load())
      throw new RemoteError('gateway/bad-request', 'cancel requires a request object', {})
    }
    const { resolved, auth } = this.authenticateTarget(request.target)
    return authenticatedContextStorage.run(auth, () => {
      const participant = requireParticipant(request.participant, auth.device)
      const rawDropQueued: unknown = request.dropQueued
      if (rawDropQueued !== undefined && typeof rawDropQueued !== 'boolean') {
        throw new RemoteError('gateway/bad-request', 'cancel dropQueued must be a boolean', {})
      }
      const dropQueued = rawDropQueued ?? (resolved.pairing.worker !== undefined)
      const agent = this.ctx.agents.get(resolved.sessionId)
      const active = agent?.status === 'running'
      const value = this.ctx.sessionController.cancel({ sessionId: resolved.sessionId, participant })
      const requestedAt = Date.now()
      let droppedQueued = 0
      if (dropQueued && agent !== undefined) {
        const prefix = peerPromptRpcPrefix(resolved.pairing.alias)
        // Peer prompts are text-only; unlike a Web submission they own no upload receipts.
        for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
          const source = message.source
          if (source.kind === 'user' && 'rpcId' in source && source.rpcId.startsWith(prefix)
            && source.participant?.kind === 'peer' && source.participant.device === auth.device
            && agent.inbox.remove(message.id)) {
            droppedQueued += 1
          }
        }
      }
      this.stopRequested.set(resolved.sessionId, requestedAt)
      this.recordPeerAction(resolved.sessionId, { action: 'cancel', actor: participant, at: requestedAt })
      this.clearWatchdog(resolved.sessionId)
      const latch = this.hostLatchOf(resolved.sessionId)
      return { accepted: value.accepted, cancelled: active, droppedQueued, stopIntent: {
        requestedAt, keepInbox: true, turnState: latch?.latch ?? 'unknown', activeDescendants: latch?.activeDescendants ?? 0,
        descendantsExact: latch?.descendantsExact ?? false, quiescence: 'unknown',
      } }
    })
  }

  /**
   * Settle a pending ask for a paired Session. An answer may resume a turn
   * the host paused on that ask; the ceiling watcher stops it after the next
   * response when the Session is already over budget.
   * @param request - target, participant, ask id, retry id, and answer payload.
   * @returns the persisted decision receipt, replayed without another delivery on a matching retry.
   */
  @Remote('answer')
  answer(request: PeerAnswerRequest): PeerAnswerValue {
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      this.authenticateAll(this.pairings.load())
      throw new RemoteError('gateway/bad-request', 'answer requires a request object', {})
    }
    const { resolved, auth } = this.authenticateTarget(request.target)
    return authenticatedContextStorage.run(auth, () => {
      const participant = requireParticipant(request.participant, auth.device)
      const requestId = brandString<PeerRequestId>(requireRequestId(request.requestId, 'answer', this.resolved.requestIdMaxLength))
      if (typeof request.askId !== 'string' || request.askId.length === 0) {
        throw new RemoteError('gateway/bad-request', 'answer requires a non-empty askId', {})
      }
      const value = this.registry.answer(
        resolved,
        brandString<PeerAskId>(request.askId),
        requireAnswer(request.answer),
        requestId,
        participant,
      )
      if (!value.replayed) this.recordPeerAction(resolved.sessionId, {
        action: 'answer',
        actor: participant,
        at: Date.now(),
        detail: request.askId,
      })
      return value
    })
  }

  /**
   * Repair history backwards from a follow cut, exposure-filtered.
   * @param request - target, inclusive cut, and optional backwards cursor.
   * @param signal - carrier cancellation for persistence reads.
   * @returns one contiguous backwards window of visible records.
   */
  @Remote('page')
  async page(request: PeerPageRequest, signal: AbortSignal): Promise<PeerPageValue> {
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      this.authenticateAll(this.pairings.load())
      throw new RemoteError('gateway/bad-request', 'page requires a request object', {})
    }
    const { resolved, auth } = this.authenticateTarget(request.target)
    return authenticatedContextStorage.run(auth, async () => {
      const page = await this.ctx.sessionController.page({
        address: { kind: 'session', sessionId: resolved.sessionId },
        throughSeq: request.throughSeq,
        ...(request.beforeSeq === undefined
          ? {}
          : { beforeSeq: request.beforeSeq }),
        ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      }, signal)
      const records = page.records.flatMap(record => toPeerRecords(record.event, resolved.exposure))
      return { records, hasMore: page.hasMore }
    })
  }

  /**
   * Open a filtered stream: opening snapshot, then durable events and latch transitions.
   * @param request - target, window budget, and debug-only assistant stream opt-in.
   * @param signal - carrier cancellation owned by the Remote stream.
   * @returns acknowledgement-paced peer frames; a gap item is followed by a `peer/gap` failure.
   */
  @Remote({ mode: 'stream' })
  follow(request: PeerFollowRequest, signal: AbortSignal): RemoteStream<PeerFollowFrame, PeerFollowAck> {
    const rawRequest: unknown = request
    if (rawRequest === null || typeof rawRequest !== 'object') {
      this.authenticateAll(this.pairings.load())
      throw new RemoteError('gateway/bad-request', 'follow requires a request object', {})
    }
    const { resolved, auth } = this.authenticateTarget(request.target)
    if (request.assistantStream === true && resolved.exposure !== 'debug') {
      throw new RemoteError('peer/forbidden', 'assistant stream requires debug exposure', { reason: 'exposure' })
    }
    const invocation = this.ctx.invocation
    const carrier = AbortSignal.any([signal, this.lifetime.signal])
    const open = (): AsyncIterator<PeerFollowFrame> => {
      const ack = invocation?.uplink<PeerFollowAck>()[Symbol.asyncIterator]()
      const release = this.followAdmission.admit(resolved.pairing.alias)
      return new BoundedFollow(this.resolved, carrier,
        control => authenticatedContextStorage.run(auth, () => this.followStream(resolved, request, control)), ack, release).read()
    }
    return (async function* () {
      if (!carrier.aborted) yield* { [Symbol.asyncIterator]: open }
    })()
  }

  private async *followStream(
    resolved: ResolvedPeerPairing,
    request: PeerFollowRequest,
    signal: AbortSignal,
  ): AsyncIterable<PeerFollowFrame> {
    let fold: PeerLatchFold | undefined
    let projections: ObservationView['projections']
    const target = this.pairings.describe(resolved)
    let stateKey: string | undefined
    let change = false
    const changed = (): boolean => change
    let wake: (() => void) | undefined
    const notify = (): void => {
      const next = wake
      wake = undefined
      next?.()
    }
    const unsubscribe = this.registry.onChange((sessionId) => {
      if (sessionId !== resolved.sessionId) return
      change = true
      notify()
    })
    signal.addEventListener('abort', notify, { once: true })
    const stream = this.ctx.sessionController.follow({
      address: { kind: 'session', sessionId: resolved.sessionId },
      maxMessages: request.maxMessages ?? FOLLOW_SNAPSHOT_MAX_MESSAGES,
      ...(request.assistantStream === true ? { assistantStream: true as const } : {}),
    }, signal)
    const durable = stream[Symbol.asyncIterator]()
    this.incrementFollowers(resolved.sessionId)
    try {
      type DurableResult = Awaited<ReturnType<typeof durable.next>>
      type Ready = { readonly result: DurableResult } | { readonly error: unknown }
      let pending: Promise<void> | undefined
      let ready: Ready | undefined
      let expectedSeq: number | undefined
      // Durable position the generation has scanned; a pushed state frame
      // carries it so repair from any frame cut stays contiguous.
      let scanned = -1
      for (;;) {
        if (signal.aborted) return
        pending ??= durable.next().then((result) => { ready = { result }; notify() }, (error: unknown) => { ready = { error }; notify() })
        if (changed() && fold !== undefined) {
          change = false
          const state = this.snapshotState(resolved, fold, this.hostLatchOf(resolved.sessionId), projections)
          const nextKey = latchKey(state)
          if (nextKey === stateKey) continue
          stateKey = nextKey
          yield { type: 'state', state, cursor: brandNumber<SessionSeq>(scanned) }
          continue
        }
        const item = ready
        if (item === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        ready = undefined
        pending = undefined
        if ('error' in item) {
          if (item.error instanceof RemoteError && item.error.code === 'gateway/internal'
            && item.error.message.includes('session event stream skipped seq')) {
            yield { type: 'gap', fromSeq: brandNumber<SessionSeq>(scanned + 1), toSeq: null, reason: 'sequence-discontinuity', resync: 'refollow-and-page' }
            return
          }
          throw item.error
        }
        const frame = item.result
        if (frame.done === true) {
          // The controller also ends normally when its lower-level backlog overflows.
          yield { type: 'gap', fromSeq: brandNumber<SessionSeq>(scanned + 1), toSeq: null, reason: 'upstream-closed', resync: 'refollow-and-page' }
          return
        }
        const current = frame.value
        if (current.type === 'snapshot') {
          expectedSeq = current.cursor + 1
          scanned = current.cursor
          const opening = await this.followOpeningFold(resolved.sessionId, current.cursor, signal)
          if (opening === undefined) {
            yield { type: 'gap', fromSeq: null, toSeq: brandNumber<SessionSeq>(scanned), reason: 'sequence-discontinuity',
              resync: 'refollow-and-page' }
            return
          }
          fold = opening.fold
          projections = opening.projections
          const state = this.snapshotState(resolved, fold, this.hostLatchOf(resolved.sessionId), projections)
          stateKey = latchKey(state)
          yield {
            type: 'snapshot',
            target,
            header: {
              id: current.header.id,
              version: current.header.version,
              createdAt: current.header.createdAt,
              ...(current.header.cwd === undefined ? {} : { cwd: current.header.cwd }),
              ...(current.header.agentPreset === undefined ? {} : { agentPreset: current.header.agentPreset }),
            },
            cursor: brandNumber<SessionSeq>(current.cursor),
            state,
            records: current.records.flatMap(record => toPeerRecords(record.event, resolved.exposure)),
            hasMore: current.hasMore,
          }
          continue
        }
        if (current.type === 'assistant-stream') {
          yield { type: 'assistant-stream', frame: current.frame }
          continue
        }
        const entry: SessionHistoryRecord = current
        if (expectedSeq === undefined || fold === undefined) continue
        if (entry.event.seq !== expectedSeq) {
          yield { type: 'gap', reason: 'sequence-discontinuity', fromSeq: brandNumber<SessionSeq>(expectedSeq),
            toSeq: brandNumber<SessionSeq>(Math.max(expectedSeq, entry.event.seq)), resync: 'refollow-and-page' }
          return
        }
        expectedSeq += 1
        fold.apply(entry.event)
        scanned = entry.event.seq
        const cursor = brandNumber<SessionSeq>(entry.event.seq)
        for (const peerRecord of toPeerRecords(entry.event, resolved.exposure)) {
          yield { type: 'event', record: peerRecord, cursor }
        }
        const state = this.snapshotState(resolved, fold, this.hostLatchOf(resolved.sessionId), projections)
        const nextKey = latchKey(state)
        if (nextKey !== stateKey) {
          stateKey = nextKey
          yield { type: 'state', state, cursor }
        }
      }
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'peer/not-found') {
        yield { type: 'end', reason: 'target-detached' }
        return
      }
      throw error
    } finally {
      signal.removeEventListener('abort', notify)
      unsubscribe()
      this.decrementFollowers(resolved.sessionId)
      await durable.return?.()
    }
  }

  private async followOpeningFold(sessionId: SessionId, through: number, signal: AbortSignal): Promise<{
    readonly fold: PeerLatchFold
    readonly projections: ObservationView['projections']
  } | undefined> {
    const observation = await this.observe(sessionId, signal)
    if (observation.cursor < through) return undefined
    const fold = new PeerLatchFold()
    for (const event of observation.events) {
      if (event.seq > through) break
      fold.apply(event)
    }
    fold.recordPeerAction(this.peerActions.get(sessionId))
    return { fold, projections: observation.cursor === through ? observation.projections : undefined }
  }

  /**
   * Capabilities this host can serve right now. The ledger is build-wide, but
   * the routing trio needs a mounted `peerRouting` service and `token-ceiling`
   * needs the usage seam: advertising either without its seam would promise a
   * call the host refuses.
   */
  private advertisedCapabilities(): readonly PeerCapability[] {
    const routingServed = this.routingService() !== undefined
    const usageServed = this.hasTokenUsageSeam()
    const receiptsServed = this.inputReceipts.isAvailable()
    const jobBindingsServed = this.jobBindings.isAvailable() && receiptsServed
    const profileIdentityServed = this.ctx.get('peerProfileIdentity') !== undefined
    const exportRootServed = this.isExportRootAvailable() && this.jobBindings.isAvailable()
    return PEER_CAPABILITIES.filter(capability =>
      (routingServed || !ROUTING_CAPABILITIES.includes(capability))
      && (usageServed || !TOKEN_CEILING_CAPABILITIES.includes(capability))
      && (receiptsServed || !RECEIPT_CAPABILITIES.includes(capability))
      && (jobBindingsServed || !JOB_BINDING_CAPABILITIES.includes(capability))
      && (profileIdentityServed || !PROFILE_IDENTITY_CAPABILITIES.includes(capability))
      && (exportRootServed || !EXPORT_ROOT_CAPABILITIES.includes(capability))
      && (this.registry.isAvailable() || !['answer-routing', 'durable-asks', 'ask-idempotent-answer'].includes(capability))
      && (capability !== 'shape-digest' || this.resolved.schemaDigest === PEER_SCHEMA_DIGEST))
  }

  private isExportRootAvailable(): boolean {
    return checkExportRootAvailable(this.resolved.exportRoot)
  }

  private jobValidationBounds() {
    return {
      jobIdMaxLength: this.resolved.jobIdMaxLength,
      jobMaxTtlMs: this.resolved.jobMaxTtlMs,
      jobIdentifierMaxLength: this.resolved.jobIdentifierMaxLength,
      jobCapabilitiesMax: this.resolved.jobCapabilitiesMax,
      jobToolsMax: this.resolved.jobToolsMax,
    }
  }

  private requireProfileIdentityService(): PeerProfileIdentityService {
    const service = this.ctx.get('peerProfileIdentity')
    if (service === undefined) {
      throw new RemoteError(
        'peer/unavailable',
        'profile identity service is unavailable for this worker pairing',
        { reason: 'profile-identity-unavailable' },
      )
    }
    return service
  }

  private describeWorkerProfileOrThrow(sessionId: SessionId): PeerProfileSummary {
    const service = this.requireProfileIdentityService()
    let described: ReturnType<PeerProfileIdentityService['describe']>
    try {
      described = service.describe(sessionId)
    } catch (error) {
      throw new RemoteError(
        'peer/unavailable',
        'profile identity service failed for this worker session',
        { reason: 'profile-identity-unavailable' },
        { cause: error },
      )
    }
    if (described === undefined) {
      throw new RemoteError(
        'peer/unavailable',
        'profile identity is unavailable for this worker session',
        { reason: 'profile-identity-unavailable' },
      )
    }
    return { hash: described.hash, presetId: described.presetId }
  }

  private async persistJobBinding(
    alias: PeerAlias,
    sessionId: SessionId,
    validatedJob: ValidatedCreateJob,
    ceiling: number | undefined,
  ): Promise<void> {
    const binding: PeerJobBinding = {
      sessionId,
      jobId: validatedJob.jobId,
      fence: validatedJob.fence,
      expiresAt: validatedJob.expiresAt,
      capabilities: validatedJob.capabilities,
      limits: ceiling === undefined
        ? validatedJob.limits
        : { ...validatedJob.limits, maxTotalTokens: ceiling },
      ...(validatedJob.mcpEndpointId === undefined ? {} : { mcpEndpointId: validatedJob.mcpEndpointId }),
      ...(validatedJob.credentialRef === undefined ? {} : { credentialRef: validatedJob.credentialRef }),
      ...(validatedJob.allowedToolNames === undefined ? {} : { allowedToolNames: validatedJob.allowedToolNames }),
      alias,
      instanceId: this.instanceId,
      createdAt: Date.now(),
    }
    try {
      await this.jobBindings.put(binding)
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw receiptUnavailableError(
        'job-binding-write-failed',
        'unable to persist worker job binding',
        error,
      )
    }
  }

  private async disposeCreatedSession(sessionId: SessionId): Promise<void> {
    try {
      await this.ctx.sessionController.delete({ sessionId })
    } catch {
      const agent = this.ctx.agents.get(sessionId)
      if (agent !== undefined) agent.cancel({ kind: 'user' }, { keepInbox: false })
      this.ctx.sessions.dispose(sessionId)
    }
  }

  private authenticateWorkerExportAlias(
    rawRequest: unknown,
    method: string,
  ): { readonly resolved: ResolvedPeerPairing; readonly auth: AuthenticatedPeerContext } {
    const loaded = this.pairings.load()
    if (rawRequest === null || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
      this.authenticateAll(loaded)
      throw new RemoteError('gateway/bad-request', `${method} requires a request object`, {})
    }
    const rawAlias = (rawRequest as { readonly alias?: unknown }).alias
    const alias = typeof rawAlias === 'string' && rawAlias.length > 0 ? rawAlias : undefined
    const pairing = alias === undefined
      ? undefined
      : loaded.pairings.find(candidate => candidate.alias === alias)
    const auth = this.authenticatePairing(pairing)
    if (pairing === undefined || auth.via !== 'bearer') throw unauthorizedError()
    if (pairing.worker === undefined) {
      throw new RemoteError(
        'peer/forbidden',
        `pairing has no worker policy for ${method}`,
        { reason: 'worker-policy-required' },
      )
    }
    if (!this.jobBindings.isAvailable()) {
      throw receiptUnavailableError('job-bindings-unavailable', 'job bindings are unavailable on this host')
    }
    const resolved = this.pairings.resolve({ kind: 'alias', alias: pairing.alias })
    if (resolved === undefined) {
      throw new RemoteError('peer/not-paired', `alias ${JSON.stringify(pairing.alias)} is not paired`, {
        alias: pairing.alias,
      })
    }
    this.requireLiveJob(resolved)
    return { resolved, auth }
  }

  private requireLiveJob(resolved: ResolvedPeerPairing): void {
    if (!this.jobBindings.isAvailable()) {
      throw receiptUnavailableError('job-bindings-unavailable', 'job bindings are unavailable on this host')
    }
    const binding = this.jobBindings.get(resolved.sessionId)
    if (binding === undefined || binding.alias !== resolved.pairing.alias) {
      throw new RemoteError('peer/forbidden', 'session has no active job binding', {
        reason: 'job-binding-missing',
      })
    }
    if (binding.revoked === true) {
      throw new RemoteError('peer/forbidden', 'job binding has been revoked', {
        reason: 'job-revoked',
      })
    }
    if (binding.expiresAt <= Date.now()) {
      throw new RemoteError('peer/forbidden', 'job binding has expired', {
        reason: 'job-expired',
      })
    }
  }

  /**
   * Whether this host can read the durable `tokenUsage` projection. The token
   * meter registers that projection in its constructor, so the mounted service
   * is the cheapest honest probe: the registry exposes no key lookup and the
   * handshake has no Session to read.
   */
  private hasTokenUsageSeam(): boolean {
    return this.ctx.get('tokenMeter') !== undefined
  }

  /** The mounted routing seam, if this deployment has one. */
  private routingService(): PeerRoutingService | undefined {
    return this.ctx.get('peerRouting')
  }

  private describePairing(pairing: PeerPairing): PeerPairingSummary {
    const resolved = this.pairings.resolve({ kind: 'alias', alias: pairing.alias })
    return {
      alias: pairing.alias,
      peer: pairing.peer,
      exposure: pairing.exposure,
      tokenRequired: pairing.tokenHash !== undefined,
      ...(resolved === undefined ? {} : { target: this.pairings.describe(resolved) }),
    }
  }

  private authenticateAll(
    loaded: LoadedPeerPairings,
  ): { readonly pairings: readonly PeerPairing[]; readonly via: 'bearer' | 'insecure' } {
    const rawAuth = readAuthorizationHeader()
    if (rawAuth !== undefined) {
      const bearer = parseBearerAuthorization(rawAuth)
      if (bearer === undefined) throw unauthorizedError()
      const matches: PeerPairing[] = []
      let ranScrypt = false
      for (const pairing of loaded.pairings) {
        if (pairing.tokenHash === undefined) continue
        if (pairing.tokenHash.startsWith('scrypt$')) ranScrypt = true
        if (verifyPairingToken(bearer, pairing.tokenHash)) matches.push(pairing)
      }
      if (matches.length === 0) {
        if (!ranScrypt) dummyVerifyToken(bearer)
        throw unauthorizedError()
      }
      return { pairings: matches, via: 'bearer' }
    }
    const insecurePairings = loaded.pairings.filter(
      pairing => pairing.insecure === true && pairing.tokenHash === undefined,
    )
    if (insecurePairings.length === 0) throw unauthorizedError()
    return { pairings: insecurePairings, via: 'insecure' }
  }

  private authenticatePairing(pairing: PeerPairing | undefined): AuthenticatedPeerContext {
    const rawAuth = readAuthorizationHeader()
    if (rawAuth !== undefined) {
      const bearer = parseBearerAuthorization(rawAuth)
      if (bearer === undefined) throw unauthorizedError()
      if (pairing === undefined || pairing.tokenHash === undefined) {
        dummyVerifyToken(bearer)
        throw unauthorizedError()
      }
      if (!verifyPairingToken(bearer, pairing.tokenHash)) throw unauthorizedError()
      return { device: pairing.peer, via: 'bearer', alias: pairing.alias }
    }
    if (pairing !== undefined && pairing.insecure === true && pairing.tokenHash === undefined) {
      return { device: pairing.peer, via: 'insecure', alias: pairing.alias }
    }
    throw unauthorizedError()
  }

  private authenticateTarget(
    target: unknown,
  ): { readonly resolved: ResolvedPeerPairing; readonly auth: AuthenticatedPeerContext } {
    const loaded = this.pairings.load()
    if (typeof target !== 'object' || target === null || Array.isArray(target)) {
      this.authenticateAll(loaded)
      throw new RemoteError('gateway/bad-request', 'target must be {kind: "alias", alias} or {kind: "session", sessionId}', {})
    }
    const record = target as { readonly kind?: unknown; readonly alias?: unknown; readonly sessionId?: unknown }
    if (record.kind === 'alias') {
      if (typeof record.alias !== 'string' || record.alias.length === 0) {
        this.authenticateAll(loaded)
        throw new RemoteError('gateway/bad-request', 'target.alias must be a non-empty string', {})
      }
      const pairing = loaded.pairings.find(candidate => candidate.alias === record.alias)
      const auth = this.authenticatePairing(pairing)
      const alias = brandString<PeerAlias>(record.alias)
      const resolved = this.pairings.resolve({ kind: 'alias', alias })
      if (resolved === undefined) {
        throw new RemoteError('peer/not-paired', `alias ${JSON.stringify(alias)} is not paired`, { alias })
      }
      return { resolved, auth }
    }
    if (record.kind === 'session') {
      if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
        this.authenticateAll(loaded)
        throw new RemoteError('gateway/bad-request', 'target.sessionId must be a non-empty string', {})
      }
      const sessionId = brandString<SessionId>(record.sessionId)
      const resolved = this.pairings.resolve({ kind: 'session', sessionId })
      const auth = this.authenticatePairing(resolved?.pairing)
      if (resolved === undefined) throw unauthorizedError()
      return { resolved, auth }
    }
    this.authenticateAll(loaded)
    throw new RemoteError('gateway/bad-request', 'target.kind must be alias or session', {})
  }

  private resolveTarget(target: PeerTarget): ResolvedPeerPairing {
    const resolved = this.pairings.resolve(target)
    if (resolved === undefined) {
      throw new RemoteError(
        'peer/not-paired',
        target.kind === 'alias'
          ? `alias ${JSON.stringify(target.alias)} is not paired`
          : `session ${JSON.stringify(target.sessionId)} is not paired`,
        target.kind === 'alias' ? { alias: target.alias } : { sessionId: target.sessionId },
      )
    }
    return resolved
  }

  private snapshotState(
    resolved: ResolvedPeerPairing,
    fold: PeerLatchFold,
    hostLatch: HostLatchFacts | undefined,
    projections: Readonly<Record<string, unknown>> | undefined,
  ): PeerExecutionState {
    const { sessionId } = resolved
    const usage = readTokenUsageProjection(projections)
    const budget = tokenBudgetOf(usage, this.ceilingOf(sessionId))
    const state = fold.snapshot(this.registry.pendingFor(sessionId, resolved), hostLatch)
    const tools = fold.inFlightTools()
    const requestedAt = this.stopRequested.get(sessionId)
    const stopIntent: PeerStopIntent = {
      ...(requestedAt === undefined ? {} : { requestedAt }),
      keepInbox: true, turnState: state.latch, activeDescendants: state.activeDescendants,
      descendantsExact: hostLatch?.descendantsExact ?? false,
      ...(tools === undefined ? {} : { inFlightTools: tools }),
      quiescence: hostLatch?.latch === 'idle' && hostLatch.descendantsExact && state.latch === 'idle'
        && state.pendingAsks.length === 0 && state.activeDescendants === 0 && tools === 0 ? 'observed' : 'unknown',
    }
    // Durable selection, else the target's own default; peers never invent one.
    // `state.lastTurnEnd.ran` says which route actually answered the turn.
    const model = state.model
      ?? readModelSelectionProjection(projections)
      ?? this.ctx.agentDefaultModel.currentSelection()
    return {
      ...state,
      stopIntent,
      model,
      ...(usage === undefined ? {} : { usage }),
      ...(budget === undefined ? {} : { budget }),
    }
  }

  /**
   * Read the host's authoritative execution latch for one Session (doc 70 §4,
   * doc 69 §8 correction 3). A missing or failing `session.executionState`
   * keeps the derived fold in charge; the host value is consumed structurally.
   */
  private hostLatchOf(sessionId: SessionId): HostLatchFacts | undefined {
    try {
      const value: unknown = this.ctx.sessionController.executionState({ sessionId })
      return readExecutionStateValue(value)
    } catch {
      // The host latch is authoritative when present and an accelerator only:
      // a cold Session or a host without the RPC falls back to the derived fold.
      return undefined
    }
  }

  private foldOf(sessionId: SessionId, observation: ObservationView): PeerLatchFold {
    const fold = new PeerLatchFold()
    for (const event of observation.events) fold.apply(event)
    fold.recordPeerAction(this.peerActions.get(sessionId))
    return fold
  }

  private async observe(sessionId: SessionId, signal?: AbortSignal): Promise<ObservationView> {
    await Promise.resolve()
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId, {
        projectionMode: 'all',
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('peer/not-found', `session ${JSON.stringify(sessionId)} was not found`, { sessionId })
      }
      throw error
    }
    try {
      return {
        header: observation.header,
        cursor: observation.cursor,
        events: [...observation.events],
        projections: observation.projections?.values as unknown as Readonly<Record<string, unknown>> | undefined,
      }
    } finally {
      observation[Symbol.dispose]()
    }
  }

  private async sessionExistsSafe(sessionId: SessionId): Promise<boolean> {
    try {
      return await this.sessionExists(sessionId)
    } catch {
      return false
    }
  }

  private async promptDispositionOf(
    sessionId: SessionId,
    alias: PeerAlias,
    requestId: string,
  ): Promise<PeerPromptDispositionResult> {
    await Promise.resolve()
    let observation: SessionObservation
    try {
      observation = await this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
    } catch {
      return { disposition: 'unknown' }
    }
    try {
      const events = [...observation.events]
      const scoped = derivePromptDisposition(events, peerPromptRpcId(alias, requestId))
      return scoped.disposition === 'unknown' ? derivePromptDisposition(events, requestId) : scoped
    } finally {
      observation[Symbol.dispose]()
    }
  }

  private formatReceiptResult(
    entry: PeerInputReceipt,
    replayedAcrossRestart: boolean,
    derived: {
      readonly disposition: PeerReceiptValue['disposition']
      readonly terminalState?: PeerReceiptValue['terminalState']
      readonly terminal?: PeerReceiptValue['terminal']
    },
  ): PeerReceiptValue {
    const base: PeerReceiptValue = {
      found: true,
      kind: entry.kind,
      sessionId: entry.sessionId,
      payloadHash: entry.payloadHash,
      instanceId: entry.instanceId,
      phase: entry.phase,
      replayedAcrossRestart,
      disposition: derived.disposition,
      acceptedAt: entry.acceptedAt,
      ...(entry.finalizedAt === undefined ? {} : { finalizedAt: entry.finalizedAt }),
    }
    if (derived.terminalState !== undefined) {
      return {
        ...base,
        terminalState: derived.terminalState,
        ...(derived.terminal === undefined ? {} : { terminal: derived.terminal }),
      }
    }
    return base
  }

  private async finalizeInputReceipt(input: {
    readonly kind: 'create' | 'prompt'
    readonly alias: PeerAlias
    readonly requestId: PeerRequestId
    readonly payloadHash: string
    readonly instanceId: string
    readonly sessionId: SessionId
    readonly created?: boolean
    readonly profile?: PeerProfileSummary
    readonly queued?: boolean
    readonly hopCount?: number
  }): Promise<void> {
    try {
      await this.inputReceipts.finalize({
        ...input,
        finalizedAt: Date.now(),
      })
    } catch (error) {
      throw receiptUnavailableError(
        'receipt-finalize-failed',
        `unable to finalize peer.${input.kind} receipt: ${error instanceof Error ? error.message : String(error)}`,
        error,
      )
    }
  }

  private async serializeInputOperation<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.inputInFlight.get(key)
    const run = previous === undefined ? fn() : previous.then(fn, fn)
    const settled = run.then(() => undefined, () => undefined)
    this.inputInFlight.set(key, settled)
    try {
      return await run
    } finally {
      if (this.inputInFlight.get(key) === settled) {
        this.inputInFlight.delete(key)
      }
    }
  }

  private async sessionExists(sessionId: SessionId): Promise<boolean> {
    await Promise.resolve()
    try {
      const observation = await this.ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
      observation[Symbol.dispose]()
      return true
    } catch (error) {
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return false
      throw error
    }
  }

  /**
   * Install routing on one Session without touching the deployment default. A
   * peer's create-time routing must affect this Session and nothing else, so
   * the selection is threaded through `session.selectModel` with
   * `persistDefault: false` (doc 70 §6, doc 72 G6); the controller's own
   * validation/normalization (resolve, append, pending-for-next-request) is
   * otherwise unchanged.
   * @param sessionId - Session the routing applies to.
   * @param request - create request carrying the routing fields.
   * @throws {@link RemoteError} `gateway/bad-request` when provider/model are incomplete.
   */
  private async applySessionRouting(sessionId: SessionId, request: PeerCreateRequest): Promise<void> {
    const provider = request.provider
    const model = request.model
    if (provider === undefined || model === undefined) {
      throw new RemoteError('gateway/bad-request', 'provider and model must be provided together', {})
    }
    await this.ctx.sessionController.selectModel({
      sessionId,
      provider,
      model,
      ...(request.chain === undefined ? {} : { chain: request.chain }),
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      persistDefault: false,
    })
  }

  private recordPeerAction(sessionId: SessionId, action: PeerParticipantAction): void {
    this.peerActions.set(sessionId, action)
  }

  private incrementFollowers(sessionId: SessionId): void {
    this.followers.set(sessionId, (this.followers.get(sessionId) ?? 0) + 1)
    this.clearWatchdog(sessionId)
  }

  private decrementFollowers(sessionId: SessionId): void {
    const next = (this.followers.get(sessionId) ?? 1) - 1
    if (next > 0) {
      this.followers.set(sessionId, next)
      return
    }
    this.followers.delete(sessionId)
    // The last follower left: an open turn with no observer is exactly what the
    // orphan watchdog exists for, so a peer that prompts and drops still gets
    // its turn bounded. Nothing to arm for an unpaired or idle session.
    let resolved: ResolvedPeerPairing | undefined
    try {
      resolved = this.resolveTarget({ kind: 'session', sessionId })
    } catch {
      // An unpaired session has no watchdog to arm; the resolve failure is the
      // signal here, not a condition to surface.
      resolved = undefined
    }
    if (resolved !== undefined && this.ctx.agents.get(sessionId)?.status === 'running') {
      this.scheduleWatchdog(resolved)
    }
  }

  private scheduleWatchdog(resolved: ResolvedPeerPairing): void {
    this.clearWatchdog(resolved.sessionId)
    const ms = this.resolved.watchdogMs
    const timer = setTimeout(() => {
      this.orphans.delete(resolved.sessionId)
      if ((this.followers.get(resolved.sessionId) ?? 0) > 0) return
      if (this.ctx.agents.get(resolved.sessionId)?.status !== 'running') return
      this.ctx.logger.warn(
        `peer-api: aborting orphaned peer turn in session ${resolved.sessionId} after ${String(ms)}ms without a follower`,
      )
      this.ctx.sessionController.cancel({ sessionId: resolved.sessionId })
    }, ms)
    timer.unref()
    this.orphans.set(resolved.sessionId, timer)
  }

  private clearWatchdog(sessionId: SessionId): void {
    const timer = this.orphans.get(sessionId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.orphans.delete(sessionId)
  }
}

function latchKey(state: PeerExecutionState): string {
  return JSON.stringify([
    state.latch,
    state.activeDescendants,
    state.descendantsExact,
    state.stopIntent,
    // Compact ask fingerprint (id, kind, since); question payloads stay out of
    // the key, and a mint or settle is a change even with no durable event.
    state.pendingAsks.map(ask => [ask.askId, ask.kind, ask.since]),
    state.lastTurnEnd?.turn ?? null,
    state.lastTurnEnd?.reason ?? null,
    state.lastParticipantAction?.at ?? null,
  ])
}

/** One compact latch line for `peer.list` rows. */
function latchSummary(latch: HostLatchFacts, pendingAskCount: number): string {
  const asks = pendingAskCount === 0 ? 'no asks' : `${String(pendingAskCount)} ask${pendingAskCount === 1 ? '' : 's'}`
  const descendants = latch.activeDescendants === 0
    ? ''
    : ` · ${String(latch.activeDescendants)} descendant${latch.activeDescendants === 1 ? '' : 's'}`
  const turn = latch.lastTurnEnd === undefined
    ? ''
    : ` · last turn ${String(latch.lastTurnEnd.turn)} ${latch.lastTurnEnd.reason}`
  return `${latch.latch} · ${asks}${descendants}${turn}`
}

/**
 * Map a failure from the create/adopt/routing stack into the peer vocabulary.
 * Peer-domain and transport-shape errors pass through unchanged; any deeper
 * code (`agent-preset/not-found`, `session/not-found`, …) becomes
 * `peer/not-found` with the original code preserved in `reason` and as cause.
 */
function createFailure(error: unknown, alias: PeerAlias): unknown {
  const code = errorCodeOf(error)
  if (error instanceof RemoteError && (code === 'gateway/bad-request' || code?.startsWith('peer/') === true)) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  return new RemoteError(
    'peer/not-found',
    `create for alias ${JSON.stringify(alias)} failed: ${code === undefined ? message : `${code} (${message})`}`,
    {
      alias,
      ...(code === undefined ? {} : { reason: code }),
    },
    { cause: error },
  )
}

/**
 * One routing refusal in the peer vocabulary. `denied` is only the offending
 * identifier, never an allow list; the message stays route-agnostic.
 */
function routingForbidden(reason: string, message: string, denied?: string): RemoteError {
  return new RemoteError('peer/forbidden', message, {
    reason,
    ...(denied === undefined ? {} : { denied }),
  })
}

/**
 * Translate a throw from the routing service into the peer vocabulary. The
 * only error with caller meaning is the service's plain `Error('invalid
 * cursor')`; everything else is a service fault that fails closed. The raw
 * message and stack never cross the wire because they can carry catalogue or
 * provider internals.
 */
function routingFailure(error: unknown): RemoteError {
  if (error instanceof Error && error.message === 'invalid cursor') {
    return new RemoteError('gateway/bad-request', 'invalid cursor', {})
  }
  return routingForbidden('routing-unavailable', 'the model routing service failed on this host')
}

/** Session request IDs are deduplicated per Session, not per alias. */
function peerPromptRpcPrefix(alias: PeerAlias): string {
  return `peer.prompt:${JSON.stringify(alias)}:`
}

function peerPromptRpcId(alias: PeerAlias, requestId: string): SessionRequestId {
  return brandString<SessionRequestId>(`${peerPromptRpcPrefix(alias)}${requestId}`)
}

/** Require a non-empty, length-bounded caller-minted request identity. */
function requireRequestId(value: unknown, method: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteError('gateway/bad-request', `${method} requires a non-empty requestId`, {})
  }
  if (value.length > maxLength) {
    throw new RemoteError(
      'gateway/bad-request',
      `${method} requestId exceeds maximum length of ${String(maxLength)}`,
      {},
    )
  }
  return value
}

function receiptUnavailableError(reason: string, message: string, cause?: unknown): RemoteError<'peer/unavailable'> {
  return new RemoteError(
    'peer/unavailable',
    message,
    { reason },
    ...(cause === undefined ? [] : [{ cause }]),
  )
}

/** Canonical SHA-256 of the four payload fields a switch hash covers. */
function selectionHash(request: PeerSelectModelRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([
      request.provider,
      request.model,
      request.chain ?? null,
      request.reasoningEffort ?? null,
    ]))
    .digest('hex')
}

/** Read one thrown value's stable error code structurally; no class is assumed. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code: unknown = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

const JOB_UPDATE_KEYS: ReadonlySet<string> = new Set([
  'alias',
  'requestId',
  'jobId',
  'fence',
  'expiresAt',
  'revoked',
])

/**
 * Reverse the binding document into one ceiling per Session, including a
 * Session a later create retired. The first recorded ceiling wins, matching
 * the pairing store's own lookup order.
 * @param bindings - the loaded created-session bindings.
 * @returns Session id to recorded ceiling; Sessions without one are absent.
 */
function ceilingsOf(bindings: LoadedPeerPairings['bindings']): Map<SessionId, number> {
  const ceilings = new Map<SessionId, number>()
  const record = (sessionId: SessionId, ceiling: number | undefined): void => {
    if (ceiling !== undefined && !ceilings.has(sessionId)) ceilings.set(sessionId, ceiling)
  }
  for (const binding of Object.values(bindings)) {
    record(binding.sessionId, binding.maxTotalTokens)
    for (const retired of binding.retired ?? []) record(retired.sessionId, retired.maxTotalTokens)
  }
  return ceilings
}

function isPeerHttpUrl(url: string | undefined): boolean {
  if (typeof url !== 'string') return false
  try {
    const pathname = new URL(url, 'http://dsh.invalid').pathname
    return pathname.startsWith('/api/peer/') || pathname.startsWith('/api/peer.')
  } catch {
    return false
  }
}

function unauthorizedError(): RemoteError<'peer/forbidden'> {
  return new RemoteError('peer/forbidden', 'peer authentication failed', { reason: 'unauthorized' })
}

function sameModelSelection(left: PeerModelSelection | undefined, right: PeerModelSelection): boolean {
  if (left === undefined) return false
  return left.provider === right.provider
    && left.model === right.model
    && (left.chain ?? undefined) === (right.chain ?? undefined)
    && (left.reasoningEffort ?? undefined) === (right.reasoningEffort ?? undefined)
}

function resolveCanonicalPath(targetPath: string): string {
  const absolute = resolve(targetPath)
  const suffix: string[] = []
  let probe = absolute
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    suffix.unshift(probe.slice(parent.length).replace(/^[/\\]+/u, ''))
    probe = parent
  }
  const base = existsSync(probe) ? realpathSync(probe) : probe
  return suffix.length === 0 ? base : resolve(base, ...suffix)
}

function resolveCreateScope(
  limits: PeerCreateDefaults,
  request: PeerCreateRequest,
): { readonly workspaceId?: string; readonly cwd?: string; readonly agentPreset?: string } {
  for (const field of ['workspaceId', 'cwd', 'agentPreset'] as const) {
    const value = request[field]
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new RemoteError('gateway/bad-request', `${field} must be a non-empty string when present`, {})
    }
  }
  if (limits.workspaceId !== undefined && request.workspaceId !== undefined && request.workspaceId !== limits.workspaceId) {
    throw routingForbidden(
      'workspace-not-allowed',
      'requested workspaceId is outside the pairing create limit',
      request.workspaceId,
    )
  }
  let resolvedCwd = request.cwd
  if (limits.cwd !== undefined && request.cwd !== undefined) {
    const pinnedBase = resolveCanonicalPath(limits.cwd)
    const targetAbsolute = isAbsolute(request.cwd) ? resolve(request.cwd) : resolve(limits.cwd, request.cwd)
    const candidateBase = resolveCanonicalPath(targetAbsolute)
    const rel = relative(pinnedBase, candidateBase)
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
      throw routingForbidden(
        'cwd-not-allowed',
        'requested cwd is outside the pairing create limit',
        request.cwd,
      )
    }
    resolvedCwd = targetAbsolute
  }
  if (request.agentPreset !== undefined) {
    if (limits.allowAgentPresets !== undefined) {
      if (!limits.allowAgentPresets.includes(request.agentPreset)) {
        throw routingForbidden(
          'preset-not-allowed',
          'requested agentPreset is not allowed by the pairing create limit',
          request.agentPreset,
        )
      }
    } else if (limits.agentPreset !== undefined && request.agentPreset !== limits.agentPreset) {
      throw routingForbidden(
        'preset-not-allowed',
        'requested agentPreset does not match the pairing create limit',
        request.agentPreset,
      )
    }
  }
  const workspaceId = request.workspaceId ?? limits.workspaceId
  const cwd = resolvedCwd ?? limits.cwd
  const agentPreset = request.agentPreset ?? limits.agentPreset
  return {
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

function requireParticipant(value: unknown, authenticatedDevice: PeerDeviceName): PeerParticipant {
  if (typeof value !== 'object' || value === null) {
    throw new RemoteError('gateway/bad-request', 'participant must be an object', {})
  }
  const record = value as Record<string, unknown>
  if (record.kind !== 'peer' || typeof record.name !== 'string' || record.name.length === 0) {
    throw new RemoteError('gateway/bad-request', 'participant must be {kind: "peer", name}', {})
  }
  if (record.device !== undefined && (typeof record.device !== 'string' || record.device.length === 0)) {
    throw new RemoteError('gateway/bad-request', 'participant.device must be a non-empty string when present', {})
  }
  if (record.device !== undefined && record.device !== authenticatedDevice) {
    throw unauthorizedError()
  }
  return {
    kind: 'peer',
    name: record.name,
    device: authenticatedDevice,
  }
}

function requirePromptContent(value: unknown): readonly { readonly type: 'text'; readonly text: string }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RemoteError('gateway/bad-request', 'prompt content must be a non-empty list', {})
  }
  return value.map((part) => {
    if (typeof part !== 'object' || part === null
      || (part as Record<string, unknown>).type !== 'text'
      || typeof (part as Record<string, unknown>).text !== 'string') {
      throw new RemoteError('gateway/bad-request', 'P2 peer prompts admit text parts only', {})
    }
    const text = (part as Record<string, unknown>).text as string
    if (text.trim().length === 0) {
      throw new RemoteError('gateway/bad-request', 'prompt text must contain non-whitespace content', {})
    }
    return { type: 'text' as const, text }
  })
}

function requireAnswer(value: unknown): PeerAnswer {
  if (typeof value !== 'object' || value === null) {
    throw new RemoteError('gateway/bad-request', 'answer must be an object', {})
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'approval') {
    if (record.outcome !== 'allowed-once' && record.outcome !== 'rejected') {
      throw new RemoteError('gateway/bad-request', 'approval outcome must be allowed-once or rejected', {})
    }
    return { kind: 'approval', outcome: record.outcome }
  }
  if (record.kind === 'question') {
    return { kind: 'question', answer: record.answer as never }
  }
  throw new RemoteError('gateway/bad-request', 'answer kind must be approval or question', {})
}
