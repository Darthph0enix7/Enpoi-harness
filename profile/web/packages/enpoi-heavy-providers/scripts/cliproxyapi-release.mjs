/**
 * Verified CLIProxyAPI release downloader. Node-only: one release, one exact
 * asset, checksums.txt verification, full ustar validation, atomic install.
 * Never builds, writes service config, restarts, or installs other assets.
 */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export const DEFAULT_REPO = 'router-for-me/CLIProxyAPI'
export const DEFAULT_RELEASES_API = `https://api.github.com/repos/${DEFAULT_REPO}/releases/latest`
export const DASHBOARD_PANEL_PATH = 'static/management.html'
export const DASHBOARD_PANEL_MAX_BYTES = 16 * 1024 * 1024
const RELEASES_API_ROOT = 'https://api.github.com/repos'
const PLATFORM_OS = { linux: 'linux', darwin: 'darwin' }
const PLATFORM_ARCH = { x64: 'amd64', arm64: 'aarch64' }
const TAR_BLOCK = 512
const MIB = 1024 * 1024
const DEFAULT_LIMITS = { timeoutMs: 120_000, maxMetadataBytes: 2 * MIB, maxDownloadBytes: 256 * MIB, maxExtractBytes: 512 * MIB, maxBinaryBytes: 256 * MIB, maxDashboardPanelBytes: DASHBOARD_PANEL_MAX_BYTES }

export class ProxyReleaseError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ProxyReleaseError'
    this.code = code
  }
}

function fail(code, message, options) {
  throw new ProxyReleaseError(code, message, options)
}

function normalizeRepo(value) {
  if (typeof value !== 'string') fail('INVALID_OPTIONS', 'repo must be an owner/name string')
  const repo = value.trim()
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u.test(repo)) {
    fail('INVALID_OPTIONS', `invalid release repository: ${JSON.stringify(value)}`)
  }
  return repo
}

function normalizeVersion(value) {
  if (typeof value !== 'string') fail('INVALID_OPTIONS', 'version must be a string')
  const version = value.trim().replace(/^v/iu, '')
  if (!/^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    fail('INVALID_OPTIONS', `invalid CLIProxyAPI version: ${JSON.stringify(value)}`)
  }
  return version
}

/** Map Node platform/arch to the exact upstream asset name. */
export function platformAsset(version, platform, arch) {
  const os = PLATFORM_OS[platform]
  const cpu = PLATFORM_ARCH[arch]
  if (os === undefined || cpu === undefined) {
    fail('PLATFORM_UNSUPPORTED', `CLIProxyAPI releases do not support ${platform}/${arch}`)
  }
  return `CLIProxyAPI_${normalizeVersion(version)}_${os}_${cpu}.tar.gz`
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function safeUrlForMessage(raw) {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return '<malformed URL>'
  }
}

function safeCause(error) {
  const cause = { name: typeof error?.name === 'string' ? error.name : 'Error' }
  if (typeof error?.code === 'string') cause.code = error.code
  return cause
}

function checkedUrl(raw, allowInsecureHttp) {
  let url
  try {
    url = new URL(raw)
  } catch (cause) {
    fail('INVALID_URL', `invalid release URL: ${safeUrlForMessage(raw)}`, { cause: safeCause(cause) })
  }
  if (url.username !== '' || url.password !== '') fail('INVALID_URL', 'release URLs must not carry credentials')
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && (allowInsecureHttp || isLoopbackHost(url.hostname))) return url
  fail('INVALID_URL', `release URL must use HTTPS (or localhost HTTP): ${safeUrlForMessage(raw)}`)
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('release download aborted')
    error.name = 'AbortError'
    throw error
  }
}

function byteLengthHeader(response) {
  const raw = response.headers?.get?.('content-length')
  if (raw === null || raw === undefined || raw === '') return undefined
  const length = Number(raw)
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined
}

async function cancelDiscardedBody(response) {
  try {
    await response?.body?.cancel?.()
  } catch {
    // The response is already being discarded; never mask the real failure.
  }
}

async function responseBytes(response, maxBytes, signal) {
  if (!response || typeof response.ok !== 'boolean') {
    await cancelDiscardedBody(response)
    fail('HTTP_STATUS', 'fetch returned an invalid response')
  }
  if (!response.ok) {
    await cancelDiscardedBody(response)
    fail('HTTP_STATUS', `release request failed with HTTP ${response.status}`)
  }
  const declared = byteLengthHeader(response)
  if (declared !== undefined && declared > maxBytes) {
    await cancelDiscardedBody(response)
    fail('BOUNDS_EXCEEDED', `release response declares ${declared} bytes (limit ${maxBytes})`)
  }
  assertNotAborted(signal)
  if (response.body?.getReader !== undefined) {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        assertNotAborted(signal)
        if (done) break
        total += value.byteLength
        if (total > maxBytes) fail('BOUNDS_EXCEEDED', `release response exceeded ${maxBytes} bytes`)
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock?.()
    }
    return Buffer.concat(chunks, total)
  }
  const body = Buffer.from(await response.arrayBuffer())
  if (body.byteLength > maxBytes) fail('BOUNDS_EXCEEDED', `release response exceeded ${maxBytes} bytes`)
  return body
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

async function requestBytes(url, options) {
  const { fetchImpl, signal, maxBytes, accept, userAgent, allowInsecureHttp = false, maxRedirects = 5 } = options
  let current = checkedUrl(url.href ?? String(url), allowInsecureHttp)
  let redirects = 0
  for (;;) {
    assertNotAborted(signal)
    let response
    try {
      // No credentials, cookies, or caller headers are forwarded across hops.
      const headers = { accept, 'user-agent': userAgent, 'x-github-api-version': '2022-11-28' }
      response = await fetchImpl(current.href, { signal, redirect: 'manual', credentials: 'omit', headers })
    } catch (cause) {
      if (signal?.aborted || cause?.name === 'AbortError') throw cause
      const code = typeof cause?.code === 'string' ? ` (${cause.code})` : ''
      fail('HTTP_STATUS', `release request failed${code}`, { cause: safeCause(cause) })
    }
    if (!REDIRECT_STATUSES.has(response?.status)) return responseBytes(response, maxBytes, signal)

    await cancelDiscardedBody(response)
    const location = response.headers?.get?.('location')
    if (typeof location !== 'string' || location.trim() === '') {
      fail('INVALID_REDIRECT', 'release redirect has no Location header')
    }
    if (redirects >= maxRedirects) fail('REDIRECT_LIMIT', `release request exceeded ${maxRedirects} redirects`)
    let next
    try {
      next = new URL(location, current)
    } catch (cause) {
      fail('INVALID_REDIRECT', 'release redirect has an invalid Location header', { cause: safeCause(cause) })
    }
    const checkedNext = checkedUrl(next.href, allowInsecureHttp)
    if (current.protocol === 'https:' && checkedNext.protocol === 'http:' && !isLoopbackHost(checkedNext.hostname)) {
      fail('INVALID_URL', `release redirect refuses an HTTPS downgrade to ${safeUrlForMessage(checkedNext)}`)
    }
    redirects++
    current = checkedNext
  }
}

function parseRelease(body) {
  let release
  try {
    release = JSON.parse(body.toString('utf8'))
  } catch (cause) {
    fail('INVALID_RELEASE', 'release API did not return JSON', { cause: safeCause(cause) })
  }
  if (release === null || typeof release !== 'object' || Array.isArray(release)) {
    fail('INVALID_RELEASE', 'release API returned a non-object')
  }
  return release
}

function oneAsset(release, name, code) {
  const assets = Array.isArray(release.assets) ? release.assets : []
  const matches = assets.filter(asset => asset !== null && typeof asset === 'object' && asset.name === name)
  if (matches.length === 0) fail(code, `release ${release.tag_name ?? ''} has no ${name} asset`)
  if (matches.length > 1) fail('INVALID_RELEASE', `release has duplicate ${name} assets`)
  return matches[0]
}

function expectedChecksum(text, assetName) {
  let expected
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/u.exec(line)
    if (match === null || match[2] !== assetName) continue
    if (expected !== undefined) fail('INVALID_RELEASE', `checksums.txt lists ${assetName} more than once`)
    expected = match[1].toLowerCase()
  }
  if (expected === undefined) fail('CHECKSUM_NOT_FOUND', `checksums.txt has no entry for ${assetName}`)
  return expected
}

function parseOctal(header, start, length) {
  const raw = header.subarray(start, start + length).toString('latin1').replace(/\0.*$/su, '').trim()
  if (raw === '') return 0
  if (!/^[0-7]+$/u.test(raw)) fail('INVALID_ARCHIVE', 'tar header has a non-octal size/checksum field')
  return Number.parseInt(raw, 8)
}

function tarPath(header) {
  const read = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '')
  const name = read(0, 100)
  const prefix = read(345, 155)
  let path = prefix === '' ? name : `${prefix}/${name}`
  while (path.startsWith('./')) path = path.slice(2)
  if (path === '' || path === '.') fail('PATH_REJECTED', 'tar entry has an empty path')
  if (path.includes('\0') || path.includes('\\')) fail('PATH_REJECTED', `tar entry path is not portable: ${JSON.stringify(path)}`)
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) fail('PATH_REJECTED', `tar entry is absolute: ${JSON.stringify(path)}`)
  if (path.split('/').some(part => part === '..')) fail('PATH_REJECTED', `tar entry traverses upward: ${JSON.stringify(path)}`)
  return path
}

function verifyTarChecksum(header) {
  const stored = parseOctal(header, 148, 8)
  let sum = 0
  for (let index = 0; index < TAR_BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  if (sum !== stored) fail('INVALID_ARCHIVE', 'tar header checksum mismatch')
}

/** Walk the complete tar; copy only the safe root binary and allowlisted dashboard panel. */
function extractRelease(archiveGzip, limits) {
  let tar
  try {
    tar = gunzipSync(archiveGzip, { maxOutputLength: limits.maxExtractBytes })
  } catch (cause) {
    if (cause?.code === 'ERR_BUFFER_TOO_LARGE') fail('BOUNDS_EXCEEDED', `archive expands beyond ${limits.maxExtractBytes} bytes`, { cause })
    fail('INVALID_ARCHIVE', 'release asset is not a valid gzip stream', { cause })
  }
  if (tar.byteLength === 0) fail('INVALID_ARCHIVE', 'release archive is empty')

  let offset = 0
  let total = 0
  let binary
  let binarySize = 0
  let dashboardPanel
  for (;;) {
    if (offset + TAR_BLOCK > tar.byteLength) fail('INVALID_ARCHIVE', 'tar archive is missing its end blocks')
    const header = tar.subarray(offset, offset + TAR_BLOCK)
    if (header.every(byte => byte === 0)) {
      for (let index = offset; index < tar.byteLength; index++) {
        if (tar[index] !== 0) fail('INVALID_ARCHIVE', 'tar archive has data after its end blocks')
      }
      break
    }
    verifyTarChecksum(header)
    if (header.subarray(257, 262).toString('latin1') !== 'ustar') {
      fail('INVALID_ARCHIVE', 'tar entry is not in ustar format')
    }
    const path = tarPath(header)
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    const size = parseOctal(header, 124, 12)
    if (path === DASHBOARD_PANEL_PATH && type !== '0') {
      fail('ENTRY_REJECTED', `${DASHBOARD_PANEL_PATH} has unsupported type ${JSON.stringify(type)}`)
    }
    if (size > limits.maxExtractBytes || total + size > limits.maxExtractBytes) {
      fail('BOUNDS_EXCEEDED', `archive entry ${path} exceeds the extraction limit`)
    }
    total += size
    const dataStart = offset + TAR_BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > tar.byteLength) fail('INVALID_ARCHIVE', `truncated data for ${path}`)

    if (type === '5') {
      if (size !== 0) fail('INVALID_ARCHIVE', `directory entry ${path} carries data`)
    } else if (type === '0') {
      if (path === 'cli-proxy-api') {
        if (binary !== undefined) fail('INVALID_ARCHIVE', 'archive contains more than one cli-proxy-api entry')
        if (size === 0) fail('MISSING_BINARY', 'cli-proxy-api is empty')
        if (size > limits.maxBinaryBytes) fail('BOUNDS_EXCEEDED', `cli-proxy-api exceeds ${limits.maxBinaryBytes} bytes`)
        binary = Buffer.from(tar.subarray(dataStart, dataEnd))
        binarySize = size
      } else if (path === DASHBOARD_PANEL_PATH) {
        if (dashboardPanel !== undefined) fail('INVALID_ARCHIVE', `archive contains more than one ${DASHBOARD_PANEL_PATH} entry`)
        if (size === 0) fail('INVALID_ARCHIVE', `${DASHBOARD_PANEL_PATH} is empty`)
        if (size > limits.maxDashboardPanelBytes) {
          fail('BOUNDS_EXCEEDED', `${DASHBOARD_PANEL_PATH} exceeds ${limits.maxDashboardPanelBytes} bytes`)
        }
        dashboardPanel = Buffer.from(tar.subarray(dataStart, dataEnd))
      }
    } else {
      fail('ENTRY_REJECTED', `archive entry ${path} has unsupported type ${JSON.stringify(type)}`)
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  if (binary === undefined) fail('MISSING_BINARY', 'archive has no root cli-proxy-api regular file')
  return { binary, binarySize, dashboardPanel }
}

async function pathExists(path) {
  try {
    return await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function lstatMaybe(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function syncFile(path) {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function rethrow(error, { userSignal, deadline, destination }) {
  if (error instanceof ProxyReleaseError) throw error
  if (deadline.aborted && !(userSignal?.aborted === true)) {
    throw new ProxyReleaseError('TIMEOUT', 'release download timed out')
  }
  if (userSignal?.aborted === true || error?.name === 'AbortError') {
    throw new ProxyReleaseError('ABORTED', 'release download aborted')
  }
  if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
    throw new ProxyReleaseError('BOUNDS_EXCEEDED', 'release archive exceeded its byte limit', { cause: safeCause(error) })
  }
  const code = typeof error?.code === 'string' ? ` (${error.code})` : ''
  throw new ProxyReleaseError('IO', `release install failed for ${destination}${code}`)
}

async function publishRelease({ tempBinary, target, tempPanel, panelTarget }) {
  if (tempPanel === undefined) {
    await rename(tempBinary, target)
    return
  }
  const panelDir = dirname(panelTarget)
  const existingDir = await lstatMaybe(panelDir)
  let panelDirCreated = false
  if (existingDir === undefined) {
    await mkdir(panelDir, { recursive: true, mode: 0o755 })
    panelDirCreated = true
  } else if (existingDir.isSymbolicLink() || !existingDir.isDirectory()) {
    fail('INVALID_OPTIONS', `dashboard panel parent is not a real directory: ${panelDir}`)
  }
  const existingPanel = await lstatMaybe(panelTarget)
  if (existingPanel !== undefined && !existingPanel.isFile()) {
    fail('INVALID_OPTIONS', `dashboard panel target is not a regular file: ${panelTarget}`)
  }
  const priorPanel = existingPanel === undefined ? undefined : await readFile(panelTarget)
  let panelPublished = false
  try {
    await rename(tempPanel, panelTarget)
    panelPublished = true
    await chmod(panelTarget, 0o644)
    await rename(tempBinary, target)
  } catch (error) {
    if (panelPublished) {
      try {
        if (priorPanel === undefined) {
          await rm(panelTarget, { force: true })
        } else {
          await writeFile(panelTarget, priorPanel, { mode: 0o644 })
          await chmod(panelTarget, 0o644)
        }
      } catch {
        // Restore is best effort; the original publish failure must surface.
      }
    }
    if (panelDirCreated) await rm(panelDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** Download, verify, validate, and atomically install CLIProxyAPI. */
export async function downloadProxyRelease(options) {
  if (options === null || typeof options !== 'object') fail('INVALID_OPTIONS', 'downloadProxyRelease needs an options object')
  const { destination, version, releasesApi, repo, signal: userSignal, platform = process.platform, arch = process.arch,
    fetch: fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_LIMITS.timeoutMs,
    maxMetadataBytes = DEFAULT_LIMITS.maxMetadataBytes, maxDownloadBytes = DEFAULT_LIMITS.maxDownloadBytes,
    maxExtractBytes = DEFAULT_LIMITS.maxExtractBytes, maxBinaryBytes = DEFAULT_LIMITS.maxBinaryBytes,
    maxDashboardPanelBytes = DEFAULT_LIMITS.maxDashboardPanelBytes,
    requiredMajor, allowInsecureHttp = false, maxRedirects = 5,
    userAgent = 'dsh-enpoi-heavy-providers/cliproxyapi-release' } = options

  if (typeof destination !== 'string' || destination.trim() === '') fail('INVALID_OPTIONS', 'destination must be a non-empty path')
  if (typeof fetchImpl !== 'function') fail('INVALID_OPTIONS', 'fetch must be a function')
  for (const [name, value] of Object.entries({
    timeoutMs, maxMetadataBytes, maxDownloadBytes, maxExtractBytes, maxBinaryBytes, maxDashboardPanelBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_OPTIONS', `${name} must be a positive integer`)
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) fail('INVALID_OPTIONS', 'maxRedirects must be a non-negative integer')
  if (version !== undefined) normalizeVersion(version)
  if (requiredMajor !== undefined && requiredMajor !== null && (!Number.isInteger(requiredMajor) || requiredMajor < 0)) {
    fail('INVALID_OPTIONS', 'requiredMajor must be a non-negative integer or null')
  }
  // Platform/version/repository validation must happen before any filesystem access.
  platformAsset(version ?? '0.0.0', platform, arch)
  const releaseRepo = normalizeRepo(repo ?? DEFAULT_REPO)

  const limits = { maxMetadataBytes, maxDownloadBytes, maxExtractBytes, maxBinaryBytes, maxDashboardPanelBytes }
  const target = destination
  const parent = dirname(target)
  const parentInfo = await pathExists(parent)
  if (parentInfo === undefined || !parentInfo.isDirectory()) fail('INVALID_OPTIONS', `destination parent does not exist: ${parent}`)
  const existing = await pathExists(target)
  if (existing !== undefined && !existing.isFile()) fail('INVALID_OPTIONS', `destination is not a regular file: ${target}`)
  if (userSignal !== undefined && !(userSignal instanceof AbortSignal)) fail('INVALID_OPTIONS', 'signal must be an AbortSignal')
  if (userSignal?.aborted === true) fail('ABORTED', 'release download aborted before start')

  const deadline = AbortSignal.timeout(timeoutMs)
  const signal = userSignal === undefined ? deadline : AbortSignal.any([userSignal, deadline])
  // Scratch lives beside the destination, so rename is same-filesystem atomic.
  let scratch
  try {
    scratch = await mkdtemp(join(parent, '.cliproxyapi-scratch-'))
    await chmod(scratch, 0o700)
    const apiUrl = checkedUrl(
      releasesApi ?? (version === undefined
        ? `${RELEASES_API_ROOT}/${releaseRepo}/releases/latest`
        : `${RELEASES_API_ROOT}/${releaseRepo}/releases/tags/v${normalizeVersion(version)}`),
      allowInsecureHttp,
    )
    const release = parseRelease(await requestBytes(apiUrl, {
      fetchImpl, signal, maxBytes: maxMetadataBytes, accept: 'application/vnd.github+json', userAgent, allowInsecureHttp, maxRedirects,
    }))
    let releaseVersion
    if (typeof release.tag_name === 'string' && release.tag_name.trim() !== '') {
      releaseVersion = normalizeVersion(release.tag_name)
    } else if (version !== undefined) {
      releaseVersion = normalizeVersion(version)
    } else {
      fail('INVALID_RELEASE', 'release API has no tag_name')
    }
    if (version !== undefined && normalizeVersion(version) !== releaseVersion) {
      fail('VERSION_MISMATCH', `release API returned ${releaseVersion}, expected ${normalizeVersion(version)}`)
    }
    if (requiredMajor !== undefined && requiredMajor !== null && Number(releaseVersion.split('.')[0]) !== requiredMajor) {
      fail('VERSION_MISMATCH', `CLIProxyAPI ${releaseVersion} is outside the pinned v${requiredMajor} baseline`)
    }

    const assetName = platformAsset(releaseVersion, platform, arch)
    const archiveAsset = oneAsset(release, assetName, 'ASSET_MISSING')
    const checksumsAsset = oneAsset(release, 'checksums.txt', 'CHECKSUMS_MISSING')
    if (typeof checksumsAsset.browser_download_url !== 'string') fail('INVALID_RELEASE', 'checksums.txt has no browser_download_url')
    if (typeof archiveAsset.browser_download_url !== 'string') fail('INVALID_RELEASE', `${assetName} has no browser_download_url`)
    if (typeof archiveAsset.size === 'number' && archiveAsset.size > maxDownloadBytes) {
      fail('BOUNDS_EXCEEDED', `${assetName} declares ${archiveAsset.size} bytes (limit ${maxDownloadBytes})`)
    }
    const checksumsUrl = checkedUrl(checksumsAsset.browser_download_url, allowInsecureHttp)
    const archiveUrl = checkedUrl(archiveAsset.browser_download_url, allowInsecureHttp)

    const checksums = await requestBytes(checksumsUrl, {
      fetchImpl, signal, maxBytes: maxMetadataBytes, accept: 'text/plain', userAgent, allowInsecureHttp, maxRedirects,
    })
    const expected = expectedChecksum(checksums.toString('utf8'), assetName)

    const archive = await requestBytes(archiveUrl, {
      fetchImpl, signal, maxBytes: maxDownloadBytes, accept: 'application/octet-stream', userAgent, allowInsecureHttp, maxRedirects,
    })
    const checksum = createHash('sha256').update(archive).digest('hex')
    if (checksum !== expected) {
      fail('CHECKSUM_MISMATCH', `${assetName} SHA256 is ${checksum}, checksums.txt says ${expected}`)
    }
    const { binary, binarySize, dashboardPanel } = extractRelease(archive, limits)

    const tempBinary = join(scratch, 'cli-proxy-api')
    await writeFile(tempBinary, binary, { mode: 0o700, flag: 'wx' })
    await chmod(tempBinary, 0o700)
    await syncFile(tempBinary)
    let tempPanel
    if (dashboardPanel !== undefined) {
      tempPanel = join(scratch, 'management.html')
      await writeFile(tempPanel, dashboardPanel, { mode: 0o644, flag: 'wx' })
      await chmod(tempPanel, 0o644)
      await syncFile(tempPanel)
    }
    assertNotAborted(userSignal)
    if (deadline.aborted) {
      const error = new Error('release install deadline exceeded')
      error.name = 'AbortError'
      throw error
    }
    const panelTarget = join(dirname(target), ...DASHBOARD_PANEL_PATH.split('/'))
    await publishRelease({ tempBinary, target, tempPanel, panelTarget })
    return {
      destination: target,
      version: releaseVersion,
      assetName,
      checksum,
      bytes: binarySize,
      dashboardPanel: dashboardPanel === undefined ? 'embedded-or-absent' : 'installed',
    }
  } catch (error) {
    rethrow(error, { userSignal, deadline, destination: target })
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}
