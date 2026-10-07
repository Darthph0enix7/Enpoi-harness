# Web setup

English | [中文](web-setup.zh.md)

[dsh-web-setup](../../packages/web/web-setup) is the host controller behind the welcome wizard's web step. It owns the `ctx.webSetup` Remote namespace: `status` reports the effective search and fetch selection, `validateProvider` probes one provider candidate, and `applySetup` stores a candidate key through `ctx.credentials` and edits provider, `web`, and `tool-web` rows through `ctx.configEditor`. The rows it writes decide what [dsh-web](../../packages/web/web) mounts and whether [dsh-tool-web](../../packages/web/tool-web) registers `web_search` and `web_fetch`.

Source: [`packages/web/web-setup/src/remote.ts`](../../packages/web/web-setup/src/remote.ts)

## Setup flow

The wizard's web step cannot use `settings.mutate`: `web.searchProvider`, `web.fetchProvider`, `tool-web.search`, `tool-web.fetch`, and provider rows are non-volatile or structural fields, so the step performs row surgery through this service instead. The step loads `status()` for its initial selection, runs `validateProvider()` with the candidate key before offering to apply, then sends one `applySetup()` carrying every group it decided; the step's pure facts and its view live in [ui-settings-models](../../packages/client/ui-settings-models). A `pendingRestart` diagnostic from one apply travels with the wizard until it closes or reopens.

## Status

`status()` reads the effective provider selection from the live `web` row's own config, then the `DSH_WEB_SEARCH_PROVIDER`/`DSH_WEB_FETCH_PROVIDER` environment fallback that `WebRuntime` resolves. The read uses `configEditor.entries()`, the projection of active Loader entries, because settings describe cannot see these non-volatile fields. `mounted` lists catalog providers whose row is a live, enabled entry. `credentials` carries one `WebSetupCredentialState` per catalog reference — `configured`, optional `source`, and `writable`, never the value. A config-editor read that throws degrades to empty row state; an absent credential provider reports every reference unconfigured and not writable.

## Provider validation

`validateProvider(request, signal)` runs one canary for the requested kind and provider. The candidate `apiKey` is one-shot and is never persisted; when the request omits it, the catalog reference is resolved from the credential provider. `deepseek-official` checks credential presence only because its search is a full auxiliary model request on the shared model key, and `http` reports success without an external call. Every failure — an unknown or wrong-kind provider, a timeout, cancellation, a transport error, a non-2xx response, or a non-JSON body — resolves to `ok: false` with a message; nothing is thrown at the Remote boundary. The v1 catalog `WEB_SETUP_PROVIDERS` is code: one `WebSetupProviderSpec` per provider carries its registration id, credential reference, profile row template, and canary kind.

## Apply semantics

`applySetup(request)` runs its writes in one fixed order and reports each committed operation in `applied`: credential write (`credentials:<REF>`), provider row ensure (`row:<id>`), `web` row edit (`web.searchProvider`/`web.fetchProvider`), then `tool-web` toggles. The call is sequential and non-atomic by design; a failure returns `ok: false` with the operations already applied. A `toolToggles` field may be true only when the effective provider exists and its row is already mounted or is mounted by this same call; otherwise the request is refused before any tool row is touched.

`ensureProviderRow` edits an enabled mounted row to the catalog template, replaces a disabled row declared in the editable profile document (the config editor writes only `config`, so the disabled declaration is removed and an enabled row is inserted), or inserts a new row. A row disabled by a layer the editable document does not own cannot be re-enabled; that case returns `pendingRestart` naming the row and the `disabled: false` field to change. The `tool-web` toggles edit every enabled top-level `tool-web` row and every enabled preset group row whose `config.plugins` carries a `tool-web` entry, clearing a nested `disabled: true` when a toggle turns on. A config-editor write that cannot hot-apply returns `pendingRestart` naming the row id and the editor's own message.

## Boundaries

This service does not own credential storage: `ctx.credentials` ([dsh-credentials](../../packages/credentials/credentials)) stores values and reports their source layers, and the plugin reads it lazily, so a deployment without a credential provider still boots and reports unconfigured references. It does not own row persistence or reconciliation: `ctx.configEditor` ([boot.md](boot.md)) persists and applies each edit through the Loader's hot-remount path. It does not own provider behavior or the model-visible tool schemas: the provider packages and [dsh-tool-web](../../packages/web/tool-web) own those, and [web.md](web.md) documents the shared search/fetch contracts. It does not own the wizard: step order, copy, and presentation belong to [ui-settings-models](../../packages/client/ui-settings-models). The package publishes no runtime invariant companion because it asserts no independently observable relationship.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwebsetup--websetupservice"></a>

### `ctx.webSetup` — `WebSetupService`

The service behind the generated `webSetup` Remote namespace.

```ts cordis-catalog
/**
 * The effective provider selection, the mounted catalog providers, and the
 * vault state of every catalog reference.
 * @returns the status projection; row reads that fail degrade to empty state.
 */
@Remote async status(): Promise<WebSetupStatus>

/**
 * Run one live provider canary. The candidate key is one-shot; when the
 * request carries none, the catalog reference is resolved from the vault.
 * `deepseek-official` reports credential presence only (it reuses the model
 * key and its search is a full auxiliary model request), and `http` reports
 * success without an external call.
 * @param request - kind, provider id, and optional one-shot key/baseURL.
 * @param signal - caller cancellation supplied by the Remote carrier.
 * @returns the probe outcome; every failure is a value, never a throw.
 */
@Remote async validateProvider(request: WebSetupValidateRequest, signal: AbortSignal): Promise<WebSetupValidation>

/**
 * Apply one setup selection: store a given key, ensure the provider rows,
 * set `web.searchProvider`/`fetchProvider` (`null` unsets), and write the
 * `tool-web` toggles. `toolToggles.search`/`fetch` may only be `true` when
 * the effective provider exists and its row is mounted or mounted by this
 * call; a refusal stops before the tool row is touched.
 * @param request - selections and toggles; absent groups leave rows untouched.
 * @returns the committed operations, or the first failure with them.
 */
@Remote async applySetup(request: WebSetupApplyRequest): Promise<WebSetupApplyResult>
```

Source: [`packages/web/web-setup/src/remote.ts`](../../packages/web/web-setup/src/remote.ts)
<!-- END GENERATED cordis-surface -->
