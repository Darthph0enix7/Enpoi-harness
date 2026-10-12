---
description: "无依赖的增量更新引擎（设计文档 95，P2）：清单哈希、完整保留/分类决策矩阵、内嵌三方合并、带日志与合格校验的分阶段 apply。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-update-engine

[English](README.md) | 中文

## 概述

在两个发布版本之间计算并执行更新，同时不丢失用户添加或修改的任何内容。本包是最优安装/更新设计（`dsh-migration/95-optimal-install-update-design.md`）的 P2 部分：清单工具（§2.1）、完整决策矩阵（§3.2）、内嵌三方合并网（§3.1–§3.5），以及带中断日志与合格校验的分阶段 apply（§2.3）。它是不依赖任何外部依赖、不使用 Cordis、不调用宿主 `git`/`diff3` 的纯 Node/TypeScript 实现；它只接受显式传入的树根路径，绝不猜测任何前缀。`scripts/install.sh` 会在每次预构建更新中将它作为 CLI 调用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### CLI

CLI 的所有路径都必须显式给出，任何内容都不会从已安装布局推导。

```
dsh-update-engine hash    --root <dir> --out <manifest.json> [--ignore <glob>]...
dsh-update-engine plan    --previous <manifest> --next <manifest> --local <dir> --base <dir>
                          --release <dir> --to-version <v> [--from-version <v>]
                          [--tombstones <file>] [--pins <file>] [--out <plan.json>]
dsh-update-engine apply   --plan <plan.json> --local <dir> --base <dir> --release <dir>
                          --staging <dir> [--journal <file>] [--timestamp <iso>] [--backup <dir>]
dsh-update-engine discard --staging <dir> [--journal <file>]
```

计划需要中止时（运行时代码合并冲突）`plan` 退出码为 3，否则为 0；`apply` 在 applied/no-op/interrupted 时退出码为 0，aborted 为 3，日志属于其他计划需要回滚时为 4，失败时为 1。`--pins` 读取 `pins.yaml`，接受 JSON 数组或简单 YAML 列表两种形式；`--tombstones` 亦然。

### 编程接口

`buildPlan` 将（上一版清单、新清单、本地扫描、墓碑列表、pin 列表）分类为每条路径恰好一个动作，并在内存中完成所有合并；`applyPlan` 在从本地树播种的 staging 目录上执行该计划；`verifyStagedTree` 可单独运行合格校验；`createBackup` 写入 §3.5 的更新前备份闩锁。计划可序列化为 JSON 且与指纹绑定：`parsePlan` 会拒绝指纹与内容不符的文档。

## Understand the implementation

### 清单规则

清单是一个 JSON 对象，将相对的 `/` 分隔路径映射到 `{sha256, size, type, mode, target, binary}` 条目；输出时键有序，因此相同目录树产生逐字节相同的清单。普通文件哈希其字节；符号链接哈希其目标字符串并记录 target；目录以空哈希列出；当文件前 8192 字节内出现 NUL 字节时 `binary` 为真。mode 为 POSIX 权限位（`mode & 0o7777`）。从清单读取的每条路径都会校验其位于对应根目录之下。

### 决策矩阵

§3.2 矩阵覆盖三份清单路径的并集，每条路径恰好得到一个动作。`unchanged/unchanged` 跳过；`unchanged/changed` 替换；`modified/unchanged` 保留本地文件；`modified/changed` 执行三方合并；未跟踪路径一律保留；新发布路径与未跟踪路径冲突时保留用户文件并写出 `<file>.shipped-<version>` 边车；本地缺失且无墓碑时从发布树恢复（完整性失败）；墓碑被尊重（apply 后该路径不存在）。仅存在于上一版清单中的文件，只有未被修改且新清单中不存在时才会删除（§3.4），且删除最后执行。pin 排除替换、合并与上游删除；没有可替换内容时 pin 不抑制任何动作，缺失的 pinned 路径仍会被恢复。

### 合并引擎

基线是已安装版本经校验和验证的原始归档（保留的 `.bases/<version>.tar[.gz]` 或缓存的完整发布包），以只读方式解包；永不远程获取基线。没有该归档时，双方都改动的文件保留本地字节并写入随包边车，报告会说明这一点。`merge3` 通过 patience 锚点 LCS（带有限的动态规划回退）计算匹配，并在两侧均未改动的行处切分文件，然后按 diff3 区域规则处理；相邻的不同侧修改会像 GNU diff3 一样冲突。默认冲突标记为 `<<<<<<< local`、`||||||| baseline`、`>>>>>>> shipped`。双方都改动的二进制文件绝不进行文本合并：保留本地，并将随包字节写入 `<file>.new-<version>`。

### 冲突分级

配置/数据冲突保留本地、写出 `.new-<version>` 检查边车，apply 继续执行。运行时代码冲突（`.js`、`.mjs`、`.cjs`、`.jsx`、`.ts`、`.tsx`、`.mts`、`.cts`、`.wasm`、`.node`）将计划标记为 `switchDecision: 'abort'`：apply 在活动文件旁写出检查边车并返回，完全不触碰 staging，因此当前版本保持活动。

### 扫描索引

`scanTree` 消费并刷新 `<tree>/.dsh-scan-index`（doc 97 §3）：一个紧凑的、按路径索引的 stat 缓存，字段 BigInt 安全（mtime/ctime 纳秒、inode、设备号），并以 tmp+rename 原子写入。信任锚点是索引文件自身的 mtime；仅当新 stat 完全匹配、且两个时间戳都严格早于索引文件时才信任条目（racy-git 规则，ctime 封堵 `utimes` 绕过）。缺失/损坏/未来时间戳的索引回退为一次带进度的完整扫描并重写；保留路径对每个遍历、分类与校验面都不可见，成功的 apply 会在目录改名之前为新树写入索引。

### 分阶段 apply 与校验

播种阶段用硬链接把本地树链接进 staging；每次写入都先 unlink 目标，再经过固定名的临时文件加 rename，因此任何写入都不可能通过共享 inode 修改活动树。日志将 staging 目录绑定到计划指纹，记录每个完成的动作，并在每个阶段写入。指纹匹配的再次进入会幂等恢复（每个动作重新检查并修复其 staged 状态）；指纹不匹配会报告为 `rollback-required`，因为该 staging 目录属于另一个计划。`stopAfterActions` 是崩溃恢复测试使用的确定性中断点。合格校验只接受：随包路径等于清单哈希、保留路径等于记录的 merge-keep/merge-output 哈希、墓碑路径缺失、每个未跟踪路径存在且被列出；它还会报告任何计划未解释的 staged 路径。该过程最后重新哈希被触碰的活动路径，证明其 inode 与哈希未发生变化。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/manifest.ts`](src/manifest.ts) | 树扫描、哈希规则、schema 读写、路径安全 |
| [`src/plan.ts`](src/plan.ts) | §3.2 分类、合并解析、指纹 |
| [`src/diff3.ts`](src/diff3.ts) | 内嵌 LCS/diff3 合并引擎 |
| [`src/apply.ts`](src/apply.ts) | staging 播种、写时复制动作、日志阶段、活动树门禁 |
| [`src/verify.ts`](src/verify.ts) | 合格校验契约 |
| [`src/backup.ts`](src/backup.ts) | §3.5 更新前备份闩锁 |
| [`src/journal.ts`](src/journal.ts) | 日志读写与阶段记录 |
| [`src/report.ts`](src/report.ts) | 结构化与人类可读更新报告 |
| [`src/pins.ts`](src/pins.ts) | pin/墓碑列表解析 |
| [`src/glob.ts`](src/glob.ts) | 相对路径 glob 匹配 |
| [`src/cli.ts`](src/cli.ts) | 基于显式目录的 CLI |

<a id="further-exploration"></a>
## 进一步阅读

先读本包实现的设计文档，再读调用它的更新器。

- 95 — 最优安装与更新系统（`~/dsh-migration/95-optimal-install-update-design.md`，位于本仓库之外）— §2.3 分阶段 apply、§3 保留矩阵、§5 报告、§8 P2 范围。
- [`scripts/install.sh`](../../../scripts/install.sh) — 调用本引擎（`delta_apply_delta`/`delta_apply_full`）并负责传输、原子 `switch_current` 与回滚的更新器。

<a id="model-experience"></a>
## Model Experience

无。本包没有任何内容进入模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **传输、原子切换与回滚由更新器负责。** 本包负责构建并校验新树以及报告；差分应用、阶梯档位选择与 `current` 切换不在范围内。
- **目录与符号链接不参与合并。** 双方都改动的目录或符号链接保留本地并报告；只有普通文本文件进入合并引擎。
- **删除目录时绝不删除未跟踪内容。** 计划删除的非空目录会被保留并报告为 `retained`。
- **运行时代码分级基于扩展名。** 二进制模块路径（`.node`、`.wasm`）双方都改动时与其他运行时代码一样中止。
- **非空墓碑目录会被保留**（其中含未跟踪内容）；校验接受该保留目录，报告会明确列出。
- **备份闩锁复制目录而非打包 tar。** 修改与未跟踪文件逐字节复制并附带 `baseline.json`，以维持零依赖约束。
- **大小写不敏感文件系统行为不在此处验证**（设计 §7.5）；它需要平台验收通道。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

设计文档留待决定的取舍记录于此，便于 P3 与 CI 清单生成器保持一致：

- 符号链接的哈希输入是原始目标字符串（`sha256(target)`），条目记录 `target` 与 lstat mode。
- 边车命名：未跟踪文件冲突时 `.shipped-<version>` 携带新随包字节；`.new-<version>` 携带带冲突标记的合并尝试（二进制/类型冲突时为随包字节）。
- 合并保留本地文件 mode，因此用户的 mode 位修改能在内容合并后保留。
- 即使文本合并产生冲突标记，配置/数据冲突也继续执行；只有运行时代码冲突会中止。
- `stopAfterActions` 与显式 `timestamp` 用于让 apply 保持确定性与可测试；生产调用方传入真实时间戳并省略中断点。
- 日志默认位置为 `<stagingRoot>.journal.json`（在 staged 树之外），因此 staging 扫描永远不会遇到日志。

</details>
