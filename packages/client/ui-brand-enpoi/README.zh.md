---
description: "Web 客户端的 Enpoi Harness 品牌与操作界面：品牌标记、Watchtower 视图、右侧栏操作标签页、设置分区、MCP 挂载徽标、会话内任务卡以及终端页面。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-enpoi

[English](README.md) | 中文

## 概述

替换内置 Web 品牌并添加 Enpoi 操作界面：侧栏与会话主视觉中的品牌标记、Watchtower 会话视图、右侧栏的 Capabilities、Agent Models、Subagent Sessions、Git 与 Terminal 标签页、Orchestration、Dynamic 与 Permissions 设置、会话头部 MCP 挂载徽标、会话内任务卡以及底部终端坞。该包还拥有浏览器终端注册表，在没有终端视图挂载时仍保持 PTY 连接，并将每个重型标签页主体在首次使用时作为包内分块加载。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将此包作为客户端插件行挂载到上游的会话、侧栏、工具与模型目录插件旁；这些插件在 `dsh.client.inject` 中声明。它本身没有配置项；它编辑的操作数据位于 `enpoi-orchestration` 设置命名空间与 Host 终端路由中。

### 何时选择它

当部署需要 Enpoi 品牌与操作座舱而不是内置品牌占位符时选择它。只需要上游 Web 界面的部署省略此行并保留官方品牌插件。

### 终端页面

右侧栏 Terminal 标签页与底部终端坞共享一个浏览器注册表。打开终端会通过 Host 受围栏的 `/enpoi-terminal` API 创建进程并附加 WebSocket；注册表会缓冲输出，因此收起终端坞、切换标签页或离开终端页面都不会拆除 shell。只有显式关闭、Host 的断连宽限期或插件卸载会结束它。Worker、其他页面或 Host 的空闲策略仍可能在该插件的浏览器生命周期之外拥有该进程。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

`src/client/index.ts` 在一个 Cordis 效果链中注册所有占位组件：品牌标记、Watchtower `conversation.view`、键控的 `sidebar.right.pane.tab` 主体、`settings.section` 页面、会话头部徽标、键控 `tool.call.toolview` 卡片以及 `shell.overlay` 底部终端坞。注册拥有各自的插槽身份与顺序；只有主体组件被延迟加载。

重型主体是包内动态导入。`src/client/lazy-surface.tsx` 渲染 `Suspense` 回退与一个错误边界，其重试会构建新的 `React.lazy` 组件，因此临时的分块获取失败不会污染整个页面。`src/client/lazy-bodies.tsx` 持有 Watchtower、Agent Models、Subagent Sessions、Git、Orchestration、Permissions 与 Dynamic 的加载器；`terminal/lazy-terminal-view.tsx` 持有终端模拟器加载器。图标、终端标签条与共享存储保留在入口中，因为标签页边框与注册时的引导胶囊会在任何主体打开前使用它们。

终端模拟器模块拥有 `@xterm/xterm`、`@xterm/addon-fit` 与 xterm 样式表。客户端打包预设将该全局 CSS 导入转换为标记为此插件的样式注入器，包内 `client.TerminalView.js` 分块只在终端标签页首次渲染时获取。`terminal/registry.ts` 中的注册表不导入 xterm：它独立于视图创建进程、连接套接字并重放转录。

包内动态导入编译为 `require.async("./client.<name>.js")`；生成的入口只保留其静态导入的共享模块。`package.json` 发布 `lib/client.*.js`，使分块随包分发。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [右侧栏](../ui-sidebar-right/README.zh.md) — 这些主体注册到的标签页注册表。
- [终端控制器](../../api/terminal-controller/README.zh.md) — Host 侧终端归属与恢复。
- [插槽](../ui-slots/README.zh.md) — 插槽声明、注册顺序与组合属性。
- [客户端打包预设](../tsdown.client.ts) — 动态分块编译与 CSS 归属。

<a id="model-experience"></a>
## 模型体验

### 浏览器操作界面

#### What the model sees

无；此包不注册任何模型可见输入。操作编辑写入 `enpoi-orchestration` 设置文档与浏览器终端注册表，绝不通过此包进入提示词、工具模式或会话事件。

#### Token effect

无；不贡献任何提示词文本、工具模式或结果渲染。

#### KV Cache effect

无；此包既不组装也不发送提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 主体分块在其标签页或设置分区首次打开时到达，因此首次打开会等待一次网络往返；没有预取或悬停预热。
- 分块获取失败会显示本地化重试控件；不重试的用户会一直看到失败状态，直到该界面重新挂载。
- 入口静态导入的共享模块仍随入口加载，因此只有上述主体被延迟；将共享存储移到分块之后会改变注册顺序行为。
- 终端模拟器被延迟，但终端进程仍需要 Host 路由与可写 WebSocket；Host 重启会结束这些进程。
- 品牌包以固定优先级占据上游插槽；同一优先级上的第二个占位组件会在加载时显式失败，而不是合并。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无运行时不变式：此包不保留可变状态，其插槽占位组件通过一个事务性效果安装与退出。延迟分块由 `scripts/client-boot-budget.spec.ts` 覆盖，该测试遍历客户端入口的静态导入图并拒绝急切加载 xterm 或主体模块；`tests/terminal-lazy.client.spec.tsx` 覆盖待定标记、重试路径与视图出现前的注册表缓冲。

</details>
