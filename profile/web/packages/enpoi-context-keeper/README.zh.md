# dsh-enpoi-context-keeper

[English](README.md) | 中文

Enpoi Harness 的按需认知层：散文式 Living Brief 只在 Oracle 或 Council 请求时才生成，而状态检查点会在分段边界与陈旧度下限处刷新。

## Living Brief

`BriefService.ensureFreshBrief()` 通过 keeper 路由链从最近的会话日志蒸馏出五段式 brief。新鲜度按结构性事件距离衡量（`structuralDistanceK`，默认 24），并受防抖动下限约束（`minRefreshMs`，默认 60 秒）；失败会进入负缓存（`negativeCacheMs`，默认 120 秒）。消费者在同一个新鲜度窗口内共享一次在途蒸馏；结构性陈旧的 `turn/end` 会调度一次去抖后的后台预取，使下一次 Oracle 或 Council 调用通常直接命中缓存。原始工具调用回显、JSON 工具信封和以标记为主的内容会在成为散文之前被拒绝。

## State checkpoints

`CheckpointService.ensureCheckpoint()` 将 brief 渲染为持久的 `state/checkpoint` 事件，以及一条替换上一个检查点节点的插件来源 surface 消息。当所有模型路由都失败时，确定性模板回退仍能保证该层有效。

当 `compaction/start` 括号打开时，完成的刷新只写入持久的 `state/checkpoint` 事件：其 surface 消息会暂存到匹配的 `compaction/end`（无论干净结束还是出错）。该结束时的冲洗就是该边界的唯一一次 surface 写入；强制的结束调用会直接返回已冲洗的检查点，而不会再次付费，因此括号期间 keeper 的 surface 消息数量为零。

每个完成的分段压缩只刷新检查点一次：监听器保存每一个 `compaction/summary` id，并在首个携带匹配 id 且不含 `error` 的 `compaction/end` 上刷新。结束事件决定事务结果，因此模型撰写、机械式与摘要器失败的摘要都会在干净结束时刷新；仅有摘要、id 不匹配、带错误的结束以及重复的结束都不会触发刷新。已处理的 id 会按会话存入固定大小的环形记录，因此已完成的摘要/结束对即使重放也不会刷新两次；按会话的状态受 LRU 上限约束，并在 `session/disposed` 与插件销毁时清除。

强制刷新到达时若旧刷新仍在途，会先等待该轮完成，再运行一次覆盖该边界的新刷新；绝不会把旧快照当作边界的检查点返回。失败的轮次不会被立即重试，而由自然的陈旧度下限再次尝试。在 `session/disposed` 或插件销毁后才完成的刷新不会发布任何内容。陈旧度下限在 `turn/end` 处按 `checkpointStaleEvents` 个结构性事件（默认 12）或 `checkpointStaleHours` 小时（默认 24）中先到者触发；token 压力只是额外触发条件。

## Configuration

每个 `Config` 字段都是可实时编辑的 `.volatile()` 值，`enpoi-orchestration.parameters.keeper` 会在每次唤醒时覆盖插件配置行。路由字段（`provider`、`model`、`fallbackProvider`、`fallbackModel`）遵循 keeper persona 分配；`leaseMs`、`maxInputEvents` 与 `maxOutputTokens` 限定单次唤醒。brief 使用 `structuralDistanceK`、`minRefreshMs` 与 `negativeCacheMs`；claims 使用 `claimsBatchSize` 与 `claimsBatchMinutes`；检查点使用 `checkpointStaleEvents` 与 `checkpointStaleHours`。

可通过 `enpoi-orchestration.capabilities.tools.keeper` 禁用 keeper；禁用后，散文蒸馏、claims 抽取和检查点刷新都会被跳过。

## Tests

```sh
cd profile/web
npx vitest run packages/enpoi-context-keeper/tests
```
