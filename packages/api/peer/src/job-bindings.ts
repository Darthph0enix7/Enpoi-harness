/**
 * Non-secret job-binding validation, persistence, and Cordis lookup service.
 *
 * Every worker job binding is persisted atomically (`0600`) in
 * `peer-job-bindings.json`, keyed by `SessionId`, alongside bounded
 * `peer.jobUpdate` idempotency receipts. Expired and revoked records remain
 * readable so guards and export handlers always observe `expiresAt` and
 * `revoked` and fail closed.
 *
 * @module @deepseek-ai/dsh-api-peer/job-bindings
 */

import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { PeerConfigError } from './pairings.ts'
import type {
  PeerAlias,
  PeerCreateJobRequest,
  PeerJobBinding,
  PeerJobBindingsService,
  PeerJobLimits,
  PeerJobUpdateRequest,
  PeerJobUpdateValue,
  PeerRequestId,
  PeerWorkerPolicy,
} from './types.ts'

/** Default machine-written job-binding document path. */
export const DEFAULT_JOB_BINDINGS_PATH = dshHomePath('peer-job-bindings.json')

const PRIVATE_MODE = 0o600
const JOB_KEYS: ReadonlySet<string> = new Set([
  'jobId',
  'fence',
  'expiresAt',
  'capabilities',
  'limits',
  'mcpEndpointId',
  'credentialRef',
  'allowedToolNames',
])
const JOB_LIMIT_KEYS: ReadonlySet<string> = new Set([
  'maxSteps',
  'maxToolCalls',
  'maxWallMs',
  'maxTotalTokens',
])
const CREDENTIAL_REF_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._/-]*)?$/u
const TOKEN_LIKE_PREFIXES: readonly string[] = [
  'sk-',
  'sk_',
  'pk_',
  'ghp_',
  'gho_',
  'ghs_',
  'ghu_',
  'github_pat_',
  'glpat-',
  'xoxb-',
  'xoxp-',
  'xoxa-',
  'akia',
  'asia',
  'aiza',
  'eyj',
  'bearer',
  'basic',
]
const HEX_DIGEST_LIKE = /^[0-9a-f]{32,}$/iu
const CONTROL_OR_WHITESPACE = /\p{Cc}|\s/u

/** Bounds applied while validating a `peer.create` `job` payload. */
export interface JobValidationBounds {
  readonly jobIdMaxLength: number
  readonly jobMaxTtlMs: number
  readonly jobIdentifierMaxLength: number
  readonly jobCapabilitiesMax: number
  readonly jobToolsMax: number
}

/** Validated and policy-checked job specification ready for binding creation. */
export interface ValidatedCreateJob {
  readonly jobId: string
  readonly fence: number
  readonly expiresAt: number
  readonly capabilities: readonly string[]
  readonly limits: PeerJobLimits
  readonly mcpEndpointId?: string
  readonly credentialRef?: string
  readonly allowedToolNames?: readonly string[]
}

/** Persisted idempotency receipt for one `peer.jobUpdate` mutation. */
export interface PeerJobUpdateReceipt {
  readonly key: string
  readonly alias: PeerAlias
  readonly requestId: PeerRequestId
  readonly payloadHash: string
  readonly value: PeerJobUpdateValue
  readonly at: number
}

/**
 * Validate that a `credentialRef` is a handle name only and never a literal
 * credential, URL, token, or assignment expression.
 * @param value - candidate credential reference string.
 * @param maxLength - maximum permitted character length.
 * @returns true only when `value` matches the strict handle-name rules.
 */
export function isValidCredentialRefName(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false
  if (value.includes('://') || value.includes('@') || value.includes('=') || value.includes('$') || value.includes('?')) {
    return false
  }
  if (!CREDENTIAL_REF_CHARSET.test(value)) return false
  if (HEX_DIGEST_LIKE.test(value)) return false
  const segments = value.toLowerCase().split(/[:/]/u)
  for (const prefix of TOKEN_LIKE_PREFIXES) {
    if (segments.some(segment => segment.startsWith(prefix) || HEX_DIGEST_LIKE.test(segment))) return false
  }
  return true
}

/**
 * Validate a `jobId` string against non-emptiness, whitespace/control chars, and length.
 * @param value - candidate job identifier.
 * @param maxLength - maximum permitted length.
 * @returns the validated `jobId`.
 * @throws {@link RemoteError} `gateway/bad-request` on malformed input.
 */
export function requireValidJobId(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || CONTROL_OR_WHITESPACE.test(value)) {
    throw new RemoteError(
      'gateway/bad-request',
      `jobId must be a non-empty identifier without whitespace/control characters (max ${String(maxLength)})`,
      {},
    )
  }
  return value
}

/**
 * Strictly validate a `peer.create` `job` object and enforce the pairing's
 * `worker` policy without silent clamping.
 * @param rawJob - unvalidated `job` field from `PeerCreateRequest`.
 * @param policy - pairing `worker` policy bounding capabilities, limits, MCP endpoints, and tools.
 * @param bounds - deployment validation bounds from `PeerService` config.
 * @param now - current epoch milliseconds used to check future expiry and max TTL.
 * @param options - optional skip flags for idempotent replay structural validation.
 * @returns validated job record merged with policy limit defaults where omitted.
 * @throws {@link RemoteError} `gateway/bad-request` on malformed input or `peer/forbidden` on policy violation.
 */
export function validateCreateJob(
  rawJob: unknown,
  policy: PeerWorkerPolicy,
  bounds: JobValidationBounds,
  now: number,
  options: { readonly checkExpiryWindow?: boolean; readonly checkPolicy?: boolean } = {},
): ValidatedCreateJob {
  if (!isPlainRecord(rawJob)) {
    throw new RemoteError('gateway/bad-request', 'job must be an object', {})
  }
  for (const key of Object.keys(rawJob)) {
    if (!JOB_KEYS.has(key)) {
      throw new RemoteError('gateway/bad-request', `job contains unknown key ${JSON.stringify(key)}`, {})
    }
  }
  const jobId = requireValidJobId(rawJob.jobId, bounds.jobIdMaxLength)
  const fence = requirePositiveInt(rawJob.fence, 'job.fence')
  const expiresAt = requirePositiveInt(rawJob.expiresAt, 'job.expiresAt')
  if (options.checkExpiryWindow !== false) {
    validateExpiryWindow(expiresAt, now, bounds.jobMaxTtlMs)
  }

  const capabilities = requireBoundedStringArray(
    rawJob.capabilities,
    'job.capabilities',
    bounds.jobCapabilitiesMax,
    bounds.jobIdentifierMaxLength,
  )
  const allowedCapabilities = new Set(policy.allowedCapabilities ?? [])
  for (const capability of capabilities) {
    if (options.checkPolicy !== false && !allowedCapabilities.has(capability)) {
      throw new RemoteError(
        'peer/forbidden',
        `requested job capability ${JSON.stringify(capability)} is not allowed by the pairing worker policy`,
        { reason: 'job-capability-not-allowed', denied: capability },
      )
    }
  }

  const limits = validateJobLimits(rawJob.limits, policy.maxLimits, options.checkPolicy !== false)

  let mcpEndpointId: string | undefined
  if (rawJob.mcpEndpointId !== undefined) {
    mcpEndpointId = requireBoundedIdentifier(rawJob.mcpEndpointId, 'job.mcpEndpointId', bounds.jobIdentifierMaxLength)
    const allowedEndpoints = policy.allowedMcpEndpoints ?? []
    if (options.checkPolicy !== false && !allowedEndpoints.includes(mcpEndpointId)) {
      throw new RemoteError(
        'peer/forbidden',
        `requested mcpEndpointId ${JSON.stringify(mcpEndpointId)} is not allowed by the pairing worker policy`,
        { reason: 'job-mcp-endpoint-not-allowed', denied: mcpEndpointId },
      )
    }
  }

  let credentialRef: string | undefined
  if (rawJob.credentialRef !== undefined) {
    if (!isValidCredentialRefName(rawJob.credentialRef, bounds.jobIdentifierMaxLength)) {
      throw new RemoteError(
        'gateway/bad-request',
        'job.credentialRef must be a reference name only, never a credential value or URL',
        {},
      )
    }
    credentialRef = rawJob.credentialRef
  }

  let allowedToolNames: readonly string[] | undefined
  if (rawJob.allowedToolNames !== undefined) {
    const requestedTools = requireBoundedStringArray(
      rawJob.allowedToolNames,
      'job.allowedToolNames',
      bounds.jobToolsMax,
      bounds.jobIdentifierMaxLength,
    )
    const allowedSet = new Set(policy.allowedToolNames ?? [])
    for (const toolName of requestedTools) {
      if (options.checkPolicy !== false && !allowedSet.has(toolName)) {
        throw new RemoteError(
          'peer/forbidden',
          `requested tool ${JSON.stringify(toolName)} in allowedToolNames is not allowed by the pairing worker policy`,
          { reason: 'job-tool-not-allowed', denied: toolName },
        )
      }
    }
    allowedToolNames = requestedTools
  } else {
    allowedToolNames = requireBoundedStringArray(
      options.checkPolicy === false ? [] : policy.allowedToolNames ?? [],
      'worker.allowedToolNames', bounds.jobToolsMax, bounds.jobIdentifierMaxLength,
    )
  }

  return {
    jobId,
    fence,
    expiresAt,
    capabilities,
    limits,
    ...(mcpEndpointId === undefined ? {} : { mcpEndpointId }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    allowedToolNames,
  }
}

/**
 * Validate that a job `expiresAt` epoch timestamp is strictly in the future and
 * within the configured maximum TTL.
 * @param expiresAt - candidate epoch milliseconds.
 * @param now - reference epoch milliseconds.
 * @param maxTtlMs - maximum permitted lifetime in milliseconds.
 * @throws {@link RemoteError} `gateway/bad-request` when expired or beyond max TTL.
 */
export function validateExpiryWindow(expiresAt: number, now: number, maxTtlMs: number): void {
  if (expiresAt <= now) {
    throw new RemoteError('gateway/bad-request', 'expiresAt must be in the future', {})
  }
  if (expiresAt - now > maxTtlMs) {
    throw new RemoteError(
      'gateway/bad-request',
      `expiresAt exceeds configured maximum TTL of ${String(maxTtlMs)}ms`,
      {},
    )
  }
}

/**
 * Canonical SHA-256 of one `peer.jobUpdate` request payload.
 * @param alias - resolved pairing alias.
 * @param request - job update payload.
 * @returns lowercase hex SHA-256 digest.
 */
export function jobUpdatePayloadHash(alias: string, request: PeerJobUpdateRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([
      'jobUpdate',
      alias,
      request.jobId,
      request.fence ?? null,
      request.expiresAt ?? null,
      request.revoked ?? null,
    ]))
    .digest('hex')
}

/**
 * Canonical JSON tuple representing a `PeerCreateJobRequest` without leaking
 * raw inputs outside the SHA-256 hash.
 * @param job - optional job request from `PeerCreateRequest`.
 * @returns normalized tuple or `null` when absent.
 */
export function canonicalCreateJobTuple(job: PeerCreateJobRequest | undefined): unknown {
  if (job === undefined) return null
  return [
    job.jobId,
    job.fence,
    job.expiresAt,
    [...job.capabilities].sort(),
    [
      job.limits.maxSteps ?? null,
      job.limits.maxToolCalls ?? null,
      job.limits.maxWallMs ?? null,
      job.limits.maxTotalTokens ?? null,
    ],
    job.mcpEndpointId ?? null,
    job.credentialRef ?? null,
    job.allowedToolNames === undefined ? null : [...job.allowedToolNames].sort(),
  ]
}

/**
 * Bounded, restart-safe store for worker job bindings (`peer-job-bindings.json`,
 * `0600`, atomic replacement) and `peer.jobUpdate` idempotency receipts.
 */
export class PeerJobBindingStore implements PeerJobBindingsService {
  private bindings = new Map<SessionId, PeerJobBinding>()
  private updateReceipts = new Map<string, PeerJobUpdateReceipt>()
  private readonly pendingRevocations = new Map<SessionId, number>()
  private loaded = false
  private available = true
  private openError: Error | undefined
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * @param path - binding document path; defaults to `~/.dsh/peer-job-bindings.json`.
   * @param maxCount - maximum retained bindings and maximum retained update receipts.
   * @param maxBytes - maximum serialized UTF-8 document size; only receipts may be evicted.
   */
  constructor(
    readonly path: string = DEFAULT_JOB_BINDINGS_PATH,
    private readonly maxCount: number = 1024,
    private readonly maxBytes: number = 1_048_576,
  ) {}

  /**
   * Attempt to open and validate the persisted binding document without throwing.
   * @returns `{ ok: true }` on success or `{ ok: false, error }` on failure.
   */
  tryOpen(): { readonly ok: true } | { readonly ok: false; readonly error: unknown } {
    try {
      this.ensureLoaded()
      this.available = true
      this.openError = undefined
      return { ok: true }
    } catch (error) {
      this.available = false
      this.openError = error instanceof Error ? error : new Error(String(error))
      return { ok: false, error }
    }
  }

  /**
   * Whether the job-binding store opened cleanly.
   * @returns true when bindings can be read and persisted.
   */
  isAvailable(): boolean {
    return this.available
  }

  /**
   * Look up a session's persisted job binding. Expired and revoked bindings
   * remain readable so guards observe `expiresAt` and `revoked` and fail closed.
   * @param sessionId - target session identifier.
   * @returns the persisted binding, or `undefined` when absent.
   */
  get(sessionId: SessionId): PeerJobBinding | undefined {
    this.ensureLoaded()
    const entry = this.bindings.get(sessionId)
    if (entry === undefined) return undefined
    const revokedAt = this.pendingRevocations.get(sessionId)
    return structuredClone(revokedAt === undefined ? entry : { ...entry, revoked: true, revokedAt })
  }

  /**
   * Find the newest binding owned by `(alias, jobId)`.
   * @param alias - pairing alias.
   * @param jobId - job identifier.
   * @returns matching binding, or `undefined`.
   */
  findByAliasAndJobId(alias: PeerAlias, jobId: string): PeerJobBinding | undefined {
    this.ensureLoaded()
    return this.findByAliasAndJobIdInLoadedEntries(alias, jobId)
  }

  private findByAliasAndJobIdInLoadedEntries(alias: PeerAlias, jobId: string): PeerJobBinding | undefined {
    for (const binding of this.bindings.values()) {
      if (binding.alias === alias && binding.jobId === jobId) return binding
    }
    return undefined
  }

  /**
   * Persist one job binding atomically under mode `0600`. Rolls back in-memory
   * state on byte-limit overflow or disk write failure.
   * @param binding - non-secret job binding record keyed by `sessionId`.
   * @returns completion of the atomic write.
   */
  async put(binding: PeerJobBinding): Promise<void> {
    return this.enqueueWrite(async () => {
      this.ensureLoaded()
      if (this.bindings.has(binding.sessionId) || this.findByAliasAndJobId(binding.alias, binding.jobId) !== undefined) {
        throw new RemoteError('peer/conflict', 'job or session already has a binding', { reason: 'job-id-reuse' })
      }
      const next = new Map(this.bindings).set(binding.sessionId, structuredClone(binding))
      await this.commit(next, new Map(this.updateReceipts))
    })
  }

  /**
   * Deny subsequent guard reads immediately and persist before acknowledging.
   * @param sessionId - bound session identifier.
   * @returns true if a binding existed and was marked revoked; false if absent.
   */
  async revoke(sessionId: SessionId): Promise<boolean> {
    this.ensureLoaded()
    const live = this.bindings.get(sessionId)
    if (live !== undefined && live.revoked !== true) {
      this.pendingRevocations.set(sessionId, this.pendingRevocations.get(sessionId) ?? Date.now())
    }
    return this.enqueueWrite(async () => {
      this.ensureLoaded()
      const current = this.bindings.get(sessionId)
      if (current === undefined) return false
      if (current.revoked !== true) {
        const revokedAt = this.pendingRevocations.get(sessionId) ?? Date.now()
        this.pendingRevocations.set(sessionId, revokedAt)
        await this.commit(new Map(this.bindings).set(sessionId, { ...current, revoked: true, revokedAt }),
          new Map(this.updateReceipts))
      }
      this.pendingRevocations.delete(sessionId)
      return true
    })
  }

  /**
   * Execute an idempotent, payload-bound `peer.jobUpdate` mutation (fence bump,
   * expiry extension, and/or revocation) and persist both binding and receipt
   * in a single atomic document write.
   * @param input - validated update request, host instance id, and TTL policy.
   * @returns the updated binding and receipt metadata.
   */
  async applyUpdate(input: {
    readonly alias: PeerAlias
    readonly request: PeerJobUpdateRequest
    readonly instanceId: string
    readonly jobMaxTtlMs: number
  }): Promise<PeerJobUpdateValue> {
    return this.enqueueWrite(async () => {
      this.ensureLoaded()
      const key = `${input.alias}\u0000${input.request.requestId}`
      const payloadHash = jobUpdatePayloadHash(input.alias, input.request)
      const existingReceipt = this.updateReceipts.get(key)
      if (existingReceipt !== undefined) {
        if (existingReceipt.payloadHash !== payloadHash) {
          throw new RemoteError(
            'peer/conflict',
            `requestId ${JSON.stringify(input.request.requestId)} was already used with a different payload`,
            { reason: 'request-id-reuse' },
          )
        }
        this.updateReceipts.delete(key)
        this.updateReceipts.set(key, existingReceipt)
        return {
          ...structuredClone(existingReceipt.value),
          replayed: true,
        }
      }

      const binding = this.findByAliasAndJobId(input.alias, input.request.jobId)
      if (binding === undefined) {
        throw new RemoteError(
          'peer/not-found',
          `no job binding ${JSON.stringify(input.request.jobId)} under alias ${JSON.stringify(input.alias)}`,
          { alias: input.alias, reason: 'job-not-found' },
        )
      }

      if (binding.revoked === true || (this.pendingRevocations.has(binding.sessionId) && input.request.revoked !== true)) {
        throw new RemoteError(
          'peer/conflict',
          `job ${JSON.stringify(binding.jobId)} is already revoked`,
          { reason: 'job-revoked' },
        )
      }

      const now = Date.now()
      if (input.request.expiresAt !== undefined) {
        validateExpiryWindow(input.request.expiresAt, now, input.jobMaxTtlMs)
      } else if (binding.expiresAt <= now && input.request.revoked !== true) {
        throw new RemoteError(
          'peer/conflict',
          `job ${JSON.stringify(binding.jobId)} has expired`,
          { reason: 'job-expired' },
        )
      }

      if (input.request.fence !== undefined && input.request.fence <= binding.fence) {
        throw new RemoteError(
          'peer/conflict',
          `jobUpdate fence (${String(input.request.fence)}) must exceed current fence (${String(binding.fence)})`,
          { reason: 'fence-regression' },
        )
      }

      const updated: PeerJobBinding = {
        ...binding,
        ...(input.request.fence === undefined ? {} : { fence: input.request.fence }),
        ...(input.request.expiresAt === undefined ? {} : { expiresAt: input.request.expiresAt }),
        ...(input.request.revoked === true ? { revoked: true, revokedAt: now } : {}),
      }
      const value: PeerJobUpdateValue = {
        accepted: true,
        binding: updated,
        replayed: false,
        payloadHash,
        instanceId: input.instanceId,
      }
      const receipt: PeerJobUpdateReceipt = {
        key,
        alias: input.alias,
        requestId: input.request.requestId,
        payloadHash,
        value,
        at: now,
      }

      const next = new Map(this.bindings).set(updated.sessionId, updated)
      const receipts = new Map(this.updateReceipts).set(key, receipt)
      if (input.request.revoked === true) this.pendingRevocations.set(updated.sessionId, now)
      await this.commit(next, receipts, key)
      if (input.request.revoked === true) this.pendingRevocations.delete(updated.sessionId)
      return structuredClone(value)
    })
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => task()
    const chained = this.writeChain.then(run, run)
    this.writeChain = chained.then(() => undefined, () => undefined)
    return chained
  }

  private ensureLoaded(): void {
    if (this.openError !== undefined) throw this.openError
    if (this.loaded) return
    let raw: string
    try {
      const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > this.maxBytes) {
          throw new PeerConfigError('peer job bindings file is not owner-only, regular, and within maxBytes')
        }
        const bytes = Buffer.alloc(stat.size + 1)
        let offset = 0
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, bytes.length - offset, null)
          if (count === 0) break
          offset += count
        }
        if (offset !== stat.size) throw new PeerConfigError('peer job bindings file changed while reading')
        raw = bytes.toString('utf8', 0, offset)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true
        return
      }
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new PeerConfigError(`peer job bindings ${this.path} must be JSON`)
    }
    if (!isPlainRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
      throw new PeerConfigError(`peer job bindings ${this.path} must be {version: 1, bindings: [...]}`)
    }
    if (parsed.bindings.length > this.maxCount) throw new PeerConfigError('peer job binding count exceeds configured limit')
    for (const [index, entry] of parsed.bindings.entries()) {
      const binding = readPersistedBinding(entry, `${this.path}#bindings[${String(index)}]`)
      if (this.bindings.has(binding.sessionId) || this.findByAliasAndJobIdInLoadedEntries(binding.alias, binding.jobId) !== undefined) {
        throw new PeerConfigError('duplicate peer job or session id')
      }
      this.bindings.set(binding.sessionId, binding)
    }
    if (parsed.updateReceipts !== undefined) {
      if (!Array.isArray(parsed.updateReceipts)) {
        throw new PeerConfigError(`peer job bindings ${this.path}: updateReceipts must be a list when present`)
      }
      if (parsed.updateReceipts.length > this.maxCount) throw new PeerConfigError('peer job receipt count exceeds configured limit')
      for (const [index, entry] of parsed.updateReceipts.entries()) {
        const receipt = readPersistedUpdateReceipt(entry, `${this.path}#updateReceipts[${String(index)}]`)
        if (this.updateReceipts.has(receipt.key)) throw new PeerConfigError('duplicate peer job update receipt')
        this.updateReceipts.set(receipt.key, receipt)
      }
    }
    this.loaded = true
  }

  private async commit(
    bindings: Map<SessionId, PeerJobBinding>,
    receipts: Map<string, PeerJobUpdateReceipt>,
    protectedReceiptKey?: string,
  ): Promise<void> {
    if (bindings.size > this.maxCount) throw new Error('peer job binding count exceeds configured limit')
    const records = [...bindings.values()]
    let serialized = encodeBindingsDocument(records, [...receipts.values()])
    for (const key of receipts.keys()) {
      if (receipts.size <= this.maxCount && Buffer.byteLength(serialized, 'utf8') <= this.maxBytes) break
      if (key === protectedReceiptKey) continue
      receipts.delete(key)
      serialized = encodeBindingsDocument(records, [...receipts.values()])
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      throw new Error(`peer job binding exceeds maxBytes (${String(this.maxBytes)})`)
    }
    await writeFileAtomic(this.path, serialized, { mode: PRIVATE_MODE, dirMode: 0o700 })
    this.bindings = bindings
    this.updateReceipts = receipts
  }
}

function encodeBindingsDocument(
  bindings: readonly PeerJobBinding[],
  updateReceipts: readonly PeerJobUpdateReceipt[],
): string {
  return `${JSON.stringify({
    version: 1,
    bindings,
    ...(updateReceipts.length === 0 ? {} : { updateReceipts }),
  })}\n`
}

function validateJobLimits(rawLimits: unknown, policyLimits: PeerJobLimits | undefined, checkPolicy: boolean): PeerJobLimits {
  if (!isPlainRecord(rawLimits)) {
    throw new RemoteError('gateway/bad-request', 'job.limits must be an object', {})
  }
  for (const key of Object.keys(rawLimits)) {
    if (!JOB_LIMIT_KEYS.has(key)) {
      throw new RemoteError('gateway/bad-request', `job.limits contains unknown key ${JSON.stringify(key)}`, {})
    }
  }
  const resolved: {
    maxSteps?: number
    maxToolCalls?: number
    maxWallMs?: number
    maxTotalTokens?: number
  } = {}
  for (const key of ['maxSteps', 'maxToolCalls', 'maxWallMs', 'maxTotalTokens'] as const) {
    const rawValue = rawLimits[key]
    const policyCap = policyLimits?.[key]
    if (rawValue !== undefined) {
      const parsed = requirePositiveInt(rawValue, `job.limits.${key}`)
      if (checkPolicy && (policyCap === undefined || parsed > policyCap)) {
        throw new RemoteError(
          'peer/forbidden',
          `job.limits.${key} exceeds or has no pairing worker policy limit`,
          { reason: 'job-limit-exceeded', denied: key },
        )
      }
      resolved[key] = parsed
    } else if (policyCap !== undefined) {
      resolved[key] = policyCap
    }
  }
  return resolved
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RemoteError('gateway/bad-request', `${field} must be a positive safe integer`, {})
  }
  return value
}

function requireBoundedIdentifier(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || CONTROL_OR_WHITESPACE.test(value)) {
    throw new RemoteError(
      'gateway/bad-request',
      `${field} must be a non-empty identifier without whitespace/control characters (max ${String(maxLength)})`,
      {},
    )
  }
  return value
}

function requireBoundedStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxItemLength: number,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new RemoteError('gateway/bad-request', `${field} must be an array of strings`, {})
  }
  if (value.length > maxItems) {
    throw new RemoteError('gateway/bad-request', `${field} exceeds maximum length of ${String(maxItems)}`, {})
  }
  const items = Array.from(value, (item: unknown, index) => requireBoundedIdentifier(item, `${field}[${String(index)}]`, maxItemLength))
  if (new Set(items).size !== items.length) throw new RemoteError('gateway/bad-request', `${field} contains duplicate names`, {})
  return items
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string' && item.length > 0)
}

function readPersistedBinding(value: unknown, subject: string): PeerJobBinding {
  if (!isPlainRecord(value)) {
    throw new PeerConfigError(`${subject} must be an object`)
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0
    || typeof value.jobId !== 'string' || value.jobId.length === 0
    || typeof value.fence !== 'number' || !Number.isSafeInteger(value.fence) || value.fence <= 0
    || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0
    || !isStringList(value.capabilities)
    || !isPlainRecord(value.limits)
    || typeof value.alias !== 'string' || value.alias.length === 0
    || typeof value.instanceId !== 'string' || value.instanceId.length === 0
    || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt)) {
    throw new PeerConfigError(`${subject} must carry valid job binding fields`)
  }
  const limits = readPersistedLimits(value.limits, `${subject}.limits`)
  if (value.mcpEndpointId !== undefined && (typeof value.mcpEndpointId !== 'string' || value.mcpEndpointId.length === 0)) {
    throw new PeerConfigError(`${subject}.mcpEndpointId must be a non-empty string`)
  }
  if (value.credentialRef !== undefined && !isValidCredentialRefName(value.credentialRef, Number.MAX_SAFE_INTEGER)) {
    throw new PeerConfigError(`${subject}.credentialRef must be a reference name`)
  }
  if (value.allowedToolNames !== undefined && !isStringList(value.allowedToolNames)) {
    throw new PeerConfigError(`${subject}.allowedToolNames must be a string list`)
  }
  if (value.revoked !== undefined && typeof value.revoked !== 'boolean') {
    throw new PeerConfigError(`${subject}.revoked must be a boolean`)
  }
  if (value.revokedAt !== undefined && (typeof value.revokedAt !== 'number' || !Number.isSafeInteger(value.revokedAt))) {
    throw new PeerConfigError(`${subject}.revokedAt must be a safe integer`)
  }
  return {
    sessionId: brandString<SessionId>(value.sessionId),
    jobId: value.jobId,
    fence: value.fence,
    expiresAt: value.expiresAt,
    capabilities: [...value.capabilities],
    limits,
    ...(value.mcpEndpointId === undefined ? {} : { mcpEndpointId: value.mcpEndpointId }),
    ...(value.credentialRef === undefined ? {} : { credentialRef: value.credentialRef }),
    ...(value.allowedToolNames === undefined ? {} : { allowedToolNames: [...value.allowedToolNames] }),
    alias: brandString<PeerAlias>(value.alias),
    instanceId: value.instanceId,
    createdAt: value.createdAt,
    ...(value.revoked === undefined ? {} : { revoked: value.revoked }),
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
  }
}

function readPersistedLimits(value: Record<string, unknown>, subject: string): PeerJobLimits {
  for (const key of Object.keys(value)) {
    if (!JOB_LIMIT_KEYS.has(key)) {
      throw new PeerConfigError(`${subject} contains unknown key ${JSON.stringify(key)}`)
    }
  }
  const limits: { maxSteps?: number; maxToolCalls?: number; maxWallMs?: number; maxTotalTokens?: number } = {}
  for (const key of ['maxSteps', 'maxToolCalls', 'maxWallMs', 'maxTotalTokens'] as const) {
    const raw = value[key]
    if (raw === undefined) continue
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
      throw new PeerConfigError(`${subject}.${key} must be a positive safe integer`)
    }
    limits[key] = raw
  }
  return limits
}

function readPersistedUpdateReceipt(value: unknown, subject: string): PeerJobUpdateReceipt {
  if (!isPlainRecord(value)
    || typeof value.key !== 'string' || value.key.length === 0
    || typeof value.alias !== 'string' || value.alias.length === 0
    || typeof value.requestId !== 'string' || value.requestId.length === 0
    || typeof value.payloadHash !== 'string' || value.payloadHash.length === 0
    || typeof value.at !== 'number' || !Number.isSafeInteger(value.at)
    || !isPlainRecord(value.value)) {
    throw new PeerConfigError(`${subject} must carry valid jobUpdate receipt fields`)
  }
  const stored = value.value
  if (stored.accepted !== true
    || typeof stored.replayed !== 'boolean'
    || typeof stored.payloadHash !== 'string'
    || typeof stored.instanceId !== 'string') {
    throw new PeerConfigError(`${subject}.value must carry valid PeerJobUpdateValue fields`)
  }
  const binding = readPersistedBinding(stored.binding, `${subject}.value.binding`)
  if (value.key !== `${value.alias}\u0000${value.requestId}` || binding.alias !== value.alias
    || stored.payloadHash !== value.payloadHash || !/^[a-f0-9]{64}$/u.test(value.payloadHash)) {
    throw new PeerConfigError(`${subject} has inconsistent jobUpdate receipt identity`)
  }
  return {
    key: value.key,
    alias: brandString<PeerAlias>(value.alias),
    requestId: brandString<PeerRequestId>(value.requestId),
    payloadHash: value.payloadHash,
    at: value.at,
    value: {
      accepted: true,
      binding,
      replayed: stored.replayed,
      payloadHash: stored.payloadHash,
      instanceId: stored.instanceId,
    },
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
