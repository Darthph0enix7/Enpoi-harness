/**
 * Failure classes: request-level errors are never retryable; quota/auth/rate
 * classes are distinct; "Proxy use detected" names the bypassed keypool.
 */
import { expect, it } from 'vitest'
import { classifyCommandCodeError, errorMessageFromBody } from '../src/errors.js'

it('classifies a request validation 400 as INVALID_REQUEST', () => {
  const body = '{"error":{"message":"Invalid request error. Often missing required parameters or typo. HINT: Validation error: Invalid input: expected string, received undefined at \\"memory\\""}}'
  const failure = classifyCommandCodeError(400, body)
  expect(failure.code).toBe('INVALID_REQUEST')
  expect(failure.message).toContain('Validation error')
})

it('classifies context-length 400s as CONTEXT_WINDOW_EXCEEDED (never rotated)', () => {
  const failure = classifyCommandCodeError(400, '{"error":{"message":"The request is longer than the model\'s context length"}}')
  expect(failure.code).toBe('CONTEXT_WINDOW_EXCEEDED')
})

it('classifies "Proxy use detected" as PROXY_USE_DETECTED', () => {
  const failure = classifyCommandCodeError(400, '{"error":{"message":"Proxy use detected. This endpoint only serves CLI. Use Command Code provider API instead."}}')
  expect(failure.code).toBe('PROXY_USE_DETECTED')
  expect(failure.message).toContain('keypool')
})

it('classifies quota, rate, auth, server and transport classes', () => {
  expect(classifyCommandCodeError(429, '{"error":{"message":"You have reached your weekly usage limit. Resets in 3h 25m."}}').code).toBe('QUOTA')
  expect(classifyCommandCodeError(400, '{"error":{"message":"insufficient credits"}}').code).toBe('QUOTA')
  expect(classifyCommandCodeError(429, '{"error":{"message":"Too many requests"}}').code).toBe('RATE_LIMIT')
  expect(classifyCommandCodeError(403, '{"error":{"message":"Forbidden"}}').code).toBe('AUTH')
  expect(classifyCommandCodeError(500, 'oops')).toMatchObject({ code: 'SERVER', message: 'oops' })
  expect(classifyCommandCodeError(0, '{"error":{"message":"upstream network error"}}').code).toBe('SERVER')
})

it('extracts messages from {error:{message}}, {error:string} and plain text', () => {
  expect(errorMessageFromBody('{"error":{"message":"a"}}')).toBe('a')
  expect(errorMessageFromBody('{"error":"b"}')).toBe('b')
  expect(errorMessageFromBody('{"message":"c"}')).toBe('c')
  expect(errorMessageFromBody('plain text')).toBe('plain text')
  expect(errorMessageFromBody('<html>')).toBe('<html>')
})
