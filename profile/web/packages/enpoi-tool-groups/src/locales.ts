/**
 * Host-locale dictionaries for the tool-group catalog labels.
 *
 * The catalog is host data, but its labels and purposes render in the browser
 * menu and in the `tool_groups` meta-tool output, so they are product copy.
 * zh is the key-set source of truth; en is checked complete against it. The
 * locale resolves from the durable `locale.preference` setting the client
 * writes, with the launch environment as the fallback before any preference
 * exists.
 *
 * @module dsh-enpoi-tool-groups/locales
 */

/** Locale ids this surface ships dictionaries for. */
export type HostLocale = 'en' | 'zh'

/**
 * The host locale from the launch environment: an explicit `DSH_LOCALE` wins
 * over the POSIX tags. Anything but a `zh` tag resolves to `en`.
 * @param env - environment to read; defaults to the process environment.
 * @returns the resolved host locale.
 */
export function hostLocale(env: NodeJS.ProcessEnv = process.env): HostLocale {
  const tag = env.DSH_LOCALE ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? ''
  return /^zh\b/i.test(tag.replaceAll('_', '-')) ? 'zh' : 'en'
}

/**
 * Normalize one durable `locale.preference` value.
 * @param preference - the stored preference, if any.
 * @param env - environment used when no preference is stored.
 * @returns the resolved host locale.
 */
export function localeFromPreference(preference: unknown, env: NodeJS.ProcessEnv = process.env): HostLocale {
  if (typeof preference !== 'string' || preference === '') return hostLocale(env)
  return /^zh\b/i.test(preference.replaceAll('_', '-')) ? 'zh' : 'en'
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'group.core.label': '核心',
  'group.core.purpose': '日常实现所需的工具面',
  'group.goals.label': '目标',
  'group.goals.purpose': '创建、读取并更新会话目标',
  'group.plan.label': '计划模式',
  'group.plan.purpose': '提交实现计划以供审批',
  'group.councils.label': '委员会',
  'group.councils.purpose': 'oracle 评审、圆桌辩论与 chorus 头脑风暴',
  'group.jobs.label': '后台任务',
  'group.jobs.purpose': '列出、读取并停止后台 shell 任务',
  'group.workflow.label': '工作流',
  'group.workflow.purpose': '运行确定性的 workflow 与 ralph 程序',
  'group.reporting.label': '报告',
  'group.reporting.purpose': '快速的结构化进度报告',
  'group.whiteboard.label': '白板',
  'group.whiteboard.purpose': '固定、读取并遗忘持久白板笔记',
  'group.memory.label': '记忆',
  'group.memory.purpose': '保存、搜索、确认并撤回持久项目事实',
  'group.peer.label': '对等互联',
  'group.peer.purpose': '跨设备对等会话：状态、提问、回答、取消',
  'group.debug.label': '调试与可观测性',
  'group.debug.purpose': '会话日志、事件轨迹与诊断检查',
  'group.creator.label': '创建者（harness 编写）',
  'group.creator.purpose': '检查并管理 harness 插件组合',
} satisfies Record<string, string>

/** The tool-group text key union. */
export type ToolGroupTextKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'group.core.label': 'Core',
  'group.core.purpose': 'the everyday implementation surface',
  'group.goals.label': 'Goals',
  'group.goals.purpose': 'create, read, and update the session goal',
  'group.plan.label': 'Plan mode',
  'group.plan.purpose': 'submit an implementation plan for approval',
  'group.councils.label': 'Councils',
  'group.councils.purpose': 'oracle review, roundtable debate, and chorus brainstorming',
  'group.jobs.label': 'Jobs',
  'group.jobs.purpose': 'list, read, and stop background shell jobs',
  'group.workflow.label': 'Workflows',
  'group.workflow.purpose': 'run deterministic workflow and ralph programs',
  'group.reporting.label': 'Reporting',
  'group.reporting.purpose': 'fast structured progress reports',
  'group.whiteboard.label': 'Whiteboard',
  'group.whiteboard.purpose': 'pin, read, and forget durable board notes',
  'group.memory.label': 'Memory',
  'group.memory.purpose': 'save, search, confirm, and rescind durable project facts',
  'group.peer.label': 'Peer interconnect',
  'group.peer.purpose': 'cross-device peer sessions: status, ask, answer, cancel',
  'group.debug.label': 'Debug & observability',
  'group.debug.purpose': 'session log, event trace, and diagnostics inspection',
  'group.creator.label': 'Creator (harness authoring)',
  'group.creator.purpose': 'inspect and manage the harness plugin composition',
} satisfies Record<ToolGroupTextKey, string>

/** Shipped group copy by locale; a group without a dictionary entry keeps its code copy. */
export function toolGroupText(
  locale: HostLocale,
  id: string,
  field: 'label' | 'purpose',
  fallback: string,
): string {
  const key = `group.${id}.${field}` as ToolGroupTextKey
  const value = (locale === 'zh' ? zh : en)[key]
  return value ?? fallback
}
