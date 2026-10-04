// @vitest-environment jsdom
/**
 * Permissions availability eye: an agent row's eye toggles the tool into and
 * out of `permissions.agents[role].available` through the same fenced
 * settings.mutate path every other control uses. An explicit allowlist is the
 * hard gate, so the row must show exactly it — never OR it with the shipped
 * role surface, which made every click on a built-in-surface tool look inert
 * (the eye stayed on after the write dropped the tool).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

/** One parsed `settings.mutate` request body. */
interface MutateBody {
  method: string
  payload: {
    args: {
      ns: string
      expectedRevision?: number
      ops: Array<{ op: string; path: Array<string | number>; value?: unknown }>
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

/** Set one path inside the fake document (leaf write, all intermediate maps). */
function setAt(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
  let node: Record<string | number, unknown> = root
  for (const key of path.slice(0, -1)) {
    const next = node[key]
    if (next === null || typeof next !== 'object') node[key] = {}
    node = node[key] as Record<string | number, unknown>
  }
  node[path[path.length - 1]!] = value
}

/** Delete one path inside the fake document (the unset op's own semantics). */
function unsetAt(root: Record<string, unknown>, path: readonly (string | number)[]): void {
  let node: Record<string | number, unknown> = root
  for (const key of path.slice(0, -1)) {
    const next = node[key]
    if (next === null || typeof next !== 'object') return
    node = node[key] as Record<string | number, unknown>
  }
  Reflect.deleteProperty(node, path[path.length - 1]!)
}

/**
 * Install one in-memory enpoi-orchestration document behind the settings RPC
 * pair: mutations apply to the document and bump its revision, so a describe
 * issued after a write reads back what the page persisted.
 * @param initial - the sections the namespace starts with.
 * @param tools - the live tool registry the capabilities RPC answers.
 * @returns the parsed mutate bodies, in call order.
 */
function installFakeSettings(initial: Record<string, unknown>, tools: readonly string[]): { mutations: MutateBody[] } {
  let revision = 1
  const value: Record<string, unknown> = structuredClone(initial)
  const mutations: MutateBody[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as MutateBody
    if (body.method === 'settings.describe') return describeResponse(structuredClone(value), revision)
    if (body.method === 'enpoiCapabilities.registeredTools') {
      return jsonResponse({ result: { ok: true, value: { tools } } })
    }
    mutations.push(body)
    for (const op of body.payload.args.ops) {
      if (op.op === 'unset') unsetAt(value, op.path)
      else setAt(value, op.path, op.value)
    }
    revision += 1
    return jsonResponse({ result: { ok: true, value: { revision } } })
  }))
  return { mutations }
}

/** Render the Permissions section over a fake document and wait for its first paint. */
async function mount(
  initial: Record<string, unknown>,
  tools: readonly string[],
): Promise<{ mutations: MutateBody[] }> {
  const settings = installFakeSettings(initial, tools)
  const mod = await import('../src/client/PermissionsSettings.tsx')
  render(<mod.PermissionsSettings close={vi.fn()} />)
  await screen.findByText('Global (all agents)')
  fireEvent.click(screen.getByRole('button', { name: 'The Oracle' }))
  return settings
}

/** The availability eye of the tool row carrying `name`. */
function eyeFor(name: string): HTMLButtonElement {
  const row = screen.getByText(name).parentElement!.parentElement!
  return within(row).getByTitle(/this role allowlist/) as HTMLButtonElement
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('permissions availability eye', () => {
  it('flips a shipped-surface tool out of the allowlist and back, persisting each write', async () => {
    const { mutations } = await mount({ permissions: { defaults: { unknownTools: 'ask' } } }, ['bash', 'read', 'edit'])

    // No explicit allowlist yet: the shipped role surface paints bash on.
    const before = eyeFor('Bash')
    expect(before.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(before)
    // The write dropped bash from the role's own list: the eye must follow.
    expect(eyeFor('Bash').getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => { expect(mutations).toHaveLength(1) })
    const first = mutations[0]!.payload.args.ops[0]!
    expect(first.path).toEqual(['permissions', 'agents', 'oracle', 'available'])
    expect(first.value as string[]).not.toContain('bash')
    expect(first.value as string[]).toContain('read')

    // A second click reads the persisted list back and re-adds the tool.
    fireEvent.click(eyeFor('Bash'))
    expect(eyeFor('Bash').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => { expect(mutations).toHaveLength(2) })
    const second = mutations[1]!.payload.args.ops[0]!
    expect(second.value as string[]).toContain('bash')
  })

  it('reads an explicit allowlist as the hard gate, without OR-ing the shipped surface back in', async () => {
    const { mutations } = await mount(
      { permissions: { defaults: { unknownTools: 'ask' }, agents: { oracle: { available: ['read'] } } } },
      ['bash', 'read', 'edit'],
    )

    expect(eyeFor('Read').getAttribute('aria-pressed')).toBe('true')
    // bash is in the shipped surface but NOT in the operator's list: off.
    expect(eyeFor('Bash').getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(eyeFor('Bash'))
    expect(eyeFor('Bash').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]!.payload.args.ops[0]!.value).toEqual(['bash', 'read'])
  })

  it('concrete rows keep their eye toggle on the role allowlist', async () => {
    await mount({ permissions: { defaults: { unknownTools: 'ask' } } }, ['bash', 'read'])
    expect(eyeFor('Bash').getAttribute('aria-pressed')).toBe('true')
    expect(eyeFor('Read').getAttribute('aria-pressed')).toBe('true')
  })

  it('presents the creator-only tools as available to the creator seat alone', async () => {
    await mount(
      { permissions: { defaults: { unknownTools: 'ask' } } },
      ['read', 'plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query'],
    )

    // The creator pre-attaches the creator tool group, so its family row (the
    // three harness-authoring tools fold into it) shows available.
    fireEvent.click(screen.getByRole('button', { name: /creator/ }))
    expect(eyeFor('Creator (harness authoring)').getAttribute('aria-pressed')).toBe('true')

    // Orchestrator and sysadmin hold the shared surface: the row shows off
    // and carries NO toggle, because the allowlist could never make a
    // seat-denied tool visible.
    for (const seat of [/orchestrator/, /sysadmin/]) {
      fireEvent.click(screen.getByRole('button', { name: seat }))
      const row = screen.getByText('Creator (harness authoring)').parentElement!.parentElement!
      expect(within(row).queryByTitle(/this role allowlist/)).toBeNull()
    }
  })
})
