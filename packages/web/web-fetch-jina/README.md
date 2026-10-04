---
description: "The Jina Reader-backed fetch provider for ctx.web: how deployments retrieve LLM-friendly Markdown through r.jina.ai, keyless or keyed, with honest truncation reporting."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-fetch-jina

English | [中文](README.zh.md)

## Summary

With `dsh-web-fetch-jina`, the harness fetches a URL through Jina Reader and gets LLM-friendly Markdown instead of raw HTML. Choose it for JavaScript-heavy pages, PDFs, and sites the anonymous HTTP fetcher cannot read. It works keyless at Jina's anonymous rate limit; a configured key raises the quota. Jina performs the target fetch, so SSRF trust moves to Jina. A configured `maxTokens` cap marks the result truncated when the response reaches it. With both `http` and `jina` mounted, pin `web.fetchProvider` or calls are ambiguous. The model-facing `web_fetch` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `jina` fetch provider. The `http` fetch provider is also usable, so with both mounted `ctx.web.fetch()` cannot auto-select one: pin `fetchProvider: jina`. The web-setup wizard's `applySetup` writes that pin into the profile; a hand-written profile must do the same.

### When to choose it

Choose this backend when a deployment wants Markdown extraction, JavaScript rendering, or PDF conversion rather than a raw page, and accepts that Jina fetches the target from its own infrastructure. The provider is usable whenever the configured endpoint base is a parseable http(s) URL; a key is optional, and the keyless request path stays available when no credential resolves.

### Minimal configuration

Load the web service and the provider, and pin the fetch provider. The key resolves in this order: the literal `apiKey`, then the credential reference `apiKeyEnv` through `ctx.credentials` (the wizard and Settings write here), then the launch environment variable named by `apiKeyEnv`. Store the key in the vault rather than in YAML; the row is editable in Settings under the `web-fetch-jina` namespace, and the secret is redacted from every described value. With no key at all, requests stay keyless at Jina's anonymous rate limit.

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    fetchProvider: jina
- name: '@deepseek-ai/dsh-web-fetch-jina'
  config:
    apiKeyEnv: JINA_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal Jina API key; prefer `apiKeyEnv` so no secret enters configuration files. Unset = keyless |
| `apiKeyEnv` | `JINA_API_KEY` | Credential reference resolved per fetch through `ctx.credentials`, with the launch environment as the fallback plane. A missing value keeps keyless mode |
| `baseURL` | `https://r.jina.ai` | Endpoint base; the target URL is appended as a path. An unparseable or non-http(s) value makes the provider unavailable |
| `engine` | (unset) | Browser engine sent as `X-Engine`: `browser`, `direct`, or `cf-browser-rendering`. Unset = Jina's automatic choice |
| `timeoutSeconds` | (unset) | Page-load wait in seconds sent as `X-Timeout`, from 1 to 180 |
| `maxTokens` | (unset) | Output-token cap sent as `X-Max-Tokens`, at least 500; Jina trims the Markdown at the cap instead of rejecting the request |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### What a fetch returns

The body is Jina's Markdown as a `text` body. `statusCode` is Jina's own response status: a successful read is `200` even when the target page answered `404`, and Jina records the target status inside the content as a `Warning: Target URL returned error 404: Not Found` line. `url` is the canonicalized target URL. `truncated` is derived from Jina's `x-usage-tokens` header: with `maxTokens` configured, a count at or above the cap marks the body truncated; without a cap, or without the header, the provider reports `false` rather than guessing from the body length.

### Failures and recovery

Provider failures — HTTP refusals such as an invalid key, rate limiting, or an unsupported target, plus network failures and credential-resolution failures — surface as `WebError` `WEB_PROVIDER_ERROR`, carrying Jina's `message` detail when the refusal body provides one; an aborted request surfaces as `WEB_ABORTED`. An invalid target (not http(s), or longer than 2048 characters) is rejected before any request as `WEB_INVALID_URL`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_fetch` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over Jina Reader with three deliberate rules:

- **Prefix form, no body protocol.** A fetch is a `GET` to `{baseURL}/<target-url>`, matching Jina's documented quickstart; the request carries no extraction prompt, schema, or cookie.
- **Only documented headers.** Every request header is taken from Jina's live documentation: `X-Engine` (`browser`, `direct`, `cf-browser-rendering`), `X-Timeout` (integer seconds, at most 180), and `X-Max-Tokens` (integer, at least 500). `X-Token-Budget` is documented too but is deliberately not exposed: it rejects over-budget requests, while the seam expects a bounded usable body.
- **Honest truncation.** `truncated` comes from the response's `x-usage-tokens` count against the configured cap, never from `text.length`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, credential and environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `JinaFetchProvider`: URL gate, request dispatch, abort classification, truncation derivation |
| [`src/types.ts`](src/types.ts) | Jina wire types: `JinaEngine`, `JinaError` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

Each operation snapshots the live config section and resolves the optional credential for that request only; a resolved key adds `Authorization: Bearer`, and no key leaves the request anonymous. `fetch()` validates the target as http(s) and at most 2048 characters, appends it to the endpoint base, and sends a `GET` with `redirect: 'error'`, so a redirect fails the request without contacting the target. Jina performs the target fetch; SSRF screening therefore moves to Jina for this provider, and the local gate covers only the scheme and length bounds. A successful response becomes a `text` body; a refusal becomes a `WebError`; an abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive fetch request/result vocabulary and error codes.
- [Web package map](../README.md) — the web package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-web-fetch-http](../web-fetch-http/README.md) — the anonymous local fetch provider this one is mutually exclusive with.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_fetch` tool that renders this provider's body.
- [Generated configuration catalog](../../../docs/config-catalog.md) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `statusCode`, target URL, Markdown body, and truncation flag or its exact `Jina fetch aborted`, `Jina fetch request failed: <error>`, `Jina Reader error (HTTP <status>)`, `Jina returned an unreadable response body: <error>`, invalid-URL, and credential-resolution failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **Pin `web.fetchProvider` when both fetch providers are mounted** — `http` and `jina` are both usable, so an unpinned `ctx.web.fetch()` is `WEB_PROVIDER_AMBIGUOUS`; the wizard's `applySetup` pins `fetchProvider: jina`, and a hand-written profile must do the same.
- **SSRF trust moves to Jina** — Jina fetches the target from its own infrastructure; the local gate checks only the scheme and length, so a destination reachable from Jina is reachable, and credentials embedded in the target URL are forwarded to Jina.
- **Truncation is only visible with `maxTokens` configured** — Jina exposes no explicit truncation flag; an at-or-above `x-usage-tokens` count marks `truncated`, a Jina-side cut without a configured cap is undetectable, and `truncated: false` therefore does not guarantee completeness.
- **Hash-fragment URLs lose the fragment** — the `GET` prefix form cannot transmit `#...`; Jina's `POST` body form would be needed for hash-routed single-page applications.
- **The keyless quota is 20 RPM per IP** — keyless requests share the launching host's address quota; a configured key raises the limit and moves accounting to the key.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: extraction controls and the POST form

Jina's selector, cookie, and content-format controls are deferred until a consumer needs them; the seam's fetch request deliberately carries only a URL. A future seam change could also carry the target as a POST body, which would preserve fragments and long URLs.

</details>
