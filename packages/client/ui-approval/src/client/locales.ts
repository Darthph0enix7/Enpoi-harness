/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allowOnce: '允许一次',
  allowAlways: '始终允许',
  allowAll: '全部允许 {label}',
  recommendation: '建议',
  recommendationHint: '仅供参考：模型建议 {suggestion}，不会自动执行。',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allowOnce: 'Allow once',
  allowAlways: 'Always allow',
  allowAll: 'Allow all {label}',
  recommendation: 'Recommendation',
  recommendationHint: 'Advisory only: the model suggests {suggestion} — it is never applied automatically.',
} satisfies Record<ApprovalKey, string>
