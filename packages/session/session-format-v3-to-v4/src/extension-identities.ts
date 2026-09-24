/** Fixed V3 event vocabulary and namespaced historical opaque events. */

import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'

// This historical list must not inherit additions or removals from the current Session event list.
/* jscpd:ignore-start */
/** First-party event names understood by the released V3 reader, independent of the installed writer. */
export const RELEASED_V3_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
  'workspace/changes',
])
/* jscpd:ignore-end */

/**
 * Installed Enpoi-fork vocabulary outside the frozen released V3 inventory.
 * The V3-era writers emitted these types as required events, and the V0→V1
 * edge stamped the older ones `ignorable: true`; the V3→V4 edge must neither
 * refuse them nor rename them to `plugin:<type>`, because every fork reader
 * folds them by this exact name. Payloads stay owner-opaque: only the envelope
 * is checked and the coordinate is moved.
 */
export const OPAQUE_FORK_V3_EVENT_TYPES: ReadonlySet<string> = new Set([
  'brief/prose-updated',
  'brief/blocker',
  'brief/decision',
  'brief/files',
  'brief/phase-updated',
  'claim/intake',
  'claim/graduated',
  'claim/rescinded',
  'claim/untrusted-pending',
  'council/started',
  'council/round',
  'council/finished',
  'llm/attempt-failed',
  'oracle/verdict-committed',
  'revert/state',
  'revert/file-intent',
  'revert/file-result',
  'revert/file-conflict',
  'state/checkpoint',
  'verify/unmet',
  'capability/toggled',
])

/**
 * Keep unknown ignorable events opaque after header promotion.
 * Installed fork vocabulary is exempt: it keeps its exact name so installed
 * readers fold it without re-learning a namespace.
 * @param event - original V3 event; this incoming identity conversion is applied once.
 * @returns the same event or an ignorable namespaced event retaining its payload and coordinates.
 */
export function namespaceV3OpaqueEvent(event: SessionFormatEvent): SessionFormatEvent {
  return event['ignorable'] === true && !RELEASED_V3_EVENT_TYPES.has(event.type) && !OPAQUE_FORK_V3_EVENT_TYPES.has(event.type)
    ? { ...event, type: `plugin:${event.type}`, ignorable: true }
    : event
}
