// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionLogDownloadController } from '../src/client/controller.ts'
import { SessionLogGlobalOverlay } from '../src/client/Dialog.tsx'
import type { SessionLogGlobalOverlayProps } from '../src/client/Dialog.tsx'
import { en } from '../src/client/locales.ts'

const SID = 'session-export-overlay' as SessionId

function bindSessionExport(controller: SessionLogDownloadController) {
  return function useSessionLogDownload<T>(selector: (state: ReturnType<typeof controller.store.getSnapshot>) => T): T {
    return useSyncExternalStore(
      listener => controller.store.subscribe(listener),
      () => selector(controller.store.getSnapshot()),
    )
  }
}

function bench() {
  const controller = new SessionLogDownloadController(async () => new Response('zip'), vi.fn())
  const dismiss = vi.fn((sessionId: SessionId) => { controller.dismiss(sessionId) })
  const useSessionLogDownload = bindSessionExport(controller)
  const props = {
    useSessionLogDownload,
    dismiss,
    t: (key: keyof typeof en): string => en[key],
  } as unknown as SessionLogGlobalOverlayProps
  const view = render(<SessionLogGlobalOverlay {...props} />)
  return { controller, dismiss, view }
}

afterEach(cleanup)

describe('Session export Global Overlay', () => {
  it('mounts clean and responds to download state changes', async () => {
    const b = bench()
    expect(b.view.container).toBeDefined()
    void b.controller.download(SID)
    await vi.waitFor(() => {
      expect(b.controller.store.getSnapshot().bySession[SID]?.status).toBe('success')
    })
  })
})
