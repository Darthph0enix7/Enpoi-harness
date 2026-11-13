# dsh-enpoi-provider-sync

English | [中文](README.zh.md)

Catalog sync for the Web profile. Each pass lists configured `llm-pi-ai` and Command Code routes, enriches entries from a route's declared registry metadata, models.dev, and the installed catalog, and writes the planned records through the settings seam. Command Code reads its bundled snapshot instead of probing an endpoint. A non-catalog route's listing also lands in `$DSH_HOME/cache/discovered-models.json` for the resolution layer.

## Refresh and membership

An endpoint-authority route converges on the ids its listing advertises whenever the listing fetched. A catalog-authority route converges on the advertised ids the fresh models.dev provider confirms and needs both sources fresh. The overlay's `remove` list applies last. `force` (manual refresh) bypasses the unattended more-than-half shrink guard. An empty effective set still aborts unless the configured route profile explicitly declares `catalogAuthority: 'endpoint'`.

`providerSync.refreshRoute` returns the cleanup union — membership removals and overlay removals — so a client that merges stored rows cannot resurrect an overlay-removed id. `providerSync.refreshRoutes` reports the same union per route.

## Precedence

1. A `source: 'manual'` record keeps the fields named by its `manualFields` list over the listing, registry metadata, and an overlay `upsert`. An absent list keeps the historical seven (`name`, `contextWindow`, `maxInputTokens`, `maxTokens`, `input`, `reasoning`, `reasoningEfforts`); an explicit empty list freezes none. `cost`, `costTiers`, `releaseDate`, `output`, and `tools` are preserved only when named. A present list naming an unknown field fails that route's refresh instead of silently freezing nothing.
2. An overlay `upsert` wins over the listing and inferred metadata for the fields it names; fields the operator declared on a manual record still win.
3. A `pinnedModels` id and a manual record survive an overlay `remove` as current records.
4. An overlay `remove` id that a route-local reference still names stays as a `source: 'pinned-in-use'`, `deprecated: true` record with the last facts it had. It is never treated as a current member again until the endpoint advertises it, and the pass reports the deprecation.
5. Any other overlay `remove` id is deleted.

Clearing the last manual field unsets `source` and `manualFields`, returning the row to ordinary refresh behavior. A later sync may then prune the row when its upstream id no longer exists; the page does not delete it eagerly or substitute a provider default. A hand-added row that predates `manualFields` keeps the historical seven without a migration write.

## Model metadata and prices

A stored model may carry the `source` labels `configured`, `manual`, `discovered`, or `pinned-in-use`; a missing label is older configuration, not an error. Only `manual` grants membership protection. The Models page writes a `manual` row with an explicit `manualFields` list; a catalog edit writes the same facts as a per-model `modelOverrides` entry and never materializes a route `models` array.

`cost` holds USD-per-million catalogue prices for `input`, `output`, `cache_read`, and `cache_write`; `costTiers` holds request-wide prices above an input-token threshold; `releaseDate` is a `YYYY-MM-DD` catalogue date. These are catalogue metadata, not a provider bill: the harness does not charge from them and never changes a runtime cost or request budget. A row loaded from the installed catalog or a discovery reply may omit price, tier, or release fields; the operator may fill them manually, and the sync never invents them. `output` modalities are reserved catalogue metadata and are not editable from the Models page.

A manual capacity wins over a lower disclosed source, including when the operator's number exceeds the actual host tier. The route then attempts the configured capacity and the provider may reject the request; no automatic clamp rewrites the claim. Fields the operator leaves unset continue to resolve from the lower disclosed source.

## Registry metadata

`metadataSources` maps a configured provider route id to an exact registry declaration; the shipped default declares `cliproxyapi` with the pinned CLIProxyAPI baseline. A declaration is enrichment only: it never changes membership, empty-listing authority, or `catalogAuthority`, and no model-id prefix or family guess ever selects metadata. A declaration is data keyed by the route id — renamed user-created instances add their own key.

```yaml
metadataSources:
  cliproxyapi:
    source: cliproxyapi
    # optional: exact channel, owner override, or extra owner aliases
    channel: codex-free
    ownerChannels:
      openai: [codex-free]
    # optional opt-in: bounded raw registry refresh, never a rich client projection
    # sourceVersion is required with refreshUrl; the bundled label is never reused
    refreshUrl: https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/master/internal/registry/models/models.json
    sourceVersion: master
```

The endpoint's `owned_by` scopes the lookup; `owner`, `channel`, and `ownerChannels` exist for renamed custom instances or an instance whose channels cannot be inferred. A missing owner and channel is an unknown lookup, never an id-only fallback. Declaring both `refreshUrl` and its actual `sourceVersion` opts the route into background startup/hourly refresh: sources run concurrently under one in-flight promise, are aborted on teardown, and retain last-good or the bundled baseline for the pass that is already running. Manual refresh uses the current last-good/baseline immediately rather than waiting on the network. Omitting the URL performs no registry network read. Membership still comes only from the route's inference `/models`. The registry supplies exact metadata only: no `?client_version` rich projection, no `base_instructions`, no membership.

When resolved, registry fields sit between the endpoint's own disclosure (including read-only sibling endpoints on the same host such as Gemini `/v1beta/models`, Anthropic `/v1/models`, LM Studio `/api/v0/models`, LiteLLM `/model/info`, and Ollama `/api/show` when the primary `/models` reply omits metadata) and owner-scoped models.dev: exact endpoint fields, then sibling endpoint fields, then registry (exact or cross-channel consensus), then owner-scoped models.dev (restricted to recognized first-party vendor owners, never generic self-hosted engines), then the installed catalog, then runtime route defaults. A larger external models.dev `contextWindow` never overrides a smaller host-disclosed `maxInputTokens`. A `source: 'manual'` record still wins every field the operator declared. Raw level names outside the settings vocabulary stay diagnostics; a budget-only `thinking` record offers no named ladder. Provenance source/version is reported in the `provider-sync/registry-metadata` diagnostic because the current settings and discovered-cache schemas have no provenance field.

## References

A model is protected when the route's default selection, an `enpoi-orchestration.chains` link, an `enpoi-orchestration.personas` seat's direct provider/model route, a `subagent-model-selection-settings.allowedModels` entry (also read under the `subagent-model-selection` spelling), or a picker favorite names it. References are re-read for every plan and every settings-conflict retry, so a reference written while a write is in flight still protects its model.

## Capability honesty

A ladder reaches settings only from a listing it advertised, a resolved registry record's named levels, or a catalog source that supplied usable levels. `reasoning: true` alone supplies no ladder; a budget-only registry record stays ladderless rather than inventing all six. Unknown level ids are dropped, an explicit `off` stays as the valueless key, and an `off`-only ladder is omitted because settings refuse it. `maxInputTokens` is persisted beside the combined context window. When the endpoint disclosed only an input cap (Gemini `/v1beta/models` `inputTokenLimit`, Anthropic `max_input_tokens`) and no source disclosed a combined window, that cap is the window the route accepts and is written as `contextWindow` too — the endpoint's own number, which is what keeps a smaller hosting tier (a 372K Codex plan) from reading as the vendor's 1M window. A non-positive capacity a source states (`0` for an image model) is treated as undisclosed and dropped: one such value fails the `models` schema and would block the whole route's write. A capacity no source disclosed is omitted, leaving the route's `defaultContextWindow` / `defaultMaxTokens` to resolve it at request time instead of persisting an adapter default as a disclosed fact. A fact an earlier pass disclosed is never erased by a later pass that is silent about it (a missed sibling probe cannot downgrade a described model), and `unverified: true` marks a record whose numbers and capabilities nothing described. A provider that explicitly states `reasoning: false` clears an unfrozen reasoning ladder; a frozen `reasoning` or `reasoningEfforts` claim survives that refusal.

## Capacity and enrichment sources

The shipped profile declares no `capacityDefaults`. The config key stays accepted for compatibility: an operator who sets it is stating an explicit route-level assumption, and the sync never persists it as a per-model fact. Only an endpoint disclosure, an exact registry record, models.dev, the installed catalog, a `source: 'manual'` record, or an overlay `upsert` reaches the stored capacities; an unsized id stays unsized and the route resolves its labeled `defaultContextWindow` / `defaultMaxTokens` at request time. models.dev `limit.context` and `limit.input` are separate facts: a record that publishes only the input cap yields `maxInputTokens`, and the endpoint's own cap stands in as `contextWindow` when no combined window was disclosed.

Enrichment is exact-id only across models.dev, the installed catalog, and the registry. Suffix stripping, family prefixes, vendor-stripped short ids, and case-folded spellings are not aliases; an exact record in a later mapped provider wins over an earlier non-exact one. A genuinely different alias belongs in an overlay `upsert` keyed by the exact id. Overlay upserts are validated through the shared pi-ai model schema; a malformed file is refused whole with a `provider-sync/catalog-overlays` diagnostic and the last good document keeps applying. `/models` replies are read through the shared listing parser and refused above the 4 MiB response bound.

## Tests

```sh
cd profile/web
pnpm vitest run packages/enpoi-provider-sync
```

## Known gaps

The `metadataSources` refresh URL and source version are not exposed in the settings UI yet, so a manifest/operator config edit is currently required to opt in. Registry source/version and unsupported-effort fields have no settings-schema home; they remain diagnostics until the core schema adds them. Per-field capacity origin is not stored, so unresolved capacities are omitted and left to the route defaults rather than labeled per field here. The discovered cache now stores a budget-only record's reasoning flag, but the core catalog materializer currently ignores that flag; a separate adapter-lane fix is required before a cache-only route preserves reasoning without a named ladder.
