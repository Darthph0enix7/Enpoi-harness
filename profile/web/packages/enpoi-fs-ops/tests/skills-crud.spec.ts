// skills-crud.spec.ts — vitest suite for the skills.list/read/create/update/delete routes.
// Drives the fenced /sidebar/fsops handler against a temp skills dir and a temp
// DSH_HOME (the user root default and the trash destination), with the session
// skill catalog faked so the registry merge is exercised without a live host.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/index'

type Handler = (req: unknown, res: unknown) => Promise<void>

interface Harness {
  call: (method: string, payload: unknown) => Promise<{ status: number; body: any }>
  catalog: { list: ReturnType<typeof vi.fn> } | undefined
}

function makeHarness(catalog: Harness['catalog'], config: { skillsDir?: string } = { skillsDir: skillsDir() }): Harness {
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
      if (name === 'sessionSkillCatalog') return catalog
      return undefined
    },
    effect: (fn: () => unknown) => fn(),
  }
  apply(ctx as never, config)
  if (handler === undefined) throw new Error('fsops handler was not registered')
  return {
    catalog,
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

let root: string
let home: string
const skillsDir = (): string => join(root, 'skills')
const trashDir = (): string => join(home, 'trash', 'skills')
let savedDshHome: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-crud-'))
  home = join(root, 'home')
  await mkdir(home, { recursive: true })
  savedDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterEach(async () => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedDshHome
  await rm(root, { recursive: true, force: true })
})

/** Write one directory-bundle skill. */
async function writeBundle(name: string, frontmatter: string): Promise<void> {
  const dir = join(skillsDir(), name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${name}\n\nBody of ${name}.\n`)
}

describe('skills.list', () => {
  it('lists directory bundles and flat files with source/protected flags and skips invalid entries', async () => {
    const harness = makeHarness(undefined)
    await writeBundle('alpha-skill', 'name: alpha-skill\ndescription: Alpha routing text')
    await writeBundle('tier1-workflow', 'name: tier1-workflow\ndescription: Shipped default')
    await writeBundle('broken-skill', 'name: broken-skill') // no description -> skipped
    await writeFile(join(skillsDir(), 'flat-skill.md'), '---\nname: flat-skill\ndescription: Flat file skill\n---\nBody\n')
    await writeFile(join(skillsDir(), 'notes.txt'), 'not a skill')

    const { status, body } = await harness.call('skills.list', {})
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value.root).toBe(skillsDir())
    expect(body.value.registry).toEqual({ ok: true })
    expect(body.value.skills.map((row: any) => row.name)).toEqual(['alpha-skill', 'flat-skill', 'tier1-workflow'])
    const alpha = body.value.skills.find((row: any) => row.name === 'alpha-skill')
    expect(alpha).toMatchObject({
      entry: 'alpha-skill',
      description: 'Alpha routing text',
      format: 'directory',
      source: 'profile',
      protected: false,
      editable: true,
    })
    const flat = body.value.skills.find((row: any) => row.name === 'flat-skill')
    expect(flat).toMatchObject({ entry: 'flat-skill', format: 'file', source: 'profile', editable: true })
    const tier = body.value.skills.find((row: any) => row.name === 'tier1-workflow')
    expect(tier).toMatchObject({ source: 'default', protected: true, editable: false })
  })

  it('merges registry-only skills as read-only rows when a session address resolves', async () => {
    const catalog = { list: vi.fn(async () => ({ skills: [{ name: 'remote-skill', description: 'From the registry', path: '/other/roots/remote-skill/SKILL.md' }] })) }
    const harness = makeHarness(catalog)
    await writeBundle('alpha-skill', 'name: alpha-skill\ndescription: Local')

    const { body } = await harness.call('skills.list', { sessionId: 'sess-1' })
    expect(catalog.list).toHaveBeenCalledWith({ sessionId: 'sess-1' }, expect.anything())
    const remote = body.value.skills.find((row: any) => row.name === 'remote-skill')
    expect(remote).toMatchObject({ source: 'registry', editable: false, protected: false, mcp: [] })
    expect(body.value.registry).toEqual({ ok: true })
    // Registry rows never duplicate a local name.
    const localNames = body.value.skills.filter((row: any) => row.source !== 'registry').map((row: any) => row.name)
    expect(localNames).toContain('alpha-skill')
  })

  it('degrades to on-disk rows with a registry error when the catalog fails', async () => {
    const catalog = { list: vi.fn(async () => { throw new Error('no projected session') }) }
    const harness = makeHarness(catalog)
    await writeBundle('alpha-skill', 'name: alpha-skill\ndescription: Local')

    const { body } = await harness.call('skills.list', { sessionId: 'sess-1' })
    expect(body.value.skills.map((row: any) => row.name)).toEqual(['alpha-skill'])
    expect(body.value.registry).toEqual({ ok: false, error: 'no projected session' })
  })

  it('returns an empty list when the skills directory does not exist', async () => {
    const harness = makeHarness(undefined)
    const { status, body } = await harness.call('skills.list', {})
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value.skills).toEqual([])
  })

  it('marks a protected registry row as a read-only shipped default', async () => {
    const catalog = { list: vi.fn(async () => ({ skills: [{ name: 'tier2-workflow', description: 'Shipped default from the profile' }] })) }
    const harness = makeHarness(catalog)
    const { body } = await harness.call('skills.list', { sessionId: 'sess-1' })
    const tier = body.value.skills.find((row: any) => row.name === 'tier2-workflow')
    expect(tier).toMatchObject({ source: 'default', protected: true, editable: false })
  })

  it('defaults to the user root $DSH_HOME/skills and creates there', async () => {
    const harness = makeHarness(undefined, {})
    const created = await harness.call('skills.create', { name: 'home-skill', description: 'Lives in the user root', body: 'Body.' })
    expect(created.status).toBe(200)
    expect(created.body.value.path).toBe(join(home, 'skills', 'home-skill', 'SKILL.md'))
    const listed = await harness.call('skills.list', {})
    expect(listed.body.value.root).toBe(join(home, 'skills'))
    expect(listed.body.value.skills.map((row: any) => row.name)).toEqual(['home-skill'])
    // The profile skills dir never sees the write (no config, user root only).
    await expect(readdir(skillsDir())).rejects.toThrow()
  })
})

describe('skills.read', () => {
  it('returns the parsed frontmatter fields and the body', async () => {
    const harness = makeHarness(undefined)
    await writeBundle('alpha-skill', 'name: alpha-skill\ndescription: "Quoted: description"\nwhenToUse: Some routing hint')

    const { status, body } = await harness.call('skills.read', { name: 'alpha-skill' })
    expect(status).toBe(200)
    expect(body.value).toMatchObject({
      name: 'alpha-skill',
      description: 'Quoted: description',
      path: join(skillsDir(), 'alpha-skill', 'SKILL.md'),
      format: 'directory',
      protected: false,
    })
    expect(body.value.body).toBe('# alpha-skill\n\nBody of alpha-skill.')
  })

  it('404s a missing skill and refuses a traversal name', async () => {
    const harness = makeHarness(undefined)
    const missing = await harness.call('skills.read', { name: 'nope' })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('not-found')

    const traversal = await harness.call('skills.read', { name: '../escape' })
    expect(traversal.status).toBe(400)
    expect(traversal.body.error.code).toBe('bad-request')
  })

  it('refuses an invalid name and a non-string name', async () => {
    const harness = makeHarness(undefined)
    for (const name of ['A-bad', 'has space', 'has/slash', '', 42]) {
      const { status, body } = await harness.call('skills.read', { name })
      expect(status).toBe(400)
      expect(body.error.code).toBe('bad-request')
    }
  })
})

describe('skills.create', () => {
  it('writes a directory bundle that round-trips through list and read', async () => {
    const harness = makeHarness(undefined)
    const created = await harness.call('skills.create', {
      name: 'fresh-skill',
      description: 'Created from the settings UI',
      body: '# Fresh\n\nDo the thing.\n',
    })
    expect(created.status).toBe(200)
    expect(created.body.value.path).toBe(join(skillsDir(), 'fresh-skill', 'SKILL.md'))

    const listed = await harness.call('skills.list', {})
    expect(listed.body.value.skills).toHaveLength(1)
    expect(listed.body.value.skills[0]).toMatchObject({
      name: 'fresh-skill',
      description: 'Created from the settings UI',
      format: 'directory',
      source: 'profile',
    })

    const read = await harness.call('skills.read', { name: 'fresh-skill' })
    expect(read.body.value.body).toBe('# Fresh\n\nDo the thing.')
  })

  it('refuses an existing directory bundle and an existing flat file', async () => {
    const harness = makeHarness(undefined)
    await writeBundle('taken', 'name: taken\ndescription: Taken')
    await writeFile(join(skillsDir(), 'flat.md'), '---\nname: flat\ndescription: Flat\n---\nBody\n')

    const dirHit = await harness.call('skills.create', { name: 'taken', description: 'x', body: '' })
    expect(dirHit.status).toBe(409)
    expect(dirHit.body.error.code).toBe('exists')
    const flatHit = await harness.call('skills.create', { name: 'flat', description: 'x', body: '' })
    expect(flatHit.status).toBe(409)
  })

  it('refuses traversal and invalid slug names without writing anything', async () => {
    const harness = makeHarness(undefined)
    for (const name of ['../escape', 'a/b', 'UPPER', 'under_score', '']) {
      const { status } = await harness.call('skills.create', { name, description: 'x', body: 'y' })
      expect(status).toBe(400)
    }
    // Nothing exists outside (or at the traversal target) after the refusals.
    await expect(stat(join(root, 'escape'))).rejects.toThrow()
    await expect(readdir(skillsDir())).rejects.toThrow()
  })

  it('requires a non-empty description and a string body', async () => {
    const harness = makeHarness(undefined)
    const noDescription = await harness.call('skills.create', { name: 'ok-name', description: '', body: 'x' })
    expect(noDescription.status).toBe(400)
    const badBody = await harness.call('skills.create', { name: 'ok-name', description: 'x', body: 42 })
    expect(badBody.status).toBe(400)
  })

  it('refuses a shipped tier name and writes nothing', async () => {
    const harness = makeHarness(undefined)
    const { status, body } = await harness.call('skills.create', {
      name: 'tier1-workflow',
      description: 'Shadow attempt',
      body: '# Shadow',
    })
    expect(status).toBe(400)
    expect(body.error.code).toBe('protected')
    expect(body.error.message).toContain('shipped default')
    await expect(readdir(skillsDir())).rejects.toThrow()
  })

  it('writes the mcp hint line and returns it from list and read', async () => {
    const harness = makeHarness(undefined)
    const created = await harness.call('skills.create', {
      name: 'hinted-skill',
      description: 'Loads a server',
      body: 'Body.',
      mcp: ['test-mcp'],
    })
    expect(created.status).toBe(200)
    const raw = await readFile(join(skillsDir(), 'hinted-skill', 'SKILL.md'), 'utf8')
    expect(raw).toContain('mcp: [test-mcp]')

    const listed = await harness.call('skills.list', {})
    expect(listed.body.value.skills[0].mcp).toEqual(['test-mcp'])
    const read = await harness.call('skills.read', { name: 'hinted-skill' })
    expect(read.body.value.mcp).toEqual(['test-mcp'])

    // Without the field (or an empty list) there is no mcp line and the read path reports [].
    await harness.call('skills.create', { name: 'plain-skill', description: 'No hint', body: '' })
    const plainRaw = await readFile(join(skillsDir(), 'plain-skill', 'SKILL.md'), 'utf8')
    expect(plainRaw).not.toContain('mcp:')
    const plainRead = await harness.call('skills.read', { name: 'plain-skill' })
    expect(plainRead.body.value.mcp).toEqual([])
  })

  it('refuses a non-array mcp field, non-string entries, and empty ids', async () => {
    const harness = makeHarness(undefined)
    for (const mcp of ['test-mcp', 42, [42], [''], [null]]) {
      const { status, body } = await harness.call('skills.create', { name: 'ok-name', description: 'x', body: 'y', mcp })
      expect(status).toBe(400)
      expect(body.error.code).toBe('bad-request')
    }
    await expect(readdir(skillsDir())).rejects.toThrow()
  })

  it('quotes a description that would otherwise break the frontmatter', async () => {
    const harness = makeHarness(undefined)
    const description = 'Stars: "quoted" # hash\nsecond line'
    const created = await harness.call('skills.create', { name: 'tricky-skill', description, body: '' })
    expect(created.status).toBe(200)
    const read = await harness.call('skills.read', { name: 'tricky-skill' })
    expect(read.body.value.description).toBe(description)
  })
})

describe('skills.update', () => {
  it('rewrites description and body while preserving other frontmatter lines', async () => {
    const harness = makeHarness(undefined)
    await writeBundle('alpha-skill', 'name: alpha-skill\ndescription: Old description\nwhenToUse: Keep me\ndisable-model-invocation: true')

    const updated = await harness.call('skills.update', {
      name: 'alpha-skill',
      description: 'New description',
      body: '# Updated\n\nNew body.',
    })
    expect(updated.status).toBe(200)
    const raw = await readFile(join(skillsDir(), 'alpha-skill', 'SKILL.md'), 'utf8')
    expect(raw).toContain('description: "New description"')
    expect(raw).toContain('whenToUse: Keep me')
    expect(raw).toContain('disable-model-invocation: true')
    expect(raw).toContain('# Updated\n\nNew body.')

    const read = await harness.call('skills.read', { name: 'alpha-skill' })
    expect(read.body.value.description).toBe('New description')
    expect(read.body.value.body).toBe('# Updated\n\nNew body.')
  })

  it('adds, replaces, and removes the mcp hint while preserving other frontmatter', async () => {
    const harness = makeHarness(undefined)
    await writeBundle('hinted', 'name: hinted\ndescription: Old\nwhenToUse: Keep me')
    const path = join(skillsDir(), 'hinted', 'SKILL.md')

    // Add.
    await harness.call('skills.update', { name: 'hinted', description: 'New', body: 'Body.', mcp: ['server-a', 'server-b'] })
    let raw = await readFile(path, 'utf8')
    expect(raw).toContain('mcp: [server-a, server-b]')
    expect(raw).toContain('whenToUse: Keep me')
    let read = await harness.call('skills.read', { name: 'hinted' })
    expect(read.body.value.mcp).toEqual(['server-a', 'server-b'])

    // Replace (and quote an entry that is not a bare YAML scalar).
    await harness.call('skills.update', { name: 'hinted', description: 'New', body: 'Body.', mcp: ['server c'] })
    raw = await readFile(path, 'utf8')
    expect(raw).toContain('mcp: ["server c"]')
    expect(raw).not.toContain('server-a')
    read = await harness.call('skills.read', { name: 'hinted' })
    expect(read.body.value.mcp).toEqual(['server c'])

    // Remove: the line and its block continuation disappear.
    await harness.call('skills.update', { name: 'hinted', description: 'New', body: 'Body.', mcp: [] })
    raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('mcp:')
    read = await harness.call('skills.read', { name: 'hinted' })
    expect(read.body.value.mcp).toEqual([])

    // Absent field leaves the stored hint untouched.
    await harness.call('skills.update', { name: 'hinted', description: 'New', body: 'Body.', mcp: ['kept-mcp'] })
    await harness.call('skills.update', { name: 'hinted', description: 'Newer', body: 'Body.' })
    expect(await readFile(path, 'utf8')).toContain('mcp: [kept-mcp]')
  })

  it('parses and removes a block-sequence mcp hint', async () => {
    const harness = makeHarness(undefined)
    await writeBundle('blocky', 'name: blocky\ndescription: Block hint\nmcp:\n  - first-mcp\n  - second-mcp')
    const read = await harness.call('skills.read', { name: 'blocky' })
    expect(read.body.value.mcp).toEqual(['first-mcp', 'second-mcp'])

    await harness.call('skills.update', { name: 'blocky', description: 'Block hint', body: 'Body.', mcp: [] })
    const raw = await readFile(join(skillsDir(), 'blocky', 'SKILL.md'), 'utf8')
    expect(raw).not.toContain('mcp:')
    expect(raw).not.toContain('first-mcp')
  })

  it('refuses an invalid mcp field without touching the file', async () => {
    const harness = makeHarness(undefined)
    await writeBundle('locked', 'name: locked\ndescription: Keep me')
    const path = join(skillsDir(), 'locked', 'SKILL.md')
    const before = await readFile(path, 'utf8')
    const { status, body } = await harness.call('skills.update', { name: 'locked', description: 'x', body: '', mcp: 'not-an-array' })
    expect(status).toBe(400)
    expect(body.error.code).toBe('bad-request')
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('404s a missing skill', async () => {
    const harness = makeHarness(undefined)
    const { status, body } = await harness.call('skills.update', { name: 'nope', description: 'x', body: '' })
    expect(status).toBe(404)
    expect(body.error.code).toBe('not-found')
  })

  it('refuses to edit a shipped tier even when it exists in the root', async () => {
    const harness = makeHarness(undefined)
    await writeBundle('tier3-workflow', 'name: tier3-workflow\ndescription: Shipped default')
    const path = join(skillsDir(), 'tier3-workflow', 'SKILL.md')
    const before = await readFile(path, 'utf8')
    const { status, body } = await harness.call('skills.update', { name: 'tier3-workflow', description: 'Hijacked', body: '# Hijacked' })
    expect(status).toBe(400)
    expect(body.error.code).toBe('protected')
    expect(await readFile(path, 'utf8')).toBe(before)
  })
})

describe('skills.delete', () => {
  it('trash-stages a bundle and removes it from the listing', async () => {
    const harness = makeHarness(undefined)
    await writeBundle('disposable', 'name: disposable\ndescription: Temp')

    const deleted = await harness.call('skills.delete', { name: 'disposable' })
    expect(deleted.status).toBe(200)
    expect(deleted.body.value.dest.startsWith(trashDir())).toBe(true)
    // Recoverable: the bundle moved, never removed.
    const staged = await readdir(trashDir())
    expect(staged).toHaveLength(1)
    expect(await readdir(join(trashDir(), staged[0]!))).toEqual(['SKILL.md'])

    const listed = await harness.call('skills.list', {})
    expect(listed.body.value.skills).toEqual([])
  })

  it('trash-stages a flat file', async () => {
    const harness = makeHarness(undefined)
    await mkdir(skillsDir(), { recursive: true })
    await writeFile(join(skillsDir(), 'flat-skill.md'), '---\nname: flat-skill\ndescription: Flat\n---\nBody\n')
    const deleted = await harness.call('skills.delete', { name: 'flat-skill' })
    expect(deleted.status).toBe(200)
    await expect(stat(join(skillsDir(), 'flat-skill.md'))).rejects.toThrow()
  })

  it('refuses the three shipped tier skills and leaves them in place', async () => {
    const harness = makeHarness(undefined)
    for (const name of ['tier1-workflow', 'tier2-workflow', 'tier3-workflow']) {
      await writeBundle(name, `name: ${name}\ndescription: Shipped default`)
      const { status, body } = await harness.call('skills.delete', { name })
      expect(status).toBe(400)
      expect(body.error.code).toBe('protected')
      expect(body.error.message).toContain('shipped default')
      expect(await readFile(join(skillsDir(), name, 'SKILL.md'), 'utf8')).toContain(`name: ${name}`)
    }
    const listed = await harness.call('skills.list', {})
    expect(listed.body.value.skills).toHaveLength(3)
  })

  it('404s a missing skill and refuses a traversal name', async () => {
    const harness = makeHarness(undefined)
    const missing = await harness.call('skills.delete', { name: 'nope' })
    expect(missing.status).toBe(404)
    const traversal = await harness.call('skills.delete', { name: '../../etc' })
    expect(traversal.status).toBe(400)
  })

  it('refuses a shipped tier name even when no on-disk copy exists', async () => {
    const harness = makeHarness(undefined)
    for (const name of ['tier1-workflow', 'tier2-workflow', 'tier3-workflow']) {
      const { status, body } = await harness.call('skills.delete', { name })
      expect(status).toBe(400)
      expect(body.error.code).toBe('protected')
    }
    await expect(readdir(skillsDir())).rejects.toThrow()
  })
})
