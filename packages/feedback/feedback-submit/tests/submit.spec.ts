/**
 * feedback-submit unit suite: the client against a local stub endpoint —
 * success, one retry after a 500, permanent failure, timeout, and the
 * disabled switch (no request at all).
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FeedbackSubmit } from '../src/index.ts'
import type { FeedbackEndpointPayload } from '../src/index.ts'

const payload: FeedbackEndpointPayload = {
  app: { name: 'deepseek-harness', version: '1.2.3', commit: 'abc' },
  message: 'the dialog lost focus',
  flags: { systemInfo: true, context: true, session: true, message: true },
  meta: { submittedAt: '2026-10-12T00:00:00.000Z', installIdHash: 'hash' },
}

interface Stub {
  readonly server: Server
  readonly url: string
  readonly requests: { body: string; path: string }[]
  /** Queue of answers; each entry is a status or 'hang'. */
  answers: (number | 'hang')[]
}

const servers: Stub[] = []

async function stub(): Promise<Stub> {
  const requests: { body: string; path: string }[] = []
  const state = { answers: [] as (number | 'hang')[], index: 0 }
  const server = createServer((request: IncomingMessage, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      requests.push({ body, path: request.url ?? '' })
      const answer = state.answers[state.index] ?? 201
      state.index += 1
      if (answer === 'hang') return
      response.writeHead(answer, { 'content-type': 'application/json' })
      response.end(answer === 201 ? JSON.stringify({ id: `fb-${state.index}` }) : '{}')
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const created: Stub = {
    server,
    url: `http://127.0.0.1:${port}/feedback`,
    requests,
    get answers(): (number | 'hang')[] { return state.answers },
    set answers(value: (number | 'hang')[]) { state.answers = value; state.index = 0 },
  }
  servers.push(created)
  return created
}

afterEach(async () => {
  for (const entry of servers.splice(0)) {
    await new Promise<void>((resolve) => { entry.server.close(() => { resolve() }) })
  }
})

function client(url: string, overrides: { enabled?: boolean; timeoutMs?: number; retryDelayMs?: number } = {}): FeedbackSubmit {
  return new FeedbackSubmit(new Context(), {
    endpoint: url,
    enabled: overrides.enabled ?? true,
    timeoutMs: overrides.timeoutMs ?? 2_000,
    retryDelayMs: overrides.retryDelayMs ?? 5,
  })
}

describe('FeedbackSubmit', () => {
  it('posts the payload once and returns the server id', async () => {
    const entry = await stub()
    const result = await client(entry.url).submit(payload)
    expect(result).toEqual({ id: 'fb-1' })
    expect(entry.requests).toHaveLength(1)
    expect(JSON.parse(entry.requests[0]?.body ?? '{}')).toMatchObject({ message: 'the dialog lost focus' })
  })

  it('retries once after a 500 and succeeds', async () => {
    const entry = await stub()
    entry.answers = [500, 201]
    const result = await client(entry.url).submit(payload)
    expect(result).toEqual({ id: 'fb-2' })
    expect(entry.requests).toHaveLength(2)
  })

  it('returns null after two failures and never throws', async () => {
    const entry = await stub()
    entry.answers = [500, 500]
    const result = await client(entry.url).submit(payload)
    expect(result).toBeNull()
    expect(entry.requests).toHaveLength(2)
  })

  it('times out fail-soft with one retry', async () => {
    const entry = await stub()
    entry.answers = ['hang', 'hang']
    const result = await client(entry.url, { timeoutMs: 100, retryDelayMs: 5 }).submit(payload)
    expect(result).toBeNull()
    expect(entry.requests).toHaveLength(2)
  })

  it('does nothing when disabled', async () => {
    const entry = await stub()
    const submit = client(entry.url, { enabled: false })
    expect(submit.enabled()).toBe(false)
    expect(await submit.submit(payload)).toBeNull()
    expect(entry.requests).toHaveLength(0)
  })

  it('reports enabled by default with the shipped endpoint', () => {
    const submit = new FeedbackSubmit(new Context())
    expect(submit.enabled()).toBe(true)
  })
})
