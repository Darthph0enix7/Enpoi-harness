# 对等互联

[English](peer.md) | 中文

[`@deepseek-ai/dsh-api-peer`](../../packages/api/peer) 的设备到设备对等 seam。一台宿主在 `peer` 命名空间下暴露一组窄接口——`handshake`、`state`、`create`、`prompt`、`cancel`、`answer`、`page`、`follow`——它们在一个闭合的分发表之后映射到 `session.*` 操作；另一台设备据此驱动并观察已配对的会话。配对是寻址边界：每个调用首先通过宿主的配对表解析其 `PeerTarget`，因此只有表中列名的会话可被听见，而暴露过滤、参与者校验、跳数上限与孤儿看门狗都在宿主侧施加，绝不交给调用方。

源码：[`packages/api/peer/src/host.ts`](../../packages/api/peer/src/host.ts)

## 宿主服务与配置

`ctx.peerService` 是 `PeerService`，一个挂载在 `peer` 命名空间下的 `TypertRemoteService`。它注入 `agentDefaultModel`、`agents`、`sessionController` 与 `sessionQuery`，在构造函数中加载配对文档（文档格式错误会让加载响亮失败），安装 ask 注册表，并在 dispose 时清除所有孤儿看门狗定时器。

```ts
/** Peer API deployment policy. */
interface Config {
  /** Pairing document path; defaults to `~/.dsh/pairings.yaml`. */
  readonly pairingsPath?: string
  /** Created-session binding path; defaults to `~/.dsh/peer-state.json`. */
  readonly bindingsPath?: string
  /** Orphan watchdog in milliseconds; defaults to 15 minutes. */
  readonly watchdogMs?: number
  /** Harness version reported by `peer.handshake`. */
  readonly harnessVersion?: string
  /** Schema digest reported by `peer.handshake`. */
  readonly schemaDigest?: string
}
```

运行时常量为 `PEER_PROTOCOL_VERSION = 1`、`DEFAULT_WATCHDOG_MS = 15 * 60 * 1000` 与 `DEFAULT_HARNESS_VERSION = '0.1.6-alpha.2'`；`PEER_SCHEMA_DIGEST` 是协议版本加固定方法列表的 SHA-256 摘要。握手宣告的能力为 `state-latch`、`derived-latch`、`answer-routing`、`session-create` 与 `runaway-ceiling`。`PeerCapability` 词汇还包含 `assistant-stream`，但本构建不宣告它——该特性只能通过 `follow` 请求标志触达。

## 配对模型

两个文档定义该边界。人工编辑的配对文档（`~/.dsh/pairings.yaml`，0600）描述本宿主在每条链路上的角色；创建会话的绑定存放在另一个机器写入的文档（`~/.dsh/peer-state.json`，0600，原子替换）中，只有 `peer.create` 会写入它。每当配对文件的 mtime 或大小变化，`PeerPairingsStore.load()` 就会重新读取；校验失败的重载会保留上一份有效快照，文件消失会撤回暴露（空配对表，设备名回退到主机名），而首次加载即格式错误会抛出 `PeerConfigError`，而不是降级为空表。

```ts
/**
 * Address a peer call resolves through the target's pairing file. An explicit
 * session id is accepted only when some pairing maps it; ambient addressing
 * ("the session I am working in") is rejected by design (doc 69 §8).
 */
type PeerTarget =
  | { readonly kind: 'alias'; readonly alias: PeerAlias }
  | { readonly kind: 'session'; readonly sessionId: SessionId }
```

```ts
/** The pairing and session a peer call resolved to, echoed on every response. */
interface PeerTargetResolved {
  readonly device: PeerDeviceName
  readonly sessionId: SessionId
  readonly exposure: PeerExposure
  readonly alias?: PeerAlias
}

/**
 * What a pairing lets a peer observe. `answer-only` carries the durable
 * dialogue plus asks and terminals; `debug` adds tool/step/subagent internals
 * and, on request, assistant stream frames (doc 69 §9.1).
 */
type PeerExposure = 'answer-only' | 'debug'
```

别名解析到配对条目的 `sessionId`，或解析到 `peer.create` 在该别名下持久化的绑定；显式的 `sessionId` 通过直接列名它的配对条目解析，或通过任何包含该会话的绑定解析。线上 target 不带 peer 判别字段，因此加载器会拒绝跨条目重复的别名（`peer pairings ... repeats alias`）——唯一性是按宿主而非按 peer 计算的。

宿主与 peer 共享的唯一条目形状是 `PeerPairing`；`create` 存在当且仅当 peer 可以在该别名下创建或领养会话。

```ts
/** One pairing entry in `~/.dsh/pairings.yaml` (this host's side of a link). */
interface PeerPairing {
  readonly alias: PeerAlias
  readonly peer: PeerDeviceName
  /** What this host exposes for its own `sessionId`; required, no implicit default. */
  readonly exposure: PeerExposure
  /** This host's session bound to the pairing; absent with `create` for a peer-created session. */
  readonly sessionId?: SessionId
  /** Present when a peer may create (or adopt) a session under this alias. */
  readonly create?: PeerCreateDefaults
  /** The session on `peer` this host calls; caller-role bookkeeping only. */
  readonly remoteSessionId?: SessionId
  /** Base URL of `peer`'s peer surface; caller-role addressing. */
  readonly endpoint?: string
  /** Reserved; never verified on the host (the peer path reads no request headers). */
  readonly token?: string
  /** Optional emergency stop; absent means unbounded agent-to-agent exchange. */
  readonly runawayCeiling?: number
  /** Allows an adopting `peer.create` to change routing; default off. */
  readonly allowModelChange?: boolean
}

/** The whole `~/.dsh/pairings.yaml` document (0600; loaded and validated on start and on change). */
interface PeerPairingsFile {
  readonly version: 1
  readonly device: PeerDeviceName
  readonly watchdogMs?: number
  readonly pairings: readonly PeerPairing[]
}
```

- `alias` 匹配 `[A-Za-z0-9._-]+`，且必须按宿主唯一。
- `exposure` 必填；没有隐式默认值，因此没有配对会隐式处于 `debug`。
- `sessionId` 与 `create` 至少存在其一，否则该条目不可达并在加载时被拒绝。
- `watchdogMs` 与 `runawayCeiling` 存在时必须是正的安全整数。
- `token` 会被解析，但在握手中只以 `tokenRequired` 报告；它从不被回显，也从不在此包中强制执行。
- 绑定以别名为键，携带 `{sessionId, device, createdAt}`，外加可选的 `retired` 列表（该别名此前绑定过的会话）；格式错误的绑定文档会抛出 `PeerConfigError`。同一别名下再次 `peer.create` 会替换当前绑定并把旧绑定移入 `retired`，因此该别名解析到最新会话，而每个被替换的会话仍可通过同一配对以显式 `sessionId` target 寻址。

## 暴露过滤器

过滤在宿主侧产生记录与帧时进行，因此 `answer-only` 流绝不会包含工具、步骤、子代理或注入数据。判定函数是 `isExposedEvent(type, data, exposure)`；`toPeerRecord` 将其应用于持久事件，`follow` 将其同时应用于快照记录与事件记录。

| 事件族 | `answer-only` | `debug` |
|---|---|---|
| `assistant/message`、`turn/start`、`turn/end`、`approval/asked`、`approval/decided` | 可见 | 可见 |
| `source.kind` 为 `user`、`user-rpc`、`webhook`、`agent-message`、`subagent-settled` 或 `team-message`，或不携带 `source` 的 `user/message` | 可见 | 可见 |
| 所有其他持久类型（`tool/call`、`tool/result`、`step/*`、`assistant/attempt`、`subagent/*`、`goal/*`、`compaction/*`、`revert/*`、`model/selection`、`session/title` 等） | 被过滤 | 可见 |
| `assistant-stream` 帧（在 `follow` 上选择性启用） | `peer/forbidden` | 可见 |

## 握手

`handshake` 是唯一无需配对即可触达的方法。它协商协议世代，并报告宿主身份、能力与可见配对。

```ts
/** `peer.handshake` request: the caller's protocol, build, and schema identity. */
interface PeerHandshakeRequest {
  readonly protocolVersion: number
  readonly harnessVersion: string
  readonly schemaDigest: string
  readonly device: PeerDeviceName
}

/** `peer.handshake` value: the host's identity, capabilities, and visible pairings. */
interface PeerHandshakeValue {
  readonly protocolVersion: PeerProtocolVersion
  readonly harnessVersion: string
  readonly schemaDigest: string
  readonly hostDevice: PeerDeviceName
  readonly capabilities: readonly PeerCapability[]
  readonly pairings: readonly PeerPairingSummary[]
}
```

`protocolVersion` 是硬性兼容门：任何非 `1` 的值都会在任何其他握手工作之前抛出 `peer/version-skew`，并附带期望值与收到的值。`harnessVersion` 与 `schemaDigest` 是宿主返回给调用方自行比较的提示值，因此在协议版本一致时摘要不同也会被接受。`device` 必须是非空字符串（否则为 `gateway/bad-request`）。回复中的每个配对是一个 `PeerPairingSummary`，包含别名、peer、exposure、`tokenRequired`，以及——当该别名当前可解析到会话时——解析后的 target。

## 发现

`list` 是只读的发现调用。不带 target 时，它报告宿主暴露的每个配对；带 `target` 时，它先通过与其它调用相同的配对门解析该 target（无法解析时为 `peer/not-paired`），并且只返回该配对。每一行携带别名、peer 与 exposure、该别名当前是否可解析到会话、绑定会话 id——即调用方的 `remoteSessionId`，来自配对自身的钉住或 `peer.create` 绑定——以及当 `sessionController.executionState` 能廉价回答绑定会话时，宿主 latch、最后活动时间与一行摘要（`latch · asks · last turn`）。仅声明为配对调用方角色 `remoteSessionId` 的钉住同样能解析显式的 `peer.state`/`peer.list` 会话 target，因此由另一台设备一侧撰写的共享文档保持可寻址，而不会因此授予任意会话 id。

```ts
/** `peer.list` request: an absent target lists every pairing; a target narrows the answer. */
interface PeerListRequest { readonly target?: PeerTarget }

/** One pairing row `peer.list` reports. */
interface PeerListEntry {
  readonly alias: PeerAlias
  readonly peer: PeerDeviceName
  readonly exposure: PeerExposure
  readonly bound: boolean
  readonly sessionId?: SessionId
  readonly remoteSessionId?: SessionId
  readonly latch?: PeerLatch
  readonly lastActivity?: number
  readonly summary: string
}

/** `peer.list` value: the serving host's device name and one row per pairing. */
interface PeerListValue {
  readonly hostDevice: PeerDeviceName
  readonly pairings: readonly PeerListEntry[]
}
```

## 会话：create、prompt、cancel

`create` 要求被寻址的配对条目带有 `create` 块（否则为 `peer/not-paired`）。当显式给出已存在的 `sessionId` 时，该会话被领养且 `created` 为 false；除非配对设置 `allowModelChange: true`，否则在领养时携带路由字段会被以 `peer/forbidden` 拒绝。否则会话通过 `sessionController.create` 创建，请求中的 `workspaceId`、`cwd` 与 `agentPreset` 回退到配对的 `create` 默认值，别名到会话的绑定随后被持久化。在通过绑定解析的别名下创建会替换该绑定；旧绑定移入 `retired`，因此之后每次别名调用都到达最新会话，而被替换的会话仍可通过显式 `sessionId` target 寻址。由配对自身 `sessionId` 钉住的别名始终解析到该钉住的会话，`create` 写入的绑定只能通过显式 `sessionId` 访问；需要新会话又不想移动别名当前目标的调用方应改用另一个别名。

```ts
/** `peer.create` request: bind a fresh or explicitly adopted session to a pairing alias. */
interface PeerCreateRequest {
  readonly alias: PeerAlias
  readonly participant: PeerParticipant
  readonly sessionId?: SessionId
  readonly workspaceId?: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly provider?: string
  readonly model?: string
  readonly chain?: string
  readonly reasoningEffort?: string
}

/** `peer.create` value: `created` is false when an existing session was adopted. */
interface PeerCreateValue {
  readonly target: PeerTargetResolved
  readonly created: boolean
}
```

create 上的路由通过 `sessionController.selectModel` 以 `persistDefault: false` 应用，所以 peer 的路由只影响该会话，绝不改写部署默认值；`provider` 与 `model` 必须成对提供（否则为 `gateway/bad-request`）。每次 create 都为解析出的会话记录一条宿主本地的 `create` 参与者动作。

```ts
/**
 * `peer.prompt` request: one inbound turn. Mode is fixed to `queue` so a human
 * message always preempts a peer (doc 69 §8); steer is not part of this API.
 */
interface PeerPromptRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
  readonly requestId: PeerRequestId
  readonly content: readonly PeerPromptContentPart[]
  /** Telemetry only: incremented by each forwarding bridge, never enforced unless a ceiling is configured. */
  readonly hopCount?: number
}

/** `peer.prompt` value: the turn entered the target inbox. */
interface PeerPromptValue {
  readonly accepted: true
  readonly queued: boolean
  readonly hopCount: number
}

/** `peer.cancel` request: cancel the target's active turn, attributed to the peer. */
interface PeerCancelRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
}

/** `peer.cancel` value: `cancelled` is false when no turn was active. */
interface PeerCancelValue {
  readonly accepted: true
  readonly cancelled: boolean
}
```

`prompt` 恰好接纳一个排队轮次。其内容必须是非空文本部件列表，每个部件都含非空白文本（否则为 `gateway/bad-request`）；调用方铸造的 `requestId` 是去重身份，`participant` 会成为目标日志 `user/message` 中的持久归属信息，也即 latch 的 `lastParticipantAction` 所报告的内容。当解析出的配对配置了 `runawayCeiling` 且 `hopCount >= ceiling` 时，prompt 会被以 `peer/hop-limit` 拒绝；否则回复返回 `hopCount + 1`。prompt 准入会安排孤儿看门狗。

`cancel` 将取消归属到调用方，仅当该会话的 agent 在调用时为 `running` 才报告 `cancelled: true`，并清除该会话的看门狗。

## 执行状态

`state` 观察会话，并经由观察游标折叠出聚合执行状态。优先级顺序是确定性的，先匹配者胜。

1. `waiting_approval` —— 待处理 ask 非空；审批与提问都意味着必须由人行动。
2. `waiting_subagents` —— 有轮次打开且 `activeDescendants > 0`。
3. `running` —— 有轮次打开，且无子代理、无待处理 ask。
4. `idle` —— 没有打开的轮次。

```ts
/**
 * Authoritative aggregate execution state of one session (doc 69 §8
 * correction 3). `waiting_approval` also covers pending user questions: either
 * ask kind means a human must act before the turn can proceed.
 */
type PeerLatch = 'running' | 'waiting_approval' | 'waiting_subagents' | 'idle'

/**
 * Aggregate execution state a peer observes instead of crawling child streams.
 * `source` says whether a host-owned latch produced it or whether it was
 * derived from the durable stream; `descendantsExact` is false when derivation
 * cannot prove descendant liveness (quiet children stay parent-invisible).
 */
interface PeerExecutionState {
  readonly latch: PeerLatch
  readonly since: number
  readonly source: 'host-latch' | 'derived'
  readonly activeDescendants: number
  readonly descendantsExact: boolean
  readonly pendingAsks: readonly PeerPendingAsk[]
  readonly lastTurnEnd?: PeerTurnTerminal
  readonly lastParticipantAction?: PeerParticipantAction
  readonly model?: PeerModelSelection
}
```

宿主 latch 能回答时优先。`state` 先调用 `sessionController.executionState({ sessionId })`，仅当返回值在结构上带有合法 latch 且子代理数量为非负安全整数时才接受；否则它读取 `executionState` 或 `peerExecutionState` 投影，两者皆无时从持久事件流派生（`source: 'derived'`）。`follow` 只读取投影形式。派生统计的是在打开的轮次开始后生成、且尚未由 `subagent-settled` 用户消息结算的 `subagent/catalog` 子代理，因此安静的子代理会让 `descendantsExact` 保持 false，调用方应重新读取 `peer.state`，而不是宣告空闲。模型选择来自最后一条持久 `model/selection`，否则来自目标的 `modelSelection` 投影（`pending` 优先于 `lastUsed`），再否则来自宿主的 `agentDefaultModel.currentSelection()`。`lastParticipantAction` 优先取 `create`、`prompt`、`cancel` 与 `answer` 记录的宿主本地动作，然后是宿主 latch 值，最后是折叠出的人类动作。

## 提问：answer 与竞态

ask 注册表以 `prepend: true` 观察 `approval/request` 与 `user-questions/request`，因此在任何本地转发停驻该 waterfall 之前就铸造好 `PeerAskId`。只有根会话被某个配对暴露的 ask 才会发布；子代理提出的 ask 通过遍历 `parentSession` 链（上限 32 层）绑定到 peer 所跟随的根会话，而无法归属到 agent 或无法解析根会话的 ask 保持本地。

本地链通过 `next()` 立即启动，注册表让它与 peer 的回答竞速：先结算者决定结果，败者值被丢弃。已结算的 ask 以 256 条为界的墓碑记录退役，因此迟到的回答会得到 `peer/conflict` 而非 `peer/not-found`。由于待处理 ask 的成员关系没有持久事件，注册表在铸造与结算时推送合并后的变更唤醒，而 `follow` 世代把 latch 键变化转化为至多一个 `state` 帧。

```ts
/** One ask a peer may answer, correlated by the host-minted `askId`. */
type PeerPendingAsk =
  | {
    readonly kind: 'approval'
    readonly askId: PeerAskId
    readonly toolName: string
    readonly callId?: string
    readonly reason?: string
    readonly since: number
  }
  | {
    readonly kind: 'question'
    readonly askId: PeerAskId
    readonly questions: readonly AskUserQuestionItem[]
    readonly since: number
  }

/** One peer answer to a pending ask, discriminated by the ask kind. */
type PeerAnswer =
  | { readonly kind: 'approval'; readonly outcome: PeerApprovalOutcome }
  | { readonly kind: 'question'; readonly answer: AskUserQuestionAnswer }

/** `peer.answer` request: settle the ask behind `askId`; races lose with `peer/conflict`. */
interface PeerAnswerRequest {
  readonly target: PeerTarget
  readonly participant: PeerParticipant
  readonly askId: PeerAskId
  readonly answer: PeerAnswer
}

/** `peer.answer` value: the answer settled the ask. */
interface PeerAnswerValue {
  readonly accepted: true
  readonly settled: true
}
```

`answer` 先校验再认领，因此格式错误的回答会让 ask 保持待处理，而合法的回答会认领它。peer 的审批结果只限 `allowed-once` 与 `rejected`（其他值为 `peer/forbidden`），结构化提问回答则从 `{answers: [{id, selected, custom?}]}` 归一化（格式错误时为 `peer/not-found`）。未知 ask id 为 `peer/not-found`，属于其他会话的 ask 为 `peer/forbidden`，回答种类与 ask 种类不匹配为 `peer/not-found`。

## 历史：page 与 follow

`page` 从 follow 切点向后修复历史，返回一个连续的、经暴露过滤的记录窗口。

```ts
/** `peer.page` request: backwards history repair from a follow opening cut (doc 69 §12.3). */
interface PeerPageRequest {
  readonly target: PeerTarget
  readonly throughSeq: SessionSeq
  readonly beforeSeq?: SessionSeq
  readonly maxMessages?: number
}

/** `peer.page` value: one contiguous backwards window of the exposure-filtered stream. */
interface PeerPageValue {
  readonly records: readonly PeerEventRecord[]
  readonly hasMore: boolean
}
```

```ts
/** `peer.follow` request: opening snapshot then live frames, filtered by exposure. */
interface PeerFollowRequest {
  readonly target: PeerTarget
  readonly maxMessages?: number
  /** Debug exposure only; `answer-only` rejects the stream with `peer/forbidden`. */
  readonly assistantStream?: true
}

/** Every frame a `peer.follow` stream carries. */
type PeerFollowFrame =
  | PeerFollowSnapshotFrame
  | PeerFollowEventFrame
  | PeerFollowStateFrame
  | PeerFollowAssistantStreamFrame
  | PeerFollowEndFrame
```

`follow` 以一个 `snapshot` 帧开场，携带解析后的 target、线上头（`id`、`version`、`createdAt`，可选 `cwd` 与 `agentPreset`）、执行状态、持久游标、有界近期窗口（默认 50 条消息）与 `hasMore`。随后它为可见持久记录发出 `event` 帧，在每次 latch 键变化时发出 `state` 帧，选择性发出 `assistant-stream` 帧，并以终帧 `end` 结束。`event` 与 `state` 帧携带 `cursor`，即宿主已扫描到的持久位置：在 `answer-only` 下过滤器会丢弃记录，因此 `record.seq` 可以跳跃而 `cursor` 继续前进，`peer.page` 正是依据 `cursor` 修复。持久连续性本身在可见事件之间被强制执行——出现缺口会抛出 `peer/gap`。观察到已消失的会话会以 `{type: 'end', reason: 'target-detached'}` 结束流；宿主侧正常结束为 `'closed'`。`assistantStream: true` 要求 `debug` 暴露。

## 孤儿看门狗

跟随者离去的 peer 轮次是有界的。prompt 准入会武装看门狗；最后一个跟随者离开时，若 agent 仍在运行则重新武装；打开跟随者或取消会清除它。经过 `watchdogMs`（默认 15 分钟）后宿主再次检查，若无跟随者且 agent 仍在运行，它会记录警告并取消该轮次。看门狗取消不归属任何参与者。定时器均已 `unref()`，并在服务 dispose 时清除。

## 限制与已知缺口

- 待处理 ask 只存在于注册表的内存表中：宿主重启会丢失它们，只有宿主进程存活期间铸造的 ask 才能被回答。提问类 ask 是最严格的情形——宿主在 `peer.answer` 接受结构化 `{answers: [...]}` 回复，但随附的调用方界面只回答审批，因此远程提问会停驻该轮次，直到浏览器作答或看门狗中止（doc 72 G1）。
- peer 已结算的 ask 不会被主动取消给本地应答者：竞速会启动浏览器链，只丢弃其迟到的值，因此浏览器仍可能显示一张结果已定的卡片。本地链以拒绝结算时，该拒绝会结算竞速并退役该 ask。
- `hopCount` 与 `runawayCeiling` 对随附调用方实际上处于保留状态：只有配对配置了上限才会强制执行，且比较的是调用方提供的原始 `hopCount`，而随附调用方发送 `0`。
- `token` 是保留字段，并未强制执行：宿主解析它且只报告 `tokenRequired`；此包不读取任何请求头，因此任何可达的调用方都能寻址已配对的别名。
- follow 的 latch 键省略了模型选择，因此仅模型变化不会发出 `state` 帧（且 `model/selection` 在 `answer-only` 暴露下被过滤）；`peer.state` 仍是权威。
- 当 ask 从未由注册表铸造时（例如无法归属的提问），宿主 latch 可能报告 `latch: 'waiting_approval'` 而 `pendingAsks` 为空；该状态不会合并这两个来源。
- 看门狗取消不带归属，且栈更深处抛出的 `create` 失败（例如 `agent-preset/not-found`）会按其原始错误码透传，而不是转为 peer 域错误。
- `create` 由配对的 `create` 块把守，但参与者身份只做结构校验——不会与配对的 `peer` 设备比对。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpeerservice--peerservice"></a>

### `ctx.peerService` — `PeerService`

Host service backing the generated `ctx.remote.peer` namespace.

```ts cordis-catalog
/**
 * Negotiate protocol, capability, and pairing identity.
 * @param request - caller protocol, harness version, schema digest, and device name.
 * @returns the host identity, capabilities, and visible pairings.
 * @throws {@link RemoteError} `gateway/bad-request` when the request is
 * absent or not an object, `peer/version-skew` on protocol divergence.
 */
@Remote('handshake') handshake(request: PeerHandshakeRequest): PeerHandshakeValue

/**
 * Read the aggregate execution state for one paired Session. The host's
 * `session.executionState` latch wins when it answers (`source:'host-latch'`);
 * a cold Session or a host without that call keeps the derived fold.
 * @param request - resolved target.
 * @returns latch, descendants, pending asks, model selection, and cursor.
 */
@Remote('state') async state(request: PeerStateRequest): Promise<PeerStateValue>

/**
 * List the pairings this host exposes with a cheap live summary. Discovery
 * is read-only and reports each pairing at its own exposure; a supplied
 * target resolves through the same pairing gate as every other call, so an
 * unpaired session is refused rather than listed.
 * @param request - optional target narrowing the answer to one pairing.
 * @returns the host device and one row per selected pairing.
 * @throws {@link RemoteError} `peer/not-paired` when a supplied target does not resolve.
 */
@Remote('list') list(request?: PeerListRequest): PeerListValue

/**
 * Create or explicitly adopt a Session and bind it to a pairing alias.
 * @param request - pairing alias, participant, optional explicit session and routing.
 * @returns the resolved target and whether a new Session was created.
 * @throws {@link RemoteError} `peer/not-paired`, `peer/forbidden`, or
 * `peer/not-found` (a deeper create failure such as `agent-preset/not-found`
 * is mapped into the peer vocabulary).
 */
@Remote('create') async create(request: PeerCreateRequest): Promise<PeerCreateValue>

/**
 * Admit one queued peer turn into a paired Session.
 * @param request - target, participant, dedupe id, text content, and hop telemetry.
 * @param signal - carrier cancellation before prompt admission begins.
 * @returns acceptance and the incremented hop count.
 * @throws {@link RemoteError} `peer/hop-limit` only when the pairing configures a ceiling.
 */
@Remote('prompt') async prompt(request: PeerPromptRequest, signal: AbortSignal): Promise<PeerPromptValue>

/**
 * Cancel the active turn of a paired Session, attributed to the peer.
 * @param request - target and participant.
 * @returns acceptance and whether a turn was active.
 */
@Remote('cancel') cancel(request: PeerCancelRequest): PeerCancelValue

/**
 * Settle a pending ask for a paired Session.
 * @param request - target, participant, ask id, and answer payload.
 * @returns acceptance after the ask settled.
 */
@Remote('answer') answer(request: PeerAnswerRequest): PeerAnswerValue

/**
 * Repair history backwards from a follow cut, exposure-filtered.
 * @param request - target, inclusive cut, and optional backwards cursor.
 * @param signal - carrier cancellation for persistence reads.
 * @returns one contiguous backwards window of visible records.
 */
@Remote('page') async page(request: PeerPageRequest, signal: AbortSignal): Promise<PeerPageValue>

/**
 * Open a filtered stream: opening snapshot, then durable events and latch transitions.
 * @param request - target, window budget, and debug-only assistant stream opt-in.
 * @param signal - carrier cancellation owned by the Remote stream.
 * @returns peer follow frames; `event`/`state` frames carry the durable scan cursor.
 */
@Remote({ mode: 'stream' }) async *follow(request: PeerFollowRequest, signal: AbortSignal): AsyncIterable<PeerFollowFrame>
```

Source: [`packages/api/peer/src/host.ts`](../../packages/api/peer/src/host.ts)
<!-- END GENERATED cordis-surface -->
