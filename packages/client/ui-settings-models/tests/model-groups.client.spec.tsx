// @vitest-environment jsdom
/**
 * Model groups registry parse/write and the Providers-page row behavior.
 *
 * Every surface reads the host's resolved-group artifact
 * (`modelChains.resolved`); the row never parses the raw `chains` map. Writes
 * are leaf patches, so stored `selectors`/`adopt`/`attempts`/`onCut`/`label`/
 * `disabled` survive an edit that does not touch them.
 */
import type { ReactElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { refreshModelGroups } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ModelGroupsRow } from '../src/client/ModelGroupsRow.tsx'
import type { ModelGroupsRowProps } from '../src/client/ModelGroupsRow.tsx'
import {
  groupEditOps, groupWriteOps, parseModelGroups, sameModelGroups, writeGroupOps,
} from '../src/client/model-groups.ts'
import type { ModelPickerFace } from '../src/client/picker-face.ts'
import { en } from '../src/client/locales.ts'
import css from '../src/client/ModelGroups.module.css'

const t: ModelGroupsRowProps['t'] = (key, params) => {
  const template = en[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function namespaceOf(): SettingsNamespaceView {
  return {
    ns: 'enpoi-orchestration',
    schema: {},
    value: {},
    autoGenerate: true,
    applies: 'live',
    secrets: [],
    revision: 3,
  }
}

const STABLE = {
  id: 'stable',
  label: 'Stable',
  links: [
    { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
    { provider: 'opencode-go', model: 'mimo-v2.5' },
  ],
  members: [
    { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
    { provider: 'opencode-go', model: 'mimo-v2.5' },
  ],
  selectors: [],
  selectorMatches: [],
  candidates: [],
  warnings: [],
  attempts: 2,
  onCut: 'failover',
  disabled: false,
  source: 'settings',
}

/** The shipped built-in: selectors only, read-only until customized. */
const BUILTIN_FREE = {
  id: 'free',
  label: 'Free',
  links: [],
  selectors: [{
    when: { zeroPrice: true, tools: true, gated: false, visible: true, minContextWindow: 65536 },
    adopt: true,
  }],
  selectorMatches: [{
    index: 0,
    when: { zeroPrice: true, tools: true, gated: false, visible: true, minContextWindow: 65536 },
    adopt: true,
    links: [{ provider: 'groq', model: 'free-tool' }],
    warnings: [],
  }],
  members: [{ provider: 'groq', model: 'free-tool' }],
  candidates: [],
  warnings: [],
  attempts: 2,
  onCut: 'failover',
  disabled: false,
  source: 'builtin',
}

/** A selector-only group: no explicit link, members resolved live. */
const FREE = {
  id: 'free',
  label: 'Free tools',
  links: [],
  selectors: [{ when: { zeroPrice: true, tools: true, minContextWindow: 32768 }, adopt: false }],
  selectorMatches: [{
    index: 0,
    when: { zeroPrice: true, tools: true, minContextWindow: 32768 },
    adopt: false,
    links: [{ provider: 'groq', model: 'free-tool' }],
    warnings: [],
  }],
  members: [{ provider: 'groq', model: 'free-tool' }],
  candidates: [{ provider: 'groq', model: 'newer-tool' }],
  warnings: ['1 new selector match(es) awaiting adoption (adopt: false): groq/newer-tool'],
  attempts: 3,
  onCut: 'continue',
  disabled: false,
  source: 'settings',
}

let artifactValue: unknown = {}
let revision = 1
let fetchMock: ReturnType<typeof vi.fn>

/** Answer the settings artifact channel with the current fixture. */
function stubArtifactReader(): void {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: {
        ok: true,
        value: { key: 'modelChains.resolved', revision: revision++, changed: true, value: artifactValue },
      },
    }),
  }))
  vi.stubGlobal('fetch', fetchMock)
}

/** Publish one artifact fixture through the real revision-aware reader. */
async function seed(value: unknown): Promise<void> {
  artifactValue = value
  stubArtifactReader()
  await refreshModelGroups()
  // The import-time prime may have answered first; the second read is the
  // one this test owns.
  await refreshModelGroups()
}

/** Apply path operations the way the host's settings mutate does. */
function applyOps(
  document: Record<string, unknown>,
  ops: ReadonlyArray<{ op: string; path: readonly string[]; value?: unknown }>,
): Record<string, unknown> {
  const next = structuredClone(document)
  for (const op of ops) {
    const path = [...op.path]
    let cursor: Record<string, unknown> = next
    for (const key of path.slice(0, -1)) {
      const child = cursor[key]
      if (child === null || typeof child !== 'object' || Array.isArray(child)) throw new Error(`missing ${path.join('.')}`)
      cursor = child as Record<string, unknown>
    }
    const leaf = path.at(-1)!
    if (op.op === 'unset') Reflect.deleteProperty(cursor, leaf)
    else cursor[leaf] = structuredClone(op.value)
  }
  return next
}

/** A settings wire face whose describe answers one revision and whose mutate is scripted. */
function wire(mutate: ReturnType<typeof vi.fn>, revision = 3): ModelGroupsRowProps['api'] {
  return {
    settings: {
      describe: vi.fn(async () => ({
        ok: true as const,
        value: { namespaces: [{ ns: 'enpoi-orchestration', revision }], writable: true },
      })),
      mutate,
      update: vi.fn(),
      replace: vi.fn(),
    },
  } as unknown as ModelGroupsRowProps['api']
}

function pickerFace(): ModelPickerFace {
  return {
    available: true,
    directory: createSnapshotStore<ModelDirectoryState>({
      current: null,
      routable: null,
      groups: [{
        id: 'antigravity',
        name: 'Antigravity',
        models: [{ id: 'gemini-3.8-flash-tiered', name: 'Gemini 3.8 Flash' }],
      }],
      failures: [],
      pending: null,
      status: 'ready',
      error: null,
    }),
    load: vi.fn(),
  }
}

/** The same face, but the model advertises reasoning levels like a seat route. */
function reasoningPickerFace(): ModelPickerFace {
  return {
    available: true,
    directory: createSnapshotStore<ModelDirectoryState>({
      current: null,
      routable: null,
      groups: [{
        id: 'antigravity',
        name: 'Antigravity',
        models: [{
          id: 'gemini-3.8-flash-tiered',
          name: 'Gemini 3.8 Flash',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'high',
          },
        }],
      }],
      failures: [],
      pending: null,
      status: 'ready',
      error: null,
    }),
    load: vi.fn(),
  }
}

/** Render harness: one row over the seeded artifact. */
function renderRow(overrides: Partial<ModelGroupsRowProps> = {}): ReturnType<typeof render> {
  return render(<ModelGroupsRow
    namespace={namespaceOf()}
    api={wire(vi.fn())}
    readOnly={false}
    picker={null}
    t={t}
    modelT={key => key}
    onSaved={vi.fn()}
    {...overrides}
  />)
}

beforeEach(async () => {
  localStorage.clear()
  await seed({})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('model groups registry', () => {
  it('defaults attempts/onCut and drops malformed entries and links', () => {
    const groups = parseModelGroups({
      stable: {
        links: [{ provider: 'a', model: 'm' }, { provider: '', model: 'x' }, 'nope'],
        disabled: true,
      },
      broken: { attempts: 0, onCut: 'restart' },
    })
    expect(groups).toEqual([
      {
        id: 'stable', label: 'stable', links: [{ provider: 'a', model: 'm' }], members: [{ provider: 'a', model: 'm' }],
        selectors: [], selectorMatches: [], candidates: [], warnings: [], attempts: 2, onCut: 'failover',
        disabled: true, source: 'settings',
      },
      {
        id: 'broken', label: 'broken', links: [], members: [], selectors: [], selectorMatches: [], candidates: [],
        warnings: [], attempts: 2, onCut: 'failover', disabled: false, source: 'settings',
      },
    ])
    expect(parseModelGroups(null)).toEqual([])
  })

  it('writes the whole spec under chains.<id> for a NEW group only', () => {
    expect(groupWriteOps({
      ...parseModelGroups({ stable: STABLE })[0]!,
      label: 'Stable',
      attempts: 3,
      onCut: 'continue',
      disabled: false,
    })).toEqual([{
      op: 'set',
      path: ['chains', 'stable'],
      value: {
        label: 'Stable',
        links: STABLE.links,
        attempts: 3,
        onCut: 'continue',
        disabled: false,
      },
    }])
  })

  it('keeps a valid link effort, drops an invalid one, and writes effort only when set', () => {
    const groups = parseModelGroups({
      stable: {
        links: [
          { provider: 'a', model: 'm', effort: ' high ' },
          { provider: 'b', model: 'm', effort: 7 },
          { provider: 'c', model: 'm', effort: '   ' },
        ],
      },
    })
    // A non-string or blank effort is absent, never a stored empty string.
    expect(groups[0]!.links).toEqual([
      { provider: 'a', model: 'm', effort: 'high' },
      { provider: 'b', model: 'm' },
      { provider: 'c', model: 'm' },
    ])
    expect(groupWriteOps({
      ...groups[0]!,
      label: 'Stable',
      links: [{ provider: 'a', model: 'm', effort: 'max' }, { provider: 'b', model: 'm' }],
      disabled: false,
    })).toEqual([{
      op: 'set',
      path: ['chains', 'stable'],
      value: {
        label: 'Stable',
        links: [{ provider: 'a', model: 'm', effort: 'max' }, { provider: 'b', model: 'm' }],
        attempts: 2,
        onCut: 'failover',
        disabled: false,
      },
    }])
  })

  it('compares parsed groups by stored value, not by object identity', () => {
    const before = parseModelGroups({ stable: STABLE })
    const echoed = parseModelGroups({ stable: STABLE })
    expect(sameModelGroups(before, echoed)).toBe(true)
    expect(sameModelGroups(before, parseModelGroups({ stable: { ...STABLE, label: 'Renamed' } }))).toBe(false)
    expect(sameModelGroups(before, parseModelGroups({ stable: { ...STABLE, attempts: 3 } }))).toBe(false)
    expect(sameModelGroups(before, parseModelGroups({ stable: { ...STABLE, links: [] } }))).toBe(false)
    expect(sameModelGroups(before, parseModelGroups({ stable: { ...STABLE, selectors: [{ when: { tools: true } }] } }))).toBe(false)
    expect(sameModelGroups(before, parseModelGroups({ stable: STABLE, extra: STABLE }))).toBe(false)
    // The resolved projection is not a stored value: a catalogue change that
    // only moves members must not read as an edit.
    expect(sameModelGroups(
      before,
      parseModelGroups({ stable: { ...STABLE, members: [{ provider: 'x', model: 'y' }], warnings: ['moved'] } }),
    )).toBe(true)
  })

  it('patches only the changed fields of an edit', () => {
    const before = parseModelGroups({ free: FREE })[0]!
    expect(groupEditOps({ ...before, label: 'Renamed' }, before)).toEqual([
      { op: 'set', path: ['chains', 'free', 'label'], value: 'Renamed' },
    ])
    expect(groupEditOps({
      ...before,
      links: [{ provider: 'groq', model: 'free-tool', effort: 'max' }],
    }, before)).toEqual([{
      op: 'set',
      path: ['chains', 'free', 'links'],
      value: [{ provider: 'groq', model: 'free-tool', effort: 'max' }],
    }])
    expect(groupEditOps({ ...before, attempts: 4, onCut: 'failover' }, before)).toEqual([
      { op: 'set', path: ['chains', 'free', 'attempts'], value: 4 },
      { op: 'set', path: ['chains', 'free', 'onCut'], value: 'failover' },
    ])
    expect(groupEditOps({ ...before }, before)).toEqual([])
  })

  it('retries a conflict and reports a persistent rejection', async () => {
    const mutate = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'settings/conflict', message: 'stale' } })
      .mockResolvedValueOnce({ ok: true, value: {} })
    await expect(writeGroupOps(wire(mutate), [])).resolves.toBeNull()
    expect(mutate).toHaveBeenCalledTimes(2)

    const refused = vi.fn(async () => ({ ok: false, error: { code: 'settings/read-only', message: 'nope' } }))
    await expect(writeGroupOps(wire(refused), [])).resolves.toEqual({ code: 'rejected', message: 'nope' })
  })
})

describe('Model groups row', () => {
  it('is always reachable: with zero groups it is one collapsed creation line', () => {
    renderRow()
    const toggle = screen.getByRole('button', { name: /Model groups/ })
    expect(toggle.textContent).toContain('· 0')
    fireEvent.click(toggle)
    expect(screen.getByText(en.groupsEmpty)).toBeTruthy()
  })

  it('lists groups collapsed, then disables one through a fenced leaf write', async () => {
    await seed({ stable: STABLE })
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    renderRow({ api: wire(mutate) })
    const toggle = screen.getByRole('button', { name: /Model groups/ })
    expect(toggle.textContent).toContain('· 1')
    expect(screen.queryByText('Stable')).toBeNull()

    fireEvent.click(toggle)
    expect(screen.getByText('Stable')).toBeTruthy()
    expect(screen.getByText(/antigravity → opencode-go/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith('enpoi-orchestration', [{
        op: 'set',
        path: ['chains', 'stable', 'disabled'],
        value: true,
      }], 3)
    })
  })

  it('renders a selector-only group with its resolved member count and a dynamic marker', async () => {
    await seed({ free: FREE })
    renderRow()
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    expect(screen.getByText('Free tools')).toBeTruthy()
    expect(screen.getByText(new RegExp(en.groupsDynamic))).toBeTruthy()
    // No explicit link (0 stored links) but one resolved member: the row must
    // count members, not stored links, and must not call it dangling.
    expect(screen.getByText('1 model')).toBeTruthy()
    expect(screen.queryByText(en.groupsDangling)).toBeNull()
    expect(screen.getByText(/groq/)).toBeTruthy()
  })

  it('keeps the optimistic overlay across a settings echo with the same groups', async () => {
    await seed({ stable: STABLE })
    const gate = { promise: undefined as unknown as Promise<{ ok: true; value: unknown }>, resolve: () => {} }
    gate.promise = new Promise((resolve) => { gate.resolve = () => { resolve({ ok: true, value: {} }) } })
    const mutate = vi.fn(() => gate.promise)
    const element = (): ReactElement => <ModelGroupsRow
      namespace={namespaceOf()}
      api={wire(mutate)}
      readOnly={false}
      picker={null}
      t={t}
      modelT={key => key}
      onSaved={vi.fn()}
    />
    const view = render(element())
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy() })

    // The settings echo republishes a fresh namespace object carrying the same
    // stored artifact: the optimistic Disable must survive it.
    view.rerender(element())
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()

    gate.resolve()
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  })

  it('clears the overlay when the stored projection actually moves', async () => {
    await seed({ stable: STABLE })
    const gate = { promise: undefined as unknown as Promise<{ ok: true; value: unknown }>, resolve: () => {} }
    gate.promise = new Promise((resolve) => { gate.resolve = () => { resolve({ ok: true, value: {} }) } })
    const mutate = vi.fn(() => gate.promise)
    const element = (namespace: SettingsNamespaceView): ReactElement => <ModelGroupsRow
      namespace={namespace}
      api={wire(mutate)}
      readOnly={false}
      picker={null}
      t={t}
      modelT={key => key}
      onSaved={vi.fn()}
    />
    const view = render(element(namespaceOf()))
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy() })

    // Another client renamed the group: the projection moved, so the host
    // truth replaces the optimistic overlay.
    artifactValue = { stable: { ...STABLE, label: 'Renamed' } }
    view.rerender(element(namespaceOf()))
    await waitFor(() => { expect(screen.getByText('Renamed')).toBeTruthy() })
    expect(screen.getByRole('button', { name: 'Disable' })).toBeTruthy()

    gate.resolve()
    await waitFor(() => { expect(mutate).toHaveBeenCalled() })
  })

  it('flags a dangling group (no links and no selectors) instead of offering it', async () => {
    await seed({
      broken: {
        ...STABLE,
        id: 'broken',
        label: 'Broken',
        links: [],
        members: [],
        selectors: [],
      },
    })
    renderRow()
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    expect(screen.getByText(en.groupsDangling)).toBeTruthy()
  })

  it('shows a disabled group as disabled', async () => {
    await seed({ stable: { ...STABLE, disabled: true } })
    renderRow()
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    expect(screen.getByText(new RegExp(en.groupsDisabled))).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
  })

  it('creates a group with a picker-chosen link and an Advanced onCut', async () => {
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    const onSaved = vi.fn()
    renderRow({ api: wire(mutate), picker: pickerFace(), onSaved })
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    fireEvent.click(screen.getByRole('button', { name: 'New group' }))

    fireEvent.change(screen.getByLabelText('Group id'), { target: { value: 'fallback' } })
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Fallback' } })
    // No links yet: the row refuses to save with the localized reason.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert').textContent).toBe(en.groupsLinksRequired)

    // Add a link through the shared picker, then take the Advanced default branch.
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }))
    fireEvent.click(screen.getByText('Gemini 3.8 Flash'))
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    fireEvent.change(screen.getByLabelText('On stream cut'), { target: { value: 'continue' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith('enpoi-orchestration', [{
        op: 'set',
        path: ['chains', 'fallback'],
        value: {
          label: 'Fallback',
          links: [{ provider: 'antigravity', model: 'gemini-3.8-flash-tiered' }],
          attempts: 2,
          onCut: 'continue',
          disabled: false,
        },
      }], 3)
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('mirrors the seat effort pill on a link and patches only the link list', async () => {
    await seed({
      stable: {
        ...STABLE,
        links: [
          { provider: 'antigravity', model: 'gemini-3.8-flash-tiered', effort: 'low' },
          { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
        ],
      },
    })
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    renderRow({ api: wire(mutate), picker: reasoningPickerFace() })
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    // The link row carries the shared picker's effort pill: the stored effort
    // paints verbatim and stays editable while the group is in edit mode; a
    // link without one shows the model default (High), like a seat row.
    const effortTrigger = await screen.findByRole('button', { name: 'Low' })
    expect((effortTrigger as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole('button', { name: 'High' })).toBeTruthy()
    fireEvent.click(effortTrigger)
    fireEvent.click(screen.getByRole('button', { name: 'Max' }))

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith('enpoi-orchestration', [{
        op: 'set',
        path: ['chains', 'stable', 'links'],
        value: [
          { provider: 'antigravity', model: 'gemini-3.8-flash-tiered', effort: 'max' },
          { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
        ],
      }], 3)
    })
  })

  it('renames a group with a label-only patch that keeps the stored links', async () => {
    await seed({ stable: STABLE })
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    renderRow({ api: wire(mutate) })
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const label = screen.getByLabelText<HTMLInputElement>('Label')
    expect(label.disabled).toBe(false)
    expect(screen.getByLabelText<HTMLInputElement>('Group id').disabled).toBe(true)
    fireEvent.change(label, { target: { value: 'Rock solid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith('enpoi-orchestration', [{
        op: 'set',
        path: ['chains', 'stable', 'label'],
        value: 'Rock solid',
      }], 3)
    })
  })

  it('round-trips a selector-only group: renaming never drops its selectors', async () => {
    await seed({ free: FREE })
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    renderRow({ api: wire(mutate) })
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    // A selector-only group saves with zero explicit links: its members are
    // resolved by the selector, and the editor has no selector UI to re-add one.
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Free forever' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    let ops: SettingsPathOpView[] = []
    await waitFor(() => {
      const call = mutate.mock.calls[0] as unknown as [string, SettingsPathOpView[]]
      expect(call[0]).toBe('enpoi-orchestration')
      ops = call[1]
    })
    // The patch touches the label only: nothing else is rewritten.
    expect(ops).toEqual([{ op: 'set', path: ['chains', 'free', 'label'], value: 'Free forever' }])

    // Applying it to the stored row leaves the selectors byte-for-byte equal.
    const stored = {
      chains: {
        free: {
          label: 'Free tools',
          links: [],
          selectors: [{ when: { zeroPrice: true, tools: true, minContextWindow: 32768 }, adopt: false }],
          attempts: 3,
          onCut: 'continue',
          disabled: false,
        },
      },
    }
    const next = applyOps(stored, ops)
    const written = (next.chains as Record<string, Record<string, unknown>>).free!
    expect(written.label).toBe('Free forever')
    expect(JSON.stringify(written.selectors)).toBe(JSON.stringify(stored.chains.free.selectors))
    expect(written.attempts).toBe(3)
    expect(written.onCut).toBe('continue')
    expect(written.disabled).toBe(false)
  })

  it('toggles a selector-only group without touching selectors, label, or attempts', async () => {
    await seed({ free: FREE })
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    renderRow({ api: wire(mutate) })
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))

    let ops: SettingsPathOpView[] = []
    await waitFor(() => {
      const call = mutate.mock.calls[0] as unknown as [string, SettingsPathOpView[]]
      ops = call[1]
    })
    expect(ops).toEqual([{ op: 'set', path: ['chains', 'free', 'disabled'], value: true }])

    const stored = {
      chains: {
        free: {
          label: 'Free tools',
          links: [],
          selectors: [{ when: { zeroPrice: true, tools: true }, adopt: false }],
          attempts: 3,
          onCut: 'continue',
          disabled: false,
        },
      },
    }
    const next = applyOps(stored, ops)
    const written = (next.chains as Record<string, Record<string, unknown>>).free!
    expect(written.disabled).toBe(true)
    expect(JSON.stringify(written.selectors)).toBe(JSON.stringify(stored.chains.free.selectors))
    expect(written.label).toBe('Free tools')
    expect(written.attempts).toBe(3)
  })

  it('renders a built-in read-only with Customize and no edit or disable', async () => {
    await seed({ free: BUILTIN_FREE })
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    renderRow({ api: wire(mutate) })
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    expect(screen.getByText('Free')).toBeTruthy()
    expect(screen.getByText(new RegExp(en.groupsBuiltin))).toBeTruthy()
    expect(screen.getByRole('button', { name: en.groupsCustomize })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Disable' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('customizes a built-in by copying its whole spec, selectors included', async () => {
    await seed({ free: BUILTIN_FREE })
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    const onSaved = vi.fn()
    renderRow({ api: wire(mutate), onSaved })
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    fireEvent.click(screen.getByRole('button', { name: en.groupsCustomize }))

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith('enpoi-orchestration', [{
        op: 'set',
        path: ['chains', 'free'],
        value: {
          label: 'Free',
          links: [],
          selectors: BUILTIN_FREE.selectors,
          attempts: 2,
          onCut: 'failover',
          disabled: false,
        },
      }], 3)
    })
    expect(onSaved).toHaveBeenCalled()
    // The copied row is now an ordinary settings group the editor can edit.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
  })

  it('resets a settings row that shadows a built-in back to the shipped group', async () => {
    await seed({ free: { ...BUILTIN_FREE, source: 'settings', overridesBuiltin: true } })
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    renderRow({ api: wire(mutate) })
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    fireEvent.click(screen.getByRole('button', { name: en.groupsReset }))

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith('enpoi-orchestration', [{
        op: 'unset',
        path: ['chains', 'free'],
      }], 3)
    })
  })

  it('preserves header-only layout when collapsed and attaches scroll class to body when expanded', async () => {
    await seed({ stable: STABLE })
    const { container } = renderRow()

    // Collapsed: header is present, but body is omitted from DOM
    expect(container.querySelector(`.${css.header}`)).not.toBeNull()
    expect(container.querySelector(`.${css.body}`)).toBeNull()

    // Expand: body mounts carrying the scrollable body class
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    const body = container.querySelector(`.${css.body}`)
    expect(body).not.toBeNull()
    expect(body?.className).toContain(css.body)
  })
})
