// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { MODEL_GROUPS_ARTIFACT_KEY, refreshModelGroups } from '../src/client/model-groups.ts'
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

/** One resolved-group artifact entry, as the host publishes it. */
function artifactGroup(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    label: id,
    links: [],
    selectors: [],
    selectorMatches: [],
    members: [],
    candidates: [],
    warnings: [],
    attempts: 2,
    onCut: 'failover',
    disabled: false,
    source: 'settings',
    ...overrides,
  }
}

const CHAINS = {
  stable: artifactGroup('stable', {
    label: 'Stable',
    links: [
      { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
      { provider: 'opencode-go', model: 'mimo-v2.5' },
    ],
    members: [
      { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
      { provider: 'opencode-go', model: 'mimo-v2.5' },
    ],
  }),
}

let revision = 1
let fetchMock: ReturnType<typeof vi.fn>

/** Answer the artifact channel with one resolved-group map. */
function stubArtifact(value: unknown): void {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      result: { ok: true, value: { key: MODEL_GROUPS_ARTIFACT_KEY, revision: revision++, changed: true, value } },
    }),
  }))
  vi.stubGlobal('fetch', fetchMock)
}

/** Publish one artifact through the real revision-aware reader. */
async function seed(value: unknown): Promise<void> {
  stubArtifact(value)
  await refreshModelGroups()
  // The import-time prime may have answered first (no fetch while importing);
  // the second read is the one this test owns.
  await refreshModelGroups()
}

beforeEach(async () => {
  await seed({})
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('ModelSelect groups section', () => {
  it('renders no Groups section while the projection is empty', () => {
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
    await seed(CHAINS)

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

  it('reads the artifact channel, never the raw chains document', async () => {
    await seed(CHAINS)
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
    expect(url).toBe('/api/settings.describeArtifact')
    const rawBody = typeof init.body === 'string' ? init.body : ''
    const body = JSON.parse(rawBody) as { method: string; payload: { args: { key: string } } }
    expect(body.method).toBe('settings.describeArtifact')
    expect(body.payload.args.key).toBe(MODEL_GROUPS_ARTIFACT_KEY)
    // No settings.describe anywhere: the raw `chains` map is not a client input.
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('settings.describe') && !String(call[0]).includes('describeArtifact'))).toBe(false)
  })

  it('carries the head link effort into a group assignment selection', async () => {
    await seed({
      boosted: artifactGroup('boosted', {
        label: 'Boosted',
        links: [{ provider: 'antigravity', model: 'gemini-3.8-flash-tiered', effort: 'high' }],
        members: [{ provider: 'antigravity', model: 'gemini-3.8-flash-tiered', effort: 'high' }],
      }),
    })

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

  it('offers a selector-only group with its resolved count and no explicit link', async () => {
    await seed({
      free: artifactGroup('free', {
        label: 'Free tools',
        selectors: [{ when: { zeroPrice: true, tools: true }, adopt: false }],
        selectorMatches: [{
          index: 0,
          when: { zeroPrice: true, tools: true },
          adopt: false,
          links: [
            { provider: 'groq', model: 'free-tool' },
            { provider: 'groq', model: 'free-tools-pro' },
          ],
          warnings: [],
        }],
        members: [
          { provider: 'groq', model: 'free-tool' },
          { provider: 'groq', model: 'free-tools-pro' },
        ],
        warnings: ['2 new selector match(es) awaiting adoption (adopt: false): groq/free-tools-pro'],
      }),
    })

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

    // The row renders the RESOLVED member count and the dynamic marker even
    // though the group declares no explicit link.
    const row = await screen.findByText('Free tools')
    expect(row.parentElement?.textContent).toContain(t('group.dynamic'))
    expect(screen.getByText('2 个模型')).toBeTruthy()
    fireEvent.click(row)

    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'groq', model: 'free-tool', chain: 'free' })
    })
  })

  it('shows a disabled group as disabled and never selects it', async () => {
    await seed({
      retired: artifactGroup('retired', {
        label: 'Retired',
        disabled: true,
        links: [{ provider: 'antigravity', model: 'gemini-3.8-flash-tiered' }],
        members: [{ provider: 'antigravity', model: 'gemini-3.8-flash-tiered' }],
      }),
    })

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
    const row = await screen.findByText('Retired')
    expect(row.closest('[data-model-disabled]')).not.toBeNull()
    expect(screen.getByText(t('group.disabled'))).toBeTruthy()
    fireEvent.click(row)
    expect(select).not.toHaveBeenCalled()
  })

  it('repaints from a republished artifact when the settings document changes', async () => {
    await seed({
      stable: artifactGroup('stable', {
        label: 'Stable',
        links: [{ provider: 'antigravity', model: 'gemini-3.8-flash-tiered' }],
        members: [{ provider: 'antigravity', model: 'gemini-3.8-flash-tiered' }],
      }),
    })

    render(<ModelSelect
      locked={false}
      available
      directory={createSnapshotStore<ModelDirectoryState>(state())}
      load={vi.fn()}
      select={vi.fn(async () => ({ ok: true as const, value: undefined }))}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek-V4-Flash' }))
    fireEvent.change(screen.getByPlaceholderText(t('search.placeholder')), { target: { value: 'stable' } })
    await screen.findByText('Stable')
    expect(screen.getByText('1 个模型')).toBeTruthy()

    // An operator adds a second member elsewhere: the host republishes the
    // artifact and pushes the settings echo the picker re-reads on.
    stubArtifact({
      stable: artifactGroup('stable', {
        label: 'Stable',
        links: [
          { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
          { provider: 'opencode-go', model: 'mimo-v2.5' },
        ],
        members: [
          { provider: 'antigravity', model: 'gemini-3.8-flash-tiered' },
          { provider: 'opencode-go', model: 'mimo-v2.5' },
        ],
      }),
    })
    window.dispatchEvent(new CustomEvent('dsh:model-groups-changed'))

    await waitFor(() => { expect(screen.getByText('2 个模型')).toBeTruthy() })
  })
})
