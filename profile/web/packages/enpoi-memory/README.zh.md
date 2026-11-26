# dsh-enpoi-memory

[English](README.md) | 中文

Enpoi Harness 的持久跨会话记忆，以四个模型工具暴露。记忆由工具驱动：不会向轮次注入任何内容，每次写入都落在一个共享 SQLite 数据库；keeper、dispatcher 与 CLI 各自通过独立连接打开它。

## 工具

- `memory_save` 保存一条自包含事实（最多 400 个字符）。已验证的根会话——包括用户创建的 fork（带 `parentSession`、`isSeeded: true`、无 `origin`、且 `delegationDepth` 缺失或为 0，与持久化 JSONL fork header 一致；该判定安全，因为真实 subagent 子会话总是写入 `origin: 'subagent'` 与 `delegationDepth >= 1`，而能伪造任意 header 的调用方本身已掌控伪造会话）——以 `origin: orchestrator` 和 operator 信任标签写入。subagent 子会话（`origin: 'subagent'` 或正的 `delegationDepth`）、缺少 `isSeeded: true` 且无 `origin` 的歧义 `parentSession`，或畸形血缘字段均归类为委派会话，以 `origin: worker:<role>`（没有 preset 时为 `worker`）落为暂定 `untrusted_external` claim；缺少会话或 header 的调用快速失败并返回 `saved: false`，不写入数据库。看起来像凭据或密钥的事实会被拒绝并返回 `saved: false`，绝不会被存储；相同的事实文本与类别只会存储一次。若保存内容的 token 与现有活跃事实高度接近，该事实仍会被保存，结果 note 会指出最接近的现有事实 id。
- `memory_search` 返回匹配的已提交与暂定事实，包含 id、category、origin、保存日期、state 与 trust。命中首先按覆盖的查询内容词数量排序，其次按完整查询短语精确匹配排序；origin/category 权重、provenance 中记录的调用方项目 cwd 与有界新近度用于打破平局。AND 未命中时回退到 OR 召回；当查询包含三个或更多内容词时，仅保留至少匹配两个内容词的行。可选的 `limit` 为整数，并限制到配置的 top-K；事实按排名顺序整条纳入，直到累计事实字符数达到配置的字符预算。即使排名第一的事实本身超出预算，也始终返回它；任何事实都不会被截断，渲染结果会报告预算省略了多少条匹配。compaction 来源的行默认限定到调用方工作区；其他来源（包括 keeper claims）保持既有可见性。内容绝不会注入模型上下文。
- `memory_rescind` 为一条事实建立墓碑。墓碑是吸收态：同一事实绝不会复活。仅根会话可调用；被委派的 subagent 会被拒绝，必须把事实报告给其父会话。
- `memory_confirm` 以 operator 信任标签和新的提交时间提交一条暂定 claim，只作用于 tentative 行；已提交的 id 返回 `Already <state>`。仅根会话可调用；被委派的 subagent 会被拒绝。子会话的 `memory_save` 在根会话确认前保持暂定。

模型发起的 `memory_confirm` 或 `memory_save` 调用属于工具委托，不是人工事实核验。operator 标签只记录写入该行的工具，不代表有人核实过该 claim。

## Claims 与信任

claim 的状态是 `tentative`、`committed`、`orphaned_cancelled` 或 `rescinded`；信任是 `operator`、`verified_execution` 或 `untrusted_external`。

- Compaction Durable Facts 以 `origin: compaction` 落为暂定 `untrusted_external` claim。检查点提交只证明摘要运行过，不证明模型抽取的文本为真。
- Keeper claims 以 `origin: keeper` 落为暂定 `untrusted_external` claim。精确 operator 引用只证明这些话存在于人类消息中，不证明其解释、接受状态或真实性。
- 子会话 `memory_save` 以 `origin: worker` 或 `worker:<role>` 落为暂定 `untrusted_external` claim。工具调用完成只证明保存运行过，不证明该发现为真。只有根会话可以确认或撤销记忆事实；被委派的会话收到 `delegated_session_denied` 结果，且不写入数据库。
- 自动 claim 只有在 operator 权威写入时才会获得 operator 标签：对 tentative 行执行 `memory_confirm`，或再次观察到同一事实的 `memory_save`。compaction 与 keeper claim 永远不会生成 `RULES`、`CONSTRAINTS` 或 `NAMING` 类别；子会话 `memory_save` 只能以暂定 claim 提出这些类别，且只有根会话写入（`memory_confirm` 或再次观察到同一事实的 `memory_save`）才能让任何 claim 获得 operator 信任。
- 近重复抑制在准入前对 compaction 事实使用 token 集合 Jaccard 阈值，且绝不会与现有行做模糊合并。`memory_save` 不抑制近匹配：它会保存事实，并在达到同一阈值时于结果 note 中指出最接近的现有活跃事实，因此仅一个数字不同的事实都会保留。secret guard 在准入管道中作用于所有来源（compaction、keeper 与 `memory_save`）：凭据形态的事实会被跳过且绝不存储，生产者不会收到异常。

启动与 HMR 对账会把未完成轮次遗留的 tentative claim 转为 `orphaned_cancelled`，但保留来源记录（source record）带有生产者结算证明的 claim：

- `origin: compaction`，`source: compaction`，且 `compactionId` 非空；
- `origin: keeper`，`source: keeper`，`sessionId` 非空，`batchBasedOnSeq` 为非负整数，且 `settled: true`；
- `origin: worker` 或 `worker:<role>`，`source: memory_save`，`sessionId` 非空，且 `settled: true`；记录的 `parentSessionId` 与 `callId` 属于归因信息，不是证明。

这是结构性来源记录检查，不是认证。已撤销与已 orphan 的行绝不会被修改。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `compactionFacts` | true | 捕获模型撰写 compaction 摘要中的 `## Durable Facts` 段 |
| `compactionFactsIncludeChildSessions` | false | 同时捕获 subagent 子会话的事实 |
| `compactionFactsMax` | 12 | 单次 compaction 最多捕获的事实数，限制在 1–40 |
| `compactionFactsNearDuplicate` | 0.8 | compaction 事实抑制与 `memory_save` 近匹配提示的 token 集合 Jaccard 阈值，限制在 0.5–1 |
| `scopeCompactionFactsToWorkspace` | true | 将 `memory_search` 中的 `origin: compaction` 行限定到调用方工作区 cwd |

检索 top-K 与字符预算来自 `enpoi-orchestration.parameters.memory`（`retrieverTopK` 默认 10，`retrieverCharBudget` 默认 1200，限制在 200–4000），每次搜索都重新解析。预算限制的是 `memory_search` 返回的事实文本，而不是排名：排名始终使用配置的 top-K，渲染结果会报告因预算被省略的匹配数。

## 已知限制

- 含换行的事实会在 `memory_search` 输出中被引用，因此无法伪造第二条结果行。
- 字符预算只省略整条事实。排名第一的单条事实即使超出预算也仍会返回；省略计数只覆盖配置 top-K 窗口内的匹配，而不是所有已存储的行。
- 调用方项目偏好读取行 provenance 中的 cwd，仅作为有界排序平局判据，不是可见性过滤。
- 委派权限不携带记忆确认权威：即使子会话拥有完整执行权限，也不能授予 operator 信任或为事实建立墓碑。必须由根会话接受该事实。
- 对于包含三个或更多内容词的查询，OR 回退会丢弃只匹配一个词的行。唯一匹配是通用词的查询不会返回无关事实，而是无命中。
- 回退成员由前 12 个内容词的两词 AND 组合 FTS 查询和 20 个候选窗口决定；JS 评分只对这些行排序。超过 20 个合格行仍可能排在目标之前并使其落在窗口外。这是有界召回，不保证全局最佳覆盖。
- 评分按 SQLite unicode61 拆分 `_`/`-` 并对已测试的拉丁字符做重音折叠；这不是完整的 unicode61 等价声明。FTS 清洗器仍要求词项至少两个字符，因此仅由单字符词组成的查询不会命中。
- 数据库路径遵循 `DSH_MEMORY_DB`，否则为 `~/.dsh/memory.db`；本包不暴露服务，兄弟进程通过 SQLite WAL 与 `BEGIN IMMEDIATE` 协调。
- 记忆绝不会被注入。跳过 `memory_search` 的消费方不会看到任何已保存事实。

## Tests

```sh
cd profile/web
npx vitest run packages/enpoi-memory/tests
```
