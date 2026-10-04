---
description: "The SearXNG-backed search provider for ctx.web: how deployments mount a keyless, self-hosted meta-search instance and map its JSON results onto the web seam."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-searxng`, the harness searches the web through a SearXNG instance and gets its aggregated, keyless results. Choose it for self-hosted or community instances that need no vendor key. The instance base URL is required, and the instance owns authentication and rate limiting. Each result maps `content` to `snippet`, and `publishedDate` is normalized to ISO-8601 when parseable and dropped otherwise. SearXNG returns no generated answer, so results carry only citeable sources. The model-facing `web_search` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `searxng` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: searxng`.

### When to choose it

Choose this backend when a deployment runs or trusts a SearXNG instance and wants aggregated results with no vendor API key. The provider is usable whenever the configured instance base is a parseable http(s) URL; a search then fails at the instance, and an unparseable or non-http(s) base makes the provider unavailable to selection.

### Minimal configuration

Load the web service and the provider. `baseURL` is required because SearXNG has no public default instance; a missing value fails the plugin load. The instance's own settings decide which engines and output formats are available.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: https://searx.example.org
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | (required) | Instance base URL; `/search` is appended. An unparseable or non-http(s) value makes the provider unavailable |
| `categories` | (unset) | Comma-separated SearXNG categories, e.g. `general,news` |
| `language` | (unset) | Language code sent as `language`; `auto` defers to the instance |
| `timeRange` | (unset) | Recency window sent as `time_range`: `day`, `week`, `month`, or `year` |
| `engines` | `[]` | Restrict results to these engine names; joined with commas. Empty = every engine of the selected categories |
| `safesearch` | (unset) | Safe-search level sent as `safesearch`: `0` none, `1` moderate, `2` strict |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each SearXNG result maps to a `WebSearchSource`: `url`, `title`, `content` as `snippet`, and `publishedDate` as `publishedAt` after normalization to an ISO-8601 instant. A result without a usable `content` stays as a URL-only source rather than being dropped. SearXNG returns no generated answer, so the result carries no `content`. A request's `maxResults` is not sent to the instance; the web service enforces the final bound, truncating and flagging on the way back.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. An HTTP 403 names the common trap: many public instances disable the JSON output format, so the error reads `SearXNG instance refused the request (HTTP 403); many public instances disable the JSON output format — enable "json" under the instance's search.formats setting or use another instance`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin, keyless adapter over SearXNG's JSON API with two deliberate rules:

- **Portable snippets only.** A source gains a `snippet` from SearXNG's real `content`; a missing `content` leaves a URL-only source rather than inventing text.
- **No fabricated timestamps.** `publishedDate` reaches `publishedAt` only after parsing to an ISO-8601 instant; an unparseable value is dropped because the seam types `publishedAt` as ISO-8601.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, required endpoint, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `SearxngSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | SearXNG wire types: `SearxngSearchResponse`, `SearxngResult`, `SearxngError` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

Each operation snapshots the live config section. `search()` sends a keyless `GET` to `{baseURL}/search` with `q` and `format=json`, plus the optional `categories`, `language`, `time_range`, `engines`, and `safesearch` parameters, and `redirect: 'error'`, so a redirect fails the request without contacting the target. The parsed `results[]` are mapped one by one, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the web package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, snippets, and normalized publication dates or its exact `SearXNG search aborted`, `SearXNG search request failed: <error>`, `SearXNG returned an unprocessable response body: <error>`, JSON-format-refusal, and HTTP-error failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **Public instances often disable JSON** — `/search?format=json` answers 403 unless the instance enables `json` under `search.formats`; the error names that trap, but the provider cannot make the instance serve it.
- **`timeRange` is deployment-level** — the seam's request carries no recency field, so per-query recency is impossible without a seam change; one mounted provider serves one window.
- **`publishedDate` is engine-dependent** — SearXNG returns it only when the contributing engine does; relative or unparseable text is dropped rather than converted to a fabricated timestamp.
- **No instance authentication support** — the provider sends no credential, so an instance behind HTTP auth cannot be used.
- **Unknown engine names are ignored by the instance** — SearXNG silently drops `engines` entries it does not know, so a typo narrows results without an error.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: per-query recency and instance authentication

SearXNG's recency window is exposed as vendor config because the web service has no provider-neutral recency field; a future provider-neutral request vocabulary would move it out of per-provider config and make it per-query. Instance credentials (HTTP auth) are deferred until a deployment needs them.

</details>
