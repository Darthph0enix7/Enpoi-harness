---
description: "反馈载荷构建与匿名化：供反馈流水线的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feedback-collect

[English](README.md) | 中文

## 概述

本包是反馈流水线的一个阶段：从活动会话与部署事实构建匿名、有界、经脱敏的载荷分区——系统（版本、平台、提供方 id、默认模型，绝不含密钥）、上下文（有界的近期消息/工具调用/错误）、会话（加盐的会话 id 哈希、计数、预设/模型、近期错误）。`sessionFeedback.record` Remote 依次编排 collect → triage → submit，每个阶段都失败软降级，因此本地记录始终成功。

## 目录

- [使用本包](#use-this-package)
- [已知限制与未竟事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

以基础组合挂载该插件；它注册 `ctx.feedbackCollect`（feedback-collect）、`ctx.feedbackSubmit`（feedback-submit，配置：`enabled` 默认 true、`endpoint` 默认 `https://enpoi-feedback.kalinsaz123321.workers.dev/feedback`、`timeoutMs` 15000、`retryDelayMs` 500）或 `ctx.feedbackTriage`（feedback-triage，配置：`provider` 默认 kilo、`model` 默认 kilo-auto/free、`preset`/`permissionPreset` 默认 system-analysis、`timeoutMinutes` 默认 5）。不挂载插件时，记录路径仍会在本地记录并返回 null 结果。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与未竟事项

- 采集器读取活动会话的事件快照；跨会话上下文不在范围内。
- 脱敏器是聚焦式的（形似密钥的令牌、邮箱、家目录路径）；遥测瀑布仍是导出作用域的。
- 分诊依赖无密钥的 Kilo 免费路由；路由不可达时降级为 null 分析。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
