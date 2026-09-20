// @vitest-environment jsdom
/**
 * SkillsPanel: the live `/api/skills.list` catalog is resolved through the
 * newest visible session from `/api/session/list`, each row shows the
 * instruction-file path, and toggles write the fenced
 * `capabilities.skills.<name>` / `capabilities.tools.<id>` paths.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

/** One parsed `settings.mutate` request body. */
interface MutateBody {
  method: string
  payload: {
    args: {
      ns: string
      expectedRevision?: number
      ops: Array<{ op: string; path: string[]; value?: unknown }>
    }
  }
}

/** One JSON response envelope. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** One `settings.describe` answer carrying the enpoi-orchestration namespace. */
function describeResponse(value: unknown, revision: number): Response {
  return jsonResponse({ result: { ok: true, value: { namespaces: [{ ns: 'enpoi-orchestration', revision, value }] } } })
}

/** One `session.list` answer. */
function sessionListResponse(ids: string[]): Response {
  return jsonResponse({
    result: {
      ok: true,
      value: {
        items: ids.map(sessionId => ({ sessionId, updatedAt: 1, running: false, blank: false })),
      },
    },
  })
}

/** One `skills.list` answer. */
function skillsListResponse(skills: unknown[]): Response {
  return jsonResponse({ result: { ok: true, value: { skills } } })
}

/** One successful `settings.mutate` envelope. */
function mutateOk(): Response {
  return jsonResponse({ result: { ok: true, value: { revision: 99 } } })
}

/** The settings.mutate bodies a mock served, in call order. */
function mutateBodies(fetchMock: ReturnType<typeof vi.fn>): MutateBody[] {
  return fetchMock.mock.calls
    .map(call => JSON.parse(String((call as [string, RequestInit])[1].body)) as MutateBody)
    .filter(body => body.method === 'settings.mutate')
}

/** Mount the panel with a driven gateway and one discovered skill. */
async function mountPanel() {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const method = (JSON.parse(String(init.body)) as { method: string }).method
    if (method === 'settings.describe') {
      return describeResponse({ capabilities: { tools: {}, skills: {} } }, 5)
    }
    if (method === 'session.list') return sessionListResponse(['sess-1'])
    if (method === 'skills.list') {
      return skillsListResponse([{
        name: 'project-management',
        description: 'Plane documentation and progress journaling',
        path: '/home/adam/.dsh/skills/project-management/SKILL.md',
        modelInvocable: true,
      }])
    }
    if (method === 'settings.mutate') return mutateOk()
    throw new Error(`unexpected method ${method}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const mod = await import('../src/client/dynamic/SkillsPanel.tsx')
  render(<mod.SkillsPanel />)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('SkillsPanel', () => {
  it('lists the live skill catalog and shows the instruction-file path', async () => {
    await mountPanel()
    expect(await screen.findByText('project-management')).toBeTruthy()
    expect(screen.getByText('/home/adam/.dsh/skills/project-management/SKILL.md')).toBeTruthy()
  })

  it('skill toggle writes the fenced capabilities.skills path', async () => {
    const fetchMock = await mountPanel()
    fireEvent.click(await screen.findByLabelText('Enable project-management'))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    const body = mutateBodies(fetchMock)[0]!
    expect(body.payload.args.ns).toBe('enpoi-orchestration')
    expect(body.payload.args.expectedRevision).toBe(5)
    expect(body.payload.args.ops).toEqual([
      { op: 'set', path: ['capabilities', 'skills', 'project-management'], value: false },
    ])
  })

  it('tool toggle writes the fenced capabilities.tools path', async () => {
    const fetchMock = await mountPanel()
    fireEvent.click(await screen.findByLabelText('Enable File Editor'))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    expect(mutateBodies(fetchMock)[0]!.payload.args.ops).toEqual([
      { op: 'set', path: ['capabilities', 'tools', 'edit'], value: false },
    ])
  })

  it('rejected writes roll back the optimistic toggle and show the reason', async () => {
    const fetchMock = await mountPanel()
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const method = (JSON.parse(String(init.body)) as { method: string }).method
      if (method === 'settings.describe') {
        return describeResponse({ capabilities: { tools: {}, skills: {} } }, 5)
      }
      if (method === 'session.list') return sessionListResponse(['sess-1'])
      if (method === 'skills.list') {
        return skillsListResponse([{
          name: 'project-management',
          description: 'Plane documentation and progress journaling',
          path: '/home/adam/.dsh/skills/project-management/SKILL.md',
          modelInvocable: true,
        }])
      }
      if (method === 'settings.mutate') {
        return jsonResponse({ result: { ok: false, error: { code: 'settings/rejected', message: 'policy refused', details: {} } } })
      }
      throw new Error(`unexpected method ${method}`)
    })
    fireEvent.click(await screen.findByLabelText('Enable project-management'))
    await waitFor(() => { expect(screen.getByText('policy refused')).toBeTruthy() })
    expect((screen.getByLabelText('Enable project-management') as HTMLInputElement).checked).toBe(true)
  })
})
