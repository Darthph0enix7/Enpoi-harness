---
description: "Package map for the web access capability family: the search/fetch service, its provider backends, and the model-facing tools that consume them."
kind: "package-group"
---

# web/ — web access capability family

English | [中文](README.zh.md)

## Summary

The `web/` packages let models search the public web and fetch HTTP(S) pages through the `web_search` and `web_fetch` tools. Deployments can choose Exa, Brave, Tavily, SearXNG, Perplexity, or DeepSeek for search and anonymous HTTP(S) or Jina Reader for fetch; availability and resource limits depend on the configured provider. Use this family for search and page retrieval, not interactive browsing, content extraction, or per-URL policy enforcement. Models receive consistent tool behavior, cancellation, and error reporting when providers change.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Eleven packages play the web roles; the subsystem reference owns the exhaustive vocabulary and contracts.

| Package | Role | ctx key |
|---|---|---|
| [`web/`](web/README.md) | Search/fetch service: search and fetch URLs through interchangeable backends, one selection and error policy | `ctx.web` |
| [`web-search-exa/`](web-search-exa/README.md) | Searches the web through Exa | registers on `ctx.web` |
| [`web-search-brave/`](web-search-brave/README.md) | Searches the web through Brave | registers on `ctx.web` |
| [`web-search-tavily/`](web-search-tavily/README.md) | Searches the web through Tavily | registers on `ctx.web` |
| [`web-search-searxng/`](web-search-searxng/README.md) | Searches the web through a self-hosted SearXNG instance | registers on `ctx.web` |
| [`web-search-perplexity/`](web-search-perplexity/README.md) | Searches the web through Perplexity | registers on `ctx.web` |
| [`web-search-deepseek/`](web-search-deepseek/README.md) | Searches the web through DeepSeek native search | registers on `ctx.web` |
| [`web-fetch-http/`](web-fetch-http/README.md) | Fetches public HTTP(S) pages anonymously | registers on `ctx.web` |
| [`web-fetch-jina/`](web-fetch-jina/README.md) | Fetches pages through Jina Reader (JavaScript rendering and PDFs) | registers on `ctx.web` |
| [`tool-web/`](tool-web/README.md) | Exposes `web_search` and `web_fetch` to the model | registers on `ctx.tools` |
| [`web-setup/`](web-setup/README.md) | Host controller for wizard-driven web setup: vault writes, provider row surgery, live canaries | owns the `webSetup` Remote namespace |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary, then the design decision behind the single provider-selection service.

- [Web subsystem](../../docs/subsystems/web.md) — the search/fetch requests and results, provider availability, `WebError`, and public-address enforcement.
- [Web capability seam decision](../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
