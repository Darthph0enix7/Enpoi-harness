/**
 * Capability truth for unknown and disclosed models: an id the catalog does
 * not describe claims neither vision nor tools, configured `input` fills an
 * unanswered modality only, `tool_call:false` sends no tools, and the
 * converter's default admits no image.
 */
import { expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { CommandCodeRouteModel, CommandCodeAdapterOptions } from '../src/adapter.js'
import { CommandCodeAdapter } from '../src/adapter.js'
import { CatalogStore, parseCatalog, type CatalogEntry } from '../src/catalog.js'
import { buildRequest } from '../src/convert.js'

const SSE_OK = [
  'data: {"type":"text-start","id":"t1"}',
  'data: {"type":"text-delta","id":"t1","text":"ok"}',
  'data: {"type":"text-end","id":"t1"}',
  'data: {"type":"finish-step","finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1}}',
  '',
  '',
].join('\n')

const TOOL: ToolSchema = { name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: {} } }

const SNAPSHOT: CatalogEntry[] = parseCatalog([
  { id: 'vision/model', name: 'Vision', attachment: true, modalities: { input: ['text', 'image'] } },
  { id: 'text/model', name: 'Text', modalities: { input: ['text'] } },
  { id: 'tools-off/model', name: 'No Tools', tool_call: false },
  { id: 'tools-on/model', name: 'Tools', tool_call: true },
])

function makeAdapter(
  models: CommandCodeRouteModel[] | undefined,
  fetchImpl: typeof fetch,
  extra: Partial<CommandCodeAdapterOptions> = {},
): CommandCodeAdapter {
  const catalog = new CatalogStore({
    baseURL: 'http://catalog.invalid',
    snapshot: SNAPSHOT,
    fetchImpl: async () => { throw new Error('catalog offline in tests') },
  })
  return new CommandCodeAdapter({
    profiles: () => new Map([['commandcode', {
      route: 'commandcode',
      displayName: 'Command Code',
      baseURL: 'http://127.0.0.1:18080',
      keyless: true,
      userImageMaxPixels: 1024 * 1024,
      userImageMaxBytes: 1024 * 1024,
      ...models === undefined ? {} : { models },
    }]]),
    catalogFor: () => catalog,
    resolveApiKey: async () => undefined,
    fetchImpl,
    ...extra,
  })
}

function captureFetch(bodies: string[]): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    bodies.push(String(init?.body ?? ''))
    return new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}

async function run(adapter: CommandCodeAdapter, options: GenerateOptions): Promise<void> {
  for await (const _chunk of adapter.stream(options) as AsyncGenerator<StreamChunk>) { /* drain */ }
}

const IMAGE_MESSAGE = {
  role: 'user',
  content: [{
    type: 'image',
    attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
  }],
} as never

const readUserImage = async (): Promise<{ data: Uint8Array; mediaType: string }> => ({
  data: Uint8Array.of(1, 2, 3),
  mediaType: 'image/png',
})

it('an unknown model id resolves no input modalities and forwards no image', async () => {
  const bodies: string[] = []
  const adapter = makeAdapter(undefined, captureFetch(bodies), { readUserImage })
  const info = await adapter.resolveModel('commandcode', 'not-in-catalog')
  expect(info.inputModalities).toBeUndefined()
  expect(info.tools).toBeUndefined()

  await run(adapter, { provider: 'commandcode', model: 'not-in-catalog', messages: [IMAGE_MESSAGE] })
  const body = JSON.parse(bodies[0]!) as { params: { messages: Array<{ content: unknown }> } }
  const content = body.params.messages[0]!.content
  expect(JSON.stringify(content)).toContain('does not accept image input')
  expect(JSON.stringify(content)).not.toContain('data:image')
})

it('resolves only exact ids: a vendor-stripped short id borrows nothing', async () => {
  const adapter = makeAdapter(undefined, captureFetch([]))
  const exact = await adapter.resolveModel('commandcode', 'vision/model')
  expect(exact.inputModalities).toEqual(['text', 'image'])
  const short = await adapter.resolveModel('commandcode', 'model')
  expect(short.name).toBe('model')
  expect(short.inputModalities).toBeUndefined()
  const listed = await adapter.listModels('commandcode')
  expect(listed.some(model => model.id === 'model')).toBe(false)
})

it('uses a configured model input as the fallback only when the catalog is silent', async () => {
  const adapter = makeAdapter([
    { id: 'configured-text', input: ['text'] },
    { id: 'configured-image', input: ['text', 'image'] },
    // The catalog states text only; configuration does not override it.
    { id: 'text/model', input: ['text', 'image'] },
  ], captureFetch([]))

  expect((await adapter.resolveModel('commandcode', 'configured-text')).inputModalities).toEqual(['text'])
  expect((await adapter.resolveModel('commandcode', 'configured-image')).inputModalities).toEqual(['text', 'image'])
  expect((await adapter.resolveModel('commandcode', 'text/model')).inputModalities).toEqual(['text'])
  expect((await adapter.resolveModel('commandcode', 'unknown-configured')).inputModalities).toBeUndefined()
})

it('a configured image model admits an image even when the catalog lacks the id', async () => {
  const bodies: string[] = []
  const adapter = makeAdapter([{ id: 'configured-image', input: ['text', 'image'] }], captureFetch(bodies), { readUserImage })
  await run(adapter, { provider: 'commandcode', model: 'configured-image', messages: [IMAGE_MESSAGE] })
  expect(bodies[0]).toContain('data:image/png')
})

it('honors catalog tool_call:false by sending no tools and advertising tools:false', async () => {
  const bodies: string[] = []
  const adapter = makeAdapter(undefined, captureFetch(bodies))
  const off = await adapter.resolveModel('commandcode', 'tools-off/model')
  expect(off.tools).toBe(false)
  expect((await adapter.listModels('commandcode')).find(model => model.id === 'tools-off/model')?.tools).toBe(false)

  await run(adapter, { provider: 'commandcode', model: 'tools-off/model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [TOOL] })
  const body = JSON.parse(bodies[0]!) as { params: { tools: unknown[] } }
  expect(body.params.tools).toEqual([])

  const on = await adapter.resolveModel('commandcode', 'tools-on/model')
  expect(on.tools).toBe(true)
  await run(adapter, { provider: 'commandcode', model: 'tools-on/model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [TOOL] })
  const withTools = JSON.parse(bodies[1]!) as { params: { tools: Array<{ name: string }> } }
  expect(withTools.params.tools.map(tool => tool.name)).toEqual(['lookup'])
  // Unknown catalog capability stays undisclosed rather than fabricating tool support.
  expect((await adapter.resolveModel('commandcode', 'not-in-catalog')).tools).toBeUndefined()
})

it('the converter admits no image unless the caller states the model accepts one', () => {
  const image = { type: 'file', mediaType: 'image/png', data: 'AAAA' }
  const omitted = buildRequest({ model: 'm', messages: [{ role: 'user', content: [image] }] })
  expect(JSON.stringify(omitted.params.messages)).toContain('does not accept image input')
  const admitted = buildRequest({ model: 'm', visionEnabled: true, messages: [{ role: 'user', content: [image] }] })
  expect(JSON.stringify(admitted.params.messages)).toContain('data:image/png')
})
