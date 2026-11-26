# dsh-enpoi-job-guard

[English](README.md) | 中文

仅在专用于作业的 Worker 组合中挂载本插件。插件要求有效的 peer 作业绑定，检查每次工具执行和模型请求，并通过 `peerProfileIdentity` 向控制器提供会话当前的工具清单。

## 配置

| 字段 | 默认值 | 行为 |
|---|---|---|
| `requireBinding` | `true` | 拒绝未绑定的执行。不要在 Worker 上禁用。 |
| `requirePinnedRoute` | `true` | 要求具体的提供方和模型，在派发前拒绝模型链。 |
| `allowedTools` | 省略（全部拒绝） | 精确的公开工具名称。绑定和此列表都必须列出该工具。 |
| `toolCapabilities` / `defaultCapability` | `{}` / 省略 | 按精确映射、配置默认值、精确公开工具名称的顺序查找；绑定也必须授予选定的能力。 |
| `maxSteps` / `maxToolCalls` | `32` / `64` | 每个会话的上限；绑定只能降低上限。 |
| `maxWallMs` / `maxTotalTokens` | `600000` / `200000` | 从 `binding.createdAt` 开始计时且不晚于 `expiresAt`；令牌上限涵盖四类用量。 |
| `defaultMaxTokensReserve` | `4096` | 在请求写入日志前补充 agent 循环缺省的输出上限。直接调用 LLM 时必须提供 `maxTokens`。 |
| `admissionUrl` / `admissionTimeoutMs` | 省略 / `5000` | 可选的 Hub POST，不得超出作业时限。禁止 URL 凭据、查询、片段和重定向。 |
| `admissionServerId` / `admissionIncludeArgs` | `job-guard-admission` / `false` | 标头提供方的目标标识；只有显式启用时才向 Hub 发送原始参数。 |
| `auditDir` / `auditMaxBytes` | `$DSH_HOME/enpoi-job-guard` / `1048576` | 私有绝对目录和每个会话的 JSONL 字节上限；不轮转。 |
| `presetId` / `harnessVersion` | `worker` / 运行中的 harness 版本 | 标识字段。会话实际使用的预设优先于 `presetId`。 |
| `expectedFence` / `instanceId` | 省略 | 可选的额外绑定约束。即便省略，首次有效查询后作业、栅栏或实例值有变更也会被拒绝。 |

## 准入与标识

控制器提供 `peerJobBindings.get(sessionId)`。在任何异步策略或网络操作之前检查精确工具授权及能力，符合条件的调用即预留名额，即使随后被拒绝也不退还。其他策略仍可以拒绝；需要交互批准的调用会被拒绝。执行器的单调检查要求同一个调用完成准入，直接调用和嵌套的注册表调用也不例外。派发时再次检查授权，并向支持协作式取消的工具传递时限信号。

启用 Hub 准入时，POST 请求发送 `jobId`、`fence`、`capability`、`toolName`、`callId`、`argsHash`，并可选地发送 `arguments`。只有成功的 HTTP 响应且 JSON 对象包含 `allowed: true` 才允许调用。错误映射成本地代码，不复制响应内容。如果绑定包含 `credentialRef`，可信主机必须挂载 `mcpHeaderProvider.headersFor(sessionId, serverId)`，针对所配置的目标将此引用解析为 Authorization 标头。请单独配置提供方；守卫不存储 bearer 凭据。

`peerProfileIdentity.describe(sessionId)` 为活动会话返回 `{ hash, presetId, toolNames, configDigest }`。将预设、运行中的 harness 版本、按名称排序的作用域工具模式、守卫配置摘要以及绑定的 MCP 端点和允许列表以键排序的 JSON 进行 SHA-256 散列。结果反映注册表中可见的工具，也包括执行时会被拒绝的工具，便于控制器发现意外暴露。

## 审计与预算

后备审计文件记录准入决策（时间、作业、栅栏、工具、调用标识、规范化参数摘要、决策和原因代码）和步骤前拒绝。不记录原始参数、标头、凭据引用或服务器响应。放行前必须成功追加记录并同步文件；文件已满或不可用时拒绝执行。日志只在本地保存，不能通过 peer 事件流获取。已有的 `peer/budget` 轮次取消标记可在会话历史中识别步骤或时限预算中止；不注册新的会话事件类型。

令牌检查合计累计计量和在途预留，后者包含预估输入和请求输出上限。已完成但没有可用计量的流按预留量计费。拒绝会在适配器派发前抛出 `JOB_BUDGET_REFUSED`。单个在途请求可能超过估计。模型链回退和适配器内部重试不会再次进入 `llm/stream`；Worker 应固定单一路由并禁用提供方回退。

## 模型体验

守卫不添加提示词、工具模式或 KV 缓存前缀。拒绝工具时，简短的拒绝信息进入正常的工具结果日志；拒绝步骤时不发送模型请求。

## 已知限制与延期工作

本插件不是操作系统隔离，也不提供跨进程共享配额。请使用专用 Worker 进程和私有审计目录；退出作业后撤销绑定，而不是重载守卫或在重启后复用会话。下次派发前的检查不会停止已在途的提供方请求，向工具发出信号也不能证明远端已停止。调用通过准入后，工具端点仍须执行自身的作业栅栏和到期检查。不提供单独的运行时不变量插件；执行器集成测试覆盖守卫自身的检查。
