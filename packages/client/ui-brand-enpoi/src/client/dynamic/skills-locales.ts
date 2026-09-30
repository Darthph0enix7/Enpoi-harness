/** Locale bundles for the Dynamic page's Skills & tools panel CRUD copy. */

/** Locale keys the Skills & tools panel renders. */
export type DynamicSkillsKey =
  | 'panelHint'
  | 'settingsUnavailable'
  | 'skillsTitle'
  | 'toolsTitle'
  | 'liveCount'
  | 'loadingTools'
  | 'coreBadge'
  | 'revisionLabel'
  | 'storedToolDescription'
  | 'enableLabel'
  | 'userOnly'
  | 'add'
  | 'newTitle'
  | 'editTitle'
  | 'fieldName'
  | 'fieldDescription'
  | 'fieldBody'
  | 'namePlaceholder'
  | 'descriptionPlaceholder'
  | 'bodyPlaceholder'
  | 'create'
  | 'save'
  | 'cancel'
  | 'edit'
  | 'delete'
  | 'deleteTitle'
  | 'deleteConfirm'
  | 'loading'
  | 'empty'
  | 'loadFailed'
  | 'retry'
  | 'protectedBadge'
  | 'noSessionHint'
  | 'registryUnavailable'
  | 'nameRequired'
  | 'descriptionRequired'
  | 'detailFailed'
  | 'saveFailed'
  | 'deleteFailed'

/** English copy. */
export const en: Record<DynamicSkillsKey, string> = {
  panelHint: 'Skill and tool toggles write capabilities.skills.* / capabilities.tools.* in enpoi-orchestration and apply to the next query. Tool policy (ask/allow/deny) lives on the Permissions settings page.',
  settingsUnavailable: 'settings service is unavailable',
  skillsTitle: 'Skills',
  toolsTitle: 'Tools',
  liveCount: '{count} live',
  loadingTools: 'Loading tools…',
  coreBadge: 'Core',
  revisionLabel: 'namespace revision {revision}',
  storedToolDescription: 'Stored tool capability',
  enableLabel: 'Enable {label}',
  userOnly: 'user-only',

  add: '+ Add',
  newTitle: 'New skill',
  editTitle: 'Edit skill',

  fieldName: 'Name',
  fieldDescription: 'Description',
  fieldBody: 'Instructions (Markdown)',
  namePlaceholder: 'my-skill',
  descriptionPlaceholder: 'Short routing description',
  bodyPlaceholder: '# My skill\n\nWhen this skill applies and what to do.',

  create: 'Create',
  save: 'Save',
  cancel: 'Cancel',
  edit: 'Edit',
  delete: 'Delete',

  deleteTitle: 'Delete skill',
  deleteConfirm: 'Delete “{name}”? The skill moves to the trash and disappears from the catalog.',

  loading: 'Loading skills…',
  empty: 'No skills yet. Use “+ Add” to create one, or drop a folder with a SKILL.md into $DSH_HOME/skills.',
  loadFailed: 'Skills could not be loaded',
  retry: 'Retry',

  protectedBadge: 'shipped',
  noSessionHint: 'No session yet — installed skills appear after the first session.',
  registryUnavailable: 'Installed skill catalog unavailable: {reason}',

  nameRequired: 'A kebab-case name is required ([a-z0-9]+(-[a-z0-9]+)*).',
  descriptionRequired: 'A description is required.',
  detailFailed: 'The skill could not be loaded: {reason}',
  saveFailed: 'Save failed: {reason}',
  deleteFailed: 'Delete failed: {reason}',
}

/** Simplified Chinese copy. */
export const zh: Record<DynamicSkillsKey, string> = {
  panelHint: '技能与工具开关写入 enpoi-orchestration 中的 capabilities.skills.* / capabilities.tools.*，并在下一次查询生效。工具策略（ask/allow/deny）位于权限设置页。',
  settingsUnavailable: '设置服务不可用',
  skillsTitle: '技能',
  toolsTitle: '工具',
  liveCount: '{count} 个',
  loadingTools: '正在加载工具…',
  coreBadge: '核心',
  revisionLabel: '命名空间修订 {revision}',
  storedToolDescription: '已存储的工具能力',
  enableLabel: '启用 {label}',
  userOnly: '仅用户',

  add: '+ 添加',
  newTitle: '新建技能',
  editTitle: '编辑技能',

  fieldName: '名称',
  fieldDescription: '描述',
  fieldBody: '指令（Markdown）',
  namePlaceholder: 'my-skill',
  descriptionPlaceholder: '简短的路由描述',
  bodyPlaceholder: '# 我的技能\n\n何时适用以及要做什么。',

  create: '创建',
  save: '保存',
  cancel: '取消',
  edit: '编辑',
  delete: '删除',

  deleteTitle: '删除技能',
  deleteConfirm: '删除「{name}」？技能会移入回收站并从目录中消失。',

  loading: '正在加载技能…',
  empty: '还没有技能。点击「+ 添加」创建，或把带 SKILL.md 的目录放入 $DSH_HOME/skills。',
  loadFailed: '技能加载失败',
  retry: '重试',

  protectedBadge: '随附',
  noSessionHint: '还没有会话——首个会话之后才会显示已安装的技能。',
  registryUnavailable: '已安装技能目录不可用：{reason}',

  nameRequired: '需要 kebab-case 名称（[a-z0-9]+(-[a-z0-9]+)*）。',
  descriptionRequired: '描述不能为空。',
  detailFailed: '技能加载失败：{reason}',
  saveFailed: '保存失败：{reason}',
  deleteFailed: '删除失败：{reason}',
}
