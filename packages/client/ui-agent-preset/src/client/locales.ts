/** Locale bundles for the agent-preset hero chip, header label, and management section. */

import { guideEn, guideZh, type PresetGuideKey } from './guide-locales.ts'

/** Locale keys these surfaces render. */
export type AgentPresetSettingsKey =
  | PresetGuideKey
  | 'builtInGroup'
  | 'customGroup'
  | 'seatHint'
  | 'headerHint'
  | 'nav'
  | 'sectionIntro'
  | 'setDefault'
  | 'view'
  | 'presetStandardName'
  | 'presetStandardDescription'
  | 'presetPtcName'
  | 'presetPtcDescription'
  | 'presetMinimalName'
  | 'presetMinimalDescription'
  | 'presetCordisName'
  | 'presetCordisDescription'
  | 'inUse'
  | 'noDescription'
  | 'brokenBadge'
  | 'switchRefused'
  | 'close'
  | 'creatorDraft'
  | 'enableDevToolsToSetDefault'
  | 'enableDevToolsToCreate'
  | 'manualNew'
  | 'manualNewTitle'
  | 'manualEditTitle'
  | 'manualBase'
  | 'manualId'
  | 'manualName'
  | 'manualDescription'
  | 'manualPersona'
  | 'manualPersonaHint'
  | 'manualCreate'
  | 'manualSave'
  | 'manualCancel'
  | 'manualEdit'
  | 'manualDelete'
  | 'manualDeleteTitle'
  | 'manualDeleteConfirm'
  | 'manualProtected'
  | 'manualUnavailable'
  | 'manualErrorId'
  | 'manualErrorName'
  | 'manualErrorPersona'
  | 'manualErrorBase'
  | 'manualCreateFailed'
  | 'manualUpdateFailed'
  | 'manualDeleteFailed'
  | 'manualDetailFailed'

/** English copy. */
export const en: Record<AgentPresetSettingsKey, string> = {
  ...guideEn,
  builtInGroup: 'Built-in', customGroup: 'Custom',
  sectionIntro: 'Choose the agent’s tools and how it works. Use Standard mode for everyday tasks, or Creator mode to add capabilities to DSH.',

  seatHint: 'Choose the agent preset for your new task',
  headerHint: 'The agent preset chosen when this task started',
  nav: 'Agent presets',

  setDefault: 'Set as new task default',
  view: 'View configuration',

  presetStandardName: 'Standard mode',
  presetStandardDescription:
    'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
  presetPtcName: 'PTC mode',
  presetPtcDescription:
    'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
  presetMinimalName: 'Minimal mode',
  presetMinimalDescription:
    'The agent works using only a terminal tool. Useful for testing and comparing its basic performance.',
  presetCordisName: 'Creator mode',
  presetCordisDescription:
    'Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',

  inUse: 'New task default',

  noDescription: 'No description.',
  brokenBadge: 'Failed to load',

  switchRefused: 'Could not switch to {name}: {reason}',

  close: 'Close',

  creatorDraft: 'Let the agent help me create a preset',

  enableDevToolsToSetDefault: 'Turn on Coding Tools in General settings to choose a default',
  enableDevToolsToCreate: 'Turn on Coding Tools in General settings to start Creator mode',

  // Manual authoring (Agent presets section)
  manualNew: '+ New preset',
  manualNewTitle: 'New agent preset',
  manualEditTitle: 'Edit agent preset',
  manualBase: 'Base preset',
  manualId: 'Id',
  manualName: 'Name',
  manualDescription: 'Description',
  manualPersona: 'Persona (doctrine suffix)',
  manualPersonaHint: 'The shared system-prompt prefix is inherited unchanged; only this suffix is yours.',
  manualCreate: 'Create',
  manualSave: 'Save',
  manualCancel: 'Cancel',
  manualEdit: 'Edit',
  manualDelete: 'Delete',
  manualDeleteTitle: 'Delete preset',
  manualDeleteConfirm: 'Delete “{name}”? Sessions already created keep their composition.',
  manualProtected: 'Shipped preset — edit it in the profile, not here',
  manualUnavailable: 'Manual authoring is unavailable on this host.',
  manualErrorId: 'A kebab-case id is required ([a-z0-9]+(-[a-z0-9]+)*).',
  manualErrorName: 'A name is required.',
  manualErrorPersona: 'A persona is required.',
  manualErrorBase: 'Choose a base preset.',
  manualCreateFailed: 'Could not create: {reason}',
  manualUpdateFailed: 'Could not save: {reason}',
  manualDeleteFailed: 'Could not delete: {reason}',
  manualDetailFailed: 'Could not load the preset: {reason}',
}

/** Simplified Chinese copy. */
export const zh: Record<AgentPresetSettingsKey, string> = {
  ...guideZh,
  builtInGroup: '内置', customGroup: '自定义',
  sectionIntro: '选择 Agent 的工具和工作方式。日常任务用「标准模式」，扩展 DSH 的能力用「创造模式」。',

  seatHint: '选择新任务使用的 Agent 预设',
  headerHint: '本任务的 Agent 预设，在任务开始时确定',
  nav: 'Agent 预设',

  setDefault: '设为新任务默认',
  view: '查看配置',

  presetStandardName: '标准模式',
  presetStandardDescription: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
  presetPtcName: 'PTC 模式',
  presetPtcDescription: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
  presetMinimalName: '极简模式',
  presetMinimalDescription: 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
  presetCordisName: '创造模式',
  presetCordisDescription: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',

  inUse: '新任务默认',

  noDescription: '暂无描述。',
  brokenBadge: '加载失败',

  switchRefused: '无法切换到「{name}」：{reason}',

  close: '关闭',

  creatorDraft: '让 Agent 帮我创建预设模式',

  enableDevToolsToSetDefault: '请先在通用设置中开启代码工作工具，再设置默认值',
  enableDevToolsToCreate: '请先在通用设置中开启代码工作工具，再启动创造模式',

  // Manual authoring (Agent presets section)
  manualNew: '+ 新建预设',
  manualNewTitle: '新建 Agent 预设',
  manualEditTitle: '编辑 Agent 预设',
  manualBase: '基础预设',
  manualId: 'Id',
  manualName: '名称',
  manualDescription: '描述',
  manualPersona: '人格（准则后缀）',
  manualPersonaHint: '共享的系统提示前缀会原样继承，只有此后缀归你所有。',
  manualCreate: '创建',
  manualSave: '保存',
  manualCancel: '取消',
  manualEdit: '编辑',
  manualDelete: '删除',
  manualDeleteTitle: '删除预设',
  manualDeleteConfirm: '删除「{name}」？已创建的会话会保留其组合。',
  manualProtected: '随附预设——请在配置中修改，而非此处',
  manualUnavailable: '此主机不支持手动创建。',
  manualErrorId: '需要 kebab-case 的 Id（[a-z0-9]+(-[a-z0-9]+)*）。',
  manualErrorName: '名称不能为空。',
  manualErrorPersona: '人格不能为空。',
  manualErrorBase: '请选择基础预设。',
  manualCreateFailed: '创建失败：{reason}',
  manualUpdateFailed: '保存失败：{reason}',
  manualDeleteFailed: '删除失败：{reason}',
  manualDetailFailed: '预加载失败：{reason}',
}

// The resolution itself is the shared fold in `dsh-agent-preset-registry/display`,
// re-exported here so every surface in this plugin reads one path; the
// Settings plugin list inlines the same fold over this plugin's dictionaries.
export { isBuiltInPreset, presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
export type { PresetDisplaySource, PresetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
