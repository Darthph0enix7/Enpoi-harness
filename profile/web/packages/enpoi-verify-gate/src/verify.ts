/**
 * dsh-enpoi-verify-gate — decision core (defect: "completed" turn whose own
 * last verification failed).
 *
 * The rule, in one line: at `turn/end` with reason `completed`, if the turn's
 * last verification-ish tool result was a failure, the turn ended unverified.
 *
 * What counts as verification-ish:
 * - the execution/editor surfaces (`bash`, `pwsh`, `str_replace_editor`), or
 * - any tool result carrying structured facts: a tool-owned `meta.exitCode`
 *   (bash/pwsh's `ShellOutcomeMeta`) or a structured `error` identity.
 *
 * What never counts: results of orchestration control-plane tools
 * ({@link CONTROL_PLANE_TOOLS}) — child dispatch, goal, and inter-agent
 * message tools. A capacity rejection or an unavailable approval is a
 * dispatch/control fact, not a failure of the work the turn is verifying.
 *
 * What counts as a failure:
 * - `meta.exitCode` present and not 0 (null means signal-killed), or
 * - a structured `error` (name/code/reason), or
 * - the tool-result block's `isError === true`, or
 * - a recognised failure text in the rendered output (`[exit code: N]`,
 *   `FAILED`, `AssertionError`, `Traceback …`, `command not found`, …).
 *
 * Pure and dependency-free so the decision is unit-testable without a live
 * harness; `index.ts` is the only place that touches sessions/agents.
 *
 * @module dsh-enpoi-verify-gate/verify
 */

/** Fork event emitted for one unverified turn (log-only, enveloped `ignorable`). */
export const VERIFY_UNMET_EVENT = 'verify/unmet'

/** Gate behaviour mode: record-only (default) or one-shot follow-up prompt. */
export type VerifyGateMode = 'record' | 'prompt'

/** Resolved gate configuration for one turn end. */
export interface GateConfig {
  readonly mode: VerifyGateMode
  readonly promptOnce: boolean
}

/** Hard default — record-only, never injects. */
export const DEFAULT_GATE_CONFIG: GateConfig = Object.freeze({ mode: 'record', promptOnce: false })

/** Tools whose results are verification-ish even without structured facts. */
export const VERIFICATION_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh', 'str_replace_editor'])

/**
 * Orchestration/dispatch-plane tools. A result from one of these tools is a
 * control-flow fact (child admitted or rejected, goal read, message delivered,
 * agent interrupted) and never evidence about the state of the work the turn is
 * verifying. Their results are excluded from the gate entirely — even a
 * structured `error` such as `ACTIVATION_LIMIT_REACHED` or a `message.isError`
 * approval failure. Only failures of the verified work count; a dispatch error
 * is classified as control-plane, not as a failed verification.
 */
export const CONTROL_PLANE_TOOLS: ReadonlySet<string> = new Set([
  'subagent',
  'task',
  'create_goal',
  'get_goal',
  'update_goal',
  'send_message',
  'interrupt_agent',
  'list_agents',
])

/** Why one tool result is classified as a verification failure. */
export type VerifyFailureReason = 'exit-code' | 'tool-error' | 'is-error' | 'failure-text'

/** Structural facts read from one `tool/result` event payload. */
export interface ToolResultFacts {
  /** Tool name resolved through the paired `tool/call` (unknown when unpaired). */
  readonly tool?: string | undefined
  /** Call id the result answers (`data.callId` or `data.message.source.callId`). */
  readonly callId?: string | undefined
  /** Turn the result belongs to. */
  readonly turn?: number | undefined
  /** Structured failure identity (`data.error`), when present. */
  readonly error?: unknown
  /** Tool-private metadata (`data.meta`); bash/pwsh carry `exitCode` here. */
  readonly meta?: unknown
  /** Native V4 `message.isError` flag on the tool-role message. */
  readonly isError?: boolean | undefined
  /** Rendered model-facing text (all top-level text blocks joined). */
  readonly text?: string | undefined
}

/** One classified verification failure inside one turn. */
export interface VerifyFailure {
  readonly turn: number
  readonly tool: string
  readonly callId?: string
  /** Process exit code; `null` when a signal killed the command. */
  readonly exitCode?: number | null
  readonly reason: VerifyFailureReason
  /** Bounded, whitespace-collapsed failure line (≤ {@link PREVIEW_CHARS}). */
  readonly messagePreview: string
}

/** Durable `verify/unmet` fork-event payload (no released union is changed). */
export interface VerifyUnmetRecord {
  readonly turn: number
  readonly tool: string
  readonly callId?: string
  readonly exitCode?: number | null
  readonly reason: VerifyFailureReason
  readonly messagePreview: string
}

/** One verification-ish tool result observed for a turn. */
export interface VerifyObservation {
  readonly turn: number
  /** The failure when the result failed; absent when it passed. */
  readonly failure?: VerifyFailure
}

/** Preview bound for `messagePreview` (spec: ≤200 chars, no secrets). */
export const PREVIEW_CHARS = 200

/**
 * Recognised failure text for results that carry no structured outcome.
 * Deliberately narrow: exit markers, test-runner failure lines, and the
 * common interpreter/runtime failure headers.
 */
export const FAILURE_TEXT_PATTERN =
  /\[exit code:\s*[1-9][0-9]*\]|\bFAILED\b|AssertionError|Traceback \(most recent call last\)|\b(?:npm|pnpm|yarn) ERR!|\bcommand not found\b|^\s*Error:/

/** ANSI SGR escapes are stripped from previews (never persisted as colour noise). */
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read `meta.exitCode` when the tool attached one.
 * @param meta - `tool/result` `meta` payload.
 * @returns the numeric exit code, `null` for a signal-killed process, or
 *   `undefined` when the result carries no exit fact (e.g. background handle).
 */
export function readExitCode(meta: unknown): number | null | undefined {
  const record = asRecord(meta)
  if (record === undefined || !('exitCode' in record)) return undefined
  const value = record.exitCode
  if (value === null) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

/**
 * Bound one failure line for the record: strip ANSI, collapse whitespace, keep
 * the most failure-relevant line (the first line matching the failure pattern,
 * else the last non-empty line), and truncate to {@link PREVIEW_CHARS}.
 * @param text - rendered tool output.
 * @param max - preview cap.
 * @returns the bounded preview (`''` when no text is available).
 */
export function previewFailureText(text: string | undefined, max: number = PREVIEW_CHARS): string {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text
    .replaceAll(ANSI_PATTERN, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
  const chosen = lines.find(line => FAILURE_TEXT_PATTERN.test(line)) ?? lines.at(-1) ?? ''
  const collapsed = chosen.replaceAll(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`
}

/**
 * Classify one `tool/result` event payload.
 * @param facts - structural facts extracted from the event.
 * @returns the observation when the result is verification-ish, otherwise
 *   `undefined` (the call does not participate in the gate).
 */
export function observeToolResult(facts: ToolResultFacts): VerifyObservation | undefined {
  const tool = typeof facts.tool === 'string' && facts.tool !== '' ? facts.tool : 'unknown'
  const turn = typeof facts.turn === 'number' && Number.isFinite(facts.turn) ? Math.trunc(facts.turn) : 0
  // Control/dispatch-plane results never participate: they neither fail nor
  // clear a verification (D3). A rejected dispatch is not a failed check.
  if (CONTROL_PLANE_TOOLS.has(tool)) return undefined
  const exitCode = readExitCode(facts.meta)
  const errorRecord = asRecord(facts.error)
  const structuredError = errorRecord !== undefined
  if (!VERIFICATION_TOOLS.has(tool) && !structuredError && exitCode === undefined) return undefined

  const callId = typeof facts.callId === 'string' && facts.callId !== '' ? facts.callId : undefined
  const base = {
    turn,
    tool,
    ...(callId === undefined ? {} : { callId }),
  }

  if (exitCode !== undefined && exitCode !== 0) {
    return {
      turn,
      failure: {
        ...base,
        exitCode,
        reason: 'exit-code',
        messagePreview: previewFailureText(facts.text),
      },
    }
  }

  if (structuredError) {
    const reason = typeof errorRecord.reason === 'string' && errorRecord.reason !== ''
      ? errorRecord.reason
      : undefined
    return {
      turn,
      failure: {
        ...base,
        ...(exitCode === undefined ? {} : { exitCode }),
        reason: 'tool-error',
        messagePreview: previewFailureText(reason ?? facts.text),
      },
    }
  }

  if (facts.isError === true) {
    return {
      turn,
      failure: {
        ...base,
        ...(exitCode === undefined ? {} : { exitCode }),
        reason: 'is-error',
        messagePreview: previewFailureText(facts.text),
      },
    }
  }

  if (typeof facts.text === 'string' && FAILURE_TEXT_PATTERN.test(facts.text)) {
    return {
      turn,
      failure: {
        ...base,
        ...(exitCode === undefined ? {} : { exitCode }),
        reason: 'failure-text',
        messagePreview: previewFailureText(facts.text),
      },
    }
  }

  return { turn }
}

/** Per-session gate state retained across turns. */
export interface GateSessionState {
  /** Turn of the most recent verification-ish result seen. */
  lastTurn: number
  /** The failure for {@link lastTurn}; cleared by a later passing result. */
  last?: VerifyFailure
  /** Consecutive unverified endings already prompted (0 = none, ≥1 = spent). */
  promptedUnverified: number
  /** Whether this session ever received a prompt (for `promptOnce`). */
  promptedEver: boolean
}

/** One `turn/end` input for the decision. */
export interface TurnEndInput {
  readonly sessionId: string
  readonly turn: number
  /** Durable turn terminal kind (`completed`, `aborted`, `error`, …). */
  readonly reason: string
  readonly config: GateConfig
}

/** One `turn/end` decision: what to record, whether to inject a follow-up. */
export interface TurnEndDecision {
  readonly record?: VerifyUnmetRecord
  /** True only in `prompt` mode, once per unverified streak (or once ever with `promptOnce`). */
  readonly prompt: boolean
}

/** Hard bound on tracked sessions (oldest insertion evicted first). */
export const MAX_TRACKED_SESSIONS = 500

/**
 * Per-session verification tracker. `index.ts` feeds it every `tool/result`
 * and asks it at every `turn/end`; it owns no I/O and never throws.
 */
export class VerifyGateTracker {
  private readonly sessions = new Map<string, GateSessionState>()

  /**
   * Record one observed (verification-ish) tool result.
   * @param sessionId - owning session.
   * @param observation - classification from {@link observeToolResult}; a
   *   non-verification result must be passed as `undefined`.
   */
  noteToolResult(sessionId: string, observation: VerifyObservation | undefined): void {
    if (observation === undefined) return
    const state = this.state(sessionId)
    if (observation.turn < state.lastTurn) return
    state.lastTurn = observation.turn
    if (observation.failure === undefined) delete state.last
    else state.last = observation.failure
  }

  /**
   * Decide what one turn ending means.
   *
   * Records only when the turn ended `completed` AND its last verification-ish
   * result failed. A second consecutive unverified ending is recorded, never
   * re-prompted; any other ending (verified, aborted, error, …) resets the
   * streak. The per-turn failure is consumed, so a duplicate boundary cannot
   * double-record.
   * @param input - turn terminal facts plus the resolved config.
   * @returns the record to persist and whether to inject one follow-up.
   */
  noteTurnEnd(input: TurnEndInput): TurnEndDecision {
    const state = this.sessions.get(input.sessionId)
    if (state === undefined) return { prompt: false }
    const failure = state.lastTurn === input.turn ? state.last : undefined
    delete state.last
    if (input.reason !== 'completed' || failure === undefined) {
      state.promptedUnverified = 0
      return { prompt: false }
    }
    const record: VerifyUnmetRecord = {
      turn: failure.turn,
      tool: failure.tool,
      ...(failure.callId === undefined ? {} : { callId: failure.callId }),
      ...(failure.exitCode === undefined ? {} : { exitCode: failure.exitCode }),
      reason: failure.reason,
      messagePreview: failure.messagePreview,
    }
    let prompt = false
    if (input.config.mode === 'prompt') {
      const allowed = state.promptedUnverified < 1
        && (!input.config.promptOnce || !state.promptedEver)
      if (allowed) {
        prompt = true
        state.promptedEver = true
      }
      state.promptedUnverified = Math.min(state.promptedUnverified + 1, 2)
    }
    return { record, prompt }
  }

  /** Read one session's state (tests/diagnostics); never creates one. */
  stateOf(sessionId: string): GateSessionState | undefined {
    return this.sessions.get(sessionId)
  }

  private state(sessionId: string): GateSessionState {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = { lastTurn: -1, promptedUnverified: 0, promptedEver: false }
      this.sessions.set(sessionId, state)
      if (this.sessions.size > MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value
        if (oldest !== undefined && oldest !== sessionId) this.sessions.delete(oldest)
      }
    }
    return state
  }
}
