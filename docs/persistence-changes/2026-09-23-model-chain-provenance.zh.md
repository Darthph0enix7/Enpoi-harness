---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-23-model-chain-provenance

[English](2026-09-23-model-chain-provenance.md) | 中文

## 概述

为持久化的模型输出增加可选的故障转移链来源信息：终止流分块上的应答链路（answeringLink）、助手消息来源上的模型组 id，以及持久化模型选择上的模型组 id。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-model-chain-provenance
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-14-image-offload"
    after: "25aaf208018d9b7c2ecbd2317967cf8c9937823f4527412ee9c0ef65cebff783"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-14-image-offload"
    after: "048161739677c663f40ccd7d9f9f1f586e78ffffe9d5504a5f40c2491f34fbb4"
    decision: same-version
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "b902b34dc7a4c08b58ad9c36519dad7dda638624a3d905d5394e9ef9969037a0"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

所有新增均为可选。仅在运行时从请求自身路由升级到链上其他链路时才写入 answeringLink；仅在请求携带模型组时才写入 chain；单模型请求两者皆无。既有日志不含这些字段，历史回放保持不变。忽略它们的消费方仍按已持久化的具体 provider/model 归因回答，该键值仍是当前活动链路；对模型选择而言，缺失或未知的组 id 保持单模型路由。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm/tests/model-chain.spec.ts packages/api/session-controller/tests/session-projections.host.spec.ts：2 个文件共 33 个测试通过，覆盖链路升级、应答链路以及带/不带 chain 的模型选择折叠。pnpm exec vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts：2 个文件共 73 个测试通过；持久化预览仅归类为可选新增，无需版本升级。

<a id="dev-note"></a>
## 开发备注

无。
