# dsh-enpoi-heavy-providers

[English](README.md) | 中文

Enpoi Harness Web profile 的 HEAVY 提供方类别。提供方会出现在 Add Provider 中，但在操作者添加之前不安装任何东西。添加时要么复用本机已在运行的实例（零安装），要么启动可轮询的本地安装任务；只有每一步和受信任的主机回执都成功后，才会写入路由。删除会取消路由，对自有安装执行清单中的卸载步骤，并清理凭据、密钥池状态、发现缓存、主机引用和生命周期记录。

本包拥有清单表、`enpoiHeavy` Remote 命名空间、任务管理器、生命周期存储和 CLIProxyAPI 安装助手。

```sh
cd profile/web
pnpm vitest run packages/enpoi-heavy-providers/tests
```

## 提供方与平台

| 提供方 | 路由 | 本地安装 |
| --- | --- | --- |
| `freellmapi` | `openai-completions`，一个统一密钥 | Linux 使用 Docker/Podman compose；macOS/Windows 使用厂商桌面应用 |
| `antigravity` | `openai-completions`，无密钥 | npm 包，Linux 为 systemd 用户单元，macOS 为 launchd 代理 |
| `commandcode` | 自有适配器命名空间与凭据池 | 运行 `enpoi-commandcode-provider` 的 `install.mjs`（直连厂商路由） |
| `meridian` | `openai-completions`，无密钥 | npm 包，由用户服务托管 |
| `cliproxyapi` | `openai-completions`，可选统一密钥，端点目录权威 | 经验证的发布包，Linux 为 systemd 用户单元，macOS 为 launchd 代理；Windows 无本地路径 |

每个服务的默认地址均为回环。部署相关端点只存在于私有的 `$DSH_HOME/heavy-server-overlay.json`，不会进入随包清单表。`delivery: 'direct'` 清单通常需要密钥池或非无密钥的认证类型。

## 安装生命周期

1. `enpoiHeavy.install` 会在创建任务之前拒绝重复的已配置路由、不受支持的平台、缺失的运行时、缺失的声明助手文件，以及助手返回的端口拒绝。
2. Node/systemd 变体还会在用户管理器无响应时拒绝。CLIProxyAPI 在 Linux 上声明 `requires: ['systemd-user']`，因此即使其步骤命令只运行 `node`，助手的单元配置需求也会被覆盖。
3. 任务通过子进程接缝执行清单步骤。步骤从环境变量读取主机路径（`DSH_HEAVY_HOME`、`DSH_HEAVY_DSH_HOME`、`DSH_HEAVY_PROFILE_DIR`、`DSH_HEAVY_HELPER`）；命令文本从不插入路径，因此路径中的 `$`、反引号、引号或反斜杠无法展开或执行。助手从本插件自身的模块位置解析，不假设 Web profile 的 `packages/` 布局，并在挂载时拒绝相对的 `profileDir` 配置。
4. 终结器会重新检查重复路由守卫，读取受信任回执和安装器生成的密钥，发现端点目录，并原子地提交路由与凭据。`SETTINGS_CONFLICT` 会用重新读取的修订重试；任务运行期间出现的路由绝不会被覆盖。
5. 端点权威路由的列表若为 `failed` 或 `unauthorized`，则不写路由（已安装的服务保留以便重试）。有效的空列表会写入已知为空的发现缓存记录（`models: []`、`fetchedAt`），使 `resolveRouteModels` 返回 `knownEmpty`，而不是在尚无上游账号的首次安装时拒绝。

删除会先取得提供方任务锁。仅删除自有本地安装的路由时，会保留生命周期记录和安装器生成的凭据：服务仍在运行，之后的检测实例添加会再次读取该密钥，而不是触发匿名授权守卫。`uninstall: true` 会执行清单卸载步骤并清理两者。

## 密钥语义

- 自有的 CLIProxyAPI 安装会生成自己的客户端密钥。`enpoiHeavy.install` 对该提供方故意忽略客户端传入的 `key`：安装器生成的值通过经验证的回执读取，在发现之前存储，且绝不会出现在线上回复、任务快照或路由配置中。
- 检测到的或外部实例接受操作者输入的密钥（`reuse.key`）；只有路由提交成功时才会通过凭据接缝存储。
- `auth.kind: 'none'` 路由始终匿名。`unified` 路由一旦存在显式或已存密钥就变为带密钥路由。
- 助手的 bootstrap/管理密钥与客户端密钥分离。`enpoiHeavy.status` 为自有本地安装暴露 `bootstrapPath` 与 `managementKeyPath`（仅路径），让仪表板能指出在本机何处读取登录密钥。

## 线上接口

`enpoiHeavy.manifests`、`status`、`reuse`、`install`、`job` 和 `remove` 是唯一入口。相关形状：

- `reuse` 成功时返回 `{ ok, catalog, route, health, models, credentialStored, endpoint, port? }`；`catalog` 是写入路由所依据的类型化 `{ state: 'fresh' | 'empty' | 'unauthorized' | 'failed', models, status?, error?, source }`。客户端应把 `empty` 视为有效的已知空答案，并让 `failed`/`unauthorized` 对操作者可见。
- `install` 返回 `{ ok, job }` 或 `{ ok: false, blocked | pendingRestart }`。客户端提供的 `receipt` 会被拒绝。客户端提供的 `key` 对不由安装器生成密钥的提供方有效；对 CLIProxyAPI 则被忽略（并记录日志）。
- `status` 报告 `mode: 'local' | 'reuse' | 'unknown'` 与 `installedByHarness`；没有路由的自有安装仍保持 `mode: 'local'` 与 `installedByHarness: true`，使该行仍可提供卸载。成功的自有本地状态还会携带 `bootstrapPath`/`managementKeyPath`。
- overlay 条目接受 `disabled`、`label`、`summary`、`dashboardUrl`、`docsUrl`、`reuseBaseURL`、`reuseHealthURL`、`installSteps`、`fallbackModel`、`pool` 和 `releaseSource`。

`packages/client/ui-settings-models` 中的预连接回退表镜像本清单表。清单变更后重新生成已提交的 fixture：

```sh
node --experimental-strip-types profile/web/packages/enpoi-heavy-providers/scripts/write-client-mirror.mjs
```

## 发布源

清单或私有 overlay 可将 `releaseSource` 设为 `https://` 发布 API URL 或 `owner/repo` slug。仅当生效清单声明该字段时，安装步骤才会传递 `--releases-api` 或 `--repo`；省略时保留助手的上游默认值。既不是 https URL（不含内嵌凭据或片段）也不是 `owner/repo` slug 的值会被 overlay 清洗器丢弃，并被 `manifestProblems` 拒绝。

## 配置

```yaml
- id: enpoi-heavy-providers
  name: dsh-enpoi-heavy-providers
  config:
    profileDir: /absolute/path/to/the/running/profile
```

`profileDir` 只是启动器提供的 `profileContext.dir` 的回退值；它必须是绝对路径。仍使用 `{profileDir}` 占位符的清单（commandcode 的安装步骤）需要它。CLIProxyAPI 不再需要。

## Model Experience

### 路由注册（间接）

#### What the model sees

间接地，通过 `dsh-llm-pi-ai` 的路由解析和操作者的模型选择：本包写入 `providers.<id>` 行（`baseURL`、认证、模型条目、容量、推理层级），解析层随后将其物化为请求。本包不添加任何提示词文本、工具模式或消息内容。端点披露的模型字段仅在列表或共享注册表提供时才会存储；不会凭空生成。

#### Token effect

直接 token 影响为零。路由的模型条目决定消费者执行的上下文与输出预算；有效的空列表提供空目录，而不是伪造的模型 id。

#### KV Cache effect

独立。本包从不贡献请求 token，因此自身无法使已有前缀失效。替换路由（新的 `baseURL`、密钥或模型列表）会改变消费者发送的内容，并可能使该路由的提供方侧缓存复用失效；追加模型或容量披露不会。

## Known Limitations and Deferred Work

- **真实主机验证** — 测试不执行真实安装、升级、删除、服务管理器切换或仪表板抓取；Linux systemd、macOS launchd 和发布归档形状仍需在一次性主机上验证后才能决定发布。
- **助手能力是可选的** — 仅当已安装助手提供 `preflightCliProxyApi`（端口预检）和 `--releases-api`/`--repo` 标志时，主机才会使用它们；缺少这些能力的旧助手会跳过预检，并在助手边界拒绝声明的 `releaseSource`。
- **macOS launchd 日志** — launchd plist 现在把 `StandardOutPath`/`StandardErrorPath` 写到自有提供方根目录下的 `logs/`，而不是 `~/Library/Logs`；清单提示指向自有根目录，真实主机上的日志轮转尚未验证。
- **发现缓存并发** — 已知空记录使用共享文件格式/版本写入，但本包的写入器不属于 `enpoi-provider-sync` 的进程内写入链；同步过程在读取与重命名之间写入另一路由时可能丢弃本路由记录。下一次成功添加/同步会修复。
- **客户端镜像** — 已提交的 `packages/client/ui-settings-models/tests/expected/heavy-provider-mirror.json` 已从本表重新生成；客户端回退源码必须采用相同的命令文本（环境变量形式的助手调用），其一致性测试才能通过。
- **仪表板面板资源** — 发布二进制是内嵌 `/management.html` 还是需要安装器解压 `static/management.html` 尚未验证；清单保留跳转 URL，但无法保证面板被提供。
- **Windows** — CLIProxyAPI 与 Meridian 没有受支持的 Windows 本地安装；检测实例和自定义路由仍可用。其他步骤通过 Git Bash 运行，未在 Windows 上验证。
- **密钥唯一来源** — 安装表单中输入的 CLIProxyAPI 密钥按设计被忽略；UI 应禁用或标注该字段，而不是让输入值看起来已生效。
