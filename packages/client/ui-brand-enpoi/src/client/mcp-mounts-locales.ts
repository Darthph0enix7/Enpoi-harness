/** Locale bundles for the session header's MCP mounts chip. */

/** Locale keys the chip renders. */
export type McpMountsKey =
  | 'chipLabel'
  | 'title'
  | 'loading'
  | 'toolCount'
  | 'unmount'
  | 'unmountFailed'
  | 'loadFailed'

/** English copy. */
export const en: Record<McpMountsKey, string> = {
  chipLabel: 'MCP {count}',
  title: 'Mounted MCP servers',
  loading: 'Loading mounts…',
  toolCount: '{count} tools',
  unmount: 'Unmount',
  unmountFailed: 'Could not unmount: {reason}',
  loadFailed: 'Could not read the mounted servers',
}

/** Simplified Chinese copy. */
export const zh: Record<McpMountsKey, string> = {
  chipLabel: 'MCP {count}',
  title: '已挂载的 MCP 服务器',
  loading: '正在加载挂载…',
  toolCount: '{count} 个工具',
  unmount: '卸载',
  unmountFailed: '卸载失败：{reason}',
  loadFailed: '无法读取已挂载的服务器',
}
