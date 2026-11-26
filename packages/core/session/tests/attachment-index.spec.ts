import { describe, expect, it } from 'vitest'
import { AttachmentId, type FileAttachmentRef, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionAttachmentIndex,
  SessionId,
  SessionSeq,
  referencedImageInEvents,
  type SessionEvent,
} from '../src/index.ts'

function imageRef(id: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(id),
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
}

function fileRef(id: string): FileAttachmentRef {
  return {
    attachmentId: AttachmentId(id),
    name: `${id}.txt`,
    bytes: 5,
  }
}

describe('SessionAttachmentIndex', () => {
  it('incrementally indexes logged image and file references on Session', () => {
    const session = Session.create(SessionId('attach-index-session'))
    const userImg = imageRef('user-img')
    const userFile = fileRef('user-file')
    const toolImg = imageRef('tool-img')
    const toolFile = fileRef('tool-file')
    const streamedImg = imageRef('streamed-img')

    session.append('user/message', createUserMessage({
      content: [
        { type: 'image', attachment: userImg },
        { type: 'file', attachment: userFile },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(session.referencedImage('user-img')).toEqual(userImg)
    expect(session.referencedFile('user-file')).toEqual(userFile)
    expect(session.referencedImage('missing')).toBeUndefined()

    session.append('tool/result', {
      turn: 1,
      step: 0,
      message: createToolResultMessage({
        callId: ToolCallId('call-1'),
        content: [
          { type: 'image', attachment: toolImg },
          { type: 'file', attachment: toolFile },
        ],
        isError: false,
      }),
    }, { surfaceOp: 'append' })

    expect(session.referencedImage('tool-img')).toEqual(toolImg)
    expect(session.referencedFile('tool-file')).toBeUndefined()

    session.append('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [{
        type: 'chunk',
        time: 10,
        chunk: { type: 'block-end', index: 0, block: { type: 'image', attachment: streamedImg } },
      }],
    })
    expect(session.referencedImage('streamed-img')).toEqual(streamedImg)

    const assistantMsgImg = imageRef('assistant-msg-img')
    const splicedImg = imageRef('spliced-img')
    const events: SessionEvent[] = [
      {
        type: 'assistant/message',
        seq: SessionSeq(0),
        time: 1,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          stream: [],
          message: createAssistantMessage({
            content: [{ type: 'image', attachment: assistantMsgImg }],
            source: { provider: 'fixture', model: 'fixture' },
          }),
        },
      },
      {
        type: 'agent/inbox/spliced',
        seq: SessionSeq(1),
        time: 2,
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [createUserMessage({
            content: [{ type: 'image', attachment: splicedImg }],
            source: { kind: 'user' },
          })],
        },
      },
    ]
    const index = SessionAttachmentIndex.fromEvents(events)
    expect(index.referencedImage('assistant-msg-img')).toEqual(assistantMsgImg)
    expect(index.referencedImage('spliced-img')).toEqual(splicedImg)
    expect(referencedImageInEvents(events, 'spliced-img')).toEqual(splicedImg)
    expect(referencedImageInEvents(events, 'absent')).toBeUndefined()
  })
})
