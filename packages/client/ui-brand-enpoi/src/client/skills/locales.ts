/** Locale bundles for the Skills settings section. */

/** Locale keys the Skills section renders. */
export type SkillsSettingsKey =
  | 'nav'
  | 'sectionIntro'
  | 'newSkill'
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
  | 'sourceDefault'
  | 'sourceProfile'
  | 'sourceInstalled'
  | 'protectedBadge'
  | 'readOnlyBadge'
  | 'nameRequired'
  | 'descriptionRequired'
  | 'detailFailed'
  | 'saveFailed'
  | 'deleteFailed'
  | 'registryUnavailable'

/** English copy. */
export const en: Record<SkillsSettingsKey, string> = {
  nav: 'Skills',
  sectionIntro: 'Create, edit, and delete skill definitions directly. A new skill joins the agent’s skill catalog on the next turn — no restart.',

  newSkill: 'New skill',
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
  empty: 'No skills yet. Create one to give the agent reusable instructions.',
  loadFailed: 'Skills could not be loaded',
  retry: 'Retry',

  sourceDefault: 'default',
  sourceProfile: 'profile',
  sourceInstalled: 'installed',
  protectedBadge: 'shipped',
  readOnlyBadge: 'read-only',

  nameRequired: 'A kebab-case name is required ([a-z0-9]+(-[a-z0-9]+)*).',
  descriptionRequired: 'A description is required.',
  detailFailed: 'The skill could not be loaded: {reason}',
  saveFailed: 'Save failed: {reason}',
  deleteFailed: 'Delete failed: {reason}',
  registryUnavailable: 'Installed skill catalog unavailable: {reason}',
}

/** Simplified Chinese copy. */
export const zh: Record<SkillsSettingsKey, string> = {
  nav: '技能',
  sectionIntro: '直接创建、编辑和删除技能定义。新技能会在下一轮对话进入 Agent 的技能目录，无需重启。',

  newSkill: '新建技能',
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
  empty: '还没有技能。创建一个，让 Agent 获得可复用的指令。',
  loadFailed: '技能加载失败',
  retry: '重试',

  sourceDefault: '默认',
  sourceProfile: '配置',
  sourceInstalled: '已安装',
  protectedBadge: '随附',
  readOnlyBadge: '只读',

  nameRequired: '需要 kebab-case 名称（[a-z0-9]+(-[a-z0-9]+)*）。',
  descriptionRequired: '描述不能为空。',
  detailFailed: '技能加载失败：{reason}',
  saveFailed: '保存失败：{reason}',
  deleteFailed: '删除失败：{reason}',
  registryUnavailable: '已安装技能目录不可用：{reason}',
}
