/** Direct provider refusal terminals: structured evidence only, with usage preserved. */
import { afterEach, describe, expect, it } from 'vitest'
import { LlmError, POLICY_REFUSAL_CODE } from '@deepseek-ai/dsh-llm'
import { adapter, assemble, chunks, options, server, sse, start } from './helpers.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})
async function endpoint(...args: Parameters<typeof server>) {
  const instance = await server(...args)
  cleanup.push(() => instance.close())
  return instance
}

describe('direct Messages refusals', () => {
  it('reports a structured HTTP refusal before status and wording classification', async () => {
    const http = await endpoint((response) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        error: { code: 'content_filter', message: 'quota and authentication wording must not win' },
      }))
    })
    const error = await chunks(adapter({ baseURL: http.url }).stream(options())).catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      code: POLICY_REFUSAL_CODE,
      message: 'quota and authentication wording must not win',
      failure: { status: 500 },
    })
  })

  it('keeps a refusal out of the credential layer auth classifier', async () => {
    const http = await endpoint((response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        error: { code: 'content_filter', message: 'provider policy blocked the request' },
      }))
    })
    const llm = adapter({ baseURL: http.url }, {
      resolveAuth: () => Promise.resolve({
        headers: { 'x-api-key': 'test-key' },
        onRequestError: async error => error instanceof LlmError
          ? new LlmError(error.message, 'AUTH', { ...error.failure, cause: error })
          : error,
      }),
    })
    await expect(chunks(llm.stream(options()))).rejects.toMatchObject({
      code: POLICY_REFUSAL_CODE,
      message: 'provider policy blocked the request',
    })
  })

  it('reports a content-filter stop as a terminal refusal with usage', async () => {
    const http = await endpoint((response) => {
      response.end(sse([
        start,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'content_filter', content_filter: { message: 'provider policy' } },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]))
    })
    const result = await assemble(adapter({ baseURL: http.url }).stream(options()))
    expect(result.assembler.finish).toMatchObject({
      kind: 'error',
      failure: { code: POLICY_REFUSAL_CODE, message: 'provider policy' },
    })
    expect(result.output).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    })
  })

  it('reports an in-band refusal event as a terminal refusal with accumulated usage', async () => {
    const http = await endpoint((response) => {
      response.end(sse([
        start,
        { type: 'error', error: { code: 'content_filter', message: 'provider explanation' }, usage: { output_tokens: 2 } },
      ]))
    })
    const result = await assemble(adapter({ baseURL: http.url }).stream(options()))
    expect(result.assembler.finish).toMatchObject({
      kind: 'error',
      failure: { code: POLICY_REFUSAL_CODE, message: 'provider explanation' },
    })
    expect(result.output).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
    })
  })
})
