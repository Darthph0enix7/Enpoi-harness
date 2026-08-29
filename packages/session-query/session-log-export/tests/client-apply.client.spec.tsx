import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { SessionLogGlobalOverlay } from '../src/client/Dialog.tsx'
import { apply, inject } from '../src/client/index.ts'

const SID = 'session-export-apply' as SessionId

afterEach(() => { vi.unstubAllGlobals() })

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declaration = declare(slots)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, slots, declaration, fiber }
}

describe('session-log-download browser plugin', () => {
  it('provides one controller and mounts its overlay contribution', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const b = await bench()
    expect(inject).toEqual(['slots', 'locale'])
    expect(b.ctx.sessionLogDownload).toBeDefined()
    const entry = b.slots.entries('shell.overlay')[0]
    expect(entry?.component).toBe(SessionLogGlobalOverlay)
    expect(entry?.options).toMatchObject({ id: 'session-log-download-overlay' })
    const injected = (entry?.inject as unknown as () => import('../src/client/Dialog.tsx').SessionLogGlobalOverlayInjected)()
    b.ctx.sessionLogDownload.download(SID)
    await vi.waitFor(() => {
      expect(b.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.status).toBe('error')
    })
    injected.dismiss(SID)
    expect(b.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.open).toBe(false)

    await b.fiber.dispose()
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('downloads only for an export execution acknowledged by this browser client', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const first = await bench()
    const second = await bench()

    first.ctx.emit('command/executed', SID, 'plan', { kind: 'success' })
    expect(fetcher).not.toHaveBeenCalled()
    first.ctx.emit('command/executed', SID, 'export', { kind: 'error', text: 'bad path' })
    expect(fetcher).not.toHaveBeenCalled()
    first.ctx.emit('command/executed', SID, 'export', { kind: 'success' })
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledOnce()
      expect(first.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]?.status).toBe('error')
    })
    expect(second.ctx.sessionLogDownload.store.getSnapshot().bySession[SID]).toBeUndefined()

    await first.fiber.dispose()
    await second.fiber.dispose()
  })

  it('re-registers after the declaring shell.overlay slot collapses and returns', async () => {
    const b = await bench()
    b.declaration()
    expect(b.slots.entries('shell.overlay')).toHaveLength(0)
    const redeclare = declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('shell.overlay')[0]?.component).toBe(SessionLogGlobalOverlay)
    redeclare()
    await b.fiber.dispose()
  })
})
