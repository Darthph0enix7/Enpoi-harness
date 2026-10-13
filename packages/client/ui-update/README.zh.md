---
description: "应用内更新界面：shell 浮层上的可用性胶囊、包含更新说明与运行进度的对话框、带重试的失败面板，以及重启后的自动重载提示，均基于宿主 updateCheck 命名空间。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-update

[English](README.md) | 中文

## 概述

`dsh-client-ui-update` 是两阶段应用内更新流程的浏览器半边。当宿主报告有更新版本时，框架级 shell 浮层左下角会出现一个小胶囊；点击打开更新对话框：从已安装版本到最新版本的版本对、更新通道、可滚动的更新说明，以及 `[立即更新] [稍后] [跳过此版本]`。`立即更新` 准备更新，胶囊随后变成独立但仍克制的 `重启以更新` 状态；其对话框提供 `[重启以更新]`，应用已暂存的树并跟随切换直至成功。失败或回滚的运行显示原因、日志末尾与重试。重启后，重新连接上的页面会自动重载，并显示一次性的“已更新到 X”提示。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 web-app 清单加载本插件。当安装已是最新、检查状态未知，或最新版本已被跳过时，它不渲染任何东西，因此普通会话不会长出更新控件。出现更新的版本会让胶囊在跳过之后重新武装。

### 指示胶囊

胶囊位于 `shell.overlay` 列表——一个比所有面板都长寿的框架级浮动层——文本为 `{最新版本} ↑`。它刻意保持纤细：11px 字号、半透明浮起填充、发丝边框。位置取自框架发布在文档根上的 shell 内边距（`--dsh-shell-inset-left/-right/-bottom`），因此始终处于中间列之内——绝不压住左侧栏、会话侧栏，也不压住移动端底部操作栏——并在全屏右侧面板占据框架时整体隐藏。准备/应用期间显示同一标签加转圈状态点；已准备好时显示独立的 `重启以更新` 状态。文案归语言字典所有（`update` 命名空间，中英双语）；版本、通道与日志行是线上数据，原样渲染。

### 对话框

对话框渲染版本对、通道，以及作为更新内容的发布说明——列表随内容增长（至多接近整个对话框高度）并在内部滚动，几十条长提交说明也能阅读。`立即更新` 调用 `updateCheck/start`（准备）并保持对话框停在进度面板；`稍后` 关闭对话框（执行中的运行继续）；`跳过此版本` 通过 `updateCheck/dismiss` 记录跳过，胶囊随之消失。引擎执行期间，面板每约 2 秒轮询 `updateCheck/run`，显示阶段标签、步骤 `N/9`、日志最后一行，并从切换步骤起显示断开提示。已准备好状态提供 `[重启以更新]`（`updateCheck/apply`）。失败或回滚的记录渲染原因、受限日志末尾（最后 40 行）与重试（暂存标记仍在时重放 `apply`，否则重新准备）。

### 轮询与重启

`updateCheck/status` 在挂载时读取一次，标签页可见时每 60 秒一次，并在窗口聚焦或可见性恢复时读取（每秒最多合并为一次调用）。运行记录在挂载时读取一次——新标签页重新打开时因此仍能看到已准备好的更新——之后仅在引擎进程执行期间（`starting`/`preparing`/`applying`）每约 2 秒轮询。`start` 与 `apply` 会把运行前的安装版本写入会话存储；应用的切换重启服务后，重新连接的页面比较宿主报告的版本，写入一次性提示负载并重载。运行中途手动刷新页面也不会丢失该标记，完成仍会被检测到。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

宿主插件（`profile/web/packages/enpoi-update-check`）是 profile 插件，因此客户端装配里没有生成的 Remote 产物：每次调用都是一条 `POST /api/updateCheck.<method>`，携带共享的 client-request 信封（`{type, method, rpcId, payload:{args}}`），与 `enpoiUiState.*` 使用的模式相同。`args` 携带描述符的具名参数，而不是请求字段：`dismiss` 发送 `{request: {version}}`，所有无参方法发送 `{}`。控制器拥有全部轮询，并通过一个快照 store 发布状态，该 store 绑定进插槽条目的 `hooks` 隔舱；组件自身不持有任何订阅机制与传输状态。

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 字典注册与 `shell.overlay` 条目 |
| [`src/client/controller.ts`](src/client/controller.ts) | 轮询策略、prepare/apply/retry/dismiss、重启检测、提示标记 |
| [`src/client/rpc.ts`](src/client/rpc.ts) | `updateCheck.*` 信封调用、描述符参数表与线上契约 |
| [`src/client/UpdateIndicator.tsx`](src/client/UpdateIndicator.tsx) | 胶囊、对话框、更新说明、进度、重启、失败面板、提示 |
| [`src/client/locales.ts`](src/client/locales.ts) | `update` 命名空间文案（中文为真源） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-enpoi-update-check`](../../../profile/web/packages/enpoi-update-check/README.zh.md) —— 宿主半边：目录检查、运行启动器/观察者、`run.json`，以及 `updateCheck` Remote 方法。
- [`ui-layout`](../ui-layout/README.zh.md) —— 提供 `shell.overlay` 座位的框架。
- [`ui-message-feedback`](../ui-message-feedback/README.zh.md) —— 同样基于非生成命名空间的对话框与提示组合的姊妹实现。

-----

<a id="model-experience"></a>
## 模型体验

无。本包为人类渲染宿主报告的更新状态，不触及任何提示词、消息、模式、流或工具结果。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义当前包的约束，不是任务清单。

- **进度粒度就是引擎的步骤行** —— 进度条跟随 `[N/9]`；字节级进度需要引擎的状态文件，宿主观察者目前不消费它。
- **已准备好的更新会在同一浏览器 profile 的任意标签页中再次展示** —— prepared 状态存在于宿主的 `run.json`，重新打开的标签页通过挂载读取发现它；重启本身始终由点击它的那个标签页发起。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

```sh
pnpm --filter @deepseek-ai/dsh-client-ui-update bundle
npx vitest run packages/client/ui-update
```

</details>

**运行时不变式：** 不发布伴随模块。本包只是对宿主 `updateCheck` 命名空间的只读投影加四个操作者动作；它不发 Cordis 事件、不持有跨插件可变状态，其唯一插槽注册的移除由浏览器半边测试证明。
