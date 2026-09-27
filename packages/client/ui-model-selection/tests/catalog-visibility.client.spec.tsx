// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import {
  CATALOG_VISIBILITY_CHANGED_EVENT,
  catalogDecision, catalogVisibilitySnapshot, parseCatalogVisibility, parseCatalogVisibilityDecision,
  refreshCatalogVisibility,
} from '../src/client/catalog-visibility.ts'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

/** The decision map the host engine publishes for these tests. */
const RESOLVED = {
  'kilo/free-model': { state: 'hidden', reason: 'hidden by rule: zero-price', source: 'rule', rule: 'zero-price' },
  'kilo/pinned-model': { state: 'visible', reason: 'pinned visible (rule: zero-price)', source: 'manual', overriddenRule: 'zero-price' },
}

function state(): ModelDirectoryState {
  return {
    current: { provider: 'kilo', model: 'plain-model' },
    routable: true,
    groups: [{
      id: 'kilo',
      name: 'Kilo',
      models: [
        { id: 'plain-model', name: 'Plain Model' },
        { id: 'free-model', name: 'Free Model' },
        { id: 'pinned-model', name: 'Pinned Model' },
        { id: 'local-hidden', name: 'Locally Hidden' },
      ],
    }],
    failures: [],
    pending: null,
    status: 'ready',
    error: null,
  }
}

/** Stub the settings describe RPC with the published map (and an empty chain registry). */
function stubDescribe(resolved: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: {
        value: {
          namespaces: [{ ns: 'enpoi-orchestration', value: { chains: {}, catalogRules: { resolved } } }],
        },
      },
    }),
  })))
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('catalog visibility parsing', () => {
  it('keeps well-formed decisions and drops malformed rows', () => {
    const map = parseCatalogVisibility({
      'p/free': { state: 'hidden', reason: 'hidden by rule: zero-price', source: 'rule', rule: 'zero-price' },
      'p/pinned': { state: 'visible', reason: 'pinned visible (rule: zero-price)', source: 'manual', overriddenRule: 'zero-price' },
      'p/manual': { state: 'hidden', reason: null, source: 'manual' },
      'p/bad-state': { state: 'maybe', reason: null, source: 'rule' },
      'p/bad-source': { state: 'hidden', reason: null, source: 'elsewhere' },
      'p/bad-reason': { state: 'hidden', reason: 7, source: 'rule' },
      'p/not-object': null,
    })
    expect([...map.keys()]).toEqual(['p/free', 'p/pinned', 'p/manual'])
    expect(map.get('p/free')).toEqual({
      state: 'hidden', reason: 'hidden by rule: zero-price', source: 'rule', rule: 'zero-price',
    })
    expect(map.get('p/manual')).toEqual({ state: 'hidden', reason: null, source: 'manual' })
    expect(parseCatalogVisibility(undefined).size).toBe(0)
    expect(parseCatalogVisibilityDecision('nope')).toBeUndefined()
  })

  it('reads the coalesced describe seam and publishes an empty map for a missing namespace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const shared = vi.fn(async () => ({ namespaces: [{ ns: 'enpoi-orchestration', user: { catalogRules: { resolved: RESOLVED } } }] }))
    ;(globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe = shared
    try {
      await refreshCatalogVisibility()
      expect(shared).toHaveBeenCalled()
      expect(catalogDecision('kilo', 'free-model')).toMatchObject({ state: 'hidden', source: 'rule' })
      expect(catalogVisibilitySnapshot().size).toBe(2)
    } finally {
      delete (globalThis as { __dshSettingsDescribe?: unknown }).__dshSettingsDescribe
    }
    // A profile without the host engine publishes an empty map rather than keeping stale state.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { value: { namespaces: [{ ns: 'other' }] } } }),
    })))
    await refreshCatalogVisibility()
    expect(catalogVisibilitySnapshot().size).toBe(0)
  })

  it('publishes no change event when a re-read resolves to the same map', async () => {
    stubDescribe(RESOLVED)
    await refreshCatalogVisibility()
    const listener = vi.fn()
    window.addEventListener(CATALOG_VISIBILITY_CHANGED_EVENT, listener)
    try {
      await refreshCatalogVisibility()
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(CATALOG_VISIBILITY_CHANGED_EVENT, listener)
    }
  })
})

describe('ModelSelect rules visibility', () => {
  it('renders a shown-pin override with its reason and reveals a hidden-by-rule entry on search', async () => {
    stubDescribe(RESOLVED)
    await refreshCatalogVisibility()
    const select = vi.fn(async () => ({ ok: true as const, value: undefined }))
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore<ModelDirectoryState>(state())}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Plain Model' }))

    // The shown pin overrides the hide rule: the row is present with the reason.
    expect(screen.getByText('pinned visible (rule: zero-price)')).toBeTruthy()
    // The rule-hidden model is not in the default list and shows no reason yet.
    expect(screen.queryByText('Free Model')).toBeNull()
    expect(screen.queryByText('hidden by rule: zero-price')).toBeNull()

    // An explicit search surfaces the hidden entry with its reason, but it stays unselectable.
    fireEvent.change(screen.getByPlaceholderText('Search models...'), { target: { value: 'free' } })
    const hiddenRow = screen.getByText('Free Model')
    expect(screen.getByText('hidden by rule: zero-price')).toBeTruthy()
    fireEvent.click(hiddenRow)
    expect(select).not.toHaveBeenCalled()

    // The shown-pin model still selects.
    fireEvent.change(screen.getByPlaceholderText('Search models...'), { target: { value: '' } })
    fireEvent.click(screen.getByText('Pinned Model'))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'kilo', model: 'pinned-model' })
    })
  })

  it('keeps the localStorage hidden list authoritative next to rule decisions', async () => {
    stubDescribe(RESOLVED)
    await refreshCatalogVisibility()
    localStorage.setItem('dsh_hidden_models_v1', JSON.stringify({ kilo: ['local-hidden'] }))
    const select = vi.fn(async () => ({ ok: true as const, value: undefined }))
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore<ModelDirectoryState>(state())}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Plain Model' }))

    expect(screen.queryByText('Locally Hidden')).toBeNull()
    // The local pin is manual: even an explicit search does not reveal it, so
    // the search reports no matches rather than explaining a manual hide.
    fireEvent.change(screen.getByPlaceholderText('Search models...'), { target: { value: 'local' } })
    expect(screen.queryByText('Locally Hidden')).toBeNull()
    expect(screen.getByText(/No models matching/)).toBeTruthy()
  })

  it('keeps the search text and the revealed rows across a decision-map republish', async () => {
    stubDescribe(RESOLVED)
    await refreshCatalogVisibility()
    const select = vi.fn(async () => ({ ok: true as const, value: undefined }))
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore<ModelDirectoryState>(state())}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Plain Model' }))
    const search = screen.getByPlaceholderText<HTMLInputElement>('Search models...')
    fireEvent.change(search, { target: { value: 'free' } })
    expect(screen.getByText('Free Model')).toBeTruthy()

    // The host republishes a changed map while the search is open: the local
    // search text and the revealed rule-hidden row survive the repaint.
    stubDescribe({
      ...RESOLVED,
      'kilo/plain-model': { state: 'hidden', reason: 'hidden by rule: zero-price', source: 'rule', rule: 'zero-price' },
    })
    await act(async () => { await refreshCatalogVisibility() })

    expect(search.value).toBe('free')
    expect(screen.getByText('Free Model')).toBeTruthy()
  })
})
