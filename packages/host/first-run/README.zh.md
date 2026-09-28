---
description: "在全新安装上写入免密钥的 Kilo Gateway 路由，并运行只读系统分析作为 sysadmin 的上下文。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-first-run

[English](README.md) | 中文

## 概要

全新 harness 主目录的两个首次运行事实。种子在全新设置文档首次完整启动时写入免密钥的 Kilo Gateway 路由，并把默认模型指向 `kilo-auto/free`；该路由位于用户层，因此 Models 页面可以移除它，标记会阻止之后的再次写入。分析在用户继续工作时运行一次有界的只读扫描（硬件、操作系统、服务、磁盘，以及存在时的 NVIDIA GPU），通过 `/system-analysis/*` 发布，并保存为 sysadmin 的系统上下文文档。

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

在浏览器可达的位置挂载分析路由。

```yaml
- name: '@deepseek-ai/dsh-host-first-run/analysis'
  config:
    routes: true
```

在 sysadmin 智能体预设内挂载上下文行，让扫描成为该智能体的机器上下文，并在扫描运行前使用文档化的默认文本。

```yaml
- name: '@deepseek-ai/dsh-host-first-run/context'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 未存标记时运行种子 |
| `provider`, `model` | `kilo`, `kilo-auto/free` | 种子写入的路由 id 与免费模型 |
| `seedVersion` | 空 | 标记；任何已存值都表示种子已经决定过 |
| `routes` | `true` | 注册 `/system-analysis/start`、`/status` 与 `/context` |

分析是单例运行：活动或已结束的运行期间 `start` 返回当前视图，`status` 不改变它，`context` 返回已存文档或 null。每个探测相互独立并限制在五秒；缺少工具只把该节降级为具名行，绝不会让扫描失败。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现内部细节——点击展开</summary>

种子等待 Loader 完成（`ctx.root.loader.await()`），确保 `llm-pi-ai`、`agent-default-model` 与 `first-run` 条目已激活，然后按序写入提供方路由、默认模型与标记。失败只记一条警告并保留未写标记；下次启动重试。已带提供方路由的设置文档属于已配置安装：种子只写标记。

扫描使用 `node:os`、`statfsSync` 与有界的 `execFile` 探测（`systemctl`、`nvidia-smi`）；文档在原子上写入 harness 主目录。上下文提供方每次组装读取该文档，缺失时回退到 `DEFAULT_SYSTEM_CONTEXT`。

[`src/index.ts`](src/index.ts) 负责种子，[`src/analysis.ts`](src/analysis.ts) 负责运行与路由，[`src/scan.ts`](src/scan.ts) 负责探测，[`src/context.ts`](src/context.ts) 负责预设作用域内的贡献。不发布运行时不变式伴随模块：已存文档是唯一的持久事实，并在测试中回读。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型所见

sysadmin 会话接收一个动态上下文条目 `system-analysis`，其文本为已存扫描文档，或以下逐字默认文本：

```markdown
System context: no analysis is stored for this machine yet.
Hardware, operating system, service and disk facts are unknown here.
Confirm them with read-only commands before acting, or run the first-run system analysis.
```

#### Token 影响

每次组装一个上下文块，受扫描写入的文档大小约束（服务名最多 20 项）。此包不添加工具、模式或章节。

#### KV 缓存影响

上下文文本在两次扫描之间保持稳定，sysadmin 前缀正常缓存；完成的扫描只会替换一次文本，之后的回合保持稳定。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- sysadmin 预设必须挂载 `@deepseek-ai/dsh-host-first-run/context`；该行由 fork 配置文件拥有，harness 仓库只发布导出。
- 分析只在调用方启动时运行（首次运行向导或操作员）；没有任何调度。
- 服务探测假定 `systemd`；其他平台把该节记为不可用。
