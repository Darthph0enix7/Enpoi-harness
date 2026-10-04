import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb } from '../src/db'
import { makePipeline } from '../src/pipeline'
import { registerMemoryTools } from '../src/tools'

interface CapturedTool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
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
