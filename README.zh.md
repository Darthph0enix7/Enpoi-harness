# Enpoi Harness

[English](README.md) | 中文

Enpoi Harness 是**上游 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) 加上我们的运维配置组合**：一个集成了模型服务商、多智能体编排、诊断系统、UI 界面与默认主题的定制分发版，将全插件架构的 `dsh` 运行时转变为开箱即用的多模型智能体集群。

- `packages/` 之前的基础运行时与包基于上游，并维护一组精简的 fork 补丁（`patches/`）。
- `$DSH_HOME/profiles/<name>`（默认 profile：`web`）下的所有内容均为自研：包括 `dsh-enpoi-*` 系列插件包、默认主题、预设角色席位、校验门禁以及 Creator 文档。
- 运维与开发文档：**[docs/creator/](docs/creator/00-index.md)** —— 从索引页面（架构图与操作规范）开始，按需阅读对应专题文件。

<a id="run"></a>

## 安装（Linux 与 macOS，无需 sudo）

```sh
curl -fsSL https://raw.githubusercontent.com/Darthph0enix7/enpoi-harness/stable/scripts/install.sh | bash
```

安装脚本会自动检测系统与架构，优先使用 `PATH` 中已有的 Node ≥ 22.19（缺失时下载隔离运行时至安装前缀目录），通过 corepack 启用 pnpm，安装最新**已发布**的预构建版本（校验和验证，无需构建工具链），初始化 `$DSH_HOME` 配置（设置、预设、技能），并将 `dsh` 启动脚本写入 `~/.local/bin`。整个过程无需 root/sudo 权限，不会覆盖已有的用户设置，且具备幂等性与自愈能力。

<a id="run-from-source"></a>

从本地检出源码运行（测试环境的安装方式）：

```sh
bash scripts/install.sh --source . --channel stable
```

## 更新通道

| 通道 | 说明 |
|---|---|
| `stable`（默认） | 已发布并完成全量验证的稳定构建。省略 `--channel` 时默认使用。 |
| `beta` | 针对下一版本发布的预览测试通道。 |

```sh
dsh update                    # update on the current channel
dsh update --channel beta     # switch to beta (then back with --channel stable)
dsh update --dry-run          # show the plan without touching anything
```

`dsh update` 使用并行分块引擎下载最新**已发布**的平台压缩包（进度条、校验和播报、带计数解包），按标准流程安装、执行健康证明，失败时回滚到上一个版本化目录。已发布版本始终是更新工件：即使通道分支头已领先，也只会输出一行提示并安装该发布版本，绝不会自动改为源码构建；只有操作员显式传入 `--source` 才会执行源码构建，通道没有任何发布版本时则以明确错误停止。`$DSH_HOME` 中的用户数据仅作增量初始化，绝不会被覆盖。旧的 delta/保留更新器已归档（git 分支与标签 `archive/delta-updater-v2`，tip `6d7c3d5bed`），仅在 `DSH_DELTA=1` 时运行；新发布只包含三个平台压缩包、对应 `.sha256` 与 `SHA256SUMS`。服务重启请使用 `dsh restart --after-turn` 安全调度 —— 严禁在智能体运行回合内直接重启服务。

## 自研组件与上游分工

| 自研部分（`dsh-enpoi-*` 插件与 profile） | 上游组件（`deepseek-harness`） |
|---|---|
| 服务商同步、重量级本地提供方集成、密钥池、目录规则、模型链 | 核心运行时、持久化会话日志、客户端框架、插件加载器、基础工具、上下文压缩 |
| 编排系统：角色席位、多方评议（Councils）、Oracle、Keeper、Living Brief、白板、长期记忆 | Web UI 外壳、对话交互、设置框架与大部分内置页面 |
| 诊断账本、验证门禁、Creator 开发者文档 | 桌面端/无头运行打包、SDK 与基准测试 |

在修改上游代码时，请遵循上游的 `AGENTS.md`、`docs/` 及贡献指南。在维护实际运行的 harness 功能时，请以 `docs/creator/` 为准，并在任何改动后同步更新文档。

## 安全与许可证

在赋予智能体终端执行权限前，请务必阅读 [安全说明](SAFETY.zh.md) —— `creator` 与 `sysadmin` 会话具备宿主机的 shell 操作权限。上游代码基于 MIT 许可证分发；本仓库自研包维护于此仓库及配套 profile 中。第三方开源依赖声明参见 [第三方声明](THIRD_PARTY_NOTICES.md)。
