# dsh-enpoi-peer-bridge

[English](README.md) | 中文

设备到设备 peer API 的调用方（doc 69 P2、doc 70、doc 27 的"thin bridge"）。
一个 harness 驱动**远端** harness 会话：发送提示、跟踪到终态、读取回答、
应答远端询问、取消远端回合。远端仍使用自己的工具、工作区、审批与模型路由，
本插件从不在远端执行任何东西。

## 工具

| 工具 | 作用 |
|---|---|
| `peer_status {alias}` | 握手（对端身份、本次启动的 `instanceId`、摘要、能力、协议）+ `peer.state`：暴露级别、目标会话、闩锁状态、子代理数、待决询问、当前模型与停止意图。观察到静默不代表清理已经完成。 |
| `peer_sessions {alias?}` | 跨所有调用方配对发现：alias、对端、endpoint、绑定的远端会话 id（本地 `remoteSessionId` 固定或主机上报的会话）、暴露级别、闩锁摘要与最近活动；不可达主机即为该行的错误。只读。 |
| `peer_models {alias, limit?, cursor?, zeroPrice?, tools?}` | 对端允许本调用方选择的模型与链（已按策略过滤），附带每条路由的能力事实（工具、视觉、上下文窗口、零价、受限、训练、推理强度）与每个链成员的实时状态（`ready`、带 `cooldownUntil` 的 `cooldown`、`deprecated`）；策略通过 `selectable` 回显。只读。不声明模型发现能力的主机会返回 `peer/capability-missing`，并提示 "host does not advertise model-discovery; upgrade the host"。 |
| `peer_switch_model {alias, provider?, model?, chain?, reasoningEffort?, requestId?}` | 把空闲的远端会话在下个回合切换到另一条路由（`provider`+`model`，或仅链 id 以取其首个就绪成员；也可在链内指定具体路由）。此处命名的 `chain` 或路由只替换本次调用中配对固定的 create 路由。返回已应用的路由、先前路由，以及同一 `requestId` 重试时的 `replayed`。对端执行自己的允许列表；拒绝会带 `peer/forbidden` 与策略原因（`model-not-allowed`、`chain-not-allowed`、`price-unproven` 等），忙碌会话返回带闩锁的 `peer/conflict`。不声明模型切换能力的主机会返回 `peer/capability-missing`，并提示 "host does not advertise model-switch; upgrade the host"。 |
| `peer_ask {alias, message?, waitMs?, resume?, requestId?, provider?, model?, chain?, reasoningEffort?, maxTotalTokens?}` | 必要时采纳/创建会话，以带归属的 peer 回合发送提示，带重连与 `peer.page` 修复地跟踪，直到会话真正静默（无活动子代理或询问且静默窗口结束）后返回**最终**回合；否则返回结构化 pending/失败结果。路由选项仅在本调用**创建**会话时生效（此处命名的路由会替换配对固定的 `create` 路由），`maxTotalTokens` 记录该会话的 token 上限；对已绑定的会话这些选项会被拒绝并指向 `peer_switch_model`，而不是被静默丢弃。被跟踪回合进入 `waiting_approval` 时**提前**返回 `status: 'waiting_approval'` 与待决询问（`askId`、`kind`、`toolName`、`reason` 及提问选项）；`resume: <requestId>` 可续跟同一回合直到终态，不会重发消息。主机在跟踪中途停止应答时，在 `probeIntervalMs` 之后返回 `status: 'host_unreachable'`（绝不取消远端回合）。 |
| `peer_asks {alias}` | 主机声明 `durable-asks` 时读取其询问日志，包括 `answered`、`expired` 和 `cancelled` 状态；旧主机只提供即时的待决列表，调用方会发出警告。 |
| `peer_answer {alias, askId, requestId?, outcome \| answers[]}` | 提交一次审批决定（`allowed-once` \| `rejected`）或提问决定（`answers: [{id, selected[], custom?}]`）。以原 ID 重试相同决定可确认先前已处理的应答（`replayed: true`），不会再次投递决定。 |
| `peer_cancel {alias}` | 以调用方身份请求停止。`stopIntent` 区分停止请求与执行观测，`keepInbox: true` 保留排队任务。未收到答复时，即使回合不再运行，也不能断定停止请求已生效。 |

## 配对文件

默认读取 `$DSH_HOME/pairings.yaml` 中的调用方条目：

```yaml
version: 1
device: serverlocal
pairings:
  - alias: co-dev
    peer: laptop                  # device being called
    exposure: debug               # host-role; required by the host parser
    endpoint: https://laptop.pike-acrux.ts.net:8443
    remoteSessionId: sess-xyz     # optional; omit to address the alias (create/adopt)
    outboundToken: null           # optional; plaintext bearer secret sent when dialing endpoint
    tokenHash: null               # host-role inbound credential hash (ignored by caller)
    inboundToken: null            # host-role plaintext inbound credential (ignored by caller)
    insecure: false               # host-role auth opt-out (ignored by caller)
    create:
      cwd: /home/user/projects/thing
      agentPreset: standard
      provider: antigravity            # optional; pins the created session's route
      model: gemini-3.8-flash-tiered   # required with provider
      chain: loopback                  # optional; forwarded only with provider+model
      reasoningEffort: high            # optional; forwarded only with provider+model
```

主机角色字段（`sessionId`、`exposure`）被调用方忽略；条目需要 `alias`、
`peer`、`endpoint` 才可拨号。调用方角色别名命名的是配对本身——按 fleet 约定即
成员设备——在两台设备的文档中是同一字符串，而不是目标主机名。未知别名会列出
各调用方角色别名及其目标设备，例如 `available: pc → serverlocal`。`create` 块会把
会话默认值转发给新建会话；`create.provider` 与 `create.model` 还会固定该会话的
路由（主机以 `persistDefault: false` 应用，不改变部署默认值），两者必须成对出现
——只出现其一会导致文档解析失败——`create.chain` / `create.reasoningEffort` 仅在
成对时转发。插件 Config 字段（`pairingsPath`、`noticesPath`、
`device`、`participantName`、`waitMs`、`settleMs`、`maxReconnects`、
`probeIntervalMs`）均声明为
`.volatile()`，合并后的 settings 服务会将其暴露为实时表单并持久化到 profile
patch。插件配置的 `pairingsPath`（CLI 的 `--pairings`）可指向其他文档，测试因此
不会碰操作者真实的配对文件。

## 远端询问

`peer_ask` 跟踪远端回合期间，待决审批询问会通过 `ctx.approval.request`
在**本地**弹出（携带远端工具名与 `remote ask on <alias>` 原因）；
`allowed-once` / `rejected` 决定以 `peer.answer` 回传。本地审批卡与跟踪生命周期
绑定：若跟踪先结束（回合到达终态、`waitMs` 到期、调用方中止或套接字断开），
待决卡片会被撤回（`cancelled`），远端询问仍可通过 `peer_answer` 应答。询问的
呈现与跟踪循环并发执行（有界在途任务、错误已收敛），因此打开的卡片不会阻塞帧
处理。本地服务不可用时
（无 `approval` 服务、无 agent、无打开的回合）或询问为提问类型时，询问写入
持久通知文件（`<配对目录>/peer-bridge/asks.jsonl`），仍可通过
`peer_answer` / `ds peer answer` 应答。不会自动应答任何询问。

桥接插件发送决定前，会在通知文件旁的 `answer-requests` 目录记录为该询问生成的应答 ID，不保存决定内容。除非显式传入 `requestId`，`peer_answer` 和本地卡片转发会为同一询问和调用方使用同一 ID。未收到答复时，不能断定由谁应答，也不能排除询问已经过期。若要确认是否为重放，请使用原 ID 和相同决定。不要重试已过期的询问，也不要重试主机因工作节点重启而拒绝的询问。

被跟踪回合进入 `waiting_approval` 时不会把调用方拖到 `waitMs`：`peer_ask`
提前返回 `ok: false`、`pending: true`、`status: 'waiting_approval'`、会话 id、
request id 以及结构化的待决询问 `pendingAsks[]`（另含摘要 `asks[]` 行）。
调用方 agent（或非交互车道上的人）用 `peer_asks`/`peer_answer` 逐条决定；
随后再次调用 `peer_ask` 并传 `resume: <requestId>`，即可在不重发消息的情况下
把**同一**回合跟到终态（`resumed: true`、`admitted: false`）。requestId 是
跟踪的因果锚点：开屏快照仍携带原始准入记录（甚至该回合的终态记录）时，结果
会被精确归因到该回合。提前返回会拆除本次跟踪世代，因此同时打开的本地审批卡
会被撤回（`cancelled`），询问仍可通过 `peer_answer` 应答；无询问的长时间停滞
仍受 `waitMs` 约束。

## 跟踪可靠性

`peer_ask` 为提示分配一个 `requestId`，并据此派生单独的 `createRequestId`。若未收到应答，它查询 `peer.receipt` 并报告主机所知的状态，不会重发请求。提示状态可以是 `queued`、`claimed`、`cancelled_before_dispatch`、`terminal` 或 `unknown`；回执缺失或无法读取时，只能报告 `unknown`，不能断定主机从未接收。若要重试，请传回原 `requestId`，并保持消息及创建选项不变；若只想继续跟踪已接收的提示而不重发，请使用 `resume`。不要把凭据放入请求 ID。主机的回执保留量有限，不要假定旧 ID 仍可安全重放。

握手摘要不一致或主机未声明 `peer_ask` 所需的可选能力时，调用方会发出警告。工作节点的就绪检查、任务更新、导出读取以及等待静默观测仅由 CLI 提供，不会为 peer 工具组增加工具或权限。

`peer_ask` 与 `ds peer ask`/`follow` 在首个 `turn/end` 之后，只要仍有子代理、
待决询问或后续回合活动，就会继续跟踪；只有在静默窗口（`settleMs`，默认 2000
毫秒；CLI 的 `--settle-ms`）结束并重读一次 `peer.state` 确认后，才认定会话
静默。记录按 seq 去重，重连快照重放不会重复追加同一段助手文本；较新的回合会
**替换**先前回合的文本。回答按因果归属：只有 `turn/start` 早于我们已采纳的
`user/message` 的回合（及其后续延续回合）才计入结果，因此并发的第三方回合不会被
当作我们的回答返回。我们的回合一旦拿到 terminal，由另一位操作者提示开启的更晚
回合会把结果冻结在我们自己的回合上（`superseded: true`），且 terminal 只携带其
自身回合提交的回答文本。`admitted` 报告宿主已接受提示（`peer.prompt` 返回接受，
或持久的 `user/message`），因此已记录的提示绝不会被报告为未采纳。

主机声明 `bounded-follow` 时，调用方按顺序确认每个已消费的非终止帧。遇到 `gap` 帧或 `peer/gap`，调用方重新打开跟踪并用 `peer.page` 修复历史，不会把缺口当作完成。连续三次修复重试仍未收到新的持久事件时，调用方停止重试。若主机返回 `follow-capacity`，请退避后再重新打开跟踪。

主机在回合中途消失（笔记本休眠、链路中断）时，跟踪套接字仍然静默打开，单凭
静默无法区分"主机已离开"与"模型正在生成"。在无帧达到
`probeIntervalMs`（默认 30000 毫秒；0 关闭）后，`peer_ask` 会发起一次廉价且有
期限的 `peer.state` 调用：只要得到任何应答（哪怕是结构化错误）就继续等待；
只有完全无人应答时才提前结束跟踪并返回 `status: 'host_unreachable'`、会话 id、
最后观测到的 `latch`/`cursor`，并注明远端回合**未被取消**、主机唤醒后可能继续。
可达但静默的回合仍以 `waitMs` 为外层上限。

## 已知限制与后续工作

- `hopCount` 固定发送 0：本桥不跟踪自主交换链（doc 69 §9.3 视其为遥测）。
- 调用方在拨号 `endpoint` 时将 `outboundToken` 作为 `Authorization: Bearer` 发送，且绝不在工具输出或错误中记录或回显它；主机角色字段（`tokenHash`、`inboundToken`、`insecure`、`create.allowAgentPresets`）会被接受并忽略，而有歧义的旧键 `token` 会被拒绝并提示使用 `outboundToken`。若配对设置了 `insecure: true`，须保持对端链路仅限 tailnet/LAN。
- 主机侧 `peer.create` 绑定与主机配对是两件事；本包只读取调用方条目。
- 调用方握手报告已安装的 harness 版本：解析 profile 旁的
  `@deepseek-ai/dsh-api-peer` 清单，或 `$DSH_HOME` 下安装器的
  `harness/install-state.json`；`DSH_PEER_HARNESS_VERSION` 可覆盖，两者都不存在时
  会明确报错（fail closed），不会发送伪造身份。
- 由于 `@deepseek-ai/dsh-api-peer` 不是 profile 依赖，这里保留 peer 客户端副本（`src/peer-client.ts`），须与 `packages/api/peer/src/client.ts` 保持同步。本地应答 ID 文件不会自动清理；主机独立限制日志保留量，因此本地仍有 ID 并不保证可重放。
