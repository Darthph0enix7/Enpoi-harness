/**
 * The `updateCheck.*` client-request envelopes: every endpoint's exact
 * `payload.args` (the descriptors name their parameters `request`, so
 * `dismiss` must wrap the version), the rpcId shape, and the fail-soft
 * branches.
 */
import { describe, expect, it } from 'vitest'
import { updateCheckRpc } from '../src/client/rpc.ts'

interface Captured {
  readonly url: string
  readonly body: Record<string, unknown>
}

/** The request URL of one captured fetch call. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/** Fetch stub capturing each request body and answering a success envelope. */
function capture(value: unknown = null): { requests: Captured[]; fetchImpl: typeof fetch } {
  const requests: Captured[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const raw = typeof init?.body === 'string' ? init.body : ''
    const parsed: unknown = JSON.parse(raw)
    requests.push({ url: requestUrl(input), body: parsed as Record<string, unknown> })
    return new Response(JSON.stringify({ result: { ok: true, value } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { requests, fetchImpl }
}

describe('updateCheck envelope shapes', () => {
  it('sends no-argument methods with an empty args object', async () => {
    for (const method of ['updateCheck.status', 'updateCheck.checkNow', 'updateCheck.start', 'updateCheck.apply', 'updateCheck.run']) {
      const { requests, fetchImpl } = capture()
      await updateCheckRpc(method, {}, fetchImpl)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toBe(`/api/${method}`)
      const body = requests[0]!.body
      expect(body).toMatchObject({ type: 'client-request', method, payload: { args: {} } })
      expect(String(body.rpcId)).toMatch(new RegExp(`^${method.replace('.', '\\.')}-\\d+$`))
    }
  })

  it('wraps the dismiss version in the descriptor’s `request` parameter', async () => {
    const { requests, fetchImpl } = capture()
    await updateCheckRpc('updateCheck.dismiss', { request: { version: '0.1.7-enpoi.2.84' } }, fetchImpl)
    const body = requests[0]!.body
    expect(body).toMatchObject({
      type: 'client-request',
      method: 'updateCheck.dismiss',
      payload: { args: { request: { version: '0.1.7-enpoi.2.84' } } },
    })
    expect(String(body.rpcId)).toMatch(/^updateCheck\.dismiss-\d+$/)
    // The flat field shape the descriptor rejected in the live failure.
    expect(body).not.toMatchObject({ payload: { args: { version: '0.1.7-enpoi.2.84' } } })
  })

  it('unwraps the business value from a success envelope', async () => {
    const { fetchImpl } = capture({ state: 'available' })
    await expect(updateCheckRpc('updateCheck.status', {}, fetchImpl)).resolves
      .toEqual({ ok: true, value: { state: 'available' } })
  })

  it('is fail-soft on a non-2xx response, a rejected envelope, and a transport error', async () => {
    const failing: typeof fetch = async () => new Response('nope', { status: 502 })
    await expect(updateCheckRpc('updateCheck.status', {}, failing)).resolves
      .toEqual({ ok: false, message: 'gateway responded 502' })

    const rejected: typeof fetch = async () => new Response(JSON.stringify({
      result: { ok: false, error: { message: 'args fields do not match the descriptor' } },
    }), { status: 200 })
    await expect(updateCheckRpc('updateCheck.dismiss', { request: { version: 'x' } }, rejected)).resolves
      .toEqual({ ok: false, message: 'args fields do not match the descriptor' })

    const thrown: typeof fetch = async () => { throw new Error('offline') }
    await expect(updateCheckRpc('updateCheck.run', {}, thrown)).resolves
      .toEqual({ ok: false, message: 'offline' })
  })
})
