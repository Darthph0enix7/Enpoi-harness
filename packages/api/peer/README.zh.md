---
description: "设备到设备 peer API：带鉴权的窄服务命名空间、配对存储、执行闩锁、提问注册表，以及调用方桥接。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-peer

[English](README.md) | 中文

## 概述

可选的设备到设备 peer API（doc 69 P2，契约见 `dsh-migration/70-peer-api-contract.md`）。一台主机通过小型 `peer` 命名空间（`handshake`、`list`、`create`、`prompt`、`receipt`、`follow`、`page`、`cancel`、`answer`、`state`、`models`、`selectModel`）暴露已配对的会话，另一台设备通过 `PeerClient` 驱动它们。服务面在构造上就是窄的：每个调用先根据 `~/.dsh/pairings.yaml` 校验 `Authorization: Bearer` 请求头，经配对门解析后映射到封闭派发表背后的 `session.*`，因此绝不会重新暴露 `settings.*`、`credentials.*`、`fs.*` 或 `control.*`。未配置入站凭据的配对会作为未鉴权兼容条目加载（入站被拒绝，每个别名记录一次警告），除非显式声明 `insecure: true`。

## 目录

- [使用本包](#use-this-package)
- [配对文件](#pairing-file)
- [主机服务面](#host-surface)
- [调用方桥接](#caller-bridge)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已经运行 Session Controller 的主机上挂载 `PeerService`；它会注册 `peer` Typert 命名空间，在配对文档格式错误时立即失败，并安装让 peer 回答与本地回答链竞争的提问注册表。随包发布的 bundle 以 `peer-api` 行挂载本包；覆盖层必须针对该行做**按 id 的配置覆盖**——用 `insert` 会重复注册 `peerService` 并导致整次加载失败（`tests/peer.overlay.yml`）：

```yaml
- id: peer-api
  name: '@deepseek-ai/dsh-api-peer'
  config:
    pairingsPath: !!js dshHomePath('pairings.yaml')   # default
    bindingsPath: !!js dshHomePath('peer-state.json') # default
    watchdogMs: 900000                                # default 15 min
```

配置项：`pairingsPath`、`bindingsPath`、`watchdogMs`、`harnessVersion`、`schemaDigest`、`receiptsPath`（默认 `~/.dsh/peer-receipts.json`）、`receiptLimit`（默认 512）、`inputReceiptsPath`（默认 `~/.dsh/peer-input-receipts.json`，或在配置了 `bindingsPath` 时位于其同级目录）、`inputReceiptLimit`（默认 1024）、`inputReceiptMaxBytes`（默认 1 MiB）、`requestIdMaxLength`（默认 256）、`modelsLimit`（默认 100）与 `modelsLimitMax`（默认 500）。 `harnessVersion` 默认取运行中包清单的版本（即插件兼容性读取的运行时版本），而不是字面量；`schemaDigest` 默认取 `PEER_SCHEMA_DIGEST`；两者在握手中都只是提示值。

<a id="pairing-file"></a>
## 配对文件

`~/.dsh/pairings.yaml`（0600）由人工编辑并接受严格校验；格式错误的文档会让主机加载失败。每个条目都必须声明 exposure——不存在隐式的 `debug`。

```yaml
version: 1
device: serverlocal
watchdogMs: 900000
pairings:
  - alias: co-dev
    peer: laptop
    exposure: debug           # answer-only | debug
    sessionId: sess-abc       # this host's session peers may address
    create:                   # present ⇒ peer.create may create/adopt under this alias; fields act as limits
      cwd: /home/user/projects/thing
      agentPreset: sysadmin
      allowAgentPresets: [sysadmin, orchestrator]
    remoteSessionId: sess-xyz # caller-role bookkeeping
    endpoint: https://laptop.pike-acrux.ts.net:8443
    tokenHash: scrypt$...     # inbound credential (or `inboundToken` hashed with scrypt at load, never retained); or `insecure: true`
    outboundToken: ...        # optional plaintext bearer this host sends when dialing `endpoint`; never logged or echoed
    runawayCeiling: null      # optional emergency hop cap; null = unbounded; inert for the shipped callers, which send hopCount 0 (doc 70 §12)
    allowModelChange: false   # default false (doc 69 §10); ignored when `routing` is present
    routing:                  # optional remote model-selection policy; authoritative when present
      allowChains: [free]
      allowModels: ["kilo/*:free", "openrouter/*:free"]
      requireZeroPrice: true
      requireNoTraining: false
      requireTools: true
      allowReasoningEfforts: [minimal, medium]
      allowSwitch: idle-only  # never (default) | idle-only
      maxTotalTokens: 5000
```

入站与出站凭据是各自独立的可选字段：`tokenHash`（`scrypt$<salt>$<hash>` 或 `sha256$<hex>`）或 `inboundToken`（加载时以 scrypt 哈希，绝不在 `PeerPairing` 上保留明文或写入日志）约束本主机对入站调用方的验证；`outboundToken` 是本主机作为调用方拨号 `endpoint` 时发送的明文 bearer（绝不写入日志，也绝不在 `handshake`/`list`/`state` 中回显，若 `pairings.yaml` 具备组/全局可读权限则在加载时发出一次警告）。`inboundToken` 与 `tokenHash` 并存、`insecure: true` 与入站凭据并存，或使用歧义旧键 `token`，都会使加载抛出 `PeerConfigError`。既无入站凭据又无 `insecure: true` 的条目作为未鉴权兼容条目加载：主机对每个此类别名发出一次指明 `tokenHash`/`inboundToken`/`insecure: true` 的警告、统一拒绝针对该别名的所有入站请求，同时保留 `endpoint`/`outboundToken` 出站调用可用。每个 `peer.*` 方法在执行任何业务逻辑前，都会对已解析配对以常量时间校验请求中的 `Authorization: Bearer` 令牌，将 `pairing.peer` 绑定为上下文与参与者归属上的已认证设备，并对缺失或错误的令牌、设备不匹配、未鉴权兼容条目以及未知目标统一返回 `peer/forbidden`（`reason: 'unauthorized'`），避免暴露别名是否存在。HTTP `/api/peer/*` 调用通过 `connection/request` waterfall 传递请求头，WebSocket `/api/remote.mux` 调用从升级请求的 `Authorization` 头传递，进程内调用方通过 `withPeerAuth` 传递。

离线生成 `tokenHash` 可运行 `node -e "import('./packages/api/peer/src/pairings.ts').then(m => console.log(m.hashPairingToken(process.argv[1])))" <secret>`（源码下运行可使用 `npx tsx`）。

`create.*` 字段在新建与领养时均作为上限约束：`request.workspaceId` 必须等于 `create.workspaceId`（`workspace-not-allowed`），`request.cwd` 必须在解析符号链接后规范地位于或等于 `create.cwd`（`cwd-not-allowed`），`request.agentPreset` 必须等于 `create.agentPreset` 或属于 `create.allowAgentPresets`（`preset-not-allowed`）。通过 `peer.create`（`sessionId`）进行的领养只允许领养已绑定到同一别名或由该别名创建的会话（`session-adoption`）。

`routing` 接受严格解析：未知键、类型错误、空模式，或落在 `[A-Za-z0-9._:/@*+-]` 之外的模式都会让主机加载失败，因为被静默忽略的成本防护会扩大配对控制方可选的范围。`allowModels` 模式匹配 `provider/model`，`*` 是唯一通配符（可覆盖任意字符序列，包括 `/`，两端锚定）；`allowChains` 条目是精确的链 id。在带 `routing` 的配对下，新建或采纳必须指定路由——`provider`+`model`，或单独的 `chain`——且主机应用路由服务解析出的 `selection`，绝不应用原始请求。仅指定链的请求由路由服务解析，目录、链注册表和路由健康状态都归该服务所有。未挂载 `peerRouting` 服务时，每个路由请求都以 `peer/forbidden`、reason `routing-unavailable` 失败关闭，握手也不再宣告 `model-discovery`、`model-routing-at-create` 与 `model-switch`。

`peer.create` 绑定持久化在 `~/.dsh/peer-state.json`（0600，带版本，原子替换）；替换别名绑定的 `create` 会把先前的会话移入该绑定的 `retired` 列表，因此被重新绑定的别名解析到最新会话，而被替换的会话仍可通过显式 `sessionId` 访问。每个绑定还记录该会话的 `maxTotalTokens` 上限（请求值，或被策略值封顶）；`PeerService.ceilingOf(sessionId)` 读取它，包括已被后续 create 退役的会话。主机从不改写配对文件。

<a id="host-surface"></a>
## 主机服务面

### Worker 会话

`create.freshOnly: true` 要求调用方生成 `requestId`，拒绝调用方提供的任何 `sessionId`，且不接管现有会话。与保留的回执完全匹配时可以重放同一个会话。如果预写回执不足以确定归属，主机会拒绝，而不是猜测。这些配置只接受已声明的键。

配对的可选 `worker` 块接受 `allowedCapabilities`、`allowedMcpEndpoints`、`allowedToolNames` 和 `maxLimits`（`maxSteps`、`maxToolCalls`、`maxWallMs`、`maxTotalTokens`）。它要求别名支持创建、未固定到会话，并使用仅新建模式和 bearer 鉴权。创建 worker 时必须提供 `job`：`{jobId, fence, expiresAt, capabilities, limits, mcpEndpointId?, credentialRef?, allowedToolNames?}`。围栏值、时间戳与上限必须是正的安全整数。过期时间以 Unix 纪元毫秒计，必须在将来且不超过 `jobMaxTtlMs`。超出策略的请求会被拒绝，而非静默截断；省略的作业上限和工具继承配置中的上限和允许的工具，未配置工具时则为空列表。`credentialRef` 仅为引用名称，不得是令牌、URL 或其他凭据值。主机不解析该引用。创建回执对作业载荷（含引用名称）计算哈希，但不存储载荷。

- `peer.ready({alias})` 返回 `{ready, missing, capabilities, profile?, instanceId, version}`。别名未绑定时，就绪检查只检查依赖，不验证尚未创建的组合。对于已绑定的 worker，主机还会尝试验证配置档身份。调度前应将 `peer.create` 返回的配置档（`{hash, presetId}`）与预期组合比对；身份服务缺失或失败时，创建请求返回 `peer/unavailable` / `profile-identity-unavailable`。
- `peer.jobUpdate({alias, requestId, jobId, fence?, expiresAt?, revoked?})` 返回 `{accepted, binding, replayed, payloadHash, instanceId}`。替换的围栏值必须增大；新的过期时间必须满足同样的 TTL 规则；`revoked: true` 不可撤销。绑定和更新回执一同提交。完全相同的重试即使发生在后续修改之后，也只返回原始结果，不会再次执行更新。`peer.receipt` 仍仅用于创建和提示。
- `peer.exportList({alias})` 返回 `{files: [{path, bytes, mtimeMs}], truncated}`。`peer.exportFetch({alias, path, maxBytes?})` 返回 `{path, bytes, sha256, contentBase64}`。两者均要求别名对应有效作业绑定。主机以 `0700` 创建 `<exportRoot>/<sessionId>`，只接受其中的 POSIX 相对路径。读取拒绝符号链接、不安全路径、非普通文件、大小变化和超限文件。中枢仍必须独立校验解码后的字节、哈希和作业验收条件；不要将列表视为快照。

主机宣告 `ready`、规范的 `shape-digest`（`schemaDigest` 覆盖方法名和线上字段，`methodsDigest` 仅对方法名计算哈希）、创建回执存储成功打开时的 `fresh-only-create`、两个存储都打开时的 `job-binding`、身份服务挂载后的 `profile-identity`，以及绑定存储和导出根目录均可用时的 `export-root`。若自定义 `schemaDigest` 覆盖值不同于规范摘要，则不宣告 `shape-digest`。

Worker 配置：`jobBindingsPath`（默认位于输入回执旁的 `peer-job-bindings.json`）、`jobBindingLimit`（1024）、`jobBindingMaxBytes`（1 MiB）、`jobIdMaxLength` 与 `jobIdentifierMaxLength`（各 128）、`jobMaxTtlMs`（24 小时）、`jobCapabilitiesMax`（64）、`jobToolsMax`（256）、`exportRoot`（peer 状态文件旁的 `peer-exports`）、`exportListMaxFiles`（256）、`exportListMaxBytes`（256 KiB）、`exportListMaxScannedEntries` 与 `exportPathMaxBytes`（各 4096），以及 `exportFetchMaxBytes`（8 MiB）。权限为 0600 的作业存储保留已过期和已撤销的记录；达到容量时拒绝新绑定，而不丢弃现有限制。

提问与停止配置：`asksPath`（输入回执旁的 `peer-asks.json`）、`askLimit`（256 条）、`askMaxBytes`（日志总计 1 MiB）、`askRecordMaxBytes`（每条待处理记录 16 KiB）、`waitQuiescentMaxMs`（10,000 毫秒）和 `waitQuiescentPollMs`（100 毫秒）。日志以 0600 权限原子替换，先淘汰最早结算的记录，绝不淘汰待处理提问。无法容纳或写入的提问仅在本地处理。日志打开失败时不宣告 `answer-routing`、`durable-asks` 和 `ask-idempotent-answer`。

跟随配置：`followQueueMaxItems`（16,384 条）、`followQueueMaxBytes`（序列化 peer 数据 8 MiB）、`followOpenMs`（10,000 毫秒）、`followIdleMs`（30,000 毫秒）、`followLifetimeMs`（900,000 毫秒）、`followMaxPerAlias`（2）、`followMaxPerHost`（16）、`followOpensPerWindow`（12）和 `followOpenWindowMs`（30,000 毫秒）。这些限制约束 peer 流世代；Session Controller 的上游积压独立限制为默认 16,384 条 / 8 MiB，Gateway 则另行限制套接字写入。peer 队列同时计入待发送和待确认的帧；丢失发生时，队列由一个小型缺口控制帧替代。

`stop-intent` 和 `wait-quiescent` 宣告停止观察能力；`bounded-follow` 和 `follow-gap-frames` 宣告逻辑流的限制和恢复帧。调用方不得假定未宣告的能力可用。

- `peer.handshake` 先进行鉴权，校验 `request.device` 与已授权配对的 `pairing.peer` 一致，协商协议、schema 与能力，报告每次启动新生成的 `instanceId`，并仅返回对该设备已授权的配对（绝不携带 token 或哈希）；协议不匹配返回 `peer/version-skew`。`create-receipts`、`prompt-receipts` 与 `input-disposition` 仅在主机启动时 `peer-input-receipts.json` 成功打开后才宣告。
- `peer.list` 发现已授权配对：不带目标时仅列出匹配当前凭据（或 `insecure: true`）的配对；带目标时先通过同一配对门禁鉴权与解析（鉴权失败或未知会话返回 `peer/forbidden` `unauthorized`，已鉴权但未绑定的别名返回 `peer/not-paired`）。
- `peer.state` 返回执行闩锁（`running | waiting_approval | waiting_subagents | idle`）、`activeDescendants`、待处理提问、当前模型选择、`lastParticipantAction` 与游标。当 `session.executionState` 调用有应答时，它读取主机的闩锁（`source: 'host-latch'`，包含静默子代理）；否则从 `turn/*`、`approval/*`、`subagent/catalog`、结算通知和提问注册表推导闩锁（`source: 'derived'`）。
- `peer.follow` 流式发送开场快照、按 exposure 过滤的持久事件和闩锁迁移；提问的铸造或结算还会推送一个 `state` 帧（变更键只包含每个待处理提问的 `(askId, kind, since)`），因此工具调用中途的提问无需等待下一个持久事件即可出现；`cursor` 是修复的权威位置，因为 `answer-only` 会过滤记录。
- `peer.prompt` 始终排队（人类优先）；`hopCount` 只是遥测，只有配置了 `runawayCeiling` 时才强制执行上限。在入队前，主机先向 `peer-input-receipts.json`（0600，原子写入，受 `inputReceiptLimit` 与 `inputReceiptMaxBytes` 约束）写入一条 `'prepared'` 预写回执，仅记录 `(sessionId, content)` 的 SHA-256 哈希与 `instanceId`（绝不记录提示词正文），并在 `sessionController.prompt` 提交后定稿。预写持久化失败会在任何提示词进入收件箱前以 `peer/unavailable` 拒绝；相同重试以 `replayed: true` 与当前处置重放；同一 `requestId` 搭配变更载荷以 `peer/conflict`（`reason: 'request-id-reuse'`）拒绝。
- `peer.receipt` 统一鉴权（凭据错误或未知别名返回 `peer/forbidden` `unauthorized`），在 `peer-input-receipts.json` 中查询 `(alias, requestId, kind?)`，返回 `{ found, kind?, sessionId?, payloadHash?, instanceId?, phase?, replayedAcrossRestart, disposition, terminalState?, terminal?, acceptedAt?, finalizedAt? }`。提示词的处置（`queued`、`claimed`、`cancelled_before_dispatch`、带 `terminalState` `completed | aborted | failed | budget | blocked | max-tokens | interrupted` 的 `terminal`，或 `unknown`）由宿主端直接从原始会话日志（`agent/inbox/spliced`、`turn/start`、`user/message`、`turn/end`）推导而不经过暴露过滤，因此在 `answer-only` 下同样可用。
- `peer.asks` 按别名和会话查询待处理提问及保留的结算；`peer.answer` 要求与载荷绑定的 `requestId`，并在交付前记录获胜的决定。
- `peer.cancel` 请求停止，并返回 `stopIntent` 和 `droppedQueued`，后者是该别名下实际移除的待处理提示词数。公布 `cancel-drop-queued` 能力的主机接受 `dropQueued`；`worker` 配对默认取 `true`，其他配对默认取 `false`。`peer.waitQuiescent` 轮询得到的是观察结果，而非彻底停止的证明。参见 [peer 语义](../../../docs/subsystems/peer.zh.md)。
- `peer.create` 强制执行 `create.*` 范围上限，将 `sessionId` 领养限制在同一别名内，并在任何会话或选择存在之前就应用策略评估出的路由，因此拒绝不会留下会话；没有 `routing` 的配对在采纳时仍沿用旧的 `allowModelChange` 门禁。提供可选 `requestId`（受 `requestIdMaxLength` 限制）时，若省略 `sessionId`，`peer.create` 会从 `(alias, requestId)` 推导确定性的 `peer-<hex>` 会话 id，在创建或领养前先写入载荷绑定的预写回执，相同重试以 `replayed: true` 重放，变更载荷以 `peer/conflict`（`reason: 'request-id-reuse'`）拒绝，回执持久化失败则在副作用前以 `peer/unavailable` 拒绝。未带 `requestId` 的 `peer.create` 保持非幂等随机创建，因此 Jarvis 等控制方必须发送 `requestId`。高于策略上限的 `maxTotalTokens` 以 reason `budget` 拒绝；省略的值会被封顶到策略值。无法读取 token 用量的主机会以 reason `budget-unmetered` 拒绝任何会携带上限的 create，且发生在任何会话存在之前。
- `peer.models` 返回某个别名经策略过滤的链与模型，外加 `selectableByThisAlias`——回显策略，让控制方看到自己实际能选什么。分页上限由 `modelsLimit`/`modelsLimitMax` 收窄；凭据、URL 和提供方错误文本都不会跨线传输。
- `peer.selectModel` 切换某个空闲会话下一回合的路由（`persistDefault: false`）。运行中或等待中的会话返回 `peer/conflict`、`reason: 'busy'` 并携带闩锁；冷会话只在其 agent 未运行时才视为空闲。拒绝以 `peer/forbidden` 返回策略的 `reason` 和被拒绝的标识符。重试按 `requestId` 加上规范化载荷的 SHA-256 保持幂等；同一 id 搭配不同载荷返回 `peer/conflict`、reason `request-id-reuse`。当 `receipts.put()` 失败时，主机记录警告并返回 `receiptPersisted: false`；当重启后的重试缺少持久化回执且会话当前生效的选择已与 `verdict.selection` 一致时，主机跳过 `sessionController.selectModel` 以避免追加重复的选择事件。

### 拒绝原因表

| 错误码 | `details.reason` | 触发条件 |
|---|---|---|
| `peer/forbidden` | `unauthorized` | 缺少/格式错误/不匹配的 bearer 令牌，未鉴权或未授权调用下的未知别名/会话，或握手/参与者设备不匹配。 |
| `peer/forbidden` | `session-adoption` | `peer.create` 试图领养未绑定到该别名或非该别名创建的既有/其他别名 `sessionId`。 |
| `peer/forbidden` | `workspace-not-allowed` | `peer.create` 的 `workspaceId` 与配对固定的 `create.workspaceId` 不一致。 |
| `peer/forbidden` | `cwd-not-allowed` | `peer.create` 的 `cwd` 解析后超出配对固定的 `create.cwd`（含 `..` 与符号链接逃逸）。 |
| `peer/forbidden` | `preset-not-allowed` | `peer.create` 的 `agentPreset` 不等于 `create.agentPreset` 或不在 `create.allowAgentPresets` 中。 |
| `peer/forbidden` | `model-change` | 领养时的 `peer.create` 在无路由策略的配对上请求更改路由，但未开启 `allowModelChange: true`。 |
| `peer/forbidden` | `routing-required`、`routing-not-configured`、`routing-unavailable`、`switch-not-allowed` | 策略配对缺少 create 路由、`models`/`selectModel` 缺少 `routing` 块、`peerRouting` 缺失或失败，或 `allowSwitch !== 'idle-only'`。 |
| `peer/forbidden` | `exposure` | `peer.follow` 在 `answer-only` 暴露下请求 `assistantStream: true`。 |
| `peer/forbidden` | `budget`、`budget-unmetered` | token 上限已达（`create` 或 `prompt`），或主机缺少 `tokenUsage` 投影。 |
| `peer/forbidden` | `approval-outcome` | `peer.answer` 收到 `allowed-once` / `rejected` 之外的审批结果。 |
| `peer/forbidden` | `ask-session-mismatch` | `peer.answer` 针对的待处理提问属于另一个会话。 |
| `peer/forbidden` | `chain-not-allowed`、`model-not-allowed`、`price-unproven`、`training-unproven`、`tools-unproven`、`effort-not-allowed`、`unknown-route` | 路由策略判定拒绝（`details.denied` 给出被拒绝的路由或链）。 |
| `peer/conflict` | `busy`、`request-id-reuse` | 对运行中/等待中的会话调用 `peer.selectModel`，或 `peer.create`/`peer.prompt`/`peer.selectModel` 复用 `requestId` 但载荷不同。 |
| `peer/unavailable` | `receipt-store-unavailable`、`receipt-write-failed`、`receipt-finalize-failed` | 输入回执存储启动打开失败，或带 key 的 `peer.create`、`peer.prompt`、`peer.receipt` 在预写或定稿落盘时失败。 |

### 模型归属与用量

`peer.state` 与 `peer.follow` 报告到底是哪条路由回答了一个回合。`lastTurnEnd.ran` 携带 `{ provider, model, chain?, hops, usage? }`，由持久化的 `assistant/message` 的 `message.source`（回答链路）以及该回合 `turn/start`…`turn/end` 窗口内的 `llm/attempt-failed` 记录折叠而来。`hops` 统计窗口内观察到的失败尝试次数；`usage` 是回答消息自身的四桶采样，前提是适配器报告过。`state.model` 仍是 Session 当前的选择（下一个请求被配置为运行的路由），因此滚动链会让它与 `lastTurnEnd.ran` 不同。

每条持久化的 `llm/attempt-failed` 还会在源事件的持久 `seq` 位置、在两种 exposure 下各生成一条合成的 `model-hop` 记录（`{ from, to?, reason: 'rate-limit' | 'error' | 'cooldown' | 'unavailable', chain?, at }`）。它绝不携带提供方的 `message`、`status` 或 `requestId`，因为提供方文字可能包含请求内容和 URL；`debug` 还会像以前一样保留原始的 `llm/attempt-failed` 记录。原因映射是封闭的：`RATE_LIMIT` 与 `PROVIDER_POOL_EXHAUSTED` 回答 `rate-limit`；凭据、授权、配额和路由能力类错误码回答 `unavailable`；其余一律回答 `error`。目前还没有表示“跳过冷却中路由”的持久错误码，因此 `cooldown` 暂时保留。`state.recentModelHops` 携带折叠窗口中最新的 32 次跳转（`RECENT_MODEL_HOPS_LIMIT`），最旧在前；更旧的跳转仍可通过 `peer.follow` 与 `peer.page` 作为流记录获取。

`state.usage` 把持久化的 `tokenUsage` 投影映射到同样的四个桶（`inputTokens` 是其未缓存输入桶；缓存读取与写入各占一桶）。harness 不携带任何计费数据，因此绝不报告成本。只有在已知 token 上限时才出现 `state.budget`（`{ maxTotalTokens, usedTokens, exceeded, metered }`，其中 `usedTokens` 是四桶之和）。`metered` 仅当本会话确实读取了 `tokenUsage` 投影时为 true；有上限但用量不可读时，主机报告 `{ usedTokens: 0, exceeded: false, metered: false }`，而不是声称上限正在执行。只有主机监视器停止的回合，`lastTurnEnd.stop` 才为 `'budget'`。

### Token 上限执行

主机执行绑定记录的上限。随插件注册的监视器监听每条持久化的 `assistant/message` 与 `turn/end`；没有绑定上限的会话只付出一次内存查找，别无其他开销。对设了上限的会话，监视器读取持久化的 `tokenUsage` 投影，每个会话最多同时进行一次观测（读取期间到达的事件折叠为一次尾随复查）；当四桶总量达到上限且 Agent 仍在运行时，它通过 Agent 的取消、以持久化的 hook 原因 `{ kind: 'hook', reason: 'peer/budget' }` 停止该回合一次，保留排队中的收件箱工作，并记录一行有界日志。该原因已存在于会话格式中，因此该标记不需要 `SESSION_FORMAT_VERSION` 升级。跨越上限的请求总会先完成：投影只在其 Assistant 消息提交时前进，因此停止落在其后的动作上，终止状态报告 `stop: 'budget'`。该标记取自持久化记录而非当前预算采样，因此能经受主机重启；人类或 peer 的停止记录 `user` 取消原因，即使会话超预算也绝不会被标记。同一回合内重复事件绝不会发出第二次停止；会话仍超预算时启动的后续回合（例如结算或目标续跑触发的自主唤醒）会在它自己的首条 Assistant 消息后再次被停止，从而把超额限制为每回合一个请求。

一旦预算超限，`peer.prompt` 会拒绝新的对端花费：在提示到达 Session Controller 之前，它返回 `peer/forbidden`、reason `budget`，并以配置的上限作为 `denied`。`peer.answer` 与 `peer.cancel` 仍然允许，因为它们不产生新花费且属于停止控制；回答待决询问可能恢复回合，监视器会在下一次响应后再次停止它。上限统计投影的四个桶，绝不统计成本，因此在某次响应与其提交之间读取 `budget` 的调用方可能看到落后一次响应的采样。create 请求的 `maxTotalTokens` 会被裁剪到配对策略的上限（省略时取策略值），绑定的记录值正是监视器与提示门共同执行的值。

实测指引（2026-11-17 无密钥沙箱自测）：一次使用工具的 orchestrator 回合约消耗 13–17k 输入 token，其中工具 schema 占主导，因此低于约 40k 的上限可能被单个回合跨越。由于跨越上限的请求总会先完成，停止会落在那条回答交付之后（已交付的回合携带 `stop: 'budget'`）；20k 上限观察到正是如此。首个短回合至少预留约 40k，之后每个回合再预留约 13–17k。回合中途的 `peer.cancel` 标记为 `user`，绝不是 `budget`，与上面的持久化标记规则一致。

### 实测目录事实（2026-11-17 无密钥沙箱自测）

在随附沙箱目录中，`free` 链解析出 13 个成员，`peer.models` 返回 14 条经策略过滤的行，全部为零价格且未 gated。全部 14 条都报告 `trainsOnData: 'yes'`，因此 `requireNoTraining: true` 会拒绝整个免费组；所有计价 Kilo 行都是 gated，所以在该目录上 `price-unproven` 只能由引擎单元测试证明。一次链回合中的真实 429 表现为单条 `model-hop` 记录，在 `answer-only` 暴露下没有原始失败事件或提供方文本。以上是一次无密钥沙箱运行的观察，不是对另一份目录的保证。

<a id="caller-bridge"></a>
## 调用方桥接

`PeerClient`（或 `./client` 导出）使用单次调用信封通信，通过 WS mux 打开 `peer.follow`，以指数退避重连，通过 `peer.page` 修复持久空洞，并返回 `peer/target-unreachable` 而不是无限重试。调用方通过 `outboundToken`（或 `token` / `headers` 中的 `Authorization: Bearer`）传递配对 bearer 凭据，回环调用方还通过 `headers` 与接收 `(url, headers)` 的 `webSocket` 工厂传递启动令牌 cookie。

<a id="model-experience"></a>
## 模型体验

### peer 发起的回合

#### 模型看到的内容

一个 `peer.prompt` 以普通且带归属的 `user/message` 进入目标会话；主机不注入任何提示文本，peer 流、闩锁帧和提问流量也从不进入模型请求。

#### Token 影响

一个被接纳的 peer 提示词消耗其消息内容加上会话正常的请求信封。被采纳的会话保持其路由，除非 `allowModelChange` 允许更换模型，或配对的 `routing` 策略授权该切换。`peer.selectModel` 的变更只作用于下一个请求，且绝不会移动部署默认模型。

#### KV Cache 影响

peer 提示词在正常的用户回合边界追加，并保留可复用前缀；通过 `peer.create` 更换模型会改变路由，因而改变缓存标识。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- **作业绑定记录作用域，不提供隔离。** 只有挂载的执行组件才会实施相应预算。Peer 的 token 上限是响应式的，每个回合可能超出一个正在进行的模型请求，并不提供预防式 token 上限或硬性费用上限。步骤数、工具调用数和运行时间需要 worker 执行防护；文件根目录、子进程隔离和网络出站需要外部监督器。不要仅凭 `ready` 启用调度。

- **peer 归属只对 prompt 和 cancel 持久。** `peer.prompt` 把 peer 标签写入目标 `user/message` 的 source，`peer.cancel` 写入中止原因，因此主机闩锁会报告它们；`peer.create` 与 `peer.answer` 只能通过 `peer.state`/`peer.follow` 看到。`peer.selectModel` 记录一条进程内的 `model-change` 动作，带执行者与 `provider/model`；它不持久，因为 Session Controller 的 `model/selection` 载荷不携带参与者，扩展该持久载荷需要格式迁移。
- **切换与其回执不是同一个事务。** `peer.selectModel` 先追加选择，再写幂等回执。当 `receipts.put()` 失败时，主机记录警告并返回 `receiptPersisted: false`，让调用方知道跨重启的幂等性未能持久化。保留在磁盘上的回执会在空闲检查前重放，绝不会用旧选择覆盖更新的选择；当重启后的重试缺少持久化回执且会话当前生效的选择已与 `verdict.selection` 一致时，主机跳过 `sessionController.selectModel`，不过若未持久化或被淘汰之后又有其他切换把会话改到另一条路由，由于 `model/selection` 不携带 `requestId`，主机无法将过时的重试与新请求区分开。
- **路由三件套需要已挂载的服务。** `model-discovery`、`model-routing-at-create` 与 `model-switch` 只在 `peerRouting` 存在时宣告；握手每次调用都重新计算能力，因此账本仍是构建级事实，而宣告保持部署准确。
- **上限执行需要用量接缝。** 仅在 token meter（`tokenUsage` 投影的注册者）挂载时才宣告 `token-ceiling`；在缺少它的主机上，任何会携带上限的 create 都会在任何会话存在前以 `peer/forbidden`、reason `budget-unmetered` 拒绝。执行是响应式的，而非预防式的：主机在达到 `maxTotalTokens` 的那次响应提交之后才停止会话，已经进行中的请求绝不会在流中途被中止。若超预算响应提交时 Agent 未在运行，则没有可停止的对象；预算仍然耗尽时重新进入的回合会在又一次响应后被停止。在重启后进入无计量主机时仍存在的旧绑定会回答 `budget.metered: false`，此时提示门与监视器都会放行而不是猜测。
- **未带 `requestId` 的 `peer.create` 仍保持非幂等。** Jarvis 等控制方必须在 `peer.create` 上发送 `requestId` 以获取确定性会话 id 与载荷绑定的重放；未带 `requestId` 时，响应丢失后的重试会创建另一个会话并移动别名绑定（被退役的会话仍可通过显式 `sessionId` 寻址）。
- **`peer.selectModel` 的重放先查回执、后查空闲。** 同 id、同载荷的重试即使会话随后已开始运行，也会返回原始值并带 `replayed: true`；权威是回执，而不是当前闩锁。
- **预写 `'prepared'` 回执在核对前报告 `'unknown'`。** 在写入 `'prepared'` 输入回执与完成 `sessionController.create`/`prompt` 之间发生宿主崩溃时，`peer-input-receipts.json` 中会留下 `'prepared'` 条目；若会话或日志尚无证据（或日志不可读），`peer.receipt` 会诚实报告 `'unknown'`，并在副作用已提交时从会话存储/日志核对出真实状态。与 `peer.selectModel`（返回 `receiptPersisted: false`）不同，带 `requestId` 的 `peer.create` 与 `peer.prompt` 在回执无法持久化时会在副作用发生前以 `peer/unavailable` 拒绝。
- **从队列移除提示词需要持久化的别名归属。** 对于没有按别名限定的 `source.rpcId` 的旧提示词，即使仍可读取其回执，`peer.cancel` 也会保留它们。本地操作员可以从队列移除这些提示词。
- **`allowModels` 为空时 `peer.models.models` 为空。** `models` 是固定路由投影；`allowModels` 缺失或为空时，即使 `chains` 有就绪成员，它也是空的，因此请读取 `chains[].members` 获取链可选集合。
- **`allowModels` 也会收窄所选链的每个成员。** 选择链不是绕过：每个解析出的成员都必须像固定路由一样满足 `allowModels`、`requireZeroPrice`、`requireNoTraining`、`requireTools` 与 `allowReasoningEfforts`。
- **跟随限制终止逻辑流，而非任意共享的 Gateway 套接字。** `PeerClient` 在失败时关闭专用套接字，并实施自己的打开、空闲、寿命、条数及字节上限。服务器无法确保不读取的套接字收到缺口帧；直接接入的调用方须在终帧缺失或载体失败时重新同步，而非判定完成。
- **持久化提问不会保留等待回答的回调。** 重启会让待处理记录过期，不会恢复原回合。若在记录获胜决定之后、交付之前崩溃，决定仍可回放，但没有证据表明原回合收到了回答。保留容量有限，淘汰的回答无法回放。
- **exposure 只按配对生效**（按会话覆盖已被裁掉），debug 读取面仍属 P3：不暴露请求快照和诊断信息。
- **SRC 派发。** 该命名空间基于 `@Remote` SRC 标记运行；生成的严格 Typert 面（`./typert`/`./remote`）尚未发布。
- **已结算的提问只广播，绝不保持可回答。** 任何结算——本地客户端、peer 回答、有界等待或取消——都会中止该提问的派发信号，因此转发事件网关会为每个已连接客户端取消该待处理提问，并停止向之后接入的客户端重放。当 follow 的下一个 `state` 帧不再包含该提问时，profile 的 peer 桥接会撤回本地已展示的卡片。
- **`peer.create` 会把更深的失败映射进 peer 词汇。** Session Controller 或 preset 注册表抛出的创建/采纳/路由失败（`agent-preset/not-found`、`session/model-unavailable` 等）会变成 `peer/not-found`，原始错误码保留在 `details.reason` 与 cause 中；peer 域错误和 `gateway/bad-request` 原样透传。
- **`peer.create` 的路由** 走 `session.selectModel` 且 `persistDefault: false`，因此 peer 创建的 Session 被路由时不改写部署默认模型（doc 70 §6，doc 72 G6）。
- **别名在每台主机上唯一。** 线上 `PeerTarget` 不携带 peer 判别字段，因此配对加载器拒绝跨 peer 重复的别名，避免某台设备的 `create` 劫持另一台设备绑定的会话（doc 72 G8）。
- **跳转按日志位置关联。** `llm/attempt-failed` 记录不携带回合 id，因此折叠会把它归给当前打开的回合。同一窗口内来自另一发射方的尝试（例如父级压缩请求）可能被计入该回合。agent-loop 的步骤重试完全没有跳转记录：在 `request/header` reason `change` 下重试的 `assistant/attempt` 失败不会上报，对其路由的 debug 猜测也不会上报。
- **成本不在范围内。** token 总量来自提供方上报的 usage；harness 没有计费数据，因此 `PeerTokenUsage` 绝不是账单，`budget` 只是 token 上限。
- `api/` 组 README 行仍待翻译工具处理。

<a id="dev-note"></a>
### 开发备注

`src/latch.ts`、`src/exposure.ts`、`src/disposition.ts` 与 `src/routing-policy.ts` 是纯函数；`src/pairings.ts` 绑定文件系统；`src/receipts.ts` 拥有有界幂等与预写输入回执文档；`src/host.ts` 拥有命名空间、派发、路由执行、归属与看门狗；`src/client.ts` 拥有调用方传输。测试：`tests/pairings.spec.ts`、`tests/latch.spec.ts`、`tests/disposition.spec.ts`、`tests/registry.host.spec.ts`、`tests/host.spec.ts`（真实 agent loop，假路由服务）、`tests/routing-policy.spec.ts`、`tests/receipts.spec.ts`、`tests/client.spec.ts`，以及 `tests/live-host.e2e.ts`（真实 `dsh web` + `tests/peer.overlay.yml`）。
