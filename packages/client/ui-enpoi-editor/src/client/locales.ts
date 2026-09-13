/**
 * `enpoiEditor` namespace dictionaries: toolbar, banner, and failure copy for
 * the editable file workbench.
 */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  loading: '正在读取…',
  loadFailed: '读取失败：{message}',
  retry: '重试',
  notFound: '文件不存在',
  notFoundDetail: '文件可能已被移动或删除。',
  bufferKept: '未保存的修改仍保留在内存中。',
  reload: '重新载入',
  save: '保存',
  saving: '正在保存…',
  saved: '已保存',
  saveFailed: '保存失败',
  dirty: '有未保存的修改',
  wrapEnable: '开启自动换行',
  wrapDisable: '关闭自动换行',
  wrapAria: '自动换行',
  preview: '预览',
  edit: '编辑',
  externalChanged: '文件已在磁盘上更新',
  externalConfirm: '放弃未保存的修改并重新载入？',
  discardReload: '放弃并重新载入',
  keepEditing: '继续编辑',
  dismiss: '忽略',
  conflict: '文件已在磁盘上更新，保存被阻止。',
  overwrite: '覆盖保存',
  truncated: '文件过大，无法安全编辑；当前显示只读前缀。',
} satisfies Record<string, string>

/** Editor dictionary key union. */
export type EnpoiEditorKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  loading: 'Reading…',
  loadFailed: 'Read failed: {message}',
  retry: 'Retry',
  notFound: 'File not found',
  notFoundDetail: 'The file may have been moved or deleted.',
  bufferKept: 'Unsaved changes are kept in memory.',
  reload: 'Reload',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  saveFailed: 'Save failed',
  dirty: 'Unsaved changes',
  wrapEnable: 'Turn on line wrap',
  wrapDisable: 'Turn off line wrap',
  wrapAria: 'Line wrap',
  preview: 'Preview',
  edit: 'Edit',
  externalChanged: 'File changed on disk',
  externalConfirm: 'Discard your unsaved changes and reload?',
  discardReload: 'Discard and reload',
  keepEditing: 'Keep editing',
  dismiss: 'Dismiss',
  conflict: 'File changed on disk; the save was blocked.',
  overwrite: 'Overwrite',
  truncated: 'File is too large to edit; showing a read-only prefix.',
} satisfies Record<EnpoiEditorKey, string>
