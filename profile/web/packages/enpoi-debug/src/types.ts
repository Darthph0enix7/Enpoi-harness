/**
 * dsh-enpoi-debug — structural types for the doc 69 §9.1 read surface.
 *
 * The plugin compiles standalone inside the web profile, so it restates the
 * host RPC shapes it reads (`session.digest`, `session.requestSnapshot`,
 * `session.executionState`, `diagnostics.list`) instead of importing the host
 * packages. The fields are exactly the wire fields; a host-side rename would
 * fail this plugin visibly at the boundary, not silently.
 *
 * @module dsh-enpoi-debug/types
 */

/** Aggregate execution latch of one Session. */
export type SessionLatch = 'running' | 'waiting_approval' | 'waiting_subagents' | 'idle'

/** Structured turn failure preserved from a durable `turn/end`. */
export interface TurnError {
  readonly code: string
  readonly message: string
  readonly provider?: string
  readonly model?: string
}

/** One turn terminal with its durable reason. */
export interface TurnTerminal {
  readonly turn: number
  readonly reason: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted'
  readonly at: number
  readonly error?: TurnError
}

/** One pending ask a human must settle. */
export type PendingAsk =
  | {
    readonly kind: 'approval'
    readonly askId: string
    readonly toolName: string
    readonly callId?: string
    readonly reason?: string
    readonly since: number
  }
  | {
    readonly kind: 'question'
    readonly askId: string
    readonly questions: readonly {
      readonly id: string
      readonly question: string
      readonly detail?: string
      readonly header?: string
      readonly options?: readonly { readonly label: string; readonly description?: string }[]
      readonly multiSelect?: boolean
    }[]
    readonly since: number
  }

/** One attributed human or peer action. */
export interface ParticipantAction {
  readonly action: 'prompt' | 'cancel'
  readonly actor: unknown
  readonly at: number
}

/** Current routing selection. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly chain?: string
}

/** Host-published execution state (`session.executionState`). */
export interface ExecutionStateValue {
  readonly latch: SessionLatch
  readonly since: number
  readonly source: 'host-latch'
  readonly activeDescendants: number
  readonly descendantsExact: boolean
  readonly pendingAsks: readonly PendingAsk[]
  readonly lastTurnEnd?: TurnTerminal
  readonly lastParticipantAction?: ParticipantAction
  readonly model?: ModelSelection
}

/** One recent tool call in a Session digest. */
export interface DigestToolCall {
  readonly tool: string
  readonly status: 'ok' | 'error' | 'running'
  readonly error?: { readonly name: string; readonly code: string; readonly reason?: string }
  readonly argumentPreview?: string
  readonly resultPreview?: string
}

/** One durable pre-commit attempt failure (model-group link / pool identity). */
export interface DigestFailure {
  readonly seq: number
  readonly provider: string
  readonly model: string
  readonly code: string
  readonly message: string
  readonly link?: number
  readonly identity?: string
  readonly next?: { readonly provider: string; readonly model: string }
}

/** One injected context block. */
export interface DigestInjection {
  readonly kind: string
  readonly label?: string
  readonly chars: number
  readonly seq: number
}

/** One child in the subagent tree. */
export interface DigestSubagent {
  readonly childSessionId: string
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
  readonly quiet: boolean
  readonly status: 'running' | 'idle' | 'inactive'
  readonly queryPreview?: string
}

/** The one-call debug digest (`session.digest`). */
export interface DigestValue {
  readonly sessionId: string
  readonly state: ExecutionStateValue
  readonly model?: ModelSelection
  readonly lastParticipantAction?: ParticipantAction
  /** Hosts that predate the failure facts omit this; newer hosts send it. */
  readonly recentFailures?: readonly DigestFailure[]
  readonly recentToolCalls: readonly DigestToolCall[]
  readonly injectionIndex: readonly DigestInjection[]
  readonly subagentTree: readonly DigestSubagent[]
  readonly pendingInteractions: readonly PendingAsk[]
}

/** One request message's summary row. */
export interface SnapshotMessage {
  readonly role: string
  readonly chars: number
}

/** Request-snapshot response shared fields. */
export interface SnapshotBase {
  readonly capturedAt: number
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly system: { readonly chars: number; readonly sha256: string } | null
  readonly tools: readonly string[]
  readonly messages: readonly SnapshotMessage[]
  readonly bodiesIncluded: boolean
}

/** Secret-bearing bodies behind the explicit opt-in. */
export interface SnapshotBodies {
  readonly system: string | null
  readonly tools: readonly unknown[]
  readonly messages: readonly unknown[]
}

/** Full snapshot response (`includeBodies: true`). */
export interface SnapshotValue extends SnapshotBase {
  readonly bodiesIncluded: boolean
  readonly bodiesOmitted?: 'size-cap'
  readonly bodies?: SnapshotBodies
}

/** One incident row from `diagnostics.list`. */
export interface IncidentRow {
  readonly at: number
  readonly severity: string
  readonly source: string
  readonly kind: string
  readonly code: string
  readonly message: string
  readonly count?: number
  readonly sessionId?: string
}

/** `diagnostics.list` value. */
export interface IncidentListValue {
  readonly generatedAt: number
  readonly items: readonly IncidentRow[]
}

/** The request form of each host call the plugin reads through. */
export interface DebugSources {
  digest(request: { readonly sessionId: string; readonly recentTools?: number }): Promise<DigestValue>
  requestSnapshot(request: { readonly sessionId: string; readonly includeBodies?: boolean }): Promise<SnapshotValue>
  executionState?(request: { readonly sessionId: string }): Promise<ExecutionStateValue>
  incidents?(limit: number): Promise<IncidentListValue | undefined>
}
