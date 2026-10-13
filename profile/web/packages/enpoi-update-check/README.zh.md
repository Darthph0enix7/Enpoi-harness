# dsh-enpoi-update-check

[English](README.md) | 中文

主机侧更新检查与两阶段应用内更新运行（docs/plan/ui-update-manifest.md P2 + P4）：读取按渠道划分的更新目录，与本机安装记录的版本比较，并通过 `updateCheck` Remote 命名空间暴露结果。检查仅供告知；运行只由显式的 `updateCheck.start` 启动。操作者的 `[立即更新]` 点击是对**准备**（`dsh update --prepare`）的同意，暂存树停留在 `$PREFIX/harness/.staged-apply.json`，而 `[重启以更新]` 点击**应用**它（`dsh update --apply`：切换、服务重启、自检、健康检查、保留策略）。

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
| `updateCheck.dismiss` | `{ request: { version } }` | 记录跳过后状态（`version` 缺失时返回 `gateway/bad-request`） |
| `updateCheck.start` | — | 新的运行记录（两阶段引擎为 `mode: 'prepare'`，旧引擎为 `mode: 'one-shot'`，`phase: 'starting'`）；无可用更新、已有运行进行中、更新已准备好、shim 缺失或启动失败（含找不到可用 Node.js 运行时）时返回 `gateway/bad-request` |
| `updateCheck.apply` | — | 新的应用记录（`mode: 'apply'`，`phase: 'applying'`）；无暂存内容或启动失败时返回 `gateway/bad-request` |
| `updateCheck.run` | — | 当前运行记录；本机从未启动过运行时为 null |

Remote 参数镜像描述符的**参数名**：`dismiss` 包裹其 `request` 对象（`payload.args.request.version`），所有无参方法都传空的 `args` 对象。该插件系列没有客户端推送；客户端轮询 `updateCheck.status`，引擎进程执行期间另轮询 `updateCheck.run`。

## 运行更新（P4）

`updateCheck.start` 固定可用目标与渠道，写入 `$DSH_HOME/update-check/run.json`，清空 `$DSH_HOME/update-check/run.log`，并分离式启动已安装的 `dsh` shim；`updateCheck.apply` 对其记录的暂存树重复同样过程。被跳过（dismissed）的版本仍可启动——跳过只隐藏客户端指示器，设置页控件会重新武装更新；而已准备好的更新会被 `start` 有意拒绝（`already-prepared`）：暂存目标由引擎记录固定，此时应提供的是“重启以更新”。

- **能力探测。** 两阶段标志只存在于较新的引擎中，因此控制器在每次插件启动时探测一次已安装的 shim（`<shim> update --help`，上限 10 秒）并缓存结果。只有帮助输出包含 `--prepare` 才算支持；探测失败、超时或输出为空一律按不支持处理——猜错的代价是旧设备上的第一次更新直接失败。
- **档位。** 支持的引擎使用 `dsh update --channel <c> --prepare`（`rung: 'two-phase'`）：运行暂存树并停留在 `prepared` 直到 `apply`。旧引擎使用一次性 `dsh update --channel <c>`（`rung: 'one-shot'`）：这次运行自行包含切换与服务重启，永远不会变成 `prepared`，且 `updateCheck.apply` 会以明确的“无内容可应用”拒绝。`launcher` 记录操作系统档位（`systemd-run|launchctl|setsid|spawn`）；`rung` 记录引擎代际。

- **启动环境。** Web 服务的环境不是登录环境，因此启动器自行探测 Node.js 运行时——安装记录的 `$PREFIX/runtime/node/current/bin`、nvm 布局（`$HOME/.local/share/nvm/<version>/bin`，其次 `$HOME/.nvm/versions/node/<version>/bin`，取最新版本）、继承的 `PATH`，最后是常见系统目录——包装脚本在 exec shim 前导出组合后的 `PATH` 以及 `DSH_HOME`/`PREFIX`。全部落空时以该列表写入 run.json 的 `reason`，而不是让引擎打出晦涩的错误。
- **阶梯。** Linux：`systemd-run --user --unit=dsh-update-<runId> --collect --wait`；macOS：`launchctl submit -l com.dsh.update.<runId>`；各处兜底：`setsid`，最后是裸的分离式 `sh`。所有阶梯都运行同一个 POSIX 包装脚本，它把更新器自身的 pid 记入 `$DSH_HOME/update-check/run.pid`，并把 stdout+stderr 重定向进 `run.log`。
- **阶段。** 两阶段：`starting` → `preparing` → `prepared`（准备进程以 0 退出并留下暂存标记；等待期间不观察任何进程）→ `applying` → `success | failed | rolledback`。一次性：`starting` → `preparing` → `success | failed | rolledback`（永不 `prepared`）。观察者每秒轮询日志末尾与包装脚本 pid 文件：从引擎的 `[N/9]` 标记解析 `step`/`steps`、`lastLine`、受限的 40 行 `logTail`，以及终局结果行（`successfully updated` / `Update applied:` / `FAILED` / `rolled back`）。
- **重启对账。** 任一档位的切换都会重启服务，观察者随之消亡。插件启动时依据日志末尾（观察者错过的终局行）、暂存标记与安装身份对记录做对账：带标记的 prepared 记录原样保留；更新器仍存活则恢复观察；安装版本已等于目标则记 `success`；其余情况记 `failed` 并附明确原因。对账是幂等的，且从不删除日志（界面读取其末尾）。

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
