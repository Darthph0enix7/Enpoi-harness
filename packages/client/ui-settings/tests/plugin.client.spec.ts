import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { SettingsSchemaService } from '../src/client/schema.ts'
import { ConfigForms } from '../src/client/config-form.ts'

function bench() {
  const describeCall = vi.fn().mockResolvedValue({
    ok: true, value: { writable: true, hasDocument: true, namespaces: [] },
  })
  const ctx = new Context()
  const remote = new TestRemote(ctx, { settings: { describe: describeCall } })
  return { ctx, describeCall, remote, fiber: ctx.plugin({ inject: [...inject], apply }) }
}

describe('settings domain base plugin', () => {
  it('mounts the scope service under configForms and reads once eagerly', async () => {
    const { ctx, describeCall, fiber } = bench()
    await fiber.await()
    expect(ctx.get('configForms')).toBeInstanceOf(ConfigForms)
    expect(ctx.get('settingsSchema')).toBeInstanceOf(SettingsSchemaService)
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(1) })
  })

  it('refreshes the mirror on document commits and connection resets, once each', async () => {
    const { ctx, describeCall, remote, fiber } = bench()
    await fiber.await()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(1) })
    remote.emit('settings/document-updated', ['ui-test', 0])
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(2) })
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(3) })
  })

  it('skips the document read for the revision its own write folded', async () => {
    const namespace = (revision: number) => ({
      ns: 'ui-test',
      schema: JSON.parse(JSON.stringify({ type: 'object', properties: {} })),
      value: {},
      autoGenerate: true,
      applies: 'live',
      secrets: [],
      revision,
    })
    const describeCall = vi.fn().mockResolvedValue({
      ok: true,
      value: { writable: true, hasDocument: true, namespaces: [namespace(3)] },
    })
    const mutate = vi.fn().mockResolvedValue({
      ok: true,
      value: namespace(4),
    })
    const ctx = new Context()
    const remote = new TestRemote(ctx, { settings: { describe: describeCall, mutate } })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(1) })

    // The client's own write folds revision 4; its echo needs no read — one
    // 926 KB body per client is pure fan-out cost.
    const form = ctx.get('configForms')!.get('ui-test')
    await form.set('field', 'value')
    remote.emit('settings/document-updated', ['ui-test', 4])
    await Promise.resolve()
    expect(describeCall).toHaveBeenCalledTimes(1)

    // Another client's commit: the fold does not cover it, so the mirror reads.
    remote.emit('settings/document-updated', ['ui-test', 5])
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(2) })
    await fiber.dispose()
  })

  it('fiber disposal retires the service and its invalidation subscriptions', async () => {
    const { ctx, describeCall, remote, fiber } = bench()
    await fiber.await()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(1) })
    await fiber.dispose()
    expect(ctx.get('configForms')).toBeUndefined()
    expect(ctx.get('settingsSchema')).toBeUndefined()
    remote.emit('settings/document-updated', ['ui-test', 0])
    ctx.emit('connection/reset')
    await Promise.resolve()
    expect(describeCall).toHaveBeenCalledTimes(1)
  })
})
