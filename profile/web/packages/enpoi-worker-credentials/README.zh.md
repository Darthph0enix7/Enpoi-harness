# dsh-enpoi-worker-credentials

[English](README.md) | 中文

此插件为一个指定的 Jarvis MCP 服务器提供宿主侧的 `mcpHeaderProvider`。`serverId` 必须与 MCP 客户端的 `serverName` 和有效作业绑定中的 `mcpEndpointId` 完全一致。提供方只解析当前会话的 `credentialRef`，并向该目的地发送 `Authorization`、`X-Jarvis-Job-ID` 和 `X-Jarvis-Job-Fence`。

`secretDir` 必须是绝对路径，默认为 `$DSH_HOME/worker-secrets`。目录（0700）和 bearer 凭据文件（0600）的所有者都必须是工作进程的 UID。引用名区分大小写，只能包含一个路径段：首字符须为 ASCII 字母或数字，后接最多 127 个 ASCII 字母、数字、句点、下划线或连字符。凭据必须存放在普通文件中，仅包含一个 bearer 值及可选的行尾；符号链接、具有多个硬链接的文件、无效值和超过 8 KiB 的文件均会被拒绝。请在可信且由工作进程所有的父目录下原子替换文件，不要原地编辑。文件不存在或绑定无效时不返回任何请求头；文件不安全时只返回通用错误。两种情况都不会记录凭据或文件名。

## 模型体验

此插件不添加提示词或工具，不消耗令牌，也不改变 KV 缓存。请求头在发出请求时解析，不会提供给模型，也不会写入会话历史。

## 已知限制与延后工作

- 绑定建立前，提供方不会提供用于发现的凭据。当提供方返回 `undefined` 时，当前 MCP 客户端仍会发出不带动态请求头的请求；端点必须拒绝未经认证的请求。不要配置静态 Authorization 作为后备。发现流程的时序阻塞见 [Jarvis 工作进程配置档](../../../../docs/creator/16-jarvis-worker-profile.md)。
- 文件所有者和权限检查不能隔离使用相同 UID 的其他进程。请为工作进程使用专用账户或更强的操作系统级隔离。此插件不发布运行时不变量配套模块，因为提供方并不拥有独立于绑定及所读文件的状态。
