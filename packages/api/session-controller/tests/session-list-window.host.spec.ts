/**
 * `session.list` window contract: one newest-first page with an opaque offset
 * cursor, a deployment page-size default, excluded heavy projection keys, and
 * loud rejection of malformed paging input.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import { testSessionPersistence } from './test-remote.ts'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

async function harness(pageSize?: number): Promise<{ ctx: Context; remote: TestSessionRemote }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop)
  return {
    ctx,
    remote: createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
      ...(pageSize === undefined ? {} : { listPageSize: pageSize }),
    }),
  }
}

/** Create one live session with an explicit creation time used as its updatedAt. */
function seed(ctx: Context, id: string, createdAt: number): void {
  ctx.sessions.create(id as never, { meta: { createdAt, cwd: `/proj/${id}` } })
}

describe('session.list windowing', () => {
  it('pages newest-first through the offset cursor without duplicates or gaps', async () => {
    const { ctx, remote } = await harness()
    seed(ctx, 'w-1', 100)
    seed(ctx, 'w-2', 200)
    seed(ctx, 'w-3', 300)
    seed(ctx, 'w-4', 400)
    seed(ctx, 'w-5', 500)

    const first = await remote.list({ limit: 2 })
    if (!first.ok) throw new Error('first page failed')
    expect(first.value.items.map(item => item.sessionId)).toEqual(['w-5', 'w-4'])
    expect(first.value.nextCursor).toBe('2')

    const firstCursor = first.value.nextCursor
    if (firstCursor === undefined) throw new Error('first page ended the list')
    const second = await remote.list({ cursor: firstCursor, limit: 2 })
    if (!second.ok) throw new Error('second page failed')
    expect(second.value.items.map(item => item.sessionId)).toEqual(['w-3', 'w-2'])
    expect(second.value.nextCursor).toBe('4')

    const secondCursor = second.value.nextCursor
    if (secondCursor === undefined) throw new Error('second page ended the list')
    const third = await remote.list({ cursor: secondCursor, limit: 2 })
    if (!third.ok) throw new Error('third page failed')
    expect(third.value.items.map(item => item.sessionId)).toEqual(['w-1'])
    expect(third.value.nextCursor).toBeUndefined()
  })

  it('uses the deployment page size when the request omits a limit', async () => {
    const { ctx, remote } = await harness(2)
    seed(ctx, 'd-1', 100)
    seed(ctx, 'd-2', 200)
    seed(ctx, 'd-3', 300)

    const page = await remote.list({})
    if (!page.ok) throw new Error('list failed')
    expect(page.value.items.map(item => item.sessionId)).toEqual(['d-3', 'd-2'])
    expect(page.value.nextCursor).toBe('2')
  })

  it('omits the cursor when the whole catalog fits one page', async () => {
    const { ctx, remote } = await harness()
    seed(ctx, 's-1', 100)
    const page = await remote.list({})
    if (!page.ok) throw new Error('list failed')
    expect(page.value.items.map(item => item.sessionId)).toEqual(['s-1'])
    expect(page.value.nextCursor).toBeUndefined()
  })

  it('rejects a malformed cursor and an out-of-range limit as bad requests', async () => {
    const { ctx, remote } = await harness()
    seed(ctx, 'r-1', 100)

    const badCursor = await remote.list({ cursor: '-1' })
    expect(badCursor.ok).toBe(false)
    if (badCursor.ok) throw new Error('unreachable')
    expect(badCursor.error.code).toBe('gateway/bad-request')

    const badLimit = await remote.list({ limit: 0 })
    expect(badLimit.ok).toBe(false)
    if (badLimit.ok) throw new Error('unreachable')
    expect(badLimit.error.code).toBe('gateway/bad-request')
  })

  it('serves light cached projections and excludes the heavy per-session keys', async () => {
    const { ctx, remote } = await harness()
    const coldId = 'w-cold' as never
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [{ version: 3, id: coldId, createdAt: 5, isSeeded: false, cwd: '/tmp' }],
    }) as never)
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => ({
        asOfSeq: SessionSeq(7),
        values: {
          title: 'Cached title',
          agentPreset: 'minimal',
          sessionListMetadata: { blank: false, lastPromptAt: 6 },
          contextLens: { events: 'x'.repeat(4096) },
          contextTimeline: [{ huge: 'y'.repeat(2048) }],
          titleInput: 'g'.repeat(2048),
        },
      }),
    } as never)

    const page = await remote.list({})
    if (!page.ok) throw new Error('list failed')
    const row = page.value.items.find(item => item.sessionId === coldId)
    expect(row?.projections?.values.title).toBe('Cached title')
    expect(row?.projections?.values.agentPreset).toBe('minimal')
    expect(row?.projections?.values.sessionListMetadata).toEqual({ blank: false, lastPromptAt: 6 })
    expect('contextLens' in (row?.projections?.values ?? {})).toBe(false)
    expect('contextTimeline' in (row?.projections?.values ?? {})).toBe(false)
    expect('titleInput' in (row?.projections?.values ?? {})).toBe(false)
  })

  it('omits the projections column when every cached key is excluded', async () => {
    const { ctx, remote } = await harness()
    const coldId = 'w-heavy' as never
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [{ version: 3, id: coldId, createdAt: 5, isSeeded: false, cwd: '/tmp' }],
    }) as never)
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: () => ({
        asOfSeq: SessionSeq(7),
        values: { contextLens: { events: ['only heavy'] } },
      }),
    } as never)

    const page = await remote.list({})
    if (!page.ok) throw new Error('list failed')
    const row = page.value.items.find(item => item.sessionId === coldId)
    expect(row).toBeDefined()
    expect(row !== undefined && 'projections' in row).toBe(false)
  })
})
