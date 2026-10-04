// fsops-read-write.spec.ts — vitest suite for the fs.read / fs.write routes.
// Drives the fenced /sidebar/fsops handler end to end against a temp workspace
// and a temp HOME (so editor backups land in an isolated, disposable store).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { apply } from '../src/index'

type Handler = (req: unknown, res: unknown) => Promise<void>

interface CallOptions {
  host?: string
  contentType?: string
}

interface Harness {
  call: (method: string, payload: unknown, opts?: CallOptions) => Promise<{ status: number; body: any }>
}

function makeHarness(): Harness {
  let handler: Handler | undefined
  const ctx = {
    get(name: string) {
      if (name === 'webServer') {
        return {
          register: (spec: { handler: Handler }) => {
            handler = spec.handler
            return () => {}
          },
        }
      }
      if (name === 'sessions') return { get: () => undefined }
      if (name === 'webRuntime') return { trustedHosts: [] as string[] }
      return undefined
    },
    effect: (fn: () => unknown) => fn(),
  }
  apply(ctx as never, {})
  if (handler === undefined) throw new Error('fsops handler was not registered')
  return {
    call: async (method, payload, opts = {}) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      const req = {
        headers: {
          host: opts.host ?? 'localhost:4096',
          'content-type': opts.contentType ?? 'application/json',
        },
        method: 'POST',
        url: `/sidebar/fsops/${method}`,
        async *[Symbol.asyncIterator]() {
          yield body
        },
      }
      let status = 0
      let text = ''
      const res = {
        writeHead: (s: number) => {
          status = s
        },
        end: (t: string) => {
          text = t
        },
      }
      await handler!(req, res)
      return { status, body: JSON.parse(text) }
    },
  }
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const backupPath = (hash: string): string => join(home, '.dsh', 'file-history', 'editor', hash)
const backupDir = (): string => join(home, '.dsh', 'file-history', 'editor')

let root: string
let home: string
let ws: string
let harness: Harness

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fsops-'))
  home = join(root, 'home')
  ws = join(root, 'ws')
  await mkdir(home, { recursive: true })
  await mkdir(ws, { recursive: true })
  process.env.HOME = home
  harness = makeHarness()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('fs.read', () => {
  it('round-trips text content with the full-file sha256', async () => {
    const file = join(ws, 'a.txt')
    await writeFile(file, 'hello\nworld\n')
    const { status, body } = await harness.call('fs.read', { cwd: ws, path: file })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value.content).toBe('hello\nworld\n')
    expect(body.value.sha256).toBe(sha('hello\nworld\n'))
    expect(body.value.size).toBe(Buffer.byteLength('hello\nworld\n'))
    expect(body.value.truncated).toBe(false)
    expect(body.value.mtimeMs).toBeGreaterThan(0)
  })

  it('refuses NUL-byte binaries with not-text', async () => {
    const file = join(ws, 'bin.dat')
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]))
    const { status, body } = await harness.call('fs.read', { cwd: ws, path: file })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('not-text')
  })

  it('refuses invalid UTF-8 with not-text', async () => {
    const file = join(ws, 'bad.txt')
    await writeFile(file, Buffer.from([0x68, 0x69, 0xff, 0xfe, 0xfd]))
    const { status, body } = await harness.call('fs.read', { cwd: ws, path: file })
    expect(status).toBe(400)
    expect(body.error.code).toBe('not-text')
  })

  it('flags >4 MiB files as truncated and still returns the full-file sha', async () => {
    const full = Buffer.alloc(4 * 1024 * 1024 + 37, 0x61)
    const file = join(ws, 'big.txt')
    await writeFile(file, full)
    const { status, body } = await harness.call('fs.read', { cwd: ws, path: file })
    expect(status).toBe(200)
    expect(body.value.truncated).toBe(true)
    expect(body.value.content.length).toBe(4 * 1024 * 1024)
    expect(body.value.size).toBe(full.length)
    expect(body.value.sha256).toBe(sha(full))
  })

  it('404s a missing file with code not-found', async () => {
    const { status, body } = await harness.call('fs.read', { cwd: ws, path: join(ws, 'nope.txt') })
    expect(status).toBe(404)
    expect(body.error.code).toBe('not-found')
  })
})

describe('fs.write', () => {
  it('force-writes with a pre-overwrite backup and preserves mode', async () => {
    const file = join(ws, 'edit.txt')
    await writeFile(file, 'old')
    await chmod(file, 0o600)
    const { status, body } = await harness.call('fs.write', { cwd: ws, path: file, content: 'new' })
    expect(status).toBe(200)
    expect(await readFile(file, 'utf8')).toBe('new')
    expect(body.value.sha256).toBe(sha('new'))
    expect(body.value.size).toBe(3)
    expect(body.value.backup).toBe(backupPath(sha('old')))
    expect(await readFile(body.value.backup, 'utf8')).toBe('old')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('accepts a matching expectedSha and saves with a backup', async () => {
    const file = join(ws, 'edit.txt')
    await writeFile(file, 'v1')
    const read = await harness.call('fs.read', { cwd: ws, path: file })
    const { status, body } = await harness.call('fs.write', {
      cwd: ws,
      path: file,
      content: 'v2',
      expectedSha: read.body.value.sha256,
    })
    expect(status).toBe(200)
    expect(await readFile(file, 'utf8')).toBe('v2')
    expect(body.value.backup).toBe(backupPath(sha('v1')))
  })

  it('conflicts on a stale expectedSha without writing', async () => {
    const file = join(ws, 'edit.txt')
    await writeFile(file, 'v1')
    const read = await harness.call('fs.read', { cwd: ws, path: file })
    await writeFile(file, 'v2')
    const { status, body } = await harness.call('fs.write', {
      cwd: ws,
      path: file,
      content: 'v3',
      expectedSha: read.body.value.sha256,
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('conflict')
    expect(body.error.message).toBe('file changed on disk since it was read')
    expect(await readFile(file, 'utf8')).toBe('v2')
  })

  it('force:true skips a stale expectedSha and still backs up the replaced bytes', async () => {
    const file = join(ws, 'edit.txt')
    await writeFile(file, 'v1')
    const read = await harness.call('fs.read', { cwd: ws, path: file })
    await writeFile(file, 'v2')
    const { status, body } = await harness.call('fs.write', {
      cwd: ws,
      path: file,
      content: 'mine',
      expectedSha: read.body.value.sha256,
      force: true,
    })
    expect(status).toBe(200)
    expect(await readFile(file, 'utf8')).toBe('mine')
    expect(body.value.backup).toBe(backupPath(sha('v2')))
    expect(await readFile(body.value.backup, 'utf8')).toBe('v2')
  })

  it('force:true recreates a vanished file with its stale expectedSha intact', async () => {
    const file = join(ws, 'gone.txt')
    const { status, body } = await harness.call('fs.write', {
      cwd: ws,
      path: file,
      content: 'back',
      expectedSha: sha('previous'),
      force: true,
    })
    expect(status).toBe(200)
    expect(await readFile(file, 'utf8')).toBe('back')
    expect(body.value.backup).toBeNull()
  })

  it('create-only still refuses when force is set', async () => {
    const file = join(ws, 'exists.txt')
    await writeFile(file, 'keep')
    const { status, body } = await harness.call('fs.write', {
      cwd: ws,
      path: file,
      content: 'clobber',
      expectedSha: null,
      force: true,
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('exists')
    expect(await readFile(file, 'utf8')).toBe('keep')
  })

  it('treats expectedSha:null as create-only (409 exists)', async () => {
    const file = join(ws, 'exists.txt')
    await writeFile(file, 'keep')
    const { status, body } = await harness.call('fs.write', {
      cwd: ws,
      path: file,
      content: 'clobber',
      expectedSha: null,
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('exists')
    expect(await readFile(file, 'utf8')).toBe('keep')
  })

  it('creates a new file with expectedSha:null and reports no backup', async () => {
    const file = join(ws, 'fresh.txt')
    const { status, body } = await harness.call('fs.write', {
      cwd: ws,
      path: file,
      content: 'made',
      expectedSha: null,
    })
    expect(status).toBe(200)
    expect(await readFile(file, 'utf8')).toBe('made')
    expect(body.value.backup).toBeNull()
  })

  it('conflicts when expectedSha is set but the file is gone', async () => {
    const { status, body } = await harness.call('fs.write', {
      cwd: ws,
      path: join(ws, 'gone.txt'),
      content: 'x',
      expectedSha: sha('whatever'),
    })
    expect(status).toBe(409)
    expect(body.error.code).toBe('conflict')
  })

  it('backs up before truncating to empty content', async () => {
    const file = join(ws, 'trunc.txt')
    await writeFile(file, 'precious')
    const { status, body } = await harness.call('fs.write', { cwd: ws, path: file, content: '' })
    expect(status).toBe(200)
    expect(body.value.size).toBe(0)
    expect(await readFile(file, 'utf8')).toBe('')
    expect(await readFile(body.value.backup, 'utf8')).toBe('precious')
  })

  it('is idempotent about the content-addressed backup store', async () => {
    const file = join(ws, 'edit.txt')
    await writeFile(file, 'old')
    const first = await harness.call('fs.write', { cwd: ws, path: file, content: 'new-1' })
    await writeFile(file, 'old')
    const second = await harness.call('fs.write', { cwd: ws, path: file, content: 'new-2' })
    expect(second.status).toBe(200)
    expect(second.body.value.backup).toBe(first.body.value.backup)
    expect(await readdir(backupDir())).toEqual([sha('old')])
  })

  it('leaves no temp files behind after an atomic write', async () => {
    const file = join(ws, 'atomic.txt')
    await writeFile(file, 'before')
    await harness.call('fs.write', { cwd: ws, path: file, content: 'after' })
    expect(await readdir(ws)).toEqual(['atomic.txt'])
    expect(await readFile(file, 'utf8')).toBe('after')
  })

  it('refuses paths outside the workspace and the workspace root itself', async () => {
    const outside = join(root, 'outside.txt')
    const escape = await harness.call('fs.write', { cwd: ws, path: outside, content: 'x' })
    expect(escape.status).toBe(400)
    await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' })

    const atRoot = await harness.call('fs.write', { cwd: ws, path: ws, content: 'x' })
    expect(atRoot.status).toBe(400)

    const dotdot = await harness.call('fs.write', {
      cwd: ws,
      path: join(ws, '..', 'escape.txt'),
      content: 'x',
    })
    expect(dotdot.status).toBe(400)
    await expect(stat(join(root, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses writing over a directory', async () => {
    const dir = join(ws, 'sub')
    await mkdir(dir)
    const { status } = await harness.call('fs.write', { cwd: ws, path: dir, content: 'x' })
    expect(status).toBe(400)
  })

  it('honours the request fences (content-type + host)', async () => {
    const file = join(ws, 'fenced.txt')
    const wrongType = await harness.call(
      'fs.write',
      { cwd: ws, path: file, content: 'x' },
      { contentType: 'text/plain' },
    )
    expect(wrongType.status).toBe(415)
    const badHost = await harness.call(
      'fs.write',
      { cwd: ws, path: file, content: 'x' },
      { host: 'evil.example' },
    )
    expect(badHost.status).toBe(403)
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
