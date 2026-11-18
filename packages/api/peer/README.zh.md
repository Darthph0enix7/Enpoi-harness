---
description: "设备到设备 peer API：无鉴权的窄服务命名空间、配对存储、执行闩锁、提问注册表，以及调用方桥接。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-peer

[English](README.md) | 中文

## 概述

可选的设备到设备 peer API（doc 69 P2，契约见 `dsh-migration/70-peer-api-contract.md`）。一台主机通过一个小型 `peer` 命名空间——`handshake`、`list`、`create`、`prompt`、`follow`、`page`、`cancel`、`answer`、`state`、`models`、`selectModel`——暴露已配对的会话，另一台设备通过 `PeerClient` 驱动并回答它们。服务面在构造上就是窄的：每个调用都先经由 `~/.dsh/pairings.yaml` 解析，再映射到封闭派发表背后的 `session.*`，因此绝不会重新暴露 `settings.*`、`credentials.*`、`fs.*` 或 `control.*`。目前 peer 路径没有鉴权（doc 69 §9.2）；绑定仅限 tailnet/LAN，可选的配对 `token` 钩子只是预留、尚未强制执行——主机会解析该字段，调用方也会发送它，但还没有读取任何请求头（doc 72 §2.4）。

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

配置项：`pairingsPath`、`bindingsPath`、`watchdogMs`、`harnessVersion`、`schemaDigest`、`receiptsPath`（默认 `~/.dsh/peer-receipts.json`）、`receiptLimit`（默认 512）、`modelsLimit`（默认 100）与 `modelsLimitMax`（默认 500）。 `harnessVersion` 默认取运行中包清单的版本（即插件兼容性读取的运行时版本），而不是字面量；`schemaDigest` 默认取 `PEER_SCHEMA_DIGEST`；两者在握手中都只是提示值。

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
    create:                   # present ⇒ peer.create may create/adopt under this alias
      cwd: /home/user/projects/thing
      agentPreset: sysadmin
    remoteSessionId: sess-xyz # caller-role bookkeeping
    endpoint: https://laptop.pike-acrux.ts.net:8443
    token: null               # reserved; sent by callers, not verified by the host yet
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

`routing` 接受严格解析：未知键、类型错误、空模式，或落在 `[A-Za-z0-9._:/@*+-]` 之外的模式都会让主机加载失败，因为被静默忽略的成本防护会扩大配对控制方可选的范围。`allowModels` 模式匹配 `provider/model`，`*` 是唯一通配符（可覆盖任意字符序列，包括 `/`，两端锚定）；`allowChains` 条目是精确的链 id。在带 `routing` 的配对下，新建或采纳必须指定路由——`provider`+`model`，或单独的 `chain`——且主机应用路由服务解析出的 `selection`，绝不应用原始请求。仅指定链的请求由路由服务解析，目录、链注册表和路由健康状态都归该服务所有。未挂载 `peerRouting` 服务时，每个路由请求都以 `peer/forbidden`、reason `routing-unavailable` 失败关闭，握手也不再宣告 `model-discovery`、`model-routing-at-create` 与 `model-switch`。

`peer.create` 绑定持久化在 `~/.dsh/peer-state.json`（0600，带版本，原子替换）；替换别名绑定的 `create` 会把先前的会话移入该绑定的 `retired` 列表，因此被重新绑定的别名解析到最新会话，而被替换的会话仍可通过显式 `sessionId` 访问。每个绑定还记录该会话的 `maxTotalTokens` 上限（请求值，或被策略值封顶）；`PeerService.ceilingOf(sessionId)` 读取它，包括已被后续 create 退役的会话。主机从不改写配对文件。

<a id="host-surface"></a>
## 主机服务面

- `peer.handshake` 协商协议、schema 与能力，并报告可见配对（绝不携带 token）；协议不匹配返回 `peer/version-skew`。
- `peer.list` 发现已暴露的会话：每行携带配对别名、peer、exposure、该别名当前是否解析到某个 Session、绑定的会话 id（调用方的 `remoteSessionId`），以及主机闩锁可廉价回答时的一行式闩锁摘要和最近活动时间。可选的 target 会先经过同一配对门禁，因此未配对的会话返回 `peer/not-paired`，而不会被列出。
- `peer.state` 返回执行闩锁（`running | waiting_approval | waiting_subagents | idle`）、`activeDescendants`、待处理提问、当前模型选择、`lastParticipantAction` 与游标。当 `session.executionState` 调用有应答时，它读取主机的闩锁（`source: 'host-latch'`，包含静默子代理）；否则从 `turn/*`、`approval/*`、`subagent/catalog`、结算通知和提问注册表推导闩锁（`source: 'derived'`）。
- `peer.follow` 流式发送开场快照、按 exposure 过滤的持久事件和闩锁迁移；提问的铸造或结算还会推送一个 `state` 帧（变更键只包含每个待处理提问的 `(askId, kind, since)`），因此工具调用中途的提问无需等待下一个持久事件即可出现；`cursor` 是修复的权威位置，因为 `answer-only` 会过滤记录。
- `peer.prompt` 始终排队（人类优先）；`hopCount` 只是遥测，只有配置了 `runawayCeiling` 时才强制执行上限。
- `peer.answer` 结算待处理提问；本地回答链仍会看到该提问，先结算者胜出——迟到的回答返回 `peer/conflict`。
- `peer.cancel` 以 peer 归属取消活动回合；孤儿看门狗会中止没有跟随者接入的 peer 回合（默认 15 分钟）。
- `peer.create` 在任何会话或选择存在之前就应用策略评估出的路由，因此拒绝不会留下会话；没有 `routing` 的配对在采纳时仍沿用旧的 `allowModelChange` 门禁。高于策略上限的 `maxTotalTokens` 以 reason `budget` 拒绝；省略的值会被封顶到策略值。无法读取 token 用量的主机会以 reason `budget-unmetered` 拒绝任何会携带上限的 create，且发生在任何会话存在之前。
- `peer.models` 返回某个别名经策略过滤的链与模型，外加 `selectableByThisAlias`——回显策略，让控制方看到自己实际能选什么。分页上限由 `modelsLimit`/`modelsLimitMax` 收窄；凭据、URL 和提供方错误文本都不会跨线传输。
- `peer.selectModel` 切换某个空闲会话下一回合的路由（`persistDefault: false`）。运行中或等待中的会话返回 `peer/conflict`、`reason: 'busy'` 并携带闩锁；冷会话只在其 agent 未运行时才视为空闲。拒绝以 `peer/forbidden` 返回策略的 `reason` 和被拒绝的标识符。重试按 `requestId` 加上规范化载荷的 SHA-256 保持幂等；同一 id 搭配不同载荷返回 `peer/conflict`、reason `request-id-reuse`。

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

`PeerClient`（或 `./client` 导出）使用单次调用信封通信，通过 WS mux 打开 `peer.follow`，以指数退避重连，通过 `peer.page` 修复持久空洞，并返回 `peer/target-unreachable` 而不是无限重试。回环调用方通过 `headers`（以及一个 WebSocket 工厂）传递启动令牌 cookie；在 §9.2 仍然有效期间，tailnet 调用方无需凭据。

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

- **peer 归属只对 prompt 和 cancel 持久。** `peer.prompt` 把 peer 标签写入目标 `user/message` 的 source，`peer.cancel` 写入中止原因，因此主机闩锁会报告它们；`peer.create` 与 `peer.answer` 只能通过 `peer.state`/`peer.follow` 看到。`peer.selectModel` 记录一条进程内的 `model-change` 动作，带执行者与 `provider/model`；它不持久，因为 Session Controller 的 `model/selection` 载荷不携带参与者，扩展该持久载荷需要格式迁移。
- **切换与其回执不是同一个事务。** `peer.selectModel` 先追加选择，再写幂等回执。两次写入之间崩溃时，重试会重新应用同一选择，这是无害的；回执写入失败会被记录日志，而切换仍然返回成功。
- **路由三件套需要已挂载的服务。** `model-discovery`、`model-routing-at-create` 与 `model-switch` 只在 `peerRouting` 存在时宣告；握手每次调用都重新计算能力，因此账本仍是构建级事实，而宣告保持部署准确。
- **上限执行需要用量接缝。** 仅在 token meter（`tokenUsage` 投影的注册者）挂载时才宣告 `token-ceiling`；在缺少它的主机上，任何会携带上限的 create 都会在任何会话存在前以 `peer/forbidden`、reason `budget-unmetered` 拒绝。执行是响应式的，而非预防式的：主机在达到 `maxTotalTokens` 的那次响应提交之后才停止会话，已经进行中的请求绝不会在流中途被中止。若超预算响应提交时 Agent 未在运行，则没有可停止的对象；预算仍然耗尽时重新进入的回合会在又一次响应后被停止。在重启后进入无计量主机时仍存在的旧绑定会回答 `budget.metered: false`，此时提示门与监视器都会放行而不是猜测。
- **`peer.create` 没有幂等键。** 响应丢失后的重试会创建另一个会话并重绑别名，退役先前的绑定；被退役的会话仍可通过显式 `sessionId` 寻址。重试前先通过 `peer.list` 与绑定状态核对，并把未知的 create 结果视为不确定。
- **`peer.selectModel` 的重放先查回执、后查空闲。** 同 id、同载荷的重试即使会话随后已开始运行，也会返回原始值并带 `replayed: true`；权威是回执，而不是当前闩锁。
- **`peer.prompt` 只按 `requestId` 去重，不绑定载荷。** Session Controller 的实时收件箱与日志 `source.rpcId` 索引对同一 id 直接回答 `accepted: true`，不比较内容，因此复用 id 搭配变更载荷不会冲突；调用方必须每次尝试都铸造新的请求 id，并自行绑定内容哈希。
- **人类 Stop 会清除排队的 peer 提示。** peer 提示以 source kind `user` 进入，因此 Stop 的收件箱清理会在它成为持久 `user/message` 之前丢弃排队的 peer 提示；清理记录带有 `outcome: canceled`，但不携带被移除消息的身份，所以唯一证据是缺失的持久 user/message。已经看到 `accepted: true` 的调用方必须检测其 `requestId` 从未进入日志，并重新驱动。
- **`allowModels` 为空时 `peer.models.models` 为空。** `models` 是固定路由投影；`allowModels` 缺失或为空时，即使 `chains` 有就绪成员，它也是空的，因此请读取 `chains[].members` 获取链可选集合。
- **`allowModels` 也会收窄所选链的每个成员。** 选择链不是绕过：每个解析出的成员都必须像固定路由一样满足 `allowModels`、`requireZeroPrice`、`requireNoTraining`、`requireTools` 与 `allowReasoningEfforts`。
- **`peer.follow` 的快照和 `state` 帧也会读取执行状态投影**（`host.ts` 的 `follow`），因此在挂载了该投影的主机上，这些帧会像 `peer.state` 一样报告 `source: 'host-latch'`；冷 Session 保持推导路径，因为 `session.executionState` 只寻址已附着的 Session。live-host e2e 仍只断言 `peer.state`（doc 72 §2.2）。
- **待处理问题只在进程内。** 重启后会丢失，行为与浏览器一致；peer 看到的是被中断的终态加 `idle`。
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

`src/latch.ts`、`src/exposure.ts` 与 `src/routing-policy.ts` 是纯函数；`src/pairings.ts` 绑定文件系统；`src/receipts.ts` 拥有有界幂等文档；`src/host.ts` 拥有命名空间、派发、路由执行、归属与看门狗；`src/client.ts` 拥有调用方传输。测试：`tests/pairings.spec.ts`、`tests/latch.spec.ts`、`tests/registry.host.spec.ts`、`tests/host.spec.ts`（真实 agent loop，假路由服务）、`tests/routing-policy.spec.ts`、`tests/receipts.spec.ts`、`tests/client.spec.ts`，以及 `tests/live-host.e2e.ts`（真实 `dsh web` + `tests/peer.overlay.yml`）。
