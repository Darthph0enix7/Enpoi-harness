---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-session-format-v5

[English](2026-11-07-session-format-v5.md) | 中文

## 概述

为正文恒等的 V5 写入器把 `SessionHeader.version` 从 4 推进到 5。记录扩展后的审批结果词汇、`max-tokens-continuation` 来源 kind、移除的 `user-approval` 与 `model-selection` 来源变体、可选的 `request/context.nativeFileInputs` 策略描述符，以及 V4 时期的同版本事件新增。将两条分叉已接受历史的未接受 V4 记录退役，并直接从已接受的 V4 尖端确认其幸存根。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-session-format-v5
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "22c6899a78214dd841c266348ae997027ef391174ddb21127f1b71dc1b362824"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "db655a74967e9c1b2d5f4763a8d930aebd0d8b1161233db0633a539c81490142"
    decision: version-bump
  - root: "event:approval/decided"
    previous: "2026-09-11-initial"
    after: "a2448bcb223dc12996b55ac351064b0000d71b95f196724c23f2fe2a097c3b32"
    decision: version-bump
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "cf192c719b0febabe8244e1de05eef4bd39e88a3a371157f359c31e63202ffe1"
    decision: version-bump
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "9c6f7442e5621d80cb1e57ce18d635366477bf62be9209571ef21238df37bdce"
    decision: version-bump
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "d36e0831e56d3195346b63301f46dca6cde03d79164152c14101a8a05fe4a468"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "3e990433b6e4327b45dc1285750d716c18da2355ddc8a57d99008aad58d07b27"
    decision: version-bump
  - root: "event:llm/attempt-failed"
    previous: null
    after: "946eb1b89fe299bfe8ebb0257e67386fada612d12b7b0e11e62b6e03e940db9d"
    decision: version-bump
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "bd52986551dc8102017f344a40c17b262a5625b5966b5aa89e4e8145344ffbc5"
    decision: version-bump
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "b902b34dc7a4c08b58ad9c36519dad7dda638624a3d905d5394e9ef9969037a0"
    decision: version-bump
  - root: "event:request/context"
    previous: "2026-09-11-initial"
    after: "429ad19b7ae2b6270c50c98e807a5b227511c31b07c0db58cfe26a6ff84476eb"
    decision: version-bump
  - root: "event:revert/branch"
    previous: null
    after: "13eb99c2a2d7291fb5d14904e927e07e020e719d0ebb389f2699754c639d96b6"
    decision: version-bump
  - root: "event:revert/iteration"
    previous: null
    after: "0000e40458eff9852e4bd97456430b0dd9186594477cf06d6d8ffa374507a4b4"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "2c600ba8579367970510fb7da25d651ce609f136925f3d3713dc099191bbd753"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "54c880f9aa3a28f3507f58101746fcf34b8cefad7d622812c4eefddd032af188"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "a8ba2aeae8ad5488af29144d87fdef68d34c2b7d8b89a4d95b632e95824c332d"
    decision: version-bump
  - root: "event:verify/unmet"
    previous: null
    after: "e891cfa7e9fdced1a0da31d1040120268aacd24293850150f2ebcb4e769b1a35"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

V4 到 V5 迁移逐字保留每个事件、compact run、坐标、时间戳、引用与 payload，只改变逻辑 header 版本，并根据源标记重新推导继承截点。较旧的 V4 二进制会在 header 处拒绝 V5；V4 前驱仍保留在磁盘上供检查，不存在回退或降级路径。历史 V4 读打开返回 V4 读取器所接纳的同一可信前缀；当严格行恢复丢弃任何已提交 V4 行时，写打开拒绝生成 V5 后继文件，V4 代际保持选中且不变，直到源恢复为可干净迁移。撕裂的最终行或帧修复不属于恢复，仍照常发布。Session append 在 log-only surface 元数据之前校验 `request/context` payload 字段（包括 `nativeFileInputs`），因此当两者同时无效时 payload 错误优先；这与其他所有事件类型一致。审批结果词汇的扩展是真实的不兼容：旧 V4 运行时校验封闭的结果联合，因此 V5 可以写入 `allowed-always` 与 `allowed-always-broad`，而迁移会原样保留所有历史结果。`user-approval` 与 `model-selection` 来源作为未知生产者 kind 原样保留，新增的 `max-tokens-continuation` kind 在不改变消息重放的前提下被接纳。可选的 `nativeFileInputs` 成员仅是策略：不包含字节、文件名、哨兵、附件 id 或 sidecar 消息，缺失表示所有文件都按 handle 文本投影。由于旧读取器会忽略该描述符并改变原生投影与 token 预算，它被并入唯一的 V5 记录，而不是稍后追加。两条退役的 `2026-09-23-*` 记录具有 V1 形快照，且其前驱边分叉了已接受的 V4 历史；其文件作为冻结证据保存在 `docs/archive/retired-persistence/`，本记录直接从 `2026-09-16-session-format-v4` 与 `2026-09-11-initial` 确认六个分叉根与幸存的 `event:model/selection` 边。`docs/persistence-changes/finalized/v4.json` 与所有已接受记录保持逐字节不变。

<a id="verification"></a>
## 验证

聚焦的 V4 到 V5、V3 到 V4 回归、catalog 链、JSONL V4 到 V5 迁移与已安装 Session 测试在 51 个文件中通过 1,069 项；log-deepseek 以及 JSONL 迁移、列表、catalog 与历史内容测试在 8 个文件中通过 165 项并跳过 1 项。断言覆盖正文恒等、继承截点推导、确定性重复、非 V4 拒绝、未知必需事件拒绝、不透明 ignorable 保留、历史来源与结果保留、只读打开不发布、排他发布 V5 后继且 V4 字节与 inode 不变、第二次打开幂等、全新进程重开、损坏前驱拒绝，以及不回落 V6 拒绝。循环层描述符测试通过 481 项 agent-loop 与 434 项 llm 测试，覆盖已准备调用上的描述符捕获、深度相等、适配器校验拒绝，以及策略变化时记录 request/context。持久化脚本测试在 6 个文件中通过 303 项，覆盖分叉拒绝、重定向拒绝、V5 header 过渡与保留的定稿历史。新 edge 与重构后的 V4 校验和 codec 的语句、分支、函数与行覆盖率均为 100%；JSONL format 辅助函数也达到 100%。`gen-persistence-catalog` 与 `verify-persistence-catalog` 通过；`verify-persistence-formats` 报告六个完整的 V0-V5 引用；`verify-session-format-catalog`、`verify-dependency-catalog` 与 `verify-module-graph` 通过；在将其策略扩展为接受 V4 作为保留基线后，无密钥 Session 领域语料库通过；Python SDK 通过 207 项并跳过 12 项。无密钥 TypeScript SDK `text-turn` 快照 refresh 与 replay 以 V5 后继 fixture 通过。完整 `pnpm run build`、`pnpm run typecheck` 与 `pnpm run lint` 因本次迁移之外的脏工作树既有错误而停止（`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` 在需要 `SessionSeq` 的位置传入普通数字，`packages/llm/llm/tests/service.spec.ts` 的模型来源缺少必需的 `kind`）。完整 `packages/session` 套件通过 2,730 项，另有五个投影/标题失败在基础提交上同样复现；完整覆盖率运行通过 41,762 项，更广泛脏工作树中有 138 个既有失败与未处理错误；其余 SDK 场景因基础提交上同样复现的工具描述漂移而失败。

<a id="dev-note"></a>
## 开发备注

无。
