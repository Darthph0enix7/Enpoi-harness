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
  | 'fieldMcp'
  | 'mcpHint'
  | 'mcpPlaceholder'
  | 'mcpAdd'
  | 'mcpRemove'
  | 'mcpBadge'
  | 'mcpCustomHint'
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
  | 'customToolAdd'
  | 'customToolNewTitle'
  | 'customToolEditTitle'
  | 'customToolBadge'
  | 'customToolId'
  | 'customToolName'
  | 'customToolDescription'
  | 'customToolCommand'
  | 'customToolCommandHint'
  | 'customToolParams'
  | 'customToolParamName'
  | 'customToolParamType'
  | 'customToolParamRequired'
  | 'customToolParamDescription'
  | 'customToolParamNamePlaceholder'
  | 'customToolCommandPlaceholder'
  | 'customToolAddParam'
  | 'customToolRemoveParam'
  | 'customToolCreate'
  | 'customToolSave'
  | 'customToolDeleteTitle'
  | 'customToolDeleteConfirm'
  | 'customToolErrorId'
  | 'customToolErrorName'
  | 'customToolErrorDescription'
  | 'customToolErrorCommand'
  | 'customToolErrorParam'
  | 'customToolCreateFailed'
  | 'customToolUpdateFailed'
  | 'customToolDeleteFailed'

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
  fieldMcp: 'MCP servers',
  mcpHint: 'Loading this skill mounts these servers for the session.',
  mcpPlaceholder: 'server-id',
  mcpAdd: 'Add',
  mcpRemove: 'Remove',
  mcpBadge: 'mcp: {servers}',
  mcpCustomHint: 'No MCP servers are configured — enter a server id.',
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

  // Custom command tools (Tools group)
  customToolAdd: '+ Add tool',
  customToolNewTitle: 'New command tool',
  customToolEditTitle: 'Edit command tool',
  customToolBadge: 'custom',
  customToolId: 'Id',
  customToolName: 'Name',
  customToolDescription: 'Description',
  customToolCommand: 'Command template',
  customToolCommandHint: 'Use {{param}} placeholders; every value is shell-quoted before execution.',
  customToolParams: 'Parameters',
  customToolParamName: 'Name',
  customToolParamType: 'Type',
  customToolParamRequired: 'Required',
  customToolParamDescription: 'Description',
  customToolParamNamePlaceholder: 'path',
  customToolCommandPlaceholder: 'gh api {{path}}',
  customToolAddParam: '+ Add parameter',
  customToolRemoveParam: 'Remove',
  customToolCreate: 'Create',
  customToolSave: 'Save',
  customToolDeleteTitle: 'Delete tool',
  customToolDeleteConfirm: 'Delete “{name}”? The tool unregisters and its permission row is removed.',
  customToolErrorId: 'A kebab-case id is required ([a-z0-9]+(-[a-z0-9]+)*).',
  customToolErrorName: 'A name is required.',
  customToolErrorDescription: 'A description is required.',
  customToolErrorCommand: 'A command is required.',
  customToolErrorParam: 'Parameter names must be kebab-case and unique.',
  customToolCreateFailed: 'Could not create the tool: {reason}',
  customToolUpdateFailed: 'Could not save the tool: {reason}',
  customToolDeleteFailed: 'Could not delete the tool: {reason}',
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
  fieldMcp: 'MCP 服务器',
  mcpHint: '加载此技能时会为该会话挂载这些服务器。',
  mcpPlaceholder: 'server-id',
  mcpAdd: '添加',
  mcpRemove: '移除',
  mcpBadge: 'mcp: {servers}',
  mcpCustomHint: '尚未配置 MCP 服务器——请直接输入服务器 id。',
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

  // Custom command tools (Tools group)
  customToolAdd: '+ 添加工具',
  customToolNewTitle: '新建命令工具',
  customToolEditTitle: '编辑命令工具',
  customToolBadge: '自定义',
  customToolId: 'Id',
  customToolName: '名称',
  customToolDescription: '描述',
  customToolCommand: '命令模板',
  customToolCommandHint: '使用 {{param}} 占位符；执行前每个值都会进行 shell 引号转义。',
  customToolParams: '参数',
  customToolParamName: '名称',
  customToolParamType: '类型',
  customToolParamRequired: '必填',
  customToolParamDescription: '描述',
  customToolParamNamePlaceholder: 'path',
  customToolCommandPlaceholder: 'gh api {{path}}',
  customToolAddParam: '+ 添加参数',
  customToolRemoveParam: '移除',
  customToolCreate: '创建',
  customToolSave: '保存',
  customToolDeleteTitle: '删除工具',
  customToolDeleteConfirm: '删除「{name}」？工具会注销，其权限行也会移除。',
  customToolErrorId: '需要 kebab-case 的 Id（[a-z0-9]+(-[a-z0-9]+)*）。',
  customToolErrorName: '名称不能为空。',
  customToolErrorDescription: '描述不能为空。',
  customToolErrorCommand: '命令不能为空。',
  customToolErrorParam: '参数名必须是 kebab-case 且不重复。',
  customToolCreateFailed: '创建工具失败：{reason}',
  customToolUpdateFailed: '保存工具失败：{reason}',
  customToolDeleteFailed: '删除工具失败：{reason}',
}
