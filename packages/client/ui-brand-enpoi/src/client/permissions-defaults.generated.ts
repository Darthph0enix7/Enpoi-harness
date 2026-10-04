/**
 * GENERATED FILE — do not edit by hand; regenerate instead.
 *
 * The client mirror of the host-owned shipped defaults and child role
 * tables. The Permissions page resolves every row against this data, so a
 * stale mirror would show a wrong decision/provenance.
 *
 * Sources: /home/adam/.dsh/profiles/web/packages/enpoi-capabilities/src/policy.ts
 *          /home/adam/.dsh/profiles/web/packages/enpoi-tool-groups/src/catalog.ts
 *          /home/adam/deepseek-harness/packages/subagent/tool-subagent/src/index.ts
 *          /home/adam/deepseek-harness/scripts/tool-inventory/expected-orchestrator.json
 *
 * Regenerate:
 *   pnpm exec tsx packages/client/ui-brand-enpoi/scripts/generate-permissions-mirror.ts --write
 * Check:
 *   pnpm exec tsx packages/client/ui-brand-enpoi/scripts/generate-permissions-mirror.ts --check
 * `HOST_DEFAULTS_DIGEST` covers the host-owned payload; the host repository's
 * tool-defaults completeness spec verifies it from the other side.
 */

export const HOST_DEFAULTS_DIGEST = '8d93d6e784cad7141f24344b872b100023c7dcb82abc17bf0bdf241e99a019d7'

export const MIRROR_SOURCE_DIGEST = 'da4d4ab349c0f6f379b954eb7bc949b94c8c2dc0612c10f48285a3a5fa88899a'

/** Shipped per-tool defaults from the host policy resolver. */
export const SHIPPED_TOOL_DEFAULTS: Readonly<Record<string, 'allow' | 'ask' | 'deny'>> = Object.freeze({
  'ask_user_question': 'allow',
  'bash': 'ask',
  'chorus': 'allow',
  'cordis_inspect_list': 'allow',
  'cordis_inspect_query': 'allow',
  'council_list': 'allow',
  'council_register': 'ask',
  'create_goal': 'allow',
  'custom_research-fetch': 'allow',
  'custom_research-verify': 'allow',
  'diagnostics_report': 'allow',
  'edit': 'allow',
  'exit_plan_mode': 'allow',
  'fast_report': 'allow',
  'get_goal': 'allow',
  'glob': 'allow',
  'grep': 'allow',
  'interrupt_agent': 'ask',
  'job_kill': 'ask',
  'job_list': 'allow',
  'job_output': 'allow',
  'list_agents': 'allow',
  'mcp': 'allow',
  'memory_confirm': 'allow',
  'memory_rescind': 'allow',
  'memory_save': 'allow',
  'memory_search': 'allow',
  'oracle_review': 'allow',
  'plugin_manager': 'allow',
  'present': 'allow',
  'ralph': 'allow',
  'read': 'allow',
  'read_image': 'allow',
  'request_evidence': 'allow',
  'roundtable': 'allow',
  'run_code': 'allow',
  'send_message': 'allow',
  'session_debug': 'allow',
  'session_event_read': 'allow',
  'session_event_search': 'allow',
  'session_event_trace': 'allow',
  'session_search': 'allow',
  'session_trace': 'allow',
  'skill': 'allow',
  'str_replace_editor': 'ask',
  'subagent': 'allow',
  'task': 'allow',
  'todo_write': 'allow',
  'tool_groups': 'allow',
  'update_goal': 'allow',
  'web_fetch': 'allow',
  'web_search': 'allow',
  'whiteboard_forget': 'allow',
  'whiteboard_pin': 'allow',
  'whiteboard_read': 'allow',
  'whiteboard_unpin': 'allow',
  'whiteboard_write': 'allow',
  'workflow': 'allow',
  'write': 'allow',
})

/** Host families deliberately left to `defaults.unknownTools` (shipped ask). */
export const SHIPPED_TOOL_DEFAULT_EXEMPTIONS: readonly { prefix: string; except?: readonly string[]; reason: string }[] = Object.freeze([
  { prefix: 'custom_', except: ['custom_research-fetch', 'custom_research-verify'], reason: 'operator-defined custom tools are configured per tool; each renders a command that runs through the bash evaluator, and until the operator sets a row the unknown-tools ask is the intended gate. The first-party research tools (doc 88) are the documented exception: their commands are fixed, local, and read-only, and they carry explicit allow rows above so an unattended research run never parks on a card' },
  { prefix: 'mcp__', reason: 'tools of mounted MCP servers are third-party surface; the MCP wildcard ladder and the unknown-tools ask gate them until the operator trusts a row or a server wildcard' },
  { prefix: 'peer_', reason: "first-party on-demand fleet tools (peer_ask, peer_asks, peer_answer, peer_cancel, peer_status) mount from enpoi-peer-bridge only while the peer driver runs; a call reaches another device's agent, so until the operator sets a row the unknown-tools ask is the intended gate" },
])

/** One shipped tool group (profile `enpoi-tool-groups` catalog). */
export interface ShippedToolGroupMirror {
  readonly id: string
  readonly label: string
  readonly purpose: string
  readonly mode: 'static' | 'on-demand'
  readonly members: readonly string[]
  readonly preAttach: readonly string[]
  readonly seats?: readonly string[]
  readonly enabled: boolean
}

/** The shipped tool-group catalog: the Permissions family rows derive from this list. */
export const SHIPPED_TOOL_GROUP_CATALOG: readonly ShippedToolGroupMirror[] = Object.freeze([
  Object.freeze({
    id: 'core',
    label: 'Core',
    purpose: 'the everyday implementation surface',
    mode: 'static',
    members: Object.freeze(['ask_user_question', 'bash', 'edit', 'glob', 'grep', 'read', 'read_image', 'skill', 'subagent', 'todo_write', 'web_search', 'write', 'present']),
    preAttach: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: 'goals',
    label: 'Goals',
    purpose: 'create, read, and update the session goal',
    mode: 'static',
    members: Object.freeze(['create_goal', 'get_goal', 'update_goal']),
    preAttach: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: 'plan',
    label: 'Plan mode',
    purpose: 'submit an implementation plan for approval',
    mode: 'static',
    members: Object.freeze(['exit_plan_mode']),
    preAttach: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: 'councils',
    label: 'Councils',
    purpose: 'oracle review, roundtable debate, and chorus brainstorming',
    mode: 'static',
    members: Object.freeze(['chorus', 'council_list', 'council_register', 'oracle_review', 'request_evidence', 'roundtable']),
    preAttach: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: 'jobs',
    label: 'Jobs',
    purpose: 'list, read, and stop background shell jobs',
    mode: 'static',
    members: Object.freeze(['job_kill', 'job_list', 'job_output']),
    preAttach: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: 'workflow',
    label: 'Workflows',
    purpose: 'run deterministic workflow and ralph programs',
    mode: 'static',
    members: Object.freeze(['ralph', 'workflow']),
    preAttach: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: 'reporting',
    label: 'Reporting',
    purpose: 'fast structured progress reports',
    mode: 'static',
    members: Object.freeze(['fast_report']),
    preAttach: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: 'whiteboard',
    label: 'Whiteboard',
    purpose: 'pin, read, and forget durable board notes',
    mode: 'static',
    members: Object.freeze(['whiteboard_forget', 'whiteboard_pin', 'whiteboard_read', 'whiteboard_unpin', 'whiteboard_write']),
    preAttach: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: 'memory',
    label: 'Memory',
    purpose: 'save, search, confirm, and rescind durable project facts',
    mode: 'static',
    members: Object.freeze(['memory_confirm', 'memory_rescind', 'memory_save', 'memory_search']),
    preAttach: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: 'peer',
    label: 'Peer interconnect',
    purpose: 'cross-device peer sessions: status, ask, answer, cancel',
    mode: 'on-demand',
    members: Object.freeze(['peer_status', 'peer_ask', 'peer_asks', 'peer_answer', 'peer_cancel']),
    preAttach: Object.freeze([]),
    enabled: true,
  }),
  Object.freeze({
    id: 'debug',
    label: 'Debug & observability',
    purpose: 'session log, event trace, and diagnostics inspection',
    mode: 'on-demand',
    members: Object.freeze(['diagnostics_report', 'session_debug', 'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace']),
    preAttach: Object.freeze(['orchestrator', 'sysadmin', 'creator', 'broker']),
    enabled: true,
  }),
  Object.freeze({
    id: 'creator',
    label: 'Creator (harness authoring)',
    purpose: 'inspect and manage the harness plugin composition',
    mode: 'on-demand',
    members: Object.freeze(['cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager']),
    preAttach: Object.freeze(['creator']),
    seats: Object.freeze(['creator']),
    enabled: true,
  }),
])

/** Tools the shipped seat guard denies per seat (`SHIPPED_SEAT_TOOL_DENY`). */
export const SHIPPED_SEAT_TOOL_DENY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'orchestrator': Object.freeze(['plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query']),
  'sysadmin': Object.freeze(['plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query']),
})

/** Tools every child keeps regardless of role surface (host keep list). */
export const SHARED_CHILD_KEEP: readonly string[] = Object.freeze(['whiteboard_read', 'whiteboard_write', 'whiteboard_pin', 'whiteboard_unpin'])

/** Tools denied to every child (host anti-leak floor). */
export const SHARED_CHILD_DENY: readonly string[] = Object.freeze(['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'roundtable', 'chorus', 'oracle_review', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'plan_mode', 'goal', 'ralph', 'workflow', 'ask_user_question', 'send_message', 'interrupt_agent', 'list_agents', 'plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query', 'review_run'])

/** Extra per-role child denials (host role table). */
export const ROLE_CHILD_DENY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'explorer': Object.freeze(['edit', 'write', 'str_replace_editor']),
  'librarian': Object.freeze(['str_replace_editor']),
})

/** The main-agent advertised surface (shipped preset inventory). */
export const OPERATOR_SURFACE: readonly string[] = Object.freeze(['ask_user_question', 'bash', 'chorus', 'council_list', 'council_register', 'create_goal', 'diagnostics_report', 'edit', 'exit_plan_mode', 'fast_report', 'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents', 'mcp', 'memory_confirm', 'memory_rescind', 'memory_save', 'memory_search', 'oracle_review', 'present', 'ralph', 'read', 'read_image', 'request_evidence', 'roundtable', 'send_message', 'session_debug', 'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace', 'skill', 'subagent', 'todo_write', 'tool_groups', 'update_goal', 'web_search', 'whiteboard_forget', 'whiteboard_pin', 'whiteboard_read', 'whiteboard_unpin', 'whiteboard_write', 'workflow', 'write'])
