import { describe, expect, it } from 'vitest'
import { parseProviderRetryAfterMs } from '../src/provider-retry.ts'

const NOW = Date.parse('2026-10-31T12:00:00Z')
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1_000

describe('parseProviderRetryAfterMs', () => {
  it.each([
    // Header: numeric seconds.
    ['header seconds', { retryAfterHeader: '120' }, 120_000],
    ['header decimal seconds', { retryAfterHeader: '1.5' }, 1_500],
    ['header whitespace', { retryAfterHeader: ' 7 ' }, 7_000],
    // Header: HTTP-date relative to the injected clock.
    ['header HTTP-date', { retryAfterHeader: new Date(NOW + 3_000).toUTCString(), now: NOW }, 3_000],
    // Body: retry_after_ms is milliseconds, nested or top level.
    ['nested retry_after_ms', { body: { error: { retry_after_ms: 2_500 } } }, 2_500],
    ['top-level retry_after_ms', { body: { retry_after_ms: 120_000 } }, 120_000],
    // Body: Anthropic retry_after is seconds, nested or top level.
    ['nested retry_after seconds', { body: { error: { retry_after: 60 } } }, 60_000],
    ['top-level retry_after seconds', { body: { retry_after: 17_337 } }, 17_337_000],
    // A flattened message carrying a JSON envelope is parsed like the body.
    ['flattened nested seconds', { message: '429: {"type":"error","error":{"retry_after":90}}', now: NOW }, 90_000],
    ['flattened top-level ms', { message: '{"message":"slow","retry_after_ms":120000}' }, 120_000],
    ['raw JSON string body', { body: '{"error":{"retry_after_ms":2500}}' }, 2_500],
  ] as const)('%s', (_name, sources, expected) => {
    expect(parseProviderRetryAfterMs(sources)).toBe(expected)
  })

  it('prefers the header, then the body, then the flattened message', () => {
    expect(parseProviderRetryAfterMs({
      retryAfterHeader: '2',
      body: { retry_after_ms: 5_000 },
      message: '{"retry_after":9}',
    })).toBe(2_000)
    expect(parseProviderRetryAfterMs({
      body: { retry_after_ms: 5_000 },
      message: '{"retry_after":9}',
    })).toBe(5_000)
  })

  it('prefers retry_after_ms over retry_after at any nesting level', () => {
    expect(parseProviderRetryAfterMs({
      body: { error: { retry_after: 60 }, retry_after_ms: 2_500 },
    })).toBe(2_500)
    expect(parseProviderRetryAfterMs({
      body: { error: { retry_after_ms: 2_500, retry_after: 60 } },
    })).toBe(2_500)
  })

  it('reads the nested error record before its top-level sibling', () => {
    expect(parseProviderRetryAfterMs({
      body: { error: { retry_after: 30 }, retry_after: 90 },
    })).toBe(30_000)
  })

  it('clamps every source to seven days', () => {
    expect(parseProviderRetryAfterMs({ retryAfterHeader: '999999999' })).toBe(SEVEN_DAYS)
    expect(parseProviderRetryAfterMs({ body: { retry_after_ms: 999_999_999_999 } })).toBe(SEVEN_DAYS)
    expect(parseProviderRetryAfterMs({ body: { retry_after: 999_999_999 } })).toBe(SEVEN_DAYS)
    expect(parseProviderRetryAfterMs({
      retryAfterHeader: new Date(NOW + 30 * 24 * 60 * 60 * 1_000).toUTCString(),
      now: NOW,
    })).toBe(SEVEN_DAYS)
  })

  it.each([
    ['missing header', { retryAfterHeader: null }],
    ['empty header', { retryAfterHeader: ' ' }],
    ['invalid header', { retryAfterHeader: 'soon' }],
    ['zero header', { retryAfterHeader: '0' }],
    ['negative header', { retryAfterHeader: '-5' }],
    ['past HTTP-date', { retryAfterHeader: new Date(NOW - 1_000).toUTCString(), now: NOW }],
    ['zero body', { body: { retry_after_ms: 0, retry_after: 0 } }],
    ['negative body', { body: { retry_after: -5 } }],
    ['non-finite body', { body: { retry_after: 1e999 } }],
    ['non-number body', { body: { retry_after_ms: '2500' } }],
    ['no envelope in text', { message: 'HTTP 429: too many requests' }],
    ['non-JSON envelope', { message: '{not json}' }],
    ['nothing at all', {}],
  ] as const)('ignores %s', (_name, sources) => {
    expect(parseProviderRetryAfterMs(sources)).toBeUndefined()
  })

  it('accepts an Array or primitive body only through its flattened message', () => {
    expect(parseProviderRetryAfterMs({ body: [1, 2] })).toBeUndefined()
    expect(parseProviderRetryAfterMs({ body: 'not json' })).toBeUndefined()
    expect(parseProviderRetryAfterMs({ body: undefined, message: '{"retry_after_ms":7}' })).toBe(7)
  })
})
