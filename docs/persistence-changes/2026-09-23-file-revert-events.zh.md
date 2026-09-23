---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-23-file-revert-events

[English](2026-09-23-file-revert-events.md) | 中文

## 概述

声明四个仅入日志的文件回退事件：revert/state 记录当前回退边界，revert/file-intent 与 revert/file-result 构成磁盘改动前的意图/结果预写对，revert/file-conflict 记录需要操作者裁决的文件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-file-revert-events
baseline: false
changes:
  - root: "event:revert/file-conflict"
    previous: null
    after: "0dd5d9778443f63729df9c252fdf3e476c6725b59d277cb257c3679de7f64142"
    decision: same-version
  - root: "event:revert/file-intent"
    previous: null
    after: "61a1ef6dfd7fa95da9e6023325c83c07d981a1e241a04a47e4a66d9f3e28729c"
    decision: same-version
  - root: "event:revert/file-result"
    previous: null
    after: "c41ca325c68f183c2c9f30184966d4982a672e442ffb1462d2476d689482982a"
    decision: same-version
  - root: "event:revert/state"
    previous: null
    after: "93a0e2ed44bc50262e59abbf13cbe484b965a0d2d9b9f716ec38e4dc6425f186"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

同一 Session 格式下的新事件根；既有日志不含这些事件，保持有效。四个事件均仅入日志、永不进入模型可见表面，因此不进入派生模型历史。早于该事件类型的读取方会拒绝携带它的日志，与所有读取即必需的事件一致；不含这些事件的会话只表现为没有回退状态。当前读取方折叠最新的 revert/state 以截断已回退的转录、把没有匹配结果的意图视为未封口以进行幂等恢复，并渲染冲突模态框。头部、事件信封与既有事件均无变化。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/core/agent-loop/tests/revert-commit.spec.ts packages/api/session-controller/tests/revert.host.spec.ts packages/api/session-controller/tests/revert-fold.client.spec.ts：3 个文件共 14 个测试通过。pnpm exec vitest run packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts：22 个测试通过，覆盖回退批次折叠进转录。pnpm exec vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts：2 个文件共 73 个测试通过；持久化预览将四个根归类为普通事件新增，无需版本升级。

<a id="dev-note"></a>
## 开发备注

无。
