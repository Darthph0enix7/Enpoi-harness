/**
 * Optimistic save handling: the digest last read from disk rides the write,
 * a 409 raises the conflict banner without touching the buffer, and Overwrite
 * retries with no expected digest.
 */
import { describe, expect, it } from 'vitest'
import { createFsOps } from '../src/client/fsops.ts'
import { completeSave, saveOnce } from '../src/client/machine.ts'
import { createEditorStore } from '../src/client/store.ts'
import { errorValue, fakeFsOpsServer, statValue } from './fixtures.client.ts'

const TAB = 'tab-1'
const SESSION = 'session-1'
const PATH = 'notes.md'

/** The SHA-256 of `hello`, the content every case below writes. */
const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

describe('saveOnce', () => {
  it('writes with the digest last read from disk and records the ack', async () => {
    const server = fakeFsOpsServer({
      'fs.write': () => ({ status: 200, body: { ok: true, value: { sha256: 'sha-new', mtimeMs: 20, size: 5 } } }),
    })
    const store = createEditorStore().create()
    store.actions.synced(TAB, { content: 'hello', sha256: 'sha-old', mtimeMs: 10, size: 5, truncated: false })
    store.actions.edited(TAB, 'hello!')
    const outcome = await saveOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      content: 'hello!',
      expectedSha: 'sha-old',
      force: false,
    })
    expect(outcome).toEqual({ kind: 'saved', sha256: 'sha-new', mtimeMs: 20, size: 5 })
    expect(server.calls[0]?.payload).toEqual({ sessionId: SESSION, path: PATH, content: 'hello!', expectedSha: 'sha-old' })
    store.actions.saving(TAB)
    store.actions.saved(TAB, 'hello!', { sha256: outcome.kind === 'saved' ? outcome.sha256 : undefined, mtimeMs: 20, size: 5 })
    const state = store.getSnapshot().byTab[TAB]
    expect(state?.draft).toBeNull()
    expect(state?.dirty).toBe(false)
    expect(state?.content).toBe('hello!')
    expect(state?.sha256).toBe('sha-new')
    expect(state?.mtimeMs).toBe(20)
    expect(state?.saveState).toBe('saved')
  })

  it('reports a 409 as a conflict and keeps the buffer', async () => {
    const server = fakeFsOpsServer({
      'fs.write': () => ({ status: 409, body: errorValue('conflict', 'file changed on disk since it was read') }),
    })
    const store = createEditorStore().create()
    store.actions.synced(TAB, { content: 'hello', sha256: 'sha-old', mtimeMs: 10, size: 5, truncated: false })
    store.actions.edited(TAB, 'my buffer')
    const outcome = await saveOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      content: 'my buffer',
      expectedSha: 'sha-old',
      force: false,
    })
    expect(outcome).toEqual({ kind: 'conflict' })
    store.actions.conflicted(TAB)
    const state = store.getSnapshot().byTab[TAB]
    expect(state?.banner).toBe('conflict')
    expect(state?.draft).toBe('my buffer')
    expect(state?.dirty).toBe(true)
    expect(state?.sha256).toBe('sha-old')
  })

  it('omits expectedSha on the forced Overwrite retry', async () => {
    const server = fakeFsOpsServer({
      'fs.write': () => ({ status: 200, body: { ok: true, value: { sha256: 'sha-forced', mtimeMs: 30, size: 9 } } }),
    })
    const outcome = await saveOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      content: 'my buffer',
      expectedSha: 'sha-old',
      force: true,
    })
    expect(outcome.kind).toBe('saved')
    expect(server.calls[0]?.payload).toEqual({ sessionId: SESSION, path: PATH, content: 'my buffer' })
  })

  it('reports a non-conflict write failure as failed', async () => {
    const server = fakeFsOpsServer({
      'fs.write': () => ({ status: 400, body: errorValue('fs-error', 'cannot write') }),
    })
    const outcome = await saveOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      content: 'x',
      expectedSha: 'sha-old',
      force: false,
    })
    expect(outcome).toEqual({ kind: 'failed', code: 'fs-error', message: 'cannot write' })
  })
})

describe('completeSave', () => {
  it('derives the digest locally and stats for the rest when the ack is bare', async () => {
    const server = fakeFsOpsServer({
      'fs.write': () => ({ status: 200, body: { ok: true, value: {} } }),
      'fs.stat': () => ({ status: 200, body: statValue(3000, 5) }),
    })
    const baseline = await completeSave(
      createFsOps(server.fetch),
      SESSION,
      PATH,
      'hello',
      { sha256: undefined, mtimeMs: undefined, size: undefined },
    )
    expect(baseline).toEqual({ sha256: HELLO_SHA, mtimeMs: 3000, size: 5 })
    expect(server.calls.map(call => call.method)).toEqual(['fs.stat'])
  })

  it('keeps unknown fields undefined when the follow-up stat also fails', async () => {
    const server = fakeFsOpsServer({
      'fs.stat': () => ({ status: 404, body: errorValue('not-found', 'gone') }),
    })
    const baseline = await completeSave(
      createFsOps(server.fetch),
      SESSION,
      PATH,
      'hello',
      { sha256: 'sha-known', mtimeMs: undefined, size: undefined },
    )
    expect(baseline.sha256).toBe('sha-known')
    expect(baseline.mtimeMs).toBeUndefined()
    expect(baseline.size).toBeUndefined()
  })
})
