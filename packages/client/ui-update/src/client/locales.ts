/**
 * `update` namespace dictionaries: the chrome indicator, the update dialog
 * (changelog, progress, failure), and the post-restart toast. Version and
 * channel values are wire data rendered verbatim through placeholders.
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'update'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'indicator.available': '{version} ↑',
  'indicator.availableAria': '有新版本 {version}，点击查看',
  'indicator.updating': '正在更新…',
  'indicator.updatingAria': '正在更新：步骤 {step}/{steps}',
  'dialog.title': 'Harness 更新',
  'dialog.close': '关闭',
  'dialog.versions': '{current} → {latest}',
  'dialog.channel': '更新通道：{channel}',
  'dialog.notes': '更新内容',
  'dialog.notesEmpty': '（无提交说明）',
  'action.updateNow': '立即更新',
  'action.later': '稍后',
  'action.skip': '跳过此版本',
  'action.retry': '重试',
  'action.close': '关闭',
  'progress.title': '正在更新',
  'progress.starting': '正在启动更新器…',
  'progress.step': '步骤 {step}/{steps}',
  'progress.disconnectWarning': '切换到新版本时界面会短暂断开，随后自动重连并重新加载。',
  'result.success': '已更新到 {version}',
  'result.failed': '更新失败',
  'result.rolledback': '更新失败，已回滚到原版本',
  'failure.log': '日志末尾',
  'error.action': '操作失败：{message}',
  'toast.updated': '已更新到 {version}',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<UpdateKey, string> = {
  'indicator.available': '{version} ↑',
  'indicator.availableAria': 'Update {version} available — click for details',
  'indicator.updating': 'Updating…',
  'indicator.updatingAria': 'Updating: step {step}/{steps}',
  'dialog.title': 'Harness update',
  'dialog.close': 'Close',
  'dialog.versions': '{current} → {latest}',
  'dialog.channel': 'Channel: {channel}',
  'dialog.notes': "What's new",
  'dialog.notesEmpty': '(no commit notes)',
  'action.updateNow': 'Update now',
  'action.later': 'Later',
  'action.skip': 'Skip this version',
  'action.retry': 'Retry',
  'action.close': 'Close',
  'progress.title': 'Updating',
  'progress.starting': 'Starting the updater…',
  'progress.step': 'Step {step}/{steps}',
  'progress.disconnectWarning': 'The UI briefly disconnects while switching to the new version, then reconnects and reloads on its own.',
  'result.success': 'Updated to {version}',
  'result.failed': 'Update failed',
  'result.rolledback': 'Update failed and rolled back to the previous version',
  'failure.log': 'Log tail',
  'error.action': 'Action failed: {message}',
  'toast.updated': 'Updated to {version}',
}

/** Key domain of the `update` namespace (zh is the source of truth). */
export type UpdateKey = keyof typeof zh
