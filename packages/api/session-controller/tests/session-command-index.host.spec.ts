/** Derived per-Session command index coverage (P3). */
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionCommandIndex } from '../src/session-command-index.ts'

function imageRef(id: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(id),
    mediaType: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  }
}

/** Append one plugin-owned log-only event without owning its declaration. */
function appendLogOnly(session: Session, type: string, data: unknown): SessionEvent {
  return (session.append as unknown as (type: string, data: unknown) => SessionEvent)(type, data)
}

describe('SessionCommandIndex', () => {
  it('answers prompt, boundary, and attachment lookups and advances by ingest', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    onTestFinished(() => ctx.fiber.dispose())
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })

    const anchor = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first' }],
      source: { kind: 'user', rpcId: 'rpc-1' as never },
    }), { surfaceOp: 'append' })
    const ref = imageRef('image-1')
    session.append('user/message', createUserMessage({
      content: [{ type: 'image', attachment: ref }],
      source: { kind: 'user', rpcId: 'rpc-2' as never },
    }), { surfaceOp: 'append' })
    appendLogOnly(session, 'revert/state', { fromSeq: anchor.seq, cause: 'revert' })

    const index = SessionCommandIndex.fromEvents(session.snapshotEvents())
    expect(index.hasPromptRequest('rpc-1')).toBe(true)
    expect(index.hasPromptRequest('rpc-2')).toBe(true)
    expect(index.hasPromptRequest('rpc-missing')).toBe(false)
    expect(index.latestRevertBoundary()).toBe(anchor.seq)
    expect(index.referencedImage('image-1')).toEqual(ref)
    expect(index.referencedImage('image-missing')).toBeUndefined()

    // Incremental ingest matches the durable append path.
    const clear = appendLogOnly(session, 'revert/state', { fromSeq: null, cause: 'commit' })
    index.ingest(clear)
    expect(index.latestRevertBoundary()).toBeUndefined()
    const late = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'later' }],
      source: { kind: 'user', rpcId: 'rpc-3' as never },
    }), { surfaceOp: 'append' })
    index.ingest(late)
    expect(index.hasPromptRequest('rpc-3')).toBe(true)
  })
})
