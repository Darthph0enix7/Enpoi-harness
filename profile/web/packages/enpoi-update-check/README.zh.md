# dsh-enpoi-update-check

[English](README.md) | 中文

主机侧更新检查（docs/plan/ui-update-manifest.md P2）：读取按渠道划分的更新目录，与本机安装记录的版本比较，并通过 `updateCheck` Remote 命名空间暴露结果。仅供告知——不下载、不切换、不自动更新；用户触发的重启流程属于后续阶段。

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

该插件系列没有客户端推送；客户端轮询 `updateCheck.status`。任何推送由 P3 UI 界面负责。

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
