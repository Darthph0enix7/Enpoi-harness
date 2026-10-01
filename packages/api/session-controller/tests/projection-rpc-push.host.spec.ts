/**
 * Projection pushes are append-driven, never turn-driven: a committed append
 * made by a Remote command (the write path every host RPC uses) drives the
 * registry's change feed exactly like an agent-loop append, so the control
 * stream emits one replacement frame for each changed client-visible unit.
 * A normal append does not double-fire a frame for a unit it did not change,
 * and every append origin converges on the same single frame.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionControlFrame } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'test/cap-override': CapOverrideRecord
  }
  interface SessionProjectionMap {
    'test/cap-override': CapOverrideRecord
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable session-scoped override record (the capabilities event shape). */
    'test/cap-override': { skills: Record<string, boolean>; tools: Record<string, boolean>; mcp: Record<string, boolean> }
  }
}

/** The complete post-change override record the capabilities RPC appends. */
interface CapOverrideRecord {
  skills: Record<string, boolean>
  tools: Record<string, boolean>
  mcp: Record<string, boolean>
}

const capOverrideSchema: z.ZodType<CapOverrideRecord> = z.object({
  skills: z.record(z.string(), z.boolean()),
  tools: z.record(z.string(), z.boolean()),
  mcp: z.record(z.string(), z.boolean()),
})

const EMPTY_CAP_OVERRIDES: CapOverrideRecord = { skills: {}, tools: {}, mcp: {} }

/** The capabilities projection unit shape: non-surface event, wire view. */
const capOverrideUnit: ProjectionDefinition<'test/cap-override', CapOverrideRecord> = {
  key: 'test/cap-override',
  stateSchema: capOverrideSchema,
  init: () => EMPTY_CAP_OVERRIDES,
  apply: (state, event) => (event.type === 'test/cap-override'
    ? { skills: { ...event.data.skills }, tools: { ...event.data.tools }, mcp: { ...event.data.mcp } }
    : state),
  wire: { viewSchema: capOverrideSchema, view: state => state },
  stateVersion: 1,
}

const ownedContexts = new Set<Context>()
afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
})

const sid = (id: string): SessionId => id as SessionId

function request<P>(payload: P): P {
  return payload
}

/** Store + projection registry + titles over a structural idle-agent factory. */
async function composed(): Promise<Context> {
  const ctx = new Context()
  ownedContexts.add(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 40 })
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.seed === undefined ? {} : { seed: [...options.seed] },
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      const agent = { id: session.id, session, status: 'idle', ctx: ownerCtx } as Agent
      await ctx.agents.register(agent)
      return Promise.resolve({ agent, dispose: () => Promise.resolve() })
    },
    resume: () => Promise.reject(new Error('resume must not run: every source is attached')),
  })
  return ctx
}

/** Register one live idle agent whose log holds one completed turn. */
async function liveAgent(ctx: Context, id: string): Promise<Session> {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'prompt' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

type ProjectionFrame = Extract<SessionControlFrame, { type: 'projection' }>

/** Frames for one projection key. */
function keyFrames(frames: readonly SessionControlFrame[], key: string): ProjectionFrame[] {
  return frames.filter(
    (frame): frame is ProjectionFrame => frame.type === 'projection' && frame.key === key,
  )
}

/** Open one control generation and return its live frame log plus teardown. */
async function openControl(ctx: Context): Promise<{
  readonly frames: SessionControlFrame[]
  readonly close: () => Promise<void>
}> {
  const proxy = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
  // The controller's change-feed subscription lands with its inject child.
  await new Promise(resolve => setTimeout(resolve, 0))
  const frames: SessionControlFrame[] = []
  const abort = new AbortController()
  const pump = (async () => {
    for await (const frame of proxy.control(abort.signal)) frames.push(frame)
  })()
  await vi.waitFor(() => {
    expect(frames.some(frame => frame.type === 'baseline')).toBe(true)
  })
  return {
    frames,
    close: async () => {
      abort.abort()
      await pump
    },
  }
}

describe('Remote-origin projection pushes', () => {
  it('pushes the changed unit for an RPC append and never double-fires a normal append', async () => {
    const ctx = await composed()
    const session = await liveAgent(ctx, 'session-rpc-push')
    const control = await openControl(ctx)
    try {
      // A real host RPC: `session.rename` appends `session/title` through the
      // title service — no agent turn runs.
      const renamed = await createSessionTestRemote(ctx, {
        defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
        cwd: '/tmp',
      }).rename(request({ sessionId: session.id, title: 'Renamed by RPC' }))
      expect(renamed.ok).toBe(true)
      if (!renamed.ok) return

      await vi.waitFor(() => {
        expect(keyFrames(control.frames, 'title')).toHaveLength(1)
      })
      expect(keyFrames(control.frames, 'title')[0]).toEqual({
        type: 'projection',
        sessionId: session.id,
        key: 'title',
        value: 'Renamed by RPC',
        seq: renamed.value.seq,
      })

      // A normal append that does not touch the title unit pushes no title
      // frame at all (no double-firing on ordinary turn traffic).
      session.append('turn/start', { turn: 2 })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(keyFrames(control.frames, 'title')).toHaveLength(1)

      // The next RPC write pushes exactly one more replacement frame.
      const second = await createSessionTestRemote(ctx, {
        defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
        cwd: '/tmp',
      }).rename(request({ sessionId: session.id, title: 'Renamed again' }))
      expect(second.ok).toBe(true)
      if (!second.ok) return
      await vi.waitFor(() => {
        expect(keyFrames(control.frames, 'title')).toHaveLength(2)
      })
      expect(keyFrames(control.frames, 'title')[1]).toMatchObject({
        value: 'Renamed again',
        seq: second.value.seq,
      })
    } finally {
      await control.close()
    }
  })

  it('pushes a capability-shaped write-service append for a live session resolved by id', async () => {
    const ctx = await composed()
    const session = await liveAgent(ctx, 'session-cap-push')
    ctx.sessionProjections.register(capOverrideUnit)
    const control = await openControl(ctx)
    try {
      // The capabilities RPC write shape: resolve the live session by id, then
      // append the complete post-change record (ignorable, non-surface).
      const live = ctx.sessions.get(session.id)
      expect(live).toBe(session)
      const seq = live?.append('test/cap-override', {
        skills: { 'tier1-workflow': false },
        tools: {},
        mcp: {},
      }, { ignorable: true }).seq

      await vi.waitFor(() => {
        expect(keyFrames(control.frames, 'test/cap-override')).toHaveLength(1)
      })
      expect(keyFrames(control.frames, 'test/cap-override')[0]).toEqual({
        type: 'projection',
        sessionId: session.id,
        key: 'test/cap-override',
        value: { skills: { 'tier1-workflow': false }, tools: {}, mcp: {} },
        seq,
      })

      // An unrelated append leaves the unit alone: one frame total, no double.
      session.append('turn/start', { turn: 2 })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(keyFrames(control.frames, 'test/cap-override')).toHaveLength(1)
    } finally {
      await control.close()
    }
  })
})
