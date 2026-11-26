# dsh-enpoi-job-guard

English | [中文](README.zh.md)

Mount this plugin only in a job-owned worker composition. It requires a live peer job binding, checks each tool execution and model request, and exposes the session's live tool inventory to the controller through `peerProfileIdentity`.

## Configuration

| Field | Default | Behavior |
|---|---|---|
| `requireBinding` | `true` | Reject unbound execution. Do not disable this on a worker. |
| `requirePinnedRoute` | `true` | Require a concrete provider and model; reject chains before dispatch. |
| `allowedTools` | omitted (deny all) | Exact public tool names. Both the binding and this list must name the tool. |
| `toolCapabilities` / `defaultCapability` | `{}` / omitted | Lookup precedence: exact mapping, configured default, then the exact public tool name. The selected capability must also be granted in the binding. |
| `maxSteps` / `maxToolCalls` | `32` / `64` | Per-session ceilings; a binding can only lower them. |
| `maxWallMs` / `maxTotalTokens` | `600000` / `200000` | Wall clock starts at `binding.createdAt` and cannot extend past `expiresAt`; token ceiling counts all four usage buckets. |
| `defaultMaxTokensReserve` | `4096` | Sets a missing output limit on agent-loop requests before the request is logged. Direct LLM callers must supply `maxTokens`. |
| `admissionUrl` / `admissionTimeoutMs` | omitted / `5000` | Optional hub POST with a deadline no later than the job deadline. No URL credentials, queries, fragments, or redirects. |
| `admissionServerId` / `admissionIncludeArgs` | `job-guard-admission` / `false` | Header-provider destination key; raw arguments go to the hub only when explicitly enabled. |
| `auditDir` / `auditMaxBytes` | `$DSH_HOME/enpoi-job-guard` / `1048576` | Absolute private directory and per-session JSONL byte limit; no rotation. |
| `presetId` / `harnessVersion` | `worker` / running harness version | Identity values. The session's actual preset takes precedence over `presetId`. |
| `expectedFence` / `instanceId` | omitted | Optional extra pins. Even without them, the guard rejects changed job, fence, or instance values after the first valid lookup. |

## Admission and identity

The controller provides `peerJobBindings.get(sessionId)`. Exact tool grants and capabilities are checked before any asynchronous policy or network work, and eligible calls consume their reservation even when later denied. Other policies retain their right to deny; any interactive ask becomes a denial. A monotonic executor check requires the same invocation to have completed admission, including direct and nested registry calls. The dispatch stage rechecks authority and supplies cooperative tools with a wall-deadline signal.

When hub admission is enabled, the POST body sends `jobId`, `fence`, `capability`, `toolName`, `callId`, `argsHash`, and optionally `arguments`. Only a successful HTTP response with a JSON object carrying `allowed: true` admits the call. Errors are mapped to local codes, never copied from the response. For a binding with a `credentialRef`, the trusted host must mount `mcpHeaderProvider.headersFor(sessionId, serverId)` and resolve that reference to an Authorization header for the configured destination. Configure the provider separately; the guard stores no bearer.

`peerProfileIdentity.describe(sessionId)` returns `{ hash, presetId, toolNames, configDigest }` for a live session. It hashes the preset, running harness version, name-sorted scoped tool schemas, guard config digest, and the binding's MCP endpoint and allowlist with SHA-256 over key-sorted JSON. It reports registry-visible tools, including any tool the guard refuses at execution; this lets the controller detect unintended exposure.

## Audit and budgets

The fallback audit file stores admission decisions (timestamp, job, fence, tool, call ID, canonical argument digest, decision and reason code) and pre-step refusals. It does not store raw arguments, headers, credential references, or server replies. An allow requires a successful append and file sync; a full or unavailable file denies work. The log is local, not available through the peer event feed. The existing `peer/budget` turn-cancel marker identifies step and wall budget stops in session history; no new session event type is registered.

The token check combines cumulative metered usage with active reservations for estimated input and the request's output limit. A settled stream without usable metering is charged its reservation. Refusal raises `JOB_BUDGET_REFUSED` before adapter dispatch. An in-flight request can overshoot an estimate. Chain fallback and adapter-internal retries do not reenter `llm/stream`; use one pinned route and disable provider fallback in the worker composition.

## Model Experience

The guard adds no prompt text, tool schema, or KV-cache prefix. A refused tool contributes a short denial to the normal logged tool result; a stopped step sends no model request.

## Known Limitations and Deferred Work

This is not OS confinement or a shared cross-process quota. Use a dedicated worker process and private audit directory, and retire the binding rather than reloading the guard or reusing the session after a restart. Provider requests already in flight are not stopped by the next-dispatch check, and signalling a tool does not prove remote quiescence. Once admission succeeds, the tool's endpoint must also enforce its own job fence and expiry. There is no independent runtime invariant companion: the executor integration tests exercise the guard's own checks.
