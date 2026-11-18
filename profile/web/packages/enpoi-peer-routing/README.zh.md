# dsh-enpoi-peer-routing

[English](README.md) | 中文

设备到设备 peer API 的策略化模型发现与选择。本插件提供 `peerRouting` 服务，
peer 主机通过 `ctx.get('peerRouting')` 解析它：已配对的控制器可以发现其配对真正
允许的链与模型，询问某个选择是否被允许，并让主机在创建或切换时应用解析出的路由。
在配对带有 `routing` 块之前服务保持惰性，但默认挂载，好让 peer 握手声明
`model-discovery`、`model-routing-at-create` 与 `model-switch`。

本服务绝不返回凭据、基础 URL、请求头、provider 错误文本、设置文档或允许列表：
拒绝只携带违规标识符。

## 服务

`evaluate(policy, selection)` 在调用时解析目录、链注册表与路由健康状态，回答
`{ allowed: true, selection: { provider, model, chain?, reasoningEffort? } }` 或
`{ allowed: false, reason, denied }`，原因是 peer 契约中的封闭集合：
`chain-not-allowed`、`model-not-allowed`、`price-unproven`、
`training-unproven`、`tools-unproven`、`effort-not-allowed`、`unknown-route`。

`discover(policy, { filter?, cursor?, limit? })` 返回允许的链及其实时成员状态
（`ready` / `cooldown` 加 `cooldownUntil`，或端点已下线、仅因引用而保留的
`deprecated`），以及通过 `evaluate` 同一谓词的模型。
结果按 `(provider, model)` 排序，并用不透明 base64url 游标分页；非法游标抛出
`invalid cursor`，由主机映射。

事实来自模型选择器使用的同一批来源，绝不本地猜测：

- 通过 `dsh-enpoi-catalog-rules` 读取目录条目（`readCatalogue`，或实时
  `catalogRules` 引擎投影，从而应用手动 gated 覆盖）；
- 零价格谓词通过该包的 selector 展开，因此“未知价格”保持未知，策略要求证明时被拒绝；
- 隐私通过 `resolvePrivacy`；`trainsOnData` 为 `yes`、`no` 或 `unknown`，
  只有 `no` 满足 `requireNoTraining`；
- `tools` 来自目录投影；只有 `true` 满足 `requireTools`，`false` 与 `unknown`
  以 `tools-unproven` 拒绝；
- `reasoningEfforts` 来自原始 `llm-pi-ai` 模型行（目录投影不携带该梯度）；
- 链来自 `modelChains.resolved` 工件（`settings.readArtifact`），路由健康来自
  `ctx.llm.routeHealth()`（`coolingUntil`）；工件缺失即无链，健康行缺失即就绪。

## 策略评估

策略就是配对的 `routing` 块。链 id 是精确值；`allowModels` 条目是两端锚定的
glob，其中 `*` 是唯一通配符（也跨越 `/`），其余字符全部字面匹配。空的
`routing: {}` 块不选择任何东西（全部拒绝），但仍使路由策略对该配对生效。

- **仅链**（`{ chain }`）：链必须列在 `allowChains` 中（缺失或为空则不允许任何链），
  并且必须通过 `modelChains.resolved` 解析。每个已解析成员在选定时都会被重新
  检查：任一成员为付费、未知价格、训练、未知训练、gated、deprecated 或不匹配模式，整条链
  即被拒绝并点名该成员。第一个未冷却成员成为具体选择；全部冷却时使用首个声明成员。
- **固定路由**（`{ provider, model }`）：路由必须存在于目录，必须匹配 `allowModels`
  glob（缺失或为空则不选择任何固定路由），并满足 `requireZeroPrice` /
  `requireNoTraining`。
- **固定路由加链**：两项授权都适用，且链必须包含该确切成员；上面的成员复查仍会运行。
- **工具**：`requireTools: true` 拒绝任何未经证明 `tools: true` 的路由；目录中的
  `false` 或 `unknown` 回答 `tools-unproven`。
- **努力级别**：调用方指定的努力级别必须在 `allowReasoningEfforts` 与所选模型公开的
  梯度之内。链链接自带的努力级别属于有效选择，也按同样规则检查。
- **Gated 或 deprecated**：gated 路由与目录中标记 `deprecated` 的记录（端点下线后
  仅因路由内引用而保留）始终被拒绝，即使 glob 匹配也不例外。包含 deprecated 成员的链
  会按成员名拒绝整条链，发现仍会列出该链并把该成员状态标为 `deprecated`。

## 发现

`discover` 每个请求读取一次快照，因此动态链若在发现与评估之间漂移，会在评估时被
捕获——调用方可能看到旧成员，但主机绝不会应用当前策略拒绝的成员。布尔过滤器要求
精确相等，因此 `zeroPrice: false` 与 `tools: false` 会排除事实为 `unknown` 的行。

## 配对用法（仅免费 worker）

一个限制到免费组的 worker 别名。`routing` 块位于别名所属的 fleet 成员上（即该条目
原本用于 `exposure` 与 `create` 的成员）；生成器把它渲染进该别名的配对条目。

`fleet.yaml` 形式：

```yaml
members:
  - name: jarvis
    alias: jarvis-worker-test
    exposure: answer-only
    create: jarvis-readonly
    hostnames: [jarvis-worker-*]
    ip: 100.64.0.9
    routing:
      allowChains: [free]
      allowModels: ["kilo/*:free", "openrouter/*:free"]
      requireZeroPrice: true
      requireNoTraining: false
      requireTools: true
      allowReasoningEfforts: [minimal, medium]
      allowSwitch: idle-only
      maxTotalTokens: 200000
```

对应的 `$DSH_HOME/pairings.yaml` 条目：

```yaml
pairings:
  - alias: jarvis-worker-test
    peer: jarvis
    exposure: answer-only
    create:
      agentPreset: jarvis-readonly
      workspaceId: ws-example
    routing:
      allowChains: [free]
      allowModels: ["kilo/*:free", "openrouter/*:free"]
      requireZeroPrice: true
      requireNoTraining: false
      requireTools: true
      allowReasoningEfforts: [minimal, medium]
      allowSwitch: idle-only
      maxTotalTokens: 200000
```

任何不使用虚构知识与假文件的运行都应设置 `requireNoTraining: true`：免费 provider
可能用提示训练，而未知训练状态会被拒绝。需要调用工具的 worker 还应设置
`requireTools: true`：在随附目录中所有免费行都报告 `tools: true`，工具能力未知的路由
会被拒绝而不是被假定可用。

fleet 生成器只携带 `create.agentPreset`。因此工作区占位符应放在配对文档中；对于
生成文档，则放在 `peer.create` 请求本身；否则主机使用其创建默认值。

### 创建请求

仅链——主机解析第一个未冷却成员：

```json
{
  "alias": "jarvis-worker-test",
  "participant": { "kind": "peer", "name": "jarvis", "device": "jarvis-host" },
  "chain": "free",
  "reasoningEffort": "medium",
  "maxTotalTokens": 200000
}
```

固定路由：

```json
{
  "alias": "jarvis-worker-test",
  "participant": { "kind": "peer", "name": "jarvis", "device": "jarvis-host" },
  "provider": "kilo",
  "model": "nvidia/nemotron-3-ultra-550b-a55b:free",
  "reasoningEffort": "minimal"
}
```

固定路由加链——路由必须是该链的成员：

```json
{
  "alias": "jarvis-worker-test",
  "participant": { "kind": "peer", "name": "jarvis", "device": "jarvis-host" },
  "provider": "kilo",
  "model": "nvidia/nemotron-3-ultra-550b-a55b:free",
  "chain": "free"
}
```

### 链与固定路由

链选择会滚动：具体路由是第一个就绪成员，并可能随成员冷却与恢复而变化，因此适合
限流的免费组。固定路由稳定，但一旦目录无法再证明其价格、训练结论或努力级别就会被
拒绝——它绝不会回退到另一个模型。两种情况下主机都报告实际运行的路由，并在切换时
重新评估策略。

## 失败姿态

每次读取都失败关闭。链工件缺失意味着没有链可解析；规则引擎故障回答空目录而不是
未 gated 的目录；缺少零价格证明会拒绝价格要求策略；缺失或畸形游标是错误，而不是
静默返回第一页。插件绝不检查设置文档来编造链成员，也绝不代理 `settings.describe`。

## 测试

包测试使用 profile 的 Vitest 配置，覆盖 glob 语义、目录事实表（零价格、付费、
未知价格、gated、训练、不训练、未知训练）、链解析与发现/评估之间的漂移、固定与
链授权、努力级别校验、过滤器、分页以及 `apply` 接线。
`tests/generate-pairings-routing.spec.ts` 固定 fleet routing 的黄金渲染及严格校验。
