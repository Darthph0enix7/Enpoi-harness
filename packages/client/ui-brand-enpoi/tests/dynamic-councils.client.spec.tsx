// @vitest-environment jsdom
/**
 * CouncilsPanel writes: add submits the whole declarative spec fenced by the
 * namespace revision (minimal defaults included), disable writes
 * `councils.<id>.disabled = true`, delete unsets `councils.<id>` (built-ins
 * fall back to their code default), and a host validation error renders.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { brandT } from './brand-i18n.client.ts'

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

/** One `enpoiCouncil.list` answer. */
function councilListResponse(councils: unknown[]): Response {
  return jsonResponse({ result: { ok: true, value: { councils } } })
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

/** Mount the panel with a driven gateway. */
async function mountPanel(councils: unknown[], value: Record<string, unknown>) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const method = (JSON.parse(String(init.body)) as { method: string }).method
    if (method === 'settings.describe') return describeResponse(value, 7)
    if (method === 'enpoiCouncil.list') return councilListResponse(councils)
    if (method === 'settings.mutate') return mutateOk()
    throw new Error(`unexpected method ${method}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const mod = await import('../src/client/dynamic/CouncilsPanel.tsx')
  render(<mod.CouncilsPanel t={brandT} />)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('CouncilsPanel', () => {
  it('renders a host validation error visibly', async () => {
    await mountPanel([{ id: 'broken', label: 'Broken', seats: [], enabled: true, error: 'missing chairTemplate' }], {})
    expect(await screen.findByText(/invalid: missing chairTemplate/)).toBeTruthy()
  })

  it('add writes the fenced declarative spec with working defaults', async () => {
    const fetchMock = await mountPanel([], {})
    fireEvent.click(await screen.findByRole('button', { name: '+ Add council' }))
    fireEvent.change(screen.getByLabelText('Council id'), { target: { value: 'my-council' } })
    fireEvent.change(screen.getByLabelText('Council label'), { target: { value: 'My Council' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add council' }))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    const body = mutateBodies(fetchMock)[0]!
    expect(body.payload.args.ns).toBe('enpoi-orchestration')
    expect(body.payload.args.expectedRevision).toBe(7)
    expect(body.payload.args.ops).toHaveLength(1)
    const op = body.payload.args.ops[0]!
    expect(op.op).toBe('set')
    expect(op.path).toEqual(['councils', 'my-council'])
    expect(op.value).toEqual({
      id: 'my-council',
      label: 'My Council',
      seats: [{ id: 'seat-1', label: 'Seat 1', persona: 'You are a rigorous council seat.' }],
      ledgerKinds: [{ kind: 'claim', idPrefix: 'C', terminalStatuses: ['invariant', 'falsified'] }],
      actions: ['PROPOSE', 'ATTACK'],
      opening: 'blind',
      deliverableSections: ['FINDINGS', 'OPEN QUESTIONS'],
      stoppingPolicy: { type: 'ledger_convergence' },
      chairTemplate: { systemPrompt: '', userPromptTemplate: '' },
    })
  })

  it('disable writes the disabled flag for the council id', async () => {
    const fetchMock = await mountPanel([{ id: 'roundtable', label: 'Roundtable', seats: [{ id: 'skeptic' }, { id: 'architect' }, { id: 'pragmatist' }], enabled: true }], {})
    fireEvent.click(await screen.findByLabelText('Disable Roundtable'))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    expect(mutateBodies(fetchMock)[0]!.payload.args.ops).toEqual([
      { op: 'set', path: ['councils', 'roundtable', 'disabled'], value: true },
    ])
  })

  it('delete unsets the council override key', async () => {
    const fetchMock = await mountPanel([{ id: 'roundtable', label: 'Roundtable', seats: [{ id: 'skeptic' }], enabled: true }], {})
    fireEvent.click(await screen.findByLabelText('Delete Roundtable'))
    fireEvent.click(screen.getByLabelText('Confirm delete Roundtable'))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    expect(mutateBodies(fetchMock)[0]!.payload.args.ops).toEqual([
      { op: 'unset', path: ['councils', 'roundtable'] },
    ])
  })

  it('prompt edits rewrite the seats array and chair template', async () => {
    const fetchMock = await mountPanel(
      [{ id: 'chorus', label: 'Chorus', seats: [{ id: 'visionary' }, { id: 'integrator' }], enabled: true }],
      { councils: { chorus: { label: 'Chorus', seats: [{ id: 'visionary', label: 'Visionary', persona: 'old persona' }, { id: 'integrator', label: 'Integrator' }], chairTemplate: { systemPrompt: 'old system', userPromptTemplate: 'old user' } } } },
    )
    fireEvent.click(await screen.findByLabelText('Expand Chorus'))
    const persona = await screen.findByLabelText('Chorus seat visionary persona')
    fireEvent.change(persona, { target: { value: 'new persona' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save prompts' }))
    await waitFor(() => { expect(mutateBodies(fetchMock)).toHaveLength(1) })
    const ops = mutateBodies(fetchMock)[0]!.payload.args.ops
    expect(ops[0]).toEqual({
      op: 'set',
      path: ['councils', 'chorus', 'seats'],
      value: [
        { id: 'visionary', label: 'Visionary', persona: 'new persona' },
        { id: 'integrator', label: 'Integrator' },
      ],
    })
    expect(ops[1]).toEqual({
      op: 'set',
      path: ['councils', 'chorus', 'chairTemplate'],
      value: { systemPrompt: 'old system', userPromptTemplate: 'old user' },
    })
  })
})
