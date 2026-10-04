---
description: "The Exa-backed search provider for ctx.web: how deployments mount vendor-native web search with portable snippets and publication dates."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-exa

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-exa`, the harness searches the web through Exa and gets vendor-native results with portable snippets and publication dates. Choose it for Exa's semantic search with date, category, and domain filters. Exa returns no generated answer, so results carry no `content` — only citeable sources. A result with no non-blank highlight is dropped unless the request asked for page text, whose leading excerpt then stands in. The API key resolves through `ctx.credentials` on every search, so a vault-stored key applies without a restart. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `exa` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: exa`.

### When to choose it

Choose this backend when a deployment holds an Exa API key and wants Exa's semantic search with per-result highlight snippets, publication dates, and Exa's date/category/domain filters. The provider stays selectable whenever it can resolve a credential, and a search with no key fails at call time with `WEB_PROVIDER_CREDENTIAL_MISSING` naming the credential reference. A non-volatile misconfiguration (an unparseable endpoint base, a non-positive result limit) makes the provider unavailable to selection.

### Minimal configuration

Load the web service and the provider. The key resolves in this order: the literal `apiKey`, then the credential reference `apiKeyEnv` through `ctx.credentials` (the wizard and Settings write here), then the launch environment variable named by `apiKeyEnv`. Store the key in the vault rather than in YAML; the row is editable in Settings under the `web-search-exa` namespace, and the secret is redacted from every described value.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKeyEnv: EXA_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Exa API key; prefer `apiKeyEnv` so no secret enters configuration files |
| `apiKeyEnv` | `EXA_API_KEY` | Credential reference resolved per search through `ctx.credentials`, with the launch environment as the fallback plane |
| `baseURL` | `https://api.exa.ai` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable |
| `searchType` | `auto` | Retrieval mode sent as Exa's `type`: `instant`, `fast`, `auto`, `deep-lite`, `deep`, or `deep-reasoning` |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`; must be a positive integer |
| `highlightsPerResult` | `1` | Highlight excerpts requested per result; `1` sends Exa's boolean `highlights: true`, larger counts send the deprecated-but-accepted `highlightsPerUrl` |
| `startPublishedDate` / `endPublishedDate` | (unset) | ISO-8601 bounds on the publication date |
| `category` | (unset) | Exa data category: `company`, `people`, `publication`, `news`, `personal site`, or `financial report` |
| `includeDomains` / `excludeDomains` | (unset) | Domain or domain-path filters (wildcard subdomains supported), up to 1,200 entries each |
| `livecrawl` | (unset) | `true` forces a live fetch by sending `contents.maxAgeHours: 0` |
| `text.maxCharacters` | (unset) | Requests full page text capped at this many characters; the cap is required because an unset object and an empty one are indistinguishable |
| `summary` | (unset) | `true` requests a generated per-page summary |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-exa) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each Exa result maps to a `WebSearchSource`: `url`, `title`, the first non-blank highlight as `snippet`, and `publishedDate` as `publishedAt`; when `text` was requested, a highlight-less result instead carries a leading text excerpt (bounded to 500 characters) as `snippet`, and only truly empty results are dropped. A request's `maxResults` wins over the configured `numResults` default and is sent to Exa as a cost and latency optimization — the final bound is enforced by the service, which truncates and flags. Exa returns no generated answer, so the result carries no `content`.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies, and credential-resolution failures — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. A search with no resolvable key surfaces as `WEB_PROVIDER_CREDENTIAL_MISSING` naming `apiKeyEnv`. A `company` or `people` category combined with `startPublishedDate`, `endPublishedDate`, or `excludeDomains` is rejected locally with `WEB_PROVIDER_ERROR` before dispatch, because Exa answers that combination with HTTP 400. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Exa's API with two deliberate rules:

- **Portable snippets only.** A source gains a `snippet` from a real highlight; only when the request asked for page text does a leading excerpt of that text stand in, so the seam never invents content the provider did not return.
- **No invented answers.** Exa returns no generated answer, so `content` is omitted rather than fabricating provider prose the model might trust.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `ExaSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Exa wire types: `ExaSearchResponse`, `ExaResult`, `ExaError` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

Each operation snapshots the live config section, rejects the unsupported category/filter combination, and resolves the credential for that request only. `search()` posts the query, retrieval mode, `contents` (highlights in the modern boolean form, plus optional text, summary, and `maxAgeHours: 0`), filters, and optional result count to `{baseURL}/search` with `redirect: 'error'`, so a redirect fails the request without contacting the target. The parsed `results[]` are mapped one by one with the text fallback when text was requested, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the six-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-exa) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, snippets (highlights or text excerpts), and publication dates or its exact `Exa search aborted`, `Exa search request failed: <error>`, `Exa returned an unprocessable response body: <error>`, credential-missing, and unsupported-category failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **A result with no non-blank highlight is dropped entirely unless text was requested** — without `text`, there is no portable snippet to map, so fewer sources than requested can return; with `text`, the fallback excerpt is bounded to 500 characters.
- **`text` requires `maxCharacters`** — a schemastery object node resolves to `{}` when unset, so an absent cap cannot be distinguished from an unset field; enable text by setting the cap.
- **`company`/`people` reject date and exclusion filters** — Exa answers those combinations with HTTP 400, so the provider rejects them locally with `WEB_PROVIDER_ERROR` before dispatch.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider Exa control surface

Exa's filter and contents controls are now exposed as vendor config because the web service has no provider-neutral fields for them; a future provider-neutral request vocabulary would move them out of per-provider config.

</details>
