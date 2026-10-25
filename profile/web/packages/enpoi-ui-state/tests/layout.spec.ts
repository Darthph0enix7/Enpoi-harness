/**
 * The host-wide layout record: the column widths are stored beside the
 * per-session UI state, keyed once per host, and the Remote boundary rejects a
 * width that could not describe a frame.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { EnpoiUiStateService, LAYOUT_KEY, requireLayoutWidths } from '../src/index.ts'

/** One in-memory per-record domain table, enough for the service's read/write path. */
type Row = Map<string, unknown>

interface Fixture {
  ctx: Context
  service: EnpoiUiStateService
  tables: Map<string, Row>
}

/** Open a service over a fresh in-memory `ui_state` domain. */
async function openService(): Promise<Fixture> {
  const tables = new Map<string, Row>([
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
  return { ctx, service, tables }
}

const widths = { sidebar: 360, rightbar: { px: 720, ratio: 0.375 } }

beforeEach(() => { /* each case opens its own context */ })

describe('requireLayoutWidths', () => {
  it('accepts a record with and without a right panel width', () => {
    expect(requireLayoutWidths(widths)).toEqual(widths)
    expect(requireLayoutWidths({ sidebar: 0 })).toEqual({ sidebar: 0 })
    expect(requireLayoutWidths({ sidebar: 280.4, rightbar: { px: 500.6, ratio: 0.3 } }))
      .toEqual({ sidebar: 280, rightbar: { px: 501, ratio: 0.3 } })
  })

  it('rejects a record that could not describe a frame', () => {
    expect(() => requireLayoutWidths(null)).toThrow('layout widths must be an object')
    expect(() => requireLayoutWidths([])).toThrow('layout widths must be an object')
    expect(() => requireLayoutWidths({})).toThrow('layout.sidebar must be a finite number')
    expect(() => requireLayoutWidths({ sidebar: -1 })).toThrow('layout.sidebar must be a non-negative width')
    expect(() => requireLayoutWidths({ sidebar: 30_000 })).toThrow('layout.sidebar must be a non-negative width')
    expect(() => requireLayoutWidths({ sidebar: 280, rightbar: 'wide' })).toThrow('layout.rightbar must be an object')
    expect(() => requireLayoutWidths({ sidebar: 280, rightbar: { ratio: 0.3 } })).toThrow('layout.rightbar.px must be a finite number')
    expect(() => requireLayoutWidths({ sidebar: 280, rightbar: { px: 0, ratio: 0.3 } })).toThrow('layout.rightbar.px must be a positive width')
    expect(() => requireLayoutWidths({ sidebar: 280, rightbar: { px: 500, ratio: 0 } })).toThrow('layout.rightbar.ratio')
    expect(() => requireLayoutWidths({ sidebar: 280, rightbar: { px: 500, ratio: 1.5 } })).toThrow('layout.rightbar.ratio')
  })
})

describe('layout record', () => {
  it('answers "nothing stored" before the first write', async () => {
    const { service } = await openService()
    expect(await service.getLayout()).toEqual({ sidebar: 0, updatedAt: 0 })
  })

  it('stores the widths once per host and stamps the write', async () => {
    const { service, tables } = await openService()
    const written = await service.putLayout(widths)
    expect(written.ok).toBe(true)
    expect(written.updatedAt).toBeGreaterThan(0)
    expect(tables.get('layout')?.get(LAYOUT_KEY)).toEqual({ ...widths, updatedAt: written.updatedAt })
    expect(await service.getLayout()).toEqual({ ...widths, updatedAt: written.updatedAt })
  })

  it('replaces the record wholesale, so a cleared right width stays cleared', async () => {
    const { service } = await openService()
    await service.putLayout(widths)
    await service.putLayout({ sidebar: 280 })
    const stored = await service.getLayout()
    expect(stored.sidebar).toBe(280)
    expect(stored).not.toHaveProperty('rightbar')
  })

  it('serializes concurrent writes and keeps the last one', async () => {
    const { service } = await openService()
    await Promise.all([
      service.putLayout({ sidebar: 320, rightbar: { px: 650, ratio: 0.34 } }),
      service.putLayout({ sidebar: 340, rightbar: { px: 700, ratio: 0.36 } }),
    ])
    const stored = await service.getLayout()
    expect(stored).toMatchObject({ sidebar: 340, rightbar: { px: 700, ratio: 0.36 } })
  })

  it('leaves the per-session records independent of the layout record', async () => {
    const { service } = await openService()
    await service.put('session-a', { surface: { layout: {} } })
    expect(await service.getLayout()).toEqual({ sidebar: 0, updatedAt: 0 })
    await service.putLayout(widths)
    expect(await service.get('session-a')).toMatchObject({ surface: { layout: {} } })
  })
})
