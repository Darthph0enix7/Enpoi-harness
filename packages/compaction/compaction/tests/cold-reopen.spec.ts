import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Build one compacted log whose persisted corrective amendment has no live compaction bracket. */
function amendmentLog(): {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly checkpointSeq: SessionSeq
  readonly amendmentSeq: SessionSeq
} {
  const id = SessionId('cold-amendment')
  const compactionId = CompactionId('cold-compaction')
  const sourceCommandId = CommandId('cold-command')
  const session = Session.create(id)
  const original = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'original' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('compaction/start', { compactionId, sourceCommandId, turn: 1 })
  session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: 'short' }],
    shadowedRange: { start: original.seq, end: original.seq },
    shadowedSeqs: [original.seq],
    shadowedTokenCount: 1,
    provider: 'mock',
    model: 'mock',
    sourceCommandId,
  })
  const checkpoint = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'checkpoint' }],
    source: compactCheckpointSource(compactionId, sourceCommandId),
  }), {
    surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
    sourceEventSeqs: [original.seq],
  })
  session.append('compaction/end', { compactionId, sourceCommandId, turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const amendment = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'amended checkpoint' }],
    source: compactCheckpointSource(compactionId, sourceCommandId),
  }), {
    surfaceOp: { op: 'replace', startSeq: checkpoint.seq, endSeq: checkpoint.seq },
    sourceEventSeqs: [checkpoint.seq, original.seq],
  })
  return {
    header: { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false },
    events: session.snapshotEvents(),
    checkpointSeq: checkpoint.seq,
    amendmentSeq: amendment.seq,
  }
}

describe('compaction cold reopen', () => {
  it('decodes a persisted corrective amendment from compressed JSONL and seeds the compaction companion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compaction-cold-'))
    roots.push(root)
    const fixture = amendmentLog()

    const writer = new Context()
    contexts.push(writer)
    await writer.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    const handle = await writer.sessionPersistence.create(fixture.header)
    try {
      await handle.append(fixture.events)
    } finally {
      await handle.close()
    }

    const cold = new Context()
    contexts.push(cold)
    await cold.plugin(SessionStore)
    await cold.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    await cold.plugin(InvariantRegistry)
    await cold.plugin(CompactionInvariant)
    const reader = await cold.sessionPersistence.open(fixture.header.id, 'read')
    let decoded: readonly SessionEvent[]
    try {
      decoded = (await reader.read()).events
    } finally {
      await reader.close()
    }
    expect(decoded.map(event => event.type)).toEqual(fixture.events.map(event => event.type))
    const amendment = decoded[fixture.amendmentSeq]
    expect(amendment?.type).toBe('user/message')
    if (amendment?.type === 'user/message') {
      expect(amendment.data.source).toEqual({
        kind: 'compact-checkpoint',
        compactionId: 'cold-compaction',
        sourceCommandId: 'cold-command',
      })
    }

    const restored = cold.sessions.create(fixture.header.id, { seed: decoded })
    expect(restored.surface.nodes).toContain(fixture.amendmentSeq)
    expect(restored.surface.nodes).not.toContain(fixture.checkpointSeq)
  })
})
