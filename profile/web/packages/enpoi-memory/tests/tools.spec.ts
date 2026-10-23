import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb } from '../src/db'
import { makePipeline } from '../src/pipeline'
import { registerMemoryTools } from '../src/tools'

interface CapturedTool {
  name: string
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>
  output: { render: (args: unknown, value: Record<string, unknown>) => Array<{ type: string; text: string }> }
}

let db: DatabaseSync

beforeEach(() => {
  const m = require('node:os').tmpdir()
  const p = `${m}/enpoi-mem-tools-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
  process.env.DSH_MEMORY_DB = p
  db = openMemoryDb()
})

afterEach(() => {
  db.close()
  try { require('node:fs').unlinkSync(process.env.DSH_MEMORY_DB ?? '') } catch { /* ok */ }
  delete process.env.DSH_MEMORY_DB
})

function captureTools(): CapturedTool[] {
  const tools: CapturedTool[] = []
  const ctx = { tools: { register: (definition: CapturedTool) => void tools.push(definition) } }
  registerMemoryTools(ctx as never, db, makePipeline(db))
  return tools
}

describe('enpoi-memory tools — memory_confirm id/claim mismatch', () => {
  it('reports an already-committed memory_save id as committed, not unknown', async () => {
    const pipeline = makePipeline(db)
    const confirm = captureTools().find(tool => tool.name === 'memory_confirm')!
    const saved = await pipeline.intake(
      [{ fact: 'MEM-8D1E: the archive bucket is eu-central-3', category: 'PROJECT' }],
      { origin: 'orchestrator', trust: 'operator' },
    )
    expect(saved[0]!.state).toBe('committed')

    const result = await confirm.execute({ id: saved[0]!.id })

    expect(result.confirmed).toBe(false)
    expect(result.state).toBe('committed')
    expect(String(result.note)).toContain('Already committed')
    expect(String(result.note)).not.toContain('Unknown')
  })

  it('confirms a tentative claim and reports unknown ids honestly', async () => {
    const pipeline = makePipeline(db)
    const confirm = captureTools().find(tool => tool.name === 'memory_confirm')!
    const tentative = await pipeline.intake(
      [{ fact: 'chat-sourced fact to verify', category: 'PROJECT' }],
      { origin: 'keeper', trust: 'untrusted_external' },
    )
    expect(tentative[0]!.state).toBe('tentative')

    const confirmed = await confirm.execute({ id: tentative[0]!.id })
    expect(confirmed.confirmed).toBe(true)
    expect(confirmed.state).toBe('committed')

    const missing = await confirm.execute({ id: 'claim-does-not-exist' })
    expect(missing.confirmed).toBe(false)
    expect(String(missing.note)).toContain('Unknown fact id')
  })
})

/** One live-session execution scope for a memory tool call. */
function execScope(sessionId: string, cwd: string) {
  return { agent: { session: { id: sessionId, header: { cwd } } }, signal: new AbortController().signal }
}

describe('enpoi-memory tools — C4 origin/savedAt rendering', () => {
  it('renders `• <id> <category> [<origin> <savedAt>] — <fact>` verbatim', async () => {
    const pipeline = makePipeline(db)
    const saved = await pipeline.intake(
      [{ fact: 'the archive bucket is eu-central-3', category: 'PROJECT' }],
      {
        origin: 'compaction',
        trust: 'verified_execution',
        provenance: JSON.stringify({ source: 'compaction', sessionId: 's1', compactionId: 'c1', cwd: '/work/a', shadowedRange: { start: 1, end: 2 }, summaryRoute: 'mock/mock' }),
      },
    )
    const row = saved[0]!
    const search = captureTools().find(tool => tool.name === 'memory_search')!
    const result = await search.execute({ query: 'archive bucket' }, execScope('s1', '/work/a'))

    const facts = result.facts as Array<Record<string, unknown>>
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      id: row.id,
      category: 'PROJECT',
      origin: 'compaction',
      savedAt: new Date(row.committed_at ?? row.created_at).toISOString().slice(0, 10),
    })
    const text = search.output.render(undefined, result)[0]!.text
    expect(text).toBe(`• ${row.id} PROJECT [compaction ${String(facts[0]!.savedAt)}] — the archive bucket is eu-central-3`)
    expect(text).toMatch(/^• claim-[0-9a-f]+ PROJECT \[compaction \d{4}-\d{2}-\d{2}\] — the archive bucket is eu-central-3$/)
  })

  it('scopes compaction facts to the caller workspace and keeps operator facts global', async () => {
    const pipeline = makePipeline(db)
    await pipeline.intake(
      [{ fact: 'compaction alpha the redis cache key is x', category: 'ARCHITECTURE' }],
      { origin: 'compaction', trust: 'verified_execution', provenance: JSON.stringify({ source: 'compaction', cwd: '/work/a' }) },
    )
    await pipeline.intake(
      [{ fact: 'operator ruling the redis cache key is global', category: 'ARCHITECTURE' }],
      { origin: 'orchestrator', trust: 'operator' },
    )
    const search = captureTools().find(tool => tool.name === 'memory_search')!

    const local = await search.execute({ query: 'redis cache key' }, execScope('s1', '/work/a'))
    const localFacts = local.facts as Array<{ origin: string }>
    expect(localFacts.some(fact => fact.origin === 'compaction')).toBe(true)
    expect(localFacts.some(fact => fact.origin === 'orchestrator')).toBe(true)

    const foreign = await search.execute({ query: 'redis cache key' }, execScope('s2', '/work/b'))
    const foreignFacts = foreign.facts as Array<{ origin: string }>
    expect(foreignFacts.some(fact => fact.origin === 'compaction')).toBe(false)
    expect(foreignFacts.some(fact => fact.origin === 'orchestrator')).toBe(true)
  })
})

describe('enpoi-memory tools — memory_save provenance', () => {
  it('records {source, sessionId, cwd} as audit-only provenance', async () => {
    const pipeline = makePipeline(db)
    const save = captureTools().find(tool => tool.name === 'memory_save')!
    await save.execute({ fact: 'saved from a live session', category: 'PROJECT' }, execScope('session-9', '/work/a'))

    const row = pipeline.list()[0]!
    expect(JSON.parse(row.provenance)).toEqual({ source: 'memory_save', sessionId: 'session-9', cwd: '/work/a' })
    expect(row.origin).toBe('orchestrator')
    expect(row.source_trust).toBe('operator')
  })
})
