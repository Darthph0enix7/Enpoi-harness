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
function fixture(initialText = '', initialAttachments: readonly RestoredDraftAttachment[] = []): TargetFixture {
  let snapshot = { draft: initialText, draftAttachments: initialAttachments }
  let listener: (() => void) | undefined
  const setDraft = vi.fn((text: string, attachments: readonly RestoredDraftAttachment[] = []) => {
    snapshot = { draft: text, draftAttachments: attachments }
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

      // Three oversized entries cannot fit the serialized cap; the text stays.
      target.actions.setDraft('typed', huge)
      await vi.waitFor(() => { expect(latestAttachments()).toHaveLength(2) }, { timeout: 2_000 })
      expect(overflow).toHaveBeenCalledOnce()
    } finally {
      stop()
      clearDraftSync(SESSION)
    }
  })
})
