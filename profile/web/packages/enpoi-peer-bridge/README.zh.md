# dsh-enpoi-peer-bridge

设备到设备 peer API 的调用方（doc 69 P2、doc 70、doc 27 的"thin bridge"）。
一个 harness 驱动**远端** harness 会话：发送提示、跟踪到终态、读取回答、
应答远端询问、取消远端回合。远端仍使用自己的工具、工作区、审批与模型路由，
本插件从不在远端执行任何东西。

## 工具

| 工具 | 作用 |
|---|---|
| `peer_status {alias}` | 握手（对端身份、能力、协议）+ `peer.state`：暴露级别、目标会话、闩锁状态、子代理数、待决询问、当前模型。 |
| `peer_ask {alias, message, waitMs?}` | 必要时采纳/创建会话，以带归属的 peer 回合发送提示，带重连与 `peer.page` 修复地跟踪，返回回答或结构化终态失败。 |
| `peer_asks {alias}` | 远端待决询问（审批与提问两种）。 |
| `peer_answer {alias, askId, outcome}` | 解决审批询问（`allowed-once` \| `rejected`）。先到先得。 |
| `peer_cancel {alias}` | 取消远端当前回合，归属为本调用方。 |

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
`device`、`participantName`、`waitMs`、`maxReconnects`）均声明为
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

## 已知限制与后续工作

- 提问类询问会展示但暂不可从本桥应答（尚未暴露结构化的
  `AskUserQuestionAnswer` 词表）。
- `hopCount` 固定发送 0：本桥不跟踪自主交换链（doc 69 §9.3 视其为遥测）。
- 主机侧 `peer.create` 绑定与主机配对是两件事；本包只读取调用方条目。
- 因 `@deepseek-ai/dsh-api-peer` 不是 profile 依赖，这里保留一份本地
  peer 客户端副本（`src/peer-client.ts`）；帧协议需与
  `packages/api/peer/src/client.ts` 保持同步。
