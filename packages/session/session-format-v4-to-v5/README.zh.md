---
description: "完整的 V4 到 V5 Session 迁移边：恒等正文转换、已发布物理分帧、继承截点保留与代际自有拒绝规则。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

[English](README.md) | 中文

## 概述

在不改写已存储代际的前提下，将受支持的已发布 V4 Session 恢复为 V5。本页完整说明迁移边的转换、保留与拒绝规则。正文转换是恒等转换：每个事件、紧凑事件段、坐标、时间戳、引用和载荷都原样发出。持久化层负责文件读取和后继代际发布；本库负责 header 转换、目标接纳与校验。

## 目录

- [使用本包](#use-this-package)
- [V4 到 V5 规范](#v4-to-v5-specification)
  - [Header 与物理分帧](#header-and-framing)
  - [恒等正文保留](#identity-body)
  - [继承截点](#inherited-cut)
  - [历史词汇](#legacy-vocabulary)
  - [未知事件与拒绝](#refusal)
  - [恢复与后继代际发布](#recovery-and-publication)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

完整恢复使用[目录](../session-format-catalog/README.zh.md)。直接导入用于目录组装和测试；本库没有 Cordis 挂载配置。[公开导出](src/index.ts)提供相邻迁移、已发布 V5 编解码器与恢复器，以及复用的已发布 V4 源编解码器和原生行接纳。源编解码器仍由 [V3 到 V4](../session-format-v3-to-v4/README.zh.md) 拥有。

仅转换 header 时校验并推进元数据，不读取正文：

```text
const targetHeader = sessionFormatV4ToV5.migrateHeader(sourceHeader)
```

每次恢复都会创建独立的 Stage 状态。紧凑事件段直接透传，不展开。持久化层必须在发布后继文件前完整读取并校验源文件；拒绝时不发布任何文件。

-----

<a id="v4-to-v5-specification"></a>
## V4 到 V5 规范

本迁移边只改变逻辑 header 版本。它不执行任何事件、消息槽位、载荷、坐标或引用转换。更早的 V0–V3 输入先经过各自的既有迁移边到达 V4；那些迁移边保留自己的转换和拒绝策略。

<a id="header-and-framing"></a>
### Header 与物理分帧

| 输入 | V5 结果 | 保留或拒绝 |
|---|---|---|
| 逻辑 V4 header | `version: 4` 变为 `5` | 先执行已发布 V4 header 校验；其他逻辑 header 字段保持不变。 |
| V4 物理行 | 已发布 V4 源编解码器解码事件和紧凑事件段 | 源分帧与原生 V4 行接纳仍由前一包拥有。 |
| V5 物理行 | `releasedV5SessionFormatCodec` 复用已发布物理分帧和原生 V4 行接纳 | 编码与解码不会运行此入边迁移。 |

<a id="identity-body"></a>
### 恒等正文保留

每个源事件都以相同的 `type`、`seq`、`time`、`data`、`surfaceOp`、`sourceEventSeqs` 和 `ignorable` 值发出。本迁移边不插入、删除、重命名或重排任何内容。它不创建用户消息、系统提示、developer 变更、工具执行或旁路文件。Assistant 紧凑事件段不展开直接转发，并保持其事件段身份。

<a id="inherited-cut"></a>
### 继承截点

目标继承截点等于源截点。未播种的源在 EOF 前声明截点为零。已播种的源从最后一个携带 `inherited: true` 的 `session/end-seed` 事件取得截点。若输入在构造时声明了源截点，`finish()` 会校验标记与之一致；未知或不一致的截点会被拒绝，而不会替换为零。

<a id="legacy-vocabulary"></a>
### 历史词汇

历史 `user-approval` 和 `model-selection` 消息来源 kind 与其元数据一起原样保留；它们不会被重新解释或丢弃。所有新旧审批结果都保留。`session-log-deepseek/delivery-accepted` 事件保留原始 `data.sessionFormatVersion` 值，因此历史 V4 水位保持历史含义，只有原生 V5 水位才按当前代际校验。

<a id="refusal"></a>
### 未知事件与拒绝

源 V4 编解码器和恢复器会拒绝未知 required 事件类型；本迁移边不会放宽该接纳范围。未知 ignorable 事件保持不透明并被保留。非 V4 源 header、目标 header 不是 V5、损坏的源正文，以及未通过原生 V4 行接纳的目标正文都会被拒绝。拒绝时不发布后继文件，源代际保持不变。

<a id="recovery-and-publication"></a>
### 恢复与后继代际发布

持久化层以严格行解码读取历史 V4 源，因此每个已提交行都会被观察到。解码失败的已提交行终止可信前缀；若其后出现 `turn/end`，该日志会像 V4 读取器一样被拒绝。若后续行未通过原生 V4 行接纳（包括更早失败之后的已退役内容），整份日志都会被拒绝，而不会形成不可信尾部。读打开返回 V4 读取器所接纳的同一可信前缀，且不写入后继文件。V4 读取器同样会抑制该尾部，因此读一致性已经成立；但发布截断前缀仍会使其成为未来唯一被选中的代际，因此写打开改为保持前驱权威。当恢复丢弃了任何已提交行时，写打开拒绝发布：V4 代际保持选中且不变，不会出现 V5 后继文件；只有源恢复为可干净迁移后，后续写打开才会重试。撕裂的最终行或最终帧属于 V4 既有的修复语义而非恢复，仍照常迁移。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

迁移声明创建相互独立的流式 Stage。Stage 通过提供的 context 转发每个已解码事件或紧凑事件段，只跟踪继承标记，并在 `finish()` 时返回校验后的截点。V5 编解码器包装已发布 V4 编解码器以复用物理分帧和行接纳；它写入逻辑 header 版本，并在委托前执行原生 V4 接纳。目标恢复器复用前一包的参数化已发布字段与关系校验器，代际参数为 5，因此当前代际 delivery 所有权按 V5 校验，而更早的标记保持历史含义。

本包不发布运行时不变量伴随插件，因为这个纯函数库不拥有独立维护的运行时观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [格式版本与发布状态](../../../docs/session-format-status.zh.md) — 当前检出写入版本与已发布格式的权威记录。
- [添加 Session 格式版本](../../../docs/cookbook/adding-a-session-format-version.zh.md) — 相邻迁移边的集成与校验。
- [JSONL 持久化](../session-persistence-jsonl/README.zh.md) — 不可变代际选择与发布。

-----

<a id="model-experience"></a>
## 模型体验

### 历史恢复

#### 模型看到什么

历史请求保留记录的消息与模型配置。恒等 Stage 不添加模型可见内容：`request/header`、`request/context` 与每个消息事件都按原样重放。

#### Token 影响

转换不改变请求文本或承载 token 的数据。

#### KV Cache 影响

该迁移边保留记录的请求前缀。提供方缓存的可用性和淘汰策略不属于本库职责。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- **历史覆盖范围** — 此迁移边只接受已发布 V4 编解码器和恢复器接纳的 V4 正文。更早的 V0–V3 迁移边保留各自的拒绝策略。
- **不支持降级** — 已发布的 V5 代际会被旧的 V4 写入器在 header 处拒绝。V4 前驱文件保留用于检查，不提供自动回退。
- **已接受转换** — [检查点](../../../docs/session-format-status.zh.md#finalization-record)保护已接受历史。V5 变更先被确认，之后才会定稿。
- **当前校验** — strict 与 current 恢复还会运行已安装 Session 校验，完整的消息、表面和 descriptor 检查由该层拥有。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
