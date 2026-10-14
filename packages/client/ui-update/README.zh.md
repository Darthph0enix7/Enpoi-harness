---
description: "应用内更新界面：shell 浮层上的可用性胶囊、包含更新说明与运行进度的对话框、带重试的失败面板，以及重启后的自动重载提示，均基于宿主 updateCheck 命名空间。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-update

[English](README.md) | 中文

## 概述

`dsh-client-ui-update` 是两阶段应用内更新流程的浏览器半边。当宿主报告有更新版本时，框架级 shell 浮层左下角会出现一个写着 **更新** 的小胶囊；点击打开更新对话框：从已安装版本到最新版本的版本对、更新通道、可滚动的更新说明，以及 `[立即更新] [稍后] [跳过此版本]`。`立即更新` 准备更新，胶囊随后变成克制的 `重启以更新` 状态，应用已暂存的树。失败显示原因与重试；被跳过的版本仍可从设置页更新；重启后页面自动重载并显示一次性的“已更新到 X”提示。

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

通过 web-app 清单加载本插件。当安装已是最新或检查状态未知时，它不渲染任何东西，因此普通会话不会长出更新控件。出现更新版本时显示胶囊；跳过只会隐藏胶囊，设置页中的控件（见下）仍然保留，而目录出现更新版本会让一切重新武装。

### 指示胶囊

胶囊位于 `shell.overlay` 列表——一个比所有面板都长寿的框架级浮动层——文本恰好是 **更新**（英文 `Update`）：没有版本号、没有箭头、没有角标。它刻意保持纤细：11px 字号、半透明浮起填充、柔和阴影，并且只比中性 chrome 高一个克制的强调层级（与设置页更新控件使用同一强调色）；无障碍名称同样不含版本号，所有发布细节都在对话框里。位置取自框架发布在文档根上的 shell 内边距（`--dsh-shell-inset-left/-right/-bottom`），因此始终处于中间列之内——绝不压住左侧栏、会话侧栏，也不压住移动端底部操作栏——并在全屏右侧面板占据框架时整体隐藏。准备/应用期间显示安静的更新中标签；已准备好时显示独立的 `重启以更新` 状态。在不支持 `--prepare` 的引擎上，宿主改用**一次性**档位（`rung: 'one-shot'`）：运行会在流程中途重启服务，因此胶囊保持普通的更新中状态，切换步骤显示断开提示，且不会出现已准备/重启入口。文案归语言字典所有（`update` 命名空间，中英双语）；版本、通道与日志行在出现之处（对话框、设置行）原样渲染。

### 对话框

源码构建安装的版本标记（`0.1.7-enpoi.2+gbb12abc`）会在对话框的版本对与更新完成提示中显示语言字典所有的“（源码构建）”限定词——胶囊本身始终保持无版本号。在版本标题旁，对话框带有一个安静的**检查更新**行内操作（经共享控制器调用 `updateCheck/checkNow`——只有一个轮询来源）：单次检查进行中时禁用（`正在检查…`），失败以灰色行内文本展示，绝不弹窗。对话框渲染版本对、通道，以及作为更新内容的发布说明——列表随内容增长（至多接近整个对话框高度）并在内部滚动，几十条长提交说明也能阅读。`立即更新` 调用 `updateCheck/start`（两阶段引擎上是准备，否则是一次性更新）并保持对话框停在进度面板；`稍后` 关闭对话框（执行中的运行继续）；`跳过此版本` 通过 `updateCheck/dismiss` 记录跳过，胶囊随之消失。引擎执行期间，面板每约 2 秒轮询 `updateCheck/run`，显示阶段标签、步骤 `N/9`、日志最后一行，并从切换步骤起显示断开提示。已准备好状态提供 `[重启以更新]`（`updateCheck/apply`，仅两阶段）。失败或回滚的记录渲染原因、受限日志末尾（最后 40 行）与重试（两阶段暂存标记仍在时重放 `apply`，否则重新运行 `start`）。当失败仍保留有效的暂存树——或其原因属于 already-running/陈旧一类——面板还会提供**清除更新状态并重试**：宿主只清理非存活状态（任何真正存活的对象存在时拒绝，且绝不触碰引擎标记或暂存树），客户端随后直接重新应用暂存版本而不重新下载；没有可用的暂存时回退为全新的 prepare。运行仍在切换之前时，进度面板提供 `[取消更新]`（`updateCheck/cancel`，委托给引擎自有的 SIGTERM/SIGKILL 流程）；越过切换点后——apply 自启动起、一次性从步骤 8 起——入口消失，与引擎的拒绝保持一致；即使拒绝真的到达宿主，也会展示引擎的消息。已取消的运行渲染 `更新已取消` 并提供重试。

**在 UI 之外**启动的运行（终端里的普通 `dsh update`）以同一种记录到达（`observed: true`，由宿主从引擎标记合成），因此更新中的胶囊、带取消入口的进度面板、以及失败/已取消面板都通过完全相同的状态渲染——没有单独路径。

### 设置页入口（跳过之后更新仍然可达）

通用设置页在当前版本行旁边（`settings.general.item`，order 101）多一个入口：同一个控制器状态的设置行渲染。`current` 显示安静的“已是最新版本”，并提供同样的**检查更新**行内操作；`unknown`（从未检查/离线）显示“尚未检查”与该操作；`available` 显示 `有新版本 {version}` 与 **立即更新** 按钮（打开共享对话框）；`dismissed` 显示同一按钮并附“已跳过此版本”提示——这正是胶囊隐藏后仍能更新被跳过版本的关键，宿主也会接受 `dismissed` 状态下的 `updateCheck/start`；`preparing`/`applying` 显示进度标签与 **查看进度**（打开对话框）；`prepared` 显示 **重启以更新**，通过同一个控制器动作执行重启；失败的运行显示 **重试**，打开失败面板。该行与胶囊共享控制器的 store 与动作——只有一个轮询来源，没有第二份传输状态。

### 轮询与重启

`updateCheck/status` 在挂载时读取一次，标签页可见时每 60 秒一次，并在窗口聚焦或可见性恢复时读取（每秒最多合并为一次调用）。运行记录在挂载时读取一次——新标签页重新打开时因此仍能看到已准备好的更新——之后仅在引擎进程执行期间（`starting`/`preparing`/`applying`）每约 2 秒轮询。`start` 与 `apply` 会把运行前的安装版本写入会话存储；更新的切换重启服务后，重新连接的页面比较宿主报告的版本，写入一次性提示负载并重载。终态成功（或带待处理更新时的重连）还会启动一个**有界的身份观察**：每约 2 秒重读一次状态、最多持续 60 秒，一旦所服务的身份变化就重载页面——重启后需要几秒才应答的服务不再需要手动刷新。观察不会自我延长，并随插件释放；运行中途手动刷新页面也不会丢失该标记，完成仍会被检测到。

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
