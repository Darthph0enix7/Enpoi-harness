---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-23-subagent-descriptor-quiet

[English](2026-09-23-subagent-descriptor-quiet.md) | 中文

## 概述

为可续期子代理描述符新增可选的 quiet 标志，使内部纤维在冷恢复后仍保持静默（不向父级发送结算通知与报告转发）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-subagent-descriptor-quiet
baseline: false
changes:
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "b35946d8fb062b10f73dda91fcde70c687a34159712ae5118ced3b4f4d7a0103"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该字段可选，仅为声明了 quiet 的可续期描述符写入；一次性与非静默子代理会省略它，既有日志中的描述符读取不变。描述符版本仍为 3：quiet 是同一组合记录的可选成员，而非新的输入形态。早于该字段的构建按模式精确白名单折叠描述符并拒绝未知字段，因此无法读取新写入的静默描述符——这仅影响新建的静默子代理，不改变历史会话的读取。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts packages/subagent/subagent/tests/service.spec.ts：2 个文件共 196 个测试通过，含 quiet 持久化与冷恢复还原。pnpm exec vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts：2 个文件共 73 个测试通过；持久化预览仅归类为可选新增，无需版本升级。

<a id="dev-note"></a>
## 开发备注

无。
