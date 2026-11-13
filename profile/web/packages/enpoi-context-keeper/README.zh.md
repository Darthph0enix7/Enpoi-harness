# dsh-enpoi-context-keeper

[English](README.md) | 中文

Enpoi Harness 的按需认知层：散文式 Living Brief 只在 Oracle 或 Council 请求时才生成，而状态检查点会在分段边界与陈旧度下限处刷新。散文 brief 是消费者与展示输出，不会注入模型请求。状态检查点才是模型可见的派生状态层。

## Living Brief

`BriefService.ensureFreshBrief()` 通过 keeper 路由链从最近的 active surface 蒸馏出五段式 brief。新鲜度按结构性事件距离衡量（`structuralDistanceK`，默认 24），并受防抖动下限约束（`minRefreshMs`，默认 60 秒）；失败会进入负缓存（`negativeCacheMs`，默认 120 秒）。消费者在同一个新鲜度窗口内共享一次在途蒸馏；结构性陈旧的 `turn/end` 会调度一次去抖后的后台预取，使下一次 Oracle 或 Council 调用通常直接命中缓存。原始工具调用回显、JSON 工具信封和以标记为主的内容会在成为散文之前被拒绝。

Keeper 读取当前模型可见 surface，而不是原始仅追加日志。已回退或废弃的分支不能提供 operator 文本或检查点锚点。裸 `user` 生产者会以 `USER_ROLE_UNVERIFIED` 可见，而不是 operator 权威；peer 与 subagent 父消息属于派生上下文；assistant 文本是公开观察，私有推理会被排除；工具调用与结果是观察值，不是已验证执行。销毁 brief 服务会清空缓存并推进按会话归属，因此已销毁或会话被逐出后，在途轮次无法发布过时散文。

## State checkpoints

`CheckpointService.ensureCheckpoint()` 写入持久的 `state/checkpoint` 事件，以及一条替换上一个检查点节点的插件来源 surface `user/message`。模型路径请求一份当前连续性 JSON item 草稿：operator 目标、约束、已陈述决定、观察证据与未完成工作。对于 operator 条目，代码只接受当前 active 人类 operator 消息中完整文本块或完整行运行的精确引用，且必须位于所引 seq。无效 JSON、非活动或错误来源锚点、未来 seq 或非精确引用会丢弃整份草稿，并只使用一次确定性模板，不重试。被接受的引用只证明文字，不证明其解释或真实性；所有路由失败时模板仍会产出有效检查点。

最新的 active `enpoi-keeper` `user/message` 是权威的先前派生状态。每次唤醒与每次缓存命中都会读取其 `content`，剥离公开的 `State checkpoint` 包装，并使用该文本；连续性读取不会使用原始 `state/checkpoint` 事件或 source 中重复的 `sections`。因此，替换该 active 消息一行的上下文修复会在下一次唤醒立即生效：缓存命中时零模型调用、零追加。若 active keeper seq 已变化，暂存的 pending commit 会被丢弃，旧渲染块无法覆盖已修复 surface。

`checkpointMaxChars` 限制完整发出的块，包括 header、派生状态 notice、正文与 telemetry 行。它接受 256 到 12,000 的整数，默认 2,400；正文按码点边界裁剪，条件允许时固定 wrapper 会保留。

当 `compaction/start` 括号打开时，完成的刷新只写入持久的 `state/checkpoint` 事件：其 surface 消息会暂存到匹配的 `compaction/end`（无论干净结束还是出错）。打开的 tool batch 同样暂存。每个完成的分段压缩只刷新检查点一次：保存的 summary id 与匹配的干净 end 配对，已处理的 id 留在有界按会话环中，因此重放不会刷新两次。强制刷新在旧轮次仍在途时会先等待，再运行一次覆盖该边界的新刷新。在会话或插件销毁后才完成的刷新不会发布任何内容。

HMR 或重新挂载后，compaction 括号状态最多从最近 64 个事件重建。若该有界反向探测在找到 `compaction/start` 之前结束，hydration 会保守地保持 unknown 并暂缓 surface 提交；之后的 `turn/start` 证明旧边界不可能仍在摘要中，并清除该保持。冷重开若找到最新持久检查点但 active keeper surface 节点缺失，服务会用同一 version 重新物化该块，而不是伪造新 version。

Watchtower 的 State 展示读取原始 `state/checkpoint` 事件。active surface 修复后，它可能显示修复前文本，直到下一次真实刷新。这只是展示延迟，不是功能缺口，也不是伪造 version 提升的理由。

## Claims

每 `claimsBatchSize` 个未中止 `turn/end` 或 `claimsBatchMinutes` 分钟运行一次批量 claims pass，以先到者为准。每条抽取出的 claim 都以暂定 `untrusted_external` 落库，即使其精确人类引用已通过校验也是如此：引用只证明文字存在，不证明其解释、接受状态或真实性。Operator 权威仍由显式 `memory_save`、`memory_confirm` 与 operator 工具掌握。每批携带一个结构性结算证明：`source: keeper`、非空 `sessionId`、非负整数 `batchBasedOnSeq` 与 `settled: true`。

## 配置

每个字段都是可实时编辑的 `.volatile()` 值；`enpoi-orchestration.parameters.keeper` 会在每次唤醒时覆盖插件配置行。

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `provider` / `model` | `kilo` / `poolside/laguna-s-2.1:free` | Keeper 主路由 |
| `fallbackProvider` / `fallbackModel` | 缺省 | 可选第二路由；两者必须同时设置 |
| `leaseMs` | 45000 | 单次唤醒上限 |
| `maxInputEvents` | 80 | 单次 framed 输入保留的 active-surface 事件数 |
| `maxOutputTokens` | 2048 | Brief/claim 输出上限，限制到 4096 上限 |
| `structuralDistanceK` | 24 | 触发重新蒸馏的结构性事件距离 |
| `minRefreshMs` | 60000 | 防抖动复用下限 |
| `negativeCacheMs` | 120000 | 失败负缓存窗口 |
| `claimsBatchSize` | 8 | 每次 claims pass 的未中止 turn end 数 |
| `claimsBatchMinutes` | 5 | 每次 claims pass 的分钟数 |
| `checkpointStaleEvents` | 12 | 陈旧度下限刷新前的结构性事件数 |
| `checkpointStaleHours` | 24 | 陈旧度下限刷新前的小时数 |
| `checkpointMaxChars` | 2400 | 完整发出检查点块上限，校验范围 256–12000 |

可通过 `enpoi-orchestration.capabilities.tools.keeper` 禁用 keeper；禁用后，散文蒸馏、claims 抽取和检查点刷新都会被跳过。

## 已知限制

- 检查点 surface 消息会把渲染块存入 `content`，并再次存入其 `source.sections` 条目。因此持久日志携带两份正文，但连续性只读取 active `content`。这是既有的 `SourceContextFormed` snapshot 形式，没有新事件、来源类型或格式版本。
- 原始 `state/checkpoint` 事件与 Watchtower State 展示可能落后于已修复 active surface，直到下一次真实刷新。模型可见的 active 消息才是权威。
- 精确 operator 引用是措辞证据，不是解释、接受状态或当前事实的证据；一次性请求不是常设规则。

## Tests

```sh
cd profile/web
npx vitest run packages/enpoi-context-keeper/tests
```
