// operator-view.spec.ts — vitest suite for the settings-document preview grant:
// `settings.document`, `fs.list`, and the `fs.write` operator allowance.
//
// The grant is derived from the live settings provider's `documentPath`, so the
// suite boots the routes with a configurable settings face and proves:
//  - the document route answers the provider's path and directory;
//  - listing is allowed inside that directory and refused everywhere else;
//  - saving is allowed inside that directory and still refused outside both the
//    session workspace and the grant (the agent/tool path never crosses these
//    routes, and a caller cannot widen the grant by supplying a path).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { apply } from '../src/index'

type Handler = (req: unknown, res: unknown) => Promise<void>

interface Harness {
  call: (method: string, payload: unknown) => Promise<{ status: number; body: any }>
}

/** The routes over one settings face: a real document path, or none. */
function makeHarness(documentPath: string | undefined): Harness {
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
      if (name === 'settings') return documentPath === undefined ? undefined : { documentPath }
      return undefined
    },
    effect: (fn: () => unknown) => fn(),
  }
  apply(ctx as never, {})
  if (handler === undefined) throw new Error('fsops handler was not registered')
  return {
    call: async (method, payload) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      const req = {
        headers: { host: 'localhost:4096', 'content-type': 'application/json' },
        method: 'POST',
        url: `/sidebar/fsops/${method}`,
        async *[Symbol.asyncIterator]() {
          yield body
        },
      }
      let status = 0
      let text = ''
      const res = {
        writeHead: (s: number) => { status = s },
        end: (t: string) => { text = t },
      }
      await handler!(req, res)
      return { status, body: JSON.parse(text) }
    },
  }
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

let root: string
let home: string
let ws: string
let profile: string
let documentPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fsops-operator-'))
  home = join(root, 'home')
  ws = join(root, 'ws')
  profile = join(root, 'profiles', 'web')
  await mkdir(home, { recursive: true })
  await mkdir(ws, { recursive: true })
  await mkdir(join(profile, 'packages'), { recursive: true })
  process.env.HOME = home
  documentPath = join(profile, 'cordis.patch.yml')
  await writeFile(documentPath, '- id: demo\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('settings.document', () => {
  it('answers the provider document path and its containing directory', async () => {
    const { status, body } = await makeHarness(documentPath).call('settings.document', {})
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { path: documentPath, root: profile } })
  })

  it('reports no document when the settings provider is absent or pathless', async () => {
    for (const missing of [undefined, '']) {
      const { status, body } = await makeHarness(missing).call('settings.document', {})
      expect(status).toBe(404)
      expect(body).toEqual({ ok: false, error: { code: 'not-found', message: 'no settings document is available' } })
    }
  })
})

describe('fs.list', () => {
  it('lists the document directory and its subdirectories', async () => {
    await writeFile(documentPath, '- id: demo\n')
    await mkdir(join(profile, 'skills'), { recursive: true })
    await writeFile(join(profile, 'README.md'), '# profile\n')
    const { status, body } = await makeHarness(documentPath).call('fs.list', { cwd: ws, path: profile })
    expect(status).toBe(200)
    expect(body.value.path).toBe(profile)
    expect(body.value.truncated).toBe(false)
    const byName = Object.fromEntries(body.value.entries.map((entry: { name: string }) => [entry.name, entry]))
    expect(byName['cordis.patch.yml']).toEqual({ name: 'cordis.patch.yml', type: 'file' })
    expect(byName['README.md']).toEqual({ name: 'README.md', type: 'file' })
    expect(byName['skills']).toEqual({ name: 'skills', type: 'directory' })

    const nested = await makeHarness(documentPath).call('fs.list', { cwd: ws, path: join(profile, 'skills') })
    expect(nested.status).toBe(200)
    expect(nested.body.value.entries).toEqual([])
  })

  it('refuses any directory outside the document directory', async () => {
    await writeFile(join(ws, 'note.txt'), 'x')
    for (const path of [ws, home, root, join(profile, '..')]) {
      const { status, body } = await makeHarness(documentPath).call('fs.list', { cwd: ws, path })
      expect(status).toBe(400)
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe('fs-error')
    }
  })

  it('refuses everything when no document is available', async () => {
    const { status, body } = await makeHarness(undefined).call('fs.list', { cwd: ws, path: profile })
    expect(status).toBe(400)
    expect(body.error.code).toBe('fs-error')
  })
})

describe('fs.write', () => {
  it('saves inside the document directory', async () => {
    const harness = makeHarness(documentPath)
    const read = await harness.call('fs.read', { cwd: ws, path: documentPath })
    expect(read.status).toBe(200)
    const next = '- id: demo\n  config:\n    welcomeNoticeVersion: 1\n'
    const { status, body } = await harness.call('fs.write', {
      cwd: ws, path: documentPath, content: next, expectedSha: read.body.value.sha256,
    })
    expect(status).toBe(200)
    expect(body.value.sha256).toBe(sha(next))
    expect(await readFile(documentPath, 'utf8')).toBe(next)
  })

  it('still refuses a workspace sibling outside both roots even with a matching digest', async () => {
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'original\n')
    const { status, body } = await makeHarness(documentPath).call('fs.write', {
      cwd: ws, path: outside, content: 'hijacked\n', expectedSha: sha('original\n'),
    })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('fs-error')
    expect(await readFile(outside, 'utf8')).toBe('original\n')
  })

  it('refuses the grant directory itself as a write target', async () => {
    const { status, body } = await makeHarness(documentPath).call('fs.write', {
      cwd: ws, path: profile, content: 'x', expectedSha: undefined,
    })
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
  })

  it('cannot be widened by a caller path: an absolute path outside the grant is refused', async () => {
    const outside = join(profile, '..', 'stray.yml')
    const { status, body } = await makeHarness(documentPath).call('fs.write', {
      cwd: ws, path: outside, content: 'x',
    })
    expect(status).toBe(400)
    expect(body.error.code).toBe('fs-error')
  })
})
