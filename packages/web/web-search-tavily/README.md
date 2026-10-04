---
description: "The Tavily-backed search provider for ctx.web: how deployments mount agent-tuned web search with portable snippets, normalized publication dates, and an optional generated answer."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-tavily`, the harness searches the web through Tavily and gets agent-tuned result snippets with normalized publication dates. Choose it for Tavily's reranked, high-signal chunks and its permanent free tier. A requested generated answer maps to `content`; without one, results carry only citeable sources. `published_date` is normalized to ISO-8601 when parseable and omitted otherwise. The API key resolves through `ctx.credentials` on every search, so a vault-stored key applies without a restart. The model-facing `web_search` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `tavily` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: tavily`.

### When to choose it

Choose this backend when a deployment holds a Tavily API key and wants agent-tuned snippets with an optional generated answer. The provider stays selectable whenever it can resolve a credential, and a search with no key fails at call time with `WEB_PROVIDER_CREDENTIAL_MISSING` naming the credential reference. A non-volatile misconfiguration (an unparseable endpoint base, a non-positive result limit) makes the provider unavailable to selection.

### Minimal configuration

Load the web service and the provider. The key resolves in this order: the literal `apiKey`, then the credential reference `apiKeyEnv` through `ctx.credentials` (the wizard and Settings write here), then the launch environment variable named by `apiKeyEnv`. Store the key in the vault rather than in YAML; the row is editable in Settings under the `web-search-tavily` namespace, and the secret is redacted from every described value.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Tavily API key; prefer `apiKeyEnv` so no secret enters configuration files |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential reference resolved per search through `ctx.credentials`, with the launch environment as the fallback plane |
| `baseURL` | `https://api.tavily.com` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable |
| `searchDepth` | `basic` | Retrieval depth sent as Tavily's `search_depth`: `basic` (1 credit) or `advanced` (2 credits, reranked chunks) |
| `maxResults` | (unset) | Default result count when a request carries no `maxResults`; Tavily caps a request at 20 |
| `includeAnswer` | (unset) | Request a generated answer: `true`/`basic` for a quick answer, `advanced` for a detailed one |
| `timeRange` | (unset) | Recency window sent as Tavily's `time_range`: `day`, `week`, `month`, or `year` |
| `topic` | (unset) | Search category sent as Tavily's `topic`: `general`, `news`, or `finance` |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each Tavily result maps to a `WebSearchSource`: `url`, `title`, `content` as `snippet`, and `published_date` as `publishedAt` after normalization to an ISO-8601 instant. A result without a usable `content` stays as a URL-only source rather than being dropped. A non-empty generated `answer` becomes the result's `content`. A request's `maxResults` wins over the configured default and is sent to Tavily as a cost and latency optimization, clamped to Tavily's ceiling of 20 — the final bound is enforced by the service, which truncates and flags.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies, and credential-resolution failures — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. A search with no resolvable key surfaces as `WEB_PROVIDER_CREDENTIAL_MISSING` naming `apiKeyEnv`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Tavily's API with two deliberate rules:

- **Portable snippets only.** A source gains a `snippet` from Tavily's real `content`; a missing `content` leaves a URL-only source rather than inventing text.
- **No fabricated timestamps.** `published_date` reaches `publishedAt` only after parsing to an ISO-8601 instant; an unparseable value is dropped because the seam types `publishedAt` as ISO-8601.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `TavilySearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Tavily wire types: `TavilySearchResponse`, `TavilyResult`, `TavilyError` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

Each operation snapshots the live config section and resolves the credential for that request only. `search()` posts the query, depth, optional result count (clamped to 20), answer request, recency window, and topic to `{baseURL}/search` with `Authorization: Bearer` and `redirect: 'error'`, so a redirect fails the request without contacting the target. The parsed `results[]` are mapped one by one, a non-empty `answer` becomes `content`, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

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

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, snippets, normalized publication dates, and any requested generated answer or its exact `Tavily search aborted`, `Tavily search request failed: <error>`, `Tavily returned an unprocessable response body: <error>`, credential-missing, and HTTP-error failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **`searchDepth` exposes only `basic` and `advanced`** — Tavily also offers `fast` and `ultra-fast`; they are deferred until a consumer needs their latency profile.
- **`published_date` is provider-side and beta** — Tavily returns it only when it detects a date (automatically for `topic: news`), so a source without one carries no `publishedAt`; the provider never invents a date.
- **A generated answer is unverified provider prose** — `includeAnswer` maps Tavily's `answer` to `content`, which the model may trust; leave it unset when only citeable sources are wanted.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: wider Tavily control surface

Tavily's depth, recency, topic, and answer controls are exposed as vendor config because the web service has no provider-neutral fields for them; a future provider-neutral request vocabulary would move them out of per-provider config.

</details>
