/**
 * `model` namespace dictionaries.
 *
 * `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
 * separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'provider.account': 'DeepSeek 账号',
  'command.label': '模型',
  'command.description': '选择本会话使用的模型',
  'option.loadError': '目录加载失败：{message}',
  'option.deepseekV4Flash.description': '快速、高效且经济；适合目标明确、常规或并行任务。',
  'option.deepseekV4Pro.description': '更强的自主编码、知识与复杂推理能力；适合复杂或质量优先的任务，但成本更高。',
  'trigger.fallback': '请选择模型',
  'trigger.loading': '正在加载模型…',
  'trigger.selectAria': '请选择模型',
  'trigger.aria': '选择模型，当前 {model}',
  'trigger.ariaEffort': '选择模型，当前 {model}，推理等级 {effort}',
  'menu.aria': '模型与推理等级',
  'menu.close': '关闭',
  'menu.model': '模型',
  'menu.effort': '推理等级',
  'search.placeholder': '搜索模型…',
  'group.groups': '模型组',
  'group.model': '{count} 个模型',
  'group.models': '{count} 个模型',
  'group.favorites': '收藏',
  'group.recent': '最近',
  'favorite.add': '加入收藏',
  'favorite.remove': '取消收藏',
  'favorite.dragReorder': '拖动以排序收藏',
  'provider.dragReorder': '拖动以排序提供商',
  'effort.providerDefault': 'Default',
  'effort.triggerTitle': '思考 / 推理等级：{effort}',
  'status.loading': '正在刷新模型列表…',
  'error.action': '模型操作失败：{message}',
  'error.sessionInUse': '当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。',
  'action.reload': '重新加载',
  'warning.groupLoad': '{name} 加载失败：{message}',
  'empty.models': '没有可用的模型。',
  'empty.efforts': '当前模型未提供推理等级。',
  'empty.search': '没有匹配 “{query}” 的模型',
} satisfies Record<string, string>

/** The model namespace key union. */
export type ModelKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'provider.account': 'DeepSeek Account',
  'command.label': 'Model',
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'Catalog failed to load: {message}',
  'option.deepseekV4Flash.description': 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
  'option.deepseekV4Pro.description': 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
  'trigger.fallback': 'Select model',
  'trigger.loading': 'Loading models…',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'menu.aria': 'Model and reasoning effort',
  'menu.close': 'Close',
  'menu.model': 'Model',
  'menu.effort': 'Effort',
  'search.placeholder': 'Search models...',
  'group.groups': 'Groups',
  'group.model': '{count} model',
  'group.models': '{count} models',
  'group.favorites': 'Favorites',
  'group.recent': 'Recent',
  'favorite.add': 'Add to favorites',
  'favorite.remove': 'Remove from favorites',
  'favorite.dragReorder': 'Drag to reorder favorite',
  'provider.dragReorder': 'Drag to reorder provider',
  'effort.providerDefault': 'Default',
  'effort.triggerTitle': 'Thinking / Reasoning Effort: {effort}',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'error.sessionInUse': 'This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.',
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'empty.models': 'No models available.',
  'empty.efforts': 'This model provides no reasoning effort levels.',
  'empty.search': 'No models matching "{query}"',
} satisfies Record<ModelKey, string>
