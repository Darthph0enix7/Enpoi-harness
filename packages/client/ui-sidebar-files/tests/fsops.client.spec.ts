// @vitest-environment jsdom
/**
 * The local fsops client over a fake transport.
 *
 * Each route is asserted on its exact URL and JSON payload, the fenced failure
 * envelope maps to its code/message/status, transport faults become `network`,
 * and the download save path decodes base64 into a Blob behind an object URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFsOps, failureMessage, FsOpsError, saveDownload } from '../src/client/fsops.ts'

/** One recorded request. */
interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A fetch answering one envelope and recording every call. */
function recorder(body: unknown, status = 200): { readonly request: typeof fetch; readonly calls: Recorded[] } {
  const calls: Recorded[] = []
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response
  }) as typeof fetch
  return { request, calls }
}

/** The JSON payload of one recorded call. */
function payloadOf(call: Recorded): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>
}

afterEach(() => { vi.restoreAllMocks() })

describe('createFsOps', () => {
  it('posts fs.create with the exact fenced payload', async () => {
    const { request, calls } = recorder({ ok: true, value: { path: '/w/a.txt' } })
    await createFsOps(request).create('s-1', '/w', 'a.txt')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/sidebar/fsops/fs.create')
    expect(calls[0]!.init?.method).toBe('POST')
    expect((calls[0]!.init?.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(payloadOf(calls[0]!)).toEqual({ sessionId: 's-1', parent: '/w', name: 'a.txt' })
  })

  it('posts fs.mkdir with the exact fenced payload', async () => {
    const { request, calls } = recorder({ ok: true, value: {} })
    await createFsOps(request).mkdir('s-1', '/w/src', 'lib')
    expect(calls[0]!.url).toBe('/sidebar/fsops/fs.mkdir')
    expect(payloadOf(calls[0]!)).toEqual({ sessionId: 's-1', parent: '/w/src', name: 'lib' })
  })

  it('posts fs.rename with from/to', async () => {
    const { request, calls } = recorder({ ok: true, value: {} })
    await createFsOps(request).rename('s-1', '/w/a.txt', '/w/b.txt')
    expect(calls[0]!.url).toBe('/sidebar/fsops/fs.rename')
    expect(payloadOf(calls[0]!)).toEqual({ sessionId: 's-1', from: '/w/a.txt', to: '/w/b.txt' })
  })

  it('posts fs.delete with the absolute path', async () => {
    const { request, calls } = recorder({ ok: true, value: {} })
    await createFsOps(request).delete('s-1', '/w/a.txt')
    expect(calls[0]!.url).toBe('/sidebar/fsops/fs.delete')
    expect(payloadOf(calls[0]!)).toEqual({ sessionId: 's-1', path: '/w/a.txt' })
  })

  it('posts fs.download and returns the base64 payload', async () => {
    const value = { base64: 'aGVsbG8=', size: 5, name: 'a.txt' }
    const { request, calls } = recorder({ ok: true, value })
    await expect(createFsOps(request).download('s-1', '/w/a.txt')).resolves.toEqual(value)
    expect(calls[0]!.url).toBe('/sidebar/fsops/fs.download')
    expect(payloadOf(calls[0]!)).toEqual({ sessionId: 's-1', path: '/w/a.txt' })
  })

  it('maps a fenced failure to its code, message, and status', async () => {
    const { request } = recorder({ ok: false, error: { code: 'exists', message: 'already there' } }, 409)
    const failure = await createFsOps(request).create('s-1', '/w', 'a.txt').then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(FsOpsError)
    expect(failure).toMatchObject({ code: 'exists', message: 'already there', status: 409 })
  })

  it('maps a transport rejection to a network failure', async () => {
    const request = (async () => { throw new Error('offline') }) as typeof fetch
    const failure = await createFsOps(request).delete('s', '/w/a').then(() => null, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'network', message: 'offline', status: 0 })
  })

  it('carries a non-Error rejection through failureMessage', async () => {
    const request = (async () => { throw 'offline' }) as typeof fetch
    const failure = await createFsOps(request).delete('s', '/w/a').then(() => null, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'network', message: 'offline', status: 0 })
    expect(failureMessage('offline')).toBe('offline')
  })

  it('falls back to the HTTP status when the answer is not an envelope', async () => {
    const request = (async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json') },
    })) as unknown as typeof fetch
    const failure = await createFsOps(request).delete('s', '/w/a').then(() => null, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'http', message: 'HTTP 502', status: 502 })
  })

  it('rejects a download answer without a value', async () => {
    const { request } = recorder({ ok: true })
    await expect(createFsOps(request).download('s', '/w/a')).rejects.toMatchObject({ code: 'malformed' })
  })
})

describe('saveDownload', () => {
  it('decodes the base64 into a blob and saves it through an object URL anchor', () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:test')
    const revokeObjectURL = vi.fn((_url: string) => {})
    const url = URL as unknown as {
      createObjectURL: (blob: Blob) => string
      revokeObjectURL: (url: string) => void
    }
    const original = { createObjectURL: url.createObjectURL, revokeObjectURL: url.revokeObjectURL }
    url.createObjectURL = createObjectURL
    url.revokeObjectURL = revokeObjectURL
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    try {
      saveDownload({ base64: 'aGVsbG8=', size: 5, name: 'note.txt' })
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      const blob = createObjectURL.mock.calls[0]![0]
      expect(blob.size).toBe(5)
      expect(downloads).toEqual(['note.txt'])
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:test')
    } finally {
      url.createObjectURL = original.createObjectURL
      url.revokeObjectURL = original.revokeObjectURL
    }
  })
})
