# Commandcode route: native key pool instead of the standalone proxy

Status: FLIPPED (2026-10-06) — live gate PASSED; the shipped route is the direct
vendor endpoint with the native pool. The standalone `~/.config/opencode/keypool`
proxy (`:8899`) is no longer a dependency of this route.
Recon: exp-5 decision memo (session archive); this doc is the durable summary.

## Live-gate result (2026-10-06)

Owner-run, owner's key, no proxy (`scripts/live-gate.mjs`):

- With the four CLI headers: HTTP 200 (SSE started).
- Without them: HTTP 403 `upgrade_required` ("Your Command Code CLI is out of
  date", minVersion 0.18.10). The four CLI headers are the gate.
- The pooled adapter driven directly against `https://api.commandcode.ai`
  streamed a real completion (usage input 50 / cacheRead 7552); with a bad
  identity at priority 1 and the good one at priority 2 it logged
  `identity "bad" failed (AUTH); rotating` and completed on the good identity
  with text `DIRECT-POOL-OK`.

## Flip record (2026-10-06)

The manifest entry is reshaped to a direct-vendor, pool-native route:

- `delivery: 'direct'`, baseURL `https://api.commandcode.ai` (reuse and local),
  `defaultPort: 443`, health probe `https://api.commandcode.ai/` (the vendor
  root answers 200 unauthenticated; it exposes no health or catalog endpoint).
- `auth: { kind: 'unified', apiKeyEnv: 'COMMANDCODE_KEY_1' }` plus a starter
  `pool` identity (`{ id: key-1, credentialRef: COMMANDCODE_KEY_1, priority: 1 }`)
  written into the `commandcode-provider` settings namespace. A fresh route is
  pooled from its first request: a credential-less request fails with
  `MISSING_CREDENTIAL` naming the Keys card, never an anonymous fallback.
- Install is the one shared, idempotent step: link and build the provider
  package (`scripts/install.mjs`). No `requiresFiles`, no proxy deploy, no
  seed, no health-wait, no systemd/launchd unit, and no `keypool-remove.mjs`
  teardown; removal drops DSH state only.
- Migration helper: `scripts/import-keypool-keys.mjs` reads the old
  `pools.json` and prints the settings `pool` identities block
  (`COMMANDCODE_KEY_<n>`, ids and priorities preserved) plus the Keys-card/env
  steps. It writes nothing and prints no key material.

## Decision

The commandcode route should be **self-contained in the harness**: reuse the
built-in key pool (`llm-pi-ai` `PoolEngine`) inside `enpoi-commandcode-provider`
and port the proxy's protocol extras (CLI headers, request sanitizer) into the
adapter. The standalone `~/.config/opencode/keypool` proxy (`:8899`) stops being
a hard dependency.

Fallback if live vendor testing disproves the direct path: vendor `proxy.js`
(+ its test) into the profile and deploy it on demand. Keep the keypool
manifest paths until the direct path is proven. (Retired: the live gate passed
and the flip landed; the vendored-proxy branch is not shipped.)

## What each side owns

| Feature | Harness `PoolEngine` | Standalone `proxy.js` |
|---|---|---|
| Multi-key rotation | `pool.identities[]` (credential refs), `priority-sticky` / `balanced` | `pools.<name>.keys[]` (inline secrets), priority / round-robin |
| Cooldowns | per identity×model; AUTH 15m, QUOTA 30s→parsed reset, CAPACITY 60s tiers, ENTITLEMENT 6h | per pool×key; base 1h, quota wording 6h, `max(cd, parsed reset)` |
| Quota/reset parsing | full-word `resets in 4hr 53min`, first phrase | shorthand `3h 25m`, sums pairs |
| Failure classes | 8 classes incl. POLICY / ENTITLEMENT / TRANSIENT | RETRYABLE 401/402/403/429 + quota/transient regexes, 5xx same-key retry |
| Usage tracking | routing state + attempt records + Keys card | `state.json` counters + append-only `usage.jsonl` + `/keys`, `/status` |
| CLI headers | not present | injects `x-command-code-version: 1.54.0`, `x-cli-environment: production`, `x-project-slug: opencode`, `user-agent: cli` |
| Sanitizer | generic image budgets | commandcode-aware: 16 MiB image budget (newest kept), base64 scrub ≥512 chars, 200k tool-text cap, 413 → strip-oldest retry once, same key |
| Catalog | generic model discovery | serves `/commandcode/catalog.json` from `catalogPaths` |
| Protocol | 3 pi-ai protocols | verbatim forward (no translation) |

Both sides need the native adapter for the `/alpha/generate` envelope; the
proxy is not a translator.

## Gaps to close before dropping the proxy

1. Live vendor gate: prove the 4 CLI headers alone turn `Proxy use detected`
   into a normal response (needs a real key — owner-run script).
2. Auth shape: proxy sends `Authorization: Bearer <key>` **and** `x-api-key`;
   the adapter must send the same per-identity key.
3. Reset parsing: port shorthand (`d/h/m/s/w`, summed) into the pool parser.
4. Quota vocabulary: add commandcode fixtures (`weekly usage limit`,
   `insufficient credits`, 402/403 bodies) to the classifier tests.
5. Sanitizer: port budget/scrub/cap/413 behavior to operate on the
   commandcode envelope; reconcile with the converter's existing 12-image /
   16 MiB forward budget instead of stacking.
6. Commit barrier: commit at the first content delta; rotate only before
   commit; 413 retry once on the same identity.

## Plan (staged)

- (i) This doc + Oracle design review. — done.
- (ii) Land reset-parser extension (`llm-pi-ai`, benefits all routes) with tests. — done.
- (iii) Land sanitizer + headers + pool loop in `enpoi-commandcode-provider`
  behind an opt-in `pool` setting. — done.
- (iv) Owner-run live gate: direct vendor request with CLI headers, rotation on
  429, 413 strip, cooldown persistence. — done (gate PASSED; see above).
- (v) Flip the manifest: drop the `:8899` dependency and the deploy/seed steps
  for the pooled path. — done; the vendored-proxy fallback branch was not
  needed and the external proxy is no longer part of the route.
- (vi) Docs + migration note (`pools.json` keys → credentials store identities). — done;
  `scripts/import-keypool-keys.mjs` and the manifest quirks carry the migration.

## What the owner provides

Commandcode account keys: one identity per key in the route profile
(`providers.commandcode.pool.identities[] {id, credentialRef, priority}` under
the `commandcode-provider` settings namespace) with the secret stored via the
Models-page Keys card (credentials store) or an environment variable — never in
settings YAML. `scripts/import-keypool-keys.mjs` maps the old `pools.json` keys
1:1 by id to `COMMANDCODE_KEY_<n>` references for continuity.

## Risks

- Vendor gate wording is undocumented; live test is the only proof.
- Live catalog refresh is lost unless the vendor exposes a catalog endpoint
  (the bundled 83-model snapshot is the catalog for a direct route; a legacy
  loopback keypool route still serves `/commandcode/catalog.json`).
- Operators sharing `:8899` across tools lose that sharing by design
  (self-containment wins); document it.
- `usage.jsonl` forensics are not replaced; the Keys card + attempt records and
  the provider logs are the native-pool equivalents. Decide whether a
  per-attempt usage log is worth adding.

## Oracle amendments (ora-2, 2026-10-06) — required before the manifest flip

Verdict: PROCEED WITH AMENDMENTS. Five must-fixes on top of the staged plan:

1. **Export the pool engine.** `PoolEngine` is not exported by
   `@deepseek-ai/dsh-llm-pi-ai` (`packages/llm/llm-pi-ai/src/index.ts`); export
   it with its types (`PoolFailureClass`, `ROTATING_CLASSES`) — or promote
   `pool.ts` to `@deepseek-ai/dsh-llm` — so the commandcode adapter reuses it
   instead of forking the logic.
2. **Register Keys-card surfaces.** `enpoi-commandcode-provider` must call
   `ctx.llm.registerConfigurableProviders(...)` (settingsNs
   `commandcode-provider`) and `ctx.llm.registerPoolOperations(...)`
   (`status` / `resetCooldown` / `testIdentity`), or `llm.poolStatus()` returns
   empty and the Keys card cannot show cooldowns or test identities.
3. **Header precedence.** Attribution injects
   `user-agent: DeepSeek-Harness/…`; the vendor gates on `user-agent: cli`.
   The CLI header set must explicitly override attribution headers per attempt.
4. **No double image budgeting.** The converter already budgets forward images
   (12 images / 16 MiB / 8 MiB per image, tool-image hoisting). Do not re-run a
   full budget pass over `params.messages`; keep text sanitization inside
   `convert.ts` and reserve `stripOlderImagesKeepingNewest` strictly for the
   413 retry on the envelope.
5. **Divergent error trapping.** Commit barrier = first non-buffered chunk
   yielded downstream (not `block-start`); pre-commit thrown `LlmError`s rotate
   after `recordFailure`, post-commit ones cool the key and re-throw.

Observations to fold in: `CatalogStore` must skip the `${baseURL}/catalog.json`
fetch when `baseURL` is not loopback (it would 404 every startup and only then
fall back to the snapshot); `testIdentity` needs a lightweight test request
(there is no model-discovery endpoint); after the flip, the
`keypool-remove.mjs` removal step becomes a plain settings mutation and the
custom removal script is obsolete.

**Required before the manifest flip** (batch review, 2026-10-06): route profiles
are parsed once in `apply()` and closed over, so settings edits (a new pool
identity, a toggled key, a baseURL change) are not observed until a remount.
Make the profiles dynamic — re-evaluate on volatile settings updates, as
`llm-pi-ai` does — so the Keys card and Settings take effect on the next
request without a daemon restart. Until then the pooled path is test-only.

**Landed** (commit `fix(commandcode): route profiles are live, not mount-frozen`):
per-operation profile resolution, the `loader/volatile-update` re-registration
seam, and the `internal/config` refusal of unserviceable writes — the flip no
longer depends on a restart to observe settings edits.
