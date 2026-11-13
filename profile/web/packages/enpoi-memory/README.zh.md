# dsh-enpoi-memory

[English](README.md) | 中文

Enpoi Harness 的持久跨会话记忆，以四个模型工具暴露。记忆由工具驱动：不会向轮次注入任何内容，每次写入都落在一个共享 SQLite 数据库；keeper、dispatcher 与 CLI 各自通过独立连接打开它。

## 工具

- `memory_save` 保存一条自包含事实（最多 400 个字符），使用 `origin: orchestrator` 与 operator 信任标签。重复或无效事实返回 `saved: false` 及原因。
- `memory_search` 返回匹配的已提交与暂定事实，包含 id、category、origin、保存日期、state 与 trust。compaction 来源的行默认限定到调用方工作区；其他来源（包括 keeper claims）保持既有可见性。内容绝不会注入模型上下文。
- `memory_rescind` 为一条事实建立墓碑。墓碑是吸收态：同一事实绝不会复活。
- `memory_confirm` 以 operator 信任标签和新的提交时间提交一条暂定 claim，只作用于 tentative 行；已提交的 id 返回 `Already <state>`。

模型发起的 `memory_confirm` 或 `memory_save` 调用属于工具委托，不是人工事实核验。operator 标签只记录写入该行的工具，不代表有人核实过该 claim。

## Claims 与信任

claim 的状态是 `tentative`、`committed`、`orphaned_cancelled` 或 `rescinded`；信任是 `operator`、`verified_execution` 或 `untrusted_external`。

- Compaction Durable Facts 以 `origin: compaction` 落为暂定 `untrusted_external` claim。检查点提交只证明摘要运行过，不证明模型抽取的文本为真。
- Keeper claims 以 `origin: keeper` 落为暂定 `untrusted_external` claim。精确 operator 引用只证明这些话存在于人类消息中，不证明其解释、接受状态或真实性。
- 自动 claim 只有在 operator 权威写入时才会获得 operator 标签：对 tentative 行执行 `memory_confirm`，或再次观察到同一事实的 `memory_save`。两种自动来源都不能生成 `RULES`、`CONSTRAINTS` 或 `NAMING` 类别。
- 近重复抑制在准入前使用 token 集合 Jaccard 阈值；secret guard 拒绝凭据形态的事实。

启动与 HMR 对账会把未完成轮次遗留的 tentative claim 转为 `orphaned_cancelled`，但保留来源记录（source record）带有生产者结算证明的 claim：

- `origin: compaction`，`source: compaction`，且 `compactionId` 非空；
- `origin: keeper`，`source: keeper`，`sessionId` 非空，`batchBasedOnSeq` 为非负整数，且 `settled: true`。

这是结构性来源记录检查，不是认证。已撤销与已 orphan 的行绝不会被修改。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `compactionFacts` | true | 捕获模型撰写 compaction 摘要中的 `## Durable Facts` 段 |
| `compactionFactsIncludeChildSessions` | false | 同时捕获 subagent 子会话的事实 |
| `compactionFactsMax` | 12 | 单次 compaction 最多捕获的事实数，限制在 1–40 |
| `compactionFactsNearDuplicate` | 0.8 | 近重复抑制的 token 集合 Jaccard 阈值，限制在 0.5–1 |
| `scopeCompactionFactsToWorkspace` | true | 将 `memory_search` 中的 `origin: compaction` 行限定到调用方工作区 cwd |

检索 top-K 与字符预算来自 `enpoi-orchestration.parameters.memory`（`retrieverTopK` 默认 10，`retrieverCharBudget` 默认 1200），每次搜索都重新解析。

## 已知限制

- 含换行的事实会在 `memory_search` 输出中被引用，因此无法伪造第二条结果行。
- 数据库路径遵循 `DSH_MEMORY_DB`，否则为 `~/.dsh/memory.db`；本包不暴露服务，兄弟进程通过 SQLite WAL 与 `BEGIN IMMEDIATE` 协调。
- 记忆绝不会被注入。跳过 `memory_search` 的消费方不会看到任何已保存事实。

## Tests

```sh
cd profile/web
npx vitest run packages/enpoi-memory/tests
```
