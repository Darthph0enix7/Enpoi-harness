/**
 * The per-session draft record: text stays required and unchanged, while the
 * optional durable attachment list is validated additively so older stored
 * records keep parsing.
 */
import { describe, expect, it } from 'vitest'
import { requireDraft } from '../src/index.ts'

const IMAGE = {
  kind: 'image',
  attachment: {
    attachmentId: 'image-1',
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
    name: 'shot.png',
  },
}

describe('requireDraft', () => {
  it('accepts a text-only draft and an older record without the attachment member', () => {
    expect(requireDraft({ text: 'hello', updatedAt: 1, clientId: 'c1' }))
      .toEqual({ text: 'hello', updatedAt: 1, clientId: 'c1' })
  })

  it('keeps the durable attachment list exactly as the client stored it', () => {
    expect(requireDraft({
      text: 'with media',
      attachments: [IMAGE, { kind: 'file', attachment: { attachmentId: 'file-1', name: 'n.txt', bytes: 4 } }],
      updatedAt: 2,
      clientId: 'c1',
    })).toEqual({
      text: 'with media',
      attachments: [IMAGE, { kind: 'file', attachment: { attachmentId: 'file-1', name: 'n.txt', bytes: 4 } }],
      updatedAt: 2,
      clientId: 'c1',
    })
  })

  it('rejects a malformed attachment list instead of dropping it silently', () => {
    const base = { text: 'x', updatedAt: 1, clientId: 'c1' }
    expect(() => requireDraft({ ...base, attachments: 'nope' }))
      .toThrow('patch.draft.attachments must be an array')
    expect(() => requireDraft({ ...base, attachments: [{ kind: 'image' }] }))
      .toThrow('entries must be objects with an attachment')
    expect(() => requireDraft({ ...base, attachments: [{ kind: 'video', attachment: { attachmentId: 'v' } }] }))
      .toThrow('kind must be "image" or "file"')
    expect(() => requireDraft({ ...base, attachments: [{ kind: 'image', attachment: { attachmentId: '' } }] }))
      .toThrow('attachment.attachmentId must be a non-empty string')
    expect(() => requireDraft({ ...base, attachments: Array.from({ length: 257 }, () => IMAGE) }))
      .toThrow('at most 256 entries')
  })
})
