# Jarvis 工作器包

[English](README.md) | 中文

此版本随附的组合只允许一个新建的 Jarvis 作业读取两种知识。[`selector.json`](selector.json) 会复制到本次尝试的主目录，不包含供人使用的配置档。控制器使用回环地址上的对等传输：一元请求需要持有者令牌，每个 WebSocket 连接只接受一个 `peer/follow` 流，限制帧并要求按序确认。不开放浏览器或通用会话控制器 RPC。参见[部署参考](../../../../docs/creator/16-jarvis-worker-profile.md)。

## 模型体验

[`knowledge-tools.json`](knowledge-tools.json) 对应 Jarvis `hub/workertools/handler.go` 提供的两个输入模式。`query` 必填；中心还会限制其 UTF-8 字节数。清单摘要对按名称排序的 `{name,inputSchema}` 条目计算哈希，JSON 对象的键也会递归排序。面向模型的条目发生变化时，更新版本及 `scripts/worker-profile.spec.ts` 中经评审的内容摘要。只有这两个条目传给模型；远程说明与指令不能改变模型提示词。此包不增加辅助模型请求。

## 已知限制与延后工作

工作器只提供一条已配置的代理路由，不为费用或隐私作担保。只读工具不等于操作系统隔离。使用作业监督程序，并独立验证隔离。此包不维护路由或工具清单的独立状态投影，因此不需要不变量伴随模块。
