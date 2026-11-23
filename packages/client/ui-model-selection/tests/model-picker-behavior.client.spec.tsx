// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
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

type Groups = ModelDirectoryState['groups']

/** One directory state with the provider groups a case needs. */
function state(groups: Groups, current: ModelSelection | null = null): ModelDirectoryState {
  return {
    current,
    routable: true,
    groups,
    failures: [],
    pending: null,
    status: 'ready',
    error: null,
  }
}

/** The two-provider catalogue the collapse and favorite cases share. */
const GROUPS: Groups = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    models: [
      { id: 'shared-model', name: 'Shared Model' },
      { id: 'claude-sonnet', name: 'Claude Sonnet' },
    ],
  },
  {
    id: 'local',
    name: 'Local',
    models: [{ id: 'shared-model', name: 'Shared Model' }],
  },
]

/** A catalogue whose only collision is the `shared-model` id across two providers. */
const DUP_GROUPS: Groups = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'flash-model', name: 'Flash Model' },
      { id: 'shared-model', name: 'DeepSeek Shared' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    models: [{ id: 'shared-model', name: 'OpenRouter Shared' }],
  },
  {
    id: 'local',
    name: 'Local',
    models: [{ id: 'local-only', name: 'Local Only' }],
  },
]

/** Keyboard cases only need two providers, one of them collapsed by preference. */
const KEYBOARD_GROUPS: Groups = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    models: [{ id: 'gamma', name: 'Gamma' }],
  },
]

function renderPicker(groups: Groups = GROUPS, current: ModelSelection | null = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, select = vi.fn(async () => ({ ok: true as const, value: undefined }))) {
  const directory = createSnapshotStore<ModelDirectoryState>(state(groups, current))
  const result = render(<ModelSelect
    locked={false}
    available
    directory={directory}
    load={vi.fn()}
    select={select}
    t={t}
  />)
  return { ...result, directory, select }
}

/** Open the picker from its trigger. */
function openPicker(): void {
  fireEvent.click(document.querySelector('[data-model-trigger]')!)
}

/** One provider section header, addressed by its visible name. */
function header(name: string): HTMLElement {
  return screen.getByRole('button', { name })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('ModelSelect search and collapse', () => {
  it('auto-expands matches, keeps an explicit search collapse for the query, and restores the saved view', async () => {
    localStorage.setItem('dsh_collapsed_groups_v2', JSON.stringify(['openrouter']))
    renderPicker()
    openPicker()

    // The saved preference collapses OpenRouter before any search.
    expect(header('OpenRouter').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Shared Model, OpenRouter' })).toBeNull()

    const search = screen.getByRole('textbox', { name: '搜索模型' })
    fireEvent.change(search, { target: { value: 'shared' } })

    // Matching groups auto-expand; a group with no match leaves the list.
    expect(header('OpenRouter').getAttribute('aria-expanded')).toBe('true')
    expect(header('Local').getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('button', { name: 'DeepSeek' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Shared Model, OpenRouter' })).toBeTruthy()

    // The user's collapse wins for the rest of this query.
    fireEvent.click(header('OpenRouter'))
    expect(header('OpenRouter').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Shared Model, OpenRouter' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Shared Model, Local' })).toBeTruthy()

    // Changing the query keeps the explicit search toggle.
    fireEvent.change(search, { target: { value: 'shared m' } })
    expect(header('OpenRouter').getAttribute('aria-expanded')).toBe('false')

    // Re-expanding in the same query also persists for that query.
    fireEvent.click(header('OpenRouter'))
    expect(header('OpenRouter').getAttribute('aria-expanded')).toBe('true')

    // Clearing restores the saved pre-search state exactly; the temporary
    // expansion never reaches localStorage.
    fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    expect(header('OpenRouter').getAttribute('aria-expanded')).toBe('false')
    expect(header('DeepSeek').getAttribute('aria-expanded')).toBe('true')
    expect(JSON.parse(localStorage.getItem('dsh_collapsed_groups_v2') ?? '[]')).toEqual(['openrouter'])

    // The next query starts from the saved preference again.
    fireEvent.change(search, { target: { value: 'shared' } })
    expect(header('OpenRouter').getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps the favorites section collapsible during a search', () => {
    localStorage.setItem('dsh_model_favorites_v2', JSON.stringify([{ provider: 'openrouter', modelId: 'shared-model' }]))
    renderPicker()
    openPicker()
    fireEvent.change(screen.getByRole('textbox', { name: '搜索模型' }), { target: { value: 'shared' } })

    const favorites = header('收藏')
    expect(favorites.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('button', { name: 'Shared Model, OpenRouter' }).length).toBeGreaterThanOrEqual(1)
    fireEvent.click(favorites)
    expect(favorites.getAttribute('aria-expanded')).toBe('false')
    // Only the provider-group row remains once the favorites body closes.
    expect(screen.getAllByRole('button', { name: 'Shared Model, OpenRouter' })).toHaveLength(1)
  })

  it('exposes aria-expanded and the controlled body only while expanded', () => {
    localStorage.setItem('dsh_collapsed_groups_v2', JSON.stringify(['openrouter']))
    renderPicker()
    openPicker()

    const collapsed = header('OpenRouter')
    expect(collapsed.getAttribute('aria-expanded')).toBe('false')
    expect(collapsed.getAttribute('aria-controls')).toBeNull()
    fireEvent.click(collapsed)
    expect(collapsed.getAttribute('aria-expanded')).toBe('true')
    const bodyId = collapsed.getAttribute('aria-controls')
    expect(bodyId).not.toBeNull()
    const body = document.getElementById(bodyId ?? '')
    expect(body?.getAttribute('role')).toBe('group')
    expect(body?.getAttribute('aria-labelledby')).toBe(collapsed.id)
  })
})

describe('ModelSelect keyboard navigation', () => {
  it('walks visible rows only, wraps, and never lands on a collapsed group item', async () => {
    localStorage.setItem('dsh_collapsed_groups_v2', JSON.stringify(['openrouter']))
    const { select } = renderPicker(KEYBOARD_GROUPS)
    openPicker()
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '搜索模型' })) })

    // ArrowDown enters the first visible row; OpenRouter's collapsed rows are
    // absent from the walk.
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'DeepSeek-V4-Flash, DeepSeek' }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'DeepSeek-V4-Pro, DeepSeek' }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'DeepSeek-V4-Flash, DeepSeek' }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'DeepSeek-V4-Pro, DeepSeek' }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'DeepSeek-V4-Flash, DeepSeek' }))

    // Type-ahead starts after the focused row and wraps.
    fireEvent.keyDown(document.activeElement as Element, { key: 'p' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'DeepSeek-V4-Pro, DeepSeek' }))

    // ArrowUp from the search input lands on the last visible row.
    const search = screen.getByRole('textbox', { name: '搜索模型' })
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'DeepSeek-V4-Pro, DeepSeek' }))

    // Enter activates the focused row.
    fireEvent.click(document.activeElement as Element)
    await waitFor(() => { expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }) })
  })

  it('skips rows inside a group the user collapses during a search', async () => {
    renderPicker()
    openPicker()
    const search = screen.getByRole('textbox', { name: '搜索模型' })
    fireEvent.change(search, { target: { value: 'shared' } })
    await waitFor(() => { expect(document.activeElement).toBe(search) })

    // Auto-expanded matches put both providers' rows in the walk.
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Shared Model, OpenRouter' }))
    const openrouter = header('OpenRouter')
    fireEvent.click(openrouter)
    openrouter.focus()
    fireEvent.keyDown(openrouter, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Shared Model, Local' }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Shared Model, Local' }))
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    renderPicker()
    openPicker()
    const search = screen.getByRole('textbox', { name: '搜索模型' })
    fireEvent.keyDown(search, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' }))
  })
})

describe('ModelSelect duplicate tagging', () => {
  it('tags both rows and the trigger only when the name or id collides across providers', () => {
    renderPicker(DUP_GROUPS, { provider: 'deepseek-official', model: 'shared-model' })
    openPicker()

    const dialog = screen.getByRole('dialog')
    const deepseek = within(dialog).getByRole('button', { name: 'DeepSeek Shared, DeepSeek' })
    const openrouter = within(dialog).getByRole('button', { name: 'OpenRouter Shared, OpenRouter' })
    expect(deepseek.textContent).toContain('DeepSeek')
    expect(openrouter.textContent).toContain('OpenRouter')
    // Names and ids are exposed even when no visible tag is needed.
    const uniqueish = within(dialog).getByRole('button', { name: 'Flash Model, DeepSeek' })
    expect(uniqueish.textContent).not.toContain('DeepSeek')
    expect(uniqueish.getAttribute('title')).toBe('Flash Model, DeepSeek')

    // The selected-model trigger identifies the provider for an ambiguous name.
    const trigger = document.querySelector<HTMLButtonElement>('[data-model-trigger]')!
    expect(trigger.textContent).toContain('DeepSeek')
    expect(trigger.getAttribute('aria-label')).toBe('DeepSeek Shared, DeepSeek')
    expect(trigger.getAttribute('title')).toBe('DeepSeek · DeepSeek Shared')

    // Filtering the collision partner away does not change the label.
    fireEvent.change(screen.getByRole('textbox', { name: '搜索模型' }), { target: { value: 'deepseek shared' } })
    expect(screen.queryByRole('button', { name: 'OpenRouter Shared, OpenRouter' })).toBeNull()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'DeepSeek Shared, DeepSeek' }).textContent).toContain('DeepSeek')
    expect(trigger.textContent).toContain('DeepSeek')
    expect(trigger.getAttribute('aria-label')).toBe('DeepSeek Shared, DeepSeek')
  })

  it('tags a name collision even when the ids differ', () => {
    renderPicker([
      { id: 'one', name: 'Provider One', models: [{ id: 'alpha', name: 'Same Label' }] },
      { id: 'two', name: 'Provider Two', models: [{ id: 'beta', name: 'Same Label' }] },
    ], null)
    openPicker()
    const one = screen.getByRole('button', { name: 'Same Label, Provider One' })
    const two = screen.getByRole('button', { name: 'Same Label, Provider Two' })
    expect(one.textContent).toContain('Provider One')
    expect(two.textContent).toContain('Provider Two')
  })

  it('tags an id collision even when the display names differ', () => {
    renderPicker([
      { id: 'one', name: 'Provider One', models: [{ id: 'shared', name: 'Alpha' }] },
      { id: 'two', name: 'Provider Two', models: [{ id: 'shared', name: 'Beta' }] },
    ], null)
    openPicker()
    expect(screen.getByRole('button', { name: 'Alpha, Provider One' }).textContent).toContain('Provider One')
    expect(screen.getByRole('button', { name: 'Beta, Provider Two' }).textContent).toContain('Provider Two')
  })

  it('leaves a single-provider catalogue untagged in the row and the trigger', () => {
    renderPicker([
      { id: 'only', name: 'Only Provider', models: [{ id: 'solo', name: 'Solo Model' }] },
    ], { provider: 'only', model: 'solo' })
    openPicker()
    const row = screen.getByRole('button', { name: 'Solo Model, Only Provider' })
    expect(row.textContent).not.toContain('Only Provider')
    const trigger = screen.getByRole('button', { name: 'Solo Model' })
    expect(trigger.textContent).not.toContain('Only Provider')
    expect(trigger.getAttribute('title')).toBe('Only Provider · Solo Model')
  })
})
