/**
 * The calling side of the peer API, shadowed locally.
 *
 * `@deepseek-ai/dsh-api-peer/client` is not resolvable from this profile (the
 * harness package is not a profile dependency), so this module re-implements
 * the same wire semantics: the `{type:'client-request', payload:{args:{request}}}`
 * unary envelope, the `/api/remote.mux` follow stream, exponential backoff with
 * `peer.page` durable-hole repair, and the caller-owned
 * `peer/target-unreachable` failure. Ported from the harness client at
 * `packages/api/peer/src/client.ts` (same frame contract); keep the two in
 * step when the contract changes.
 *
 * The handshake's `harnessVersion` is resolved at call time (see
 * `caller-version.ts`) instead of carrying a literal that drifts from the
 * shipped release.
 *
 * @module dsh-enpoi-peer-bridge/peer-client
 */

import { resolveCallerHarnessVersion } from './caller-version.js'

/** One structured peer failure, mirroring the harness `RemoteError` surface. */
export class PeerBridgeError extends Error {
  /** Stable peer error code (`peer/*`, `gateway/*`). */
  readonly code: string
  /** Structured details from the host envelope. */
  readonly details: Readonly<Record<string, unknown>>
  /** Endpoint the failing call targeted. */
  readonly endpoint: string

  /**
   * @param code - stable error code.
   * @param message - human-readable failure.
   * @param endpoint - target base URL.
   * @param details - structured details.
   */
  constructor(code: string, message: string, endpoint: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message)
    this.name = 'PeerBridgeError'
    this.code = code
    this.details = details
    this.endpoint = endpoint
  }
}

/** Address of a peer call; resolves through the serving host's pairing file. */
export type PeerTarget = { readonly kind: 'alias'; readonly alias: string } | { readonly kind: 'session'; readonly sessionId: string }

/** Minimal WebSocket surface `follow` needs. */
export interface PeerWebSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void
}

/** Reconnect pacing for `follow`; exponential with a ceiling. */
export interface PeerBackoff {
  readonly initialMs: number
  readonly maxMs: number
  readonly factor: number
}

/**
 * A durable-history hole `peer.page` could not fill. The replay continues past
 * it; the caller decides whether to warn, retry, or stop.
 */
export interface PeerRepairHole {
  /** First missing durable seq (inclusive). */
  readonly from: number
  /** First seq after the missing range (exclusive). */
  readonly to: number
}

/** Caller configuration: one target host and its carrier details. */
export interface PeerClientOptions {
  readonly endpoint: string
  readonly device: string
  readonly headers?: Readonly<Record<string, string>>
  readonly harnessVersion?: string
  readonly schemaDigest?: string
  readonly fetch?: typeof fetch
  readonly webSocket?: (url: string) => PeerWebSocket
  readonly backoff?: PeerBackoff
  readonly maxReconnects?: number
  readonly pageSize?: number
  /** Receives a repair hole when `peer.page` cannot prove durable contiguity. */
  readonly onWarning?: (hole: PeerRepairHole) => void
  /** Receives an advisory digest mismatch without echoing untrusted wire text. */
  readonly onCompatibilityWarning?: (message: string) => void
}

/** One selectable option on a remote question. */
export interface PeerQuestionOption {
  /** User-facing label; the value `peer.answer` echoes back. */
  readonly label: string
  /** Optional extra context rendered by capable UIs. */
  readonly description?: string
}

/**
 * One question on a remote question ask. Mirrors the host's
 * `AskUserQuestionItem` wire fields; presentation-only fields the caller
 * cannot act on are not modelled.
 */
export interface PeerQuestionItem {
  /** Stable question id, echoed in the answer. */
  readonly id: string
  /** The question to display. */
  readonly question: string
  /** Optional supporting detail. */
  readonly detail?: string
  /** Optional short heading. */
  readonly header?: string
  /** Choices the caller can select; absent means a free-form answer. */
  readonly options?: readonly PeerQuestionOption[]
  /** Whether more than one option may be selected. Defaults to single-select. */
  readonly multiSelect?: boolean
}

/** One answered question; the host validates `selected` against its options. */
export interface PeerQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** The structured answer `peer.answer` carries for `kind:'question'`. */
export interface PeerQuestionAnswer {
  readonly answers: readonly PeerQuestionAnswerItem[]
}

/** One pending ask as the host reports it. */
export interface PeerPendingAsk {
  readonly kind: 'approval' | 'question'
  readonly askId: string
  readonly toolName?: string
  readonly callId?: string
  readonly reason?: string
  readonly questions?: readonly PeerQuestionItem[]
  readonly since: number
}

/** Retained ask journal entry; an answered entry does not imply the turn resumed. */
export type PeerAskRecord = PeerPendingAsk & {
  readonly alias: string
  readonly sessionId: string
  readonly instanceId: string
  readonly createdAt: number
  readonly state: 'pending' | 'answered' | 'expired' | 'cancelled'
  readonly settledAt?: number
  readonly settlementReason?: 'host-restarted' | 'local-answer' | 'local-cancelled'
  readonly answeredBy?: { readonly requestId: string; readonly payloadHash: string }
}

/** Stop intent and observed execution facts, not proof of teardown. */
export interface PeerStopIntent {
  readonly requestedAt?: number
  readonly keepInbox: true
  readonly turnState: PeerExecutionState['latch'] | 'unknown'
  readonly activeDescendants: number
  readonly descendantsExact: boolean
  readonly inFlightTools?: number
  readonly quiescence: 'unknown' | 'observed'
}

/** Aggregate execution state; the latch is the authoritative wait signal. */
export interface PeerExecutionState {
  readonly stopIntent?: PeerStopIntent
  readonly latch: 'running' | 'waiting_approval' | 'waiting_subagents' | 'idle'
  readonly since: number
  readonly source: 'host-latch' | 'derived'
  readonly activeDescendants: number
  readonly descendantsExact: boolean
  readonly pendingAsks: readonly PeerPendingAsk[]
  readonly lastTurnEnd?: {
    readonly turn: number
    readonly reason: string
    readonly at: number
    readonly error?: Record<string, unknown>
    /** Route that actually answered the turn (may differ from `model` on a rolling chain). */
    readonly ran?: { readonly provider: string; readonly model: string; readonly chain?: string; readonly hops: number }
    /** Present only on the turn the host's token ceiling stopped. */
    readonly stop?: string
  }
  readonly model?: { readonly provider: string; readonly model: string; readonly chain?: string }
  /** Token ceiling and spend; absent when the session records no ceiling. */
  readonly budget?: { readonly maxTotalTokens: number; readonly usedTokens: number; readonly exceeded: boolean; readonly metered: boolean }
}

/** Tri-state capability fact the catalogue may not know; never guessed. */
export type PeerKnown = boolean | 'unknown'

/** One selectable route with the facts a controller needs to choose it. */
export interface PeerModelInfo {
  readonly provider: string
  readonly model: string
  readonly tools: PeerKnown
  readonly vision: PeerKnown
  readonly contextWindow?: number
  readonly zeroPrice: PeerKnown
  readonly gated: PeerKnown
  readonly trainsOnData: 'yes' | 'no' | 'unknown'
  readonly reasoningEfforts: readonly string[]
}

/** One chain a controller may select, with its live member state. */
export interface PeerChainInfo {
  readonly id: string
  readonly label?: string
  readonly dynamic: boolean
  readonly members: readonly {
    readonly provider: string
    readonly model: string
    readonly state: 'ready' | 'cooldown' | 'deprecated'
    readonly cooldownUntil?: number
  }[]
}

/** Optional narrowing a caller may apply on top of the pairing policy. */
export interface PeerModelsFilter {
  readonly zeroPrice?: boolean
  readonly tools?: boolean
  readonly gated?: boolean
  readonly minContextWindow?: number
}

/** `peer.models` value: the policy-filtered page plus the policy echo. */
export interface PeerModelsValue {
  readonly chains: readonly PeerChainInfo[]
  readonly models: readonly PeerModelInfo[]
  readonly nextCursor?: string
  readonly selectableByThisAlias: {
    readonly chains: readonly string[]
    readonly models: readonly string[]
    readonly reasoningEfforts?: readonly string[]
    readonly requireZeroPrice: boolean
    readonly requireNoTraining: boolean
    readonly requireTools: boolean
    readonly allowSwitch: 'never' | 'idle-only'
  }
}

/** One applied model selection. */
export interface PeerModelSelection {
  readonly provider: string
  readonly model: string
  readonly chain?: string
  readonly reasoningEffort?: string
}

/** `peer.selectModel` value; a same-request replay reports `replayed: true`. */
export interface PeerSelectModelValue {
  readonly accepted: true
  readonly selected: PeerModelSelection
  readonly previous?: PeerModelSelection
  readonly replayed: boolean
  readonly receiptPersisted?: boolean
}

/** One durable event record on the peer wire. */
export interface PeerEventRecord {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

/** Every frame `peer/follow` carries. */
export type PeerFollowFrame =
  | {
    readonly type: 'snapshot'
    readonly target: { readonly device: string; readonly sessionId: string; readonly exposure: string; readonly alias?: string }
    readonly header: { readonly id: string; readonly version: number; readonly createdAt: number; readonly cwd?: string }
    readonly cursor: number
    readonly state: PeerExecutionState
    readonly records: readonly PeerEventRecord[]
    readonly hasMore: boolean
  }
  | { readonly type: 'event'; readonly record: PeerEventRecord; readonly cursor: number }
  | { readonly type: 'state'; readonly state: PeerExecutionState; readonly cursor: number }
  | { readonly type: 'assistant-stream'; readonly frame: unknown }
  | PeerFollowGapFrame
  | { readonly type: 'end'; readonly reason: 'closed' | 'target-detached' }

/** Follow generation lost continuity; reopen and repair before proceeding. */
export interface PeerFollowGapFrame {
  readonly type: 'gap'
  readonly fromSeq: number | null
  readonly toSeq: number | null
  readonly reason: 'queue-overflow' | 'sequence-discontinuity' | 'upstream-closed' | 'open-timeout' | 'idle-timeout' | 'lifetime-limit'
  readonly resync: 'refollow-and-page'
}

/** `peer.handshake` value. */
export interface PeerHandshakeValue {
  readonly protocolVersion: number
  readonly harnessVersion: string
  readonly schemaDigest: string
  readonly methodsDigest?: string
  readonly instanceId?: string
  readonly hostDevice: string
  readonly capabilities: readonly string[]
  readonly pairings: readonly {
    readonly alias: string
    readonly peer: string
    readonly exposure: string
    readonly tokenRequired: boolean
    readonly target?: { readonly sessionId: string }
  }[]
}

/** `peer.state` value. */
export interface PeerStateValue {
  readonly target: { readonly device: string; readonly sessionId: string; readonly exposure: string; readonly alias?: string }
  readonly state: PeerExecutionState
  readonly cursor: number
}

/** One pairing row `peer.list` reports. */
export interface PeerListEntry {
  readonly alias: string
  readonly peer: string
  readonly exposure: string
  readonly bound: boolean
  /** Session the host exposes; the caller's `remoteSessionId`. */
  readonly sessionId?: string
  /** Caller-role pin echoed from a shared pairing document, when declared. */
  readonly remoteSessionId?: string
  readonly latch?: string
  readonly lastActivity?: number
  readonly summary: string
}

/** `peer.list` value. */
export interface PeerListValue {
  readonly hostDevice: string
  readonly pairings: readonly PeerListEntry[]
}

/** `peer.create` value. */
export interface PeerCreateValue {
  readonly target: { readonly device: string; readonly sessionId: string; readonly exposure: string; readonly alias?: string }
  readonly created: boolean
  readonly replayed?: boolean
  readonly payloadHash?: string
  readonly instanceId?: string
  readonly profile?: PeerProfileSummary
}

/** Worker profile attested by the host. */
export interface PeerProfileSummary { readonly hash: string; readonly presetId: string }

/** Upper bounds declared by a worker job. */
export interface PeerJobLimits {
  readonly maxSteps?: number
  readonly maxToolCalls?: number
  readonly maxWallMs?: number
  readonly maxTotalTokens?: number
}

/** Non-secret worker scope carried on create. */
export interface PeerCreateJobRequest {
  readonly jobId: string
  readonly fence: number
  readonly expiresAt: number
  readonly capabilities: readonly string[]
  readonly limits: PeerJobLimits
  readonly mcpEndpointId?: string
  readonly credentialRef?: string
  readonly allowedToolNames?: readonly string[]
}

/** Committed worker scope, including revocation and the host that bound it. */
export interface PeerJobBinding extends PeerCreateJobRequest {
  readonly sessionId: string
  readonly alias: string
  readonly instanceId: string
  readonly createdAt: number
  readonly revoked?: boolean
  readonly revokedAt?: number
}

/** Operations covered by peer input receipts. */
export type PeerInputReceiptKind = 'create' | 'prompt'
/** Host-derived state of the prompt, not the session's aggregate latch. */
export type PeerPromptDisposition = 'queued' | 'claimed' | 'cancelled_before_dispatch' | 'terminal' | 'unknown'
/** Terminal classification from the prompt receipt, distinct from a raw turn/end reason. */
export type PeerTerminalOutcome = 'completed' | 'aborted' | 'failed' | 'budget' | 'blocked' | 'max-tokens' | 'interrupted'
/** Prompt admission or replay response. */
export interface PeerPromptValue {
  readonly accepted: true
  readonly queued: boolean
  readonly hopCount: number
  readonly replayed?: boolean
  readonly payloadHash?: string
  readonly instanceId?: string
  readonly disposition?: PeerPromptDisposition
  readonly terminalState?: PeerTerminalOutcome
  readonly terminal?: PeerExecutionState['lastTurnEnd']
}

/** Durable create/prompt receipt lookup with host-derived disposition. */
export interface PeerReceiptValue {
  readonly found: boolean
  readonly kind?: PeerInputReceiptKind
  readonly sessionId?: string
  readonly payloadHash?: string
  readonly instanceId?: string
  readonly phase?: 'prepared' | 'finalized'
  readonly replayedAcrossRestart: boolean
  readonly disposition: PeerPromptDisposition | 'created' | 'adopted'
  readonly terminalState?: PeerTerminalOutcome
  readonly terminal?: PeerExecutionState['lastTurnEnd']
  readonly acceptedAt?: number
  readonly finalizedAt?: number
}

/** Authenticated worker readiness; an unbound alias may not attest a profile yet. */
export interface PeerReadyValue {
  readonly ready: boolean
  readonly missing: readonly string[]
  readonly capabilities: readonly string[]
  readonly profile?: PeerProfileSummary
  readonly instanceId: string
  readonly version: string
}

/** Bounded inventory of regular files under the session export root. */
export interface PeerExportListValue {
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly mtimeMs: number }[]
  readonly truncated: boolean
}

/** Export bytes and the host's claimed size and digest; verify before use. */
export interface PeerExportFetchValue {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly contentBase64: string
}

// Baseline from packages/api/peer/src/wire-schema.ts for the standalone caller.
const SCHEMA_DIGEST = '599b07e200d7a174273a735675729383f40e6edfa3fdfc9afb2842dd8e106d86'
const METHODS_DIGEST = '43cd7b31db35f5a557e10ec65debe4b3308e11597cf17a1656a0145fe2a4e87e'

/** Peer participant attribution sent on every peer-originated call. */
export interface PeerParticipant {
  readonly kind: 'peer'
  readonly name: string
  readonly device?: string
}

const DEFAULT_BACKOFF: PeerBackoff = { initialMs: 250, maxMs: 4_000, factor: 2 }
const REPAIR_PAGE_LIMIT = 20
const GAP_RECONNECT_LIMIT = 3

/**
 * Error frames that cannot be fixed by retrying the same follow: the pairing,
 * session, or exposure is gone or refused. A healthy reconnect cannot change
 * them, so `follow` surfaces them instead of reconnecting at backoff cadence.
 */
const CALLER_TERMINAL_CODES: ReadonlySet<string> = new Set([
  'gateway/bad-request',
  'peer/version-skew',
  'peer/not-paired',
  'peer/not-found',
  'peer/forbidden',
])

interface WireFrame {
  readonly streamId: string
  readonly type: 'item' | 'error' | 'end'
  readonly value?: unknown
}

/**
 * Client bridge one device uses to drive, observe, and answer a peer's Session.
 * One instance is cheap; `follow` owns its socket per generation.
 */
export class PeerClient {
  private readonly endpoint: string
  private readonly headers: Readonly<Record<string, string>>
  private readonly fetchImpl: typeof fetch
  private readonly webSocketFactory: (url: string) => PeerWebSocket
  private readonly backoff: PeerBackoff
  private readonly maxReconnects: number | undefined
  private readonly pageSize: number
  private boundedFollow: boolean | undefined

  /**
   * @param options - target endpoint, identity, and carrier replacements.
   */
  constructor(private readonly options: PeerClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/u, '')
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.webSocketFactory = options.webSocket ?? defaultWebSocket
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    this.maxReconnects = options.maxReconnects
    this.pageSize = options.pageSize ?? 50
  }

  /** Negotiate against the target; a protocol mismatch surfaces `peer/version-skew`. */
  async handshake(): Promise<PeerHandshakeValue> {
    const schemaDigest = this.options.schemaDigest ?? SCHEMA_DIGEST
    const value = await this.rpc<PeerHandshakeValue>('handshake', {
      protocolVersion: 1,
      harnessVersion: this.options.harnessVersion ?? resolveCallerHarnessVersion(),
      schemaDigest,
      device: this.options.device,
    })
    this.boundedFollow = value.capabilities.includes('bounded-follow')
    if (value.capabilities.includes('shape-digest') && value.schemaDigest !== schemaDigest) {
      this.options.onCompatibilityWarning?.('peer handshake schemaDigest differs from this caller')
    }
    const methodsDigest = value.methodsDigest ?? (value.capabilities.includes('shape-digest') ? undefined : value.schemaDigest)
    if (methodsDigest && methodsDigest !== METHODS_DIGEST) {
      this.options.onCompatibilityWarning?.('peer handshake methodsDigest differs from this caller')
    }
    return value
  }

  /** Read the latch for one target. */
  state(target: PeerTarget): Promise<PeerStateValue> {
    return this.rpc('state', { target })
  }

  /** List the pairings the host exposes, optionally narrowed to one resolved target. */
  list(request: { readonly target?: PeerTarget } = {}): Promise<PeerListValue> {
    return this.rpc('list', request)
  }

  /**
   * Read the policy-filtered chains and models one alias may select.
   * @param request - alias, participant, optional filter, cursor, and page limit.
   * @returns selectable chains/models with the policy echoed for the controller.
   */
  models(request: {
    readonly alias: string
    readonly participant: PeerParticipant
    readonly filter?: PeerModelsFilter
    readonly cursor?: string
    readonly limit?: number
  }): Promise<PeerModelsValue> {
    return this.rpc('models', request)
  }

  /** Create or adopt a Session under a pairing alias. */
  create(request: {
    readonly alias: string
    readonly participant: PeerParticipant
    readonly requestId?: string
    readonly sessionId?: string
    readonly workspaceId?: string
    readonly cwd?: string
    readonly agentPreset?: string
    /** Provider route the host pins on the created Session (with `model`). */
    readonly provider?: string
    /** Model id the host pins on the created Session (with `provider`). */
    readonly model?: string
    /** Model-group id the created Session's requests carry. */
    readonly chain?: string
    /** Adapter-owned reasoning effort for the pinned route. */
    readonly reasoningEffort?: string
    readonly maxTotalTokens?: number
    readonly job?: PeerCreateJobRequest
  }): Promise<PeerCreateValue> {
    return this.rpc('create', request)
  }

  /** Admit a queued peer turn. */
  prompt(request: {
    readonly target: PeerTarget
    readonly participant: PeerParticipant
    readonly requestId: string
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
    readonly hopCount?: number
  }): Promise<PeerPromptValue> {
    return this.rpc('prompt', request)
  }

  /** Read one input receipt; a missing entry does not prove non-admission. */
  receipt(request: { readonly alias: string; readonly requestId: string; readonly kind?: PeerInputReceiptKind }, signal?: AbortSignal): Promise<PeerReceiptValue> {
    return this.rpc('receipt', request, signal)
  }

  /** Rotate a fence, extend the expiry, or revoke a bound job. */
  jobUpdate(request: { readonly alias: string; readonly requestId: string; readonly jobId: string; readonly fence?: number; readonly expiresAt?: number; readonly revoked?: boolean }): Promise<{
    readonly accepted: true; readonly binding: PeerJobBinding; readonly replayed: boolean; readonly payloadHash: string; readonly instanceId: string
  }> {
    return this.rpc('jobUpdate', request)
  }

  /** Read authenticated readiness for one alias. */
  ready(request: { readonly alias: string }): Promise<PeerReadyValue> {
    return this.rpc('ready', request)
  }

  /** List metadata for a worker's export files. */
  exportList(request: { readonly alias: string }): Promise<PeerExportListValue> {
    return this.rpc('exportList', request)
  }

  /** Fetch one bounded export; the caller verifies the returned digest and size. */
  exportFetch(request: { readonly alias: string; readonly path: string; readonly maxBytes?: number }): Promise<PeerExportFetchValue> {
    return this.rpc('exportFetch', request)
  }

  /** Cancel the target's active turn. */
  cancel(request: { readonly target: PeerTarget; readonly participant: PeerParticipant }): Promise<{ readonly accepted: boolean; readonly cancelled: boolean; readonly stopIntent?: PeerStopIntent }> {
    return this.rpc('cancel', request)
  }

  /** Read retained asks for the selected alias binding. */
  asks(request: { readonly alias: string; readonly sessionId?: string }): Promise<{ readonly instanceId: string; readonly asks: readonly PeerAskRecord[] }> {
    return this.rpc('asks', request)
  }

  /** Wait for an observation, not proof of quiescence. */
  waitQuiescent(request: { readonly alias: string; readonly timeoutMs: number }): Promise<{ readonly observation: 'observed'; readonly timedOut: boolean; readonly last?: PeerStateValue }> {
    return this.rpc('waitQuiescent', request)
  }

  /** Settle a pending ask. */
  answer(request: {
    readonly target: PeerTarget
    readonly participant: PeerParticipant
    readonly askId: string
    readonly requestId: string
    readonly answer: { readonly kind: 'approval'; readonly outcome: 'allowed-once' | 'rejected' } | { readonly kind: 'question'; readonly answer: PeerQuestionAnswer }
  }): Promise<{ readonly accepted: true; readonly settled: true; readonly replayed: boolean; readonly payloadHash: string; readonly instanceId: string }> {
    return this.rpc('answer', request)
  }

  /**
   * Switch one idle Session's routing for its next turn.
   * @param request - target, participant, request id, requested route or chain, and optional effort.
   * @returns the applied selection, the previous one when known, and replay status.
   */
  selectModel(request: {
    readonly target: PeerTarget
    readonly participant: PeerParticipant
    readonly requestId: string
    readonly provider: string
    readonly model: string
    readonly chain?: string
    readonly reasoningEffort?: string
  }): Promise<PeerSelectModelValue> {
    return this.rpc('selectModel', request)
  }

  /** Read one backwards history window for repair. */
  page(request: { readonly target: PeerTarget; readonly throughSeq: number; readonly beforeSeq?: number; readonly maxMessages?: number }, signal?: AbortSignal): Promise<{ readonly records: readonly PeerEventRecord[]; readonly hasMore: boolean }> {
    return this.rpc('page', request, signal)
  }

  /**
   * Cheap reachability probe: one bounded `peer.state` read.
   *
   * A sleep, a cut link, or a dead host leaves a follow socket open and silent,
   * so the follow loop cannot tell "the host is gone" from "the model is
   * thinking" without an independent call. This answers only reachability:
   * any response — including a structured error — means reachable; only a
   * transport failure or the deadline means the host did not answer.
   * @param target - resolved peer target.
   * @param options - deadline and caller cancellation.
   * @returns true when the host answered within the deadline; false when it did not.
   */
  async probe(target: PeerTarget, options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<boolean> {
    const signals = [AbortSignal.timeout(options.timeoutMs)]
    if (options.signal !== undefined) signals.push(options.signal)
    try {
      await this.rpc('state', { target }, AbortSignal.any(signals))
      return true
    } catch (error) {
      return !(error instanceof PeerBridgeError && error.code === 'peer/target-unreachable')
    }
  }

  /**
   * Open one follow generation without reconnect handling.
   * @param request - target and window options.
   * @param signal - caller cancellation closing the socket.
   * @returns frames exactly as the host sends them.
   */
  async *followOnce(request: { readonly target: PeerTarget; readonly maxMessages?: number }, signal: AbortSignal): AsyncGenerator<PeerFollowFrame> {
    if (signal.aborted) return
    const socket = this.webSocketFactory(this.muxUrl())
    const streamId = `peer-${randomToken()}`
    const queue: WireFrame[] = []
    let wake: (() => void) | undefined
    let closed = false
    let opened = false
    const openedSocket = (): boolean => opened
    let frameNumber = 0
    let cursor: number | undefined
    const notify = (): void => {
      wake?.()
      wake = undefined
    }
    const onMessage = (event: unknown): void => {
      const text = messageText(event)
      if (text === undefined) return
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      if (typeof parsed !== 'object' || parsed === null) return
      const frame = parsed as Record<string, unknown>
      if (frame.streamId !== streamId || (frame.type !== 'item' && frame.type !== 'error' && frame.type !== 'end')) return
      queue.push({ streamId, type: frame.type, value: frame.type === 'error' ? frame.error ?? frame.value : frame.value })
      notify()
    }
    const onClose = (): void => {
      closed = true
      notify()
    }
    const isClosed = (): boolean => closed
    const onAbort = (): void => {
      closed = true
      notify()
      socket.close()
    }
    const openTimer = setTimeout(onAbort, 10_000).unref()
    const onOpen = (): void => {
      clearTimeout(openTimer)
      if (isClosed()) return
      try {
        socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'peer/follow', payload: { args: { request } } }))
        opened = true
      } catch {
        onAbort()
      }
    }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!signal.aborted) {
        const frame = queue.shift()
        if (frame === undefined) {
          if (isClosed()) {
            if (this.boundedFollow === true && openedSocket()) yield gapAfter(cursor, 'upstream-closed')
            if (!openedSocket()) throw unreachable(this.endpoint)
            return
          }
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        if (frame.type === 'item') {
          if (typeof frame.value !== 'object' || frame.value === null || !('type' in frame.value)) throw unreachable(this.endpoint)
          const value = frame.value as PeerFollowFrame
          if (value.type === 'gap' || value.type === 'end') { yield value; return }
          if ('cursor' in value) cursor = value.cursor
          try {
            yield value
          } finally {
            if (this.boundedFollow !== false && !isClosed() && !signal.aborted) {
              try { socket.send(JSON.stringify({ type: 'item', streamId, value: { type: 'ack', frame: ++frameNumber } })) } catch {
                onAbort()
              }
            }
          }
          continue
        }
        if (frame.type === 'error') {
          throw decodeFailure(frame.value, this.endpoint)
        }
        if (this.boundedFollow === true) yield gapAfter(cursor, 'upstream-closed')
        return
      }
    } finally {
      clearTimeout(openTimer)
      signal.removeEventListener('abort', onAbort)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onAbort)
      socket.close()
      if (queue.length > 0) queue.length = 0
    }
  }

  /**
   * Stream frames with automatic reconnect and durable-hole repair.
   * @param request - target and window options.
   * @param signal - caller cancellation; the only way to stop a healthy stream.
   * @returns follow frames across reconnects; repair records precede the new snapshot.
   */
  async *follow(request: { readonly target: PeerTarget; readonly maxMessages?: number }, signal: AbortSignal): AsyncGenerator<PeerFollowFrame> {
    let lastCursor: number | undefined
    let boundSession: string | undefined
    let attempt = 0
    let gapAttempts = 0
    let recovering = false
    let recoveryThrough = -1
    while (!signal.aborted) {
      let progressed = false
      let lost: PeerFollowGapFrame | undefined
      try {
        for await (const frame of this.followOnce(request, signal)) {
          if (frame.type === 'gap') {
            lost = frame
            break
          }
          progressed = true
          if (frame.type === 'snapshot') {
            if (boundSession !== undefined && frame.target.sessionId !== boundSession) {
              yield { type: 'end', reason: 'target-detached' }
              return
            }
            boundSession = frame.target.sessionId
            if (recovering && frame.cursor < recoveryThrough) {
              throw new PeerBridgeError('peer/gap', 'The follow snapshot is older than the required repair cut.', this.endpoint)
            }
            if (lastCursor !== undefined) {
              const oldest = frame.records[0]?.seq ?? frame.cursor + 1
              if (oldest > lastCursor + 1) {
                const target = { kind: 'session' as const, sessionId: frame.target.sessionId }
                yield* this.repairForward(target, lastCursor, oldest, signal, recovering)
              }
            }
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor)
            recovering = false
            recoveryThrough = -1
          } else if (frame.type === 'event') {
            if (frame.cursor > (lastCursor ?? -1)) gapAttempts = 0
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor)
          } else if (frame.type === 'state') {
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor)
          }
          yield frame
          if (frame.type === 'end') return
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof PeerBridgeError) {
          if (CALLER_TERMINAL_CODES.has(error.code)) throw error
          if (error.code === 'peer/unavailable' && error.details.reason === 'follow-capacity') {
            throw new PeerBridgeError(error.code, 'Peer follow is at capacity; back off before reopening.', this.endpoint, { reason: 'follow-capacity' })
          }
          if (error.code === 'peer/gap') lost = gapFromError(error.details.gap, lastCursor)
        }
      }
      if (signal.aborted) return
      if (lost !== undefined || recovering) {
        recovering = true
        gapAttempts += 1
        if (lost !== undefined) {
          recoveryThrough = Math.max(recoveryThrough, lost.toSeq ?? -1, lastCursor ?? -1)
          if (lost.fromSeq !== null) lastCursor = Math.min(lastCursor ?? lost.fromSeq - 1, lost.fromSeq - 1)
          else if (lastCursor === undefined && lost.toSeq !== null) lastCursor = -1
          yield lost
        }
        if (gapAttempts > Math.min(this.maxReconnects ?? GAP_RECONNECT_LIMIT, GAP_RECONNECT_LIMIT)) {
          throw new PeerBridgeError('peer/gap', 'Peer follow could not repair history within the retry limit; retry following the same request.', this.endpoint)
        }
      }
      attempt = recovering ? gapAttempts : progressed ? 1 : attempt + 1
      if (this.maxReconnects !== undefined && attempt > this.maxReconnects) {
        throw unreachable(this.endpoint)
      }
      await delay(backoffDelay(this.backoff, attempt), signal)
    }
  }

  /**
   * Fill a durable hole between two cursors by paging backwards from the newer cut.
   * A hole the pages cannot prove contiguous emits `onWarning` with the missing range.
   * @param target - resolved peer target.
   * @param fromExclusive - last durable seq the caller already folded.
   * @param toExclusive - first durable seq the caller is about to receive.
   * @param signal - caller cancellation.
   * @param strict - refuse incomplete repair after an explicit gap.
   * @returns the missing records in ascending seq order.
   */
  async *repairForward(target: PeerTarget, fromExclusive: number, toExclusive: number, signal: AbortSignal, strict = false): AsyncGenerator<PeerFollowFrame> {
    const collected: PeerEventRecord[] = []
    let throughSeq = toExclusive - 1
    let hole: PeerRepairHole | undefined
    let pages = 0
    let complete = throughSeq <= fromExclusive
    while (pages < REPAIR_PAGE_LIMIT) {
      if (signal.aborted || throughSeq <= fromExclusive) break
      const value = await this.page({ target, throughSeq, maxMessages: this.pageSize }, signal)
      pages += 1
      if (value.records.length === 0) {
        complete = !value.hasMore
        hole = { from: fromExclusive + 1, to: throughSeq + 1 }
        break
      }
      for (const record of value.records) {
        if (record.seq > fromExclusive && record.seq < toExclusive) collected.push(record)
      }
      const oldest = value.records[0]?.seq
      if (oldest === undefined || oldest <= fromExclusive + 1 || !value.hasMore) {
        complete = true
        if (oldest !== undefined && oldest > fromExclusive + 1) hole = { from: fromExclusive + 1, to: oldest }
        break
      }
      throughSeq = oldest - 1
    }
    if (strict && !complete && !signal.aborted) throw new PeerBridgeError('peer/gap', 'Peer history repair exceeded its page limit.', this.endpoint)
    if (strict) hole = undefined
    if (!strict && hole === undefined && !signal.aborted && throughSeq > fromExclusive) {
      hole = { from: fromExclusive + 1, to: throughSeq + 1 }
    }
    if (hole !== undefined) this.options.onWarning?.(hole)
    collected.sort((left, right) => left.seq - right.seq)
    for (const record of collected) yield { type: 'event', record, cursor: record.seq }
  }

  private async rpc<T>(method: string, args: unknown, signal?: AbortSignal): Promise<T> {
    const endpoint = `${this.endpoint}/api/peer/${method}`
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `peer-${randomToken()}`,
          method: `peer/${method}`,
          // SRC-derived host descriptors name the business parameter `request`.
          payload: { args: { request: args } },
        }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      throw unreachable(this.endpoint, error)
    }
    if (!response.ok) {
      throw new PeerBridgeError('peer/target-unreachable', `peer ${method} failed over HTTP ${String(response.status)}`, this.endpoint, { endpoint: this.endpoint })
    }
    let body: {
      readonly result?: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
    }
    try {
      body = await response.json()
    } catch (error) {
      throw unreachable(this.endpoint, error)
    }
    const result = body?.result
    if (result?.ok !== true && result?.ok !== false) {
      throw new PeerBridgeError('gateway/internal', `peer ${method} returned no result envelope`, this.endpoint, { reason: 'missing-result-envelope' })
    }
    if (result.ok) return result.value
    throw decodeFailure(result.error, this.endpoint)
  }

  private muxUrl(): string {
    const url = new URL(this.endpoint)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/api/remote.mux'
    url.search = ''
    return url.toString()
  }
}

function gapAfter(cursor: number | undefined, reason: PeerFollowGapFrame['reason'] = 'sequence-discontinuity'): PeerFollowGapFrame {
  return { type: 'gap', fromSeq: cursor === undefined ? null : cursor + 1, toSeq: null, reason, resync: 'refollow-and-page' }
}

function gapFromError(wire: unknown, cursor: number | undefined): PeerFollowGapFrame {
  const gap = gapAfter(cursor)
  if (typeof wire !== 'object' || wire === null || !('type' in wire) || wire.type !== 'gap') return gap
  const fromSeq = 'fromSeq' in wire && typeof wire.fromSeq === 'number' && Number.isSafeInteger(wire.fromSeq) ? wire.fromSeq : gap.fromSeq
  const toSeq = 'toSeq' in wire && typeof wire.toSeq === 'number' && Number.isSafeInteger(wire.toSeq) ? wire.toSeq : null
  return { ...gap, fromSeq, toSeq }
}

/** Raise the caller-side unreachable failure with its transport cause. */
export function unreachable(endpoint: string, cause?: unknown): PeerBridgeError {
  const error = new PeerBridgeError('peer/target-unreachable', `peer target ${endpoint} is unreachable`, endpoint, { endpoint })
  if (cause !== undefined) (error as { cause?: unknown }).cause = cause
  return error
}

/** Restore one structured peer failure from the wire envelope. */
function decodeFailure(value: unknown, endpoint: string): PeerBridgeError {
  if (typeof value !== 'object' || value === null) return unreachable(endpoint)
  const record = value as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code : 'gateway/internal'
  const message = typeof record.message === 'string' ? record.message : 'peer call failed'
  const details = typeof record.details === 'object' && record.details !== null
    ? record.details as Readonly<Record<string, unknown>>
    : {}
  return new PeerBridgeError(code, message, endpoint, details)
}

function defaultWebSocket(url: string): PeerWebSocket {
  const ctor = Reflect.get(globalThis, 'WebSocket') as (new (url: string) => PeerWebSocket) | undefined
  if (ctor === undefined) throw new Error('peer client: no global WebSocket; inject one through PeerClientOptions.webSocket')
  return new ctor(url)
}

function messageText(event: unknown): string | undefined {
  if (typeof event === 'string') return event
  if (typeof event !== 'object' || event === null) return undefined
  const data = Reflect.get(event, 'data') as unknown
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  return undefined
}

function randomToken(): string {
  return globalThis.crypto.randomUUID()
}

function backoffDelay(backoff: PeerBackoff, attempt: number): number {
  const scaled = backoff.initialMs * backoff.factor ** Math.max(0, attempt - 1)
  return Math.min(backoff.maxMs, Math.round(scaled))
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
