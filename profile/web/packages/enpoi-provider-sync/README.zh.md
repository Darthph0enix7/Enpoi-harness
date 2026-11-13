# dsh-enpoi-provider-sync

[English](README.md) | 中文

Web profile 的模型目录同步插件。每次同步会列出已配置的 `llm-pi-ai` 路由与 Command Code 路由，用路由声明的注册表元数据、models.dev 和已安装目录补全条目，并通过设置读写面写入规划好的记录。Command Code 读取其随包快照，不探测端点。非目录路由的列表还会写入 `$DSH_HOME/cache/discovered-models.json`，供解析层使用。

## 刷新与成员关系

端点权威路由在列表成功获取时，收敛到端点声明的 id。目录权威路由收敛到端点声明且最新 models.dev 提供方确认的 id，并要求两个来源都新鲜。overlay 的 `remove` 列表最后应用。`force`（手动刷新）会绕过无人值守的“删除超过一半”保护。有效集合为空时仍然中止，除非已配置的路由配置显式声明 `catalogAuthority: 'endpoint'`。

只有路由配置显式声明 `catalogAuthority: 'endpoint'` 时，成功返回的空列表才具有权威性。同步从不写入该字段，`metadataSources` 声明也不会提供它。对于显式 endpoint 权威路由，已发现缓存会写入 `models: []` 和新的 `fetchedAt` 时间戳（最近一次成功探测），目录层报告 `knownEmpty`，而不是用已安装目录重新填充。重复成功空探测会更新该时间戳；抓取失败、401 或无效列表内容不会进入该路径，并保留上一次正常时间戳与已存模型，同时标记为降级。端点不再声明的被引用 id 会以 `deprecated: true` 保留，引用消失后才移除。

`providerSync.refreshRoute` 返回清理并集——成员删除与 overlay 删除——这样客户端合并已存行时不会把 overlay 删除的 id 重新带回来。`providerSync.refreshRoutes` 每条路由报告同一个并集。

## 优先级

1. `source: 'manual'` 记录保留其 `manualFields` 列表所命名的字段，优先于列表、注册表元数据和 overlay `upsert`。缺失列表时保留历史七项（`name`、`contextWindow`、`maxInputTokens`、`maxTokens`、`input`、`reasoning`、`reasoningEfforts`）；显式空列表不冻结任何字段。`cost`、`costTiers`、`releaseDate`、`output` 与 `tools` 仅在命名时保留。存在的列表若命名未知字段，会令该路由刷新失败，而不是静默地什么都不冻结。
2. overlay `upsert` 对其中列出的字段优先于列表与推断元数据；操作者在 manual 记录上声明的字段仍然优先。
3. `pinnedModels` 中的 id 与 manual 记录不会被 overlay `remove` 删除，继续作为当前记录保留。
4. overlay `remove` 的 id 若仍被路由内引用，则保留为 `source: 'pinned-in-use'`、`deprecated: true` 的记录，并带上最后一次已知事实。在端点重新声明该 id 之前，它不会再被当作当前成员，本次同步也会报告该弃用。
5. 其他被 overlay `remove` 的 id 会被删除。

清除最后一个手动字段会 unset `source` 与 `manualFields`，让该行回到普通刷新行为。之后的同步可在其上游 id 不存在时删除该行；页面不会立即删除它，也不会替换成提供方默认值。早于 `manualFields` 的手工新增行保留历史七项，不发生迁移写入。

## 模型元数据与价格

存储模型可以携带 `source` 标签：`configured`、`manual`、`discovered` 或 `pinned-in-use`；缺失标签表示较旧配置，不是错误。只有 `manual` 获得成员关系保护。Models 页面写入带显式 `manualFields` 列表的 `manual` 行；目录编辑把相同事实写入逐模型 `modelOverrides` 条目，绝不会物化路由的 `models` 数组。

`cost` 保存美元/百万 token 的目录价格：`input`、`output`、`cache_read` 与 `cache_write`；`costTiers` 保存超过输入 token 阈值后适用的整请求价格；`releaseDate` 是 `YYYY-MM-DD` 目录日期。这些是目录元数据，不是提供方账单：harness 不据此收费，也绝不改变运行时成本或请求预算。从已安装目录或发现回复载入的行可能缺少价格、阶梯或发布日期；操作员可以手动填写，同步绝不编造。`output` 模态是保留的目录元数据，Models 页面不提供编辑。

手动容量优先于较低的披露来源，即使操作员数字超过实际宿主档位也是如此。路由随后按配置容量尝试，提供方可能拒绝请求；不会自动收紧并改写该声明。操作员未设置的字段继续从较低披露来源解析。

## 注册表元数据

`metadataSources` 把已配置的提供方路由 id 映射到精确的注册表声明；随包默认值以固定的 CLIProxyAPI 基线声明 `cliproxyapi`。声明只用于补全：它从不改变成员关系、空列表权威或 `catalogAuthority`，任何模型 id 前缀或厂商族猜测都不会用来选取元数据。声明是按路由 id 索引的数据——重命名的用户自建实例添加自己的 key。

```yaml
metadataSources:
  cliproxyapi:
    source: cliproxyapi
    # optional: exact channel, owner override, or extra owner aliases
    channel: codex-free
    ownerChannels:
      openai: [codex-free]
    # optional opt-in: bounded raw registry refresh, never a rich client projection
    # sourceVersion is required with refreshUrl; the bundled label is never reused
    refreshUrl: https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/master/internal/registry/models/models.json
    sourceVersion: master
```

端点的 `owned_by` 用于限定查找范围；`owner`、`channel` 与 `ownerChannels` 用于重命名自建实例或无法推断 channel 的实例。缺少 owner 与 channel 时按未知处理，绝不退化为仅按 id 查找。同时声明 `refreshUrl` 与实际 `sourceVersion` 会让该路由在后台启动和每小时刷新：各来源并发执行、共享同一个 in-flight promise、销毁时中止，并为正在运行的 pass 保留 last-good 或随包基线。手动刷新立即使用当前 last-good/基线，不等待网络。省略 URL 则完全不进行注册表网络读取。成员关系仍只来自路由的推理 `/models`。注册表只提供精确元数据：不使用 `?client_version` 富投影，不读取 `base_instructions`，不决定成员关系。

解析成功时，注册表字段位于端点自身披露（当主 `/models` 回复省略元数据时，包含同一主机上的只读同源端点，如 Gemini `/v1beta/models`、Anthropic `/v1/models`、LM Studio `/api/v0/models`、LiteLLM `/model/info` 与 Ollama `/api/show`）与按 owner 限定的 models.dev 之间：端点精确字段、同源端点字段、注册表（精确匹配或跨通道共识）、按 owner 限定的 models.dev（仅限已识别的一方厂商 owner，绝不套用于通用自托管引擎）、已安装目录、运行时路由默认值。更大的外部 models.dev `contextWindow` 绝不会覆盖主机实际披露的较小 `maxInputTokens`。`source: 'manual'` 记录仍然赢得操作者声明的每个字段。设置词表之外的原始级别名称只作为诊断保留；只有预算的 `thinking` 记录不会提供命名阶梯。来源 source/version 通过 `provider-sync/registry-metadata` 诊断上报，因为当前设置与已发现缓存 schema 没有来源字段。

## 引用

当路由的默认选择、`enpoi-orchestration.chains` 链接、`enpoi-orchestration.personas` 座位的直接 provider/model 路由、`subagent-model-selection-settings.allowedModels` 条目（也读取 `subagent-model-selection` 拼写）或选择器收藏指向某个模型时，该模型受保护。每次规划以及每次设置冲突重试都会重新读取引用，因此写入进行期间新增的引用仍能保护其模型。

## 能力诚实性

只有当列表声明了阶梯、解析后的注册表记录提供了命名级别，或目录来源提供了可用级别时，阶梯才会写入设置。仅 `reasoning: true` 不会提供阶梯；只有预算的注册表记录保持无阶梯，而不是编造全部六档。未知级别 id 会被丢弃，显式 `off` 保留为无值键，仅含 `off` 的阶梯会被省略，因为设置会拒绝它。`maxInputTokens` 与合并上下文窗口并列持久化。当端点只披露了输入上限（Gemini `/v1beta/models` 的 `inputTokenLimit`、Anthropic 的 `max_input_tokens`）且没有任何来源披露合并窗口时，该上限就是这条路由实际接受的窗口，同样写入 `contextWindow` —— 这是端点自己给出的数字，也正是让较小的托管档位（372K 的 Codex 档）不会被读成厂商的 1M 窗口的原因。来源声明的非正容量（图像模型给出的 `0`）视为未披露并被丢弃：单个这样的值会令 `models` schema 校验失败，从而静默阻断整条路由的写入。没有任何来源披露的容量会被省略，交由路由的 `defaultContextWindow` / `defaultMaxTokens` 在请求时解析，而不是把适配器默认值当作已披露事实持久化。早前轮次已披露的事实绝不会被之后对此沉默的轮次抹去（一次错过的同源探测不会把已描述的模型降级），`unverified: true` 标记的是数字与能力都没有任何来源描述的记录。提供方显式声明 `reasoning: false` 会清除未冻结的推理阶梯；被冻结的 `reasoning` 或 `reasoningEfforts` claim 会保留，不受该拒绝影响。

## 容量与补全来源

随包配置不再声明 `capacityDefaults`。该配置键仍然可被解析以保持兼容：设置它的操作者是在声明一个显式的路由级假设，同步绝不会把它当作逐模型事实持久化。只有端点披露、精确注册表记录、models.dev、已安装目录、`source: 'manual'` 记录或 overlay `upsert` 会进入已存容量；没有来源描述容量的 id 保持未定，由路由在请求时用带来源标记的 `defaultContextWindow` / `defaultMaxTokens` 解析。models.dev 的 `limit.context` 与 `limit.input` 是两个独立事实：只发布输入上限的记录会得到 `maxInputTokens`；当没有披露合并窗口时，端点自身给出的上限会充当 `contextWindow`。

补全在 models.dev、已安装目录与注册表之间只按精确 id 匹配。后缀剥离、厂商族前缀、去掉厂商段的短 id 与大小写折叠拼写都不构成别名；映射列表中靠后提供方的精确记录优先于靠前的非精确记录。真正不同的别名应写入以精确 id 为键的 overlay `upsert`。overlay upsert 会通过共享的 pi-ai 模型 schema 校验；格式错误的文件会被整体拒绝并给出 `provider-sync/catalog-overlays` 诊断，上一份正常文档继续生效。`/models` 回复通过共享列表解析器读取，超过 4 MiB 响应上限会被拒绝。

## 测试

```sh
cd profile/web
pnpm vitest run packages/enpoi-provider-sync
```

## 已知缺口

`metadataSources` 的刷新 URL 与 sourceVersion 尚未暴露在设置 UI 中，目前需要 manifest 或操作者配置编辑来启用。注册表来源/版本与不支持的努力级别字段没有设置 schema 位置，因此在核心 schema 增加之前只作为诊断保留。逐字段容量来源不会被存储，因此未解析容量目前只做省略并交给路由默认值，而不是逐字段标注。已发现缓存现在会保存只有预算的记录中的 reasoning 标志，但核心目录物化目前会忽略该标志；在仅依赖缓存的路由上保留推理能力而不提供命名阶梯，需要适配器侧另行修复。
