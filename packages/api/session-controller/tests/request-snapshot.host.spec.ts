/**
 * session.requestSnapshot: summary by default, secret-bearing bodies only on
 * request, not-found naming one Session, and the size-capped capture case.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import {
  createSystemMessage,
  createUserMessage,
  writeSessionWireCapture,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

const SESSION_ID = 'session-snapshot-1' as SessionId

const temps: string[] = []
let previousCap: string | undefined

async function harness(): Promise<{ root: string; remote: TestSessionRemote; ctx: Context }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-request-snapshot-'))
  temps.push(root)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: '/tmp',
    wireLogRoot: root,
  })
  return { root, remote, ctx }
}

function options(sessionId: SessionId): GenerateOptions {
  return {
    provider: 'mock',
    model: 'mock',
    sessionId,
    messages: [
      createSystemMessage('SYSTEM RULES', 'test'),
      createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }),
    ],
    tools: [{ name: 'read', description: 'read a file', parameters: {} }],
  }
}

afterEach(async () => {
  if (previousCap === undefined) delete process.env.DSH_WIRE_SESSION_MAX_BYTES
  else process.env.DSH_WIRE_SESSION_MAX_BYTES = previousCap
  previousCap = undefined
  await Promise.all(temps.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('session.requestSnapshot', () => {
  it('returns the summary by default and the bodies only with includeBodies', async () => {
    const { root, remote, ctx } = await harness()
    try {
      await writeSessionWireCapture(root, options(SESSION_ID))
      const signal = new AbortController().signal

      const summary = await remote.requestSnapshot({ sessionId: SESSION_ID }, signal)
      expect(summary).toMatchObject({
        ok: true,
        value: {
          sessionId: SESSION_ID,
          provider: 'mock',
          model: 'mock',
          system: {
            chars: 'SYSTEM RULES'.length,
            sha256: createHash('sha256').update('SYSTEM RULES', 'utf8').digest('hex'),
          },
          tools: ['read'],
          messages: [
            { role: 'system', chars: 'SYSTEM RULES'.length },
            { role: 'user', chars: 'hello'.length },
          ],
          bodiesIncluded: false,
        },
      })
      if (!summary.ok) throw new Error('unreachable')
      expect(summary.value.capturedAt).toBeGreaterThan(0)
      expect(summary.value).not.toHaveProperty('bodies')

      const full = await remote.requestSnapshot(
        { sessionId: SESSION_ID, includeBodies: true },
        signal,
      )
      expect(full).toMatchObject({
        ok: true,
        value: {
          bodiesIncluded: true,
          bodies: {
            system: 'SYSTEM RULES',
            tools: [{ name: 'read' }],
            messages: [{ role: 'system' }, { role: 'user' }],
          },
        },
      })
      if (!full.ok) throw new Error('unreachable')
      expect(full.value).toHaveProperty('bodies.messages.1.content.0.text', 'hello')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names the Session when no capture exists', async () => {
    const { remote, ctx } = await harness()
    try {
      const missing = 'session-not-captured-1' as SessionId
      const result = await remote.requestSnapshot(
        { sessionId: missing },
        new AbortController().signal,
      )
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'session/not-found' },
      })
      if (result.ok) throw new Error('unreachable')
      expect(result.error.message).toContain('session-not-captured-1')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a Session id that cannot address a capture file', async () => {
    const { remote, ctx } = await harness()
    try {
      const result = await remote.requestSnapshot(
        { sessionId: '../escape' as SessionId },
        new AbortController().signal,
      )
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'gateway/bad-request' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a size-capped capture without bodies', async () => {
    const { root, remote, ctx } = await harness()
    try {
      previousCap = process.env.DSH_WIRE_SESSION_MAX_BYTES
      process.env.DSH_WIRE_SESSION_MAX_BYTES = '64'
      await writeSessionWireCapture(root, options(SESSION_ID))
      process.env.DSH_WIRE_SESSION_MAX_BYTES = previousCap

      const result = await remote.requestSnapshot(
        { sessionId: SESSION_ID, includeBodies: true },
        new AbortController().signal,
      )
      expect(result).toMatchObject({
        ok: true,
        value: {
          bodiesIncluded: false,
          bodiesOmitted: 'size-cap',
          tools: ['read'],
          system: { chars: 'SYSTEM RULES'.length },
        },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
