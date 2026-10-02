/**
 * GENERATED FILE — do not edit by hand; regenerate instead.
 *
 * The client mirror of the host-owned shipped defaults and child role
 * tables. The Permissions page resolves every row against this data, so a
 * stale mirror would show a wrong decision/provenance.
 *
 * Sources: /home/adam/.dsh/profiles/web/packages/enpoi-capabilities/src/policy.ts
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

export const HOST_DEFAULTS_DIGEST = 'bf4c14fcd185d2e4d5a7ac7ee7c0f7dda4d2dec07f097febff0fa399975dc43b'

export const MIRROR_SOURCE_DIGEST = '4e92d4a40e26375b623dcbc69a815290c7c328c562a1a9e7f3a79824b06c1a1d'

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
export const SHIPPED_TOOL_DEFAULT_EXEMPTIONS: readonly { prefix: string; reason: string }[] = Object.freeze([
  { prefix: 'custom_', reason: 'operator-defined custom tools are configured per tool; each renders a command that runs through the bash evaluator, and until the operator sets a row the unknown-tools ask is the intended gate' },
  { prefix: 'mcp__', reason: 'tools of mounted MCP servers are third-party surface; the MCP wildcard ladder and the unknown-tools ask gate them until the operator trusts a row or a server wildcard' },
  { prefix: 'peer_', reason: "first-party on-demand fleet tools (peer_ask, peer_asks, peer_answer, peer_cancel, peer_status) mount from enpoi-peer-bridge only while the peer driver runs; a call reaches another device's agent, so until the operator sets a row the unknown-tools ask is the intended gate" },
])

/** Tools every child keeps regardless of role surface (host keep list). */
export const SHARED_CHILD_KEEP: readonly string[] = Object.freeze(['whiteboard_read', 'whiteboard_write', 'whiteboard_pin', 'whiteboard_unpin'])

/** Tools denied to every child (host anti-leak floor). */
export const SHARED_CHILD_DENY: readonly string[] = Object.freeze(['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'roundtable', 'chorus', 'oracle_review', 'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'plan_mode', 'goal', 'ralph', 'workflow', 'job_output', 'job_list', 'job_kill', 'ask_user_question', 'send_message', 'interrupt_agent', 'list_agents'])

/** Extra per-role child denials (host role table). */
export const ROLE_CHILD_DENY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'explorer': Object.freeze(['edit', 'write', 'str_replace_editor']),
  'librarian': Object.freeze(['edit', 'write', 'str_replace_editor']),
})

/** The main-agent advertised surface (shipped preset inventory). */
export const OPERATOR_SURFACE: readonly string[] = Object.freeze(['ask_user_question', 'bash', 'chorus', 'cordis_inspect_list', 'cordis_inspect_query', 'council_list', 'council_register', 'create_goal', 'diagnostics_report', 'edit', 'exit_plan_mode', 'fast_report', 'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents', 'mcp', 'memory_confirm', 'memory_rescind', 'memory_save', 'memory_search', 'oracle_review', 'plugin_manager', 'present', 'ralph', 'read', 'read_image', 'request_evidence', 'roundtable', 'send_message', 'session_debug', 'session_event_read', 'session_event_search', 'session_event_trace', 'session_search', 'session_trace', 'skill', 'subagent', 'todo_write', 'tool_groups', 'update_goal', 'web_search', 'whiteboard_forget', 'whiteboard_pin', 'whiteboard_read', 'whiteboard_unpin', 'whiteboard_write', 'workflow', 'write'])
