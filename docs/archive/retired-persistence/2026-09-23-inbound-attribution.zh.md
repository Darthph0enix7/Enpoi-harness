---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-23-inbound-attribution

[English](2026-09-23-inbound-attribution.md) | 中文

## 概述

为持久化的入站消息来源与回合结束取消记录增加可选的来源信息：MessageSourceMap.user 与 AgentCancelCause 的 user 变体新增 ParticipantTag，模型消息来源新增模型故障转移组 id，因取消而中止的回合可携带终端提供方失败。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-inbound-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-14-image-offload"
    after: "cadf725ba3f4f901af69f53b88939a691b0138d0fe007e3acceed5518dfaff24"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-14-image-offload"
    after: "d240ee700d481b6493bb7157e55d500773aa5e88358a4863f1d942949cd1a37b"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-14-image-offload"
    after: "90451e186d67b39f7cc3dca49d4d282a11c793b9c67a645f5f2f1c63431fa5c3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-14-image-offload"
    after: "41cfde553a6cceb62d77f1de7638dde2c3732693fe2eb198db1051d19e7a05c0"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

全部为可选属性新增；必填成员、事件信封与 Session 头部均无变化。既有日志不含这些字段，历史读取、模型回放与折叠结果保持不变。participant 仅作归属标注，不携带任何权限；无法确定行动者的写入方会省略它，忽略该字段的消费方仍看到相同的消息类型与内容。chain 仅在来源来自分组指派时写入，并与已持久化的具体 provider/model 一致；忽略它的读取方仍按原先的路由归因回答。在取消到达循环前就已中止的回合现在可以携带 error，旧观察方不会读取该字段，既有 reason 仍是权威依据。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/llm/llm/tests/message.spec.ts packages/session/session-title-llm/tests/llm.spec.ts：2 个文件共 16 个测试通过。pnpm exec vitest run packages/subagent/subagent/tests/continuation.spec.ts packages/subagent/subagent/tests/service.spec.ts：2 个文件共 196 个测试通过。pnpm exec vitest run packages/core/agent-loop/tests/cancel.spec.ts：39 个测试通过。pnpm exec vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts：2 个文件共 73 个测试通过；持久化预览仅将这些根归类为可选新增，无需版本升级。

<a id="dev-note"></a>
## 开发备注

无。
