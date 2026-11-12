/**
 * SDK-owned retry behaviour for the one pi-ai protocol that implements its own
 * retry loop.
 *
 * `openai-codex-responses` reads `maxRetries` and defaults to 0; the adapter
 * passes an explicit 0 in every attempt's options. These tests pin the outcome
 * at the wire: a retryable response is issued once, and a caller abort is not
 * followed by a second request. They also pin that pi-ai's codex adapter honors
 * an aborted SDK signal rather than reissuing the request.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
})

const servers: Server[] = []

/** JWT-shaped key whose payload carries the Codex account claim the SDK reads. */
function codexKey(): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' },
  })).toString('base64')
  return `header.${payload}.signature`
}

/** A local endpoint that counts requests and answers through `handler`. */
async function endpoint(handler: (count: number, response: import('node:http').ServerResponse) => void): Promise<{
  url: string
  requests: () => number
}> {
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    requests += 1
    handler(requests, response)
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests }
}

/** A single-route codex adapter forcing the SSE transport against a local endpoint. */
function adapterOf(baseURL: string): PiAiAdapter {
  // The installed catalog ships the Codex provider; its base URL and models are
  // repointed at the fixture, and the harness api-key method accepts a JWT.
  const profile: PiAiProviderProfile = {
    apiKeyEnv: 'CODEX_TEST_KEY',
    baseURL,
    transport: 'sse',
    models: [{ id: 'gpt-5.4', contextWindow: 128_000, maxTokens: 8192 }],
    streamIdleTimeoutMs: 5_000,
  }
  return new PiAiAdapter({
    profiles: () => resolveProfiles({ 'openai-codex': profile }),
    resolveApiKey: () => Promise.resolve(codexKey()),
    auth: memoryAuth(),
    log: () => {},
  })
}

async function collect(
  adapter: PiAiAdapter,
  route = { provider: 'openai-codex', model: 'gpt-5.4' },
  signal?: AbortSignal,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    ...route,
    messages: [],
    ...signal === undefined ? {} : { signal },
  })) {
    chunks.push(chunk)
  }
  return chunks
}

/** Whether the attempt surfaced a terminal provider failure rather than content. */
function failedTerminally(chunks: readonly StreamChunk[]): boolean {
  const finish = chunks.find(chunk => chunk.type === 'finish')
  return finish?.type === 'finish' && finish.reason.kind === 'error'
}

function openAiAdapterOf(baseURL: string): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      openai: {
        api: 'openai-completions',
        baseURL,
        models: [{ id: 'gpt-test', contextWindow: 65_536, maxTokens: 4096 }],
        streamIdleTimeoutMs: 5_000,
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
    log: () => {},
  })
}

describe('pi-ai SDK-owned retries', () => {
  it('disables the OpenAI SDK client default retries with maxRetries: 0', async () => {
    const server = await endpoint((_count, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
      response.end('{"error":{"code":"rate_limit_exceeded","message":"slow down"}}')
    })

    const chunks = await collect(openAiAdapterOf(server.url), { provider: 'openai', model: 'gpt-test' })

    // The OpenAI SDK defaults to two retries; the adapter's explicit zero must
    // reach it, or this endpoint would see three requests.
    expect(failedTerminally(chunks)).toBe(true)
    expect(server.requests()).toBe(1)
  })

  it('issues a retryable codex response once because maxRetries is zero', async () => {
    const server = await endpoint((_count, response) => {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
      response.end('{"error":{"code":"rate_limit_exceeded","message":"slow down"}}')
    })

    const chunks = await collect(adapterOf(server.url))

    // A second request would prove the SDK retried with its own policy; the
    // adapter's explicit maxRetries: 0 makes one request the whole attempt.
    expect(failedTerminally(chunks)).toBe(true)
    expect(server.requests()).toBe(1)
  })

  it('does not reissue a codex request after the caller aborts', async () => {
    const server = await endpoint((_count, _response) => {
      // Hold the response head open: the abort has to stop the pending fetch.
    })

    const controller = new AbortController()
    const reading = collect(adapterOf(server.url), undefined, controller.signal)
    setTimeout(() => { controller.abort('caller stopped waiting') }, 100)

    const chunks = await reading

    expect(chunks.find(chunk => chunk.type === 'finish')?.type).toBe('finish')
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.type === 'finish' ? finish.reason.kind : undefined).toBe('aborted')
    expect(server.requests()).toBe(1)
  })
})
