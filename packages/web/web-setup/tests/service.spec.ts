/**
 * Service-level behavior: the status projection, validateProvider mapping,
 * and applySetup's sequential row surgery, refusals, and pending-restart
 * fallback. The config editor and credential provider are in-memory seams;
 * the profile document is exercised for real in web-setup.host.spec.ts.
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { providerSpec } from '../src/catalog.ts'
import { applyPresetToolToggles, missingCredentialError, pendingRestartMessage, WebSetupService } from '../src/remote.ts'
import type {
  WebSetupApplyRequest,
  WebSetupConfigEditor,
  WebSetupEditorRow,
  WebSetupSeams,
  WebSetupValidateRequest,
} from '../src/types.ts'
import { FakeCredentials, FakeEditor, jsonFetch, nestedToolWeb, presetRow, PRESET_PLUGIN_NAME, providerRow, toolRow, webRow } from './fakes.ts'

/** Cast one malformed wire value to the declared request type. */
function wireApply(value: unknown): WebSetupApplyRequest {
  return value as WebSetupApplyRequest
}

/** Cast one malformed wire value to the declared validate request type. */
function wireValidate(value: unknown): WebSetupValidateRequest {
  return value as WebSetupValidateRequest
}

/** Build a service over in-memory seams. */
function build(options: {
  rows?: WebSetupEditorRow[]
  editor?: FakeEditor | null
  credentials?: FakeCredentials | null
  overrides?: Partial<WebSetupSeams>
} = {}): { service: WebSetupService; editor?: FakeEditor; credentials?: FakeCredentials } {
  const editor = options.editor === null ? undefined : options.editor ?? new FakeEditor(options.rows ?? [webRow(), toolRow()])
  const credentials = options.credentials === null ? undefined : options.credentials ?? new FakeCredentials()
  const service = new WebSetupService(new Context(), () => ({
    ...editor === undefined ? {} : { configEditor: editor },
    ...credentials === undefined ? {} : { credentials },
    fetchImpl: jsonFetch({}),
    env: {},
    now: () => 0,
    ...options.overrides,
  }))
  return {
    service,
    ...editor === undefined ? {} : { editor },
    ...credentials === undefined ? {} : { credentials },
  }
}

it('projects the provider selection, mounted rows, and vault state', async () => {
  const credentials = new FakeCredentials()
  credentials.store.set('EXA_API_KEY', 'stored')
  const editor = new FakeEditor([
    webRow({ searchProvider: 'exa', fetchProvider: 'http' }),
    toolRow({ search: true, fetch: true }),
    providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa'),
    providerRow('web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'),
    providerRow('web-search-brave', '@deepseek-ai/dsh-web-search-brave', {}),
  ])
  editor.rows[4]!.options.disabled = true
  const { service } = build({ editor, credentials })
  expect(await service.status()).toEqual({
    searchProvider: 'exa',
    fetchProvider: 'http',
    mounted: [
      { kind: 'search', provider: 'exa' },
      { kind: 'fetch', provider: 'http' },
    ],
    credentials: {
      EXA_API_KEY: { configured: true, source: 'store', writable: true },
      DEEPSEEK_API_KEY: { configured: false, writable: true },
      BRAVE_API_KEY: { configured: false, writable: true },
      TAVILY_API_KEY: { configured: false, writable: true },
      JINA_API_KEY: { configured: false, writable: true },
    },
  })
})

it('finds the web row by module name when its id differs', async () => {
  const editor = new FakeEditor([{ options: { id: 'my-web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'brave' } } }])
  const { service } = build({ editor })
  expect((await service.status()).searchProvider).toBe('brave')
})

it('falls back to the DSH_WEB_ environment names, then to null', async () => {
  const { service } = build({
    rows: [webRow({ searchProvider: '', fetchProvider: 7 })],
    overrides: { env: { DSH_WEB_SEARCH_PROVIDER: 'brave', DSH_WEB_FETCH_PROVIDER: 'jina' } },
  })
  const status = await service.status()
  expect(status.searchProvider).toBe('brave')
  expect(status.fetchProvider).toBe('jina')
})

it('reports no provider when the web row is absent, even with environment overrides', async () => {
  const { service } = build({ rows: [toolRow()], overrides: { env: { DSH_WEB_SEARCH_PROVIDER: 'brave' } } })
  const status = await service.status()
  expect(status.searchProvider).toBeNull()
  expect(status.fetchProvider).toBeNull()
  expect(status.mounted).toEqual([])
})

it('reports every catalog reference unconfigured without a credential provider', async () => {
  const { service } = build({ credentials: null })
  const status = await service.status()
  expect(status.credentials).toEqual({
    EXA_API_KEY: { configured: false, writable: false },
    DEEPSEEK_API_KEY: { configured: false, writable: false },
    BRAVE_API_KEY: { configured: false, writable: false },
    TAVILY_API_KEY: { configured: false, writable: false },
    JINA_API_KEY: { configured: false, writable: false },
  })
})

it('degrades an unreadable editor and a failing describe to empty state', async () => {
  const logged: string[] = []
  const editor = new FakeEditor([webRow({ searchProvider: 'exa' })])
  editor.entriesFailure = new Error('loader gone')
  const credentials = new FakeCredentials()
  credentials.describeFailure = new Error('vault denied')
  const { service } = build({ editor, credentials, overrides: { log: line => logged.push(line) } })
  const status = await service.status()
  expect(status.searchProvider).toBeNull()
  expect(status.mounted).toEqual([])
  expect(status.credentials.EXA_API_KEY).toEqual({ configured: false, writable: false })
  expect(logged.join('\n')).toContain('loader gone')
  expect(logged.join('\n')).toContain('vault denied')
})

it('runs the Exa canary with a one-shot key', async () => {
  const { service } = build({ overrides: { fetchImpl: jsonFetch({ results: [{}] }) } })
  const result = await service.validateProvider({ kind: 'search', provider: 'exa', apiKey: 'one-shot' }, new AbortController().signal)
  expect(result).toMatchObject({ ok: true, status: 200, sourcesCount: 1 })
})

it('resolves the stored key for a canary without a candidate key', async () => {
  const credentials = new FakeCredentials()
  credentials.store.set('EXA_API_KEY', 'from-vault')
  const requests: RequestInit[] = []
  const { service } = build({
    credentials,
    overrides: {
      fetchImpl: async (_url, init) => {
        requests.push(init ?? {})
        return new Response('{"results":[]}', { status: 200 })
      },
    },
  })
  const result = await service.validateProvider({ kind: 'search', provider: 'exa' }, new AbortController().signal)
  expect(result.ok).toBe(true)
  expect(requests[0]?.headers).toMatchObject({ authorization: 'Bearer from-vault' })
})

it('treats an unresolvable stored key as absent', async () => {
  const credentials = new FakeCredentials()
  credentials.store.set('EXA_API_KEY', 'x')
  credentials.resolveFailure = new Error('locked')
  const logged: string[] = []
  const { service } = build({ credentials, overrides: { log: line => logged.push(line) } })
  const result = await service.validateProvider({ kind: 'search', provider: 'exa' }, new AbortController().signal)
  expect(result.ok).toBe(true)
  expect(logged.join('\n')).toContain('locked')
})

it('reports the built-in HTTP fetcher as valid without an external call', async () => {
  const { service } = build({ overrides: { fetchImpl: async () => { throw new Error('must not be called') } } })
  expect(await service.validateProvider({ kind: 'fetch', provider: 'http' }, new AbortController().signal)).toEqual({ ok: true })
})

it('reports DeepSeek by credential presence and accepts a one-shot key', async () => {
  const { service, credentials } = build()
  expect(await service.validateProvider({ kind: 'search', provider: 'deepseek-official' }, new AbortController().signal))
    .toEqual({ ok: false, error: 'deepseek-official needs a configured DEEPSEEK_API_KEY credential' })
  credentials!.store.set('DEEPSEEK_API_KEY', 'sk')
  expect(await service.validateProvider({ kind: 'search', provider: 'deepseek-official' }, new AbortController().signal))
    .toEqual({ ok: true })
  expect(await service.validateProvider({ kind: 'search', provider: 'deepseek-official', apiKey: 'sk2' }, new AbortController().signal))
    .toEqual({ ok: true })
})

it('refuses malformed validateProvider input at the wire boundary', async () => {
  const { service } = build()
  const signal = new AbortController().signal
  expect(await service.validateProvider(wireValidate(undefined), signal)).toEqual({ ok: false, error: 'validateProvider: request must be an object' })
  expect(await service.validateProvider(wireValidate({ kind: 'other', provider: 'exa' }), signal)).toEqual({ ok: false, error: 'validateProvider: kind must be "search" or "fetch"' })
  expect(await service.validateProvider(wireValidate({ kind: 'search', provider: 7 }), signal)).toEqual({ ok: false, error: 'validateProvider: provider must be a non-empty string' })
  expect(await service.validateProvider(wireValidate({ kind: 'search', provider: 'exa', apiKey: 7 }), signal)).toEqual({ ok: false, error: 'validateProvider: apiKey must be a string' })
  expect(await service.validateProvider(wireValidate({ kind: 'search', provider: 'exa', baseURL: 7 }), signal)).toEqual({ ok: false, error: 'validateProvider: baseURL must be a string' })
  expect(await service.validateProvider(wireValidate({ kind: 'search', provider: 'missing' }), signal)).toEqual({ ok: false, error: 'unknown search provider "missing"' })
  expect(await service.validateProvider(wireValidate({ kind: 'fetch', provider: 'exa' }), signal)).toEqual({ ok: false, error: '"exa" is a search provider, not fetch' })
})

it('maps an unexpected service failure to an error value', async () => {
  const service = new WebSetupService(new Context(), () => { throw new Error('seams unavailable') })
  expect(await service.validateProvider({ kind: 'search', provider: 'exa' }, new AbortController().signal))
    .toEqual({ ok: false, error: 'seams unavailable' })
})

it('applies a search selection: vault write, row insert, web edit, and tool toggle', async () => {
  const credentials = new FakeCredentials()
  const editor = new FakeEditor([webRow(), toolRow()])
  const { service } = build({ editor, credentials })
  const result = await service.applySetup({
    search: { provider: 'exa', apiKey: 'exa-key', baseURL: 'https://exa.test' },
    toolToggles: { search: true, fetch: false },
  })
  expect(result).toEqual({
    ok: true,
    applied: ['credentials:EXA_API_KEY', 'row:web-search-exa', 'web.searchProvider', 'tool-web.search'],
  })
  expect(credentials.sets).toEqual([['EXA_API_KEY', 'exa-key']])
  expect(editor.calls).toEqual([
    { kind: 'insert', id: 'web-search-exa', name: '@deepseek-ai/dsh-web-search-exa', config: { apiKeyEnv: 'EXA_API_KEY', baseURL: 'https://exa.test' } },
    { kind: 'edit', id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'exa' } },
    { kind: 'edit', id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { search: true, fetch: false } },
  ])
  expect(editor.rows.find(row => row.options.id === 'web')?.options.config).toEqual({ searchProvider: 'exa' })
  expect(editor.rows.find(row => row.options.id === 'tool-web')?.options.config).toEqual({ search: true, fetch: false })
})

it('is idempotent for a repeated identical selection', async () => {
  const editor = new FakeEditor([
    webRow({ searchProvider: 'exa' }),
    toolRow({ search: true, fetch: false }),
    providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa', { apiKeyEnv: 'EXA_API_KEY' }),
  ])
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa' }, toolToggles: { search: true, fetch: false } })
  expect(result).toEqual({ ok: true, applied: [] })
  expect(editor.calls).toEqual([
    { kind: 'edit', id: 'web-search-exa', name: '@deepseek-ai/dsh-web-search-exa', config: { apiKeyEnv: 'EXA_API_KEY' } },
  ])
})

it('edits a mounted provider row when the template config changes', async () => {
  const editor = new FakeEditor([
    providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa', { apiKeyEnv: 'EXA_API_KEY' }),
  ])
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa', baseURL: 'https://exa.test' } })
  expect(result.applied).toEqual(['row:web-search-exa'])
  expect(editor.rows[0]?.options.config).toEqual({ apiKeyEnv: 'EXA_API_KEY', baseURL: 'https://exa.test' })
})

it('re-enables a disabled provider row by replacing its document declaration', async () => {
  const editor = new FakeEditor([webRow(), toolRow()])
  editor.rows.push(providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa'))
  editor.rows[2]!.options.disabled = true
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa' } })
  expect(result).toEqual({ ok: true, applied: ['row:web-search-exa', 'web.searchProvider'] })
  expect(editor.calls.map(call => `${call.kind}:${call.id}`)).toEqual(['remove:web-search-exa', 'insert:web-search-exa', 'edit:web'])
  expect(editor.rows.find(row => row.options.name === '@deepseek-ai/dsh-web-search-exa')?.options.disabled).not.toBe(true)
})

it('reports a disabled row owned outside the document with the exact field to change', async () => {
  const editor = new FakeEditor([webRow(), toolRow()])
  editor.rows.push(providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa'))
  editor.rows[2]!.options.disabled = true
  editor.removeFailure = new Error('config-editor: profile row "web-search-exa" is not removable from this document')
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa' } })
  expect(result.ok).toBe(false)
  expect(result.pendingRestart?.ns).toBe('web-search-exa')
  expect(result.pendingRestart?.message).toContain('disabled: false')
  expect(result.pendingRestart?.message).toContain('not removable')
  expect(editor.calls).toEqual([])
})

it('reports a failed re-insert after the disabled row was removed', async () => {
  const editor = new FakeEditor([webRow(), toolRow()])
  editor.rows.push(providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa'))
  editor.rows[2]!.options.disabled = true
  editor.insertFailure = new Error('Cannot find package @deepseek-ai/dsh-web-search-exa')
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa' } })
  expect(result.ok).toBe(false)
  expect(result.pendingRestart?.ns).toBe('web-search-exa')
  expect(result.pendingRestart?.message).toContain('was removed')
  expect(result.pendingRestart?.message).toContain('Cannot find package')
})

it('refuses a provider whose insert did not mount it', async () => {
  const editor = new FakeEditor([webRow(), toolRow()])
  editor.swallowInsert = true
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa' } })
  expect(result.ok).toBe(false)
  expect(result.error).toContain('was not mounted')
  expect(result.applied).toEqual(['row:web-search-exa'])
})

it('reports a missing provider package as pendingRestart with committed ops first', async () => {
  const credentials = new FakeCredentials()
  const editor = new FakeEditor([webRow(), toolRow()])
  editor.insertFailure = new Error('Cannot find package @deepseek-ai/dsh-web-search-brave')
  const { service } = build({ editor, credentials })
  const result = await service.applySetup({ search: { provider: 'brave', apiKey: 'brave-key' } })
  expect(result.ok).toBe(false)
  expect(result.applied).toEqual(['credentials:BRAVE_API_KEY'])
  expect(result.pendingRestart?.ns).toBe('web-search-brave')
  expect(result.pendingRestart?.message).toContain('Cannot find package @deepseek-ai/dsh-web-search-brave')
})

it('unsets a provider and toggles a tool without touching the other provider', async () => {
  const editor = new FakeEditor([
    webRow({ searchProvider: 'exa', fetchProvider: 'http' }),
    toolRow({ search: true, fetch: true }),
    providerRow('web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'),
  ])
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: null }, toolToggles: { search: false, fetch: true } })
  expect(result).toEqual({ ok: true, applied: ['web.searchProvider', 'tool-web.search'] })
  expect(editor.rows.find(row => row.options.id === 'web')?.options.config).toEqual({ fetchProvider: 'http' })
  expect(editor.rows.find(row => row.options.id === 'tool-web')?.options.config).toEqual({ search: false, fetch: true })
})

it('selects the built-in HTTP fetcher and enables web_fetch', async () => {
  const editor = new FakeEditor([webRow(), toolRow()])
  const { service } = build({ editor })
  const result = await service.applySetup({ fetch: { provider: 'http' }, toolToggles: { search: false, fetch: true } })
  expect(result.applied).toEqual(['row:web-fetch-http', 'web.fetchProvider', 'tool-web.fetch'])
  expect(editor.calls[0]?.config).toEqual({})
  expect(editor.rows.find(row => row.options.id === 'web')?.options.config).toEqual({ fetchProvider: 'http' })
})

it('selects the reserved Jina fetch row with its credential reference', async () => {
  const editor = new FakeEditor([webRow(), toolRow()])
  const { service } = build({ editor })
  const result = await service.applySetup({ fetch: { provider: 'jina' }, toolToggles: { search: false, fetch: true } })
  expect(result.ok).toBe(true)
  expect(editor.calls[0]?.config).toEqual({ apiKeyEnv: 'JINA_API_KEY' })
})

it('refuses to enable search with no provider', async () => {
  const editor = new FakeEditor([webRow(), toolRow()])
  const { service } = build({ editor })
  const result = await service.applySetup({ toolToggles: { search: true, fetch: false } })
  expect(result).toEqual({ ok: false, applied: [], error: 'tool-web.search cannot be enabled without a search provider' })
  expect(editor.calls).toEqual([])
})

it('refuses to enable fetch with no provider', async () => {
  const { service } = build()
  const result = await service.applySetup({ toolToggles: { search: false, fetch: true } })
  expect(result.error).toBe('tool-web.fetch cannot be enabled without a fetch provider')
})

it('refuses a configured provider the catalog does not know', async () => {
  const { service } = build({ rows: [webRow({ searchProvider: 'mystery' }), toolRow()] })
  const result = await service.applySetup({ toolToggles: { search: true, fetch: false } })
  expect(result.error).toBe('unknown search provider "mystery"')
})

it('refuses to enable a tool whose provider row is not mounted', async () => {
  const { service } = build({ rows: [webRow({ searchProvider: 'exa' }), toolRow()] })
  const result = await service.applySetup({ toolToggles: { search: true, fetch: false } })
  expect(result.error).toContain('not mounted')
})

it('enables a tool when the configured provider row is already mounted', async () => {
  const editor = new FakeEditor([
    webRow({ searchProvider: 'exa' }),
    toolRow(),
    providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa'),
  ])
  const { service } = build({ editor })
  const result = await service.applySetup({ toolToggles: { search: true, fetch: false } })
  expect(result).toEqual({ ok: true, applied: ['tool-web.search'] })
})

it('edits enabled preset group rows when the host row is disabled', async () => {
  const editor = new FakeEditor([webRow()])
  editor.rows.push(providerRow('tool-web', '@deepseek-ai/dsh-tool-web', { fetch: true }))
  editor.rows[1]!.options.disabled = true
  editor.rows.push(
    presetRow('preset-orchestrator', [
      nestedToolWeb({ fetch: true, searchTimeoutMs: 60000 }),
      { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
    ]),
    presetRow('preset-sysadmin', [nestedToolWeb({ fetch: true, searchTimeoutMs: 60000 })]),
    presetRow('preset-creator', [nestedToolWeb({ fetch: true, searchTimeoutMs: 60000 })]),
  )
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa' }, toolToggles: { search: true, fetch: false } })
  expect(result.ok).toBe(true)
  expect(result.applied).toContain('tool-web.search')
  const editedPresets = editor.calls.filter(call => call.kind === 'edit' && call.name === PRESET_PLUGIN_NAME)
  expect(editedPresets.map(call => call.id).sort()).toEqual(['preset-creator', 'preset-orchestrator', 'preset-sysadmin'])
  const config = editor.rows.find(row => row.options.id === 'preset-orchestrator')?.options.config as { plugins: Array<Record<string, unknown>> }
  const nested = config.plugins.find(plugin => plugin.name === '@deepseek-ai/dsh-tool-web') as { config: Record<string, unknown> }
  expect(nested.config).toMatchObject({ search: true, fetch: false, searchTimeoutMs: 60000 })
  expect(editor.calls.some(call => call.kind === 'edit' && call.id === 'tool-web')).toBe(false)
})

it('edits both an enabled host row and the preset rows', async () => {
  const editor = new FakeEditor([
    webRow({ searchProvider: 'exa', fetchProvider: 'http' }),
    toolRow({ search: false, fetch: false }),
    providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa'),
    providerRow('web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'),
    presetRow('preset-orchestrator', [nestedToolWeb({ search: false, fetch: false })]),
  ])
  const { service } = build({ editor })
  const result = await service.applySetup({ toolToggles: { search: true, fetch: true } })
  expect(result).toEqual({ ok: true, applied: ['tool-web.search', 'tool-web.fetch'] })
  expect(editor.calls.filter(call => call.kind === 'edit').map(call => call.id)).toEqual(['tool-web', 'preset-orchestrator'])
})

it('reports a disabled host row with no editable preset as pendingRestart', async () => {
  const editor = new FakeEditor([webRow(), toolRow()])
  editor.rows[1]!.options.disabled = true
  const { service } = build({ editor })
  const result = await service.applySetup({ toolToggles: { search: false, fetch: false } })
  expect(result.ok).toBe(false)
  expect(result.pendingRestart?.ns).toBe('tool-web')
  expect(result.pendingRestart?.message).toContain('disabled by the composition')
  expect(result.pendingRestart?.message).toContain('disabled: false')
  expect(editor.calls).toEqual([])
})

it('re-enables a disabled nested tool plugin when the setup enables it', async () => {
  const editor = new FakeEditor([
    webRow({ searchProvider: 'exa', fetchProvider: 'http' }),
    providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa'),
    providerRow('web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'),
    presetRow('preset-orchestrator', [nestedToolWeb({ fetch: true }, true)]),
  ])
  const { service } = build({ editor })
  const result = await service.applySetup({ toolToggles: { search: false, fetch: true } })
  expect(result.ok).toBe(true)
  const config = editor.rows.find(row => row.options.id === 'preset-orchestrator')?.options.config as { plugins: Array<Record<string, unknown>> }
  expect(config.plugins[0]).toMatchObject({ disabled: false, config: { search: false, fetch: true } })
})

it('creates the nested tool config when a preset plugin carries none', async () => {
  const editor = new FakeEditor([
    webRow({ searchProvider: 'exa', fetchProvider: 'http' }),
    providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa'),
    providerRow('web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'),
    presetRow('preset-orchestrator', [{ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' }]),
  ])
  const { service } = build({ editor })
  const result = await service.applySetup({ toolToggles: { search: true, fetch: false } })
  expect(result.ok).toBe(true)
  const config = editor.rows.find(row => row.options.id === 'preset-orchestrator')?.options.config as { plugins: Array<Record<string, unknown>> }
  expect(config.plugins[0]).toMatchObject({ config: { search: true, fetch: false } })
})

it('reports a preset-row edit failure as pendingRestart', async () => {
  const editor = new FakeEditor([
    webRow({ searchProvider: 'exa' }),
    providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa'),
    presetRow('preset-orchestrator', [nestedToolWeb({ search: false })]),
  ])
  editor.editFailure = new Error('preset row locked')
  const { service } = build({ editor })
  const result = await service.applySetup({ toolToggles: { search: true, fetch: false } })
  expect(result.ok).toBe(false)
  expect(result.pendingRestart?.ns).toBe('tool-web')
  expect(result.pendingRestart?.message).toContain('preset row locked')
})

it('refuses an apiKey without a selected provider, for a keyless provider, or without a vault', async () => {
  const { service } = build()
  expect(await service.applySetup({ search: { provider: null, apiKey: 'k' } }))
    .toEqual({ ok: false, applied: [], error: 'search.apiKey requires a selected search provider' })
  expect(await service.applySetup({ search: { provider: 'searxng', apiKey: 'k' } }))
    .toEqual({ ok: false, applied: [], error: 'the "searxng" provider takes no API key' })
  const { service: noVault } = build({ credentials: null })
  expect(await noVault.applySetup({ search: { provider: 'exa', apiKey: 'k' } }))
    .toEqual({ ok: false, applied: [], error: 'no credential provider is mounted; the key cannot be stored' })
})

it('reports a refusing vault write as an error without pendingRestart', async () => {
  const credentials = new FakeCredentials()
  credentials.setFailure = new Error('EXA_API_KEY is set by a read-only source')
  const { service } = build({ credentials })
  const result = await service.applySetup({ search: { provider: 'exa', apiKey: 'k' } })
  expect(result).toEqual({ ok: false, applied: [], error: 'EXA_API_KEY is set by a read-only source' })
})

it('refuses malformed applySetup input at the wire boundary', async () => {
  const { service } = build()
  const calls: Array<[unknown, string]> = [
    [undefined, 'applySetup: request must be an object'],
    [{ search: 7 }, 'applySetup: search must be an object'],
    [{ search: { provider: 7 } }, 'applySetup: search.provider must be a non-empty string or null'],
    [{ search: { provider: '' } }, 'applySetup: search.provider must be a non-empty string or null'],
    [{ search: { provider: 'exa', apiKey: '' } }, 'applySetup: search.apiKey must be a non-empty string'],
    [{ search: { provider: 'exa', baseURL: '' } }, 'applySetup: search.baseURL must be a non-empty string'],
    [{ fetch: 7 }, 'applySetup: fetch must be an object'],
    [{ fetch: { provider: 7 } }, 'applySetup: fetch.provider must be a non-empty string or null'],
    [{ toolToggles: 7 }, 'applySetup: toolToggles must be an object'],
    [{ toolToggles: { search: true } }, 'applySetup: toolToggles.search and toolToggles.fetch must be booleans'],
    [{ search: { provider: 'missing' } }, 'unknown search provider "missing"'],
    [{ fetch: { provider: 'exa' } }, '"exa" is a search provider, not fetch'],
  ]
  for (const [input, message] of calls) {
    const result = await service.applySetup(wireApply(input))
    expect(result.ok).toBe(false)
    expect(result.error).toBe(message)
    expect(result.applied).toEqual([])
  }
})

it('reports a missing config editor as pendingRestart', async () => {
  const { service } = build({ editor: null })
  const result = await service.applySetup({ search: { provider: 'exa' } })
  expect(result.ok).toBe(false)
  expect(result.pendingRestart?.ns).toBe('web-setup')
  expect(result.pendingRestart?.message).toContain('profile configuration editor is not mounted')
})

it('reports a missing web row as pendingRestart after committing the provider row', async () => {
  const editor = new FakeEditor([toolRow()])
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa' } })
  expect(result.ok).toBe(false)
  expect(result.applied).toEqual(['row:web-search-exa'])
  expect(result.pendingRestart?.ns).toBe('web')
  expect(result.pendingRestart?.message).toContain('"@deepseek-ai/dsh-web" row is not part of the running profile')
})

it('reports a web-row edit failure as pendingRestart', async () => {
  const editor = new FakeEditor([webRow(), toolRow()])
  editor.editFailure = new Error('overridden by a home patch')
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa' } })
  expect(result.ok).toBe(false)
  expect(result.applied).toEqual(['row:web-search-exa'])
  expect(result.pendingRestart?.ns).toBe('web')
  expect(result.pendingRestart?.message).toContain('overridden by a home patch')
})

it('reports a missing tool-web row as pendingRestart after committing provider and web rows', async () => {
  const editor = new FakeEditor([webRow()])
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa' }, toolToggles: { search: true, fetch: false } })
  expect(result.ok).toBe(false)
  expect(result.applied).toEqual(['row:web-search-exa', 'web.searchProvider'])
  expect(result.pendingRestart?.ns).toBe('tool-web')
})

it('reports a tool-row edit failure as pendingRestart', async () => {
  const editor = new FakeEditor([webRow(), toolRow()])
  let edits = 0
  const failing: WebSetupConfigEditor = {
    entries: () => editor.entries(),
    edit: async (entry, change) => {
      edits += 1
      if (edits > 1) throw new Error('tool row locked')
      await editor.edit(entry, change)
    },
    insert: row => editor.insert(row),
    remove: id => editor.remove(id),
  }
  const { service } = build({ overrides: { configEditor: failing } })
  const result = await service.applySetup({ search: { provider: 'exa' }, toolToggles: { search: true, fetch: false } })
  expect(result.ok).toBe(false)
  expect(result.applied).toEqual(['row:web-search-exa', 'web.searchProvider'])
  expect(result.pendingRestart?.ns).toBe('tool-web')
  expect(result.pendingRestart?.message).toContain('tool row locked')
})

it('never throws from a runtime apply failure', async () => {
  const { service } = build()
  const result = await service.applySetup(wireApply({ search: { provider: 'exa', apiKey: 'k' } }))
  expect(typeof result.ok).toBe('boolean')
})

it('names the row and the failure in the operator-facing restart message', () => {
  expect(pendingRestartMessage('web', 'row not found')).toBe(
    'Setup could not be applied while the service is running (row not found). The "web" change takes effect after a restart if the profile already carries it; if its provider package is missing, build the profile first, then restart the service.',
  )
})

it('mounts without a config editor and serves an empty status', async () => {
  const { service } = build({ editor: null })
  const status = await service.status()
  expect(status).toEqual({
    searchProvider: null,
    fetchProvider: null,
    mounted: [],
    credentials: {
      EXA_API_KEY: { configured: false, writable: true },
      DEEPSEEK_API_KEY: { configured: false, writable: true },
      BRAVE_API_KEY: { configured: false, writable: true },
      TAVILY_API_KEY: { configured: false, writable: true },
      JINA_API_KEY: { configured: false, writable: true },
    },
  })
})

it('probes with a caller-supplied baseURL and treats an empty one as absent', async () => {
  const urls: string[] = []
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(url)
    return new Response('{"results":[]}', { status: 200 })
  }
  const { service } = build({ overrides: { fetchImpl } })
  const signal = new AbortController().signal
  expect((await service.validateProvider({ kind: 'search', provider: 'exa', apiKey: 'k', baseURL: 'https://proxied.test' }, signal)).ok).toBe(true)
  expect(urls[0]).toBe('https://proxied.test/search')
  expect((await service.validateProvider(wireValidate({ kind: 'search', provider: 'exa', apiKey: '', baseURL: '' }), signal)).ok).toBe(true)
  expect(urls[1]).toBe('https://api.exa.ai/search')
})

it('probes keyless when the credential seam is absent', async () => {
  const requests: RequestInit[] = []
  const { service } = build({
    credentials: null,
    overrides: {
      fetchImpl: async (_url, init) => {
        requests.push(init ?? {})
        return new Response('{"results":[]}', { status: 200 })
      },
    },
  })
  const result = await service.validateProvider({ kind: 'search', provider: 'exa' }, new AbortController().signal)
  expect(result.ok).toBe(true)
  const headers = requests[0]?.headers as Record<string, string> | undefined
  expect(headers?.authorization).toBeUndefined()
})

it('names the credential reference in the missing-key refusal', () => {
  const deepseek = providerSpec('search', 'deepseek-official')
  if (deepseek === undefined) throw new Error('catalog missing deepseek-official')
  expect(missingCredentialError(deepseek)).toBe('deepseek-official needs a configured DEEPSEEK_API_KEY credential')
  expect(missingCredentialError({ ...deepseek, keyRef: null })).toBe('deepseek-official needs a configured credential')
})

it('unsets the fetch provider through the null path', async () => {
  const editor = new FakeEditor([webRow({ fetchProvider: 'http' }), toolRow({ search: false, fetch: true })])
  const { service } = build({ editor })
  const result = await service.applySetup({ fetch: { provider: null }, toolToggles: { search: false, fetch: false } })
  expect(result).toEqual({ ok: true, applied: ['web.fetchProvider', 'tool-web.fetch'] })
  expect(editor.rows.find(row => row.options.id === 'web')?.options.config).toEqual({})
})

it('skips a fetch row that already carries the template and a pointer that already matches', async () => {
  const editor = new FakeEditor([
    webRow({ fetchProvider: 'http' }),
    toolRow(),
    { options: { id: 'web-fetch-http', name: '@deepseek-ai/dsh-web-fetch-http' } },
  ])
  const { service } = build({ editor })
  expect(await service.applySetup({ fetch: { provider: 'http' } })).toEqual({ ok: true, applied: [] })
})

it('writes both toggles when the tool row carries no config yet', async () => {
  const editor = new FakeEditor([
    webRow(),
    { options: { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' } },
  ])
  const { service } = build({ editor })
  const result = await service.applySetup({ toolToggles: { search: false, fetch: false } })
  expect(result).toEqual({ ok: true, applied: ['tool-web.search', 'tool-web.fetch'] })
})

it('stringifies a non-Error seam failure', async () => {
  const service = new WebSetupService(new Context(), () => { throw 'seams down' })
  expect(await service.validateProvider({ kind: 'search', provider: 'exa' }, new AbortController().signal))
    .toEqual({ ok: false, error: 'seams down' })
})

it('reports an enabled provider-row edit failure as pendingRestart', async () => {
  const editor = new FakeEditor([
    webRow(),
    toolRow(),
    providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa', { apiKeyEnv: 'EXA_API_KEY' }),
  ])
  editor.editFailure = new Error('provider row locked')
  const { service } = build({ editor })
  const result = await service.applySetup({ search: { provider: 'exa', baseURL: 'https://exa.test' } })
  expect(result.ok).toBe(false)
  expect(result.pendingRestart?.ns).toBe('web-search-exa')
  expect(result.pendingRestart?.message).toContain('provider row locked')
})

it('skips already-matching tool targets while other targets change', async () => {
  const editor = new FakeEditor([
    webRow({ searchProvider: 'exa', fetchProvider: 'http' }),
    providerRow('web-search-exa', '@deepseek-ai/dsh-web-search-exa'),
    providerRow('web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'),
    providerRow('tool-web', '@deepseek-ai/dsh-tool-web', { search: true, fetch: false }),
    providerRow('tool-web-extra', '@deepseek-ai/dsh-tool-web', { search: false, fetch: false }),
    presetRow('preset-orchestrator', [nestedToolWeb({ search: true, fetch: false })]),
    presetRow('preset-sysadmin', [nestedToolWeb({ search: false, fetch: false }, true)]),
    presetRow('preset-creator', [nestedToolWeb({ search: false, fetch: false })]),
  ])
  const { service } = build({ editor })
  const result = await service.applySetup({ toolToggles: { search: false, fetch: false } })
  expect(result).toEqual({ ok: true, applied: ['tool-web.search'] })
  expect(editor.calls.filter(call => call.kind === 'edit').map(call => call.id)).toEqual(['tool-web', 'preset-orchestrator'])
})

it('leaves a preset config without a plugins array untouched', () => {
  const current = { id: 'preset', plugins: 'not-an-array' }
  expect(applyPresetToolToggles(current, { search: true, fetch: true })).toBe(current)
})
