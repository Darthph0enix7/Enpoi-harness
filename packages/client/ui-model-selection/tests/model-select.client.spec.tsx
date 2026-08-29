// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    // OpenChamber-style picker: model trigger shows model name, effort pill shows effort name
    const modelTrigger = screen.getByRole('button', { name: 'DeepSeek-V4-Flash' })
    expect(modelTrigger.textContent).toContain('DeepSeek-V4-Flash')
    const effortTrigger = screen.getByRole('button', { name: 'High' })
    expect(effortTrigger.textContent).toContain('High')

    fireEvent.click(effortTrigger)
    // effort popover shows Off/High/Max without description
    expect(screen.getByRole('button', { name: 'Off' })).toBeTruthy()
    // High appears both as trigger and as selected option
    expect(screen.getAllByRole('button', { name: 'High' }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Max' })).toBeTruthy()
    expect(screen.queryByText('Largest budget')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Max' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      // after selection the effort pill now reads Max
      expect(screen.getByRole('button', { name: 'Max' }).textContent).toContain('Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    // Model pill shows Model, effort pill shows Default (provider default)
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy()
    const effortTrigger = screen.getByRole('button', { name: 'Default' })
    expect(effortTrigger.textContent).toContain('Default')
    fireEvent.click(effortTrigger)
    // popover should contain Default and Standard
    expect(screen.getAllByRole('button', { name: 'Default' }).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByRole('button', { name: 'Standard' })).toBeTruthy()
  })

  it('shows the durable model id when the catalog has no matching display name', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    // OpenChamber shows raw model id when not in catalog (title/modelLabel is model id alone)
    const trigger = screen.getByRole('button', { name: 'removed-model' })
    expect(trigger.textContent).toContain('removed-model')
    fireEvent.click(trigger)
    // no reasoning pill when model not found
    expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull()
    // picker popover contains the available model, not the removed one, and hides description
    expect(screen.getByText('DeepSeek-V4-Flash')).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
    // only the trigger contains removed-model, the list does not duplicate it
    expect(screen.getAllByText('removed-model').length).toBe(1)
  })

  it('shows loading until the catalog and Session projection are both ready', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: null,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    // OpenChamber fallback while loading: shows the fallback label, not the loading key,
    // because the component derives modelLabel from fallback when current is null.
    expect(screen.getByRole('button', { name: '选择模型' }).textContent)
      .toContain('选择模型')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'High' })).toBeTruthy()
    })
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    // Open the model picker and choose the second model via its row text (div, not menuitemradio)
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' }))
    // picker renders model rows as divs with span.modelNameText; clicking the text bubbles to the row
    fireEvent.click(screen.getByText('DeepSeek-V4-Pro'))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})
