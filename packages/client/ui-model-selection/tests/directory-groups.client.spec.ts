/**
 * `ModelDirectory.select` group-id handling: the id is carried to the host and
 * a host that refuses the unknown field is retried without it, so the concrete
 * provider/model selection still applies. The settled state is the durable
 * selection projection's (the same source the picker labels from), so the fake
 * projection echoes whatever the host accepted.
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ModelDirectory } from '../src/client/directory.ts'
import type { ModelCatalogDirectory } from '../src/client/catalog.ts'

const SESSION = SessionId('session-1')

interface Fake {
  directory: ModelDirectory
  selectModel: ReturnType<typeof vi.fn>
  setProjected(next: unknown): void
}

function fakeDirectory(selectModel: ReturnType<typeof vi.fn>): Fake {
  let projectedValue: unknown = {}
  const catalog = {
    store: {
      getSnapshot: () => ({
        status: 'ready',
        value: {
          default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          routableProviders: ['deepseek-official'],
          groups: [],
          failures: [],
        },
        error: null,
      }),
      subscribe: () => () => {},
    },
    load: async () => {},
    // The directory reads the adapter's reasoning levels for the retained label.
    reasoningFor: () => undefined,
  } as unknown as ModelCatalogDirectory
  const projected = {
    getSnapshot: () => projectedValue,
    subscribe: () => () => {},
  }
  const directory = new ModelDirectory(
    { selectModel } as never,
    SESSION,
    () => true,
    catalog,
    projected as never,
  )
  return {
    directory,
    selectModel,
    setProjected: (next) => { projectedValue = next },
  }
}

const ANTI = { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' }

describe('ModelDirectory group selections', () => {
  it('carries the group id in the request', async () => {
    const selectModel = vi.fn(async (args: { chain?: string }) => {
      // The durable fold echoes the accepted selection, chain included.
      return {
        ok: true as const,
        value: { selected: { provider: ANTI.provider, model: ANTI.model, ...args.chain === undefined ? {} : { chain: args.chain } } },
      }
    })
    const { directory } = fakeDirectory(selectModel)

    await directory.select({ ...ANTI, chain: 'stable' })

    expect(selectModel).toHaveBeenCalledTimes(1)
    expect(selectModel).toHaveBeenCalledWith({ sessionId: SESSION, ...ANTI, chain: 'stable' })
    expect(directory.store.getSnapshot().status).toBe('ready')
  })

  it('retries without the group id when the host refuses the unknown field', async () => {
    const selectModel = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'invalid/request', message: 'unknown field chain' } })
      .mockResolvedValueOnce({ ok: true, value: { selected: ANTI } })
    const { directory, setProjected } = fakeDirectory(selectModel)
    setProjected({ next: ANTI })

    const result = await directory.select({ ...ANTI, chain: 'stable' })

    expect(result).toEqual({ ok: true, value: undefined })
    expect(selectModel).toHaveBeenCalledTimes(2)
    expect(selectModel.mock.calls[0]?.[0]).toMatchObject({ chain: 'stable' })
    expect(selectModel.mock.calls[1]?.[0]).not.toHaveProperty('chain')
    expect(directory.store.getSnapshot().current).toEqual(ANTI)
    expect(directory.store.getSnapshot().status).toBe('ready')
  })

  it('keeps the group id on the settled selection when the host echoes it', async () => {
    const selectModel = vi.fn(async () => ({ ok: true as const, value: { selected: ANTI } }))
    const { directory, setProjected } = fakeDirectory(selectModel)
    setProjected({ next: { ...ANTI, chain: 'stable' } })

    await directory.select({ ...ANTI, chain: 'stable' })

    expect(directory.store.getSnapshot().current).toEqual({ ...ANTI, chain: 'stable' })
  })

  it('rolls back the optimistic group selection when both attempts fail', async () => {
    const selectModel = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'invalid/request', message: 'unknown field chain' } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'settings/read-only', message: 'no' } })
    const { directory } = fakeDirectory(selectModel)

    const result = await directory.select({ ...ANTI, chain: 'stable' })

    expect(result.ok).toBe(false)
    expect(directory.store.getSnapshot().current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(directory.store.getSnapshot().status).toBe('error')
  })
})
