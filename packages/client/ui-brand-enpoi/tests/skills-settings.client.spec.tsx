// @vitest-environment jsdom
/**
 * SkillsSettings: the new Settings section lists the profile's skills from the
 * fenced `skills.list` route, creates through `skills.create`, edits through
 * `skills.read`/`skills.update`, deletes with confirm through `skills.delete`,
 * and surfaces the host's refusals (tier protection) in place.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { en, zh } from '../src/client/skills/locales.ts'
import type { SkillsSettingsProps } from '../src/client/skills/SkillsSettings.tsx'

/** One parsed fsops request body and its route method. */
interface FsopsCall {
  method: string
  payload: Record<string, unknown>
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
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

function sessionListResponse(ids: string[]): Response {
  return jsonResponse({ result: { ok: true, value: { items: ids.map(sessionId => ({ sessionId })) } } })
}

/** Translate with `{param}` interpolation, mirroring the locale service. */
function translate(key: keyof typeof en, params?: Record<string, unknown>): string {
  let text = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** The fsops requests a mock fetch served, in call order. */
function fsopsCalls(fetchMock: ReturnType<typeof vi.fn>): FsopsCall[] {
  return fetchMock.mock.calls
    .filter(call => String((call as [string])[0]).startsWith('/sidebar/fsops/'))
    .map((call) => {
      const url = String((call as [string])[0])
      const init = (call as [string, RequestInit])[1]
      return {
        method: url.slice('/sidebar/fsops/'.length),
        payload: JSON.parse(String(init.body)) as Record<string, unknown>,
      }
    })
}

async function renderSection(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(fetchImpl)
  vi.stubGlobal('fetch', fetchMock)
  const mod = await import('../src/client/skills/SkillsSettings.tsx')
  const props = { t: translate, close: () => {} } as unknown as SkillsSettingsProps
  render(<mod.SkillsSettings {...props} />)
  return fetchMock
}

/** A route stub table: session list plus per-skills-method handlers. */
function routeTable(handlers: Record<string, (payload: Record<string, unknown>) => Response>) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    if (url === '/api/session/list') return sessionListResponse(['sess-1'])
    const method = url.slice('/sidebar/fsops/'.length)
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
    if (handler === undefined) throw new Error(`unexpected fsops route ${method}`)
    return handler(JSON.parse(String(init.body)) as Record<string, unknown>)
  }
}

/** One skill row as the host returns it. */
function profileRow(name: string, description: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    entry: name,
    description,
    path: `/home/sandbox/profiles/web/skills/${name}/SKILL.md`,
    format: 'directory',
    source: 'profile',
    protected: false,
    editable: true,
    ...extra,
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('SkillsSettings', () => {
  it('lists on-disk and registry rows with source badges and read-only shipped rows without actions', async () => {
    const fetchMock = await renderSection(routeTable({
      'skills.list': () => ok({
        root: '/home/sandbox/skills',
        skills: [
          profileRow('alpha-skill', 'Alpha routing text'),
          profileRow('tier1-workflow', 'Shipped default', { source: 'default', protected: true, editable: false }),
          {
            name: 'tier2-workflow',
            entry: 'tier2-workflow',
            description: 'Shipped default from the registry',
            format: 'file',
            source: 'default',
            protected: true,
            editable: false,
          },
          {
            name: 'remote-skill',
            entry: 'remote-skill',
            description: 'From another root',
            format: 'file',
            source: 'registry',
            protected: false,
            editable: false,
          },
        ],
        registry: { ok: true },
      }),
    }))
    expect(await screen.findByText('alpha-skill')).toBeTruthy()
    expect(screen.getByText('Alpha routing text')).toBeTruthy()
    expect(screen.getByText(en.sourceProfile)).toBeTruthy()
    expect(screen.getAllByText(en.sourceDefault)).toHaveLength(2)
    expect(screen.getByText(en.sourceInstalled)).toBeTruthy()
    expect(screen.getAllByText(en.protectedBadge)).toHaveLength(2)
    // Every non-editable row (shipped tiers and registry entries) is read-only.
    for (const name of ['tier1-workflow', 'tier2-workflow', 'remote-skill']) {
      expect(screen.queryByLabelText(`${en.edit}: ${name}`)).toBeNull()
      expect(screen.queryByLabelText(`${en.delete}: ${name}`)).toBeNull()
    }
    // The editable row keeps both actions.
    expect(screen.getByLabelText(`${en.edit}: alpha-skill`)).toBeTruthy()
    expect(screen.getByLabelText(`${en.delete}: alpha-skill`)).toBeTruthy()
    // The registry merge is addressed by the newest session.
    const list = fsopsCalls(fetchMock).find(call => call.method === 'skills.list')
    expect(list?.payload).toEqual({ sessionId: 'sess-1' })
  })

  it('shows the empty state when no skills exist', async () => {
    await renderSection(routeTable({
      'skills.list': () => ok({ root: '/skills', skills: [], registry: { ok: true } }),
    }))
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('creates a skill through the New dialog and reloads the list', async () => {
    let rows: unknown[] = []
    const fetchMock = await renderSection(routeTable({
      'skills.list': () => ok({ root: '/skills', skills: rows, registry: { ok: true } }),
      'skills.create': (payload) => {
        rows = [profileRow(String(payload.name), String(payload.description))]
        return ok({ name: payload.name, path: '/skills/x/SKILL.md' })
      },
    }))
    fireEvent.click(await screen.findByText(en.newSkill))
    fireEvent.change(await screen.findByLabelText(en.fieldName), { target: { value: 'fresh-skill' } })
    fireEvent.change(screen.getByLabelText(en.fieldDescription), { target: { value: 'Created here' } })
    fireEvent.change(screen.getByLabelText(en.fieldBody), { target: { value: '# Fresh\n\nBody.' } })
    fireEvent.click(screen.getByText(en.create))

    await waitFor(() => { expect(fsopsCalls(fetchMock).some(call => call.method === 'skills.create')).toBe(true) })
    const create = fsopsCalls(fetchMock).find(call => call.method === 'skills.create')
    expect(create?.payload).toEqual({ name: 'fresh-skill', description: 'Created here', body: '# Fresh\n\nBody.' })
    expect(await screen.findByText('fresh-skill')).toBeTruthy()
  })

  it('validates the name and description before calling the host', async () => {
    const fetchMock = await renderSection(routeTable({
      'skills.list': () => ok({ root: '/skills', skills: [], registry: { ok: true } }),
    }))
    fireEvent.click(await screen.findByText(en.newSkill))
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
    const fetchMock = await renderSection(routeTable({
      'skills.list': () => ok({ root: '/skills', skills: [profileRow('alpha-skill', description)], registry: { ok: true } }),
      'skills.read': () => ok({
        name: 'alpha-skill',
        entry: 'alpha-skill',
        description,
        body: '# Old\n\nOld body.',
        content: `---\nname: alpha-skill\ndescription: ${description}\n---\n\n# Old\n\nOld body.`,
        path: '/skills/alpha-skill/SKILL.md',
        format: 'directory',
        source: 'profile',
        protected: false,
      }),
      'skills.update': (payload) => {
        description = String(payload.description)
        return ok({ name: payload.name, path: '/skills/alpha-skill/SKILL.md' })
      },
    }))
    fireEvent.click(await screen.findByLabelText(`${en.edit}: alpha-skill`))
    const body = await screen.findByLabelText(en.fieldBody) as HTMLTextAreaElement
    await waitFor(() => { expect(body.value).toBe('# Old\n\nOld body.') })
    expect(screen.getByLabelText(en.fieldName)).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText(en.fieldDescription), { target: { value: 'New description' } })
    fireEvent.change(body, { target: { value: '# New\n\nNew body.' } })
    fireEvent.click(screen.getByText(en.save))

    await waitFor(() => { expect(fsopsCalls(fetchMock).some(call => call.method === 'skills.update')).toBe(true) })
    const update = fsopsCalls(fetchMock).find(call => call.method === 'skills.update')
    expect(update?.payload).toEqual({ name: 'alpha-skill', description: 'New description', body: '# New\n\nNew body.' })
    expect(await screen.findByText('New description')).toBeTruthy()
  })

  it('deletes after confirmation and reloads without the row', async () => {
    let rows: unknown[] = [profileRow('disposable', 'Temp skill')]
    const fetchMock = await renderSection(routeTable({
      'skills.list': () => ok({ root: '/skills', skills: rows, registry: { ok: true } }),
      'skills.delete': () => {
        rows = []
        return ok({ name: 'disposable', dest: '/trash/disposable' })
      },
    }))
    fireEvent.click(await screen.findByLabelText(`${en.delete}: disposable`))
    expect(await screen.findByText(en.deleteConfirm.replace('{name}', 'disposable'))).toBeTruthy()
    fireEvent.click(screen.getByText(en.delete, { selector: 'button[data-skill-delete-confirm]' }))

    await waitFor(() => { expect(fsopsCalls(fetchMock).some(call => call.method === 'skills.delete')).toBe(true) })
    expect(fsopsCalls(fetchMock).find(call => call.method === 'skills.delete')?.payload).toEqual({ name: 'disposable' })
    await waitFor(() => { expect(screen.queryByText('disposable')).toBeNull() })
  })

  it('surfaces a host delete failure and keeps the skill', async () => {
    const fetchMock = await renderSection(routeTable({
      'skills.list': () => ok({
        root: '/skills',
        skills: [profileRow('doomed-skill', 'Editable row')],
        registry: { ok: true },
      }),
      'skills.delete': () => failure('fs-error', 'cannot delete skill "doomed-skill": staging failed'),
    }))
    fireEvent.click(await screen.findByLabelText(`${en.delete}: doomed-skill`))
    fireEvent.click(screen.getByText(en.delete, { selector: 'button[data-skill-delete-confirm]' }))

    const error = await screen.findByText(new RegExp('staging failed'))
    expect(error.getAttribute('data-skills-delete-error')).not.toBeNull()
    // The refusal never removes the row.
    expect(screen.queryByText('doomed-skill')).not.toBeNull()
    expect(fsopsCalls(fetchMock).filter(call => call.method === 'skills.delete')).toHaveLength(1)
  })

  it('surfaces an edit load failure inside the dialog', async () => {
    await renderSection(routeTable({
      'skills.list': () => ok({ root: '/skills', skills: [profileRow('alpha-skill', 'Alpha')], registry: { ok: true } }),
      'skills.read': () => failure('not-found', 'skill "alpha-skill" does not exist', 404),
    }))
    fireEvent.click(await screen.findByLabelText(`${en.edit}: alpha-skill`))
    expect(await screen.findByText(new RegExp('does not exist'))).toBeTruthy()
  })

  it('shows a load failure with Retry, and Retry reloads', async () => {
    let fail = true
    const fetchMock = await renderSection(routeTable({
      'skills.list': () => {
        if (fail) {
          fail = false
          return failure('internal', 'skills directory is unresolved', 500)
        }
        return ok({ root: '/skills', skills: [profileRow('alpha-skill', 'Alpha')], registry: { ok: true } })
      },
    }))
    expect(await screen.findByText(new RegExp(en.loadFailed))).toBeTruthy()
    fireEvent.click(screen.getByText(en.retry))
    expect(await screen.findByText('alpha-skill')).toBeTruthy()
    expect(fsopsCalls(fetchMock).filter(call => call.method === 'skills.list')).toHaveLength(2)
  })

  it('flags an unavailable registry catalog without hiding on-disk rows', async () => {
    await renderSection(routeTable({
      'skills.list': () => ok({ root: '/skills', skills: [profileRow('alpha-skill', 'Alpha')], registry: { ok: false, error: 'no session' } }),
    }))
    expect(await screen.findByText('alpha-skill')).toBeTruthy()
    expect(await screen.findByText(new RegExp('no session'))).toBeTruthy()
  })
})

describe('skills locale dictionaries', () => {
  it('define exactly the same key set in English and Chinese with non-empty copy', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(en[key].length).toBeGreaterThan(0)
      expect(zh[key].length).toBeGreaterThan(0)
    }
  })
})
