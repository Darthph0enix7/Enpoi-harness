# dsh-enpoi-verify-gate

回合结束「验证门」。它修复一个实际观测到的缺陷：Agent 在**自己最后一次验证失败**的
情况下，仍然把回合标记为成功结束（真实会话：跑 `pytest`，看到 `assert [] == [7]`，
随后以 `completed` 结束回合，从未调用 `edit`/`write` —— harness 毫无察觉）。

## 判定规则

插件观察持久化 `session/event` 事件流（与 `enpoi-diagnostics` 相同的官方接缝，不用
废弃读取器），在 `turn/end` 时判定该回合「未验证」当且仅当：

1. 本回合**最后一次验证类工具结果**失败；且
2. 回合以 `completed` 结束。

「验证类」包括：
- `bash`、`pwsh`、`str_replace_editor`，或
- 任何携带结构化事实的工具结果：工具自有的 `meta.exitCode`（bash/pwsh 的
  `ShellOutcomeMeta`）或结构化 `error` 身份。

编排/调度控制面工具（`subagent`、`task`、goal 工具、`send_message`、
`interrupt_agent`、`list_agents`）不计入：容量拒绝或审批不可用属于编排事实，而
不是被验证工作的失败。它们的结果既不会触发也不会清除验证门。

「失败」包括：`meta.exitCode` 存在且不为 `0`（`null` 表示被信号杀死）、存在结构化
`error`、工具角色消息的 `isError === true`（原生 session-format V4 —— 不再读取已
弃用的 V3 嵌套 `tool-result` 包装），或识别出失败文本（`[exit code: N]`、
`FAILED`、`AssertionError`、`Traceback …`、`… ERR!`、`command not found`）。
同一回合内后续的通过验证会清除先前的失败；非验证类结果（如 `read`）不影响判定。

## 记录形态

每个未验证回合写入一条可忽略（ignorable）fork 事件，通过
`Session.append(..., { ignorable: true })` 写入 —— 与 LLM seam 的
`llm/attempt-failed` 使用同一信封，因此**不改动任何已发布联合类型或 schema**：

```json
{
  "type": "verify/unmet",
  "seq": 35,
  "data": {
    "turn": 1,
    "tool": "bash",
    "callId": "call_00_…",
    "exitCode": 1,
    "reason": "exit-code",
    "messagePreview": "test_convert.py:8: AssertionError"
  },
  "ignorable": true
}
```

`messagePreview` 为折叠空白、去除 ANSI 的失败行，上限 200 字符；`reason` 取值
`exit-code | tool-error | is-error | failure-text`。每个回合最多记录一次（回合
边界处消费该失败事实）。

## 行为开关（默认 = 仅记录）

`enpoi-orchestration.parameters.verifyGate`，每次回合结束时从共享文档热读取——
0.1.7 settings→Config 迁移后，该文档即 `enpoi-orchestration` profile 条目的
`.volatile()` Config，经 settings 服务的 `describe()` 值读取（带 pre-0.1.7 的
`get()` 回退；见 `dsh-enpoi-contracts:readOrchestrationDocument`）：

```yaml
parameters:
  verifyGate:
    mode: record        # record（默认）| prompt
    promptOnce: false   # prompt 模式：整个会话最多提示一次
```

- `record`：绝不注入任何内容。
- `prompt`：向同一会话注入**一条有界追问**（"Your last verification failed —
  continue the work or explain why the turn is done."），通过
  `agent.followup(...)` 投递；**不循环**：连续第二次未验证结束只记录、不再追问。
  已验证（或中止/出错）的回合会重置连续计数；`promptOnce: true` 限制整个会话最多
  一次提示。

插件自身 `cordis.patch.yml` 的 `mode`/`promptOnce`（`.volatile()`）仅作为无
settings 时的回退；由于是 volatile 字段，也可经 profile 的 config-editor 文档
实时编辑。

## 调试可见性

`session.digest` 位于 host 侧（harness 仓库的 `packages/api/session-controller`，
即 `F/packages/**`），无法从本 profile 扩展。改为：门把每个「未验证」回合通过
diagnostics 服务已有的 `report` 接缝写入事件（`kind: 'verify-unmet'`），
`enpoi-debug` 的 `session_debug` 工具在 `incidents` 区块中会直接显示（本会话行
优先）—— 无需改动 `enpoi-debug`。读取路由即 `diagnostics/list` RPC。

示例（`diagnostics/list`）：

```
error  client  client-report  D96FB6B  session-…  verify/unmet: bash exit-code exitCode=1 turn=1 test_convert.py:8: AssertionError
```

`F/packages/session/session-format-v0-to-v1/src/dispositions.ts` 的迁移清单属于
harness 侧（超出 profile 范围），**未**修改，也不需要修改：持久化读取路径对未知
事件类型的容忍条件正是携带 `ignorable: true`（`session-persistence/
src/storage-contract.ts`），与既有 fork 词汇（`llm/attempt-failed`）完全一致。

## 保证

- Fail-open：门自身失败只记日志并吞掉，绝不阻塞回合、append 或其他插件。
- 对其他包只读：无 host 代码、无 schema/联合类型改动、不改本包与 profile 注册
  之外的任何文件。
- 有界：预览 ≤200 字符；记忆的 callId 与会话跟踪均有上限（最旧者先淘汰）。

## 构建

```sh
pnpm --dir ~/.dsh/profiles/web/packages/enpoi-verify-gate build
```

## 测试

```sh
cd ~/.dsh/profiles/web && pnpm vitest run packages/enpoi-verify-gate
```

覆盖：真实形态 exit-1 结果识别、干净/中止/出错回合不记录、未验证回合恰好记录一次、
prompt 模式恰好注入一次且第二次连续未验证不再注入、`promptOnce`、settings 优先级、
以及插件接线（延迟 append、diagnostics 上报、追问消息）。
