---
description: "ctx.web 的 SearXNG 搜索提供方：部署方如何挂载无密钥的自托管元搜索实例，并将其 JSON 结果映射到 web seam。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-searxng`，harness 可以通过 SearXNG 实例搜索 web，获得该实例聚合的无密钥结果。当部署自托管或信任社区实例、且不希望使用厂商密钥时选择它。实例基址是必填项，认证与速率限制由实例负责。每项结果将 `content` 映射为 `snippet`；`publishedDate` 在能解析时规范化为 ISO-8601，否则丢弃。SearXNG 不返回生成答案，因此结果只产出可引用的来源。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `searxng` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: searxng` 固定。

### 何时选择

当部署自行运行或信任某个 SearXNG 实例，并希望在不使用厂商 API 密钥的情况下获得聚合结果时，选择此后端。只要配置的实例基址是可解析的 http(s) URL，提供方就可用；搜索随后在实例侧失败，而无法解析或非 http(s) 的基址会使提供方对选择不可用。

### 最小配置

加载 web 服务与本提供方。`baseURL` 是必填项，因为 SearXNG 没有公共默认实例；缺少该值会导致插件加载失败。实例自身的设置决定可用的引擎与输出格式。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: https://searx.example.org
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | （必填） | 实例基址；追加 `/search`。无法解析或非 http(s) 时提供方不可用 |
| `categories` | （未设置） | 逗号分隔的 SearXNG 类别，例如 `general,news` |
| `language` | （未设置） | 以 `language` 发送的语言代码；`auto` 交由实例决定 |
| `timeRange` | （未设置） | 以 `time_range` 发送的时间窗口：`day`、`week`、`month` 或 `year` |
| `engines` | `[]` | 将结果限制在这些引擎；以逗号连接。为空表示所选类别的全部引擎 |
| `safesearch` | （未设置） | 以 `safesearch` 发送的安全搜索级别：`0` 关闭、`1` 适中、`2` 严格 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 搜索返回什么

每项 SearXNG 结果映射为 `WebSearchSource`：`url`、`title`、作为 `snippet` 的 `content`，以及规范化为 ISO-8601 时刻后作为 `publishedAt` 的 `publishedDate`。没有可用 `content` 的结果会保留为仅含 URL 的来源，而不是被丢弃。SearXNG 不返回生成答案，因此结果不携带 `content`。请求的 `maxResults` 不会发送给实例；最终上限由 web 服务在返回路径上强制执行：截断并标记。

### 失败与恢复

提供方失败——HTTP 错误、网络失败、响应体无法解析或结构不符——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。HTTP 403 会指明常见陷阱：许多公共实例禁用了 JSON 输出格式，因此错误消息为 `SearXNG instance refused the request (HTTP 403); many public instances disable the JSON output format — enable "json" under the instance's search.formats setting or use another instance`。调用方根据错误码进行分流；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 SearXNG JSON API 之上的无密钥薄适配器，遵循两条刻意的规则：

- **只取可移植的 snippet。** 来源从 SearXNG 真实的 `content` 获得 `snippet`；缺少 `content` 时保留仅含 URL 的来源，而不是虚构文本。
- **不伪造时间戳。** `publishedDate` 只有在解析为 ISO-8601 时刻后才进入 `publishedAt`；无法解析的值会被丢弃，因为 seam 将 `publishedAt` 类型定义为 ISO-8601。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、必填端点、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `SearxngSearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | SearXNG 协议类型：`SearxngSearchResponse`、`SearxngResult`、`SearxngError` |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

### 请求与映射流程

每次操作都会快照当前配置段。`search()` 向 `{baseURL}/search` 发送无密钥 `GET`，携带 `q` 与 `format=json`，以及可选的 `categories`、`language`、`time_range`、`engines` 与 `safesearch` 参数，并使用 `redirect: 'error'`，因此重定向会在不接触目标的情况下使请求失败。解析后的 `results[]` 逐项映射，服务在返回路径上应用最终的 `maxResults` 上限。中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

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

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方经 `maxResults` 限制的 URL、标题、snippet 与规范化发布日期；如果发生失败，则会在消费方的错误包装层内保留原样错误消息 `SearXNG search aborted`、`SearXNG search request failed: <error>`、`SearXNG returned an unprocessable response body: <error>`、JSON 格式拒绝与 HTTP 错误。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **公共实例常常禁用 JSON**——除非实例在 `search.formats` 中启用 `json`，否则 `/search?format=json` 会返回 403；错误会指明该陷阱，但提供方无法让实例提供该格式。
- **`timeRange` 是部署级的**——seam 的请求不携带时间窗口字段，因此不修改 seam 就无法实现按查询的时间范围；一个已挂载的提供方只服务一个时间窗口。
- **`publishedDate` 取决于引擎**——只有贡献结果的引擎返回它时 SearXNG 才提供；相对或无法解析的文本会被丢弃，而不是转换为伪造的时间戳。
- **不支持实例认证**——提供方不发送任何凭据，因此位于 HTTP 认证之后的实例无法使用。
- **实例会忽略未知引擎名**——SearXNG 会静默丢弃它不认识的 `engines` 条目，因此拼写错误会在没有报错的情况下缩小结果范围。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：按查询的时间范围与实例认证

SearXNG 的时间窗口以厂商配置形式公开，因为 web 服务尚没有提供方无关的时间范围字段；未来的提供方无关请求词汇会把它移出各提供方的配置，并使其可按查询设置。实例凭据（HTTP 认证）将推迟到有部署需要时再做。

</details>
