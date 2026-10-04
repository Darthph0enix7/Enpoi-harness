---
description: "The host controller behind the welcome wizard's web step: credential-vault writes, provider/web/tool-web profile row surgery through the config editor, and live validation canaries exposed as the webSetup Remote namespace."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-setup

English | [中文](README.zh.md)

## Summary

With `dsh-web-setup`, a configuration surface can turn web search and page reading on or off while the harness is running. The welcome wizard cannot use `settings.mutate` for this step: `web.searchProvider`/`fetchProvider`, `tool-web.search`/`fetch`, and provider rows are non-volatile or structural, so the host instead performs row surgery through `ctx.configEditor` and stores candidate keys in the credential vault. The package owns the `webSetup` Remote namespace (`status`, `validateProvider`, `applySetup`) and the v1 provider catalog that names each provider id, credential reference, profile row, and canary.

## Table of Contents

- [Use this package](#use-this-package)
- [The webSetup Remote namespace](#the-websetup-remote-namespace)
- [Provider catalog](#provider-catalog)
- [Apply semantics](#apply-semantics)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the controller in a profile that already loads the config editor. The plugin injects `configEditor` and reads `ctx.credentials` lazily, so a deployment without a credential provider still boots and reports unconfigured references.

```yaml
- name: '@deepseek-ai/dsh-web-setup'
```

A profile patch that inserts the row:

```yaml
- insert:
    - id: web-setup
      name: '@deepseek-ai/dsh-web-setup'
```

### Config

None. Every input crosses the `webSetup` Remote methods; the catalog is code so the wizard lane and this controller cannot drift on ids or references.

### Host seams

| Seam | Use |
|---|---|
| `ctx.configEditor` | `entries`, `insert`, and `edit` for provider, `web`, and `tool-web` rows |
| `ctx.credentials` | `describe`/`resolve` for status and canaries, `set` for candidate keys |
| `globalThis.fetch` | Live canaries (bounded by a 5 s `AbortController`, `redirect: 'error'` on every credentialed request) |

## The webSetup Remote namespace

The Remote registration is the profile-plugin pattern: a function plugin (`name`/`inject`/`Config`/`apply`) constructs a `TypertRemoteService` whose service key is `webSetup`; `@Remote` methods are discovered by the gateway's source-mode reflection without generated metadata.

### `status()`

```ts
{ searchProvider: string | null, fetchProvider: string | null,
  mounted: Array<{ kind: 'search' | 'fetch', provider: string }>,
  credentials: Record<string, { configured: boolean, source?: string, writable: boolean }> }
```

The provider selection is read from the live `web` row (`configEditor.entries()`, the config-editor projection of active Loader entries — settings describe cannot see these non-volatile fields), with the same `DSH_WEB_SEARCH_PROVIDER`/`DSH_WEB_FETCH_PROVIDER` fallback `WebRuntime` resolves. `mounted` lists catalog providers whose module-name row is a live, enabled entry. `credentials` carries one entry per catalog reference.

### `validateProvider(request, signal)`

```ts
request: { kind: 'search' | 'fetch', provider: string, apiKey?: string, baseURL?: string }
result:  { ok: boolean, status?: number, latencyMs?: number, error?: string, sourcesCount?: number }
```

The candidate key is one-shot; when omitted, the catalog reference is resolved from the vault. `exa` posts `{query, numResults: 1}` with `Authorization: Bearer`; `brave` GETs `/res/v1/web/search?q=test&count=1` with `X-Subscription-Token`; `tavily` posts `{query, max_results: 1}` with the key in the body and the bearer header; `searxng` GETs `{baseURL}/search?q=test&format=json`; `jina` GETs `r.jina.ai/https://example.com`. `deepseek-official` reports credential presence only (its search is an auxiliary model request reusing the model key), and `http` reports success without an external call. Failures — timeout, cancellation, transport, non-2xx, non-JSON — resolve to `ok: false` with a message; nothing is persisted.

### `applySetup(request)`

```ts
request: {
  search?: { provider: string | null, apiKey?: string, baseURL?: string },
  fetch?: { provider: string | null },
  toolToggles?: { search: boolean, fetch: boolean },
}
result:  { ok: boolean, applied: string[], pendingRestart?: { ns: string, message: string }, error?: string }
```

## Provider catalog

| Kind | id | Reference | Row |
|---|---|---|---|
| search | `exa` | `EXA_API_KEY` | `@deepseek-ai/dsh-web-search-exa` |
| search | `deepseek-official` | `DEEPSEEK_API_KEY` | `@deepseek-ai/dsh-web-search-deepseek` |
| search | `brave` | `BRAVE_API_KEY` | `@deepseek-ai/dsh-web-search-brave` |
| search | `tavily` | `TAVILY_API_KEY` | `@deepseek-ai/dsh-web-search-tavily` |
| search | `searxng` | (none) | `@deepseek-ai/dsh-web-search-searxng` |
| fetch | `http` | (none) | `@deepseek-ai/dsh-web-fetch-http` |
| fetch | `jina` | `JINA_API_KEY` | `@deepseek-ai/dsh-web-fetch-jina` |

Rows for `brave`, `tavily`, `searxng`, and `jina` mount once their adapter packages ship; `WEB_SETUP_PROVIDERS` is the single source of ids, references, and row templates.

## Apply semantics

Operations run in one order and report after each commits: vault write (`credentials:<REF>`), provider row ensure (`row:<id>`), `web` row edit (`web.searchProvider`/`web.fetchProvider`), then `tool-web` toggles. A no-op edit is not listed.

A provider row that is disabled in the editable profile document is removed and re-inserted with the catalog template, because the config editor writes only `config` and never an entry's `disabled` flag; a row disabled by a shipped layer cannot be re-enabled this way and returns `pendingRestart` naming the row and the `disabled: false` field to change.

The `tool-web` toggles edit every enabled top-level `tool-web` row and every enabled preset group row whose `config.plugins` carries a `tool-web` entry — the rows the preset registry actually mounts for each agent. A nested entry carrying `disabled: true` is re-enabled by writing `disabled: false` into the group config. When only a disabled top-level row exists and no preset carries the tools, `pendingRestart` names that row instead of pretending a restart alone would enable it.

Per the tool-gating rule, `toolToggles.search`/`fetch` may only be `true` when the effective provider exists and its row is mounted or mounted by the same call; otherwise the request is refused before the tool rows are touched. A config-editor write that cannot be hot-applied returns `pendingRestart` naming the failed row id, with the editor's own message; the profile document is rolled back by the editor when reconciliation fails.

## Design notes

**Runtime invariant:** No companion is published. This controller asserts no independently observable runtime relationship; the config-editor's own rollback and reconcile checks, the status projection, and the canary result values are its evidence.

## Model Experience

### Web tool catalog through profile rows

#### What the model sees

This package writes no prompt text of its own. It changes the model-visible tool catalog indirectly: the `tool-web` row's `search`/`fetch` toggles and the mounted provider rows decide whether `web_search` and `web_fetch` exist in every agent's schema.

#### Token effect

Zero direct tokens. Applying a `tool-web` toggle adds or removes the `web_search`/`web_fetch` tool schemas and their prompt guidance from the next request, so the effect is the tool catalog's own conditional cost.

#### KV Cache effect

Independent of the request prefix: rows are applied between turns, and a toggled tool set replaces the tool-schema block on the next request, which can invalidate prefix reuse from that point.

## Known Limitations and Deferred Work

- **Selected provider rows are never removed.** `provider: null` clears only the `web` pointer; the mounted row stays for a later switch. The only removal is the disabled-row replacement described under apply semantics.
- **Tool toggles change preset definitions, not a running agent's mounted revision.** The preset registry owns when a live agent picks up the re-registered definition; this package only writes the rows that define it.
- **The frozen fetch selection carries no `apiKey`/`baseURL`.** Jina's optional key and a custom reader endpoint can be configured in the provider row's own config, but not through `applySetup` yet.
- **`deepseek-official` validation is a credential-presence check**, not a live search: a real probe would be a full auxiliary model request and would spend the shared model key.
- **Row names for `brave`, `tavily`, `searxng`, and `jina` are catalog assumptions** until those adapter packages ship; the catalog's unshipped-row test is their compatibility point.
- **Tavily's auth mechanism is not stated in `providers.md` §2.5.** The canary sends the documented bearer header and the legacy body key so either generation answers; the adapter should confirm one form.
