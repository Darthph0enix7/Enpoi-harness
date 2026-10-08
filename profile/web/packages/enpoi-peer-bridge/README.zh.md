# dsh-enpoi-peer-bridge

设备到设备 peer API 的调用方（doc 69 P2、doc 70、doc 27 的"thin bridge"）。
一个 harness 驱动**远端** harness 会话：发送提示、跟踪到终态、读取回答、
应答远端询问、取消远端回合。远端仍使用自己的工具、工作区、审批与模型路由，
本插件从不在远端执行任何东西。

## 工具

| 工具 | 作用 |
|---|---|
| `peer_status {alias}` | 握手（对端身份、能力、协议）+ `peer.state`：暴露级别、目标会话、闩锁状态、子代理数、待决询问、当前模型。 |
| `peer_ask {alias, message, waitMs?}` | 必要时采纳/创建会话，以带归属的 peer 回合发送提示，带重连与 `peer.page` 修复地跟踪，直到会话真正静默（无活动子代理或询问且静默窗口结束）后返回**最终**回合；否则返回结构化 pending/失败结果。 |
| `peer_asks {alias}` | 远端待决询问（审批与提问两种）。 |
| `peer_answer {alias, askId, outcome}` | 解决审批询问（`allowed-once` \| `rejected`）。先到先得。传输失败时重读 `peer.state`：询问已消失则报告 `confirmation: 'lost'`，而不是诱使盲目重试的失败。 |
| `peer_cancel {alias}` | 取消远端当前回合，归属为本调用方。传输失败时重读闩锁：无活动回合时报 `confirmation: 'lost'`。 |

## 配对文件

默认读取 `$DSH_HOME/pairings.yaml` 中的调用方条目：

```yaml
version: 1
device: serverlocal
pairings:
  - alias: co-dev
    peer: laptop                  # 被调用的设备
    exposure: debug               # 主机角色；主机解析器要求此字段
    endpoint: https://laptop.pike-acrux.ts.net:8443
    remoteSessionId: sess-xyz     # 可选；省略则按 alias 寻址（创建/采纳）
    token: null                   # 可选；以 Authorization: Bearer 发送
    create:
      cwd: /home/user/projects/thing
      agentPreset: standard
```

主机角色字段（`sessionId`、`exposure`）被调用方忽略；条目需要 `alias`、
`peer`、`endpoint` 才可拨号。插件 Config 字段（`pairingsPath`、`noticesPath`、
`device`、`participantName`、`waitMs`、`settleMs`、`maxReconnects`）均声明为
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
`peer_answer` / `ds peer answer` 应答。`peer/conflict` 表示其他参与者已先行
应答——本插件如实报告，绝不盲目重试。不会自动应答任何询问。

## 跟踪可靠性

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
`peer/not-paired`、`peer/not-found`、`peer/forbidden`、
`peer/version-skew` 错误帧会立即终止跟踪并上报该错误，而不是按退避节奏无限
重连；`peer.page` 无法证明连续的持久化空洞会带 `[from, to)` 范围经警告回调
上报，重放则跨过该空洞继续。

## 已知限制与后续工作

- 提问类询问会展示但暂不可从本桥应答（尚未暴露结构化的
  `AskUserQuestionAnswer` 词表）。
- `hopCount` 固定发送 0：本桥不跟踪自主交换链（doc 69 §9.3 视其为遥测）。
- 主机侧 `peer.create` 绑定与主机配对是两件事；本包只读取调用方条目。
- 因 `@deepseek-ai/dsh-api-peer` 不是 profile 依赖，这里保留一份本地
  peer 客户端副本（`src/peer-client.ts`）；帧协议需与
  `packages/api/peer/src/client.ts` 保持同步。本地副本额外在调用方终态错误帧上
  终止、对已接受的修复空洞发出警告，并在 `src/index.ts` 中先结算再返回；
  harness 客户端目前仍对除版本偏差外的错误一律重试。
