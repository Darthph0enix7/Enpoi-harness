/**
 * Opt-in live verification of the hot-path indexing split against a real DSH
 * home's session store. Runs only when `DSH_SESSION_QUERY_LIVE_HOME` names a
 * session-persistence root (e.g. `/home/adam/.dsh/sessions`); the derived index
 * always lands in a temporary database, never the deployment's own.
 *
 *   DSH_SESSION_QUERY_LIVE_HOME=~/.dsh/sessions \
 *     npx vitest run packages/session-query/session-query-sqlite/tests/live-home.e2e.ts
 *
 * Asserts: a real session's first event search answers without the tool
 * deadline (targeted indexing), the index then holds rows, repeated searches
 * do not restart the pass, and cross-session search either answers after the
 * bounded wait or reports the coded `SESSION_QUERY_INDEXING` state.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite/tests/live-home
 */

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE_ROOT = process.env.DSH_SESSION_QUERY_LIVE_HOME
const LIVE_SESSION = process.env.DSH_SESSION_QUERY_LIVE_SESSION ?? 'ctx-eval-long-a'
const LIVE_QUERY = process.env.DSH_SESSION_QUERY_LIVE_QUERY ?? 'CTXEVAL'
const describeLive = LIVE_ROOT === undefined || LIVE_ROOT === '' ? describe.skip : describe

const temporaryDirectories: string[] = []
const REPORT_PATH = process.env.DSH_SESSION_QUERY_LIVE_REPORT
const metrics: Record<string, unknown> = {}

afterAll(() => {
  if (REPORT_PATH !== undefined && REPORT_PATH !== '') {
    writeFileSync(REPORT_PATH, JSON.stringify({ liveRoot: LIVE_ROOT, session: LIVE_SESSION, query: LIVE_QUERY, metrics }, null, 2) + '\n')
  }
})

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function liveEngine(config: { firstSearchWaitMs?: number } = {}): Promise<{ ctx: Context; engine: SqliteSessionQueryEngine; indexPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-live-search-'))
  temporaryDirectories.push(directory)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: LIVE_ROOT!, compression: 'zstd' })
  const indexPath = join(directory, 'index.db')
  await ctx.plugin(SqliteSessionQueryEngine, {
    path: indexPath,
    openAt: 'first-search',
    ...config,
  })
  // `ctx.plugin` resolves to the mount fiber; the service lives on the context.
  return { ctx, engine: ctx.sessionQuery as SqliteSessionQueryEngine, indexPath }
}

function indexedRows(indexPath: string): number {
  const db = new DatabaseSync(indexPath, { readOnly: true })
  try {
    return (db.prepare('SELECT count(*) AS n FROM persisted_sessions').get() as { n: number }).n
  } finally {
    db.close()
  }
}

async function waitForReady(engine: SqliteSessionQueryEngine, timeoutMs: number): Promise<number> {
  const started = Date.now()
  while (engine.indexState.status === 'running' || engine.indexState.status === 'idle') {
    if (Date.now() - started > timeoutMs) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return Date.now() - started
}

describeLive('live home session search (hot-path indexing split)', () => {
  it('answers a real session\'s first event search well inside the tool deadline', async () => {
    const { ctx, engine, indexPath } = await liveEngine()
    const started = Date.now()
    const page = await ctx.sessionQuery.searchEvents({
      sessionId: SessionId(LIVE_SESSION),
      query: LIVE_QUERY,
      limit: 5,
    })
    const elapsedMs = Date.now() - started
    expect(elapsedMs).toBeLessThan(25_000)
    expect(page?.items.length).toBeGreaterThan(0)
    // The index holds the target row: "a real session's index reports rows".
    const rows = indexedRows(indexPath)
    expect(rows).toBeGreaterThan(0)
    metrics.targetedSearchMs = elapsedMs
    metrics.targetedHits = page.items.length
    metrics.indexRowsAfterTargeted = rows
    metrics.indexStateAfterTargeted = engine.indexState
    // A brand-new live session answers its first search the same way.
    const fresh = ctx.sessions.create(SessionId('live-fresh-search'), {
      seed: [{
        type: 'user/message',
        seq: SessionSeq(0),
        time: Date.now(),
        data: createUserMessage({ content: [{ type: 'text', text: 'fresh session needle' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      }],
    })
    const freshStarted = Date.now()
    const freshPage = await ctx.sessionQuery.searchEvents({ sessionId: fresh.id, query: 'fresh session needle' })
    metrics.freshLiveSearchMs = Date.now() - freshStarted
    metrics.freshLiveHits = freshPage.items.length
    expect(freshPage.items.length).toBeGreaterThan(0)
    // Repeated searches answer the same page without the pass restarting
    // (indexedSessions never resets to zero while running).
    const indexedBefore = engine.indexState.indexedSessions
    const again = await ctx.sessionQuery.searchEvents({
      sessionId: SessionId(LIVE_SESSION),
      query: LIVE_QUERY,
      limit: 5,
    })
    expect(again.items.map(item => item.seq)).toEqual(page.items.map(item => item.seq))
    expect(engine.indexState.indexedSessions).toBeGreaterThanOrEqual(indexedBefore)
    console.log(`[live-home] targeted search ${elapsedMs}ms, ${page.items.length} hit(s), index rows ${rows}`)
  }, 60_000)

  it('cross-session search answers after the bounded wait or reports indexing, never a timeout', async () => {
    const { ctx, engine, indexPath } = await liveEngine({ firstSearchWaitMs: 20_000 })
    const started = Date.now()
    let page: Awaited<ReturnType<typeof ctx.sessionQuery.searchSessions>> | undefined
    let firstAttemptMs = 0
    try {
      page = await ctx.sessionQuery.searchSessions({ query: LIVE_QUERY, limit: 5 })
      firstAttemptMs = Date.now() - started
    } catch (error: unknown) {
      expect((error as { code?: string }).code).toBe('SESSION_QUERY_INDEXING')
      firstAttemptMs = Date.now() - started
      // Never the tool's 30 s abort: the bounded wait returns a coded state.
      expect(firstAttemptMs).toBeLessThan(30_000)
      const passMs = await waitForReady(engine, 240_000)
      expect(engine.indexState.status).toBe('ready')
      page = await ctx.sessionQuery.searchSessions({ query: LIVE_QUERY, limit: 5 })
        metrics.corpusReadyMs = passMs
      metrics.firstAttemptMs = firstAttemptMs
    }
    expect(page.items.length).toBeGreaterThan(0)
    expect(engine.indexState.status).toBe('ready')
    expect(engine.indexState.totalSessions).toBeGreaterThan(0)
    expect(indexedRows(indexPath)).toBeGreaterThan(0)
    metrics.corpusTotalMs = Date.now() - started
    metrics.indexState = engine.indexState
    metrics.indexRowsFinal = indexedRows(indexPath)
  }, 300_000)
})
