/**
 * CLIProxyAPI release helper: platform mapping, exact-asset checksum lookup,
 * complete tar validation, abort cleanup, and atomic installation.
 *
 * Every archive is built in-process (ustar headers + zlib), and every request
 * is served by an injected fetch returning Response objects — no network.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- the release helper is plain Node ESM and ships no declarations.
import * as releaseHelper from '../scripts/cliproxyapi-release.mjs'

const {
  DASHBOARD_PANEL_MAX_BYTES,
  DEFAULT_RELEASES_API,
  downloadProxyRelease,
  platformAsset,
  ProxyReleaseError,
} = releaseHelper

const VERSION = '8.0.55'
const ASSET = `CLIProxyAPI_${VERSION}_linux_amd64.tar.gz`
const API = 'https://api.test/releases/latest'
const CHECKSUMS = `https://cdn.test/${VERSION}/checksums.txt`
const ARCHIVE = `https://cdn.test/${VERSION}/${ASSET}`

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliproxy-release-'))
  scratch.push(dir)
  return dir
}

interface TarEntry {
  name: string
  data?: string | Buffer
  type?: string
  linkname?: string
}

function octal(buffer: Buffer, offset: number, length: number, value: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'latin1')
}

function tarHeader(entry: TarEntry): Buffer {
  const data = Buffer.from(entry.data ?? '')
  const header = Buffer.alloc(512)
  header.write(entry.name, 0, 100, 'utf8')
  octal(header, 100, 8, entry.type === '5' ? 0o755 : 0o644)
  octal(header, 108, 8, 0)
  octal(header, 116, 8, 0)
  octal(header, 124, 12, data.byteLength)
  octal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header.write(entry.type ?? '0', 156, 1, 'latin1')
  header.write(entry.linkname ?? '', 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'latin1')
  header.write('00', 263, 2, 'latin1')
  header.write('root', 265, 32, 'utf8')
  header.write('root', 297, 32, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return header
}

function tarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    blocks.push(tarHeader(entry), data, Buffer.alloc((512 - (data.byteLength % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function releaseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: `v${VERSION}`,
    assets: [
      { name: ASSET, size: 4096, browser_download_url: ARCHIVE },
      { name: 'checksums.txt', size: 128, browser_download_url: CHECKSUMS },
    ],
    ...overrides,
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

type Route = () => Response | Promise<Response>

function fetchStub(routes: Record<string, Route>): { fetch: typeof globalThis.fetch; calls: string[]; inits: RequestInit[] } {
  const calls: string[] = []
  const inits: RequestInit[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    inits.push(init ?? {})
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`)
    return route()
  }) as typeof globalThis.fetch
  return { fetch, calls, inits }
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

function trackedStream(): { stream: ReadableStream<Uint8Array>; canceled: () => boolean } {
  let canceled = false
  const stream = new ReadableStream<Uint8Array>({ cancel() { canceled = true } })
  return { stream, canceled: () => canceled }
}

function validArchive(entries: TarEntry[] = [{ name: 'cli-proxy-api', data: 'the-binary' }]): Buffer {
  return tarGz([
    ...entries,
    { name: 'LICENSE', data: 'license text' },
    { name: 'README.md', data: 'readme' },
    { name: 'config.example.yaml', data: 'config: true' },
  ])
}

function archiveRoutes(archive: Buffer, checksums: string, release = releaseBody()): Record<string, Route> {
  return {
    [API]: () => json(release),
    [CHECKSUMS]: () => new Response(checksums),
    [ARCHIVE]: () => new Response(new Uint8Array(archive)),
  }
}

function installOptions(dir: string, routes: Record<string, Route>, signal?: AbortSignal) {
  return {
    destination: join(dir, 'cli-proxy-api'),
    version: VERSION,
    releasesApi: API,
    platform: 'linux',
    arch: 'x64',
    fetch: fetchStub(routes).fetch,
    signal,
  }
}

describe('platformAsset', () => {
  it('maps all four supported platform/arch pairs to upstream asset names', () => {
    expect(platformAsset('v8.0.55', 'linux', 'x64')).toBe('CLIProxyAPI_8.0.55_linux_amd64.tar.gz')
    expect(platformAsset('8.0.55', 'linux', 'arm64')).toBe('CLIProxyAPI_8.0.55_linux_aarch64.tar.gz')
    expect(platformAsset('v8.0.55', 'darwin', 'x64')).toBe('CLIProxyAPI_8.0.55_darwin_amd64.tar.gz')
    expect(platformAsset('8.0.55', 'darwin', 'arm64')).toBe('CLIProxyAPI_8.0.55_darwin_aarch64.tar.gz')
  })

  it('throws for an unsupported target before touching the filesystem', async () => {
    expect(() => platformAsset('8.0.55', 'win32', 'x64')).toThrow(ProxyReleaseError)
    expect(() => platformAsset('8.0.55', 'linux', 'ia32')).toThrow(ProxyReleaseError)
    const dir = scratchDir()
    const calls: string[] = []
    const fetch = (async (url: string) => {
      calls.push(url)
      return new Response('should not happen')
    }) as unknown as typeof globalThis.fetch
    await expect(downloadProxyRelease({
      destination: join(dir, 'cli-proxy-api'),
      platform: 'win32',
      arch: 'x64',
      fetch,
    })).rejects.toMatchObject({ code: 'PLATFORM_UNSUPPORTED' })
    await expect(downloadProxyRelease({
      destination: join(dir, 'cli-proxy-api'),
      platform: 'linux',
      arch: 'ia32',
      fetch,
    })).rejects.toMatchObject({ code: 'PLATFORM_UNSUPPORTED' })
    expect(calls).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('downloadProxyRelease', () => {
  it('installs only the verified root binary with mode 0700 and removes scratch', async () => {
    const dir = scratchDir()
    const archive = validArchive()
    const { fetch, calls } = fetchStub(archiveRoutes(archive, `${sha256(archive)}  ${ASSET}\n`))

    const result = await downloadProxyRelease({
      destination: join(dir, 'cli-proxy-api'),
      version: VERSION,
      releasesApi: API,
      platform: 'linux',
      arch: 'x64',
      fetch,
    })

    expect(result).toEqual({
      destination: join(dir, 'cli-proxy-api'),
      version: VERSION,
      assetName: ASSET,
      checksum: sha256(archive),
      bytes: Buffer.byteLength('the-binary'),
      dashboardPanel: 'embedded-or-absent',
    })
    expect(calls).toEqual([API, CHECKSUMS, ARCHIVE])
    expect(readFileSync(join(dir, 'cli-proxy-api'), 'utf8')).toBe('the-binary')
    expect(statSync(join(dir, 'cli-proxy-api')).mode & 0o777).toBe(0o700)
    expect(readdirSync(dir)).toEqual(['cli-proxy-api'])
  })

  it('installs only the allowlisted dashboard panel at static/management.html with mode 0644', async () => {
    const dir = scratchDir()
    const archive = tarGz([
      { name: 'cli-proxy-api', data: 'the-binary' },
      { name: 'static/management.html', data: '<html>panel</html>' },
      { name: 'static/other.js', data: 'alert(1)' },
    ])
    const { fetch } = fetchStub(archiveRoutes(archive, `${sha256(archive)}  ${ASSET}\n`))

    const result = await downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })

    expect(result.dashboardPanel).toBe('installed')
    expect(readFileSync(join(dir, 'cli-proxy-api'), 'utf8')).toBe('the-binary')
    expect(readFileSync(join(dir, 'static', 'management.html'), 'utf8')).toBe('<html>panel</html>')
    expect(statSync(join(dir, 'static', 'management.html')).mode & 0o777).toBe(0o644)
    expect(readdirSync(dir).sort()).toEqual(['cli-proxy-api', 'static'])
    expect(readdirSync(join(dir, 'static'))).toEqual(['management.html'])
  })

  it('rejects an oversized dashboard panel before publishing anything', async () => {
    const dir = scratchDir()
    const destination = join(dir, 'cli-proxy-api')
    writeFileSync(destination, 'old-binary')
    const archive = tarGz([
      { name: 'cli-proxy-api', data: 'the-binary' },
      { name: 'static/management.html', data: Buffer.alloc(DASHBOARD_PANEL_MAX_BYTES + 1) },
    ])
    const { fetch } = fetchStub(archiveRoutes(archive, `${sha256(archive)}  ${ASSET}\n`))

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code: 'BOUNDS_EXCEEDED' })

    expect(readFileSync(destination, 'utf8')).toBe('old-binary')
    expect(readdirSync(dir)).toEqual(['cli-proxy-api'])
  })

  it.each([
    ['directory', { name: 'static/management.html', type: '5' }],
    ['symlink', { name: 'static/management.html', type: '2', linkname: '/etc/passwd' }],
  ])('rejects a dashboard panel entry that is a %s', async (_label, entry) => {
    const dir = scratchDir()
    const archive = tarGz([{ name: 'cli-proxy-api', data: 'the-binary' }, entry as TarEntry])
    const { fetch } = fetchStub(archiveRoutes(archive, `${sha256(archive)}  ${ASSET}\n`))

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code: 'ENTRY_REJECTED' })

    expect(readdirSync(dir)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked static directory instead of writing through it', async () => {
    const dir = scratchDir()
    const outside = scratchDir()
    writeFileSync(join(dir, 'cli-proxy-api'), 'old-binary')
    symlinkSync(outside, join(dir, 'static'))
    const archive = tarGz([
      { name: 'cli-proxy-api', data: 'the-binary' },
      { name: 'static/management.html', data: '<html>panel</html>' },
    ])
    const { fetch } = fetchStub(archiveRoutes(archive, `${sha256(archive)}  ${ASSET}\n`))

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })

    expect(readdirSync(outside)).toEqual([])
    expect(readFileSync(join(dir, 'cli-proxy-api'), 'utf8')).toBe('old-binary')
  })

  it('rejects duplicate dashboard panel entries', async () => {
    const dir = scratchDir()
    const archive = tarGz([
      { name: 'cli-proxy-api', data: 'the-binary' },
      { name: 'static/management.html', data: 'first' },
      { name: 'static/management.html', data: 'second' },
    ])
    const { fetch } = fetchStub(archiveRoutes(archive, `${sha256(archive)}  ${ASSET}\n`))

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })

    expect(readdirSync(dir)).toEqual([])
  })

  it('defaults to the upstream releases API and honours a fork repository override', async () => {
    const upstreamDir = scratchDir()
    const upstreamArchive = validArchive()
    const upstream = fetchStub({
      ...archiveRoutes(upstreamArchive, `${sha256(upstreamArchive)}  ${ASSET}\n`),
      [DEFAULT_RELEASES_API]: () => json(releaseBody()),
    })
    const upstreamResult = await downloadProxyRelease({
      destination: join(upstreamDir, 'cli-proxy-api'),
      platform: 'linux',
      arch: 'x64',
      fetch: upstream.fetch,
    })
    expect(upstreamResult.version).toBe(VERSION)
    expect(upstream.calls[0]).toBe(DEFAULT_RELEASES_API)

    const forkDir = scratchDir()
    const forkArchive = validArchive()
    const forkApi = 'https://api.github.com/repos/acme/fork/releases/latest'
    const fork = fetchStub({
      ...archiveRoutes(forkArchive, `${sha256(forkArchive)}  ${ASSET}\n`),
      [forkApi]: () => json(releaseBody()),
    })
    await downloadProxyRelease({
      destination: join(forkDir, 'cli-proxy-api'),
      repo: 'acme/fork',
      platform: 'linux',
      arch: 'x64',
      fetch: fork.fetch,
    })
    expect(fork.calls[0]).toBe(forkApi)

    const taggedDir = scratchDir()
    const taggedArchive = validArchive()
    const tagApi = `https://api.github.com/repos/acme/fork/releases/tags/v${VERSION}`
    const tagged = fetchStub({
      ...archiveRoutes(taggedArchive, `${sha256(taggedArchive)}  ${ASSET}\n`),
      [tagApi]: () => json(releaseBody()),
    })
    await downloadProxyRelease({
      destination: join(taggedDir, 'cli-proxy-api'),
      repo: 'acme/fork',
      version: VERSION,
      platform: 'linux',
      arch: 'x64',
      fetch: tagged.fetch,
    })
    expect(tagged.calls[0]).toBe(tagApi)
  })

  it('rejects an invalid fork repository before any filesystem or network access', async () => {
    const dir = scratchDir()
    const { fetch, calls } = fetchStub({})

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      repo: '../escape',
      fetch,
    })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })

    expect(calls).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('uses the release tag when no version is requested', async () => {
    const dir = scratchDir()
    const archive = validArchive()
    const { fetch } = fetchStub(archiveRoutes(archive, `${sha256(archive)}  ${ASSET}\n`))
    const result = await downloadProxyRelease({
      destination: join(dir, 'cli-proxy-api'),
      releasesApi: API,
      platform: 'linux',
      arch: 'x64',
      fetch,
    })
    expect(result.version).toBe(VERSION)
    expect(readFileSync(join(dir, 'cli-proxy-api'), 'utf8')).toBe('the-binary')
  })

  it('rejects a checksum mismatch and preserves the prior executable', async () => {
    const dir = scratchDir()
    const destination = join(dir, 'cli-proxy-api')
    const archive = validArchive()
    writeFileSync(destination, 'old-binary', { mode: 0o755 })
    const { fetch } = fetchStub(archiveRoutes(archive, `${sha256(Buffer.from('other'))}  ${ASSET}\n`))

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' })

    expect(readFileSync(destination, 'utf8')).toBe('old-binary')
    expect(readdirSync(dir)).toEqual(['cli-proxy-api'])
  })

  it('looks up the exact filename and never falls back to a sibling checksum', async () => {
    const dir = scratchDir()
    const destination = join(dir, 'cli-proxy-api')
    writeFileSync(destination, 'old-binary')
    const archive = validArchive()
    const sibling = 'CLIProxyAPI_8.0.55_linux_aarch64.tar.gz'
    const { fetch } = fetchStub(archiveRoutes(archive, `${sha256(archive)}  ${sibling}\n`))

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code: 'CHECKSUM_NOT_FOUND' })

    expect(readFileSync(destination, 'utf8')).toBe('old-binary')
  })

  it.each([
    ['traversal', { name: '../escaped', data: 'evil' }, 'PATH_REJECTED'],
    ['absolute path', { name: '/tmp/escaped', data: 'evil' }, 'PATH_REJECTED'],
    ['symlink', { name: 'link', type: '2', linkname: '/etc/passwd' }, 'ENTRY_REJECTED'],
    ['hardlink', { name: 'link', type: '1', linkname: 'cli-proxy-api' }, 'ENTRY_REJECTED'],
  ])('rejects a malicious %s entry and preserves the prior executable', async (_label, entry, code) => {
    const dir = scratchDir()
    const destination = join(dir, 'cli-proxy-api')
    writeFileSync(destination, 'old-binary')
    const archive = tarGz([{ name: 'cli-proxy-api', data: 'the-binary' }, entry as TarEntry])
    const { fetch } = fetchStub(archiveRoutes(archive, `${sha256(archive)}  ${ASSET}\n`))

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code })

    expect(readFileSync(destination, 'utf8')).toBe('old-binary')
    expect(readdirSync(dir)).toEqual(['cli-proxy-api'])
  })

  it('rejects a corrupt gzip stream after the checksum passes', async () => {
    const dir = scratchDir()
    const destination = join(dir, 'cli-proxy-api')
    writeFileSync(destination, 'old-binary')
    const corrupt = Buffer.from('this is not a gzip stream')
    const { fetch } = fetchStub(archiveRoutes(corrupt, `${sha256(corrupt)}  ${ASSET}\n`))

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' })

    expect(readFileSync(destination, 'utf8')).toBe('old-binary')
    expect(readdirSync(dir)).toEqual(['cli-proxy-api'])
  })

  it('rejects an archive without a root cli-proxy-api binary', async () => {
    const dir = scratchDir()
    const destination = join(dir, 'cli-proxy-api')
    writeFileSync(destination, 'old-binary')
    const archive = tarGz([{ name: 'README.md', data: 'no binary here' }])
    const { fetch } = fetchStub(archiveRoutes(archive, `${sha256(archive)}  ${ASSET}\n`))

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code: 'MISSING_BINARY' })

    expect(readFileSync(destination, 'utf8')).toBe('old-binary')
  })

  it('aborts cleanly, removes scratch, and preserves the prior executable', async () => {
    const dir = scratchDir()
    const destination = join(dir, 'cli-proxy-api')
    writeFileSync(destination, 'old-binary')
    const controller = new AbortController()
    const calls: string[] = []
    const fetch = (async (url: string) => {
      calls.push(url)
      if (url === API) return json(releaseBody())
      controller.abort()
      return new Response(`${sha256(Buffer.from('archive'))}  ${ASSET}\n`)
    }) as unknown as typeof globalThis.fetch

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}, controller.signal),
      fetch,
    })).rejects.toMatchObject({ code: 'ABORTED' })

    expect(calls).toEqual([API, CHECKSUMS])
    expect(readFileSync(destination, 'utf8')).toBe('old-binary')
    expect(readdirSync(dir)).toEqual(['cli-proxy-api'])
  })

  it('honours an already-aborted signal before any fetch', async () => {
    const dir = scratchDir()
    const destination = join(dir, 'cli-proxy-api')
    writeFileSync(destination, 'old-binary')
    const controller = new AbortController()
    controller.abort()
    const { fetch, calls } = fetchStub({})

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}, controller.signal),
      fetch,
    })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(calls).toEqual([])
    expect(readFileSync(destination, 'utf8')).toBe('old-binary')
  })

  it('rejects a release whose tag does not match the requested version', async () => {
    const dir = scratchDir()
    const archive = validArchive()
    const { fetch } = fetchStub(archiveRoutes(
      archive,
      `${sha256(archive)}  ${ASSET}\n`,
      releaseBody({ tag_name: 'v8.0.54' }),
    ))

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code: 'VERSION_MISMATCH' })
  })

  it('follows verified HTTPS redirects, cancels discarded bodies, and forwards no auth', async () => {
    const dir = scratchDir()
    const archive = validArchive()
    const apiRedirect = trackedStream()
    const release = releaseBody()
    ;(release.assets as Array<Record<string, unknown>>)[0]!.browser_download_url = 'https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.55/CLIProxyAPI_8.0.55_linux_amd64.tar.gz'
    const { fetch, calls, inits } = fetchStub({
      [API]: () => new Response(apiRedirect.stream, { status: 302, headers: { location: 'https://api-cdn.test/release.json' } }),
      'https://api-cdn.test/release.json': () => json(release),
      [CHECKSUMS]: () => new Response(`${sha256(archive)}  ${ASSET}\n`),
      'https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.55/CLIProxyAPI_8.0.55_linux_amd64.tar.gz': () => redirect('https://release-assets.githubusercontent.com/github-production-release-asset/123'),
      'https://release-assets.githubusercontent.com/github-production-release-asset/123': () => new Response(new Uint8Array(archive)),
    })

    const result = await downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })

    expect(result.version).toBe(VERSION)
    expect(readFileSync(join(dir, 'cli-proxy-api'), 'utf8')).toBe('the-binary')
    expect(apiRedirect.canceled()).toBe(true)
    expect(calls).toEqual([
      API,
      'https://api-cdn.test/release.json',
      CHECKSUMS,
      'https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.55/CLIProxyAPI_8.0.55_linux_amd64.tar.gz',
      'https://release-assets.githubusercontent.com/github-production-release-asset/123',
    ])
    for (const init of inits) {
      expect(init.credentials).toBe('omit')
      const headers = init.headers as Record<string, string>
      expect(Object.keys(headers).map(key => key.toLowerCase())).not.toContain('authorization')
    }
  })

  it('refuses an HTTPS downgrade to a non-loopback HTTP redirect before the second fetch', async () => {
    const dir = scratchDir()
    const destination = join(dir, 'cli-proxy-api')
    writeFileSync(destination, 'old-binary')
    const { fetch, calls } = fetchStub({ [API]: () => redirect('http://evil.test/payload') })

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
      allowInsecureHttp: true,
    })).rejects.toMatchObject({ code: 'INVALID_URL' })

    expect(calls).toEqual([API])
    expect(readFileSync(destination, 'utf8')).toBe('old-binary')
    expect(readdirSync(dir)).toEqual(['cli-proxy-api'])
  })

  it('rejects credentials in a redirect Location without echoing them', async () => {
    const dir = scratchDir()
    const { fetch, calls } = fetchStub({
      [API]: () => redirect('https://user:super-secret@cdn.test/payload?token=also-secret'),
    })

    let error: { code?: string; message?: string } | undefined
    try {
      await downloadProxyRelease({ ...installOptions(dir, {}), fetch })
    } catch (cause) {
      error = cause as { code?: string; message?: string }
    }

    expect(error?.code).toBe('INVALID_URL')
    expect(error?.message ?? '').not.toContain('super-secret')
    expect(error?.message ?? '').not.toContain('also-secret')
    expect(error?.message ?? '').not.toContain('user:')
    expect(calls).toEqual([API])
  })

  it('rejects a credential-bearing initial URL without echoing it', async () => {
    const dir = scratchDir()
    const { fetch, calls } = fetchStub({})

    let error: { code?: string; message?: string } | undefined
    try {
      await downloadProxyRelease({
        ...installOptions(dir, {}),
        releasesApi: 'https://user:super-secret@api.test/releases/latest?token=also-secret',
        fetch,
      })
    } catch (cause) {
      error = cause as { code?: string; message?: string }
    }

    expect(error?.code).toBe('INVALID_URL')
    expect(error?.message ?? '').not.toContain('super-secret')
    expect(error?.message ?? '').not.toContain('also-secret')
    expect(calls).toEqual([])
  })

  it('does not echo credentials from an unknown AbortError failure', async () => {
    const dir = scratchDir()
    const fetch = (async () => {
      const error = new Error('boom https://user:super-secret@cdn.test?token=also-secret')
      error.name = 'AbortError'
      throw error
    }) as unknown as typeof globalThis.fetch

    let error: { code?: string; message?: string } | undefined
    try {
      await downloadProxyRelease({ ...installOptions(dir, {}), fetch })
    } catch (cause) {
      error = cause as { code?: string; message?: string }
    }

    expect(error?.code).toBe('ABORTED')
    expect(error?.message ?? '').not.toContain('super-secret')
    expect(error?.message ?? '').not.toContain('also-secret')
  })

  it('bounds redirect chains instead of following forever', async () => {
    const dir = scratchDir()
    const { fetch, calls } = fetchStub({ [API]: () => redirect(API) })

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
      maxRedirects: 2,
    })).rejects.toMatchObject({ code: 'REDIRECT_LIMIT' })

    expect(calls).toEqual([API, API, API])
  })

  it('cancels a non-2xx response body before failing', async () => {
    const dir = scratchDir()
    const body = trackedStream()
    const { fetch } = fetchStub({
      [API]: () => json(releaseBody()),
      [CHECKSUMS]: () => new Response(body.stream, { status: 404 }),
    })

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
    })).rejects.toMatchObject({ code: 'HTTP_STATUS' })

    expect(body.canceled()).toBe(true)
  })

  it('cancels a declared-oversize response body before failing', async () => {
    const dir = scratchDir()
    const archive = validArchive()
    const body = trackedStream()
    const release = releaseBody()
    ;(release.assets as Array<Record<string, unknown>>)[0] = { name: ASSET, browser_download_url: ARCHIVE }
    const { fetch } = fetchStub({
      [API]: () => json(release),
      [CHECKSUMS]: () => new Response(`${sha256(archive)}  ${ASSET}\n`),
      [ARCHIVE]: () => new Response(body.stream, { headers: { 'content-length': '4096' } }),
    })

    await expect(downloadProxyRelease({
      ...installOptions(dir, {}),
      fetch,
      maxDownloadBytes: 16,
    })).rejects.toMatchObject({ code: 'BOUNDS_EXCEEDED' })

    expect(body.canceled()).toBe(true)
  })
})
