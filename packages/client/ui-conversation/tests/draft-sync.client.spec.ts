// @vitest-environment jsdom
/** Server draft sync: durable restored attachments travel with the text. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RestoredDraftAttachment } from '../src/client/contract/input.ts'
import { bindDraftSync, clearDraftSync, type DraftSyncTarget } from '../src/client/draft-sync.ts'

const SESSION = 'session-draft'

const IMAGE: RestoredDraftAttachment = {
  kind: 'image',
  attachment: {
    attachmentId: 'image-1' as never,
    mediaType: 'image/png',
    bytes: 3,
    width: 1,
    height: 1,
    name: 'shot.png',
  },
}
const FILE: RestoredDraftAttachment = {
  kind: 'file',
  attachment: { attachmentId: 'file-1' as never, name: 'notes.txt', bytes: 4 },
}

interface TargetFixture {
  readonly instance: DraftSyncTarget
  actions: DraftSyncTarget['actions']
  /** The setDraft spy itself, exposed without a method-reference lint hit. */
  readonly setDraft: ReturnType<typeof vi.fn>
  emit(): void
}

/** Minimal store instance: snapshot, actions, and one listener. */
function fixture(
  initialText = '',
  initialAttachments: readonly RestoredDraftAttachment[] = [],
  initialIncomplete?: boolean,
): TargetFixture {
  let snapshot: {
    draft: string
    draftAttachments: readonly RestoredDraftAttachment[]
    draftAttachmentsIncomplete?: boolean
  } = {
    draft: initialText,
    draftAttachments: initialAttachments,
    ...(initialIncomplete === true ? { draftAttachmentsIncomplete: true } : {}),
  }
  let listener: (() => void) | undefined
  const setDraft = vi.fn((
    text: string,
    attachments: readonly RestoredDraftAttachment[] = [],
    incomplete = false,
  ) => {
    snapshot = {
      draft: text,
      draftAttachments: attachments,
      ...(incomplete ? { draftAttachmentsIncomplete: true } : {}),
    }
    listener?.()
  })
  const actions: DraftSyncTarget['actions'] = { setDraft }
  return {
    instance: {
      getSnapshot: () => snapshot,
      actions,
      subscribe: (fn) => {
        listener = fn
        return () => { listener = undefined }
      },
    },
    actions,
    setDraft,
    emit: () => { listener?.() },
  }
}

/** Route `enpoiUiState.get`/`put` calls to scripted answers while recording bodies. */
function stubUiState(remote: unknown) {
  const calls: Array<{ method: string; patch?: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const raw = typeof init.body === 'string' ? init.body : ''
    const body = JSON.parse(raw) as {
      method: string
      payload: { args: { patch?: unknown } }
    }
    calls.push({ method: body.method, ...(body.payload.args.patch === undefined ? {} : { patch: body.payload.args.patch }) })
    return {
      ok: true,
      json: async () => ({
        result: { ok: true, value: body.method === 'enpoiUiState.get' ? remote : { updatedAt: 1 } },
      }),
    }
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('draft sync attachments', () => {
  it('adopts a newer server draft with its durable restored attachments', async () => {
    stubUiState({
      updatedAt: 10,
      draft: { text: 'remote text', attachments: [IMAGE, FILE], updatedAt: 20, clientId: 'other-device' },
    })
    const target = fixture()
    const stop = bindDraftSync(target.instance, SESSION)
    try {
      await vi.waitFor(() => {
        expect(target.setDraft).toHaveBeenCalledWith('remote text', [IMAGE, FILE])
      })
    } finally {
      stop()
    }
  })

  it('keeps the remote text when a stored attachment entry is malformed', async () => {
    stubUiState({
      updatedAt: 10,
      draft: {
        text: 'remote text',
        attachments: [{ kind: 'image', attachment: { attachmentId: '' } }],
        updatedAt: 20,
        clientId: 'other-device',
      },
    })
    const target = fixture()
    const stop = bindDraftSync(target.instance, SESSION)
    try {
      await vi.waitFor(() => {
        expect(target.setDraft).toHaveBeenCalledWith('remote text', [])
      })
    } finally {
      stop()
    }
  })

  it('mirrors local attachment changes into the server record', async () => {
    const calls = stubUiState({ updatedAt: 0 })
    const target = fixture('typed')
    const stop = bindDraftSync(target.instance, SESSION)
    try {
      await vi.waitFor(() => {
        expect(calls.some(call => call.method === 'enpoiUiState.put')).toBe(true)
      }, { timeout: 2_000 })
      target.actions.setDraft('typed', [IMAGE])
      await vi.waitFor(() => {
        const latest = calls.filter(call => call.method === 'enpoiUiState.put').at(-1)
        expect(latest?.patch).toMatchObject({ draft: { text: 'typed', attachments: [IMAGE] } })
      }, { timeout: 2_000 })
      target.actions.setDraft('typed', [])
      await vi.waitFor(() => {
        const latest = calls.filter(call => call.method === 'enpoiUiState.put').at(-1)
        expect(latest?.patch).toMatchObject({ draft: { text: 'typed', attachments: [] } })
      }, { timeout: 2_000 })
    } finally {
      stop()
      clearDraftSync(SESSION)
    }
  })

  it('bounds pushed references to the server record cap, keeps the text, and notices once', async () => {
    const calls = stubUiState({ updatedAt: 0 })
    const overflow = vi.fn()
    const many = Array.from({ length: 300 }, (_, index): RestoredDraftAttachment => ({
      kind: 'file',
      attachment: {
        attachmentId: `file-${index}` as never,
        name: `f-${index}.txt`,
        bytes: 1,
      },
    }))
    const huge = Array.from({ length: 3 }, (_, index): RestoredDraftAttachment => ({
      kind: 'file',
      attachment: {
        attachmentId: `huge-${index}` as never,
        name: 'x'.repeat(120_000),
        bytes: 1,
      },
    }))
    const latestAttachments = (): readonly unknown[] => {
      const latest = calls.filter(call => call.method === 'enpoiUiState.put').at(-1)
      const patch = latest?.patch as { draft: { text: string; attachments: readonly unknown[] } } | undefined
      expect(patch?.draft.text).toBe('typed')
      return patch?.draft.attachments ?? []
    }
    const target = fixture('typed')
    const stop = bindDraftSync(target.instance, SESSION, { onAttachmentOverflow: overflow })
    try {
      await vi.waitFor(() => {
        expect(calls.some(call => call.method === 'enpoiUiState.put')).toBe(true)
      }, { timeout: 2_000 })

      target.actions.setDraft('typed', many)
      await vi.waitFor(() => { expect(latestAttachments()).toHaveLength(256) }, { timeout: 2_000 })
      expect(overflow).toHaveBeenCalledOnce()

      // Three oversized entries cannot fit the serialized cap; the text stays
      // and the wire draft carries the explicit incomplete marker.
      target.actions.setDraft('typed', huge)
      await vi.waitFor(() => { expect(latestAttachments()).toHaveLength(2) }, { timeout: 2_000 })
      expect(overflow).toHaveBeenCalledOnce()
      const latestPut = calls.filter(call => call.method === 'enpoiUiState.put').at(-1)
      expect(latestPut?.patch).toMatchObject({ draft: { text: 'typed', incompleteAttachments: true } })
      expect(target.instance.getSnapshot().draftAttachmentsIncomplete).toBeUndefined()
    } finally {
      stop()
      clearDraftSync(SESSION)
    }
  })

  it('marks adopted drafts incomplete when the server record carries incompleteAttachments', async () => {
    stubUiState({
      updatedAt: 10,
      revision: 3,
      draft: {
        text: 'partial draft',
        attachments: [IMAGE],
        incompleteAttachments: true,
        updatedAt: 20,
        clientId: 'other-device',
      },
    })
    const target = fixture()
    const stop = bindDraftSync(target.instance, SESSION)
    try {
      await vi.waitFor(() => {
        expect(target.setDraft).toHaveBeenCalledWith('partial draft', [IMAGE], true)
      })
      expect(target.instance.getSnapshot().draftAttachmentsIncomplete).toBe(true)
    } finally {
      stop()
      clearDraftSync(SESSION)
    }
  })

  it('serializes pushes per binding and reconciles conflicts without dropping live typing', async () => {
    const putResolvers: Array<(value: unknown) => void> = []
    const sentPatches: Array<{ draft?: unknown; expectedRevision?: number }> = []
    let inFlight = 0
    let maxInFlight = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
        method: string
        payload: { args: { patch?: { draft?: unknown; expectedRevision?: number } } }
      }
      if (body.method === 'enpoiUiState.get') {
        return {
          ok: true,
          json: async () => ({
            result: {
              ok: true,
              value: {
                updatedAt: 10,
                revision: 1,
                draft: { text: 'base', updatedAt: 10, clientId: 'other' },
              },
            },
          }),
        }
      }
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      sentPatches.push(body.payload.args.patch ?? {})
      const value = await new Promise<unknown>((resolve) => { putResolvers.push(resolve) })
      inFlight -= 1
      return { ok: true, json: async () => ({ result: { ok: true, value } }) }
    }))

    const target = fixture()
    const stop = bindDraftSync(target.instance, SESSION)
    try {
      await vi.waitFor(() => { expect(target.setDraft).toHaveBeenCalledWith('base', []) })

      // First edit triggers push after 600ms debounce.
      target.actions.setDraft('edit-1')
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(1) }, { timeout: 2_000 })
      expect(sentPatches[0]).toMatchObject({ expectedRevision: 1, draft: { text: 'edit-1' } })

      // User keeps typing while the first push is still in flight; debounce
      // finishes while put #1 is still pending -> must NOT launch a second concurrent put.
      target.actions.setDraft('edit-2-live')
      await new Promise(resolve => setTimeout(resolve, 700))
      expect(sentPatches).toHaveLength(1)
      expect(maxInFlight).toBe(1)

      // First push loses to another device's edit at revision 2. Because the user
      // is still typing 'edit-2-live', client MUST NOT overwrite it with winner;
      // it rebases onto revision 2 and pushes 'edit-2-live'.
      putResolvers[0]!({
        ok: false,
        conflict: true,
        updatedAt: 20,
        revision: 2,
        record: {
          updatedAt: 20,
          revision: 2,
          draft: { text: 'other-winner', updatedAt: 20, clientId: 'other' },
        },
      })
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(2) }, { timeout: 2_000 })
      expect(sentPatches[1]).toMatchObject({ expectedRevision: 2, draft: { text: 'edit-2-live' } })
      expect(target.instance.getSnapshot().draft).toBe('edit-2-live')
      putResolvers[1]!({ ok: true, updatedAt: 30, revision: 3 })
      await new Promise(resolve => setTimeout(resolve, 20))

      // Now user is idle and makes an edit that loses to another device at revision 4 -> adopts winner.
      target.actions.setDraft('edit-3-stale')
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(3) }, { timeout: 2_000 })
      expect(sentPatches[2]).toMatchObject({ expectedRevision: 3, draft: { text: 'edit-3-stale' } })
      putResolvers[2]!({
        ok: false,
        conflict: true,
        updatedAt: 40,
        revision: 4,
        record: {
          updatedAt: 40,
          revision: 4,
          draft: { text: 'remote-wins', updatedAt: 40, clientId: 'other' },
        },
      })
      await vi.waitFor(() => {
        expect(target.instance.getSnapshot().draft).toBe('remote-wins')
      })
      expect(sentPatches).toHaveLength(3)
    } finally {
      stop()
      clearDraftSync(SESSION)
    }
  })

  it('adopts a newer server revision despite client clock skew', async () => {
    // Local cache was synced at revision 1 with a skewed future clock (updatedAt = 999999).
    localStorage.setItem(`dsh.conversation.draft-sync.v1.${SESSION}`, JSON.stringify({
      text: 'local-skewed',
      attachments: [],
      updatedAt: 999_999,
      clientId: 'this-device',
      serverRevision: 1,
      dirty: false,
    }))
    stubUiState({
      updatedAt: 100,
      revision: 2,
      draft: { text: 'remote-newer-rev', updatedAt: 50, clientId: 'other-device' },
    })
    const target = fixture('local-skewed')
    const stop = bindDraftSync(target.instance, SESSION)
    try {
      await vi.waitFor(() => {
        expect(target.setDraft).toHaveBeenCalledWith('remote-newer-rev', [])
      })
    } finally {
      stop()
      clearDraftSync(SESSION)
    }
  })

  it('rebases onto a non-draft server revision bump and preserves incompleteAttachments across text edits', async () => {
    const sentPatches: Array<{ draft?: unknown; expectedRevision?: number }> = []
    let putCount = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as {
        method: string
        payload: { args: { patch?: { draft?: unknown; expectedRevision?: number } } }
      }
      if (body.method === 'enpoiUiState.get') {
        return {
          ok: true,
          json: async () => ({
            result: {
              ok: true,
              value: {
                updatedAt: 10,
                revision: 1,
                draft: {
                  text: 'partial',
                  attachments: [IMAGE],
                  incompleteAttachments: true,
                  updatedAt: 10,
                  clientId: 'other',
                },
              },
            },
          }),
        }
      }
      putCount += 1
      sentPatches.push(body.payload.args.patch ?? {})
      if (putCount === 1) {
        // Simulate a sidebar surface write bumping revision 1 -> 2 with the same draft.
        return {
          ok: true,
          json: async () => ({
            result: {
              ok: true,
              value: {
                ok: false,
                conflict: true,
                updatedAt: 15,
                revision: 2,
                record: {
                  updatedAt: 15,
                  revision: 2,
                  draft: {
                    text: 'partial',
                    attachments: [IMAGE],
                    incompleteAttachments: true,
                    updatedAt: 10,
                    clientId: 'other',
                  },
                },
              },
            },
          }),
        }
      }
      return { ok: true, json: async () => ({ result: { ok: true, value: { ok: true, updatedAt: 20, revision: 3 } } }) }
    }))

    const target = fixture()
    const stop = bindDraftSync(target.instance, SESSION)
    try {
      await vi.waitFor(() => {
        expect(target.setDraft).toHaveBeenCalledWith('partial', [IMAGE], true)
      })
      target.actions.setDraft('partial edited', [IMAGE], true)
      await vi.waitFor(() => { expect(sentPatches).toHaveLength(2) }, { timeout: 2_000 })
      expect(sentPatches[0]).toMatchObject({ expectedRevision: 1 })
      expect(sentPatches[1]).toMatchObject({
        expectedRevision: 2,
        draft: { text: 'partial edited', attachments: [IMAGE], incompleteAttachments: true },
      })
    } finally {
      stop()
      clearDraftSync(SESSION)
    }
  })
})
