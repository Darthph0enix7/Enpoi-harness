# dsh-enpoi-debug

面向 Agent 的**调试/透明化只读接口**（doc 69 §9.1，P3）：只有一个只读工具
`session_debug`，一次调用回答"这个 Session 到底在做什么"。

## 暴露内容

| 区块 | 内容 |
|---|---|
| `digest`（默认） | 执行锁存器（latch）与 `since`、存活后代（含 quiet 子会话）、当前模型、待处理提问（审批 id / 问题项）、带结构化错误的最后一次 turn 结束、有界最近工具调用（参数/结果预览）、注入索引、子代理树 |
| `snapshot` | 主模型请求摘要：provider/model、system 字符数与 SHA-256、工具名、消息角色/大小；**正文仅在 `includeBodies: true` 且本地操作员批准 `allowed-once` 时返回**（重量级、含密钥），其他结果只返回有界摘要并明确拒绝正文 |
| `incidents` | 诊断事件尾部，本 session 的行优先 |

天生只读：通过 host RPC 所包装的同一批进程内服务读取（`ctx.sessionController`
/ `ctx.remote.session`，事件用 `ctx.diagnostics`），从不向模型发送 prompt、从不修改、
从不写 session 日志（唯一可能触发的提示是操作员自己的 `includeBodies` 审批卡）。
输出有硬上限与预览（约 4k tokens），错误保留网关错误码
（`session/not-found`、`gateway/bad-request` 等）。

## 挂载位置

仅挂载在 **`orchestrator`** 与 **`sysadmin`** preset 的 `enpoi-orchestration`
agent-plane 分组内（`~/.dsh/profiles/web/presets/*/agent.cordis.yml`）。工具注册
进入这两个 agent 自己的 tools 层，其他 preset 不可见。该包刻意**不**列入
`dsh.profile.bundles`——host-plane 挂载会让工具对所有 agent 全局可见。

## 构建

```sh
pnpm --dir ~/.dsh/profiles/web/packages/enpoi-debug build
```

或用 `~/.dsh/profiles/web/build-plugins.sh` 重建全部 profile 插件。

## 测试

```sh
cd ~/.dsh/profiles/web && pnpm vitest run packages/enpoi-debug
```
