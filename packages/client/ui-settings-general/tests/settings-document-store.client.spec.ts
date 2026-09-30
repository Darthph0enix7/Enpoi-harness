import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsDocumentStore } from '../src/client/settings-document-store.ts'
import type { SettingsDocumentLocation } from '../src/client/settings-document-store.ts'
import { DOCUMENT, scriptedView, SESSION, type ViewScript } from './view-script.client.ts'

/** Store over a real mirror derived from the same scripted context, plus the scripted door. */
function derivedDocumentStore(remote: object, script: ViewScript) {
  const ctx = { remote } as never
  return new SettingsDocumentStore(new SettingsDescribeMirror(ctx), script.view)
}

function response(hasDocument = false) {
  return { ok: true, value: { writable: true, hasDocument, namespaces: [] } }
}

function describeFailed(message: string) {
  return { ok: false as const, error: new RemoteError('gateway/internal', message, {}) }
}

describe('SettingsDocumentStore', () => {
  it('loads provider metadata, then closes Settings and reveals the document in the preview', async () => {
    const describe = vi.fn(() => Promise.resolve(response(true)))
    const script = scriptedView({ sessionId: SESSION })
    const controller = derivedDocumentStore({ settings: { describe } }, script)
    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({
      status: 'ready', opening: false, error: null,
    })
    await controller.open()
    expect(script.calls.locate).toBe(1)
    expect(script.calls.close).toBe(1)
    expect(script.calls.reveal).toEqual([{ sessionId: SESSION, document: DOCUMENT }])
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', opening: false, error: null })
  })

  it('marks absent or failed metadata unavailable without opening anything', async () => {
    const script = scriptedView({ sessionId: SESSION })
    const absent = derivedDocumentStore({
      settings: { describe: () => Promise.resolve(response()) },
    }, script)
    await absent.load()
    await absent.open()
    expect(absent.store.getSnapshot().status).toBe('unavailable')
    expect(script.calls.close).toBe(0)

    const failed = derivedDocumentStore({
      settings: { describe: () => Promise.reject(new Error('offline')) },
    }, script)
    await failed.load()
    expect(failed.store.getSnapshot()).toMatchObject({ status: 'unavailable', error: 'offline' })

    const rejected = derivedDocumentStore({
      settings: { describe: () => Promise.resolve(describeFailed('provider failed')) },
    }, script)
    await rejected.load()
    expect(rejected.store.getSnapshot()).toMatchObject({
      status: 'unavailable', error: 'provider failed',
    })
  })

  it('keeps Settings open and reports a failure before the panel closes', async () => {
    const script = scriptedView({
      sessionId: SESSION,
      locate: () => Promise.reject(new Error('no settings document is available')),
    })
    const controller = derivedDocumentStore({
      settings: { describe: () => Promise.resolve(response(true)) },
    }, script)
    await controller.load()
    await controller.open()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', opening: false, error: 'no settings document is available',
    })
    expect(script.calls.close).toBe(0)
    expect(script.calls.reveal).toEqual([])

    // The next gesture retries from a clean error state.
    const retry = scriptedView({ sessionId: SESSION })
    const recovered = derivedDocumentStore({
      settings: { describe: () => Promise.resolve(response(true)) },
    }, retry)
    await recovered.load()
    await recovered.open()
    expect(retry.calls.reveal).toHaveLength(1)
  })

  it('reports no session without closing Settings or revealing anything', async () => {
    const script = scriptedView({ sessionId: undefined })
    const controller = derivedDocumentStore({
      settings: { describe: () => Promise.resolve(response(true)) },
    }, script)
    await controller.load()
    await controller.open()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', opening: false, error: 'no session is mounted for the document preview',
    })
    expect(script.calls.locate).toBe(0)
    expect(script.calls.close).toBe(0)
    expect(script.calls.reveal).toEqual([])
  })

  it('collapses concurrent open gestures into one locate/close/reveal', async () => {
    let settle!: (document: SettingsDocumentLocation) => void
    const script = scriptedView({
      sessionId: SESSION,
      locate: () => new Promise<SettingsDocumentLocation>((resolve) => { settle = resolve }),
    })
    const controller = derivedDocumentStore({
      settings: { describe: () => Promise.resolve(response(true)) },
    }, script)
    await controller.load()
    const first = controller.open()
    const second = controller.open()
    expect(script.calls.locate).toBe(1)
    settle(DOCUMENT)
    await Promise.all([first, second])
    expect(script.calls.close).toBe(1)
    expect(script.calls.reveal).toHaveLength(1)
  })

  it('recovers availability via a mirror refresh after a failed first read', async () => {
    // A first read that failed leaves the action unavailable with the miss
    // recorded; the mirror's next refresh (a commit or reconnect) recovers it.
    const ctx = {
      remote: {
        settings: {
          describe: vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(response(true)),
        },
      },
    } as never
    const mirror = new SettingsDescribeMirror(ctx)
    const caught = new SettingsDocumentStore(mirror, scriptedView({ sessionId: SESSION }).view)
    await caught.load()
    expect(caught.store.getSnapshot()).toMatchObject({ status: 'unavailable', error: 'offline' })
    await mirror.load()
    expect(caught.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
  })
})
