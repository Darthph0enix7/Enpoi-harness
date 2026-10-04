# dsh-enpoi-catalog-rules

Dynamic rule/filter engine for the synced model catalogue (doc 82 §E5). Rules
are **data** in `enpoi-orchestration.catalogRules`; the engine reads them plus
the hourly-synced `llm-pi-ai` catalogue and provides the `catalogRules` service.
It publishes only the derived `catalogRules.resolved` decision map the picker
reads (never the rules document) and never deletes catalogue entries —
hide ≠ delete. The map rides the settings **artifact channel** on a host that
serves it, so publishing it costs no document revision, profile write, Loader
reload, or whole-document fan-out; on mount the engine also removes the
persisted pre-artifact copy from `enpoi-orchestration` so describes stop
carrying it. A pre-artifact host keeps the legacy document write.

## Document

```yaml
enpoi-orchestration:
  catalogRules:
    version: 1
    privacy:
      providers: { mistral: trains, groq: no-train }   # route id → trains | no-train
      models: { mistral/mistral-large-latest: no-train } # provider/model or bare id; beats provider
    visibility:
      hide:
        - id: zero-price
          when: { zeroPrice: true }                     # reason defaults to the predicate summary
          # reason: "free tier"                          # optional picker string
    overrides:
      hidden: { openrouter: [some/model] }              # manual hidden pins
      shown: { openrouter: [other/model] }              # manual visible pins
      gated: { providers: [], models: [] }              # unavailable from this client
```

Predicates (all present clauses ANDed): `zeroPrice`, `maxPrice`, `tools`,
`vision`, `reasoning`, `minContextWindow`, `provider`, `providerGlob`,
`idGlob`, `nameGlob`, `noTraining`, `gated`. Unknown price/context/name fails
the clause rather than guessing; **unknown privacy fails `noTraining` in both
directions** — never treated as safe. The curated privacy seed lives in
`src/rules.ts` and the profile settings document.

## Precedence

Manual hidden (the picker's `uiPreferences.hiddenModels` plus
`overrides.hidden`) > manual shown (`overrides.shown`) > gated marker > hide
rules > default visible. The picker renders `decide()`'s `reason`, e.g.
`hidden by rule: zero-price`, `gated`, `hidden manually`, or
`pinned visible (rule: zero-price)`.

## Published decisions

On every refresh the engine republishes `catalogRules.resolved`: a
`provider/model`-keyed map of `{ state, reason, source, rule?, overriddenRule? }`.
Default-visible entries are omitted (absence = visible), so the map carries
exactly what a client cannot derive: hidden entries with their reason, and
manual pins with the rule or gate they override. The composer picker reads it
through the settings document; manual hidden pins still filter client-side for
0ms.

## Group selectors

Chains may mix explicit `links` with `selectors`, expanded live through
`ctx.get('catalogRules').expandSelector()` when the chain resolves. Matches are
best-first (known-cheapest price, larger context, then id). A selector adopts
the matches present at its first evaluation; `adopt: true` (opt-in) also
adopts new matches continuously and announces them on stderr, while the
default `adopt: false` holds newer matches as preview-only candidates.

## Discipline

A hide rule or manual pin that matches nothing emits a warning; a selector
that matches nothing keeps the explicit links (and warns). `previewRulesChange`
diffs a proposed document's hidden/gated effect over the live catalogue before
the edit is applied.

## Service

`visibility()`, `decide(provider, model)`, `expandSelector(selector)`,
`expandRawSelector(raw)` (the model-chains seam), `previewRulesChange(raw)`,
`warnings()`.

## Verification

```sh
pnpm exec vitest run packages/enpoi-catalog-rules packages/enpoi-model-chains
```
