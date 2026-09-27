/**
 * Host Remote owner for the configuration surfaces over the settings-domain
 * seams. Two namespaces: `settings`, the redacted reads and writes of
 * `ctx.settings`, owned by the class below; and `credentials`, mounted from
 * here as its own plugin.
 *
 * @module @deepseek-ai/dsh-api-settings-controller
 */

import { Context } from '@deepseek-ai/cordis'
import {
  openNativeTextFile,
} from '@deepseek-ai/dsh-native-command'
import type { SettingsDescriptor, SettingsPathOp, SettingsForms } from '@deepseek-ai/dsh-settings'
import type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-settings/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { CredentialsController } from './credentials.ts'
import type { SettingsArtifactView, SettingsDocumentOpenValue } from './types.ts'

export { CredentialsController } from './credentials.ts'
export type * from './types.ts'

const settingsNamespaceRequestSchema = z.object({ ns: z.string().min(1) })
const settingsArtifactRequestSchema = z.object({
  key: z.string().min(1),
  knownRevision: z.number().int().nonnegative().optional(),
})

/** One queued host write; coalesced callers settle on the same promise. */
interface QueuedWrite {
  mode: 'update' | 'replace' | 'mutate'
  input: Record<string, JsonValue> | SettingsPathOpView[]
  expectedRevision: number | undefined
  readonly settled: PromiseWithResolvers<SettingsNamespaceView>
}

/** Read abort state afresh after an awaited provider or opener call. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Host integrations replaceable by direct unit tests. */
export interface SettingsControllerInternals {
  /** Host text-editor integration used to open the settings document. */
  readonly openTextFile?: (path: string, signal: AbortSignal) => Promise<void>
}

/**
 * Project one redacted descriptor onto its wire view, field by field. The
 * Gateway returns a business result without decoding it, so a provider whose
 * descriptor carried extra enumerable properties would otherwise serialize them
 * to the caller.
 * @param descriptor - one descriptor read under `redactSecrets`.
 * @returns the same facts with nothing else attached.
 */
function namespaceView(descriptor: SettingsDescriptor): SettingsNamespaceView {
  return {
    ns: String(descriptor.ns),
    autoGenerate: descriptor.autoGenerate,
    schema: descriptor.schema as JsonValue,
    value: descriptor.value as JsonValue,
    ...descriptor.base === undefined ? {} : { base: descriptor.base as JsonValue },
    ...descriptor.user === undefined ? {} : { user: descriptor.user as JsonValue },
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map(secret => ({ path: [...secret.path], set: secret.set })),
    revision: descriptor.revision,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `settings` Remote namespace. */
    settingsController: SettingsController
  }
}

/**
 * Host service backing the generated `ctx.remote.settings` namespace. Every
 * remote read uses `redactSecrets: true`, so a `role('secret')` field cannot
 * ride a response. Writes expose the settings service's merge, replacement,
 * and path-addressed operations, and classify every provider refusal as
 * `settings/conflict` or `settings/rejected` with the service's message.
 */
export class SettingsController extends TypertRemoteService {
  private readonly openTextFile: (path: string, signal: AbortSignal) => Promise<void>
  /** Per-namespace write queues; one commit runs at a time. */
  private readonly writeQueues = new Map<string, QueuedWrite[]>()
  /** Namespaces with a commit in flight; a running drain picks queued writes up itself. */
  private readonly writing = new Set<string>()

  /**
   * Register the settings namespace and mount the credentials namespace beside
   * it. Both namespaces stay registered when a provider is absent so calls can
   * return the configuration API's actionable missing-provider diagnostic.
   * @param ctx - Host context where settings and credential providers may be mounted.
   */
  constructor(ctx: Context, internals: SettingsControllerInternals = {}) {
    super(ctx, 'settingsController', { namespace: 'settings' })
    this.openTextFile = internals.openTextFile ?? openNativeTextFile
    ctx.plugin(CredentialsController)
  }

  /**
   * Describe every registered namespace for a configuration page: redacted
   * layered values plus the serialized schema the page renders its form from.
   * @returns provider writability, local-document presence, and one view per namespace.
   * @throws RemoteError when no settings provider is mounted.
   */
  @Remote
  describe(): SettingsDescribeValue {
    const settings = this.provider()
    return {
      writable: settings.writable,
      hasDocument: true,
      namespaces: settings.describe({ redactSecrets: true }).map(namespaceView),
    }
  }

  /**
   * Answer one namespace's redacted view from the service's cached generation,
   * so a reader that consumes a single namespace does not transfer the rest.
   * @param ns - namespace key to read.
   * @returns the namespace's redacted view, or `undefined` when no active entry carries it.
   * @throws RemoteError when the request is invalid or no provider is mounted.
   */
  @Remote
  describeNamespace(ns: string): SettingsNamespaceView | undefined {
    const parsed = settingsNamespaceRequestSchema.safeParse({ ns })
    if (!parsed.success) {
      throw new RemoteError('gateway/bad-request', 'invalid payload for settings.describeNamespace', { issues: parsed.error.issues })
    }
    const descriptor = this.provider().describeNamespace(parsed.data.ns, { redactSecrets: true })
    return descriptor === undefined ? undefined : namespaceView(descriptor)
  }

  /**
   * Read one published settings artifact. Derived values are published beside
   * the document through `settings.publishArtifact`, so a change to them never
   * forces a document revision, reload, or whole-document read.
   * @param key - artifact name.
   * @param knownRevision - revision the caller holds; a match answers `changed: false` without the value.
   * @returns the artifact read, or `undefined` when the key was never published.
   * @throws RemoteError when the request is invalid or no provider is mounted.
   */
  @Remote
  describeArtifact(key: string, knownRevision: number | undefined): SettingsArtifactView | undefined {
    const parsed = settingsArtifactRequestSchema.safeParse({ key, knownRevision })
    if (!parsed.success) {
      throw new RemoteError('gateway/bad-request', 'invalid payload for settings.describeArtifact', { issues: parsed.error.issues })
    }
    const artifact = this.provider().readArtifact(parsed.data.key)
    if (artifact === undefined) return undefined
    const changed = parsed.data.knownRevision !== artifact.revision
    return {
      key: parsed.data.key,
      revision: artifact.revision,
      changed,
      ...changed ? { value: artifact.value as JsonValue } : {},
    }
  }

  /**
   * Merge a patch into one namespace's stored user section.
   * @param ns - namespace key to write.
   * @param patch - fields to merge into the user section.
   * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
   * @returns the namespace's redacted view after the write.
   * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
   */
  @Remote
  update(
    ns: string,
    patch: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    return this.write(ns, 'update', patch, expectedRevision)
  }

  /**
   * Replace one namespace's stored user section wholesale.
   * @param ns - namespace key to write.
   * @param section - complete replacement user section.
   * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
   * @returns the namespace's redacted view after the write.
   * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
   */
  @Remote
  replace(
    ns: string,
    section: Record<string, JsonValue>,
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    return this.write(ns, 'replace', section, expectedRevision)
  }

  /**
   * Apply path-addressed edits to one namespace's user section, resolved against
   * the section as stored rather than against whatever the caller last read,
   * then answer with that namespace's new redacted view.
   * @param ns - namespace key to write.
   * @param ops - the edits to apply, in order.
   * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
   * @returns the namespace's redacted view after the write.
   * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
   */
  @Remote
  async mutate(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    return this.write(ns, 'mutate', ops, expectedRevision)
  }

  /**
   * Materialize the provider-owned settings document and open it in a native text editor.
   * @param signal - caller lifetime; abort terminates preparation or the native command.
   * @returns confirmation after the native opener accepts the document.
   * @throws RemoteError when no document exists, preparation fails, or opening fails.
   */
  @Remote
  async openSettingsDocument(signal: AbortSignal): Promise<SettingsDocumentOpenValue> {
    const settings = this.provider()
    if (isAborted(signal)) throw new RemoteError('gateway/cancelled', 'settings document open was aborted', {})
    let path: string
    try {
      path = await settings.prepareDocument()
    } catch (error: unknown) {
      if (isAborted(signal)) throw new RemoteError('gateway/cancelled', 'settings document preparation was aborted', {})
      throw new RemoteError('gateway/internal', `settings document preparation failed: ${messageOf(error)}`, {}, { cause: error })
    }
    if (isAborted(signal)) throw new RemoteError('gateway/cancelled', 'settings document open was aborted', {})
    try {
      await this.openTextFile(path, signal)
      return { opened: true }
    } catch (error: unknown) {
      if (isAborted(signal)) throw new RemoteError('gateway/cancelled', 'settings document open was aborted', {})
      throw new RemoteError('gateway/internal', `path open failed: ${messageOf(error)}`, {}, { cause: error })
    }
  }

  /**
   * Queue one namespace write. Writes to one namespace run one at a time;
   * requests issued before the queued `mutate` tail starts commit — including a
   * burst in one turn — fold into that single commit, whose operations run in
   * arrival order, and every coalesced caller receives its resulting view (or
   * its refusal). A different mode or a different `expectedRevision` starts its
   * own queued commit, so a caller's revision fence is never widened by another
   * caller's write.
   * @param ns - namespace key to write.
   * @param mode - seam operation.
   * @param input - patch, section, or path ops for the operation.
   * @param expectedRevision - revision the caller read; `undefined` writes unconditionally.
   * @returns the namespace's redacted view after the commit that carries this request.
   * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
   */
  private write(
    ns: string,
    mode: 'update' | 'replace' | 'mutate',
    input: Record<string, JsonValue> | SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    const parsed = settingsNamespaceRequestSchema.safeParse({ ns })
    if (!parsed.success) {
      return Promise.reject(new RemoteError('gateway/bad-request', `invalid payload for settings.${mode}`, { issues: parsed.error.issues }))
    }
    const namespace = parsed.data.ns
    const queue = this.writeQueues.get(namespace)
    const tail = queue?.at(-1)
    // Only a queued-but-not-yet-started request can absorb more operations: one
    // commit at a time is shifted off the queue before it starts, so the tail is
    // always still pending.
    if (tail !== undefined && tail.mode === 'mutate' && mode === 'mutate' && tail.expectedRevision === expectedRevision) {
      tail.input = [...tail.input as SettingsPathOpView[], ...input as SettingsPathOpView[]]
      return tail.settled.promise
    }
    const entry: QueuedWrite = { mode, input, expectedRevision, settled: Promise.withResolvers() }
    if (queue === undefined) this.writeQueues.set(namespace, [entry])
    else queue.push(entry)
    // Defer the drain one microtask so requests issued together in one turn
    // fold into the same commit instead of racing it.
    if (!this.writing.has(namespace)) queueMicrotask(() => { void this.flush(namespace) })
    return entry.settled.promise
  }

  /** Run the queue for one namespace until it drains. */
  private async flush(namespace: string): Promise<void> {
    this.writing.add(namespace)
    try {
      for (;;) {
        const queue = this.writeQueues.get(namespace)
        const entry = queue?.shift()
        if (queue !== undefined && queue.length === 0) this.writeQueues.delete(namespace)
        if (entry === undefined) return
        try {
          entry.settled.resolve(await this.commit(namespace, entry.mode, entry.input, entry.expectedRevision))
        } catch (error: unknown) {
          entry.settled.reject(error)
        }
      }
    } finally {
      this.writing.delete(namespace)
    }
  }

  /** Execute one queued write against the settings provider. */
  private async commit(
    namespace: string,
    mode: 'update' | 'replace' | 'mutate',
    input: Record<string, JsonValue> | SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsNamespaceView> {
    const settings = this.provider()
    try {
      if (mode === 'update') await settings.update(namespace, input, expectedRevision)
      else if (mode === 'replace') await settings.replace(namespace, input, expectedRevision)
      else await settings.mutate(namespace, input as SettingsPathOp[], expectedRevision)
    } catch (error: unknown) {
      throw rejected(namespace, error)
    }
    const descriptor = settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === namespace)
    if (descriptor === undefined) {
      // The write committed but the namespace vanished before this read: only a
      // concurrent registrant disposal can produce it.
      throw new RemoteError('gateway/internal', `settings namespace "${namespace}" was disposed after the ${mode}`, {})
    }
    return namespaceView(descriptor)
  }

  /** Resolve the optional provider or report how to supply it. */
  private provider(): SettingsForms {
    const settings = this.ctx.get('settings')
    if (settings === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'settings service is absent: mount @deepseek-ai/dsh-settings with @deepseek-ai/dsh-config-editor in the profile composition',
        {},
      )
    }
    return settings
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface SettingsConflict {
  readonly code: 'SETTINGS_CONFLICT'
  readonly message: string
  readonly expected: number
  readonly actual: number
}

function settingsConflictOf(error: unknown): SettingsConflict | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if (Reflect.get(error, 'code') !== 'SETTINGS_CONFLICT'
    || typeof Reflect.get(error, 'message') !== 'string'
    || typeof Reflect.get(error, 'expected') !== 'number'
    || typeof Reflect.get(error, 'actual') !== 'number') return undefined
  return error as SettingsConflict
}

/**
 * Classify one seam refusal. A stale writer is its own outcome, not a malformed
 * request: the client must re-read and re-apply rather than treat the write as
 * invalid.
 * @param ns - the namespace the write addressed.
 * @param error - whatever the seam threw.
 * @returns the failure to raise for that refusal.
 */
function rejected(ns: string, error: unknown): RemoteError {
  const conflict = settingsConflictOf(error)
  if (conflict !== undefined) {
    return new RemoteError(
      'settings/conflict',
      conflict.message,
      { ns, expected: conflict.expected, actual: conflict.actual },
      { cause: error },
    )
  }
  return new RemoteError('settings/rejected', messageOf(error), { ns }, { cause: error })
}

export default SettingsController
