---
description: "The Brave-backed search provider for ctx.web: how deployments mount vendor-native web search with portable snippets and normalized publication dates."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brave

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-brave`, the harness searches the web through Brave and gets vendor-native results with portable snippets and normalized publication dates. Choose it for Brave's independent index and sub-second latency. Brave returns no generated answer, so results carry no `content` — only citeable sources. `page_age` is normalized to ISO-8601 when it names a parseable date and dropped when it is relative text such as "2 days ago". The API key resolves through `ctx.credentials` on every search, so a vault-stored key applies without a restart. The model-facing `web_search` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `brave` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: brave`.

### When to choose it

Choose this backend when a deployment holds a Brave Search API key and wants an index independent of Google and Bing with sub-second p90 latency. The provider stays selectable whenever it can resolve a credential, and a search with no key fails at call time with `WEB_PROVIDER_CREDENTIAL_MISSING` naming the credential reference. A non-volatile misconfiguration (an unparseable endpoint base, a non-positive count) makes the provider unavailable to selection.

### Minimal configuration

Load the web service and the provider. The key resolves in this order: the literal `apiKey`, then the credential reference `apiKeyEnv` through `ctx.credentials` (the wizard and Settings write here), then the launch environment variable named by `apiKeyEnv`. Store the key in the vault rather than in YAML; the row is editable in Settings under the `web-search-brave` namespace, and the secret is redacted from every described value.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-brave'
  config:
    apiKeyEnv: BRAVE_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Brave API key; prefer `apiKeyEnv` so no secret enters configuration files |
| `apiKeyEnv` | `BRAVE_API_KEY` | Credential reference resolved per search through `ctx.credentials`, with the launch environment as the fallback plane |
| `baseURL` | `https://api.search.brave.com` | Endpoint base; `/res/v1/web/search` is appended. An unparseable value makes the provider unavailable |
| `count` | `10` | Default result count when a request carries no `maxResults`; Brave caps a request at 20 |
| `freshness` | (unset) | Deployment-level recency window: `pd` (past day), `pw` (past week), `pm` (past month), `py` (past year), or an ISO-8601 range `YYYY-MM-DDtoYYYY-MM-DD` |
| `country` | (unset) | Two-letter country code sent as Brave's `country` |
| `searchLang` | (unset) | Search-language code sent as Brave's `search_lang` |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each Brave result maps to a `WebSearchSource`: `url`, `title`, `description` as `snippet`, and `page_age` as `publishedAt` after normalization to an ISO-8601 instant. A result without a usable description stays as a URL-only source rather than being dropped. A request's `maxResults` wins over the configured `count` default and is sent to Brave as a cost and latency optimization, clamped to Brave's ceiling of 20 — the final bound is enforced by the service, which truncates and flags. Brave returns no generated answer, so the result carries no `content`.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies, and credential-resolution failures — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. A search with no resolvable key surfaces as `WEB_PROVIDER_CREDENTIAL_MISSING` naming `apiKeyEnv`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Brave's API with two deliberate rules:

- **Portable snippets only.** A source gains a `snippet` from Brave's real `description`; a missing description leaves a URL-only source rather than inventing text.
- **No fabricated timestamps.** `page_age` reaches `publishedAt` only after parsing to an ISO-8601 instant; relative text such as "2 days ago" is dropped because the seam types `publishedAt` as ISO-8601.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `BraveSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Brave wire types: `BraveSearchResponse`, `BraveWebResult`, `BraveError` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

Each operation snapshots the live config section and resolves the credential for that request only. `search()` sends a `GET` to `{baseURL}/res/v1/web/search` with `q`, `count` (clamped to 20), and the optional `freshness`, `country`, and `search_lang` parameters, authenticated with `X-Subscription-Token` and `redirect: 'error'`, so a redirect fails the request without contacting the target. The parsed `web.results[]` are mapped one by one, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

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

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, snippets, and normalized publication dates or its exact `Brave search aborted`, `Brave search request failed: <error>`, `Brave returned an unprocessable response body: <error>`, credential-missing, and HTTP-error failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **`freshness` is deployment-level** — the seam's request carries no recency field, so per-query recency is impossible without a seam change; one mounted provider serves one freshness window.
- **Relative `page_age` text is dropped** — Brave's age text is not guaranteed to be ISO-8601, and the seam types `publishedAt` as ISO-8601, so "2 days ago" is omitted rather than converted to a fabricated timestamp.
- **`count` is clamped to Brave's ceiling of 20** — a larger `maxResults` still returns at most 20 sources from Brave; the service enforces the caller's bound on the way back.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: per-query recency

Brave's freshness window is exposed as vendor config because the web service has no provider-neutral recency field; a future provider-neutral request vocabulary would move it out of per-provider config and make it per-query.

</details>
