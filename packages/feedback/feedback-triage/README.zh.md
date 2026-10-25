---
description: "临时反馈分诊：一个隔离的 Kilo 会话把载荷分类为严格 JSON，随后被释放并删除其持久日志，因此会话列表绝不会列出它。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feedback-triage

[English](README.md) | 中文

## 概述

本包是反馈流水线的一个阶段：一个临时、隔离的智能体会话把一条已记录的备注及其共享载荷分类为严格的分诊 JSON `{category, severity, summary, details?}`。该会话沿用首次运行系统分析的形态——品牌化 id、`system-analysis` 权限预设、无密钥的 Kilo 免费路由、硬性时限——空闲后即被释放且**从不归档**，因此绝不会污染会话列表。任何失败都返回 null：分诊只是建议，绝不能让记录路径失败。

## 目录

- [使用本包](#use-this-package)
- [已知限制与未竟事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

以基础组合挂载该插件；它注册 `ctx.feedbackCollect`（feedback-collect）、`ctx.feedbackSubmit`（feedback-submit，配置：`enabled` 默认 true、`endpoint` 默认 `https://enpoi-feedback.kalinsaz123321.workers.dev/feedback`、`timeoutMs` 15000、`retryDelayMs` 500）或 `ctx.feedbackTriage`（feedback-triage，配置：`provider` 默认 kilo、`model` 默认 poolside/laguna-s-2.1:free、`preset`/`permissionPreset` 默认 system-analysis、`timeoutMinutes` 默认 5）。不挂载插件时，记录路径仍会在本地记录并返回 null 结果。

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
