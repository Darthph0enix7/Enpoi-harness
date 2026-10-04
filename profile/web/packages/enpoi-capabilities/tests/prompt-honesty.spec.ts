/**
 * Prompt-surface honesty: a section may only name a tool the advertised
 * surface carries. The fixture texts below are verbatim from the live
 * 2026-09-28 roundtable debater session that burned four `job_output` calls.
 */
import { describe, expect, it } from 'vitest'
import {
  mentionsTool, stripUnavailableToolGuidance, type PromptSectionLike,
} from '../src/prompt-honesty'

/** The pragmatist's live advertised surface (request/header of session ec40bca6). */
const PRAGMATIST_SURFACE = new Set([
  'fast_report', 'memory_search', 'present', 'todo_write', 'tool_groups',
  'whiteboard_forget', 'whiteboard_pin', 'whiteboard_read', 'whiteboard_unpin', 'whiteboard_write',
])

/** The live registry vocabulary around that debater (restricted names included). */
const VOCABULARY = new Set([
  ...PRAGMATIST_SURFACE,
  'bash', 'edit', 'write', 'read', 'glob', 'grep', 'subagent', 'skill', 'task',
  'job_output', 'job_kill', 'job_list',
  'session_search', 'session_event_search', 'session_event_read', 'session_event_trace', 'session_trace',
  'create_goal', 'get_goal', 'update_goal',
  'workflow', 'ralph',
  'peer_status', 'peer_ask', 'peer_asks', 'peer_answer', 'peer_cancel',
  'diagnostics_report', 'session_debug',
])

const SECTIONS: PromptSectionLike[] = [
  {
    name: 'tool:bash', order: 1000,
    text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
  },
  {
    name: 'tool:jobs', order: 1600,
    text: 'Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job\'s work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.',
  },
  {
    name: 'tool:session-query', order: 2300,
    text: 'Use session_search to find relevant work from prior sessions, or session_event_search to search earlier events in one session. Search results are cursor-free and workspace-scoped. Follow a useful hit with session_trace, session_event_trace, or session_event_read when you need lineage, relationships, or exact data.',
  },
  {
    name: 'tool:goal', order: 2400,
    text: 'create_goal may infer goal intent from a direct human request in any language. After session resume or fork, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it.',
  },
  {
    name: 'tool:workflow', order: 2600,
    text: 'Use the workflow tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.',
  },
  {
    name: 'tool:ralph', order: 2700,
    text: 'Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory.',
  },
  {
    name: 'tool-groups:menu', order: 2950,
    text: 'Tool groups — extra tool families stay off until attached. Call tool_groups with action "attach" and the group id to add one; its tools appear in your tool list from the next turn.\n- peer — cross-device peer sessions: status, ask, answer, cancel (5 tools, not attached)\n- debug — session log, event trace, and diagnostics inspection (7 tools, not attached)',
  },
  {
    name: 'tool:present', order: 2900,
    text: 'Use present when a separate file card helps the user open the complete deliverable. Do not call present just to list edited source files.',
  },
]

describe('prompt-surface honesty', () => {
  it('mentionsTool: snake_case identifiers count anywhere; ordinary words only in tool position', () => {
    expect(mentionsTool('collect every job with job_output now', 'job_output')).toBe(true)
    expect(mentionsTool('The run_code tool is non-functional', 'run_code')).toBe(true)
    expect(mentionsTool('the read tool — not shell commands like cat', 'read')).toBe(true)
    expect(mentionsTool('use bash to inspect', 'bash')).toBe(true)
    expect(mentionsTool('prefer plain subagent calls', 'subagent')).toBe(true)
    expect(mentionsTool('read the file before editing', 'read')).toBe(false)
    expect(mentionsTool('the presentation layer', 'present')).toBe(false)
  })

  it('a narrow seat keeps no section text naming a tool its surface lacks', () => {
    const kept = stripUnavailableToolGuidance(SECTIONS, PRAGMATIST_SURFACE, VOCABULARY)
    const names = kept.map(section => section.name)
    // The stale guidance is gone entirely (own tool not advertised / no honest text left).
    expect(names).not.toContain('tool:bash')
    expect(names).not.toContain('tool:jobs')
    expect(names).not.toContain('tool:session-query')
    expect(names).not.toContain('tool:goal')
    expect(names).not.toContain('tool:workflow')
    expect(names).not.toContain('tool:ralph')
    // The advertised meta-tool and the advertised present tool survive.
    expect(names).toContain('tool-groups:menu')
    expect(names).toContain('tool:present')
    // And no unavailable name survives anywhere in the rendered prompt. Bare
    // English words are checked with word boundaries ("edited" ≠ a `edit` mention).
    const rendered = kept.map(section => section.text).join('\n\n')
    const unavailable = [...VOCABULARY].filter(name => !PRAGMATIST_SURFACE.has(name))
    for (const name of unavailable) {
      if (!name.includes('_') && !['bash', 'edit', 'write', 'read', 'glob', 'grep', 'skill', 'task'].includes(name)) continue
      expect(new RegExp(`\\b${name}\\b`).test(rendered)).toBe(false)
    }
  })

  it('a seat with the tools keeps every mention, byte for byte', () => {
    const wide = new Set(VOCABULARY)
    const kept = stripUnavailableToolGuidance(SECTIONS, wide, VOCABULARY)
    expect(kept).toEqual(SECTIONS)
  })

  it('drops only the stale paragraph of a mixed section', () => {
    const mixed: PromptSectionLike[] = [{
      name: 'tool:custom', order: 1,
      text: 'This paragraph is honest: it mentions read, which is advertised.\n\nThe stale half tells the model to collect with job_output.',
    }]
    const kept = stripUnavailableToolGuidance(mixed, new Set([...PRAGMATIST_SURFACE, 'read']), VOCABULARY)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.text).toBe('This paragraph is honest: it mentions read, which is advertised.')
  })

  it('leaves an assembly with nothing unavailable untouched', () => {
    const narrow = new Set(['read', 'bash'])
    const kept = stripUnavailableToolGuidance(SECTIONS, narrow, narrow)
    expect(kept).toEqual(SECTIONS)
  })
})
