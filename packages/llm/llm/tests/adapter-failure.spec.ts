import { describe, expect, it } from 'vitest'
import { normalizeLlmFailure } from '../src/adapter-failure.ts'
import { LlmError, ProviderRequestId } from '../src/index.ts'

describe('adapter failure normalization', () => {
  it('contains hostile non-Error coercion', () => {
    const thrown = { [Symbol.toPrimitive]: () => { throw new Error('coercion failed') } }
    expect(normalizeLlmFailure(thrown)).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
  })

  it('normalizes empty primitive throws and data descriptors without values', () => {
    expect(normalizeLlmFailure('')).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
    expect(normalizeLlmFailure(null)).toEqual({ message: 'null', code: 'UNKNOWN' })

    const error = new Error('provider failed')
    Object.defineProperty(error, 'failure', { get: () => ({ message: 'ignored', code: 'IGNORED' }) })
    Object.defineProperty(error, 'code', { get: () => 'IGNORED' })
    expect(normalizeLlmFailure(error)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const accessorCode = Object.assign(new Error('provider failed'), {
      failure: { message: 'provider failed', code: 'FOREIGN' },
    })
    Object.defineProperty(accessorCode, 'code', { get: () => 'FOREIGN' })
    expect(normalizeLlmFailure(accessorCode)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const primitiveFailure = Object.assign(new Error('provider failed'), {
      failure: null,
      code: 'FOREIGN',
    })
    expect(normalizeLlmFailure(primitiveFailure)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('contains hostile Error property reflection', () => {
    const withFailure = new Error('provider failed') as Error & { failure: unknown; code: string }
    withFailure.failure = { message: 'provider failed', code: 'FOREIGN' }
    withFailure.code = 'FOREIGN'
    const hostileCode = new Proxy(withFailure, {
      getOwnPropertyDescriptor(target, property) {
        if (property === 'code') throw new Error('code descriptor failed')
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    expect(normalizeLlmFailure(hostileCode)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const hostileFailure = new Proxy(new Error('provider failed'), {
      getOwnPropertyDescriptor() { throw new Error('failure descriptor failed') },
    })
    expect(normalizeLlmFailure(hostileFailure)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('rejects malformed or accessor-backed failure snapshots', () => {
    const malformed = new Error('provider failed') as Error & { failure: unknown; code: string }
    malformed.failure = { message: 'provider failed', code: 'FOREIGN', requestId: '' }
    malformed.code = 'FOREIGN'
    expect(normalizeLlmFailure(malformed)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })

    const accessorBacked = new Error('provider failed') as Error & { failure: unknown }
    accessorBacked.failure = Object.defineProperty({}, 'message', {
      get() { throw new Error('failure getter failed') },
    })
    expect(normalizeLlmFailure(accessorBacked)).toEqual({ message: 'provider failed', code: 'UNKNOWN' })
  })

  it('falls back when an Error message accessor throws', () => {
    const error = new Error('provider failed')
    Object.defineProperty(error, 'message', { get() { throw new Error('message getter failed') } })
    expect(normalizeLlmFailure(error)).toEqual({ message: 'LLM adapter failed', code: 'UNKNOWN' })
  })
})

describe('adapter failure reset hints', () => {
  it('recovers a pre-stream reset hint from an SDK header, body, or flattened message', () => {
    const header = Object.assign(new Error('429: Too Many Requests'), {
      status: 429,
      headers: new Headers({ 'retry-after': '2' }),
    })
    expect(normalizeLlmFailure(header)).toEqual({
      message: '429: Too Many Requests',
      code: 'UNKNOWN',
      providerRetryAfterMs: 2_000,
    })

    const body = Object.assign(new Error('429 refused'), {
      status: 429,
      error: { retry_after_ms: 2_500 },
    })
    expect(normalizeLlmFailure(body)).toEqual({
      message: '429 refused',
      code: 'UNKNOWN',
      providerRetryAfterMs: 2_500,
    })

    const text = new Error('429: {"type":"error","error":{"retry_after":17}}')
    expect(normalizeLlmFailure(text)).toEqual({
      message: text.message,
      code: 'UNKNOWN',
      providerRetryAfterMs: 17_000,
    })
  })

  it('adds the hint beside a carried failure without replacing its facts', () => {
    const failure = new LlmError('rate limited', 'RATE_LIMIT', { status: 429, requestId: ProviderRequestId('req-1') })
    const withHeader = Object.assign(failure, { headers: new Headers({ 'retry-after': '3' }) })
    expect(normalizeLlmFailure(withHeader)).toEqual({
      message: 'rate limited',
      code: 'RATE_LIMIT',
      status: 429,
      requestId: 'req-1',
      providerRetryAfterMs: 3_000,
    })
  })
})
