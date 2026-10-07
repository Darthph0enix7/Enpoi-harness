# Web 设置

[English](web-setup.md) | 中文

[dsh-web-setup](../../packages/web/web-setup) 是欢迎向导网页步骤背后的宿主控制器。它拥有 `ctx.webSetup` Remote 命名空间：`status` 报告生效的搜索与抓取选择，`validateProvider` 探测一个候选提供方，`applySetup` 通过 `ctx.credentials` 存入候选密钥，并通过 `ctx.configEditor` 编辑提供方、`web` 与 `tool-web` 行。它写入的行决定 [dsh-web](../../packages/web/web) 挂载什么，以及 [dsh-tool-web](../../packages/web/tool-web) 是否注册 `web_search` 与 `web_fetch`。

源码：[`packages/web/web-setup/src/remote.ts`](../../packages/web/web-setup/src/remote.ts)

## 设置流程

向导的网页步骤无法使用 `settings.mutate`：`web.searchProvider`、`web.fetchProvider`、`tool-web.search`、`tool-web.fetch` 以及提供方行都是非易变字段或结构性字段，因此该步骤改由本服务执行行级修改。该步骤加载 `status()` 取得初始选择，在提供应用前用候选密钥运行 `validateProvider()`，然后发送一次携带它已决定的每个分组的 `applySetup()`；步骤的纯事实与视图位于 [ui-settings-models](../../packages/client/ui-settings-models)。一次应用返回的 `pendingRestart` 诊断会随向导保留，直到向导关闭或重新打开。

## 状态

`status()` 先读取实时 `web` 行自身配置中的生效提供方选择，再读取 `WebRuntime` 所解析的 `DSH_WEB_SEARCH_PROVIDER`/`DSH_WEB_FETCH_PROVIDER` 环境回退。该读取使用 `configEditor.entries()`，即活动 Loader 条目的投影，因为 settings describe 看不到这些非易变字段。`mounted` 列出行为实时且已启用条目的目录提供方。`credentials` 为每个目录引用携带一个 `WebSetupCredentialState`——`configured`、可选的 `source` 与 `writable`，绝不包含值。抛出异常的 config-editor 读取降级为空行状态；凭据提供方缺席时，每个引用都报告为未配置且不可写。

## 提供方校验

`validateProvider(request, signal)` 为请求的种类与提供方运行一次 canary。候选 `apiKey` 是一次性的，绝不持久化；请求省略它时，从凭据提供方解析目录引用。`deepseek-official` 只检查凭据是否存在，因为它的搜索是复用共享模型密钥的完整辅助模型请求；`http` 不发起外部调用即报告成功。每种失败——未知或种类错误的提供方、超时、取消、传输错误、非 2xx 响应或非 JSON 响应体——都解析为带消息的 `ok: false`；Remote 边界不抛出任何异常。v1 目录 `WEB_SETUP_PROVIDERS` 以代码形式存在：每个提供方一个 `WebSetupProviderSpec`，携带其注册 id、凭据引用、资料行模板与 canary 种类。

## 应用语义

`applySetup(request)` 按固定顺序执行写入，并在 `applied` 中报告每个已提交操作：凭据写入（`credentials:<REF>`）、提供方行确保（`row:<id>`）、`web` 行编辑（`web.searchProvider`/`web.fetchProvider`），最后是 `tool-web` 开关。该调用按设计是顺序且非原子的；失败时返回 `ok: false` 及已应用的操作。`toolToggles` 字段只有在生效提供方存在、且其行已挂载或由同一次调用挂载时才能为 true；否则请求在任何工具行被触及前即被拒绝。

`ensureProviderRow` 把已启用的已挂载行编辑为目录模板，替换可编辑资料文档中声明的已禁用行（配置编辑器只写 `config`，因此禁用声明被移除并插入一条已启用行），或插入一条新行。由可编辑文档不拥有的层禁用的行无法这样重新启用；该情况返回 `pendingRestart`，指明该行与要改的 `disabled: false` 字段。`tool-web` 开关编辑每条已启用的顶层 `tool-web` 行，以及每条 `config.plugins` 携带 `tool-web` 条目的已启用 preset 分组行，并在开关打开时清除嵌套的 `disabled: true`。无法热应用的 config-editor 写入返回 `pendingRestart`，指明行 id 与编辑器自身的消息。

## 边界

本服务不拥有凭据存储：`ctx.credentials`（[dsh-credentials](../../packages/credentials/credentials)）存储值并报告其来源层，插件惰性读取它，因此没有凭据提供方的部署仍能启动并把引用报告为未配置。它不拥有行的持久化与协调：`ctx.configEditor`（[boot.md](boot.zh.md)）通过 Loader 的热重挂载路径持久化并应用每次编辑。它不拥有提供方行为或模型可见的工具 schema：这些归提供方包与 [dsh-tool-web](../../packages/web/tool-web) 所有，共享的搜索/抓取约定由 [web.md](web.zh.md) 记录。它不拥有向导：步骤顺序、文案与呈现归 [ui-settings-models](../../packages/client/ui-settings-models) 所有。该包不发布运行时不变式伴随文件，因为它不主张任何可独立观察的关系。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
