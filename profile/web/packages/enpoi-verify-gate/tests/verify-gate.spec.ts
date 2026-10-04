import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  extractToolResultFacts,
  resolveGateConfig,
  apply,
  type ApplyOptions,
  type Config,
} from '../src/index.js'
import {
  observeToolResult,
  previewFailureText,
  readExitCode,
  VerifyGateTracker,
  CONTROL_PLANE_TOOLS,
  VERIFY_UNMET_EVENT,
  type ToolResultFacts,
} from '../src/verify.js'
import {
  bashClean,
  bashExitFailure,
  bashFailureText,
  bashIsError,
  bashIsErrorNoIdentity,
  bashResult,
  capacityRejection,
  editAmbiguous,
  getGoalApprovalUnavailable,
  readResult,
  retiredV3BashResult,
} from './fixtures/native-v4.js'

function facts(data: Record<string, unknown>, tool = 'bash'): ToolResultFacts {
  return { ...extractToolResultFacts(data), tool }
}

describe('native V4 parser', () => {
  it('extracts the real V4 tool-role message facts (callId, text, isError, meta)', () => {
    const extracted = extractToolResultFacts(bashExitFailure)
    expect(extracted).toMatchObject({
      turn: 5,
      callId: 'chatcmpl-tool-a2af395f1409a07d',
      isError: false,
      meta: { exitCode: 2 },
    })
    expect(extracted.text).toContain('[exit code: 2]')
  })

  it('reads message.isError from the tool-role message', () => {
    expect(extractToolResultFacts(bashIsError).isError).toBe(true)
    expect(extractToolResultFacts(bashClean).isError).toBe(false)
  })

  it('joins every top-level text block', () => {
    const twoBlocks = {
      turn: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: 'call_multi' },
        toolCallId: 'call_multi',
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'ignored' },
          { type: 'text', text: 'second' },
        ],
      },
    }
    expect(extractToolResultFacts(twoBlocks).text).toBe('first\nsecond')
  })

  it('does not read the retired V3 tool-result wrapper (rejected at the session boundary)', () => {
    const extracted = extractToolResultFacts(retiredV3BashResult)
    expect(extracted.isError).toBeUndefined()
    expect(extracted.text).toBe('')
    // The call id still resolves from `message.source.callId`; only the retired
    // wrapper payload is ignored.
    expect(extracted.callId).toBe('call_legacy_1')
  })
})

describe('failure classification', () => {
  it('classifies a real native-V4 bash exit 2 result as an exit-code failure with a real preview', () => {
    const observation = observeToolResult(facts(bashExitFailure))
    expect(observation?.failure).toMatchObject({
      turn: 5,
      tool: 'bash',
      callId: 'chatcmpl-tool-a2af395f1409a07d',
      exitCode: 2,
      reason: 'exit-code',
    })
    expect(observation?.failure?.messagePreview).toBe('[exit code: 2]')
  })

  it('treats a real clean exit 0 as "verified" (no failure)', () => {
    const observation = observeToolResult(facts(bashClean))
    expect(observation).toEqual({ turn: 10 })
    expect(observation?.failure).toBeUndefined()
  })

  it('treats a signal-killed command (exitCode null) as a failure', () => {
    const observation = observeToolResult(facts(bashResult({ exitCode: null, text: '[killed by signal: SIGKILL]' })))
    expect(observation?.failure).toMatchObject({ reason: 'exit-code', exitCode: null })
    expect(observation?.failure?.messagePreview).toContain('SIGKILL')
  })

  it('ignores a real non-verification read result with no structured failure facts', () => {
    expect(observeToolResult(facts(readResult, 'read'))).toBeUndefined()
  })

  it('classifies isError results as failures and lifts a non-empty preview', () => {
    const observation = observeToolResult(facts(bashIsErrorNoIdentity))
    expect(observation?.failure).toMatchObject({ reason: 'is-error', tool: 'bash', turn: 1 })
    expect(observation?.failure?.messagePreview).not.toBe('')
    expect(observation?.failure?.messagePreview).toContain('interrupted after it was recorded')
  })

  it('prefers the structured error identity over isError and previews its text', () => {
    const observation = observeToolResult(facts(bashIsError))
    expect(observation?.failure).toMatchObject({ reason: 'tool-error', tool: 'bash' })
    expect(observation?.failure?.messagePreview).not.toBe('')
  })

  it('classifies a real structured error on a non-control work tool as a failure', () => {
    const observation = observeToolResult(facts(editAmbiguous, 'edit'))
    expect(observation?.failure).toMatchObject({ reason: 'tool-error', tool: 'edit', turn: 16 })
    expect(observation?.failure?.messagePreview).toContain('old_string matched 2 times')
  })

  it('falls back to recognised failure text when the result carries no exit fact', () => {
    expect(observeToolResult(facts(bashFailureText))?.failure).toMatchObject({
      reason: 'failure-text',
      tool: 'bash',
      turn: 1,
    })
    expect(observeToolResult(facts(bashFailureText))?.failure?.messagePreview).toBe('[exit code: 128]')
    expect(observeToolResult(facts(bashResult({ exitCode: 0, omitMeta: true, text: 'AssertionError: boom' })))?.failure)
      .toMatchObject({ reason: 'failure-text' })
    expect(observeToolResult(facts(bashResult({ exitCode: 0, omitMeta: true, text: 'everything is fine' })))?.failure)
      .toBeUndefined()
  })

  it('reads exit codes and bounds previews', () => {
    expect(readExitCode({ exitCode: 0 })).toBe(0)
    expect(readExitCode({ exitCode: null })).toBeNull()
    expect(readExitCode({})).toBeUndefined()
    expect(readExitCode('nope')).toBeUndefined()
    const long = `FAILED ${'x'.repeat(500)}`
    const preview = previewFailureText(long)
    expect(preview.length).toBeLessThanOrEqual(200)
    expect(preview.endsWith('…')).toBe(true)
    expect(previewFailureText(undefined)).toBe('')
  })
})

describe('control/dispatch-plane exclusion (D3)', () => {
  it('lists the orchestration control surfaces and not the verification surfaces', () => {
    for (const tool of ['subagent', 'task', 'create_goal', 'get_goal', 'update_goal', 'send_message', 'interrupt_agent', 'list_agents']) {
      expect(CONTROL_PLANE_TOOLS.has(tool)).toBe(true)
    }
    for (const tool of ['bash', 'pwsh', 'str_replace_editor', 'edit', 'write', 'read', 'grep']) {
      expect(CONTROL_PLANE_TOOLS.has(tool)).toBe(false)
    }
  })

  it('never classifies a control-plane result, even with a structured error', () => {
    expect(observeToolResult(facts(capacityRejection, 'subagent'))).toBeUndefined()
    expect(observeToolResult(facts(getGoalApprovalUnavailable, 'get_goal'))).toBeUndefined()
  })

  it('does not record an unmet turn whose only failure is a capacity rejection', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(capacityRejection, 'subagent')))
    const decision = tracker.noteTurnEnd({
      sessionId: 's1',
      turn: 8,
      reason: 'completed',
      config: { mode: 'record', promptOnce: false },
    })
    expect(decision.record).toBeUndefined()
    expect(decision.prompt).toBe(false)
  })

  it('does not record an unmet turn whose only failure is a control approval rejection', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(getGoalApprovalUnavailable, 'get_goal')))
    expect(tracker.noteTurnEnd({
      sessionId: 's1',
      turn: 10,
      reason: 'completed',
      config: { mode: 'record', promptOnce: false },
    }).record).toBeUndefined()
  })

  it('keeps a work failure when a control-plane rejection follows it in the same turn', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 8, callId: 'call_work' }))))
    tracker.noteToolResult('s1', observeToolResult(facts(capacityRejection, 'subagent')))
    const decision = tracker.noteTurnEnd({
      sessionId: 's1',
      turn: 8,
      reason: 'completed',
      config: { mode: 'record', promptOnce: false },
    })
    expect(decision.record).toMatchObject({ turn: 8, tool: 'bash', callId: 'call_work', reason: 'exit-code' })
    expect(decision.record?.messagePreview).not.toBe('')
  })

  it('keeps a work failure when a control-plane success follows it', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 3, callId: 'call_work' }))))
    tracker.noteToolResult('s1', undefined) // a successful `subagent` dispatch classifies as undefined
    expect(tracker.noteTurnEnd({
      sessionId: 's1',
      turn: 3,
      reason: 'completed',
      config: { mode: 'record', promptOnce: false },
    }).record).toMatchObject({ tool: 'bash', callId: 'call_work' })
  })
})

describe('turn-end decision (record mode)', () => {
  it('records exactly once for a failing-last-tool + completed turn', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(bashExitFailure)))
    const decision = tracker.noteTurnEnd({
      sessionId: 's1',
      turn: 5,
      reason: 'completed',
      config: { mode: 'record', promptOnce: false },
    })
    expect(decision.record).toMatchObject({
      turn: 5,
      tool: 'bash',
      callId: 'chatcmpl-tool-a2af395f1409a07d',
      exitCode: 2,
      reason: 'exit-code',
    })
    expect(decision.record?.messagePreview).toBe('[exit code: 2]')
    expect(decision.prompt).toBe(false)
    // The per-turn failure is consumed: a duplicate boundary cannot double-record.
    expect(tracker.noteTurnEnd({
      sessionId: 's1',
      turn: 5,
      reason: 'completed',
      config: { mode: 'record', promptOnce: false },
    }).record).toBeUndefined()
  })

  it('records nothing on a clean turn', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(bashClean)))
    const decision = tracker.noteTurnEnd({
      sessionId: 's1',
      turn: 10,
      reason: 'completed',
      config: { mode: 'record', promptOnce: false },
    })
    expect(decision.record).toBeUndefined()
    expect(decision.prompt).toBe(false)
  })

  it('records nothing when a later verification passes after a failure', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 1 }))))
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 1, exitCode: 0, text: '1 passed' }))))
    expect(tracker.noteTurnEnd({
      sessionId: 's1',
      turn: 1,
      reason: 'completed',
      config: { mode: 'record', promptOnce: false },
    }).record).toBeUndefined()
  })

  it('records nothing for aborted or error turn endings', () => {
    for (const reason of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted']) {
      const tracker = new VerifyGateTracker()
      tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 1 }))))
      const decision = tracker.noteTurnEnd({
        sessionId: 's1',
        turn: 1,
        reason,
        config: { mode: 'record', promptOnce: false },
      })
      expect(decision.record).toBeUndefined()
      expect(decision.prompt).toBe(false)
    }
  })

  it('never records a failure from a different turn', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 1 }))))
    expect(tracker.noteTurnEnd({
      sessionId: 's1',
      turn: 2,
      reason: 'completed',
      config: { mode: 'record', promptOnce: false },
    }).record).toBeUndefined()
  })
})

describe('prompt mode', () => {
  const promptConfig = { mode: 'prompt' as const, promptOnce: false }

  it('injects exactly once and never on a second consecutive unverified turn', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 1 }))))
    const first = tracker.noteTurnEnd({ sessionId: 's1', turn: 1, reason: 'completed', config: promptConfig })
    expect(first.record).toBeDefined()
    expect(first.prompt).toBe(true)
    expect(tracker.noteToolResult).not.toThrow()

    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 2 }))))
    const second = tracker.noteTurnEnd({ sessionId: 's1', turn: 2, reason: 'completed', config: promptConfig })
    expect(second.record).toBeDefined()
    expect(second.prompt).toBe(false)

    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 3 }))))
    const third = tracker.noteTurnEnd({ sessionId: 's1', turn: 3, reason: 'completed', config: promptConfig })
    expect(third.prompt).toBe(false)
  })

  it('resets the streak after a verified turn', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 1 }))))
    expect(tracker.noteTurnEnd({ sessionId: 's1', turn: 1, reason: 'completed', config: promptConfig }).prompt).toBe(true)
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 2, exitCode: 0, text: '1 passed' }))))
    expect(tracker.noteTurnEnd({ sessionId: 's1', turn: 2, reason: 'completed', config: promptConfig }).prompt).toBe(false)
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 3 }))))
    expect(tracker.noteTurnEnd({ sessionId: 's1', turn: 3, reason: 'completed', config: promptConfig }).prompt).toBe(true)
  })

  it('honours promptOnce across streaks', () => {
    const tracker = new VerifyGateTracker()
    const config = { mode: 'prompt' as const, promptOnce: true }
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 1 }))))
    expect(tracker.noteTurnEnd({ sessionId: 's1', turn: 1, reason: 'completed', config }).prompt).toBe(true)
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 2, exitCode: 0, text: 'ok' }))))
    tracker.noteTurnEnd({ sessionId: 's1', turn: 2, reason: 'completed', config })
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 3 }))))
    const decision = tracker.noteTurnEnd({ sessionId: 's1', turn: 3, reason: 'completed', config })
    expect(decision.record).toBeDefined()
    expect(decision.prompt).toBe(false)
  })

  it('record mode never prompts', () => {
    const tracker = new VerifyGateTracker()
    tracker.noteToolResult('s1', observeToolResult(facts(bashResult({ turn: 1 }))))
    const decision = tracker.noteTurnEnd({
      sessionId: 's1',
      turn: 1,
      reason: 'completed',
      config: { mode: 'record', promptOnce: false },
    })
    expect(decision.record).toBeDefined()
    expect(decision.prompt).toBe(false)
  })
})

describe('settings switch', () => {
  function ctxWith(gate: unknown, present = true): Context {
    return {
      get: (name: string) => name === 'settings'
        ? (present ? { get: () => ({ parameters: { verifyGate: gate } }) } : undefined)
        : undefined,
    } as unknown as Context
  }

  it('defaults to record-only when settings or the namespace are absent', () => {
    expect(resolveGateConfig(ctxWith(undefined, false), {})).toEqual({ mode: 'record', promptOnce: false })
    expect(resolveGateConfig(ctxWith(undefined), {})).toEqual({ mode: 'record', promptOnce: false })
  })

  it('reads enpoi-orchestration.parameters.verifyGate over the plugin config', () => {
    expect(resolveGateConfig(ctxWith({ mode: 'prompt', promptOnce: true }), { mode: 'record' }))
      .toEqual({ mode: 'prompt', promptOnce: true })
    expect(resolveGateConfig(ctxWith({ mode: 'nonsense' }), { mode: 'prompt' }))
      .toEqual({ mode: 'prompt', promptOnce: false })
  })

  it('falls back on a throwing settings service', () => {
    const ctx = { get: () => ({ get: () => { throw new Error('locked') } }) } as unknown as Context
    expect(resolveGateConfig(ctx, { mode: 'prompt' })).toEqual({ mode: 'prompt', promptOnce: false })
  })
})

describe('plugin wiring', () => {
  interface Harness {
    ctx: Context
    session: { id: string; append: (type: string, data: unknown, opts?: { ignorable?: true }) => void }
    appended: Array<{ type: string; data: any; opts?: { ignorable?: true } }>
    followups: unknown[]
    reports: Array<{ kind?: string; message?: string; sessionId?: string }>
    emit: (type: string, data: unknown) => void
  }

  function harness(config: Config = {}, gate?: { mode?: string; promptOnce?: boolean }, deferImmediate = true): Harness {
    const listeners: Array<(session: unknown, event: unknown) => void> = []
    const appended: Harness['appended'] = []
    const followups: unknown[] = []
    const reports: Harness['reports'] = []
    const session = {
      id: 'session-wire-1',
      append: (type: string, data: unknown, opts?: { ignorable?: true }) => { appended.push({ type, data, opts }) },
    }
    const ctx = {
      on: (name: string, listener: (session: unknown, event: unknown) => void) => {
        if (name === 'session/event') listeners.push(listener)
        return () => {}
      },
      get: (name: string) => {
        if (name === 'settings') return gate === undefined ? undefined : { get: () => ({ parameters: { verifyGate: gate } }) }
        if (name === 'agents') return { get: () => ({ followup: (message: unknown) => { followups.push(message) } }) }
        if (name === 'diagnostics') return { report: (request: Harness['reports'][number]) => { reports.push(request); return { code: 'D123456' } } }
        return undefined
      },
      logger: { info: () => {}, warn: () => {} },
    } as unknown as Context
    const options: ApplyOptions = deferImmediate ? { defer: (task: () => void) => task() } : {}
    apply(ctx, config, options)
    return {
      ctx,
      session,
      appended,
      followups,
      reports,
      emit: (type: string, data: unknown) => { for (const listener of listeners) listener(session, { type, data }) },
    }
  }

  function callIdOf(result: Record<string, unknown>): string {
    const message = result.message as { source?: { callId?: string } } | undefined
    return message?.source?.callId ?? ''
  }

  function drive(h: Harness, turn: number, result: Record<string, unknown>, tool = 'bash'): void {
    h.emit('tool/call', { turn, step: 1, callId: callIdOf(result), name: tool, arguments: '{}' })
    h.emit('tool/result', result)
    h.emit('turn/end', { turn, reason: { kind: 'completed' } })
  }

  it('records a real native-V4 failing bash result once and reports it to diagnostics', () => {
    const h = harness()
    drive(h, 5, bashExitFailure)
    expect(h.appended).toHaveLength(1)
    expect(h.appended[0]?.type).toBe(VERIFY_UNMET_EVENT)
    expect(h.appended[0]?.opts).toEqual({ ignorable: true })
    expect(h.appended[0]?.data).toMatchObject({
      turn: 5,
      tool: 'bash',
      callId: 'chatcmpl-tool-a2af395f1409a07d',
      exitCode: 2,
      reason: 'exit-code',
    })
    expect(h.appended[0]?.data.messagePreview).toBe('[exit code: 2]')
    expect(h.followups).toHaveLength(0)
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]?.kind).toBe('verify-unmet')
    expect(h.reports[0]?.sessionId).toBe('session-wire-1')
    expect(h.reports[0]?.message).toContain('[exit code: 2]')
  })

  it('records nothing for a clean or an error turn', () => {
    const clean = harness()
    drive(clean, 10, bashClean)
    expect(clean.appended).toHaveLength(0)

    const errored = harness()
    errored.emit('tool/call', { turn: 5, step: 1, callId: callIdOf(bashExitFailure), name: 'bash', arguments: '{}' })
    errored.emit('tool/result', bashExitFailure)
    errored.emit('turn/end', { turn: 5, reason: { kind: 'error', error: { code: 'X', message: 'boom' } } })
    expect(errored.appended).toHaveLength(0)
  })

  it('records nothing when the turn\'s only failure is a dispatch rejection (D3)', () => {
    const h = harness()
    h.emit('tool/call', { turn: 8, step: 6, callId: callIdOf(capacityRejection), name: 'subagent', arguments: '{}' })
    h.emit('tool/result', capacityRejection)
    h.emit('turn/end', { turn: 8, reason: { kind: 'completed' } })
    expect(h.appended).toHaveLength(0)
    expect(h.reports).toHaveLength(0)
  })

  it('records the work failure even when a dispatch rejection is the last result of the turn (D3)', () => {
    const h = harness()
    h.emit('tool/call', { turn: 8, step: 1, callId: callIdOf(bashResult({ turn: 8, callId: 'call_work' })), name: 'bash', arguments: '{}' })
    h.emit('tool/result', bashResult({ turn: 8, callId: 'call_work' }))
    h.emit('tool/call', { turn: 8, step: 6, callId: callIdOf(capacityRejection), name: 'subagent', arguments: '{}' })
    h.emit('tool/result', capacityRejection)
    h.emit('turn/end', { turn: 8, reason: { kind: 'completed' } })
    expect(h.appended).toHaveLength(1)
    expect(h.appended[0]?.data).toMatchObject({ tool: 'bash', callId: 'call_work', reason: 'exit-code' })
  })

  it('prompt mode injects exactly one follow-up and never on the second unverified turn', () => {
    const h = harness({}, { mode: 'prompt' })
    drive(h, 1, bashResult({ turn: 1 }))
    drive(h, 2, bashResult({ turn: 2 }))
    expect(h.appended).toHaveLength(2)
    expect(h.followups).toHaveLength(1)
    const message = h.followups[0] as { role?: string; content?: Array<{ text?: string }>; source?: { kind?: string } }
    expect(message.role).toBe('user')
    expect(message.content?.[0]?.text).toContain('Your last verification failed')
    expect(message.source?.kind).toBe('enpoi-verify-gate')
  })

  it('defers delivery out of append publication', () => {
    const h = harness()
    const deferred: Array<() => void> = []
    const ctx = {
      on: (name: string, listener: (session: unknown, event: unknown) => void) => {
        if (name === 'session/event') (h as any).listener = listener
        return () => {}
      },
      get: () => undefined,
      logger: { info: () => {} },
    } as unknown as Context
    apply(ctx, {}, { defer: (task) => { deferred.push(task) } })
    const listener = (h as any).listener as (session: unknown, event: unknown) => void
    listener(h.session, { type: 'tool/call', data: { callId: callIdOf(bashExitFailure), name: 'bash' } })
    listener(h.session, { type: 'tool/result', data: bashExitFailure })
    listener(h.session, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    expect(h.appended).toHaveLength(0)
    expect(deferred).toHaveLength(1)
    deferred[0]?.()
    expect(h.appended).toHaveLength(1)
  })

  it('uses the plugin config fallback when settings are absent', () => {
    const h = harness({ mode: 'prompt' })
    drive(h, 1, bashResult({ turn: 1 }))
    expect(h.followups).toHaveLength(1)
  })
})
