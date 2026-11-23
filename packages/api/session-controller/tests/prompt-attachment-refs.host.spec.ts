/** Durable prompt-reference authorization and batch limits through the real command index and store. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, {
  SESSION_FORMAT_VERSION, SessionId, SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import {
  ToolCallId, createToolResultMessage, createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import SessionController from '../src/index.ts'
import { createSessionTestController, testSessionPersistence } from './test-remote.ts'

const defaults = {
  defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
  cwd: '/tmp',
}

/** Limits tight enough to exercise every count/byte bound with two or three citations. */
const LIMITS: ImageAttachmentLimits = Object.freeze({
  maxImageBytes: 20,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 10,
  maxImagePixels: 4,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png'] as const),
})

/** Real `AttachmentStore` admission over references, refusing the upload/read paths. */
class PromptReferenceStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits
  override readonly maxFileReferencesPerMessage: number

  constructor(ctx: Context, maxFiles = 2) {
    super(ctx)
    this.imageLimits = LIMITS
    this.maxFileReferencesPerMessage = maxFiles
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    throw new Error('this fixture admits durable references only')
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    throw new Error('this fixture admits durable references only')
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    throw new Error('this fixture admits durable references only')
  }
}

function imageRef(id: string, bytes: number): ImageAttachmentRef {
  return { attachmentId: AttachmentId(id), mediaType: 'image/png', bytes, width: 1, height: 1 }
}

function fileRef(id: string): FileAttachmentRef {
  return { attachmentId: AttachmentId(id), name: `${id}.txt`, bytes: 1 }
}

/** One live Session with a registered Agent and the real controller over a reference-only store. */
async function harness(): Promise<{
  ctx: Context
  controller: SessionController
  session: Session
  sessionId: SessionId
  followup: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const sessionId = SessionId('prompt-refs-session')
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/workspace',
  }
  const events: SessionEvent[] = []
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([header]),
    inspect: () => Promise.resolve({ meta: header, events }),
  }) as never)
  const store = new PromptReferenceStore(ctx)
  void store
  const controller = createSessionTestController(ctx, defaults)
  const session = ctx.sessions.create(sessionId, { meta: header })
  const followup = vi.fn()
  const agent = {} as Agent
  Object.assign(agent, {
    id: sessionId,
    session,
    status: 'idle',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
    followup,
  })
  await ctx.agents.register(agent)
  return { ctx, controller, session, sessionId, followup }
}

/** Append one committed user message carrying the given blocks. */
function logUserMessage(session: Session, content: readonly ContentBlock[]): void {
  session.append('user/message', createUserMessage({
    content,
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Register one idle Agent over a freshly created Session and expose its followup receipt. */
async function registerAgent(ctx: Context, session: Session): Promise<ReturnType<typeof vi.fn>> {
  const followup = vi.fn()
  const agent = {} as Agent
  Object.assign(agent, {
    id: session.id,
    session,
    status: 'idle',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
    followup,
  })
  await ctx.agents.register(agent)
  return followup
}

describe('durable prompt references', () => {
  it('admits logged image and file citations through the real store', async () => {
    const h = await harness()
    const image = imageRef('image-1', 4)
    const file = fileRef('file-1')
    logUserMessage(h.session, [
      { type: 'text', text: 'original' },
      { type: 'image', attachment: image },
      { type: 'file', attachment: file },
    ])

    await expect(h.controller.prompt({
      requestId: 'accepted-refs' as never,
      sessionId: h.sessionId,
      mode: 'queue',
      content: [
        { type: 'image-ref', attachment: image },
        { type: 'file-ref', attachment: file },
        { type: 'text', text: 'again' },
      ],
    }, new AbortController().signal)).resolves.toEqual({ accepted: true })

    expect(h.followup).toHaveBeenCalledTimes(1)
    const message = h.followup.mock.calls[0]![0] as { content: readonly unknown[] }
    expect(message.content).toEqual([
      { type: 'image', attachment: image },
      { type: 'file', attachment: file },
      { type: 'text', text: 'again' },
    ])
  })

  it('rejects a reference logged only by another Session', async () => {
    const h = await harness()
    const file = fileRef('foreign-file')
    const other = h.ctx.sessions.create(SessionId('other-session'), { meta: { cwd: '/workspace' } })
    logUserMessage(other, [{ type: 'file', attachment: file }])

    await expect(h.controller.prompt({
      requestId: 'foreign-session-ref' as never,
      sessionId: h.sessionId,
      mode: 'queue',
      content: [{ type: 'file-ref', attachment: file }],
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'session/attachment-invalid',
      details: { reason: 'ATTACHMENT_NOT_REFERENCED' },
    })
    expect(h.followup).not.toHaveBeenCalled()
  })

  it('accepts a fork seed-prefix citation and rejects a source-only one', async () => {
    const h = await harness()
    const inside = imageRef('fork-inside', 1)
    logUserMessage(h.session, [{ type: 'image', attachment: inside }])
    const seed = h.session.snapshotEvents()
    const childId = SessionId('fork-child')
    const child = h.ctx.sessions.create(childId, {
      seed: [...seed],
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { cwd: '/workspace', parentSession: h.sessionId, isSeeded: true },
    })
    const childFollowup = await registerAgent(h.ctx, child)

    await expect(h.controller.prompt({
      requestId: 'fork-inside' as never,
      sessionId: childId,
      mode: 'queue',
      content: [{ type: 'image-ref', attachment: inside }],
    }, new AbortController().signal)).resolves.toEqual({ accepted: true })
    expect(childFollowup).toHaveBeenCalledTimes(1)

    const outside = imageRef('fork-outside', 1)
    logUserMessage(h.session, [{ type: 'image', attachment: outside }])
    await expect(h.controller.prompt({
      requestId: 'fork-outside' as never,
      sessionId: childId,
      mode: 'queue',
      content: [{ type: 'image-ref', attachment: outside }],
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'session/attachment-invalid',
      details: { reason: 'ATTACHMENT_NOT_REFERENCED' },
    })
  })

  it('rejects a file cited only by a non-user-message event', async () => {
    const h = await harness()
    const file = fileRef('tool-file')
    h.session.append('tool/result', {
      turn: 1,
      step: 0,
      message: createToolResultMessage({
        callId: ToolCallId('call-file'),
        content: [{ type: 'file', attachment: file }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })

    await expect(h.controller.prompt({
      requestId: 'tool-only-file' as never,
      sessionId: h.sessionId,
      mode: 'queue',
      content: [{ type: 'file-ref', attachment: file }],
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'session/attachment-invalid',
      details: { reason: 'ATTACHMENT_NOT_REFERENCED' },
    })
  })

  it('rejects malformed durable wire references before any log lookup', async () => {
    const h = await harness()
    const malformed = [
      [{ type: 'image-ref', attachment: null }],
      [{ type: 'image-ref', attachment: { attachmentId: 5, mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }],
      [{ type: 'file-ref', attachment: { attachmentId: '' } }],
      [{ type: 'image-ref', attachment: { attachmentId: 'image-x', bytes: 1, width: 1, height: 1 } }],
      [{ type: 'image-ref', attachment: { attachmentId: 'image-y', mediaType: 'image/png', bytes: 1, width: 1 } }],
      [{ type: 'image-ref', attachment: { attachmentId: 'image-z', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 5 } }],
      [{ type: 'file-ref', attachment: { attachmentId: 'file-x', name: '', bytes: 1 } }],
      [{ type: 'file-ref', attachment: { attachmentId: 'file-y', name: 5, bytes: 1 } }],
      [{ type: 'file-ref', attachment: { attachmentId: 'file-z', name: 'x', bytes: '1' } }],
      [{ type: 'image-ref', attachment: { attachmentId: 'image-b', mediaType: 'image/png', bytes: -1, width: 1, height: 1 } }],
    ]
    for (const [index, content] of malformed.entries()) {
      await expect(h.controller.prompt({
        requestId: `malformed-${index}` as never,
        sessionId: h.sessionId,
        mode: 'queue',
        content: content as never,
      }, new AbortController().signal)).rejects.toMatchObject({
        code: 'session/attachment-invalid',
        details: { reason: 'INVALID_ATTACHMENT_REF' },
      })
    }
    expect(h.followup).not.toHaveBeenCalled()
  })

  it('enforces the image count, byte, and duplicate-citation limits over references', async () => {
    const h = await harness()
    const a = imageRef('limit-a', 1)
    const b = imageRef('limit-b', 1)
    const c = imageRef('limit-c', 1)
    logUserMessage(h.session, [
      { type: 'image', attachment: a },
      { type: 'image', attachment: b },
      { type: 'image', attachment: c },
    ])

    await expect(h.controller.prompt({
      requestId: 'over-count' as never,
      sessionId: h.sessionId,
      mode: 'queue',
      content: [
        { type: 'image-ref', attachment: a },
        { type: 'image-ref', attachment: b },
        { type: 'image-ref', attachment: c },
      ],
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'session/attachment-invalid',
      details: { reason: 'TOO_MANY_IMAGES' },
    })

    await expect(h.controller.prompt({
      requestId: 'duplicate' as never,
      sessionId: h.sessionId,
      mode: 'queue',
      content: [
        { type: 'image-ref', attachment: a },
        { type: 'image-ref', attachment: a },
      ],
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'session/attachment-invalid',
      details: { reason: 'DUPLICATE_ATTACHMENT_REF' },
    })
    expect(h.followup).not.toHaveBeenCalled()
  })

  it('enforces the aggregate image-byte limit over cited bytes', async () => {
    const h = await harness()
    const heavyA = imageRef('heavy-a', 6)
    const heavyB = imageRef('heavy-b', 6)
    logUserMessage(h.session, [
      { type: 'image', attachment: heavyA },
      { type: 'image', attachment: heavyB },
    ])

    await expect(h.controller.prompt({
      requestId: 'over-bytes' as never,
      sessionId: h.sessionId,
      mode: 'queue',
      content: [
        { type: 'image-ref', attachment: heavyA },
        { type: 'image-ref', attachment: heavyB },
      ],
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'session/attachment-invalid',
      details: { reason: 'IMAGES_TOO_LARGE' },
    })
    expect(h.followup).not.toHaveBeenCalled()
  })

  it('caps durable file references per prompt', async () => {
    const h = await harness()
    const first = fileRef('cap-1')
    const second = fileRef('cap-2')
    const third = fileRef('cap-3')
    logUserMessage(h.session, [
      { type: 'file', attachment: first },
      { type: 'file', attachment: second },
      { type: 'file', attachment: third },
    ])

    await expect(h.controller.prompt({
      requestId: 'over-files' as never,
      sessionId: h.sessionId,
      mode: 'queue',
      content: [
        { type: 'file-ref', attachment: first },
        { type: 'file-ref', attachment: second },
        { type: 'file-ref', attachment: third },
      ],
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'session/attachment-invalid',
      details: { reason: 'TOO_MANY_FILES' },
    })
    expect(h.followup).not.toHaveBeenCalled()
  })
})
