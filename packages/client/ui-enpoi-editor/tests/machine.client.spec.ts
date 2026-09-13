/**
 * The editor state machine over a fake `/sidebar/fsops` transport: load,
 * external-change polling, the keystroke-loss guard, and the store transitions
 * each outcome drives. The fake exercises the real fsops client, so the request
 * payloads and error-envelope mapping are covered too.
 */
import { describe, expect, it } from 'vitest'
import { createFsOps, FsOpsError } from '../src/client/fsops.ts'
import { loadOnce, pollOnce } from '../src/client/machine.ts'
import { createEditorStore } from '../src/client/store.ts'
import { errorValue, fakeFsOpsServer, readValue, statValue } from './fixtures.client.ts'

const TAB = 'tab-1'
const SESSION = 'session-1'
const PATH = 'notes.md'

describe('loadOnce', () => {
  it('reads through the fenced route and reports the snapshot', async () => {
    const server = fakeFsOpsServer({ 'fs.read': () => ({ status: 200, body: readValue('hello', 'sha-1', 10, 5) }) })
    const outcome = await loadOnce(createFsOps(server.fetch), SESSION, PATH)
    expect(outcome).toEqual({
      kind: 'loaded',
      snapshot: { content: 'hello', sha256: 'sha-1', mtimeMs: 10, size: 5, truncated: false },
    })
    expect(server.calls).toEqual([{ method: 'fs.read', payload: { sessionId: SESSION, path: PATH } }])
  })

  it('maps 404 not-found to the missing state', async () => {
    const server = fakeFsOpsServer({ 'fs.read': () => ({ status: 404, body: errorValue('not-found', 'gone') }) })
    expect(await loadOnce(createFsOps(server.fetch), SESSION, PATH)).toEqual({ kind: 'missing' })
  })

  it('reports a transport failure as a failed outcome', async () => {
    const offline = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
    expect(await loadOnce(createFsOps(offline), SESSION, PATH))
      .toEqual({ kind: 'failed', code: 'network', message: 'offline' })
  })
})

describe('external-change polling', () => {
  it('reports an unchanged stat without reading', async () => {
    const server = fakeFsOpsServer({ 'fs.stat': () => ({ status: 200, body: statValue(1000, 5) }) })
    const outcome = await pollOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      baseline: { mtimeMs: 1000, size: 5 },
      dirty: false,
      truncated: false,
      revision: 0,
      currentRevision: () => 0,
    })
    expect(outcome).toEqual({ kind: 'unchanged' })
    expect(server.calls.map(call => call.method)).toEqual(['fs.stat'])
  })

  it('re-reads and swaps when the file changed under a clean buffer', async () => {
    const server = fakeFsOpsServer({
      'fs.stat': () => ({ status: 200, body: statValue(2000, 11) }),
      'fs.read': () => ({ status: 200, body: readValue('new content', 'sha-2', 2000, 11) }),
    })
    const outcome = await pollOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      baseline: { mtimeMs: 1000, size: 5 },
      dirty: false,
      truncated: false,
      revision: 4,
      currentRevision: () => 4,
    })
    expect(outcome).toEqual({
      kind: 'swap',
      snapshot: { content: 'new content', sha256: 'sha-2', mtimeMs: 2000, size: 11, truncated: false },
    })
    expect(server.calls.map(call => call.method)).toEqual(['fs.stat', 'fs.read'])
  })

  it('raises the banner without reading or clobbering a dirty buffer', async () => {
    const server = fakeFsOpsServer({ 'fs.stat': () => ({ status: 200, body: statValue(2000, 11) }) })
    const store = createEditorStore().create()
    store.actions.loading(TAB)
    store.actions.synced(TAB, { content: 'hello', sha256: 'sha-1', mtimeMs: 1000, size: 5, truncated: false })
    store.actions.edited(TAB, 'my buffer')
    const outcome = await pollOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      baseline: { mtimeMs: 1000, size: 5 },
      dirty: true,
      truncated: false,
      revision: 1,
      currentRevision: () => 1,
    })
    expect(outcome).toEqual({ kind: 'banner' })
    expect(server.calls.map(call => call.method)).toEqual(['fs.stat'])
    store.actions.changed(TAB)
    const state = store.getSnapshot().byTab[TAB]
    expect(state?.banner).toBe('external-change')
    expect(state?.draft).toBe('my buffer')
    expect(state?.dirty).toBe(true)
  })

  it('aborts the swap when a keystroke lands during the read await', async () => {
    const server = fakeFsOpsServer({
      'fs.stat': () => ({ status: 200, body: statValue(2000, 11) }),
      'fs.read': () => ({ status: 200, body: readValue('new content', 'sha-2', 2000, 11) }),
    })
    const outcome = await pollOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      baseline: { mtimeMs: 1000, size: 5 },
      dirty: false,
      truncated: false,
      revision: 4,
      currentRevision: () => 5,
    })
    expect(outcome).toEqual({ kind: 'banner' })
  })

  it('reports a vanished file as missing while a dirty buffer stays in the store', async () => {
    const server = fakeFsOpsServer({ 'fs.stat': () => ({ status: 404, body: errorValue('not-found', 'gone') }) })
    const store = createEditorStore().create()
    store.actions.synced(TAB, { content: 'hello', sha256: 'sha-1', mtimeMs: 1000, size: 5, truncated: false })
    store.actions.edited(TAB, 'my buffer')
    const outcome = await pollOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      baseline: { mtimeMs: 1000, size: 5 },
      dirty: true,
      truncated: false,
      revision: 1,
      currentRevision: () => 1,
    })
    expect(outcome).toEqual({ kind: 'missing' })
    store.actions.missing(TAB)
    const state = store.getSnapshot().byTab[TAB]
    expect(state?.status).toBe('missing')
    expect(state?.draft).toBe('my buffer')
    expect(state?.dirty).toBe(true)
    expect(state?.content).toBe('hello')
  })

  it('never reads a truncated buffer on change; it raises the banner instead', async () => {
    const server = fakeFsOpsServer({ 'fs.stat': () => ({ status: 200, body: statValue(2000, 900) }) })
    const outcome = await pollOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      baseline: { mtimeMs: 1000, size: 800 },
      dirty: false,
      truncated: true,
      revision: 0,
      currentRevision: () => 0,
    })
    expect(outcome).toEqual({ kind: 'banner' })
    expect(server.calls.map(call => call.method)).toEqual(['fs.stat'])
  })

  it('reports a stat failure other than not-found as a failed outcome', async () => {
    const server = fakeFsOpsServer({ 'fs.stat': () => ({ status: 400, body: errorValue('fs-error', 'cannot stat') }) })
    const outcome = await pollOnce({
      fs: createFsOps(server.fetch),
      sessionId: SESSION,
      path: PATH,
      baseline: { mtimeMs: 1000, size: 5 },
      dirty: false,
      truncated: false,
      revision: 0,
      currentRevision: () => 0,
    })
    expect(outcome).toEqual({ kind: 'failed', code: 'fs-error', message: 'cannot stat' })
  })
})

describe('fsops client', () => {
  it('flags an error envelope by its status as well as its code', () => {
    expect(new FsOpsError('conflict', 'changed', 409).conflict).toBe(true)
    expect(new FsOpsError('http', 'changed', 409).conflict).toBe(true)
    expect(new FsOpsError('not-found', 'gone', 404).notFound).toBe(true)
    expect(new FsOpsError('http', 'gone', 404).notFound).toBe(true)
    expect(new FsOpsError('fs-error', 'x', 400).conflict).toBe(false)
  })
})
