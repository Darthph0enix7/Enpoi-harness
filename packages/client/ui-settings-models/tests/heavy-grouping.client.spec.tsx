// @vitest-environment jsdom
/**
 * The Models page groups heavy/self-hosted providers in their own labelled
 * group AFTER the mainstream providers: the sidebar renders the mainstream
 * row first, then the "Self-hosted / heavy" label, then the heavy row.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import type { ModelsWire } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
  })),
})

function wireNamespaces() {
  return [
    {
      ns: 'llm-pi-ai',
      schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as never,
      value: {
        providers: {
          openai: { baseURL: 'https://proxy' },
          freellmapi: { baseURL: 'http://127.0.0.1:3002/v1' },
        },
      },
      user: {
        providers: {
          openai: { baseURL: 'https://proxy' },
          freellmapi: { baseURL: 'http://127.0.0.1:3002/v1' },
        },
      },
      autoGenerate: true,
      applies: 'live',
      secrets: [],
      revision: 0,
    },
  ]
}

async function mountSection(): Promise<void> {
  const face = {
    llm: {
      listProviders: vi.fn(async () => ({
        ok: true,
        value: [{ id: 'openai', name: 'openai' }, { id: 'freellmapi', name: 'FreeLLMAPI' }],
      })),
      listConfigurableProviders: vi.fn(async () => ({
        ok: true,
        value: [
          { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
          { provider: 'freellmapi', displayName: 'FreeLLMAPI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'freellmapi'] },
        ],
      })),
      discoverModels: vi.fn(async () => ({ ok: true, value: [] })),
    },
    settings: {
      describe: vi.fn(async () => ({
        ok: true,
        value: { writable: true, hasDocument: false, namespaces: wireNamespaces() },
      })),
      update: vi.fn(),
      mutate: vi.fn(),
    },
    credentials: {
      describe: vi.fn(async (refs: string[]) => ({
        ok: true,
        value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
      })),
      set: vi.fn(),
      unset: vi.fn(),
    },
  }
  const ctx = { remote: face } as never
  const controller = new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
  await controller.load()
  render(
    <ModelsSection
      controller={controller}
      useSnapshot={bindSnapshotSelector(controller.store)}
      api={face as unknown as ModelsWire}
      schema={settingsSchema}
      t={key => en[key]}
      picker={null}
      modelT={key => key}
      renderSlot={(() => null) as unknown as ModelsSectionProps['renderSlot']}
    />,
  )
}

/** True when `second` follows `first` in document order. */
function follows(first: HTMLElement, second: HTMLElement): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

/** The sidebar row carrying `name` as its label. */
function sidebarRow(name: string): HTMLElement {
  const row = screen.getAllByText(name)
    .map(node => node.closest<HTMLElement>('[role="button"]'))
    .find(candidate => candidate !== null)
  if (row === undefined || row === null) throw new Error(`no sidebar row for ${name}`)
  return row
}

it('renders mainstream rows first, then the Self-hosted / heavy label and its rows', async () => {
  // The heavy row's online dot probes through the gateway; keep it offline.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  await mountSection()

  const mainstream = sidebarRow('openai')
  const label = screen.getByText(en.heavyGroup)
  const heavy = sidebarRow('FreeLLMAPI')
  expect(en.heavyGroup).toBe('Self-hosted / heavy')
  expect(follows(mainstream, label)).toBe(true)
  expect(follows(label, heavy)).toBe(true)
})
