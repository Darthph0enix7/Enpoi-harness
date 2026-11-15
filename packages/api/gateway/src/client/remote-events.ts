/** Client owner for forwarded Remote Event subscriptions and deliveries. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  ConnectionGenerationSource,
  ConnectionHostInfo,
  ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  TypertClientEventListener,
  TypertOwnedValue,
  TypertRemoteEvent,
} from '@deepseek-ai/dsh-typert-protocol'
import { isRemoteJsonValue, isTypertOwnedValue } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_EVENT_STREAM_ENDPOINT,
  REMOTE_EVENT_STREAM_PAYLOAD,
  type RemoteEventClientLimits,
  isRemoteEventAgentId,
  isRemoteEventClientId,
  isRemoteEventId,
  projectRemoteEventRejection,
  type RemoteEventClientId,
  type RemoteEventDownlinkFrame,
  type RemoteEventEmitFrame,
  type RemoteEventInvocationFrame,
  type RemoteEventResult,
} from '../stream-protocol.ts'

/** Open the Gateway-internal forwarded-event stream on the selected carrier. */
export type RemoteEventStreamOpener = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => AsyncIterable<unknown>

/** One subscribed listener after its event-specific signature is erased. */
type RemoteEventListener = (this: Context, ...args: unknown[]) => unknown

/** Untyped access used only for instance-private Cordis event keys. */
interface PrivateEventContext {
  on(name: string, listener: RemoteEventListener): () => boolean
  parallel(name: string, ...args: unknown[]): Promise<void>
  waterfall(
    thisArg: Context,
    name: string,
    request: Readonly<Record<string, unknown>>,
    next: () => Promise<symbol>,
  ): unknown
}

/** Transport outcome after one Client listener chain either claims or delegates. */
type RemoteEventReplyOutcome =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'next' }
  | { readonly kind: 'rejected'; readonly error: ReturnType<typeof projectRemoteEventRejection> }

/** Private end-of-chain marker that cannot collide with a JSON listener result. */
const REMOTE_EVENT_NEXT = Symbol('api-gateway.remote-event.next')

/**
 * Cross-bundle marker Connection uses to stop automatic recovery. The
 * registered symbol is the shared protocol contract, so this bundle does not
 * import Connection's runtime value.
 */
const TERMINAL_CONNECTION_FAILURE = Symbol.for('dsh.connection.terminal-failure')

/**
 * Build one terminal generation failure carrying Connection's shared marker.
 * @param message - actionable diagnosis surfaced through the Connection state.
 * @returns an Error that Connection treats as non-retryable across bundles.
 */
function terminalConnectionError(message: string): Error {
  const error = new Error(message)
  error.name = 'ConnectionTerminalError'
  Object.defineProperty(error, TERMINAL_CONNECTION_FAILURE, { value: true })
  return error
}

/** Default concurrent listener tasks (answers plus emits) one generation may launch. */
export const DEFAULT_REMOTE_EVENT_MAX_ACTIVE_TASKS = 64

/** Default retirement threshold: a new generation is refused once this many abandoned listener tasks remain. */
export const DEFAULT_REMOTE_EVENT_MAX_RETIRED_TASKS = 4

/**
 * Resolve validated forwarded-event client limits from the Host's page
 * bootstrap. Missing values keep the bounded defaults; malformed values fail
 * activation instead of silently disabling the resource bound.
 * @param input - page-global limit object.
 * @returns complete listener-task budgets.
 */
export function resolveRemoteEventLimits(input: unknown = {}): RemoteEventClientLimits {
  if (input !== undefined && (typeof input !== 'object' || input === null)) {
    throw new RangeError('client api: forwarded Remote event limits must be an object')
  }
  const record = input as Record<string, unknown>
  return {
    maxActiveTasks: limitBound(record.maxActiveTasks, DEFAULT_REMOTE_EVENT_MAX_ACTIVE_TASKS, 'maxActiveTasks'),
    maxRetiredTasks: limitBound(record.maxRetiredTasks, DEFAULT_REMOTE_EVENT_MAX_RETIRED_TASKS, 'maxRetiredTasks'),
  }
}

/** Resolve one positive integer listener-task bound, failing loud on a bad bootstrap value. */
function limitBound(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`client api: forwarded Remote event ${name} must be a positive integer`)
  }
  return value
}

/** Per-generation capability; revoked before teardown so late work cannot answer or write. */
interface DeliveryCapability {
  active: boolean
}

/** Read through a call so TypeScript's narrowing cannot outlive an await. */
function deliveryCurrent(capability: DeliveryCapability, signal: AbortSignal): boolean {
  return capability.active && !signal.aborted
}

/** Own Cordis registrations, generation pumping, waterfall dispatch, and HTTP replies. */
export class ClientRemoteEvents {
  private readonly eventPrefix = `internal/api-gateway/remote-event/${randomUUID()}/`
  private readonly unregisterGeneration: () => void
  private readonly retiredTasks = new Set<Promise<void>>()
  private readonly maxActiveTasks: number
  private readonly maxRetiredTasks: number
  private activeGeneration: Promise<void> | undefined
  private generationActivity: (() => void) | undefined
  private generationHeartbeat: (() => void) | undefined

  /**
   * @param ownerCtx - Client Gateway root used for Agent Context resolution.
   * @param connection - Connection carrier used for HTTP result calls.
   * @param openStream - selected in-process or WebSocket stream opener.
   */
  constructor(
    private readonly ownerCtx: Context,
    private readonly connection: ConnectionHandle,
    private readonly openStream: RemoteEventStreamOpener,
    limits: RemoteEventClientLimits = resolveRemoteEventLimits(),
  ) {
    this.maxActiveTasks = limits.maxActiveTasks
    this.maxRetiredTasks = limits.maxRetiredTasks
    this.unregisterGeneration = connection.registerGenerationSource(this.runGeneration)
  }

  /**
   * Register one typed Remote Event listener in its calling fiber.
   * @param callerCtx - fiber Context owning the registration.
   * @param event - selected forwarded event.
   * @param listener - listener derived from that event's declaration.
   * @returns disposer for this exact registration.
   */
  subscribe<Event extends TypertRemoteEvent>(
    callerCtx: Context,
    event: Event,
    listener: TypertClientEventListener<Event>,
  ): () => void {
    const dispose = privateEvents(callerCtx).on(
      this.eventKey(event),
      listener as RemoteEventListener,
    )
    return () => { dispose() }
  }

  /** Withdraw the generation source and wait for active listener work to quiesce. */
  async dispose(): Promise<void> {
    this.unregisterGeneration()
    await Promise.allSettled([this.activeGeneration])
  }

  /**
   * Report one inbound frame on any logical stream of the current physical
   * carrier to the active generation's Connection liveness timestamp.
   */
  reportActivity(): void {
    this.generationActivity?.()
  }

  /**
   * Report one inbound application heartbeat frame on any logical stream of
   * the current physical carrier to the active generation. It also counts as
   * activity and arms that generation's silence watchdog.
   */
  reportHeartbeat(): void {
    this.generationHeartbeat?.()
  }

  /** Track the current generation so plugin disposal waits for listener work to stop. */
  private readonly runGeneration: ConnectionGenerationSource = (signal, ready, activity, heartbeat) => {
    if (this.retiredTasks.size >= this.maxRetiredTasks) {
      return Promise.reject(terminalConnectionError(
        `client api: forwarded Remote event resources are exhausted (${String(this.retiredTasks.size)} abandoned listener tasks, threshold ${String(this.maxRetiredTasks)}); reload the page to reset recovery`,
      ))
    }
    this.generationActivity = activity
    this.generationHeartbeat = heartbeat
    const tracked = this.pumpEvents(signal, ready, activity).finally(() => {
      if (this.activeGeneration !== tracked) return
      this.activeGeneration = undefined
      this.generationActivity = undefined
      this.generationHeartbeat = undefined
    })
    this.activeGeneration = tracked
    return tracked
  }

  /** Deliver one notification through Cordis while containing listener failures. */
  private deliver(frame: RemoteEventEmitFrame): Promise<void> {
    return privateEvents(this.ownerCtx)
      .parallel(this.eventKey(frame.event), ...frame.args)
      .catch((error: unknown) => { this.reportError(frame.event, error) })
  }

  /** Run one Connection generation over the forwarded-event logical stream. */
  private async pumpEvents(
    signal: AbortSignal,
    ready: (host: ConnectionHostInfo) => void,
    activity: () => void,
  ): Promise<void> {
    let clientId: RemoteEventClientId | undefined
    const capability: DeliveryCapability = { active: true }
    const failed = new AbortController()
    const generationSignal = AbortSignal.any([signal, failed.signal])
    const active = new Map<string, AbortController>()
    const tasks = new Set<Promise<void>>()
    const activeTasks = new Set<Promise<void>>()
    const source = this.openStream(
      REMOTE_EVENT_STREAM_ENDPOINT,
      REMOTE_EVENT_STREAM_PAYLOAD,
      generationSignal,
    )
    const iterator = source[Symbol.asyncIterator]()
    let streamFailed = false
    let streamError: unknown
    try {
      while (true) {
        const step = await raceIteratorNext(iterator, generationSignal)
        if (step.kind === 'aborted') break
        if (step.result.done === true) break
        const value = step.result.value
        activity()
        if (clientId === undefined) {
          const opening = parseRemoteEventReady(value)
          clientId = opening.clientId
          ready(opening.host)
          continue
        }
        const frame = parseRemoteEventFrame(value)
        if (frame.type === 'cancel') {
          active.get(frame.eventId)?.abort(new Error('client api: Remote event was cancelled by the Host'))
          continue
        }
        this.admitListenerTask(activeTasks)
        if (frame.type === 'emit') {
          this.trackListenerTask(this.deliver(frame), activeTasks)
          continue
        }
        const controller = new AbortController()
        active.set(frame.eventId, controller)
        const deliverySignal = AbortSignal.any([generationSignal, controller.signal])
        const delivery = this.answer(frame, clientId, deliverySignal, capability)
          .catch((error: unknown) => {
            if (!deliverySignal.aborted) failed.abort(error)
          })
          .finally(() => {
            active.delete(frame.eventId)
            activeTasks.delete(delivery)
            this.retiredTasks.delete(delivery)
          })
        this.trackListenerTask(delivery, activeTasks)
        // The generation owns the forward-event task through its signal, not
        // the listener's cooperation: the tracked promise settles on abort so
        // teardown cannot hang on an ignored cancellation.
        const task = raceDeliveryWithAbort(delivery, deliverySignal)
        tasks.add(task)
        const forget = (): void => { tasks.delete(task) }
        void task.then(forget, forget)
      }
    } catch (error) {
      streamFailed = true
      streamError = error
    } finally {
      capability.active = false
      for (const controller of active.values()) {
        controller.abort(new Error('client api: Remote event generation ended'))
      }
      // Only tasks still unresolved after cancellation become retired work;
      // settled cooperative tasks never consume the abandoned budget.
      for (const task of activeTasks) this.retireListenerTask(task)
      try {
        const returned = iterator.return?.()
        /* v8 ignore next -- a stream opener's optional return may reject after the consumer stopped waiting; containment is deliberate */
        void Promise.resolve(returned).catch(() => undefined)
      } catch {
        // A synchronous iterator return failure is already terminal work.
      }
      await Promise.allSettled(tasks)
    }
    if (failed.signal.aborted) {
      throw toError(failed.signal.reason, 'client api: Remote event result delivery failed')
    }
    if (signal.aborted) return
    if (streamFailed) throw streamError
    throw new Error('client api: forwarded Remote event stream ended unexpectedly')
  }

  /** Reject one frame before it launches work when the active-task budget is full. */
  private admitListenerTask(activeTasks: ReadonlySet<Promise<void>>): void {
    if (activeTasks.size < this.maxActiveTasks) return
    throw terminalConnectionError(
      `client api: forwarded Remote event listener capacity reached (${String(this.maxActiveTasks)} active tasks); reload the page to reset recovery`,
    )
  }

  /** Track one in-flight emit or answer for the current generation. */
  private trackListenerTask(task: Promise<void>, activeTasks: Set<Promise<void>>): void {
    activeTasks.add(task)
    const forget = (): void => { activeTasks.delete(task) }
    void task.then(forget, forget)
  }

  /** Retire one task that stayed unresolved after its generation was aborted. */
  private retireListenerTask(task: Promise<void>): void {
    this.retiredTasks.add(task)
    const forget = (): void => { this.retiredTasks.delete(task) }
    void task.then(forget, forget)
  }

  private async answer(
    frame: RemoteEventInvocationFrame,
    clientId: RemoteEventClientId,
    signal: AbortSignal,
    capability: DeliveryCapability,
  ): Promise<void> {
    const adapter = this.ownerCtx.typert.contexts.getClient('agent')
    let resolved: Context | TypertOwnedValue<Context> | undefined
    try {
      resolved = adapter?.resolve(frame.agentId)
    } catch (error) {
      this.reportError(frame.event, error)
    }
    const owned = isTypertOwnedValue(resolved) ? resolved : undefined
    try {
      const target = isTypertOwnedValue(resolved) ? resolved.value : resolved
      let outcome: RemoteEventReplyOutcome = { kind: 'next' }
      if (target !== undefined) {
        try {
          outcome = await this.dispatchWaterfall(target, frame, signal)
        } catch (error) {
          if (!deliveryCurrent(capability, signal)) return
          outcome = { kind: 'rejected', error: projectRemoteEventRejection(error) }
        }
      }
      // A retired generation never answers, even if its listener eventually
      // resolves; that late result must not overwrite the replacement's Host state.
      if (!deliveryCurrent(capability, signal)) return
      const result: RemoteEventResult = {
        clientId,
        eventId: frame.eventId,
        outcome: outcome.kind === 'result' && outcome.value === undefined
          ? { kind: 'result' }
          : outcome,
      }
      const response = await this.connection.rpc.call(
        '/api',
        REMOTE_EVENT_RESULT_ENDPOINT,
        { args: result },
        signal,
      )
      if (!deliveryCurrent(capability, signal)) return
      if (!response.ok) throw new Error(response.error.message)
    } finally {
      owned?.[Symbol.dispose]()
    }
  }

  private async dispatchWaterfall(
    target: Context,
    frame: RemoteEventInvocationFrame,
    signal: AbortSignal,
  ): Promise<RemoteEventReplyOutcome> {
    const request = {
      ...frame.request,
      agent: target,
      signal,
    }
    // Cancellation reaches the handler, whose Context remains owned until it settles.
    const value = await privateEvents(target).waterfall(
      target,
      this.eventKey(frame.event),
      request,
      () => Promise.resolve(REMOTE_EVENT_NEXT),
    )
    if (value !== REMOTE_EVENT_NEXT && value !== undefined && !isRemoteJsonValue(value)) {
      throw new TypeError('Remote event listener result is not lossless JSON data')
    }
    return value === REMOTE_EVENT_NEXT
      ? { kind: 'next' }
      : { kind: 'result', value }
  }

  private eventKey(event: string): string {
    return `${this.eventPrefix}${event}`
  }

  private reportError(event: string, error: unknown): void {
    console.error(`client api: Remote event ${JSON.stringify(event)} listener threw:`, error)
  }
}

/** Validate and return one generation's Client identity and Host facts. */
function parseRemoteEventReady(value: unknown): {
  readonly clientId: RemoteEventClientId
  readonly host: ConnectionHostInfo
} {
  if (!isRemoteEventRecord(value)
    || !hasExactRemoteEventKeys(value, ['type', 'clientId', 'host'])
    || value.type !== 'ready'
    || !isRemoteEventClientId(value.clientId)
    || !isRemoteEventRecord(value.host)
    || !hasExactRemoteEventKeys(value.host, ['home'])
    || typeof value.host.home !== 'string') {
    throw new TypeError('client api: forwarded Remote event stream did not begin with ready')
  }
  return { clientId: value.clientId, host: { home: value.host.home } }
}

/** Validate one untrusted value from the Gateway-internal forwarded-event stream. */
function parseRemoteEventFrame(value: unknown): Exclude<RemoteEventDownlinkFrame, { type: 'ready' }> {
  if (!isRemoteEventRecord(value)) invalidRemoteEventFrame()
  if (value.type === 'cancel'
    && hasExactRemoteEventKeys(value, ['type', 'eventId'])
    && isRemoteEventId(value.eventId)) {
    return { type: 'cancel', eventId: value.eventId }
  }
  if (value.type === 'emit'
    && hasExactRemoteEventKeys(value, ['type', 'event', 'args'])
    && validRemoteEventName(value.event)
    && Array.isArray(value.args)
    && isRemoteJsonValue(value.args)) {
    return { type: 'emit', event: value.event, args: value.args }
  }
  if (value.type === 'waterfall'
    && hasExactRemoteEventKeys(value, ['type', 'event', 'eventId', 'agentId', 'request'])
    && validRemoteEventName(value.event)
    && isRemoteEventId(value.eventId)
    && isRemoteEventAgentId(value.agentId)
    && isRemoteEventRecord(value.request)
    && !Object.hasOwn(value.request, 'agent')
    && !Object.hasOwn(value.request, 'signal')
    && isRemoteJsonValue(value.request)) {
    return {
      type: 'waterfall',
      event: value.event,
      eventId: value.eventId,
      agentId: value.agentId,
      request: value.request,
    }
  }
  invalidRemoteEventFrame()
}

function isRemoteEventRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactRemoteEventKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validRemoteEventName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function invalidRemoteEventFrame(): never {
  throw new TypeError('client api: invalid forwarded Remote event frame')
}

function privateEvents(ctx: Context): PrivateEventContext {
  return ctx
}

function toError(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message, { cause: reason })
}

/** One source pull outcome: a real iterator result or generation cancellation. */
type IteratorStep =
  | { readonly kind: 'next'; readonly result: IteratorResult<unknown> }
  | { readonly kind: 'aborted' }

/**
 * Race one asynchronous operation with a cancellation signal. The tracked
 * promise settles on abort even when the operation ignores it; a late
 * settlement is handled, never leaked as an unhandled rejection.
 * @param operation - work to start now.
 * @param signal - cancellation signal.
 * @param aborted - value returned when cancellation wins.
 * @param rejectionMessage - fallback description for a non-Error rejection.
 * @returns the operation result or the abort value.
 */
function raceWithAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  aborted: T,
  rejectionMessage: string,
): Promise<T> {
  if (signal.aborted) return Promise.resolve(aborted)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => { finish(() => { resolve(aborted) }) }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve().then(operation).then(
      (value) => { finish(() => { resolve(value) }) },
      (error: unknown) => { finish(() => { reject(toError(error, rejectionMessage)) }) },
    )
  })
}

/**
 * Race one source pull with generation cancellation. A stream opener that
 * ignores abort can leave `next()` pending forever; the tracked step still
 * settles on abort so teardown and disposal stay bounded.
 * @param iterator - opened forwarded-event stream.
 * @param signal - generation cancellation.
 * @returns the next item or an abort settlement.
 */
function raceIteratorNext(iterator: AsyncIterator<unknown>, signal: AbortSignal): Promise<IteratorStep> {
  return raceWithAbort<IteratorStep>(
    async () => ({ kind: 'next', result: await iterator.next() }),
    signal,
    { kind: 'aborted' as const },
    'client api: forwarded Remote event stream read failed',
  )
}

/**
 * Race one owned listener task with its delivery cancellation. The returned
 * promise always settles when the signal aborts, so generation teardown waits
 * only for cooperative work; a listener that never observes the signal stays
 * retired and cannot answer or mutate the current generation.
 * @param delivery - listener task with its own error containment.
 * @param signal - generation or per-invocation cancellation signal.
 * @returns settlement or prompt cancellation of the tracked task.
 */
export function raceDeliveryWithAbort(delivery: Promise<void>, signal: AbortSignal): Promise<void> {
  return raceWithAbort(
    () => delivery,
    signal,
    undefined,
    'client api: Remote event listener task failed',
  )
}
