/**
 * The per-session draft record: text stays required and unchanged, while the
 * optional durable attachment list is validated additively so older stored
 * records keep parsing.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { EnpoiUiStateService, requireDraft } from '../src/index.ts'

async function openSessionService(): Promise<EnpoiUiStateService> {
  const tables = new Map<string, Map<string, unknown>>([
    ['sessions', new Map()],
    ['layout', new Map()],
  ])
  const domain = {
    table: (name: string) => ({
      get: (key: string): unknown => tables.get(name)?.get(key),
      put: async (key: string, value: unknown): Promise<void> => {
        tables.get(name)?.set(key, value)
      },
    }),
    close: (): void => {},
  }
  const ctx = new Context()
  ctx.provide('storageDomain', { open: async () => domain } as never)
  const service = new EnpoiUiStateService(ctx)
  await service[Service.init]()
  return service
}

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
    expect(() => requireDraft({ ...base, incompleteAttachments: 'yes' }))
      .toThrow('incompleteAttachments must be a boolean')
  })

  it('preserves incompleteAttachments only when true', () => {
    expect(requireDraft({
      text: 'partial',
      attachments: [IMAGE],
      incompleteAttachments: true,
      updatedAt: 2,
      clientId: 'c1',
    })).toEqual({
      text: 'partial',
      attachments: [IMAGE],
      incompleteAttachments: true,
      updatedAt: 2,
      clientId: 'c1',
    })
    expect(requireDraft({
      text: 'complete',
      incompleteAttachments: false,
      updatedAt: 2,
      clientId: 'c1',
    })).toEqual({
      text: 'complete',
      updatedAt: 2,
      clientId: 'c1',
    })
  })
})

describe('EnpoiUiStateService conditional draft revisions', () => {
  it('assigns monotonic revisions on put and rejects stale expectedRevision without overwriting', async () => {
    const service = await openSessionService()
    expect(await service.get('s1')).toEqual({ updatedAt: 0, revision: 0 })

    const first = await service.put('s1', {
      expectedRevision: 0,
      draft: { text: 'v1', updatedAt: 100, clientId: 'c1' },
    })
    expect(first).toMatchObject({ ok: true, revision: 1 })

    // Clock skew: c2's wall clock (50) is behind c1's (100), but it knows revision 1 so it succeeds.
    const second = await service.put('s1', {
      expectedRevision: 1,
      draft: { text: 'v2-skewed', updatedAt: 50, clientId: 'c2' },
    })
    expect(second).toMatchObject({ ok: true, revision: 2 })

    // Concurrent/stale writer still expecting revision 1 gets conflict and winning record.
    const stale = await service.put('s1', {
      expectedRevision: 1,
      draft: { text: 'stale-v1', updatedAt: 999, clientId: 'c1' },
    })
    expect(stale).toMatchObject({
      ok: false,
      conflict: true,
      revision: 2,
      record: {
        revision: 2,
        draft: { text: 'v2-skewed', updatedAt: 50, clientId: 'c2' },
      },
    })
    expect(await service.get('s1')).toMatchObject({
      revision: 2,
      draft: { text: 'v2-skewed', updatedAt: 50, clientId: 'c2' },
    })
  })

  it('keeps legacy clients working without lowering a stored newer draft', async () => {
    const service = await openSessionService()
    await service.put('s1', {
      expectedRevision: 0,
      draft: { text: 'newer', updatedAt: 200, clientId: 'c1' },
    })

    // Legacy client omitting expectedRevision cannot overwrite a newer draft.
    const lower = await service.put('s1', {
      draft: { text: 'older', updatedAt: 150, clientId: 'legacy' },
    })
    expect(lower).toMatchObject({
      ok: false,
      conflict: true,
      revision: 1,
      record: { revision: 1, draft: { text: 'newer', updatedAt: 200, clientId: 'c1' } },
    })
    expect(await service.get('s1')).toMatchObject({
      revision: 1,
      draft: { text: 'newer', updatedAt: 200, clientId: 'c1' },
    })

    // Legacy client with newer updatedAt advances the revision.
    const higher = await service.put('s1', {
      draft: { text: 'legacy-newer', updatedAt: 250, clientId: 'legacy' },
    })
    expect(higher).toMatchObject({ ok: true, revision: 2 })
    expect(await service.get('s1')).toMatchObject({
      revision: 2,
      draft: { text: 'legacy-newer', updatedAt: 250, clientId: 'legacy' },
    })
  })

  it('rejects malformed expectedRevision and handles concurrent race cleanly', async () => {
    const service = await openSessionService()
    await expect(service.put('s1', { expectedRevision: 1.5 as number, surface: {} }))
      .rejects.toThrow('expectedRevision must be an integer')
    await expect(service.put('s1', { expectedRevision: -1, surface: {} }))
      .rejects.toThrow('expectedRevision must be a non-negative integer')

    const [a, b] = await Promise.all([
      service.put('s1', { expectedRevision: 0, draft: { text: 'winner', updatedAt: 10, clientId: 'c1' } }),
      service.put('s1', { expectedRevision: 0, draft: { text: 'loser', updatedAt: 20, clientId: 'c2' } }),
    ])
    expect(a).toMatchObject({ ok: true, revision: 1 })
    expect(b).toMatchObject({
      ok: false,
      conflict: true,
      revision: 1,
      record: { revision: 1, draft: { text: 'winner', updatedAt: 10, clientId: 'c1' } },
    })
  })
})
