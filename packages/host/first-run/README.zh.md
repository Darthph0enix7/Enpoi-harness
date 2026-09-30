---
description: "在全新安装上写入免密钥的 Kilo Gateway 路由，并运行需显式选择的只读 sysadmin 调查以生成系统档案。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-first-run

[English](README.md) | 中文

## 概要

全新 harness 主目录的两个首次运行事实。种子在全新设置文档首次完整启动时写入免密钥的 Kilo Gateway 路由，并把默认模型指向 `kilo-auto/free`；该路由位于用户层，因此 Models 页面可以移除它，标记会阻止之后的再次写入。系统分析是显式选择：用户从设置向导的智能体步骤或右下角小窗启动，随后一个有界的 sysadmin 智能体会话使用 harness 自身的工具只读地调查这台机器，覆盖六个清单阶段，并发布结构化 `system-profile.json` 与简短、概括的 `system-profile.md`，后者以 `## At a glance` 摘要开篇。文档只记录这台机器是什么类型、用于什么，并停在类别层面，不含确切版本、项目名、域名、地址或主机名，因此在机器变化后仍然有用。挂载在 sysadmin 预设中的提示上下文只贡献从该 JSON 读取的要点以及对文档的引用。没有任何机制会自行安排运行。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

在全新安装需要无密钥即可与模型通信的位置挂载种子行。写入的路由指向公共网关端点 `https://api.kilo.ai/api/gateway`，绝不假定本机服务器。

```yaml
- name: '@deepseek-ai/dsh-host-first-run'
  config:
    enabled: true
    provider: kilo
    model: kilo-auto/free
```

在浏览器可达的位置挂载分析路由，并在 sysadmin 智能体预设内挂载上下文行。

```yaml
- name: '@deepseek-ai/dsh-host-first-run/analysis'
  config:
    preset: sysadmin
    permissionPreset: system-analysis
    timeoutMinutes: 15

- name: '@deepseek-ai/dsh-host-first-run/context'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 未存标记时运行种子 |
| `provider`, `model` | `kilo`, `kilo-auto/free` | 种子写入的路由 id 与免费模型 |
| `seedVersion` | 空 | 标记；任何已存值都表示种子已经决定过 |
| `routes` | `true` | 注册 `/system-analysis/start`、`/status`、`/context`、`/accept` 与 `/reject` |
| `preset` | `sysadmin` | 负责调查的智能体预设；仅为该会话挂载 |
| `permissionPreset` | `system-analysis` | 强制用于调查会话的权限预设；它把写入限制在该运行自己的临时工作区，且不发起审批提示，因为无人值守该运行 |
| `timeoutMinutes` | `15` | 单次调查的硬性上限 |

运行是单例的，且只在客户端显式操作时启动。运行中或已结束时 `start` 返回当前视图，`status` 不会改变它，`context` 返回已存文档或 null，`accept`/`reject` 记录操作员的决定。调查智能体维护一个待办清单，条目即清单各节，宿主把该清单映射到小窗的阶段轨道；智能体用普通的 `write` 工具把 `profile.json` 与 `system-profile.md` 写入该运行的临时工作区，宿主再把两份文件复制到 harness 主目录。缺少智能体运行时、未知预设或超出时限都会让运行以原因失败于任务视图，且不影响 harness。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

种子等待 Loader 完成（`ctx.root.loader.await()`），确保 `llm-pi-ai`、`agent-default-model` 与 `first-run` 条目已激活，然后按序写入提供方路由、默认模型与标记。失败只记一条警告并保留未写标记；下次启动重试。已带提供方路由的设置文档属于已配置安装：种子只写标记。

一次调查就是配置预设上的一个根智能体会话：运行器解析预设、固定其修订（`acquireScope`）、清空 harness 主目录下的临时工作区、以该工作区为 `cwd` 创建会话、设置配置的权限预设、设置标题，并把清单提示作为开场用户消息发送。提示约束智能体对主机做只读调查，要求使用精确的待办条目驱动阶段轨道，列出六个清单阶段（machine、usage、hosting、networking、tooling、write profile），并携带概括规则：不含确切版本号、文件夹/仓库/项目名、域名、IP 地址或主机名，不做清单式枚举，硬件只到类别层面，且每一条断言都以实际观察为依据而不引用探测过程。它要求在工作区写出 `profile.json` 与 `system-profile.md`（约 60 至 120 行，以 `## At a glance` 摘要开篇）。运行器跟随会话的 `todo_write` 事件推进阶段，等待回合收尾，校验两份文件，允许两次有界的纠正回合，然后原子写入 `system-profile.json` 与 `system-profile.md` 并释放会话。已发布的文档若仍带有确切机器事实（IPv4 地址、点分版本号或域名式字符串），仍会被存储，并记录匹配到的事实，因此运行不会仅因风格问题失败。存储文档的头部只添加调查来源；它不含时间戳，因此文档在多次运行之间保持稳定。整个运行受配置时限与插件生命周期取消约束。

上下文提供方每次组装读取该文档，缺失时回退到 `DEFAULT_SYSTEM_CONTEXT`；存在 JSON 时，在引用之前附加一行从其读取的、有界的要点。

[`src/index.ts`](src/index.ts) 负责种子，[`src/analysis.ts`](src/analysis.ts) 负责运行器与路由，[`src/investigation.ts`](src/investigation.ts) 负责会话、提示、阶段映射与工作区，[`src/context.ts`](src/context.ts) 负责预设作用域内的贡献。不发布运行时不变式伴随模块：已存文档是唯一的持久事实，并在测试中回读。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型所见

sysadmin 会话接收一个动态上下文条目 `system-analysis`。在任何调查运行之前——或操作员拒绝该文档之后——其文本为以下逐字默认文本：

```markdown
System profile: no analysis is stored for this machine yet.
Hardware, operating system, service and hosting facts are unknown here.
Confirm them with read-only commands before acting, or run the system analysis.
```

档案存好后，该条目变为一行从 `system-profile.json` 读取的要点（主机形态、CPU、内存、GPU、磁盘；缺失字段省略），后接对完整文档的引用：

```markdown
System profile essentials: server; CPU server-class x86-64, 28 threads; memory 64 GiB class; GPU discrete accelerator, 24 GB class; disk SSD storage, moderate headroom.
Read $DSH_HOME/system-profile.md for this machine.
It is the living, full record of this host; the structured profile sits beside it as system-profile.json.
Confirm anything the document does not state with read-only commands.
```

#### Token 影响

每次组装一个上下文块，大小受要点行加三行引用约束；完整文档绝不内联。分析行本身不添加提示章节，也不添加工具。

#### KV 缓存影响

上下文文本在两次调查之间保持稳定，sysadmin 前缀正常缓存；完成的调查只会替换一次文本，之后的回合保持稳定。调查会话自身的提示每次运行只写入一次。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- sysadmin 预设必须挂载 `@deepseek-ai/dsh-host-first-run/context`；该行由 fork 配置文件拥有，harness 仓库只发布导出。
- 分析只在显式操作（智能体步骤或小窗）时启动；档案被接受或决定被记录后，不再主动提供运行。
- 调查会话以随附的 `system-analysis` 预设运行（workspace-write 沙箱、审批 `never`），且仅限它自己的临时工作区，以便智能体写入两份产物；该目录之外的主机对它仍是只读的，提示禁止其他一切改动。
- 强制程度取决于部署如何命名权限预设；`permissionPreset` 不可用时只记一条警告，并仅依靠提示中的只读规则继续。
- 调查会话不挂载到 Workspace，因此会出现在历史中，但不在某个工作区的会话列表里。
