import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendAskNotice,
  askLabel,
  askSummary,
  defaultNoticesPath,
  localDecisionToPeerAnswer,
  normalizeQuestionSelections,
} from '../src/asks.ts'
import { DEFAULT_SETTLE_QUIET_MS, contentText, isPeerSessionSettled, recordAssistantText, recordRpcId, recordTerminal, recordTurn } from '../src/follow.ts'

const event = (type: string, data: unknown) => ({ seq: 1, time: 1, type, data })

describe('isPeerSessionSettled', () => {
  const terminal = { turn: 6, reason: 'completed' }

  it('requires a terminal and a quiet state', () => {
    expect(isPeerSessionSettled(undefined)).toBe(false)
    expect(isPeerSessionSettled({})).toBe(false)
    expect(isPeerSessionSettled({ terminal })).toBe(true)
    expect(isPeerSessionSettled({ terminal, latch: 'unknown', activeDescendants: 0, pendingAskCount: 0 })).toBe(true)
    expect(isPeerSessionSettled({ terminal, latch: 'idle', activeDescendants: 0, pendingAskCount: 0 })).toBe(true)
  })

  it('refuses while a turn, a child, an ask, or an inexact descendant count is live', () => {
    expect(isPeerSessionSettled({ terminal, latch: 'running', activeDescendants: 0, pendingAskCount: 0 })).toBe(false)
    expect(isPeerSessionSettled({ terminal, latch: 'idle', activeDescendants: 1, pendingAskCount: 0 })).toBe(false)
    expect(isPeerSessionSettled({ terminal, latch: 'waiting_approval', activeDescendants: 0, pendingAskCount: 1 })).toBe(false)
    expect(isPeerSessionSettled({ terminal, latch: 'idle', activeDescendants: 0, pendingAskCount: 0, descendantsExact: false })).toBe(false)
  })

  it('ships a positive quiet window', () => {
    expect(DEFAULT_SETTLE_QUIET_MS).toBeGreaterThan(0)
  })
})

describe('follow record readers', () => {
  it('reads the prompt rpcId from a user/message source', () => {
    expect(recordRpcId(event('user/message', { source: { kind: 'user', rpcId: 'peer-bridge-1' } }))).toBe('peer-bridge-1')
    expect(recordRpcId(event('user/message', { source: { kind: 'plugin', plugin: 'x' } }))).toBeUndefined()
    expect(recordRpcId(event('assistant/message', {}))).toBeUndefined()
  })

  it('extracts assistant text blocks only', () => {
    expect(recordAssistantText(event('assistant/message', {
      turn: 2,
      message: { content: [{ type: 'text', text: 'one' }, { type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'two' }] },
    }))).toBe('one\ntwo')
    expect(contentText(undefined)).toBe('')
  })

  it('parses turn terminals with structured errors', () => {
    expect(recordTerminal(event('turn/end', { turn: 3, reason: { kind: 'completed' } }))).toEqual({ turn: 3, reason: 'completed' })
    expect(recordTerminal(event('turn/end', {
      turn: 4,
      reason: { kind: 'error', error: { code: 'insufficient-balance', message: 'no credit', provider: 'p', model: 'm' } },
    }))).toMatchObject({ turn: 4, reason: 'error', error: { code: 'insufficient-balance' } })
    expect(recordTerminal(event('assistant/message', { turn: 1 }))).toBeUndefined()
    expect(recordTurn(event('turn/end', { turn: 9, reason: {} }))).toBe(9)
  })
})

describe('ask surfacing helpers', () => {
  it('maps local decisions onto the peer answer vocabulary', () => {
    expect(localDecisionToPeerAnswer('allowed-once').outcome).toBe('allowed-once')
    expect(localDecisionToPeerAnswer('rejected').outcome).toBe('rejected')
    expect(localDecisionToPeerAnswer('cancelled').outcome).toBeUndefined()
    expect(localDecisionToPeerAnswer('unavailable').outcome).toBeUndefined()
    expect(localDecisionToPeerAnswer('unsurfaced').note).toContain('peer_answer')
  })

  it('labels and summarizes asks', () => {
    const approval = { kind: 'approval' as const, askId: 'a', toolName: 'bash', reason: 'rm needs approval', since: 1 }
    expect(askLabel('scratch', 'sess-1', approval)).toBe('remote ask on scratch (sess-1): approval for tool "bash" — rm needs approval')
    expect(askSummary(approval)).toBe('approval a tool=bash (rm needs approval)')
    const question = {
      kind: 'question' as const,
      askId: 'q',
      since: 1,
      questions: [
        { id: 'colour', question: 'Pick a colour', options: [{ label: 'red' }, { label: 'blue' }] },
        { id: 'scope', question: 'Which scope?', multiSelect: true, options: [{ label: 'one' }, { label: 'all' }] },
      ],
    }
    expect(askSummary(question)).toBe('question q (2 items): "Pick a colour" (id=colour; options: red, blue); "Which scope?" (id=scope multi; options: one, all)')
    expect(askLabel('scratch', 'sess-1', question)).toBe('remote ask on scratch (sess-1): a user question ("Pick a colour")')
  })

  it('validates question selections against the ask before sending', () => {
    const questions = [
      { id: 'colour', question: 'Pick a colour', options: [{ label: 'red' }, { label: 'blue' }] },
      { id: 'scope', question: 'Which scope?', multiSelect: true, options: [{ label: 'one' }, { label: 'all' }] },
    ]
    const answered = normalizeQuestionSelections(questions, [
      { id: 'colour', selected: ['blue'] },
      { id: 'scope', selected: ['one', 'all'] },
    ])
    expect(answered).toEqual({ ok: true, answer: { answers: [{ id: 'colour', selected: ['blue'] }, { id: 'scope', selected: ['one', 'all'] }] } })

    const wrongLabel = normalizeQuestionSelections(questions, [
      { id: 'colour', selected: ['green'] },
      { id: 'scope', selected: ['one'] },
    ])
    expect(wrongLabel).toEqual({ ok: false, message: '"green" is not an option of question "colour" (options: red, blue)' })

    const unknownId = normalizeQuestionSelections(questions, [{ id: 'nope', selected: ['x'] }])
    expect(unknownId.ok).toBe(false)
    if (!unknownId.ok) expect(unknownId.message).toContain('unknown question id "nope"')

    const multiOnSingle = normalizeQuestionSelections(questions, [
      { id: 'colour', selected: ['red', 'blue'] },
      { id: 'scope', selected: ['one'] },
    ])
    expect(multiOnSingle.ok).toBe(false)

    const partial = normalizeQuestionSelections(questions, [{ id: 'colour', selected: ['red'] }])
    expect(partial).toEqual({ ok: false, message: 'question "scope" not answered' })

    expect(normalizeQuestionSelections(questions, []).ok).toBe(false)
  })

  it('appends durable notices and swallows write failures', () => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-bridge-notices-'))
    const path = join(dir, 'nested', 'asks.jsonl')
    appendAskNotice(path, {
      at: 1, alias: 'scratch', sessionId: 'sess-1', askId: 'ask-1', kind: 'approval', toolName: 'bash', note: 'n',
    })
    expect(readFileSync(path, 'utf8')).toContain('"askId":"ask-1"')
    // A regular file cannot host a directory: the failure must be swallowed.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    expect(() => appendAskNotice(join(blocker, 'asks.jsonl'), {
      at: 1, alias: 'a', sessionId: 's', askId: 'x', kind: 'question', note: 'n',
    })).not.toThrow()
    expect(defaultNoticesPath('/home/x/.dsh')).toBe('/home/x/.dsh/peer-bridge/asks.jsonl')
  })
})
