// @vitest-environment jsdom
/**
 * SkillsPanel — the Dynamic page's Skills & tools tab: catalog rows from the
 * fenced `skills.list` route (shipped tiers read-only, user rows editable),
 * add/edit/delete through `skills.create|read|update|delete`, the existing
 * capability toggles unchanged, and locale-dictionary parity.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
// Load the package's module augmentations (LocaleNamespaceMap) into this program.
import type {} from '../src/client/index.ts'
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { en, zh } from '../src/client/dynamic/skills-locales.ts'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** One parser map for every route the panel touches. */
interface Fixture {
  describe?: () => Response
  sessionList?: () => Response
  gatewaySkills?: () => Response
  mutate?: () => Response
  fsops?: Record<string, (payload: Record<string, unknown>) => Response>
}

function ok(value: unknown): Response {
  return jsonResponse({ ok: true, value })
}

function failure(code: string, message: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** One skill row as the host's `skills.list` returns it. */
function skillRow(name: string, description: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    entry: name,
    description,
    path: `/home/sandbox/skills/${name}/SKILL.md`,
    format: 'directory',
    source: 'profile',
    protected: false,
    editable: true,
    ...extra,
  }
}

/** Translate with `{param}` interpolation, mirroring the locale service. */
function translate(key: LocaleKeysOf<'settings.dynamicSkills'>, params?: Record<string, unknown>): string {
  let text = (en as Partial<Record<string, string>>)[key] ?? String(key)
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** The fsops requests a mock fetch served, in call order. */
function fsopsCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(call => String((call as [string])[0]).startsWith('/sidebar/fsops/'))
    .map((call) => {
      const url = String((call as [string])[0])
      return {
        method: url.slice('/sidebar/fsops/'.length),
        payload: JSON.parse(String((call as [string, RequestInit])[1].body)) as Record<string, unknown>,
      }
    })
}

async function mountPanel(fixture: Fixture = {}) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/settings.describe') {
      return (fixture.describe ?? (() => jsonResponse({
        result: { ok: true, value: { namespaces: [{ ns: 'enpoi-orchestration', revision: 5, value: { capabilities: { tools: {}, skills: {} } } }] } },
      })))()
    }
    if (url === '/api/session/list') {
      return (fixture.sessionList ?? (() => jsonResponse({ result: { ok: true, value: { items: [{ sessionId: 'sess-1' }] } } })))()
    }
    if (url === '/api/skills.list') {
      return (fixture.gatewaySkills ?? (() => jsonResponse({
        result: { ok: true, value: { skills: [{ name: 'alpha-skill', modelInvocable: true }] } },
      })))()
    }
    if (url === '/api/settings.mutate') {
      return (fixture.mutate ?? (() => jsonResponse({ result: { ok: true, value: { revision: 6 } } })))()
    }
    if (url.startsWith('/sidebar/fsops/')) {
      const method = url.slice('/sidebar/fsops/'.length)
      const handler = fixture.fsops?.[method]
      if (handler !== undefined) return handler(JSON.parse(String(init.body)) as Record<string, unknown>)
    }
    throw new Error(`unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const mod = await import('../src/client/dynamic/SkillsPanel.tsx')
  render(<mod.SkillsPanel t={translate} />)
  return fetchMock
}

/** The default catalog: one editable user skill, one read-only shipped tier, one registry row. */
function defaultFsopsList(rows = [
  skillRow('alpha-skill', 'Alpha routing text'),
  skillRow('tier1-workflow', 'Shipped default', { source: 'default', protected: true, editable: false }),
]) {
  return () => ok({ root: '/home/sandbox/skills', skills: rows, registry: { ok: true } })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('SkillsPanel', () => {
  it('lists catalog rows, keeps shipped rows read-only, and keeps toggles for every row', async () => {
    await mountPanel({
      fsops: {
        'skills.list': defaultFsopsList([
          skillRow('alpha-skill', 'Alpha routing text'),
          skillRow('tier1-workflow', 'Shipped default', { source: 'default', protected: true, editable: false }),
          {
            name: 'remote-skill',
            entry: 'remote-skill',
            description: 'From another root',
            path: '/home/sandbox/skills/remote-skill/SKILL.md',
            format: 'file',
            source: 'registry',
            protected: false,
            editable: false,
          },
        ]),
      },
      gatewaySkills: () => jsonResponse({
        result: { ok: true, value: { skills: [{ name: 'alpha-skill', modelInvocable: true }, { name: 'remote-skill', modelInvocable: false }] } },
      }),
    })
    expect(await screen.findByText('alpha-skill')).toBeTruthy()
    expect(screen.getByText('Alpha routing text')).toBeTruthy()
    expect(screen.getByText(en.protectedBadge)).toBeTruthy()
    expect(screen.getByText('user-only')).toBeTruthy()
    // The editable row carries Edit/Delete; every read-only row does not.
    expect(screen.getByLabelText(`${en.edit}: alpha-skill`)).toBeTruthy()
    expect(screen.getByLabelText(`${en.delete}: alpha-skill`)).toBeTruthy()
    for (const name of ['tier1-workflow', 'remote-skill']) {
      expect(screen.queryByLabelText(`${en.edit}: ${name}`)).toBeNull()
      expect(screen.queryByLabelText(`${en.delete}: ${name}`)).toBeNull()
    }
    // Toggles stay on all rows (existing capability behavior).
    for (const name of ['alpha-skill', 'tier1-workflow', 'remote-skill']) {
      expect(screen.getByLabelText(`Enable ${name}`)).toBeTruthy()
    }
  })

  it('skill toggle writes the fenced capabilities.skills path', async () => {
    const fetchMock = await mountPanel({ fsops: { 'skills.list': defaultFsopsList() } })
    fireEvent.click(await screen.findByLabelText('Enable alpha-skill'))
    await waitFor(() => { expect((fetchMock.mock.calls.filter(c => String(c[0]) === '/api/settings.mutate'))).toHaveLength(1) })
    const body = JSON.parse(String((fetchMock.mock.calls.find(c => String(c[0]) === '/api/settings.mutate')![1] as RequestInit).body))
    expect(body.payload.args.ns).toBe('enpoi-orchestration')
    expect(body.payload.args.expectedRevision).toBe(5)
    expect(body.payload.args.ops).toEqual([
      { op: 'set', path: ['capabilities', 'skills', 'alpha-skill'], value: false },
    ])
  })

  it('tool toggle writes the fenced capabilities.tools path', async () => {
    const fetchMock = await mountPanel({ fsops: { 'skills.list': defaultFsopsList() } })
    fireEvent.click(await screen.findByLabelText('Enable File Editor'))
    await waitFor(() => { expect(fetchMock.mock.calls.filter(c => String(c[0]) === '/api/settings.mutate')).toHaveLength(1) })
    const body = JSON.parse(String((fetchMock.mock.calls.find(c => String(c[0]) === '/api/settings.mutate')![1] as RequestInit).body))
    expect(body.payload.args.ops).toEqual([
      { op: 'set', path: ['capabilities', 'tools', 'edit'], value: false },
    ])
  })

  it('rejected writes roll back the optimistic toggle and show the reason', async () => {
    await mountPanel({
      fsops: { 'skills.list': defaultFsopsList() },
      mutate: () => jsonResponse({ result: { ok: false, error: { code: 'settings/rejected', message: 'policy refused', details: {} } } }),
    })
    fireEvent.click(await screen.findByLabelText('Enable alpha-skill'))
    const { getStatus } = await import('../src/client/dynamic/status.ts')
    await waitFor(() => { expect(getStatus()).toBe('policy refused') })
    expect((screen.getByLabelText('Enable alpha-skill') as HTMLInputElement).checked).toBe(true)
  })

  it('creates a skill from + Add and reloads the catalog', async () => {
    let rows: unknown[] = []
    const fetchMock = await mountPanel({
      fsops: {
        'skills.list': () => ok({ root: '/home/sandbox/skills', skills: rows, registry: { ok: true } }),
        'skills.create': (payload) => {
          rows = [skillRow(String(payload.name), String(payload.description))]
          return ok({ name: payload.name, path: '/home/sandbox/skills/x/SKILL.md' })
        },
      },
    })
    fireEvent.click(await screen.findByText(en.add))
    fireEvent.change(await screen.findByLabelText(en.fieldName), { target: { value: 'fresh-skill' } })
    fireEvent.change(screen.getByLabelText(en.fieldDescription), { target: { value: 'Created here' } })
    fireEvent.change(screen.getByLabelText(en.fieldBody), { target: { value: '# Fresh\n\nBody.' } })
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(fsopsCalls(fetchMock).some(call => call.method === 'skills.create')).toBe(true) })
    const create = fsopsCalls(fetchMock).find(call => call.method === 'skills.create')
    expect(create?.payload).toEqual({ name: 'fresh-skill', description: 'Created here', body: '# Fresh\n\nBody.' })
    expect(await screen.findByText('fresh-skill')).toBeTruthy()
  })

  it('validates name and description before calling the host', async () => {
    const fetchMock = await mountPanel({ fsops: { 'skills.list': defaultFsopsList() } })
    fireEvent.click(await screen.findByText(en.add))
    fireEvent.change(await screen.findByLabelText(en.fieldName), { target: { value: 'Bad Name' } })
    fireEvent.click(screen.getByText(en.create))
    expect(await screen.findByText(en.nameRequired)).toBeTruthy()
    expect(fsopsCalls(fetchMock).some(call => call.method === 'skills.create')).toBe(false)

    fireEvent.change(screen.getByLabelText(en.fieldName), { target: { value: 'ok-name' } })
    fireEvent.click(screen.getByText(en.create))
    expect(await screen.findByText(en.descriptionRequired)).toBeTruthy()
    expect(fsopsCalls(fetchMock).some(call => call.method === 'skills.create')).toBe(false)
  })

  it('loads the body on Edit and saves description and body', async () => {
    let description = 'Old description'
    const fetchMock = await mountPanel({
      fsops: {
        'skills.list': () => ok({ root: '/home/sandbox/skills', skills: [skillRow('alpha-skill', description)], registry: { ok: true } }),
        'skills.read': () => ok({
          name: 'alpha-skill',
          entry: 'alpha-skill',
          description,
          body: '# Old\n\nOld body.',
          content: `---\nname: alpha-skill\ndescription: ${description}\n---\n\n# Old\n\nOld body.`,
          path: '/home/sandbox/skills/alpha-skill/SKILL.md',
          format: 'directory',
          source: 'profile',
          protected: false,
        }),
        'skills.update': (payload) => {
          description = String(payload.description)
          return ok({ name: payload.name, path: '/home/sandbox/skills/alpha-skill/SKILL.md' })
        },
      },
    })
    fireEvent.click(await screen.findByLabelText(`${en.edit}: alpha-skill`))
    const body = await screen.findByLabelText(en.fieldBody) as HTMLTextAreaElement
    await waitFor(() => { expect(body.value).toBe('# Old\n\nOld body.') })
    expect(screen.getByLabelText(en.fieldName)).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText(en.fieldDescription), { target: { value: 'New description' } })
    fireEvent.change(body, { target: { value: '# New\n\nNew body.' } })
    fireEvent.click(screen.getByText(en.save))

    await waitFor(() => { expect(fsopsCalls(fetchMock).some(call => call.method === 'skills.update')).toBe(true) })
    expect(fsopsCalls(fetchMock).find(call => call.method === 'skills.update')?.payload)
      .toEqual({ name: 'alpha-skill', description: 'New description', body: '# New\n\nNew body.' })
    expect(await screen.findByText('New description')).toBeTruthy()
  })

  it('surfaces an edit load failure inside the dialog', async () => {
    await mountPanel({
      fsops: {
        'skills.list': defaultFsopsList([skillRow('alpha-skill', 'Alpha')]),
        'skills.read': () => failure('not-found', 'skill "alpha-skill" does not exist', 404),
      },
    })
    fireEvent.click(await screen.findByLabelText(`${en.edit}: alpha-skill`))
    expect(await screen.findByText(new RegExp('does not exist'))).toBeTruthy()
  })

  it('saves a rejected edit behind the error line', async () => {
    await mountPanel({
      fsops: {
        'skills.list': defaultFsopsList([skillRow('alpha-skill', 'Alpha')]),
        'skills.read': () => ok({
          name: 'alpha-skill', entry: 'alpha-skill', description: 'Alpha', body: 'Body.',
          content: '---\nname: alpha-skill\ndescription: Alpha\n---\n\nBody.',
          path: '/skills/alpha-skill/SKILL.md', format: 'directory', source: 'profile', protected: false,
        }),
        'skills.update': () => failure('protected', 'skill "alpha-skill" is a shipped default of this profile and cannot be edited'),
      },
    })
    fireEvent.click(await screen.findByLabelText(`${en.edit}: alpha-skill`))
    await waitFor(() => { expect((screen.getByLabelText(en.fieldBody) as HTMLTextAreaElement).value).toBe('Body.') })
    fireEvent.change(screen.getByLabelText(en.fieldDescription), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByText(en.save))
    expect(await screen.findByText(new RegExp('shipped default'))).toBeTruthy()
  })

  it('deletes after confirmation and reloads without the row', async () => {
    let rows: unknown[] = [skillRow('disposable', 'Temp skill')]
    const fetchMock = await mountPanel({
      fsops: {
        'skills.list': () => ok({ root: '/home/sandbox/skills', skills: rows, registry: { ok: true } }),
        'skills.delete': () => {
          rows = []
          return ok({ name: 'disposable', dest: '/trash/disposable' })
        },
      },
    })
    fireEvent.click(await screen.findByLabelText(`${en.delete}: disposable`))
    expect(await screen.findByText(en.deleteConfirm.replace('{name}', 'disposable'))).toBeTruthy()
    fireEvent.click(screen.getByText(en.delete, { selector: 'button[data-skill-delete-confirm]' }))

    await waitFor(() => { expect(fsopsCalls(fetchMock).some(call => call.method === 'skills.delete')).toBe(true) })
    expect(fsopsCalls(fetchMock).find(call => call.method === 'skills.delete')?.payload).toEqual({ name: 'disposable' })
    await waitFor(() => { expect(screen.queryByText('disposable')).toBeNull() })
  })

  it('surfaces a host delete failure and keeps the row', async () => {
    const fetchMock = await mountPanel({
      fsops: {
        'skills.list': defaultFsopsList([skillRow('doomed-skill', 'Editable row')]),
        'skills.delete': () => failure('fs-error', 'cannot delete skill "doomed-skill": staging failed'),
      },
    })
    fireEvent.click(await screen.findByLabelText(`${en.delete}: doomed-skill`))
    fireEvent.click(screen.getByText(en.delete, { selector: 'button[data-skill-delete-confirm]' }))

    const error = await screen.findByText(new RegExp('staging failed'))
    expect(error.getAttribute('data-skills-delete-error')).not.toBeNull()
    expect(screen.queryByText('doomed-skill')).not.toBeNull()
    expect(fsopsCalls(fetchMock).filter(call => call.method === 'skills.delete')).toHaveLength(1)
  })

  it('falls back to on-disk rows and a note when the session list is empty', async () => {
    await mountPanel({
      sessionList: () => jsonResponse({ result: { ok: true, value: { items: [] } } }),
      fsops: { 'skills.list': defaultFsopsList() },
    })
    expect(await screen.findByText('alpha-skill')).toBeTruthy()
    expect(await screen.findByText(en.noSessionHint)).toBeTruthy()
  })

  it('shows a load failure with Retry when the fsops catalog fails', async () => {
    let fail = true
    const fetchMock = await mountPanel({
      fsops: {
        'skills.list': () => {
          if (fail) {
            fail = false
            return failure('internal', 'skills directory is unresolved', 500)
          }
          return ok({ root: '/home/sandbox/skills', skills: [skillRow('alpha-skill', 'Alpha')], registry: { ok: true } })
        },
      },
    })
    expect(await screen.findByText(new RegExp(en.loadFailed))).toBeTruthy()
    fireEvent.click(screen.getByText(en.retry))
    expect(await screen.findByText('alpha-skill')).toBeTruthy()
    expect(fsopsCalls(fetchMock).filter(call => call.method === 'skills.list')).toHaveLength(2)
  })
})

describe('dynamic skills locale dictionaries', () => {
  it('define exactly the same key set in English and Chinese with non-empty copy', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(en[key].length).toBeGreaterThan(0)
      expect(zh[key].length).toBeGreaterThan(0)
    }
  })
})
