/**
 * Type definitions for `dsh-enpoi-job-guard`.
 *
 * Includes a local mirror of the job-binding types exported by
 * `@deepseek-ai/dsh-api-peer` so this profile package compiles independently of
 * peer-host source changes.
 *
 * @module dsh-enpoi-job-guard/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Local mirror of `PeerJobBinding` from `@deepseek-ai/dsh-api-peer`.
 */
export interface PeerJobBinding {
  sessionId: SessionId
  jobId: string
  fence: string
  expiresAt: number
  capabilities: readonly string[]
  limits: {
    maxSteps?: number
    maxToolCalls?: number
    maxWallMs?: number
    maxTotalTokens?: number
  }
  mcpEndpointId?: string
  credentialRef?: string
  allowedToolNames?: readonly string[]
  alias: string
  instanceId: string
  createdAt: number
}

/** Lane 1's persisted implementation uses a numeric fence; compare either representation exactly. */
export type RuntimePeerJobBinding = Omit<PeerJobBinding, 'fence'> & {
  fence: string | number
  revoked?: boolean
  revokedAt?: number
}

/**
 * Local mirror of the `peerJobBindings` service contract from `@deepseek-ai/dsh-api-peer`.
 */
export interface PeerJobBindingsService {
  /** Look up the binding for a session; `undefined` or revoked state denies worker execution. */
  get(sessionId: SessionId): RuntimePeerJobBinding | undefined
}

/**
 * Effective worker profile identity returned by `peerProfileIdentity.describe()`.
 */
export interface PeerProfileIdentityDescription {
  hash: string
  presetId: string
  toolNames: string[]
  configDigest: string
}

/**
 * Service interface provided as `peerProfileIdentity`.
 */
export interface PeerProfileIdentityService {
  /** Compute the live profile identity hash and tool inventory for `sessionId`. */
  describe(sessionId: SessionId): PeerProfileIdentityDescription | undefined
}

/** Optional host-side header provider consumed for hub admission requests. */
export interface McpHeaderProviderService {
  headersFor(sessionId: string | undefined, serverId: string): Promise<Record<string, string> | undefined>
}

/** Sanitized admission audit record persisted before tool dispatch. */
export interface JobGuardAuditRecord {
  t: number
  jobId: string
  fence: string | number
  toolName: string
  callId: string
  argsHash: string
  decision: 'allow' | 'deny'
  reasonCode: string
}

/** Sanitized step/budget refusal record written when a turn stops at pre-step. */
export interface JobGuardBudgetStopRecord {
  t: number
  turn: number
  step: number
  jobId: string
  fence: string | number
  decision: 'deny'
  reasonCode: string
}

/** Plugin configuration for `enpoi-job-guard`. */
export interface Config {
  /** Deny sessions without an active job binding (default `true` for worker hosts). */
  requireBinding?: boolean
  /** Require a single concrete provider+model route and forbid model chains (default `true`). */
  requirePinnedRoute?: boolean
  /** Exact allowed tool names intersected with `binding.allowedToolNames`. */
  allowedTools?: string[]
  /** Required capability per exact tool name. */
  toolCapabilities?: Record<string, string>
  /** Default required capability for tools not listed in `toolCapabilities`. */
  defaultCapability?: string
  /** Hard ceiling on model steps per session (combined with `binding.limits.maxSteps`). */
  maxSteps?: number
  /** Hard ceiling on tool calls per session (combined with `binding.limits.maxToolCalls`). */
  maxToolCalls?: number
  /** Hard ceiling on wall-clock milliseconds from `binding.createdAt` (combined with `binding.limits.maxWallMs`). */
  maxWallMs?: number
  /** Hard ceiling on cumulative tokens per session (combined with `binding.limits.maxTotalTokens`). */
  maxTotalTokens?: number
  /** Output token reserve used when `GenerateOptions.maxTokens` is omitted (default `4096`). */
  defaultMaxTokensReserve?: number
  /** Optional HTTP URL for hub tool-execution admission. */
  admissionUrl?: string
  /** Timeout in milliseconds for the hub admission HTTP call (default `5000`). */
  admissionTimeoutMs?: number
  /** Server identifier passed to `mcpHeaderProvider.headersFor` for hub admission (default `'job-guard-admission'`). */
  admissionServerId?: string
  /** Include raw tool arguments in the hub admission request body (default `false`). */
  admissionIncludeArgs?: boolean
  /** Directory for bounded `0600` per-session audit files (default `$DSH_HOME/enpoi-job-guard`). */
  auditDir?: string
  /** Maximum byte size per session audit file before failing closed (default `1048576`). */
  auditMaxBytes?: number
  /** Fallback preset id used by `peerProfileIdentity` when the session header omits `agentPreset`. */
  presetId?: string
  /** Optional harness version override for `peerProfileIdentity`. */
  harnessVersion?: string
  /** Optional expected fence override; mismatches deny immediately. */
  expectedFence?: string | number
  /** Optional expected host instanceId; mismatches deny immediately. */
  instanceId?: string
}

/** Validated, fully defaulted runtime configuration for `enpoi-job-guard`. */
export interface ResolvedJobGuardConfig {
  readonly requireBinding: boolean
  readonly requirePinnedRoute: boolean
  readonly allowedTools: readonly string[] | undefined
  readonly toolCapabilities: Readonly<Record<string, string>>
  readonly defaultCapability: string | undefined
  readonly maxSteps: number
  readonly maxToolCalls: number
  readonly maxWallMs: number
  readonly maxTotalTokens: number
  readonly defaultMaxTokensReserve: number
  readonly admissionUrl: string | undefined
  readonly admissionTimeoutMs: number
  readonly admissionServerId: string
  readonly admissionIncludeArgs: boolean
  readonly auditDir: string
  readonly auditMaxBytes: number
  readonly presetId: string
  readonly harnessVersion: string
  readonly expectedFence: string | number | undefined
  readonly instanceId: string | undefined
}
