/**
 * Native session-format V4 `tool/result` payload captures for the verify-gate
 * spec.
 *
 * Every payload is a verbatim `data` object from a persisted
 * `session.v4.jsonl.zstd` log (provenance in each comment). The retired V3
 * representation wrapped the result in a nested `{ type: 'tool-result' }`
 * content block; native V4 lifts the wrapper's text and `isError` onto the
 * tool-role message. The gate regression was masked by V3-shaped fixtures, so
 * these captures are the real shape the `session/event` listener receives.
 *
 * `bashIsErrorNoIdentity` is the one documented derivation: no work-tool
 * capture in the fleet carries `message.isError: true` without a structured
 * `data.error`, so the real `ToolOutcomeUnknownError` capture is reused with
 * `error` removed to exercise the `is-error` branch on a native envelope.
 */

/** Real capture: subagent capacity rejection (session-232802d3…, seq 214, turn 8 step 6). */
export const capacityRejection: Record<string, unknown> = {
  turn: 8,
  step: 6,
  message: {
    role: 'tool',
    source: { kind: 'tool', callId: 'b3125d6b-4816-4fa9-9325-c6cbdb04d972' },
    toolCallId: 'b3125d6b-4816-4fa9-9325-c6cbdb04d972',
    content: [{
      type: 'text',
      text: 'Error: subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents',
    }],
    isError: true,
    id: '25f2fc06-9444-49cd-bb69-8aebe07da1d0',
  },
  error: { name: 'SubagentError', code: 'ACTIVATION_LIMIT_REACHED' },
}

/** Real capture: bash exit 2 (session-5e5ea93b…, seq 276, turn 5 step 1). */
export const bashExitFailure: Record<string, unknown> = {
  turn: 5,
  step: 1,
  message: {
    role: 'tool',
    source: { kind: 'tool', callId: 'chatcmpl-tool-a2af395f1409a07d' },
    toolCallId: 'chatcmpl-tool-a2af395f1409a07d',
    content: [{
      type: 'text',
      text: "ls: cannot access '/home/adam/edit-tool-test': No such file or directory\n[exit code: 2]",
    }],
    isError: false,
    id: 'b83221f0-ef5e-45d8-b90f-6c016541b7b0',
  },
  meta: { exitCode: 2 },
}

/** Real capture: clean bash exit 0 (session-232802d3…, seq 588, turn 10 step 2). */
export const bashClean: Record<string, unknown> = {
  turn: 10,
  step: 2,
  message: {
    role: 'tool',
    source: { kind: 'tool', callId: '7aa9fa33-bfd4-4ace-916c-a5c3279266c9' },
    toolCallId: '7aa9fa33-bfd4-4ace-916c-a5c3279266c9',
    content: [{ type: 'text', text: '2026-10-02T09:31:29+00:00\n' }],
    isError: false,
    id: '56620d80-e9cf-440c-86d3-88224379e67b',
  },
  meta: { exitCode: 0 },
}

/** Real capture: bash failure text with no `meta` (session-0c33bd2a…, seq 18, turn 1 step 1). */
export const bashFailureText: Record<string, unknown> = {
  turn: 1,
  step: 1,
  message: {
    role: 'tool',
    source: { kind: 'tool', callId: 'call_782738' },
    toolCallId: 'call_782738',
    content: [{
      type: 'text',
      text: '/home/adam\n[stderr]\nfatal: not a git repository (or any of the parent directories): .git\n[exit code: 128]',
    }],
    isError: false,
    id: 'c0f950f1-271b-4b59-bd14-294ff00af140',
  },
}

/** Real capture: bash `isError` + structured error (session-4bcb6731…, seq 33, turn 1 step 3). */
export const bashIsError: Record<string, unknown> = {
  turn: 1,
  step: 3,
  message: {
    role: 'tool',
    source: { kind: 'tool', callId: 'call_5503935' },
    toolCallId: 'call_5503935',
    content: [{
      type: 'text',
      text: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
    }],
    isError: true,
    id: 'interrupted-tool-result-call_5503935-33',
  },
  error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
}

/** Derived from {@link bashIsError}: same native envelope, `data.error` removed. */
export const bashIsErrorNoIdentity: Record<string, unknown> = (() => {
  const { error: _error, ...rest } = bashIsError as Record<string, unknown> & { error?: unknown }
  return structuredClone(rest)
})()

/** Real capture: non-verification read result (session-232802d3…, seq 435, turn 9 step 11). */
export const readResult: Record<string, unknown> = {
  turn: 9,
  step: 11,
  message: {
    role: 'tool',
    source: { kind: 'tool', callId: '69fb3ff1-60a2-4a1c-95b7-6b60e0c014f6' },
    toolCallId: '69fb3ff1-60a2-4a1c-95b7-6b60e0c014f6',
    content: [{
      type: 'text',
      text: '<path>/home/adam/.wave5-realwork-probe.txt</path>\n<type>file</type>\n<content>\n1: 2026-10-02T09:13:52+00:00\n\n(End of file - total 1 lines)\n</content>',
    }],
    isError: false,
    id: '26bb733c-1cb3-453d-b76f-e600769ae8b1',
  },
  meta: {
    path: '/home/adam/.wave5-realwork-probe.txt',
    offset: 1,
    lines: [{ number: 1, text: '2026-10-02T09:13:52+00:00' }],
    totalLines: 1,
  },
}

/** Real capture: structured error on a non-control work surface (session-232802d3…, seq 974, turn 16 step 10). */
export const editAmbiguous: Record<string, unknown> = {
  turn: 16,
  step: 10,
  message: {
    role: 'tool',
    source: { kind: 'tool', callId: '28d48f57-026a-4ed7-b234-bacf62ee4f7f' },
    toolCallId: '28d48f57-026a-4ed7-b234-bacf62ee4f7f',
    content: [{
      type: 'text',
      text: 'Error: old_string matched 2 times in "/home/adam/subagent-probe-findings.md"; provide a more specific old_string or set replace_all to true',
    }],
    isError: true,
    id: '164f18b0-ed8c-48fe-912b-4bb5bb89ed0e',
  },
  error: { name: 'FsError', code: 'FS_AMBIGUOUS_EDIT' },
}

/** Real capture: control-plane approval failure (session-232802d3…, seq 573, turn 10 step 1). */
export const getGoalApprovalUnavailable: Record<string, unknown> = {
  turn: 10,
  step: 1,
  message: {
    role: 'tool',
    source: { kind: 'tool', callId: '23ad2029-f35f-4564-9a4c-3647a16cdadc' },
    toolCallId: '23ad2029-f35f-4564-9a4c-3647a16cdadc',
    content: [{
      type: 'text',
      text: 'Error: tool "get_goal" requires approval, but no approval channel is available',
    }],
    isError: true,
    id: 'b8cc3945-2cf2-41a8-99f3-8c6aa8247c6f',
  },
}

/**
 * The retired V3 wrapper shape (kept only as a negative fixture): nested
 * `{ type: 'tool-result', content, isError }` on a `user`-role message. The
 * session core rejects this at the seed/load boundary and session-format-v3-to-v4
 * lifts it, so the parser deliberately does not read it.
 */
export const retiredV3BashResult: Record<string, unknown> = {
  turn: 1,
  step: 1,
  message: {
    source: { kind: 'tool', callId: 'call_legacy_1' },
    content: [{
      type: 'tool-result',
      toolCallId: 'call_legacy_1',
      content: [{ type: 'text', text: 'FAILED test_cart.py::test_total - assert [] == [7]\n[exit code: 1]' }],
      isError: true,
    }],
    role: 'user',
    id: 'msg_legacy_1',
  },
  meta: { exitCode: 1 },
}

/** Overrides for {@link bashResult}. */
export interface BashOverrides {
  readonly turn?: number
  readonly callId?: string
  readonly exitCode?: number | null
  readonly omitMeta?: boolean
  readonly isError?: boolean
  readonly text?: string
  readonly error?: unknown
}

/**
 * Native V4 bash result derived from the real {@link bashExitFailure} capture.
 * Used only for combinations no live capture exists for (signal-kill, omitted
 * meta, custom text); the envelope stays the captured native shape.
 */
export function bashResult(overrides: BashOverrides = {}): Record<string, unknown> {
  const {
    turn = 1,
    callId = 'call_1',
    exitCode = 1,
    omitMeta = false,
    isError = false,
    text = 'FAILED test_cart.py::test_total - assert [] == [7]\n[exit code: 1]',
    error,
  } = overrides
  return {
    turn,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError,
      id: `msg_${callId}`,
    },
    ...(omitMeta ? {} : { meta: { exitCode } }),
    ...(error === undefined ? {} : { error }),
  }
}
