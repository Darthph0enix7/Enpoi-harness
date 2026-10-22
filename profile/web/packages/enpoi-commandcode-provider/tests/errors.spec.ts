/**
 * Failure classes: request-level errors are never retryable; quota/auth/rate
 * classes are distinct; "Proxy use detected" names the missing CLI header set.
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
  expect(failure.message).toContain('CLI headers')
})

it('classifies quota, rate, auth, server and transport classes', () => {
  expect(classifyCommandCodeError(429, '{"error":{"message":"You have reached your weekly usage limit. Resets in 3h 25m."}}').code).toBe('QUOTA')
  expect(classifyCommandCodeError(400, '{"error":{"message":"insufficient credits"}}').code).toBe('QUOTA')
  expect(classifyCommandCodeError(429, '{"error":{"message":"Too many requests"}}').code).toBe('RATE_LIMIT')
  expect(classifyCommandCodeError(403, '{"error":{"message":"Forbidden"}}').code).toBe('AUTH')
  expect(classifyCommandCodeError(500, 'oops')).toMatchObject({ code: 'SERVER', message: 'oops' })
  expect(classifyCommandCodeError(0, '{"error":{"message":"upstream network error"}}').code).toBe('SERVER')
})

it('classifies a 500 carrying the dangling-tool-call sentence as INVALID_REQUEST', () => {
  // The exact body from the incident: a 500 whose content is a validation
  // sentence. Rotating identities cannot fix it, so status must not win.
  const body = '{"type":"server_error","message":"Tool result is missing for tool call call_00_9boejr0piu3rhreimujs7766."}'
  const failure = classifyCommandCodeError(500, body)
  expect(failure.code).toBe('INVALID_REQUEST')
  expect(failure.message).toBe('Tool result is missing for tool call call_00_9boejr0piu3rhreimujs7766.')
})

it('recognises the request-shape patterns at any status', () => {
  const bodies = [
    '{"error":{"message":"tool_call_id is required for role tool"}}',
    '{"error":{"message":"messages[2]: must be an object"}}',
    '{"type":"invalid_request_error","message":"bad input"}',
  ]
  for (const body of bodies) {
    expect(classifyCommandCodeError(500, body).code).toBe('INVALID_REQUEST')
    expect(classifyCommandCodeError(0, body).code).toBe('INVALID_REQUEST')
  }
})

it('keeps plain 5xx and auth/rate statuses out of the request-shape match', () => {
  // Transient gateway bodies keep retrying.
  expect(classifyCommandCodeError(500, '{"message":"internal error"}')).toMatchObject({ code: 'SERVER', message: 'internal error' })
  expect(classifyCommandCodeError(502, 'Bad Gateway').code).toBe('SERVER')
  expect(classifyCommandCodeError(503, '{"message":"upstream timeout"}').code).toBe('SERVER')
  // The JSON key `message` + an "Invalid ..." value is not message-array
  // validation: gateways phrase transient faults this way.
  expect(classifyCommandCodeError(502, '{"message":"Invalid upstream response from provider"}').code).toBe('SERVER')
  expect(classifyCommandCodeError(500, '{"error":{"message":"invalid gateway state"}}').code).toBe('SERVER')
  // A 401 with the OpenAI client-error type is still a credential failure.
  expect(classifyCommandCodeError(401, '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}').code).toBe('AUTH')
  // A rate-limit status stays rotating regardless of wording.
  expect(classifyCommandCodeError(429, '{"error":{"message":"invalid_request_error: slow down"}}').code).toBe('RATE_LIMIT')
})

it('extracts messages from {error:{message}}, {error:string} and plain text', () => {
  expect(errorMessageFromBody('{"error":{"message":"a"}}')).toBe('a')
  expect(errorMessageFromBody('{"error":"b"}')).toBe('b')
  expect(errorMessageFromBody('{"message":"c"}')).toBe('c')
  expect(errorMessageFromBody('plain text')).toBe('plain text')
  expect(errorMessageFromBody('<html>')).toBe('<html>')
})
