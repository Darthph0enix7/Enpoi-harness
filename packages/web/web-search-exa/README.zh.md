---
description: "ctx.web 的 Exa 搜索提供方：部署方如何挂载厂商原生 web 搜索，获得可移植 snippet 与发布日期。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-exa

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-exa`，harness 可以通过 Exa 搜索 web，获得带可移植 snippet 与发布日期的厂商原生结果。当部署希望使用 Exa 的语义搜索以及日期、类别与域名过滤时选择它。Exa 不返回生成答案，因此结果不携带 `content`——只产出可引用的来源。没有非空白高亮的来源会被丢弃，除非请求要求页面文本，此时由开头的文本摘录顶替。API 密钥在每次搜索时通过 `ctx.credentials` 解析，因此存入保险库的密钥无需重启即可生效。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `exa` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: exa` 固定。

### 何时选择

当部署持有 Exa API 密钥，并希望使用 Exa 的语义搜索、获得每项结果的高亮 snippet 与发布日期，以及 Exa 的日期／类别／域名过滤时，选择此后端。只要能够解析到凭据，提供方就保持可被选中；没有密钥的搜索会在调用时以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败，并指明凭据引用。非易失性的配置错误（端点基址无法解析、结果上限不是正整数）会使提供方对选择不可用。

### 最小配置

加载 web 服务与本提供方。密钥按以下顺序解析：字面量 `apiKey`，然后是通过 `ctx.credentials` 解析的凭据引用 `apiKeyEnv`（向导与设置写入此处），最后是 `apiKeyEnv` 命名的启动环境变量。请把密钥存入凭据保险库而不是 YAML；该行可在设置的 `web-search-exa` 命名空间下编辑，且所有被描述的值中密钥都会被隐去。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKeyEnv: EXA_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面量 Exa API 密钥；优先使用 `apiKeyEnv`，避免密钥进入配置文件 |
| `apiKeyEnv` | `EXA_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用，启动环境作为回退平面 |
| `baseURL` | `https://api.exa.ai` | 端点基址；追加 `/search`。无法解析时提供方不可用 |
| `searchType` | `auto` | 以 Exa `type` 发送的检索模式：`instant`、`fast`、`auto`、`deep-lite`、`deep` 或 `deep-reasoning` |
| `numResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数；必须是正整数 |
| `highlightsPerResult` | `1` | 每个结果请求的高亮摘录数；`1` 发送 Exa 的布尔形式 `highlights: true`，更大的数量发送仍被接受但已弃用的 `highlightsPerUrl` |
| `startPublishedDate` / `endPublishedDate` | （未设置） | 发布日期的 ISO-8601 边界 |
| `category` | （未设置） | Exa 数据类别：`company`、`people`、`publication`、`news`、`personal site` 或 `financial report` |
| `includeDomains` / `excludeDomains` | （未设置） | 域名或域名路径过滤（支持通配符子域），各最多 1,200 项 |
| `livecrawl` | （未设置） | `true` 通过发送 `contents.maxAgeHours: 0` 强制实时抓取 |
| `text.maxCharacters` | （未设置） | 请求按此字符数截断的整页文本；必须给出上限，因为未设置的空对象与空对象无法区分 |
| `summary` | （未设置） | `true` 请求生成的逐页摘要 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-exa)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每项 Exa 结果映射为 `WebSearchSource`：`url`、`title`、以首个非空白高亮作为 `snippet`、`publishedDate` 作为 `publishedAt`；当请求了 `text` 时，没有高亮的结果改以开头的文本摘录（上限 500 字符）作为 `snippet`，只有真正空的结果才会被丢弃。请求的 `maxResults` 优先于已配置的默认 `numResults`，并作为成本与延迟优化发送给 Exa——最终上限由服务强制执行：截断并标记。Exa 不返回生成答案，因此结果不携带 `content`。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析或结构不符，以及凭据解析失败——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。没有可解析密钥的搜索以 `WEB_PROVIDER_CREDENTIAL_MISSING` 呈现，并指明 `apiKeyEnv`。`company` 或 `people` 类别与 `startPublishedDate`、`endPublishedDate` 或 `excludeDomains` 组合时，会在分发前被本地以 `WEB_PROVIDER_ERROR` 拒绝，因为 Exa 对该组合返回 HTTP 400。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Exa API 之上的薄适配器，遵循两条刻意的规则：

- **只取可移植的 snippet。** 来源从真实高亮获得 `snippet`；只有当请求要求页面文本时，才由该文本的开头摘录顶替，因此 seam 绝不会虚构提供方未返回的内容。
- **不虚构答案。** Exa 不返回生成答案，因此省略 `content`，而不是编造模型可能信任的提供方文本。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `ExaSearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Exa 协议类型：`ExaSearchResponse`、`ExaResult`、`ExaError` |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

### 请求与映射流程

每次操作都会快照当前配置段、拒绝不受支持的类别／过滤组合，并且只针对该请求解析凭据。`search()` 以 `redirect: 'error'` 把查询、检索模式、`contents`（现代布尔形式的高亮，外加可选的 text、summary 与 `maxAgeHours: 0`）、过滤条件与可选结果数 POST 到 `{baseURL}/search`，因此重定向会在不接触目标的情况下使请求失败。解析后的 `results[]` 在请求了文本时带文本回退逐项映射，服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——六包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-exa)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方经 `maxResults` 限制的 URL、标题、snippet（高亮或文本摘录）与发布日期；如果发生失败，则会在消费方的错误包装层内保留原样错误消息 `Exa search aborted`、`Exa search request failed: <error>`、`Exa returned an unprocessable response body: <error>`、凭据缺失与不支持的类别错误。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **没有非空白高亮的来源会被整个丢弃，除非请求了 text**——没有 `text` 时没有可映射的可移植 snippet，因此返回来源可能少于请求数量；有 `text` 时，回退摘录上限为 500 字符。
- **`text` 必须给出 `maxCharacters`**——schemastery 的对象节点在未设置时解析为 `{}`，因此无法把缺失的上限与未设置的字段区分开；通过设置上限来启用 text。
- **`company`／`people` 拒绝日期与排除过滤**——Exa 对这些组合返回 HTTP 400，因此提供方在分发前以 `WEB_PROVIDER_ERROR` 本地拒绝。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：更宽的 Exa 控制面

Exa 的过滤条件与内容控制项现在以厂商配置形式公开，因为 web 服务尚没有对应的提供方无关字段；未来的提供方无关请求词汇会把这些控制项移出各提供方的配置。

</details>
