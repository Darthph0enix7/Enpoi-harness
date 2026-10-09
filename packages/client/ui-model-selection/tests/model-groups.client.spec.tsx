// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { refreshModelGroups } from '../src/client/model-groups.ts'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'

const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

function state(): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }],
    }],
    failures: [],
    pending: null,
    status: 'ready',
    error: null,
  }
}

const CHAINS = {
  stable: {
    label: 'Stable',
    links: [
      { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
      { provider: 'opencode-go', model: 'mimo-v2.5' },
    ],
    attempts: 2,
    onCut: 'failover',
  },
}

function describeResponse(): { ok: true; json: () => Promise<unknown> } {
  return {
    ok: true,
    json: async () => ({
      result: { value: { namespaces: [{ ns: 'enpoi-orchestration', value: { chains: CHAINS } }] } },
    }),
  }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('ModelSelect groups section', () => {
  it('renders no Groups section while the registry is empty', () => {
    const select = vi.fn(async () => ({ ok: true as const, value: undefined }))
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore<ModelDirectoryState>(state())}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' }))
    expect(screen.queryByText('模型组')).toBeNull()
  })

  it('renders the group above Favorites and selects it as an assignment carrying chain', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => describeResponse()))
    await refreshModelGroups()

    const select = vi.fn(async () => ({ ok: true as const, value: undefined }))
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore<ModelDirectoryState>(state())}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' }))

    // The section header answers the same search box as models.
    fireEvent.change(screen.getByPlaceholderText(t('search.placeholder')), { target: { value: 'stable' } })
    const row = await screen.findByText('Stable')
    expect(screen.getByText('模型组')).toBeTruthy()
    fireEvent.click(row)

    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'antigravity',
        model: 'gemini-3.8-flash-tiered',
        chain: 'stable',
      })
    })
  })

  it('carries the head link effort into a group assignment selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: {
          value: {
            namespaces: [{
              ns: 'enpoi-orchestration',
              value: {
                chains: {
                  boosted: {
                    label: 'Boosted',
                    links: [{ provider: 'antigravity', model: 'gemini-3.8-flash-tiered', effort: 'high' }],
                  },
                },
              },
            }],
          },
        },
      }),
    })))
    await refreshModelGroups()

    const select = vi.fn(async () => ({ ok: true as const, value: undefined }))
    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore<ModelDirectoryState>(state())}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' }))
    fireEvent.change(screen.getByPlaceholderText(t('search.placeholder')), { target: { value: 'boosted' } })
    fireEvent.click(await screen.findByText('Boosted'))

    // The runtime applies the head link's effort to this route; the recorded
    // selection must name it so the logged request header matches.
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'antigravity',
        model: 'gemini-3.8-flash-tiered',
        reasoningEffort: 'high',
        chain: 'boosted',
      })
    })
  })
})
