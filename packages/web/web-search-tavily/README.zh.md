---
description: "ctx.web 的 Tavily 搜索提供方：部署方如何挂载面向 agent 调优的 web 搜索，获得可移植 snippet、规范化发布日期与可选的生成答案。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-tavily

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-tavily`，harness 可以通过 Tavily 搜索 web，获得面向 agent 调优的结果 snippet 与规范化发布日期。当部署希望使用 Tavily 的重排序高信噪比分块及其永久免费额度时选择它。请求的生成答案会映射为 `content`；没有答案时，结果只携带可引用的来源。`published_date` 在能解析时规范化为 ISO-8601，否则省略。API 密钥在每次搜索时通过 `ctx.credentials` 解析，因此存入保险库的密钥无需重启即可生效。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `tavily` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: tavily` 固定。

### 何时选择

当部署持有 Tavily API 密钥，并希望使用面向 agent 调优的 snippet 与可选的生成答案时，选择此后端。只要能够解析到凭据，提供方就保持可被选中；没有密钥的搜索会在调用时以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败，并指明凭据引用。非易失性的配置错误（端点基址无法解析、结果上限不是正数）会使提供方对选择不可用。

### 最小配置

加载 web 服务与本提供方。密钥按以下顺序解析：字面量 `apiKey`，然后是通过 `ctx.credentials` 解析的凭据引用 `apiKeyEnv`（向导与设置写入此处），最后是 `apiKeyEnv` 命名的启动环境变量。请把密钥存入凭据保险库而不是 YAML；该行可在设置的 `web-search-tavily` 命名空间下编辑，且所有被描述的值中密钥都会被隐去。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-tavily'
  config:
    apiKeyEnv: TAVILY_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面量 Tavily API 密钥；优先使用 `apiKeyEnv`，避免密钥进入配置文件 |
| `apiKeyEnv` | `TAVILY_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用，启动环境作为回退平面 |
| `baseURL` | `https://api.tavily.com` | 端点基址；追加 `/search`。无法解析时提供方不可用 |
| `searchDepth` | `basic` | 以 Tavily `search_depth` 发送的检索深度：`basic`（1 信用点）或 `advanced`（2 信用点，重排序分块） |
| `maxResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数；Tavily 将单次请求上限设为 20 |
| `includeAnswer` | （未设置） | 请求生成答案：`true`／`basic` 为快速答案，`advanced` 为更详细的答案 |
| `timeRange` | （未设置） | 以 Tavily `time_range` 发送的时间窗口：`day`、`week`、`month` 或 `year` |
| `topic` | （未设置） | 以 Tavily `topic` 发送的搜索类别：`general`、`news` 或 `finance` |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每项 Tavily 结果映射为 `WebSearchSource`：`url`、`title`、作为 `snippet` 的 `content`，以及规范化为 ISO-8601 时刻后作为 `publishedAt` 的 `published_date`。没有可用 `content` 的结果会保留为仅含 URL 的来源，而不是被丢弃。非空的生成 `answer` 会成为结果的 `content`。请求的 `maxResults` 优先于已配置的默认值，并作为成本与延迟优化发送给 Tavily，且被钳制到 Tavily 的上限 20——最终上限由服务强制执行：截断并标记。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析或结构不符，以及凭据解析失败——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。没有可解析密钥的搜索以 `WEB_PROVIDER_CREDENTIAL_MISSING` 呈现，并指明 `apiKeyEnv`。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Tavily API 之上的薄适配器，遵循两条刻意的规则：

- **只取可移植的 snippet。** 来源从 Tavily 真实的 `content` 获得 `snippet`；缺少 `content` 时保留仅含 URL 的来源，而不是虚构文本。
- **不伪造时间戳。** `published_date` 只有在解析为 ISO-8601 时刻后才进入 `publishedAt`；无法解析的值会被丢弃，因为 seam 将 `publishedAt` 类型定义为 ISO-8601。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `TavilySearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | Tavily 协议类型：`TavilySearchResponse`、`TavilyResult`、`TavilyError` |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

### 请求与映射流程

每次操作都会快照当前配置段，并且只针对该请求解析凭据。`search()` 以 `Authorization: Bearer` 认证和 `redirect: 'error'` 把查询、深度、可选结果数（钳制到 20）、答案请求、时间窗口与类别 POST 到 `{baseURL}/search`，因此重定向会在不接触目标的情况下使请求失败。解析后的 `results[]` 逐项映射，非空的 `answer` 成为 `content`，服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——web 包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方经 `maxResults` 限制的 URL、标题、snippet、规范化发布日期，以及请求过的生成答案；如果发生失败，则会在消费方的错误包装层内保留原样错误消息 `Tavily search aborted`、`Tavily search request failed: <error>`、`Tavily returned an unprocessable response body: <error>`、凭据缺失与 HTTP 错误。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **`searchDepth` 只公开 `basic` 与 `advanced`**——Tavily 还提供 `fast` 与 `ultra-fast`；在消费方需要其延迟特性之前暂缓。
- **`published_date` 由提供方决定且处于 beta**——Tavily 只在检测到日期时返回它（`topic: news` 时自动启用），因此没有日期的来源不携带 `publishedAt`；提供方绝不虚构日期。
- **生成答案是未经核验的提供方文本**——`includeAnswer` 会把 Tavily 的 `answer` 映射为 `content`，模型可能信任它；只需要可引用来源时请勿设置。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：更宽的 Tavily 控制面

Tavily 的深度、时间窗口、类别与答案控制项以厂商配置形式公开，因为 web 服务尚没有对应的提供方无关字段；未来的提供方无关请求词汇会把这些控制项移出各提供方的配置。

</details>
