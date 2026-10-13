# dsh-enpoi-update-check

[English](README.md) | 中文

主机侧更新检查与应用内更新运行（docs/plan/ui-update-manifest.md P2 + P4）：读取按渠道划分的更新目录，与本机安装记录的版本比较，并通过 `updateCheck` Remote 命名空间暴露结果。检查仅供告知；运行只由显式的 `updateCheck.start` 启动——操作者的 `[立即更新]` 点击就是重启决定，之后运行自行推进到切换与重启。

## 功能

- 检查**本机安装渠道**的目录（`install-state.json` → `channel`；缺失或不可读时为 `stable`），启动后约 30 秒（含抖动）检查一次，之后每隔 `intervalMinutes`（含抖动）检查一次。
- 目录 URL 遵循 `harness-release.yml` 发布的约定：`https://raw.githubusercontent.com/Darthph0enix7/Enpoi-harness/catalog/<channel>.json`（分支 `catalog`，文件为分支根目录下的 `<channel>.json`；同一份 JSON 也会作为 `update-catalog-<channel>.json` 发布资产提供）。
- 将 `install-state.json` 的 `version`/`commit`（版本回退到运行树的 `package.json`）与目录中最新的条目比较。版本比较器按数值处理 `0.1.7-enpoi.<n>` 形态；无法解析的版本保持 `unknown`。
- 状态：`unknown`（从未获取，或没有成功先例的失败）→ `current` → `available` → `dismissed`。失败会保留上一次成功比较的结果并记录 `error`；跳过之后出现更新的目录版本会重新触发 `available`。
- 完全失效无害：每次尝试只做一次有界获取（15 秒超时），下一个间隔之前不重试，每次失败最多输出一行 debug 日志。
- 跳过记录持久化在 `$DSH_HOME/update-check/dismissed.json`（原子写入；存储失败降级为"未跳过"）。

## 配置

补丁行 id `enpoi-update-check`：

```yaml
- id: enpoi-update-check
  name: 'dsh-enpoi-update-check'
  config:
    enabled: true
    intervalMinutes: 360
    jitterSeconds: 300
```

`enabled: false` 只停止定时器；`updateCheck.checkNow` 仍可用。

## Remote 接口

| 方法 | 请求 | 结果 |
|---|---|---|
| `updateCheck.status` | — | `{ state, current: { version, commit, channel }, latest?: { version, commit, releasedAt, notes }, checkedAt?, error? }` |
| `updateCheck.checkNow` | — | 一次检查之后的状态（与定时器共享单次飞行；永不拒绝） |
| `updateCheck.dismiss` | `{ version }` | 记录跳过后状态（`version` 缺失时返回 `gateway/bad-request`） |
| `updateCheck.start` | — | 新的运行记录（`phase: 'starting'`）；无可用更新、已有运行进行中、shim 缺失或启动失败时返回 `gateway/bad-request` |
| `updateCheck.run` | — | 当前运行记录；本机从未启动过运行时为 null |

该插件系列没有客户端推送；客户端轮询 `updateCheck.status`，运行进行中时另轮询 `updateCheck.run`。

## 运行更新（P4）

`updateCheck.start` 固定可用目标与渠道，写入 `$DSH_HOME/update-check/run.json`，清空 `$DSH_HOME/update-check/run.log`，并以 `dsh update --channel <channel>` 分离式启动已安装的 `dsh` shim：

- Linux：`systemd-run --user --unit=dsh-update-<runId> --collect --wait`；macOS：`launchctl submit -l com.dsh.update.<runId>`；各处兜底：`setsid`，最后是裸的分离式 `sh`。所有阶梯都运行同一个 POSIX 包装脚本，它把更新器自身的 pid 记入 `$DSH_HOME/update-check/run.pid`，并把 stdout+stderr 重定向进 `run.log`。
- 观察者每秒轮询日志末尾并刷新记录：从引擎的 `[N/9]` 标记解析 `step`/`steps`、`lastLine`、受限的 40 行 `logTail`，以及按文档化步骤区间表得到的 `phase`（1–2 fetch、3 verify、4 unpack、5 deps、6–7 profile、8 switch、9 selfcheck）。终局结果行设置 `result`（`success` / `failed` / `rolledback`）；没有结果行的退出记为 `failed`，原因是最后一行。
- 切换时服务会重启，观察者随之消亡。插件启动时对记录做对账：更新器仍存活则恢复观察；安装版本已等于运行目标则记 `success`；其余情况记 `failed` 并附明确原因。对账是幂等的，且从不删除日志（界面读取其末尾）。

## 挂载位置

作为 `profile/web/package.json`（`dsh.profile.bundles`）中的主机 bundle，其挂载行在本包的 `cordis.patch.yml`（id `enpoi-update-check`）。

## 构建

```sh
bash profile/web/build-plugins.sh profile/web
```

## 测试

```sh
cd profile/web && ./node_modules/.bin/vitest run packages/enpoi-update-check
```
