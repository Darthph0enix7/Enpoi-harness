// @vitest-environment node
/**
 * Sibling endpoint enrichment, consensus resolution, and host-wins precedence
 * tests across multi-protocol proxies (CLIProxyAPI), local engines (Ollama,
 * LM Studio, LiteLLM), and owner-scoped models.dev fallbacks.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { enrichFromSiblingEndpoints } from '../src/sibling-discovery.ts'
import { loadBundledRegistryMetadataIndex, resolveRegistryConsensus } from '../src/registry-metadata.ts'

const servers: Server[] = []
const directories: string[] = []
const originalModelsDevPath = process.env.DSH_MODELS_DEV_PATH

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

afterAll(() => {
  if (originalModelsDevPath === undefined) Reflect.deleteProperty(process.env, 'DSH_MODELS_DEV_PATH')
  else process.env.DSH_MODELS_DEV_PATH = originalModelsDevPath
})

async function multiRouteServer(
  handler: (url: string, method: string, headers: IncomingMessage['headers'], body: string) => { status: number; json: unknown },
): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const target = request.url ?? ''
      hits.push(`${request.method ?? 'GET'} ${target}`)
      const reply = handler(target, request.method ?? 'GET', request.headers, Buffer.concat(chunks).toString('utf8'))
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(reply.json))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${String(address.port)}`, hits }
}

describe('sibling endpoint enrichment', () => {
  it('skips probing entirely when primary listing models already have full metadata', async () => {
    const { url, hits } = await multiRouteServer(() => ({ status: 200, json: {} }))
    const models = [{
      id: 'rich-model',
      name: 'Rich Model',
      contextWindow: 128_000,
      maxTokens: 16_384,
      input: ['text' as const, 'image' as const],
      tools: true,
      reasoning: true,
    }]
    await enrichFromSiblingEndpoints(`${url}/v1`, models)
    expect(hits).toEqual([])
  })

  it('enriches minimal OpenAI listings from Gemini /v1beta/models and Anthropic /v1/models without altering membership', async () => {
    const { url } = await multiRouteServer((target, _method, headers) => {
      if (target === '/v1beta/models') {
        return {
          status: 200,
          json: {
            models: [
              {
                name: 'models/claude-fable-5-2',
                displayName: 'Claude Fable 5.2',
                inputTokenLimit: 1_000_000,
                outputTokenLimit: 128_000,
                supportedInputModalities: ['text', 'image'],
              },
              {
                name: 'models/gemini-3.8-flash-tiered',
                displayName: 'Gemini 3.8 Flash (Tiered)',
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 65_536,
                supportedInputModalities: ['text', 'image', 'audio', 'video'],
              },
              {
                name: 'models/extra-sibling-only',
                displayName: 'Should Never Appear',
                inputTokenLimit: 999_999,
              },
            ],
          },
        }
      }
      if (target === '/v1/models?limit=1000' && headers['anthropic-version'] === '2023-06-01') {
        return {
          status: 200,
          json: {
            data: [{
              id: 'claude-fable-5-2',
              display_name: 'Claude Fable 5.2',
              max_input_tokens: 1_000_000,
              max_tokens: 128_000,
              capabilities: { pdf_input: { supported: true } },
            }],
          },
        }
      }
      return { status: 404, json: {} }
    })

    const primary = [
      { id: 'claude-fable-5-2' },
      { id: 'gemini-3.8-flash-tiered' },
    ]
    await enrichFromSiblingEndpoints(`${url}/v1`, primary, { api: 'openai-completions', key: 'test-key' })
    expect(primary.map(m => m.id)).toEqual(['claude-fable-5-2', 'gemini-3.8-flash-tiered'])
    expect(primary[0]).toMatchObject({
      id: 'claude-fable-5-2',
      name: 'Claude Fable 5.2',
      maxInputTokens: 1_000_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
    })
    expect(primary[1]).toMatchObject({
      id: 'gemini-3.8-flash-tiered',
      name: 'Gemini 3.8 Flash (Tiered)',
      maxInputTokens: 1_048_576,
      maxTokens: 65_536,
      input: ['text', 'image', 'audio', 'video'],
    })
  })

  it('reads Ollama configured num_ctx over GGUF default and LM Studio loaded_context_length', async () => {
    const { url: ollamaUrl } = await multiRouteServer((target, method, _headers, body) => {
      if (target === '/api/tags') {
        return { status: 200, json: { models: [{ name: 'qwen3:32b' }] } }
      }
      if (target === '/api/show' && method === 'POST' && JSON.parse(body).model === 'qwen3:32b') {
        return {
          status: 200,
          json: {
            parameters: 'temperature 0.6\nnum_ctx 16384\n',
            model_info: { 'qwen3.context_length': 131_072 },
            capabilities: ['completion', 'tools', 'thinking'],
          },
        }
      }
      return { status: 404, json: {} }
    })

    const ollamaModels = [{ id: 'qwen3:32b' }]
    await enrichFromSiblingEndpoints(`${ollamaUrl}/v1`, ollamaModels)
    expect(ollamaModels[0]).toMatchObject({
      id: 'qwen3:32b',
      contextWindow: 16_384,
      tools: true,
      reasoning: true,
    })

    const { url: lmsUrl } = await multiRouteServer((target) => {
      if (target === '/api/v0/models') {
        return {
          status: 200,
          json: {
            data: [{
              id: 'local-vl',
              type: 'vlm',
              loaded_context_length: 8_192,
              max_context_length: 32_768,
              capabilities: ['tool_use'],
            }],
          },
        }
      }
      return { status: 404, json: {} }
    })

    const lmsModels = [{ id: 'local-vl' }]
    await enrichFromSiblingEndpoints(`${lmsUrl}/v1`, lmsModels)
    expect(lmsModels[0]).toMatchObject({
      id: 'local-vl',
      contextWindow: 8_192,
      input: ['text', 'image'],
      tools: true,
    })
  })
})

describe('consensus resolution and host-first precedence', () => {
  it('preserves unanimous Codex fields and leaves differing tier contextWindow null', () => {
    const index = loadBundledRegistryMetadataIndex()
    const consensus = resolveRegistryConsensus(index, 'gpt-5.6-sol', { owner: 'openai' })
    expect(consensus.status).toBe('resolved')
    if (consensus.status !== 'resolved') return
    expect(consensus.metadata).toMatchObject({
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      contextWindow: null,
      maxTokens: 128_000,
      inputModalities: ['text', 'image'],
      reasoning: true,
    })
    expect(consensus.metadata.effort?.supportedKeys).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('uses owned_by to resolve models.dev & openrouter metadata while never overwriting smaller host limits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-owner-mdev-'))
    directories.push(directory)
    const mdevPath = join(directory, 'models.json')
    writeFileSync(mdevPath, JSON.stringify({
      anthropic: {
        models: {
          'claude-fable-5-2': {
            name: 'Claude Fable 5.2',
            limit: { context: 1_000_000, output: 128_000 },
            modalities: { input: ['text', 'image', 'pdf'] },
            reasoning: true,
            tool_call: true,
          },
        },
      },
      openai: {
        models: {
          'gpt-5.6-sol': {
            name: 'GPT-5.6 Sol',
            limit: { context: 1_050_000, output: 128_000 },
            modalities: { input: ['text', 'image', 'pdf'] },
            reasoning: true,
            tool_call: true,
          },
        },
      },
      meta: {
        models: {
          'llama-3.3-70b': {
            name: 'Llama 3.3 70B',
            limit: { context: 131_072, output: 8_192 },
            tool_call: true,
          },
        },
      },
      openrouter: {
        models: {
          'anthropic/claude-fable-5.3': {
            name: 'Claude Fable 5.3',
            limit: { context: 1_000_000, output: 128_000 },
            modalities: { input: ['text', 'image'] },
            reasoning: true,
            tool_call: true,
          },
        },
      },
    }))
    process.env.DSH_MODELS_DEV_PATH = mdevPath
    vi.resetModules()
    const { planRouteModels } = await import('../src/index.ts')

    const planned = planRouteModels({
      route: 'renamed-cpa',
      configured: [],
      live: [
        { id: 'claude-fable-5-2', owner: 'anthropic' },
        { id: 'claude-fable-5-3', owner: 'anthropic' },
        // Host disclosed a smaller 372K tier cap via /v1beta/models: 1.05M must NOT overwrite it.
        { id: 'gpt-5.6-sol', owner: 'openai', maxInputTokens: 372_000, maxTokens: 128_000 },
        // Generic local host (`owned_by: 'vllm'`) disclosing nothing must NOT borrow meta's 131K.
        { id: 'llama-3.3-70b', owner: 'vllm' },
        // Self-hosted vLLM disclosing exact --max-model-len 32K keeps 32K even if owned_by is meta.
        { id: 'llama-3.3-70b-32k', owner: 'vllm', contextWindow: 32_768 },
      ],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    })

    const byId = new Map(planned.models.map(model => [String(model.id), model]))
    expect(byId.get('claude-fable-5-2')).toMatchObject({
      name: 'Claude Fable 5.2',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: true,
      tools: true,
    })
    expect(byId.get('claude-fable-5-2')?.unverified).toBeUndefined()

    expect(byId.get('claude-fable-5-3')).toMatchObject({
      name: 'Claude Fable 5.3',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: true,
      tools: true,
    })

    const gpt = byId.get('gpt-5.6-sol')!
    expect(gpt.maxInputTokens).toBe(372_000)
    expect(gpt.contextWindow).toBeUndefined()
    expect(gpt.unverified).toBeUndefined()

    // Sibling-described model retains its live 1M+ / 65K limits and modalities,
    // while accurately flagging an unverified reasoning hint when neither
    // /v1beta nor models.dev disclosed reasoning.
    const tiered = planRouteModels({
      route: 'renamed-cpa',
      configured: [],
      live: [{
        id: 'gemini-3.8-flash-tiered',
        owner: 'antigravity',
        maxInputTokens: 1_048_576,
        maxTokens: 65_536,
        input: ['text', 'image', 'audio', 'video'],
      }],
      catalogRoute: false,
      endpointFresh: true,
      catalogFresh: true,
      now: 1_000_000,
    }).models[0]!
    expect(tiered.maxInputTokens).toBe(1_048_576)
    expect(tiered.maxTokens).toBe(65_536)
    expect(tiered.input).toEqual(['text', 'image', 'audio', 'video'])
    expect(tiered.unverified).toBe(true)

    const localBare = byId.get('llama-3.3-70b')!
    expect(localBare.contextWindow).toBeUndefined()
    expect(localBare.unverified).toBe(true)

    const localSized = byId.get('llama-3.3-70b-32k')!
    expect(localSized.contextWindow).toBe(32_768)
    expect(localSized.unverified).toBeUndefined()
  })
})
