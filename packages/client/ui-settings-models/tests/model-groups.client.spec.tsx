// @vitest-environment jsdom
/** Model groups registry parse/write and the Providers-page row behavior. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ModelGroupsRow } from '../src/client/ModelGroupsRow.tsx'
import type { ModelGroupsRowProps } from '../src/client/ModelGroupsRow.tsx'
import {
  groupWriteOps, parseModelGroups, writeGroupOps,
} from '../src/client/model-groups.ts'
import type { ModelPickerFace } from '../src/client/picker-face.ts'
import { en } from '../src/client/locales.ts'

const t: ModelGroupsRowProps['t'] = (key, params) => {
  const template = en[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function namespaceOf(chains: unknown): SettingsNamespaceView {
  return {
    ns: 'enpoi-orchestration',
    schema: {} as never,
    value: { chains } as never,
    autoGenerate: true,
    applies: 'live',
    secrets: [],
    revision: 3,
  }
}

const STABLE = {
  label: 'Stable',
  links: [
    { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
    { provider: 'opencode-go', model: 'mimo-v2.5' },
  ],
  attempts: 2,
  onCut: 'failover',
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

beforeEach(() => {
  localStorage.clear()
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
      { id: 'stable', label: 'stable', links: [{ provider: 'a', model: 'm' }], attempts: 2, onCut: 'failover', disabled: true },
      { id: 'broken', label: 'broken', links: [], attempts: 2, onCut: 'failover', disabled: false },
    ])
    expect(parseModelGroups(null)).toEqual([])
  })

  it('writes the whole spec under chains.<id>', () => {
    expect(groupWriteOps({
      id: 'stable', label: 'Stable', links: [{ provider: 'a', model: 'm' }], attempts: 3, onCut: 'continue', disabled: false,
    })).toEqual([{
      op: 'set',
      path: ['chains', 'stable'],
      value: {
        label: 'Stable',
        links: [{ provider: 'a', model: 'm' }],
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
      id: 'stable', label: 'Stable', links: [{ provider: 'a', model: 'm', effort: 'max' }, { provider: 'b', model: 'm' }], attempts: 2, onCut: 'failover', disabled: false,
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
    // The row is the only place a group can be created, so it must never be
    // hidden by the empty registry (a first group would be impossible to make).
    render(<ModelGroupsRow
      namespace={namespaceOf(undefined)}
      api={wire(vi.fn())}
      readOnly={false}
      picker={null}
      t={t}
      modelT={key => key}
      onSaved={vi.fn()}
    />)
    const toggle = screen.getByRole('button', { name: /Model groups/ })
    expect(toggle.textContent).toContain('· 0')
    fireEvent.click(toggle)
    expect(screen.getByText(en.groupsEmpty)).toBeTruthy()
  })

  it('lists groups collapsed, then disables one through a fenced write', async () => {
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    render(<ModelGroupsRow
      namespace={namespaceOf({ stable: STABLE })}
      api={wire(mutate)}
      readOnly={false}
      picker={null}
      t={t}
      modelT={key => key}
      onSaved={vi.fn()}
    />)
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

  it('flags a dangling group (no valid links) instead of offering it as an assignment', () => {
    render(<ModelGroupsRow
      namespace={namespaceOf({ broken: { label: 'Broken', links: [{ provider: '', model: '' }] } })}
      api={wire(vi.fn())}
      readOnly={false}
      picker={null}
      t={t}
      modelT={key => key}
      onSaved={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    expect(screen.getByText(en.groupsDangling)).toBeTruthy()
  })

  it('creates a group with a picker-chosen link and an Advanced onCut', async () => {
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    const onSaved = vi.fn()
    render(<ModelGroupsRow
      namespace={namespaceOf({})}
      api={wire(mutate)}
      readOnly={false}
      picker={pickerFace()}
      t={t}
      modelT={key => key}
      onSaved={onSaved}
    />)
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

  it('mirrors the seat effort pill on a link and saves the chosen effort', async () => {
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    render(<ModelGroupsRow
      namespace={namespaceOf({
        stable: {
          label: 'Stable',
          links: [
            { provider: 'antigravity', model: 'gemini-3.8-flash-tiered', effort: 'low' },
            { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
          ],
          attempts: 2,
          onCut: 'failover',
        },
      })}
      api={wire(mutate)}
      readOnly={false}
      picker={reasoningPickerFace()}
      t={t}
      modelT={key => key}
      onSaved={vi.fn()}
    />)
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
        path: ['chains', 'stable'],
        value: {
          label: 'Stable',
          links: [
            { provider: 'antigravity', model: 'gemini-3.8-flash-tiered', effort: 'max' },
            { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
          ],
          attempts: 2,
          onCut: 'failover',
          disabled: false,
        },
      }], 3)
    })
  })

  it('edits an existing group label and keeps the stored links', async () => {
    const mutate = vi.fn(async () => ({ ok: true, value: {} }))
    render(<ModelGroupsRow
      namespace={namespaceOf({ stable: STABLE })}
      api={wire(mutate)}
      readOnly={false}
      picker={null}
      t={t}
      modelT={key => key}
      onSaved={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: /Model groups/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const label = screen.getByLabelText('Label') as HTMLInputElement
    expect(label.disabled).toBe(false)
    expect((screen.getByLabelText('Group id') as HTMLInputElement).disabled).toBe(true)
    fireEvent.change(label, { target: { value: 'Rock solid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith('enpoi-orchestration', [{
        op: 'set',
        path: ['chains', 'stable'],
        value: {
          label: 'Rock solid',
          links: STABLE.links,
          attempts: 2,
          onCut: 'failover',
          disabled: false,
        },
      }], 3)
    })
  })
})
