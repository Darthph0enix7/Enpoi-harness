---
description: "dsh Web 客户端右侧边栏的可编辑文件工作台：在会话级文件地址上运行 CodeMirror 编辑器，通过受围栏保护的 /sidebar/fsops 路由做乐观保存，并以外部变更防护确保永不覆盖未保存的缓冲区。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-enpoi-editor

[English](README.md) | 中文

## 概述

右侧边栏的可编辑工作台：以 `extension` 优先带注册的标签类型打开会话文件，在 CodeMirror 6 中编辑，并通过配置档案受围栏保护的 `/sidebar/fsops` JSON 路由保存。它只认领文本类会话文件——图片、PDF、办公文档和未知类别仍由只读预览处理——并在标签可见时轮询 `fs.stat`，使干净缓冲区下的磁盘变更就地替换，且绝不覆盖未保存的编辑。

## 目录

- [注册内容](#what-it-registers)
- [编辑与保存](#editing-and-saving)
- [查找与导航](#finding-and-navigating)
- [外部变更](#external-changes)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者说明](#dev-note)

-----

<a id="what-it-registers"></a>
## 注册内容

- **标签类型** —— `ctx.sidebarRightTabs.register(...)`，kind 与 id 均为 `enpoi-editor`，patterns 为 `['dsh-resource://file/**']`，优先带为 `extension`；`canOpen` 只接受会话作用域、且路径经 `classifyFileType` 归入可编辑类别的地址。优先带本身就是决策：仅对这些地址，本类型胜过 `ui-sidebar-documentpreview` 注册的只读 `text` 回退；其他地址根本不会到达这里。
- **标签标题** —— 定义的 `title`，即地址解码后的 basename（沿用只读预览的约定）。
- **正文** —— 同一 id 下键控的 `sidebar.right.pane.tab` 席位：工具栏、横幅、编辑器或预览，以及加载/文件不存在/失败状态。按标签 id 键控的声明式 store 保存一个文件的内容、磁盘基线、脏缓冲区和视图选择，切换标签再回来时未保存的编辑仍在。
- **文案** —— `enpoiEditor` 本地化命名空间。

`src/client/` 下的五个源文件：`definition.ts`（类型）、`fsops.ts`（`/sidebar/fsops` 客户端）、`machine.ts`（读取/轮询/保存的异步决策）、`store.ts`（标签保存的状态）、`languages.ts`（语法映射），以及组件 `EditorBody.tsx` / `CodeMirrorEditor.tsx`，另有 `EditorBody.module.css` 与 `icons.tsx`（接线在 `index.ts`）。

<a id="editing-and-saving"></a>
## 编辑与保存

编辑器为 CodeMirror 6，带行号、撤销历史、小型语言集（Markdown、JavaScript/TypeScript/JSX、JSON、Python），以及两个 compartment：自动换行与只读。预览通过 `MarkdownText`（Markdown）或 `CodeBlock`（其余）只读渲染当前缓冲区。编辑器内的 `Mod-s` 与工具栏的保存按钮调用同一次保存。

保存时携带 `expectedSha`——即**最后一次从磁盘读取**内容的 SHA-256，绝不是编辑后缓冲区的摘要。`409 conflict` 会弹出冲突横幅，提供**覆盖保存**（省略 `expectedSha` 重试，即路由的强制写入形式）与**重新载入**；缓冲在操作者选择之前一直保留。截断读取（`truncated: true`）为只读且永不保存：编辑器隐藏保存控件并显示提示，因为部分缓冲区绝不能覆盖文件。

I/O 为同源的 `POST /sidebar/fsops/<method>`，`content-type: application/json`，由注入的 `EditorFsOps` 面封装：`fs.read` → `{content, sha256, mtimeMs, size, truncated}`，`fs.write` → 新摘要/状态（或 `409 conflict`），`fs.stat` → `{mtimeMs, size}`。`not-found`（404）是一种状态，而不是错误。

<a id="finding-and-navigating"></a>
## 查找与导航

**查找**（`Mod-F` 或工具栏控件）在编辑区上方打开主题化查找栏。输入查询时即高亮匹配项，`Enter`/`Shift-Enter`（以及箭头按钮）循环跳转，计数器显示 `index / total` 或安静的 **No matches** 状态。大小写（`Aa`）与正则（`.*`）开关就地重新查询；正则以查询自身的语法为锚，且除非大小写开关打开否则不区分大小写。正则模式关闭时转义序列永不展开——查找字段就是字面文本。非法模式（`(`）不是错误界面：查找栏报告 **No matches** 并清除标记，而不是抛错。

`@codemirror/search` 自带的高亮器仅在其内置面板打开时装饰匹配项，因此本包自行维护覆盖层：`search.ts` 在 `StateField` 中收集查询范围，把每个匹配标为 `cm-searchMatch`、把当前揭示项标为 `cm-searchMatch-selected`，并在一次事务中派发覆盖层、选区与居中的 `EditorView.scrollIntoView`——首次查询与每次步进都会高亮并滚动到视野内。`CodeMirrorEditor.tsx` 通过 `--dsw-alias-state-warn-primary` 以两级强度为两个类名设样式，因此它们跟随当前皮肤与明暗方案；装饰会随文档变更映射，并在被替换的文档使范围失效时清除。

**转到行**（`g` 或工具栏控件，且当前选中本渲染器）把光标移到 1 基行号、居中、聚焦编辑器，并短暂闪烁目标行（`cm-gotoFlash`，一个 1.4 秒后移除的行装饰，使重复跳转再次闪烁）。

<a id="external-changes"></a>
## 外部变更

当被寻址的标签可见时（`tab.visible` 且 `document.visibilityState === 'visible'`），正文每 1500 ms 对文件执行一次 stat。stat 未变化时只消耗一次请求。

- **已变化、缓冲区干净** → 重新读取文件，就地替换文档并夹紧选区，然后记录新基线。读取等待期间落入的按键会中止替换——读取前捕获的缓冲区 revision 在读取完成后比较——并改为弹出横幅。
- **已变化、缓冲区为脏**（或截断） → 显示**文件已在磁盘上更新**横幅，提供**重新载入**与**忽略**；缓冲区不受影响。重新载入会先请求确认，然后丢弃并重新读取。
- **`not-found`** → 正文变为**文件不存在**状态并显示路径，提供重新载入；脏缓冲区仍留在 store 中，状态会说明其被保留。若文件重新出现，下一次轮询会在保留缓冲区的前提下采用新基线，而不是丢弃它。

<a id="model-experience"></a>
## 模型体验

### 浏览器端编辑器

#### What the model sees

无；本包不注册任何面向模型输入。文件内容、磁盘基线与脏缓冲区都留在浏览器中，仅经由受围栏保护的 `/sidebar/fsops` 路由传输。

#### Token effect

无；不贡献任何提示文本、工具 schema 或结果渲染。

#### KV Cache effect

无；本包既不组装也不发送提供方请求。

## 已知限制与未竟事项

<a id="known-limitations-and-deferred-work"></a>
- **未知类别被拒绝。** `classifyFileType` 对无扩展名文件或 `.txt`/`.log` 没有文本类别，因此这些仍由只读预览处理；用文本扩展名白名单放宽 `canOpen` 是后续工作。
- **不创建新文件，也不重命名或删除。** 工作台编辑已存在的文件；浏览与文件系统操作属于其他界面。
- **写入路由不报告摘要时 sha 基线会降级。** 写入回执没有摘要时回退到 WebCrypto；若 `crypto.subtle` 不可用，下一次保存可能冲突，需要覆盖保存。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作备注——点击展开</summary>

CodeMirror 被内联进 `lib/client.js`（未压缩约 1.1 MB），而不是从模块表请求：没有其他插件与其共享运行时 identity，依赖策略也把仅浏览器的第三方实现留在包的 `devDependencies` 中。语法与高亮样式随同一产物分发。

</details>

**运行时不变式：** 不发布 companion。唯一的运行时状态是每个标签一个 store bucket，由拥有它的正文写入，并在标签的中止信号上遗忘；不存在对其的第二处观测可供比较。
