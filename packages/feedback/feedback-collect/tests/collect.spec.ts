/**
 * feedback-collect unit suite: the redactor (key-like strings, paths, emails),
 * the bounded context/session builders, the system section, and the collector
 * service over a live session.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  buildContextSection,
  buildSessionSection,
  buildSystemSection,
  COLLECT_LIMITS,
  FeedbackCollector,
  redactText,
  resolveShareFlags,
  type CollectedEvent,
} from '../src/index.ts'

const HOME = '/home/alice'

describe('redactText', () => {
  it('redacts key-like tokens, emails, and home paths', () => {
    expect(redactText('token sk-abcdefghijklmnopqrstuvwxyz', HOME)).toBe('token <redacted>')
    expect(redactText('use ghp_ABCDEFGHIJKLMNOPQRSTUVWX please', HOME)).toBe('use <redacted> please')
    expect(redactText('api_key=SUPERSECRETVALUE', HOME)).toBe('api_key=<redacted>')
    expect(redactText('Authorization: Bearer abcdefghijklmnop', HOME)).toBe('Authorization: <redacted>')
    expect(redactText('AKIAIOSFODNN7EXAMPLE', HOME)).toBe('<redacted>')
    expect(redactText('mail bob.smith+tag@example.co.uk now', HOME)).toBe('mail <email> now')
    expect(redactText(`read ${HOME}/notes.txt and /home/aliceb/other`, HOME))
      .toBe('read ~/notes.txt and /home/aliceb/other')
    expect(redactText(`cwd is ${HOME}`, HOME)).toBe('cwd is ~')
  })

  it('keeps ordinary prose and short words intact', () => {
    expect(redactText('the quick brown fox jumps', HOME)).toBe('the quick brown fox jumps')
    expect(redactText('a1b2c3d4e5f6', HOME)).toBe('a1b2c3d4e5f6')
  })
})

describe('buildContextSection', () => {
  const events: CollectedEvent[] = [
    { type: 'user/message', data: { content: [{ type: 'text', text: `look at ${HOME}/x.txt` }] } },
    { type: 'tool/call', data: { name: 'read', arguments: '{"path":"/home/alice/x.txt","api_key":"SECRETVALUE123"}' } },
    { type: 'turn/end', data: { end: { kind: 'error', error: { message: 'connect failed with sk-abcdefghijklmnopqrstuvwxyz' } } } },
  ]

  it('collects messages, tool calls, and errors redacted', () => {
    const section = buildContextSection(events, HOME)
    expect(section.messages).toHaveLength(1)
    expect(section.messages[0]?.text).toBe('look at ~/x.txt')
    expect(section.toolCalls[0]?.name).toBe('read')
    expect(section.toolCalls[0]?.arguments).toContain('~/x.txt')
    expect(section.toolCalls[0]?.arguments).not.toContain('SECRETVALUE123')
    expect(section.errors[0]).toContain('<redacted>')
  })

  it('caps messages, tool calls, and characters', () => {
    const many: CollectedEvent[] = []
    for (let index = 0; index < 100; index += 1) {
      many.push({ type: 'user/message', data: { content: [{ type: 'text', text: `message ${index} ${'x'.repeat(5_000)}` }] } })
    }
    const section = buildContextSection(many, HOME)
    expect(section.messages).toHaveLength(COLLECT_LIMITS.maxMessages)
    expect(section.messages[0]?.text.length).toBeLessThanOrEqual(COLLECT_LIMITS.maxMessageChars)
    // The tail is retained.
    expect(section.messages.at(-1)?.text.startsWith('message 99')).toBe(true)
  })
})

describe('buildSessionSection', () => {
  it('hashes the session id and reports counts without the raw id', () => {
    const events: CollectedEvent[] = [
      { type: 'turn/start', data: {} },
      { type: 'turn/end', data: { end: { kind: 'completed' } } },
      { type: 'turn/start', data: {} },
      { type: 'turn/end', data: { end: { kind: 'error', error: { message: 'boom' } } } },
    ]
    const section = buildSessionSection({ sessionId: 'session-abc', events, preset: 'orchestrator', model: 'kilo/kilo-auto/free', salt: 'salt', home: HOME })
    expect(section.sessionIdHash).toMatch(/^[0-9a-f]{64}$/)
    expect(section.sessionIdHash).not.toContain('session-abc')
    expect(section.eventCount).toBe(4)
    expect(section.turnCount).toBe(2)
    expect(section.preset).toBe('orchestrator')
    expect(section.recentErrors).toEqual(['boom'])
  })
})

describe('buildSystemSection and share flags', () => {
  it('defaults every flag to true and builds an anonymous system section', () => {
    expect(resolveShareFlags()).toEqual({ systemInfo: true, context: true, session: true, message: true })
    expect(resolveShareFlags({ context: false })).toEqual({ systemInfo: true, context: false, session: true, message: true })
    const section = buildSystemSection({
      app: { name: 'deepseek-harness', version: '1.2.3', commit: 'abc' },
      platform: 'darwin',
      arch: 'arm64',
      node: 'v22.0.0',
      providers: ['kilo', 'opencode-go'],
      defaultModel: 'kilo/kilo-auto/free',
    })
    expect(section.providers).toEqual(['kilo', 'opencode-go'])
    expect(section.defaultModel).toBe('kilo/kilo-auto/free')
    expect(JSON.stringify(section)).not.toMatch(/key|secret|token/iu)
  })
})

describe('FeedbackCollector service', () => {
  async function harness(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    return ctx
  }

  it('collects the shared sections from a live session and honors flags', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('collect-session'))
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hello world' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const collector = new FeedbackCollector(ctx)
    const all = await collector.collect({ session, share: { systemInfo: true, context: true, session: true, message: true } })
    expect(all?.system?.platform).toBe(process.platform)
    expect(all?.context?.messages[0]?.text).toBe('hello world')
    expect(all?.session?.sessionIdHash).toMatch(/^[0-9a-f]{64}$/)

    const none = await collector.collect({ session, share: { systemInfo: false, context: false, session: false, message: false } })
    expect(none).toEqual({})

    const contextOnly = await collector.collect({ session, share: { systemInfo: false, context: true, session: false, message: false } })
    expect(contextOnly?.system).toBeUndefined()
    expect(contextOnly?.context?.messages).toHaveLength(1)
    expect(contextOnly?.session).toBeUndefined()
  })

  it('returns null instead of throwing when the session cannot be read', async () => {
    const ctx = await harness()
    const collector = new FeedbackCollector(ctx)
    const broken = {
      id: 'broken',
      get snapshotEvents(): () => readonly CollectedEvent[] {
        throw new Error('unreadable')
      },
    }
    const result = await collector.collect({ session: broken, share: { systemInfo: true, context: true, session: true, message: true } })
    expect(result).toBeNull()
  })
})
