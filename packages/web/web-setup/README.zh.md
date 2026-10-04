---
description: "欢迎向导网页步骤背后的宿主控制器：凭证库写入、通过配置编辑器对 provider/web/tool-web 资料行做行级修改，以及以 webSetup Remote 命名空间暴露的实时校验探针。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-setup

[English](README.md) | 中文

## 概要

有了 `dsh-web-setup`，配置界面可以在 harness 运行期间开启或关闭网页搜索与页面阅读。欢迎向导无法对该步骤使用 `settings.mutate`：`web.searchProvider`/`fetchProvider`、`tool-web.search`/`fetch` 以及 provider 行要么是非易变字段，要么是结构性的，因此宿主改为通过 `ctx.configEditor` 执行行级修改，并把候选密钥存入凭证库。该包拥有 `webSetup` Remote 命名空间（`status`、`validateProvider`、`applySetup`）以及 v1 provider 目录，后者为每个 provider 命名其 id、凭证引用、资料行与探针方式。

## 目录

- [使用此包](#use-this-package)
- [webSetup Remote 命名空间](#the-websetup-remote-namespace)
- [Provider 目录](#provider-catalog)
- [应用语义](#apply-semantics)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

在已经加载配置编辑器的 profile 中挂载该控制器。插件注入 `configEditor`，并惰性读取 `ctx.credentials`，因此没有凭证 provider 的部署仍可启动，只是会把各引用报告为未配置。

```yaml
- name: '@deepseek-ai/dsh-web-setup'
```

以资料补丁插入该行的写法：

```yaml
- insert:
    - id: web-setup
      name: '@deepseek-ai/dsh-web-setup'
```

### 配置

无。所有输入都通过 `webSetup` Remote 方法传递；目录以代码形式存在，因此向导侧与本控制器不会在 id 或引用上发生偏移。

### 宿主接缝

| 接缝 | 用途 |
|---|---|
| `ctx.configEditor` | 对 provider、`web` 与 `tool-web` 行执行 `entries`、`insert` 与 `edit` |
| `ctx.credentials` | 用 `describe`/`resolve` 支撑状态与探针，用 `set` 写入候选密钥 |
| `globalThis.fetch` | 实时探针（由 5 秒 `AbortController` 限时，每个携带凭证的请求都设置 `redirect: 'error'`） |

<a id="the-websetup-remote-namespace"></a>
## webSetup Remote 命名空间

Remote 注册采用 profile 插件模式：函数式插件（`name`/`inject`/`Config`/`apply`）构造一个服务键为 `webSetup` 的 `TypertRemoteService`；网关的 source-mode 反射无需生成元数据即可发现 `@Remote` 方法。

### `status()`

```ts
{ searchProvider: string | null, fetchProvider: string | null,
  mounted: Array<{ kind: 'search' | 'fetch', provider: string }>,
  credentials: Record<string, { configured: boolean, source?: string, writable: boolean }> }
```

provider 选择读取自运行中的 `web` 行（`configEditor.entries()`，即配置编辑器对活动 Loader 条目的投影——settings describe 看不到这些非易变字段），并带有与 `WebRuntime` 自身解析相同的 `DSH_WEB_SEARCH_PROVIDER`/`DSH_WEB_FETCH_PROVIDER` 回退。`mounted` 列出模块名行是活动且启用条目的目录 provider。`credentials` 为每个目录引用携带一项。

### `validateProvider(request, signal)`

```ts
request: { kind: 'search' | 'fetch', provider: string, apiKey?: string, baseURL?: string }
result:  { ok: boolean, status?: number, latencyMs?: number, error?: string, sourcesCount?: number }
```

候选密钥是一次性的；省略时从凭证库解析目录引用。`exa` 以 `Authorization: Bearer` POST `{query, numResults: 1}`；`brave` 以 `X-Subscription-Token` GET `/res/v1/web/search?q=test&count=1`；`tavily` POST `{query, max_results: 1}`，密钥同时放在请求体与 bearer 头中；`searxng` GET `{baseURL}/search?q=test&format=json`；`jina` GET `r.jina.ai/https://example.com`。`deepseek-official` 只报告凭证是否存在（其搜索是复用模型密钥的辅助模型请求），`http` 不发起外部调用直接报告成功。超时、取消、传输失败、非 2xx、非 JSON 都会解析为 `ok: false` 并附带消息；不会持久化任何内容。

### `applySetup(request)`

```ts
request: {
  search?: { provider: string | null, apiKey?: string, baseURL?: string },
  fetch?: { provider: string | null },
  toolToggles?: { search: boolean, fetch: boolean },
}
result:  { ok: boolean, applied: string[], pendingRestart?: { ns: string, message: string }, error?: string }
```

<a id="provider-catalog"></a>
## Provider 目录

| 类型 | id | 引用 | 行 |
|---|---|---|---|
| search | `exa` | `EXA_API_KEY` | `@deepseek-ai/dsh-web-search-exa` |
| search | `deepseek-official` | `DEEPSEEK_API_KEY` | `@deepseek-ai/dsh-web-search-deepseek` |
| search | `brave` | `BRAVE_API_KEY` | `@deepseek-ai/dsh-web-search-brave` |
| search | `tavily` | `TAVILY_API_KEY` | `@deepseek-ai/dsh-web-search-tavily` |
| search | `searxng` | （无） | `@deepseek-ai/dsh-web-search-searxng` |
| fetch | `http` | （无） | `@deepseek-ai/dsh-web-fetch-http` |
| fetch | `jina` | `JINA_API_KEY` | `@deepseek-ai/dsh-web-fetch-jina` |

`brave`、`tavily`、`searxng` 与 `jina` 的行会在对应适配器包发布后挂载；`WEB_SETUP_PROVIDERS` 是 id、引用与行模板的唯一来源。

<a id="apply-semantics"></a>
## 应用语义

操作按固定顺序执行，并在每步提交后报告：凭证库写入（`credentials:<REF>`）、provider 行确保（`row:<id>`）、`web` 行编辑（`web.searchProvider`/`web.fetchProvider`），最后是 `tool-web` 开关。无实际变化的编辑不会列出。

在可编辑的资料文档中被禁用的 provider 行会被移除，并以目录模板重新插入，因为配置编辑器只写 `config`，从不写条目的 `disabled` 标志；由随附层禁用的行无法这样重新启用，会返回 `pendingRestart`，其中命名该行以及需要改动的 `disabled: false` 字段。

`tool-web` 开关会编辑每个已启用的顶层 `tool-web` 行，以及每个 `config.plugins` 中携带 `tool-web` 条目的已启用 preset 组行——即 preset 注册表真正为每个 agent 挂载的行。携带 `disabled: true` 的嵌套条目会通过在组 config 中写入 `disabled: false` 被重新启用。当只有被禁用的顶层行存在、且没有 preset 携带这些工具时，`pendingRestart` 会命名该行，而不是假装仅靠重启就能启用它。

按工具门控规则，只有当有效 provider 存在、且其行已挂载或在同一次调用中被挂载时，`toolToggles.search`/`fetch` 才可为 `true`；否则请求会在触碰工具行之前被拒绝。无法热应用的配置编辑器写入会返回 `pendingRestart`，其中命名失败的行 id 并附上编辑器自身的消息；当协调失败时编辑器会回滚资料文档。

## 设计说明

**运行时不变式：** 不发布 companion。该控制器不声明任何可独立观测的运行时关系；配置编辑器自身的回滚与协调检查、状态投影以及探针结果值就是它的证据。

<a id="model-experience"></a>
## 模型体验

### 通过资料行改变网页工具目录

#### 模型看到什么

此包不写任何自己的提示文本。它间接改变模型可见的工具目录：`tool-web` 行的 `search`/`fetch` 开关与已挂载的 provider 行决定每个 agent 的 schema 中是否存在 `web_search` 与 `web_fetch`。

#### Token 影响

无直接 token。应用 `tool-web` 开关会从下一个请求中增加或移除 `web_search`/`web_fetch` 工具 schema 及其提示指引，因此影响就是工具目录自身的条件性开销。

#### KV Cache 影响

与请求前缀无关：行在轮次之间应用，切换后的工具集合会替换下一个请求的工具 schema 块，从而可能从该点起使前缀复用失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **已选 provider 行从不移除。** `provider: null` 只清除 `web` 指针；已挂载的行会留给后续切换使用。唯一的移除是应用语义中描述的禁用行替换。
- **工具开关改变的是 preset 定义，而不是运行中 agent 已挂载的修订。** preset 注册表负责决定运行中的 agent 何时采用重新注册的定义；本包只写定义这些定义的行。
- **冻结的 fetch 选择不携带 `apiKey`/`baseURL`。** Jina 的可选密钥与自定义 reader 端点可以在 provider 行自身的 config 中设置，但尚不能通过 `applySetup` 设置。
- **`deepseek-official` 的校验是凭证存在性检查**，不是实时搜索：真实探针会是一次完整的辅助模型请求，并消耗共享的模型密钥。
- **`brave`、`tavily`、`searxng` 与 `jina` 的行名是目录假设**，直到对应适配器包发布；目录中针对未发布行的测试是它们的兼容点。
- **`providers.md` §2.5 未说明 Tavily 的认证方式。** 探针同时发送文档所述的 bearer 头和旧的请求体密钥，以便两代实现都能应答；适配器应确认其中一种形式。
