// @vitest-environment jsdom
/**
 * Roles and Prompts tabs of the Dynamic settings page: the list merges the
 * code defaults with the settings registry (retired entries stay listed so
 * they can be restored), every edit persists as one revision-fenced
 * `settings.mutate` op, tools.available writes the whole array, the retire
 * toggle writes `disabled`, the Prompts tab writes `roles.<id>.persona` (and
 * a built-in gets an override entry), and a rejected write rolls the
 * optimistic value back with one error line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

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
function describeResponse(value: Record<string, unknown>, revision: number): Response {
  return jsonResponse({ result: { ok: true, value: { namespaces: [{ ns: 'enpoi-orchestration', revision, value }] } } })
}

/** One successful `settings.mutate` answer. */
function mutateOk(revision: number): Response {
  return jsonResponse({ result: { ok: true, value: { revision } } })
}

/** One stale-revision rejection. */
function mutateConflict(): Response {
  return jsonResponse({ result: { ok: false, error: { code: 'settings/conflict', message: 'stale', details: {} } } })
}

/**
 * Install one in-memory enpoi-orchestration document behind the settings RPC
 * pair: mutations apply to the document and bump its revision, so a describe
 * issued after a write reads back what the panel persisted.
 * @param initial - the document sections the namespace starts with.
 * @returns the parsed mutate bodies, in call order.
 */
function installFakeSettings(initial: Record<string, unknown>): { mutations: MutateBody[] } {
  let revision = 1
  const value: Record<string, unknown> = structuredClone(initial)
  const mutations: MutateBody[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      method: string
      payload: { args: { ops?: Array<{ op: string; path: Array<string | number>; value?: unknown }> } }
    }
    if (body.method === 'settings.describe') return describeResponse(structuredClone(value), revision)
    mutations.push(body as unknown as MutateBody)
    for (const op of body.payload.args.ops ?? []) {
      const [section, id] = op.path
      if (typeof section !== 'string' || typeof id !== 'string') continue
      const map = (value[section] ??= {}) as Record<string, unknown>
      if (op.op === 'unset') {
        value[section] = Object.fromEntries(
          Object.entries(map).filter(([candidate]) => candidate !== id),
        )
      } else map[id] = op.value
    }
    revision += 1
    return mutateOk(revision)
  }))
  return { mutations }
}

/** Render the Roles tab over a fake document and wait for its first paint. */
async function mountRoles(initial: Record<string, unknown>, waitForText = 'The Oracle'): Promise<{ mutations: MutateBody[] }> {
  const settings = installFakeSettings(initial)
  const mod = await import('../src/client/dynamic/RolesPanel.tsx')
  render(<mod.RolesPanel />)
  await screen.findByText(waitForText)
  return settings
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('RolesPanel', () => {
  it('lists the code defaults merged with settings, retired entries included', async () => {
    await mountRoles({
      roles: {
        muse: { label: 'The Muse', group: 'council' },
        ghost: { label: 'Ghost', disabled: true },
      },
    }, 'Ghost')

    expect(screen.getByText('The Muse')).toBeTruthy()
    // A retired role stays listed so the operator can restore it.
    expect(screen.getByText('Ghost')).toBeTruthy()
    expect(screen.getByText('retired')).toBeTruthy()
    expect(screen.getAllByText('built-in')).toHaveLength(5)
  })

  it('adds a role with one fenced roles.<id> set op', async () => {
    const { mutations } = await mountRoles({ roles: {} })

    fireEvent.change(screen.getByLabelText('New role id'), { target: { value: 'scribe' } })
    fireEvent.change(screen.getByLabelText('New role label'), { target: { value: 'The Scribe' } })
    fireEvent.change(screen.getByLabelText('New role persona'), { target: { value: 'Writes the record.' } })
    fireEvent.change(screen.getByLabelText('New role group'), { target: { value: 'specialists' } })
    fireEvent.click(screen.getByText('Add role'))

    expect(await screen.findByText('The Scribe')).toBeTruthy()
    await waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]?.payload.args).toEqual({
      ns: 'enpoi-orchestration',
      expectedRevision: 1,
      ops: [{
        op: 'set',
        path: ['roles', 'scribe'],
        value: { label: 'The Scribe', persona: 'Writes the record.', group: 'specialists' },
      }],
    })
  })

  it('edits a label on blur and writes the merged settings-over-defaults entry', async () => {
    const { mutations } = await mountRoles({ roles: {} })

    fireEvent.click(screen.getByLabelText('Edit Fixer'))
    const input = screen.getByLabelText('Label for Fixer')
    fireEvent.change(input, { target: { value: 'The Fixer' } })
    fireEvent.blur(input)

    await waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]?.payload.args.ops[0]).toEqual({
      op: 'set',
      path: ['roles', 'fixer'],
      value: { label: 'The Fixer', group: 'specialists', seat: true },
    })
  })

  it('writes the tools.available array and clears it back to the default surface', async () => {
    const { mutations } = await mountRoles({ roles: {} })

    fireEvent.click(screen.getByLabelText('Edit Fixer'))
    fireEvent.click(screen.getByLabelText('Read for Fixer'))
    await waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]?.payload.args.ops[0]?.value).toEqual({
      label: 'Fixer', group: 'specialists', seat: true, tools: { available: ['read'] },
    })

    fireEvent.click(screen.getByLabelText('Bash for Fixer'))
    await waitFor(() => { expect(mutations).toHaveLength(2) })
    expect((mutations[1]?.payload.args.ops[0]?.value as { tools: { available: string[] } }).tools.available)
      .toEqual(['bash', 'read'])

    // Empty = the role's default surface: the override key is dropped entirely.
    // Rapid toggles queue per role, so the LAST write is the second removal.
    fireEvent.click(screen.getByLabelText('Read for Fixer'))
    fireEvent.click(screen.getByLabelText('Bash for Fixer'))
    await waitFor(() => {
      const last = mutations[mutations.length - 1]?.payload.args.ops[0]?.value as Record<string, unknown>
      expect('tools' in last).toBe(false)
    })
  })

  it('retires a role with disabled:true and restores it without the key', async () => {
    const { mutations } = await mountRoles({ roles: {} })

    fireEvent.click(screen.getByLabelText('Retire Fixer'))
    await screen.findByText('retired')
    await waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]?.payload.args.ops[0]).toEqual({
      op: 'set',
      path: ['roles', 'fixer'],
      value: { label: 'Fixer', group: 'specialists', seat: true, disabled: true },
    })

    fireEvent.click(screen.getByLabelText('Restore Fixer'))
    await waitFor(() => { expect(mutations).toHaveLength(2) })
    const restored = mutations[1]?.payload.args.ops[0]?.value as Record<string, unknown>
    expect('disabled' in restored).toBe(false)
  })

  it('deletes a user role with an unset op and explains the built-in default', async () => {
    const { mutations } = await mountRoles({ roles: { muse: { label: 'The Muse', group: 'council' } } }, 'The Muse')

    fireEvent.click(screen.getByLabelText('Edit The Muse'))
    expect(screen.getByText('Delete removes this role from the registry.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Delete The Muse'))

    await waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]?.payload.args.ops[0]).toEqual({ op: 'unset', path: ['roles', 'muse'] })
    await waitFor(() => { expect(screen.queryByText('The Muse')).toBeNull() })
  })

  it('publishes an edit at 0ms and rolls it back when the write is rejected', async () => {
    let release: ((res: Response) => void) | undefined
    const gate = new Promise<Response>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      if (body.method === 'settings.describe') return describeResponse({ roles: {} }, 1)
      return gate
    }))
    const mod = await import('../src/client/dynamic/RolesPanel.tsx')
    const { getStatus } = await import('../src/client/dynamic/status.ts')
    render(<mod.RolesPanel />)
    await screen.findByText('The Oracle')

    fireEvent.click(screen.getByLabelText('Retire Fixer'))
    // 0ms optimistic state, before the write settles.
    expect(await screen.findByText('retired')).toBeTruthy()

    release?.(jsonResponse({ result: { ok: false, error: { code: 'internal', message: 'nope', details: {} } } }))
    // The failure is hoisted to the section status line, so it survives a tab switch.
    await waitFor(() => {
      expect(getStatus()).toBe('Could not save Fixer — the change was reverted.')
    })
    await waitFor(() => { expect(screen.queryByText('retired')).toBeNull() })
  })

  it('re-reads after a settings/conflict and re-applies onto the fresh entry', async () => {
    let serverLabel = 'Old'
    let revision = 1
    const mutations: MutateBody[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string }
      if (body.method === 'settings.describe') {
        return describeResponse({ roles: { fixer: { label: serverLabel } } }, revision)
      }
      mutations.push(body as unknown as MutateBody)
      if (mutations.length === 1) {
        serverLabel = 'Remote'
        revision = 2
        return mutateConflict()
      }
      return mutateOk(revision)
    }))
    const mod = await import('../src/client/dynamic/RolesPanel.tsx')
    render(<mod.RolesPanel />)
    // Wait for the settings entry (label "Old"), not the code-default first paint.
    await screen.findByText('Old')

    fireEvent.click(screen.getByLabelText('Retire Old'))
    await waitFor(() => { expect(mutations).toHaveLength(2) })
    // The retry carries the NEW revision and the operator's retire applied on
    // top of the value the other client wrote in between (no clobber).
    expect(mutations[1]?.payload.args.expectedRevision).toBe(2)
    expect(mutations[1]?.payload.args.ops[0]?.value).toEqual({
      label: 'Remote', group: 'specialists', seat: true, disabled: true,
    })
  })
})

describe('PromptsPanel', () => {
  it('writes a built-in persona into a new override entry and shows council prompts read-only', async () => {
    const settings = installFakeSettings({
      roles: {},
      councils: {
        alpha: {
          label: 'Alpha Council',
          seats: [{ id: 'skeptic' }, { id: 'architect' }],
          chairTemplate: { systemPrompt: 'Summarize the debate.' },
        },
      },
    })
    const mod = await import('../src/client/dynamic/PromptsPanel.tsx')
    render(<mod.PromptsPanel />)

    const persona = await screen.findByLabelText('Persona for The Oracle')
    fireEvent.change(persona, { target: { value: 'You are the oracle.' } })
    fireEvent.blur(persona)

    await waitFor(() => { expect(settings.mutations).toHaveLength(1) })
    expect(settings.mutations[0]?.payload.args.ops[0]).toEqual({
      op: 'set',
      path: ['roles', 'oracle'],
      value: { label: 'The Oracle', group: 'supervision', seat: true, persona: 'You are the oracle.' },
    })

    // Council prompts are read-only here.
    expect(screen.getByText('Edited in Councils')).toBeTruthy()
    expect(screen.getByText('Seats: skeptic, architect')).toBeTruthy()
    expect(screen.getByText('Chair system prompt: Summarize the debate.')).toBeTruthy()
    expect(screen.getByText('Chair user template: none')).toBeTruthy()
  })
})
