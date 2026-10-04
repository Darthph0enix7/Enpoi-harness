---
description: "ctx.web 的 Jina Reader 抓取提供方：部署方如何通过 r.jina.ai 获取适合 LLM 的 Markdown——可选密钥，并诚实报告截断。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-fetch-jina

[English](README.md) | 中文

## 概述

有了 `dsh-web-fetch-jina`，harness 可以通过 Jina Reader 抓取 URL，获得适合 LLM 的 Markdown，而不是原始 HTML。当需要 JavaScript 渲染页面、PDF，或匿名 HTTP 抓取器读不了的站点时选择它。它可无密钥运行，受 Jina 匿名速率限制；配置密钥可提高配额。目标抓取由 Jina 执行，因此 SSRF 信任转移到 Jina。配置 `maxTokens` 上限后，当响应达到上限时结果会被标记为已截断。同时挂载 `http` 与 `jina` 时，必须固定 `web.fetchProvider`，否则调用有歧义。面向模型的 `web_fetch` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `jina` 抓取提供方身份注册。`http` 抓取提供方同样可用，因此两者同时挂载时 `ctx.web.fetch()` 无法自动选择：请固定 `fetchProvider: jina`。web-setup 向导的 `applySetup` 会把该固定项写入 profile；手写 profile 也必须这样做。

### 何时选择

当部署希望获得 Markdown 提取、JavaScript 渲染或 PDF 转换而不是原始页面，并接受由 Jina 从其自有基础设施抓取目标时，选择此后端。只要配置的端点基址是可解析的 http(s) URL，提供方就可用；密钥是可选的，当没有凭据可解析时，无密钥请求路径仍然可用。

### 最小配置

加载 web 服务与本提供方，并固定抓取提供方。密钥按以下顺序解析：字面量 `apiKey`，然后是通过 `ctx.credentials` 解析的凭据引用 `apiKeyEnv`（向导与设置写入此处），最后是 `apiKeyEnv` 命名的启动环境变量。请把密钥存入凭据保险库而不是 YAML；该行可在设置的 `web-fetch-jina` 命名空间下编辑，且所有被描述的值中密钥都会被隐去。完全没有密钥时，请求保持无密钥，受 Jina 匿名速率限制。

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    fetchProvider: jina
- name: '@deepseek-ai/dsh-web-fetch-jina'
  config:
    apiKeyEnv: JINA_API_KEY
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面量 Jina API 密钥；优先使用 `apiKeyEnv`，避免密钥进入配置文件。未设置 = 无密钥 |
| `apiKeyEnv` | `JINA_API_KEY` | 每次抓取通过 `ctx.credentials` 解析的凭据引用，启动环境作为回退平面。缺少值时保持无密钥模式 |
| `baseURL` | `https://r.jina.ai` | 端点基址；目标 URL 作为路径追加。无法解析或非 http(s) 时提供方不可用 |
| `engine` | （未设置） | 以 `X-Engine` 发送的浏览器引擎：`browser`、`direct` 或 `cf-browser-rendering`。未设置 = Jina 自动选择 |
| `timeoutSeconds` | （未设置） | 以 `X-Timeout` 发送的页面加载等待秒数，范围 1 到 180 |
| `maxTokens` | （未设置） | 以 `X-Max-Tokens` 发送的输出 token 上限，至少 500；Jina 会在上限处裁剪 Markdown，而不是拒绝请求 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 抓取返回什么

正文是作为 `text` 正文的 Jina Markdown。`statusCode` 是 Jina 自身的响应状态：读取成功时为 `200`，即使目标页面返回 `404`；Jina 会把目标状态记录在内容中，形如 `Warning: Target URL returned error 404: Not Found` 的一行。`url` 是规范化后的目标 URL。`truncated` 由 Jina 的 `x-usage-tokens` 响应头推导：配置了 `maxTokens` 时，达到或超过上限的计数会把正文标记为已截断；没有上限或没有该响应头时，提供方报告 `false`，而不是根据正文长度猜测。

### 失败与恢复

提供方失败——无效密钥、速率限制、不支持的目标等 HTTP 拒绝，以及网络失败和凭据解析失败——以 `WebError` `WEB_PROVIDER_ERROR` 呈现，并在拒绝响应体提供时携带 Jina 的 `message` 细节；中止请求以 `WEB_ABORTED` 呈现。无效目标（非 http(s)，或超过 2048 个字符）会在发出任何请求之前以 `WEB_INVALID_URL` 拒绝。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。调用方根据错误码进行分流；面向模型的 `web_fetch` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该提供方是 Jina Reader 之上的薄适配器，遵循三条刻意的规则：

- **前缀形式，不用请求体协议。** 一次抓取就是向 `{baseURL}/<target-url>` 发送 `GET`，与 Jina 文档的快速开始一致；请求不携带提取提示、schema 或 cookie。
- **只使用有文档的响应头。** 每个请求头都取自 Jina 的实时文档：`X-Engine`（`browser`、`direct`、`cf-browser-rendering`）、`X-Timeout`（整数秒，至多 180）与 `X-Max-Tokens`（整数，至少 500）。`X-Token-Budget` 也有文档，但刻意不公开：它会拒绝超预算请求，而 seam 期望得到有界且可用的正文。
- **诚实的截断。** `truncated` 来自响应的 `x-usage-tokens` 计数与所配置上限的比较，绝不来自 `text.length`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、凭据与环境变量回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `JinaFetchProvider`：URL 门禁、请求分发、中止分类、截断推导 |
| [`src/types.ts`](src/types.ts) | Jina 协议类型：`JinaEngine`、`JinaError` |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

### 请求与映射流程

每次操作都会快照当前配置段，并且只针对该请求解析可选凭据；解析出的密钥会添加 `Authorization: Bearer`，没有密钥则请求保持匿名。`fetch()` 校验目标为 http(s) 且至多 2048 个字符，把它追加到端点基址后发送 `GET`，并使用 `redirect: 'error'`，因此重定向会在不接触目标的情况下使请求失败。目标抓取由 Jina 执行；因此对本提供方而言 SSRF 筛查转移到 Jina，本地门禁只覆盖协议与长度边界。成功响应变为 `text` 正文；拒绝变为 `WebError`；中止——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余情况变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的抓取请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——web 包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-web-fetch-http](../web-fetch-http/README.zh.md)——与本提供方互斥的匿名本地抓取提供方。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方正文的面向模型 `web_fetch` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方的 `statusCode`、目标 URL、Markdown 正文与截断标记；如果发生失败，则会在消费方的错误包装层内保留原样错误消息 `Jina fetch aborted`、`Jina fetch request failed: <error>`、`Jina Reader error (HTTP <status>)`、`Jina returned an unreadable response body: <error>`、无效 URL 与凭据解析失败。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **同时挂载两个抓取提供方时必须固定 `web.fetchProvider`**——`http` 与 `jina` 都可用，因此未固定的 `ctx.web.fetch()` 会以 `WEB_PROVIDER_AMBIGUOUS` 失败；向导的 `applySetup` 会固定 `fetchProvider: jina`，手写 profile 也必须这样做。
- **SSRF 信任转移到 Jina**——目标由 Jina 从其自有基础设施抓取；本地门禁只检查协议与长度，因此从 Jina 可到达的目标就可到达，且目标 URL 中内嵌的凭据会被转发给 Jina。
- **只有配置 `maxTokens` 时截断才可见**——Jina 不提供显式的截断标记；达到或超过上限的 `x-usage-tokens` 计数会标记 `truncated`，而未配置上限时的 Jina 侧裁剪无法检测，因此 `truncated: false` 并不保证内容完整。
- **带哈希片段的 URL 会丢失片段**——`GET` 前缀形式无法传输 `#...`；哈希路由的单页应用需要 Jina 的 `POST` 请求体形式。
- **无密钥配额为每 IP 20 RPM**——无密钥请求共享启动主机的地址配额；配置密钥可提高限制并把计量转移到该密钥。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 未来：提取控制与 POST 形式

Jina 的选择器、cookie 与内容格式控制将推迟到有消费方需要时再做；seam 的抓取请求刻意只携带 URL。未来的 seam 变更也可以把目标改为 POST 请求体传输，从而保留片段与长 URL。

</details>
