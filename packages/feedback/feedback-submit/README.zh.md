---
description: "反馈提交客户端：供反馈流水线的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feedback-submit

[English](README.md) | 中文

## 概述

本包是反馈流水线的一个阶段：把端点载荷以单个 JSON POST 发送到部署配置的端点。提交按契约失败软降级——调用方已在本地记录备注，端点故障绝不能使记录路径失败——因此任何失败（网络、超时、非 2xx、无法解析的回复）在至多一次重试后返回 null。

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
