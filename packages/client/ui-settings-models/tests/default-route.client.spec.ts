/**
 * Default-route facts: the wizard states the route a fresh install talks to
 * from the live Models join, with the shipped preset as the pre-connection
 * fallback.
 */
import { expect, it } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { deriveDefaultRoute } from '../src/client/default-route.ts'
import { providerPreset } from '../src/client/provider-templates.ts'
import { WIZARD_FREE_MODEL, WIZARD_FREE_PROVIDER } from '../src/client/welcome-wizard.ts'
import type { ProviderRow } from '../src/client/store.ts'
import { settingsSchema } from './settings-schema.client.ts'

/** The shipped preset of the default route, as the catalog carries it. */
const preset = providerPreset(WIZARD_FREE_PROVIDER)

/** One live Models join row for the default route. */
function row(displayName = 'Row Name'): ProviderRow {
  return {
    entry: {
      provider: WIZARD_FREE_PROVIDER,
      displayName,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', WIZARD_FREE_PROVIDER],
      active: true,
    },
    configured: true,
    removable: false,
    apiKeyEnv: undefined,
    credential: undefined,
  }
}

/** One namespace view whose value carries the given `llm-pi-ai` document. */
function view(value: JsonValue): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: {},
    value,
    base: {},
    user: {},
    autoGenerate: true,
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

it('falls back to the shipped preset before the join carries the route', () => {
  const facts = deriveDefaultRoute({ rows: [], namespaces: new Map(), schema: settingsSchema })
  expect(facts).toEqual({
    id: WIZARD_FREE_PROVIDER,
    name: preset?.name,
    protocol: preset?.protocol,
    baseURL: preset?.baseURL,
    free: true,
    model: WIZARD_FREE_MODEL,
  })
})

it('reads the live profile fields over the preset', () => {
  const namespaces = new Map([['llm-pi-ai', view({
    providers: {
      [WIZARD_FREE_PROVIDER]: {
        displayName: 'My Gateway',
        api: 'anthropic-messages',
        baseURL: 'https://gateway.test',
        keyless: false,
        models: [{ id: 'auto-free' }],
      },
    },
  })]])
  const facts = deriveDefaultRoute({ rows: [row()], namespaces, schema: settingsSchema })
  expect(facts).toEqual({
    id: WIZARD_FREE_PROVIDER,
    name: 'My Gateway',
    protocol: 'anthropic-messages',
    baseURL: 'https://gateway.test',
    free: false,
    model: 'auto-free',
  })
})

it('keeps the row display name when the profile names none, and skips unusable model rows', () => {
  const namespaces = new Map([['llm-pi-ai', view({
    providers: {
      [WIZARD_FREE_PROVIDER]: {
        models: [{ name: 'no id' }, 'not a record', null],
      },
    },
  })]])
  const facts = deriveDefaultRoute({ rows: [row('Live Row')], namespaces, schema: settingsSchema })
  expect(facts.name).toBe('Live Row')
  expect(facts.protocol).toBe(preset?.protocol)
  expect(facts.baseURL).toBe(preset?.baseURL)
  expect(facts.model).toBe(WIZARD_FREE_MODEL)
})

it('keeps the row display name when the profile resolves to a non-object', () => {
  const namespaces = new Map([['llm-pi-ai', view('not a profile')]])
  const facts = deriveDefaultRoute({ rows: [row('Live Row')], namespaces, schema: settingsSchema })
  expect(facts.name).toBe('Live Row')
})

it('falls back to the preset when the row names a namespace the join does not carry', () => {
  const facts = deriveDefaultRoute({ rows: [row('Live Row')], namespaces: new Map(), schema: settingsSchema })
  expect(facts.name).toBe('Live Row')
  expect(facts.protocol).toBe(preset?.protocol)
})
