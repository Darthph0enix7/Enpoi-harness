# Feedback System — design & overnight plan (2026-10-12)

> Operator brief: our own feedback flow with default-ON checkboxes (anonymous
> system info, context data, session data, user message); a free-LLM triage in
> an isolated, disposable session; submission to an endpoint reachable from
> anywhere; experimental is fine. Status: **infrastructure verified; lanes A and B
> landed (2026-10-12); follow-ups listed at the end.**

## 1. What already exists (recon, do not duplicate)

- **`/feedback` command + dialog** — `packages/feedback/command-feedback`
  (`feedback` command, `sessionFeedback.record` Remote, `feedback/record`
  log-only event) and `packages/client/ui-message-feedback` (bare `/feedback`
  is client-decorated: `FeedbackDialog.tsx` Modal with category chips +
  textarea + toast; `en`/`zh` locales; message-level rating separate).
- **Redaction** — `packages/session/session-telemetry` redaction waterfall;
  feedback-gated OTel mode `FEEDBACK_ONLY` (default) in
  `packages/session/session-telemetry-otel`.
- **Diagnostics** — `enpoi-diagnostics` SQLite ledger + `dsh doctor --json`
  (host/service/providers/keys/diagnostics/sessions). Reuse, don't rebuild.
- **Ephemeral isolated session pattern** — first-run system analysis:
  `packages/host/first-run/src/investigation.ts`
  (`agents.create` with a branded `system-analysis-*` id, preset mount,
  `permissions.set(..., 'system-analysis')` = `workspace-write + never ask`,
  model **`kilo / poolside/laguna-s-2.1:free`** (keyless free tier), `whenIdle` →
  `dispose()`; work dir `$DSH_HOME/system-analysis-work` removed).
- **Session data accessors** — `ctx.sessionQuery.*` (search/read/trace,
  cwd-fenced), `session-log-export` (`readSessionLogText`, ZIP stream),
  live `Session.snapshotEvents()`; system info via `APP_IDENTITY`,
  `ctx.llm.listProviders()`, `agentDefaultModel.currentSelection()`,
  `anonymous-user-id`.

## 2. Architecture (chosen)

```
[/feedback or dialog]                 (client, existing dialog + 4 checkboxes)
        │ sessionFeedback.record({text, category, share, submit})
        ▼
[feedback/collect]  host: build payload
   system  : version/commit, os/arch/node, provider ids + default model (no keys)
   context : recent messages/tool-calls/errors (sessionQuery, size-capped)
   session : hashed session id, counts, preset/model, recent errors
   redact  : telemetry redaction waterfall + path/identity anonymizer (home→~)
        │
        ▼
[feedback/triage]   ephemeral session (kilo/poolside/laguna-s-2.1:free, preset
   'system-analysis', title 'Feedback triage', no archive, disposed after idle,
   work dir removed) → JSON {category, severity, summary, details}   (fail-soft)
        │
        ▼
[feedback/submit]   POST https://enpoi-feedback.kalinsaz123321.workers.dev/feedback  (fail-soft; 1 retry)
        │
        ▼
[enpoi feedback-service]  serverlocal: 127.0.0.1:8091 + webserver proxy
   storage: ~/feedback-service/data/<day>/<ts>-<id>.json ; admin list/get
   (VERIFIED end-to-end: local + public tunnel POSTs return 201)
```

## 3. Frozen contract (both lanes implement against this)

- **Remote** (extends existing): `sessionFeedback.record({sessionId, text?,
  category?, share?: {systemInfo, context, session, message: boolean},
  submit?: boolean})` → `{recorded: true; submitted: {id: string} | null;
  analysis: FeedbackTriage | null}`. Absent `share` = all true (defaults ON);
  `submit` absent = true (submission on by default, settings can disable).
  The `message` flag is host-side: false omits the message text from the
  ENDPOINT payload only — the local `feedback/record` event always keeps it
  (the record is the user's own log) and the endpoint accepts telemetry-only
  payloads.
- **Endpoint payload**: `{app: {name, version, commit}, message, category?,
  flags, system?, context?, session?, analysis?, meta: {submittedAt,
  installIdHash}}` — 2 MiB cap; server stores as-is.
- **Triage JSON**: `{category: <one of the 7 FeedbackCategory ids>, severity:
  'low'|'medium'|'high', summary: string, details?: string}`.

## 4. Phases & lanes

- **Lane A (host core)** — `packages/feedback/command-feedback` payload
  extension + new `feedback-collect` (payload builder + redaction/anonymizer)
  + `feedback-submit` (endpoint client, settings toggle) + `feedback-triage`
  (ephemeral session per §1 pattern; skip archive; dispose; fail-soft) + unit
  tests (redaction, payload shape, submit client against a local stub, triage
  prompt/parse) + settings keys documented.
- **Lane B (client UI)** — `ui-message-feedback` dialog: 4 checkboxes
  (default ON) + submit path via the extended remote; `en`+`zh` locales; update
  the locked goldens (`snapshots/web/feedback-command/*`,
  `lifecycle-chrome/command-menu*`, `apps/web/tests/feedback-command.e2e.ts`,
  `shipped-composition.e2e.ts` if needed); tests.
- **Verification** — unit suites both lanes; end-to-end: a scratch managed
  prefix submits a real feedback to `https://enpoi-feedback.kalinsaz123321.workers.dev/feedback` and the admin
  list shows it; the Mac/PC smoke left to the operator.

## 6. Landing status (2026-10-12)

- **Lane A (host core) — landed**: `packages/feedback/command-feedback`
  orchestrates record → collect → triage → submit (all fail-soft; the record
  always succeeds); new `packages/feedback/feedback-collect` (payload +
  redaction/anonymizer), `packages/feedback/feedback-submit` (config:
  enabled/endpoint/timeoutMs/retryDelayMs), and `packages/feedback/feedback-triage`
  (config: provider/model/preset/permissionPreset/timeoutMinutes; disposable,
  never archived). The `message` flag lives on the host request and payload
  builder.
- **Lane B (client UI) — landed**: the dialog's four sharing checkboxes and the
  extended `sessionFeedback.record` path.
- **Composition — landed**: `profile/web/cordis.patch.yml` inserts
  `feedback-collect`, `feedback-submit`, and `feedback-triage` (new row ids
  insert on update, so devices receive them without a manual edit).
- **Follow-ups**: (1) `feedback-collect` still reads the deprecated synchronous
  `session.snapshotEvents()` through a structural interface — migrate it to the
  live `session/event` watcher the triage package uses; (2) triage degrades to
  a null analysis silently when the keyless Kilo route or the agent runtime is
  missing (warn log only) — consider a settings-visible note; (3) a browser
  e2e for the four checkboxes (the dialog's share defaults and the message-off
  payload path).

## 5. Decisions taken (operator may override)

1. **Endpoint on our infra, not GitHub**: no device secrets, storage we own,
   reachable anywhere via the existing tunnel; GitHub mirroring can be added
   later as a consumer of the stored JSONs.
2. **Triage on-device with the free Kilo route** (mirrors the system-analysis
   pattern; zero server cost; isolated + disposed). Server-side re-analysis can
   consume the stored payloads later.
3. **Anonymity**: raw IP never stored (salted hash only); session id hashed in
   the payload; home paths anonymized; provider *ids* only, never keys.
4. **Defaults ON** for the three data checkboxes + submission; one settings
   switch disables submission entirely (local record still happens).

## 6a. Endpoint: Cloudflare Worker (2026-10-13, final)

The collector moved off the operator's hardware entirely: one Cloudflare Worker
(`~/feedback-worker/worker.js`, free tier) at
`https://enpoi-feedback.kalinsaz123321.workers.dev` stores each submission as a
Workers KV entry and serves the token-gated read surface (`/admin` HTML browse,
`/admin/list`, `/admin/get`). No GitHub, no server, no database: nothing of the
operator's runs. The serverlocal collector (`feedback-service`) and the
`enpoi.vip/feedback` proxy route are retired (service stopped and disabled,
route removed, public path now 404s); its collected submissions were backfilled
into the Worker store. The read token lives in `~/feedback-worker/.env` (mode
600); the Cloudflare API token used for the deploy can be revoked — the Worker
is independent of it. KV `list` is eventually consistent (~60 s), so the browse
page may lag briefly behind a fresh submission.

## 6. Overnight verification (live, 2026-10-12)

- **Endpoint**: verified public + local — `https://enpoi-feedback.kalinsaz123321.workers.dev/feedback` and the
  direct `127.0.0.1:8091` both 201; storage + admin list + telemetry-only and
  empty-body cases correct (`~/feedback-service/`).
- **Full harness chain** (scratch web instance on :3099 + gateway RPC
  `sessionFeedback.record`, awaited pipeline): record ✓ → collect ✓ (system
  section with provider ids and default model; session section with a **hashed**
  session id; context section shaped but empty — the `session.prompt` RPC shape
  was not found in time) → **submit ✓ live** — stored submission
  `f5b857b568c0` with the complete payload (see
  `~/feedback-service/data/20261012/`). Anonymity verified: no raw session id,
  no keys, hashed IP at the endpoint.
- **Triage root-caused and fixed (2026-10-13 morning)**: two defects —
  (1) the triage agent preset defaulted to `system-analysis`, which is a
  *permission* preset; the agent preset must be `sysadmin` (mirroring the
  first-run investigation); (2) the reply watcher read `event.data.content`
  while `assistant/message` carries content at `event.data.message.content`,
  so no reply was ever captured and the runner returned null silently.
  Fixed both; the live run now returns a parsed analysis
  (`{category, severity, summary, details}`) and the endpoint stores it
  (`analysisCategory` in the admin list). Free-route latency is variable
  (≈20 s–3 min), so the dialog can wait on the pipeline.
- **Observation**: plugin `ctx.logger.warn` output does not reach the service
  journal — silent failures in plugins are invisible; the triage keeps one
  `console.error` line on the no-reply path until the logger wiring is fixed.
- **Follow-ups**: collect's deprecated `snapshotEvents` → live-event migration;
  a browser e2e asserting the four checkboxes; a server-side contract test for
  telemetry-only payloads; the `session.prompt` RPC shape (for richer context
  testing).
