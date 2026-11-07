---
description: "Browser-host wire layer for the web GUI: Remote RPC, event-stream delivery with reconnect, exact Fetch routes, the /api HTTP bridge, and the browser-trust fence."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

English | [中文](README.zh.md)

## Summary

The package carries browser-to-Host Remote calls, exact Fetch responses, and connection generations. The Client plugin mounts `ctx.connection` with current-page loopback state, generic RPC, the active generation and its Host facts, observable recovery state, an immediate reconnect command, and the registration point for one generation source. A generation becomes visible when its source reports ready; source completion, failure, withdrawal, or an explicit stop clears it before `ConnectionController` applies its retry policy.

## Table of Contents

- [Use this package](#use-this-package)
- [Browser authentication and request trust](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

A static desktop page can provide `__DSH_TRANSPORT__.streamBaseUrl` for the HTTP origin of its owned Host. The Gateway uses that origin for its WebSocket while HTTP transport remains independently selected. The desktop carrier owns authentication; setting the origin alone grants no access.

Unary RPC requests use JSON. A Host handler may return byte attachments that it has already separated from the JSON-compatible result value, with each attachment naming its result-relative path. Connection writes these values as multipart parts. The JSON `metadata` part contains the RPC response envelope with `null` placeholders and an attachment table recording each path, codec, and part identifier. Paths use string keys and numeric array indices; no business field name is reserved. The Client validates the envelope, `rpcId`, attachment table, and parts, then restores each byte value as an `ArrayBuffer`-backed view. Results without attachments, including base64 strings, and failures remain JSON. Logical RPC carriers return decoded native values directly. Connection does not discover binary fields or depend on Typert; the handler that owns a result protocol performs any type-directed or runtime projection before returning. Binary parameters, events, and streamed binary results are unsupported.

The browser uses HTTP POST for Remote unary calls. API Gateway owns the `/api/remote.mux` WebSocket and its logical streams; shell-owned compositions provide equivalent Remote streams, including a stream's uplink, through `connection.rpc.open` without opening a WebSocket. The browser plugin reads the page transport, recovery settings, and location, then delegates to `installConnection(ctx, options)`. A composition that owns its carrier may call the same installer directly; the whole-client test tier does so. Each invocation creates one Context-owned service, so several Client trees can use different carriers in one realm. The Host half always provides the carrier-neutral RPC and exact `GET`/`HEAD`/`POST` route registries. When a Web carrier is present it also owns the sole `/api` route, Fetch bridge, browser authentication, and Host/Origin checks; a shell-owned carrier dispatches the shared Fetch handler directly. Each exact route declares buffered or streaming request-body handling before the bridge reads any bytes. Typert Gateway claims generated Remote endpoints, feature packages register non-JSON responses such as Session-log downloads and raw file uploads, and unclaimed requests return 404. Loopback hostname classification remains package-internal to the browser-facing Client state. Browser raw-body transfer is provided by [`dsh-client-file-upload`](../file-upload/README.md).

-----

<a id="browser-authentication-and-request-trust"></a>
## Browser authentication and request trust

Every Host RPC method and WebSocket stream requires one browser session; there is no method-specific loopback tier. Each process mints a random launch token. `dsh-web-app` prints and opens its application URL with `?token=...`, preserving the caller's authority and mount; `frontend-static` delegates root and index requests to `ctx.connection.authorizeIndex`, which accepts that token only on `GET /`, writes an authority-bound signed cookie, and redirects to clean `./`, which drops the token and keeps the request's directory. A missing, expired, malformed, or wrong-authority cookie returns 401 before RPC dispatch. Static assets remain public. The HTTP carrier accepts no query token outside the root exchange and no Authorization-header token.

The cookie signing secret is the owner-scoped `client-connection/browser-session` grant record in `ctx.credentials`. The local provider persists it in `$DSH_HOME/.credentials.yaml`; `BrowserAuth` loads or creates the record during Connection activation and retains the secret in memory, so request authentication is synchronous. Deleting or replacing the record takes effect on the next Connection activation. Cookies carry an absolute issue/expiry interval, defaulting to 30 days through `cookieMaxAgeDays`, and bind the normalized hostname plus port in both their deterministic name and signed payload. They are host-only, `Path=/`, `HttpOnly`, and `SameSite=Strict`; they deliberately omit `Secure` because the shipped server uses loopback HTTP.

Before authentication, every request still passes `src/api-request-trust.ts`. Its `Host` must be loopback or match a `trustedHosts` entry: exact on `host:port`, any port on port-less entries, both sides WHATWG-normalized. An attached `Origin` must equal that Host and `sec-fetch-site: cross-site` is refused. Malformed configured authorities fail plugin load. These checks defend DNS rebinding and cross-site browser requests; they never establish identity. A failed Host/Origin check returns 403, while a trusted but unauthenticated request returns 401. `dsh web --host 0.0.0.0` remains unsupported. Decision records: [browser request trust](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md) and [browser token authentication](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md).

Every admitted request speaks for one Peer, the operator. `ctx.connection.operator` is that `PeerScope`: its `ctx` is a Cordis scope that owns connection-lifetime registrations and is disposed with the Connection. `ctx.connection.admit(request)` runs the trust and authentication checks and answers with the rejection status or the operator; the `/api` route and the Gateway's WebSocket upgrade admit through it, and every RPC handler receives the Peer of its call. `OperatorPeer` is exported so a composition without Connection, such as the Gateway's in-process carrier, owns an operator scope with the same contract.

Authenticated shared HTTP requests pass through the `connection/request` waterfall before body transfer. A listener may refuse new requests or await `next()` through response completion; removing its owning fiber removes admission behavior. Desktop uses this hook to lock new API work during an approved installation without canceling already-admitted work. Client disconnection aborts the handler signal; the bridge stops socket writes and drains any remaining response chunks. WebSocket stream ownership remains with API Gateway.

<a id="connection-generation"></a>
## Connection generation

API Gateway Client registers the internal `$events` logical stream as the sole generation source, independently of whether any `$on` listener exists. The Host attaches all incremental listeners in the API Remotes source factory, then sends one `{ type: 'ready', clientId, host: { home } }` item before events. `ConnectionController` publishes that generation and calls `onConnected` only after the ready item arrives, so baseline acquisition cannot race ahead of incremental observation.

An ended `$events` stream, a Remote stream error, a non-ready opening item, or a malformed event item invalidates the current generation. A pending handshake logs a slow-Host warning after 3 seconds and logs the readiness timeout and aborts after 15 seconds by default, including time spent waiting for the physical socket. The source must stop delivery, release resources, and settle after cancellation before a replacement starts; late readiness from a cancelled source cannot publish a generation. `ConnectionController` resets the retry sequence only after a generation has stayed ready for `stableConnectionMs` (30 seconds by default) or after an explicit `ctx.connection.reconnect()`; a socket that becomes ready and dies sooner keeps climbing the same jittered backoff, so a flapping link cannot bounce at the base tier forever. While the browser reports network availability, the controller publishes `connecting` and retries with 50%–100% jitter under caps of 500ms, 1s, 2s, 4s, 8s, and 10s, continuing at the final cap until recovery. Every retry asks Gateway to replace the physical WebSocket once and reopens `$events`. The [continuous recovery decision](../../../.agents/notes/implemented/bug-fix/2026-09-05-continuous-client-recovery.md) owns the deadlines and retry policy.

`ctx.connection.reconnect()` interrupts active work, resets the sequence, and starts retry 1 immediately. Browser `offline` and `online` bursts are debounced by `networkDebounceMs` (1 second by default), so one interface flap does not abort work or advance the retry ladder repeatedly; returning online resumes the existing ladder rather than resetting it. A visible `visibilitychange` or `pageshow` (including bfcache restores) requests one debounced reconnect, skipping it before the first connection outcome, while offline, while a connected generation received a frame within `wakeStaleThresholdMs` (30 seconds by default), or while a handshake started less than `wakeConnectingGraceMs` (3 seconds by default) ago; a disconnected or backing-off generation is replaced at once. A low-frequency watchdog (`watchdogIntervalMs`, 5 seconds by default) reconnects a connected generation that received no frame for `watchdogStaleMs` (30 seconds by default), coalescing repeated ticks into one request, but it arms only after that generation reported an inbound application heartbeat frame: a Host that ignores the negotiated heartbeat request never sends one, so a merely idle generation keeps relying on Host close, wake, and online recovery instead of reconnecting every window. Every wake reconnect and every retry after a generation that had reached ready adds a bounded per-tab random offset (`reconnectStaggerMs`, 100 ms by default; 0 disables it), so several tabs do not reconnect in lockstep; a first handshake that never becomes ready keeps the plain 50%–100% retry jitter. Every frame the Client receives on any Remote stream advances the liveness window, including the capability-negotiated application-level `{ type: 'heartbeat' }` frame that the mux writes only to Client bundles that asked for it. The control Ping itself remains invisible to browser script. Only a ready item publishes `connected`. Gateway mux owns no independent retry schedule.

Set the Host Connection row's `config.recovery` to override retry caps, the growth factor, handshake warning and cancellation times, the stability window, wake/wake-grace and watchdog windows, the network debounce, the per-tab reconnect stagger, or the unary RPC deadline; the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-client-connection) lists accepted fields. The Host validates these values and injects them into each served page. The Client validates the bootstrap data before providing Connection and uses those defaults when Gateway starts its loop; explicit `start()` timing overrides take precedence. The growth factor must be finite and at least one. Readiness, failure, cancellation, or a hard deadline that occurs before the warning cancels that warning. Unary RPC calls share `rpcTimeoutMs` (45 seconds by default): a half-open HTTP exchange rejects at the deadline, propagates the caller's cancellation, and a timed-out shared `settings.describe` read clears its in-flight promise so later reads issue a new request. Reload the page after changing Host recovery configuration.


<a id="model-experience"></a>
## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Wake staleness is not derived from the Host heartbeat policy** — the page does not receive Gateway's resolved heartbeat interval and timeout, so `wakeStaleThresholdMs` keeps a conservative validated default (30 s) that a deployment may override through Host recovery configuration; it is deliberately not the old 4 s copy of two 2 s intervals.
- **Buffered `/api` routes retain each request body in memory** — `maxRequestBodyBytes` (default 300 MiB, sized for the default 200 MiB aggregate image limit after base64 expansion plus envelope headroom) bounds ordinary image and RPC envelopes. Opt-in streaming routes receive backpressured chunks and bypass the aggregate cap; route implementations own persistence, cancellation, and any storage quota.
- **The browser cookie is not marked `Secure`** — loopback HTTP is the shipped transport, so exposing the same authority over plaintext networking can expose the bearer cookie in transit.
- **There is no logout operation** — clearing the browser cookie ends one browser session; deleting the owner credential record and restarting `dsh` revokes every session.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Browser-session verification reads the credential record asynchronously at the request that authorizes work, while the credentials companion owns record commit-event lifetime. Stream/reconnect sequencing and rpcId round-trip discipline are exercised directly by behavior specs, and route register/dispose symmetry is audited by the webserver companion.
