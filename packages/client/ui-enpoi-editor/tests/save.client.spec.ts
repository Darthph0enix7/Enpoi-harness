/**
 * Optimistic save handling: the digest last read from disk rides the write,
 * an explicit force flag performs the conflict flow's Overwrite while the
 * route keeps its backup duty, a 409 raises the conflict banner without
 * touching the buffer, and a beside-write is create-only.
 */
import { describe, expect, it } from 'vitest'
import { createFsOps } from '../src/client/fsops.ts'
import { completeSave, saveBesideOnce, saveOnce } from '../src/client/machine.ts'
import { createEditorStore } from '../src/client/store.ts'
import { errorValue, fakeFsOpsServer, statValue } from './fixtures.client.ts'

const ADDRESS = 'dsh-resource://file/session/session-1/notes.md'
const SESSION = 'session-1'
const PATH = 'notes.md'

/** The SHA-256 of `hello`, the content every case below writes. */
const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

describe('saveOnce', () => {
  it('writes with the digest last read from disk and records the ack', async () => {
    const server = fakeFsOpsServer({
      'fs.write': () => ({ status: 200, body: { ok: true, value: { sha256: 'sha-new', mtimeMs: 20, size: 6 } } }),
    })
    const store = createEditorStore().create()
    store.actions.attach(ADDRESS, 'tab-1')
    store.actions.synced(ADDRESS, { content: 'hello', sha256: 'sha-old', mtimeMs: 10, size: 5, truncated: false })
    store.actions.edited(ADDRESS, 'hello!')
    const outcome = await saveOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      content: 'hello!',
      expectedSha: 'sha-old',
      force: false,
    })
    expect(outcome).toEqual({ kind: 'saved', sha256: 'sha-new', mtimeMs: 20, size: 6 })
    expect(server.calls[0]?.payload).toEqual({ sessionId: SESSION, path: PATH, content: 'hello!', expectedSha: 'sha-old' })
    store.actions.saving(ADDRESS)
    const baseline = outcome.kind === 'saved'
      ? { sha256: outcome.sha256, mtimeMs: outcome.mtimeMs, size: outcome.size }
      : { sha256: undefined, mtimeMs: undefined, size: undefined }
    store.actions.saved(ADDRESS, 'hello!', baseline, undefined)
    const state = store.getSnapshot().byAddress[ADDRESS]
    expect(state?.draft).toBeNull()
    expect(state?.dirty).toBe(false)
    expect(state?.content).toBe('hello!')
    expect(state?.sha256).toBe('sha-new')
    expect(state?.mtimeMs).toBe(20)
    expect(state?.saveState).toBe('saved')
    expect(state?.savedAt).not.toBeNull()
  })

  it('reports a 409 as a conflict and keeps the buffer', async () => {
    const server = fakeFsOpsServer({
      'fs.write': () => ({ status: 409, body: errorValue('conflict', 'file changed on disk since it was read') }),
    })
    const store = createEditorStore().create()
    store.actions.attach(ADDRESS, 'tab-1')
    store.actions.synced(ADDRESS, { content: 'hello', sha256: 'sha-old', mtimeMs: 10, size: 5, truncated: false })
    store.actions.edited(ADDRESS, 'my buffer')
    const outcome = await saveOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      content: 'my buffer',
      expectedSha: 'sha-old',
      force: false,
    })
    expect(outcome).toEqual({ kind: 'conflict' })
    store.actions.conflicted(ADDRESS)
    const state = store.getSnapshot().byAddress[ADDRESS]
    expect(state?.banner).toBe('conflict')
    expect(state?.draft).toBe('my buffer')
    expect(state?.dirty).toBe(true)
    expect(state?.sha256).toBe('sha-old')
  })

  it('sends the explicit force flag on the Overwrite retry, digest omitted', async () => {
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
    expect(server.calls[0]?.payload).toEqual({ sessionId: SESSION, path: PATH, content: 'my buffer', force: true })
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

describe('saveBesideOnce', () => {
  it('writes <file>.mine-<timestamp> create-only and reports the copy path', async () => {
    const server = fakeFsOpsServer({
      'fs.write': () => ({ status: 200, body: { ok: true, value: { sha256: 'sha-copy', mtimeMs: 20, size: 9 } } }),
    })
    const outcome = await saveBesideOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      content: 'my buffer',
    })
    expect(outcome.kind).toBe('saved')
    if (outcome.kind !== 'saved') return
    expect(outcome.path).toMatch(/^notes\.md\.mine-\d+$/)
    expect(outcome.sha256).toBe('sha-copy')
    expect(server.calls[0]?.payload).toEqual({
      sessionId: SESSION,
      path: outcome.path,
      content: 'my buffer',
      expectedSha: null,
    })
  })

  it('maps the create-only 409 to exists with the attempted path', async () => {
    const server = fakeFsOpsServer({
      'fs.write': () => ({ status: 409, body: errorValue('exists', 'already exists') }),
    })
    const outcome = await saveBesideOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      content: 'my buffer',
    })
    expect(outcome).toEqual({ kind: 'exists', path: expect.stringMatching(/^notes\.md\.mine-\d+$/) })
  })

  it('reports a transport failure as failed', async () => {
    const server = fakeFsOpsServer({
      'fs.write': () => ({ status: 400, body: errorValue('fs-error', 'denied') }),
    })
    const outcome = await saveBesideOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      content: 'my buffer',
    })
    expect(outcome).toEqual({ kind: 'failed', code: 'fs-error', message: 'denied' })
  })
})

describe('save bookkeeping', () => {
  it('keeps the buffer dirty when keystrokes landed during the save round-trip', () => {
    const store = createEditorStore().create()
    store.actions.attach(ADDRESS, 'tab-1')
    store.actions.synced(ADDRESS, { content: 'hello', sha256: 'sha-old', mtimeMs: 10, size: 5, truncated: false })
    store.actions.edited(ADDRESS, 'hello!')
    // The write carried `hello!`; by its settlement the reader had typed `hello!!`.
    store.actions.saving(ADDRESS)
    store.actions.saved(ADDRESS, 'hello!', { sha256: 'sha-new', mtimeMs: 20, size: 7 }, 'hello!!')
    const state = store.getSnapshot().byAddress[ADDRESS]
    expect(state?.content).toBe('hello!')
    expect(state?.sha256).toBe('sha-new')
    expect(state?.draft).toBe('hello!!')
    expect(state?.dirty).toBe(true)
    expect(state?.saveState).toBe('saved')
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
