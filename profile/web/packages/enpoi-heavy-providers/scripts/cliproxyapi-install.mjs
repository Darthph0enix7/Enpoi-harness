#!/usr/bin/env node
/**
 * Receipt-owned CLIProxyAPI installer.
 *
 * One install owns exactly `<dshHome>/providers/cliproxyapi`: the binary,
 * seed config, auth directory, private bootstrap credentials, receipt, and
 * one uniquely named user service. It never adopts, overwrites, or removes a
 * foreign directory, unit, binary, or the existing `cliproxyapi.service` that
 * may own port 8317.
 *
 * Node built-ins only. The release downloader is injected in tests; the real
 * one is `./cliproxyapi-release.mjs`, loaded with a file stamp so a replaced
 * downloader is seen without reloading this module. Service commands are
 * injectable and are never executed by the test suite.
 */
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import {
  chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, rmdir, unlink,
} from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 8317
export const SERVICE_LABEL = 'dsh-cliproxyapi'
export const LAUNCHD_LABEL = 'dev.enpoi.cliproxyapi'
export const RECEIPT_VERSION = 1
export const DEFAULT_SERVICE_TIMEOUT_MS = 10_000
export const REQUIRED_CONFIG_MAJOR = 8
export const DASHBOARD_PANEL_MAX_BYTES = 16 * 1024 * 1024
/** A lock record without a provable owner is reclaimed only after this age. */
const INSTALL_LOCK_STALE_MS = 60_000

const SYSTEMD_KIND = 'systemd-user'
const LAUNCHD_KIND = 'launchd-agent'
const JOURNAL_NAME = '.install-journal.json'
const REMOVED_STATE_NAME = '.removed-state.json'
const SUPPORTED_ARCH = Object.freeze({ linux: ['x64', 'arm64'], darwin: ['x64', 'arm64'] })
const TOKEN_SUFFIX = '[a-f0-9]{24}'
const ROOT_TRANSIENT = new RegExp(
  `^(?:\\.install\\.lock(?:\\.stale-${TOKEN_SUFFIX})?|\\.(?:receipt\\.json|config\\.yaml|bootstrap\\.json|install-journal\\.json|removed-state\\.json)\\.tmp-${TOKEN_SUFFIX})$`,
  'u',
)
const BIN_TRANSIENT = new RegExp(`^\\.(?:cli-proxy-api\\.stage|rollback-binary)-${TOKEN_SUFFIX}$`, 'u')
const PANEL_TRANSIENT = new RegExp(`^\\.rollback-panel-${TOKEN_SUFFIX}$`, 'u')
const HEX64 = /^[a-f0-9]{64}$/u
/** One loaded release downloader and the on-disk stamp it came from. */
let releaseDownloader

/** Installer refusal or failure with a stable machine-readable code. */
export class CliProxyInstallError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'CliProxyInstallError'
    this.code = code
  }
}

function fail(code, message, options) {
  throw new CliProxyInstallError(code, message, options)
}

function nowMs(now) {
  if (typeof now === 'function') return now()
  if (typeof now === 'number' && Number.isFinite(now)) return now
  return Date.now()
}

function token() {
  return randomBytes(12).toString('hex')
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

async function sha256File(path) {
  return sha256(await readFile(path))
}

async function lstatMaybe(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Load the release downloader beside this helper. The import URL carries the
 * release helper's own mtime/size/inode stamp, so replacing only
 * `cliproxyapi-release.mjs` is observed on the next install even when the host
 * cached this module under an unchanged stamp.
 * @returns the downloader for the current release-helper bytes.
 */
async function loadReleaseDownloader() {
  const releaseUrl = new URL('./cliproxyapi-release.mjs', import.meta.url)
  const releasePath = fileURLToPath(releaseUrl)
  let info
  try {
    info = statSync(releasePath)
  } catch (error) {
    fail('IO', `release helper is missing or unreadable: ${releasePath}`, { cause: error })
  }
  const stamp = `${String(info.mtimeMs)}:${String(info.size)}:${String(info.ino)}`
  if (releaseDownloader?.stamp === stamp) return releaseDownloader.download
  let module
  try {
    module = await import(`${releaseUrl.href}?stamp=${encodeURIComponent(stamp)}`)
  } catch (error) {
    fail('IO', `release helper could not be loaded: ${releasePath}`, { cause: error })
  }
  if (typeof module.downloadProxyRelease !== 'function') {
    fail('IO', 'release helper does not export downloadProxyRelease')
  }
  releaseDownloader = { stamp, download: module.downloadProxyRelease }
  return releaseDownloader.download
}

function parsePort(value) {
  const port = typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value) : value
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail('INVALID_OPTIONS', `port must be an integer between 1 and 65535, got ${JSON.stringify(value)}`)
  }
  return port
}

export function assertSupportedPlatform(platform, arch) {
  if (!SUPPORTED_ARCH[platform]?.includes(arch)) {
    fail('PLATFORM_UNSUPPORTED', `CLIProxyAPI install is unsupported on ${platform}/${arch}`)
  }
}

/** Resolve every path the receipt may own for one install. */
export function resolveCliProxyLayout(options) {
  if (options === null || typeof options !== 'object') {
    fail('INVALID_OPTIONS', 'install layout needs a { dshHome } object')
  }
  const {
    dshHome,
    platform = process.platform,
    userHome = process.env.HOME ?? homedir(),
    xdgConfigHome,
  } = options
  if (typeof dshHome !== 'string' || dshHome.trim() === '') {
    fail('INVALID_OPTIONS', 'dshHome must be a non-empty path')
  }
  const root = resolve(dshHome, 'providers', 'cliproxyapi')
  const serviceKind = platform === 'linux' ? SYSTEMD_KIND : platform === 'darwin' ? LAUNCHD_KIND : fail(
    'PLATFORM_UNSUPPORTED', `CLIProxyAPI install is unsupported on ${platform}`,
  )
  const serviceLabel = platform === 'linux' ? SERVICE_LABEL : LAUNCHD_LABEL
  const xdg = xdgConfigHome ?? process.env.XDG_CONFIG_HOME
  const configHome = typeof xdg === 'string' && isAbsolute(xdg)
    ? xdg
    : resolve(userHome, '.config')
  const unitPath = platform === 'linux'
    ? resolve(configHome, 'systemd', 'user', `${SERVICE_LABEL}.service`)
    : resolve(userHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
  return Object.freeze({
    root,
    binDir: join(root, 'bin'),
    binaryPath: join(root, 'bin', 'cli-proxy-api'),
    configPath: join(root, 'config.yaml'),
    authDir: join(root, 'auths'),
    staticDir: join(root, 'static'),
    dashboardPanelPath: join(root, 'static', 'management.html'),
    logDir: join(root, 'logs'),
    stdoutLogPath: join(root, 'logs', 'cliproxyapi.out.log'),
    stderrLogPath: join(root, 'logs', 'cliproxyapi.err.log'),
    bootstrapPath: join(root, 'bootstrap.json'),
    receiptPath: join(root, 'receipt.json'),
    journalPath: join(root, JOURNAL_NAME),
    removedStatePath: join(root, REMOVED_STATE_NAME),
    stageDir: join(root, '.install-stage'),
    lockPath: join(root, '.install.lock'),
    unitPath,
    serviceLabel,
    serviceKind,
    platform,
  })
}

async function defaultProbePort(port) {
  return await new Promise((resolveProbe) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (occupied) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe(occupied)
    }
    socket.setTimeout(1000, () => finish(true))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

async function releaseLock(path, expectedToken) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return
  }
  try {
    const record = JSON.parse(text)
    if (record?.token === expectedToken) await unlink(path).catch(() => {})
  } catch {
    // An unreadable lock is not ours to remove.
  }
}

/** Write one complete, durable lock record under a temporary name. */
async function writeLockRecord(path, record) {
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
    await handle.writeFile(record, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(path, 0o600)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlink(path).catch(() => {})
    throw error
  }
}

/** A parsed lock record that names a concrete owner. */
function validLockOwner(record) {
  return record !== null
    && typeof record === 'object'
    && typeof record.token === 'string'
    && record.token !== ''
    && Number.isInteger(record.pid)
    && record.pid > 0
}

/** Whether an unreadable/invalid lock record is old and stable enough to reclaim. */
async function staleLockRecord(layout, existing, now) {
  const info = await lstatMaybe(layout.lockPath)
  if (info === undefined || !info.isFile()) return false
  if (nowMs(now) - info.mtimeMs < INSTALL_LOCK_STALE_MS) return false
  const still = await readFile(layout.lockPath, 'utf8').catch(() => undefined)
  return still === existing
}

async function acquireInstallLock(layout, now) {
  const lockToken = token()
  const record = JSON.stringify({ version: 1, token: lockToken, pid: process.pid, startedAt: nowMs(now) })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Publish only a complete record: the exclusive hard link is the create.
    const temporary = `${layout.lockPath}.stale-${token()}`
    let created = false
    try {
      await writeLockRecord(temporary, record)
      await link(temporary, layout.lockPath)
      created = true
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        fail('IO', `cannot create install lock at ${layout.lockPath}: ${error?.message ?? String(error)}`, { cause: error })
      }
    } finally {
      await unlink(temporary).catch(() => {})
    }
    if (created) {
      return {
        token: lockToken,
        path: layout.lockPath,
        release: () => releaseLock(layout.lockPath, lockToken),
      }
    }
    const existing = await readFile(layout.lockPath, 'utf8').catch(() => undefined)
    if (existing === undefined) continue
    let parsed
    try {
      parsed = JSON.parse(existing)
    } catch {
      parsed = undefined
    }
    if (validLockOwner(parsed)) {
      if (processAlive(parsed.pid)) {
        fail('LOCKED', `install lock is held by pid ${parsed.pid}`)
      }
    } else {
      if (Number.isInteger(parsed?.pid) && parsed.pid > 0 && processAlive(parsed.pid)) {
        fail('LOCKED', `install lock is held by pid ${parsed.pid} but its record is invalid`)
      }
      if (!await staleLockRecord(layout, existing, now)) {
        fail('LOCKED', 'install lock is unreadable or invalid; refusing to steal a recent record')
      }
    }
    const still = await readFile(layout.lockPath, 'utf8').catch(() => undefined)
    if (still !== existing) continue
    const stale = `${layout.lockPath}.stale-${token()}`
    try {
      await rename(layout.lockPath, stale)
    } catch {
      continue
    }
    await unlink(stale).catch(() => {})
  }
  fail('LOCKED', 'install lock could not be acquired')
}

function rootTransient(name) {
  return ROOT_TRANSIENT.test(name)
}

function binTransient(name) {
  return BIN_TRANSIENT.test(name)
}

function panelTransient(name) {
  return PANEL_TRANSIENT.test(name)
}

async function removeKnownStages(layout) {
  const sweep = async (dir, matches) => {
    // Never follow a symlinked sweep directory: only a real directory can be
    // owned, and readdir/rm through a link would act on an unrelated target.
    const info = await lstatMaybe(dir)
    if (info === undefined || !info.isDirectory()) return
    let entries
    try {
      entries = await readdir(dir)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const name of entries) {
      if (matches(name)) await rm(join(dir, name), { recursive: true, force: true }).catch(() => {})
    }
  }
  await sweep(layout.root, (name) => rootTransient(name) && name !== '.install.lock')
  await sweep(layout.binDir, binTransient)
  await sweep(layout.staticDir, panelTransient)
  await sweep(dirname(layout.unitPath), (name) => new RegExp(`^\\.${basename(layout.unitPath).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.tmp-${TOKEN_SUFFIX}$`, 'u').test(name))
  await rm(layout.stageDir, { recursive: true, force: true }).catch(() => {})
}

async function rootHasForeignState(layout) {
  const info = await lstatMaybe(layout.root)
  if (info === undefined) return false
  if (!info.isDirectory()) return true
  const entries = await readdir(layout.root, { withFileTypes: true })
  // A receipt or an incomplete-install journal makes this the owned root;
  // both are validated against exact expected paths/tokens under the lock.
  if (entries.some((entry) => (
    entry.name === 'receipt.json'
    || entry.name === JOURNAL_NAME
    || entry.name === REMOVED_STATE_NAME
  ) && entry.isFile())) {
    return false
  }
  for (const entry of entries) {
    if (rootTransient(entry.name)) continue
    if (entry.name === '.install-stage' && entry.isDirectory()) continue
    if (entry.name === 'bin' && entry.isDirectory()) {
      const inner = await readdir(join(layout.root, 'bin'))
      if (inner.every(binTransient)) continue
      return true
    }
    if (entry.name === 'auths' && entry.isDirectory()) {
      if ((await readdir(join(layout.root, 'auths'))).length === 0) continue
      return true
    }
    return true
  }
  return false
}

function assertReceiptShape(receipt, layout) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    fail('RECEIPT_INVALID', 'receipt is not an object')
  }
  if (receipt.version !== RECEIPT_VERSION) fail('RECEIPT_INVALID', 'receipt version is not 1')
  if (typeof receipt.installId !== 'string' || receipt.installId.trim() === '') {
    fail('RECEIPT_INVALID', 'receipt has no installId')
  }
  const expected = {
    root: layout.root,
    binaryPath: layout.binaryPath,
    configPath: layout.configPath,
    authDir: layout.authDir,
    bootstrapPath: layout.bootstrapPath,
    unitPath: layout.unitPath,
    serviceLabel: layout.serviceLabel,
    serviceKind: layout.serviceKind,
  }
  for (const [field, value] of Object.entries(expected)) {
    if (receipt[field] !== value) fail('RECEIPT_INVALID', `receipt ${field} is not the expected owned path`)
  }
  for (const field of ['binarySha256', 'unitSha256', 'ownerTokenSha256']) {
    if (typeof receipt[field] !== 'string' || !HEX64.test(receipt[field])) {
      fail('RECEIPT_INVALID', `receipt ${field} is not a sha256 digest`)
    }
  }
  if (typeof receipt.cliProxyVersion !== 'string' || receipt.cliProxyVersion.trim() === '') {
    fail('RECEIPT_INVALID', 'receipt has no CLIProxyAPI version')
  }
  if (!Number.isInteger(receipt.port) || receipt.port < 1 || receipt.port > 65_535) {
    fail('RECEIPT_INVALID', 'receipt has no valid port')
  }
  if (typeof receipt.installedAt !== 'string' || Number.isNaN(Date.parse(receipt.installedAt))) {
    fail('RECEIPT_INVALID', 'receipt has no valid installedAt timestamp')
  }
}

async function readReceipt(layout, { optional = false } = {}) {
  const rootInfo = await lstatMaybe(layout.root)
  if (rootInfo === undefined) {
    if (optional) return undefined
    fail('NOT_INSTALLED', `no owned CLIProxyAPI receipt at ${layout.receiptPath}`)
  }
  if (!rootInfo.isDirectory()) fail('FOREIGN_STATE', `install root is not a directory: ${layout.root}`)
  const info = await lstatMaybe(layout.receiptPath)
  if (info === undefined) {
    if (optional) return undefined
    fail('NOT_INSTALLED', `no owned CLIProxyAPI receipt at ${layout.receiptPath}`)
  }
  if (!info.isFile()) fail('RECEIPT_INVALID', 'receipt path is not a regular file')
  let receipt
  try {
    receipt = JSON.parse(await readFile(layout.receiptPath, 'utf8'))
  } catch (error) {
    fail('RECEIPT_INVALID', `receipt cannot be parsed: ${error?.message ?? String(error)}`, { cause: error })
  }
  assertReceiptShape(receipt, layout)
  return receipt
}

async function syncDirectory(directory) {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Directory fsync is a durability hint; unsupported filesystems are fine.
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

function assertJournalShape(journal, layout) {
  if (journal === null || typeof journal !== 'object' || Array.isArray(journal)) {
    fail('FOREIGN_STATE', 'install journal is not an object')
  }
  if (journal.version !== 1) fail('FOREIGN_STATE', 'install journal version is not 1')
  if (typeof journal.ownerTokenSha256 !== 'string' || !HEX64.test(journal.ownerTokenSha256)) {
    fail('FOREIGN_STATE', 'install journal has no stable owner token digest')
  }
  for (const field of ['binarySha256', 'unitSha256']) {
    if (typeof journal[field] !== 'string' || !HEX64.test(journal[field])) {
      fail('FOREIGN_STATE', `install journal ${field} is not a sha256 digest`)
    }
  }
  for (const field of ['previousBinarySha256', 'previousUnitSha256']) {
    if (journal[field] !== undefined && (typeof journal[field] !== 'string' || !HEX64.test(journal[field]))) {
      fail('FOREIGN_STATE', `install journal ${field} is not a sha256 digest`)
    }
  }
  for (const field of ['dashboardPanelSha256', 'previousDashboardPanelSha256']) {
    if (journal[field] !== undefined && (typeof journal[field] !== 'string' || !HEX64.test(journal[field]))) {
      fail('FOREIGN_STATE', `install journal ${field} is not a sha256 digest`)
    }
  }
  if (typeof journal.installId !== 'string' || journal.installId.trim() === '') {
    fail('FOREIGN_STATE', 'install journal has no installId')
  }
  const expected = {
    root: layout.root,
    binaryPath: layout.binaryPath,
    configPath: layout.configPath,
    authDir: layout.authDir,
    bootstrapPath: layout.bootstrapPath,
    unitPath: layout.unitPath,
    serviceLabel: layout.serviceLabel,
    serviceKind: layout.serviceKind,
  }
  for (const [field, value] of Object.entries(expected)) {
    if (journal[field] !== value) fail('FOREIGN_STATE', `install journal ${field} is not the expected owned path`)
  }
}

function assertRemovedStateShape(removed, layout) {
  if (removed === null || typeof removed !== 'object' || Array.isArray(removed)) {
    fail('FOREIGN_STATE', 'removed-state marker is not an object')
  }
  if (removed.version !== 1 || removed.state !== 'removed') {
    fail('FOREIGN_STATE', 'removed-state marker version/state is invalid')
  }
  if (typeof removed.ownerTokenSha256 !== 'string' || !HEX64.test(removed.ownerTokenSha256)) {
    fail('FOREIGN_STATE', 'removed-state marker has no stable owner token digest')
  }
  for (const field of ['binarySha256', 'unitSha256']) {
    if (typeof removed[field] !== 'string' || !HEX64.test(removed[field])) {
      fail('FOREIGN_STATE', `removed-state marker ${field} is not a sha256 digest`)
    }
  }
  if (typeof removed.installId !== 'string' || removed.installId.trim() === '') {
    fail('FOREIGN_STATE', 'removed-state marker has no installId')
  }
  const expected = {
    root: layout.root,
    binaryPath: layout.binaryPath,
    configPath: layout.configPath,
    authDir: layout.authDir,
    bootstrapPath: layout.bootstrapPath,
    unitPath: layout.unitPath,
    serviceLabel: layout.serviceLabel,
    serviceKind: layout.serviceKind,
  }
  for (const [field, value] of Object.entries(expected)) {
    if (removed[field] !== value) fail('FOREIGN_STATE', `removed-state marker ${field} is not the expected owned path`)
  }
}

async function readRemovedState(layout, { optional = false } = {}) {
  const rootInfo = await lstatMaybe(layout.root)
  if (rootInfo === undefined) {
    if (optional) return undefined
    fail('NOT_INSTALLED', `no removed-state marker at ${layout.removedStatePath}`)
  }
  if (!rootInfo.isDirectory()) fail('FOREIGN_STATE', `install root is not a directory: ${layout.root}`)
  const info = await lstatMaybe(layout.removedStatePath)
  if (info === undefined) {
    if (optional) return undefined
    fail('NOT_INSTALLED', `no removed-state marker at ${layout.removedStatePath}`)
  }
  if (!info.isFile()) fail('FOREIGN_STATE', 'removed-state marker path is not a regular file')
  let removed
  try {
    removed = JSON.parse(await readFile(layout.removedStatePath, 'utf8'))
  } catch (error) {
    fail('FOREIGN_STATE', `removed-state marker cannot be parsed: ${error?.message ?? String(error)}`, { cause: error })
  }
  assertRemovedStateShape(removed, layout)
  return removed
}

async function writeRemovedState(layout, {
  installId,
  ownerTokenSha256,
  binarySha256,
  unitSha256,
  now,
}) {
  const removed = {
    version: 1,
    state: 'removed',
    installId,
    ownerTokenSha256,
    binarySha256,
    unitSha256,
    root: layout.root,
    binaryPath: layout.binaryPath,
    configPath: layout.configPath,
    authDir: layout.authDir,
    bootstrapPath: layout.bootstrapPath,
    unitPath: layout.unitPath,
    serviceLabel: layout.serviceLabel,
    serviceKind: layout.serviceKind,
    removedAt: new Date(nowMs(now)).toISOString(),
  }
  await atomicWrite(layout.removedStatePath, `${JSON.stringify(removed, null, 2)}\n`, 0o600)
  await syncDirectory(layout.root)
  return removed
}

function assertOwnershipMatches(left, right, relation) {
  if (left.installId !== right.installId || left.ownerTokenSha256 !== right.ownerTokenSha256) {
    fail('FOREIGN_STATE', `${relation} installId/owner token do not match`)
  }
}

function validateOwnershipMarkers({ receipt, journal, removed }) {
  if (receipt !== undefined && journal !== undefined) {
    assertOwnershipMatches(receipt, journal, 'receipt and journal')
  }
  if (receipt !== undefined && removed !== undefined) {
    assertOwnershipMatches(receipt, removed, 'receipt and removed-state marker')
  }
  if (journal !== undefined && removed !== undefined) {
    assertOwnershipMatches(journal, removed, 'journal and removed-state marker')
  }
}

async function readJournal(layout, { optional = false } = {}) {
  const rootInfo = await lstatMaybe(layout.root)
  if (rootInfo === undefined) {
    if (optional) return undefined
    fail('NOT_INSTALLED', `no install journal at ${layout.journalPath}`)
  }
  if (!rootInfo.isDirectory()) fail('FOREIGN_STATE', `install root is not a directory: ${layout.root}`)
  const info = await lstatMaybe(layout.journalPath)
  if (info === undefined) {
    if (optional) return undefined
    fail('NOT_INSTALLED', `no install journal at ${layout.journalPath}`)
  }
  if (!info.isFile()) fail('FOREIGN_STATE', 'install journal path is not a regular file')
  let journal
  try {
    journal = JSON.parse(await readFile(layout.journalPath, 'utf8'))
  } catch (error) {
    fail('FOREIGN_STATE', `install journal cannot be parsed: ${error?.message ?? String(error)}`, { cause: error })
  }
  assertJournalShape(journal, layout)
  return journal
}

async function writeJournal(layout, {
  installId,
  ownerTokenSha256,
  binarySha256,
  unitSha256,
  previousBinarySha256,
  previousUnitSha256,
  dashboardPanelSha256,
  previousDashboardPanelSha256,
  now,
}) {
  const journal = {
    version: 1,
    installId,
    ownerTokenSha256,
    binarySha256,
    unitSha256,
    ...(previousBinarySha256 === undefined ? {} : { previousBinarySha256 }),
    ...(previousUnitSha256 === undefined ? {} : { previousUnitSha256 }),
    ...(dashboardPanelSha256 === undefined ? {} : { dashboardPanelSha256 }),
    ...(previousDashboardPanelSha256 === undefined ? {} : { previousDashboardPanelSha256 }),
    root: layout.root,
    binaryPath: layout.binaryPath,
    configPath: layout.configPath,
    authDir: layout.authDir,
    bootstrapPath: layout.bootstrapPath,
    unitPath: layout.unitPath,
    serviceLabel: layout.serviceLabel,
    serviceKind: layout.serviceKind,
    createdAt: new Date(nowMs(now)).toISOString(),
  }
  await atomicWrite(layout.journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600)
  await syncDirectory(layout.root)
  return journal
}

async function readBootstrap(layout, { optional = false } = {}) {
  const info = await lstatMaybe(layout.bootstrapPath)
  if (info === undefined) {
    if (optional) return undefined
    fail('CREDENTIAL_STATE_INVALID', 'owned bootstrap is missing')
  }
  if (!info.isFile()) fail('CREDENTIAL_STATE_INVALID', 'bootstrap path is not a regular file')
  let bootstrap
  try {
    bootstrap = JSON.parse(await readFile(layout.bootstrapPath, 'utf8'))
  } catch (error) {
    fail('CREDENTIAL_STATE_INVALID', 'owned bootstrap is unreadable', { cause: error })
  }
  if (bootstrap?.version !== 1
    || typeof bootstrap.ownerToken !== 'string' || !HEX64.test(bootstrap.ownerToken)
    || typeof bootstrap.installId !== 'string' || bootstrap.installId.trim() === ''
    || typeof bootstrap.managementSecretKey !== 'string' || bootstrap.managementSecretKey === ''
    || typeof bootstrap.inferenceKey !== 'string' || bootstrap.inferenceKey === '') {
    fail('CREDENTIAL_STATE_INVALID', 'owned bootstrap has no stable owner token or credentials')
  }
  return bootstrap
}

function unquoteYamlScalar(raw) {
  const value = raw.trim()
  if (value === '') return undefined
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  const withoutComment = value.replace(/\s+#.*$/u, '').trim()
  return withoutComment === '' ? undefined : withoutComment
}

/**
 * Read the first plaintext access.api-keys entry from a config produced by
 * this installer or by the management panel. This is intentionally a narrow
 * block-list reader, not a general YAML implementation; unparseable configs
 * fall back to the bootstrap seed key.
 */
function extractInferenceKeyFromConfig(text) {
  const lines = text.split(/\r?\n/u)
  let inAccess = false
  let inKeys = false
  const keys = []
  for (const line of lines) {
    if (/^access:\s*(?:#.*)?$/u.test(line)) {
      inAccess = true
      inKeys = false
      continue
    }
    if (/^\S/u.test(line)) {
      if (inAccess) break
      continue
    }
    if (!inAccess) continue
    const apiKeys = /^\s+api-keys:\s*(.*)$/u.exec(line)
    if (apiKeys !== null) {
      const rest = apiKeys[1].trim()
      if (rest.startsWith('[') && rest.endsWith(']')) {
        for (const part of rest.slice(1, -1).split(',')) {
          const key = unquoteYamlScalar(part)
          if (key !== undefined) keys.push(key)
        }
        inKeys = false
      } else if (rest === '' || rest.startsWith('#')) {
        inKeys = true
      } else {
        const key = unquoteYamlScalar(rest)
        if (key !== undefined) keys.push(key)
        inKeys = false
      }
      continue
    }
    if (inKeys) {
      const item = /^\s*-\s*(.*)$/u.exec(line)
      if (item !== null) {
        const key = unquoteYamlScalar(item[1])
        if (key !== undefined) keys.push(key)
        continue
      }
      if (/^\s*(?:#.*)?$/u.test(line)) continue
      inKeys = false
    }
  }
  return keys[0]
}

function extractServerPortFromConfig(text) {
  const lines = text.split(/\r?\n/u)
  let inServer = false
  for (const line of lines) {
    if (/^server:\s*(?:#.*)?$/u.test(line)) {
      inServer = true
      continue
    }
    if (/^\S/u.test(line)) {
      if (inServer) break
      continue
    }
    if (!inServer) continue
    const port = /^\s+port:\s*(.*)$/u.exec(line)
    if (port === null) continue
    const value = unquoteYamlScalar(port[1])
    const parsed = value === undefined ? Number.NaN : Number(value)
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : undefined
  }
  return undefined
}

async function assertConfigPort(layout, requestedPort) {
  const info = await lstatMaybe(layout.configPath)
  if (info === undefined) return undefined
  if (!info.isFile()) fail('CREDENTIAL_STATE_INVALID', 'config path is not a regular file')
  const configPort = extractServerPortFromConfig(await readFile(layout.configPath, 'utf8'))
  if (configPort === undefined) {
    fail('CONFIG_PORT_MISMATCH', 'config.yaml server.port could not be parsed; refusing download/service changes')
  }
  if (configPort !== requestedPort) {
    fail('CONFIG_PORT_MISMATCH', `config.yaml server.port ${configPort} differs from requested port ${requestedPort}`)
  }
  return configPort
}

async function inspectUnit(layout, { receipt, journal, removed } = {}) {
  const info = await lstatMaybe(layout.unitPath)
  if (info === undefined) return { exists: false }
  if (!info.isFile()) fail('FOREIGN_STATE', `service unit path is not a regular file: ${layout.unitPath}`)
  if (receipt === undefined && journal === undefined && removed === undefined) {
    fail('FOREIGN_STATE', `refusing to adopt a foreign service unit at ${layout.unitPath}`)
  }
  const content = await readFile(layout.unitPath)
  const known = [
    receipt?.unitSha256,
    journal?.unitSha256,
    journal?.previousUnitSha256,
    removed?.unitSha256,
  ].filter((value) => typeof value === 'string')
  if (!known.includes(sha256(content))) {
    fail('UNIT_MODIFIED', 'owned service unit matches no known ownership target')
  }
  return { exists: true, content, mode: info.mode & 0o777 }
}

async function inspectBinary(layout, { receipt, journal, removed } = {}) {
  const info = await lstatMaybe(layout.binaryPath)
  if (info === undefined) return { exists: false }
  if (!info.isFile()) fail('FOREIGN_STATE', `binary path is not a regular file: ${layout.binaryPath}`)
  if (receipt === undefined && journal === undefined && removed === undefined) {
    fail('FOREIGN_STATE', `refusing to adopt an unowned binary at ${layout.binaryPath}`)
  }
  const known = [
    receipt?.binarySha256,
    journal?.binarySha256,
    journal?.previousBinarySha256,
    removed?.binarySha256,
  ].filter((value) => typeof value === 'string')
  if (!known.includes(await sha256File(layout.binaryPath))) {
    fail('BINARY_MODIFIED', 'owned binary matches no known ownership target')
  }
  return { exists: true }
}

async function inspectCredentials(layout) {
  const config = await lstatMaybe(layout.configPath)
  const bootstrap = await lstatMaybe(layout.bootstrapPath)
  if (config !== undefined && !config.isFile()) fail('CREDENTIAL_STATE_INVALID', 'config path is not a regular file')
  if (bootstrap !== undefined && !bootstrap.isFile()) fail('CREDENTIAL_STATE_INVALID', 'bootstrap path is not a regular file')
  return { configExists: config !== undefined, bootstrapExists: bootstrap !== undefined }
}

/**
 * Detect a binary/panel pair left half-published by a crash between the two
 * renames. A journal without the panel target describes a binary-only install.
 * @param layout - resolved install layout.
 * @param journal - the durable install journal, when one exists.
 * @returns whether exactly one half of the target pair is in place.
 */
async function inspectPublishPair(layout, journal) {
  if (journal === undefined) {
    return { halfPublished: false, binaryMatches: undefined, panelMatches: undefined, unitMatches: undefined }
  }
  const binaryInfo = await lstatMaybe(layout.binaryPath)
  const binaryMatches = binaryInfo?.isFile() === true
    && await sha256File(layout.binaryPath) === journal.binarySha256
  const unitInfo = await lstatMaybe(layout.unitPath)
  const unitMatches = unitInfo?.isFile() === true
    && await sha256File(layout.unitPath) === journal.unitSha256
  if (journal.dashboardPanelSha256 === undefined) {
    return { halfPublished: false, binaryMatches, panelMatches: undefined, unitMatches }
  }
  const panelInfo = await lstatMaybe(layout.dashboardPanelPath)
  const panelMatches = panelInfo?.isFile() === true
    && await sha256File(layout.dashboardPanelPath) === journal.dashboardPanelSha256
  return { halfPublished: binaryMatches !== panelMatches, binaryMatches, panelMatches, unitMatches }
}

/** Find one transient backup in a directory whose bytes match a recorded digest. */
async function findTransientWithDigest(directory, matches, expectedSha256) {
  let entries
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  for (const name of entries) {
    if (!matches(name)) continue
    const path = join(directory, name)
    if ((await lstatMaybe(path))?.isFile() !== true) continue
    if (await sha256File(path) === expectedSha256) return path
  }
  return undefined
}

/** Move a transient backup over its live path, falling back to a copy. */
async function promoteTransient(source, target, mode) {
  try {
    await rename(source, target)
  } catch {
    await copyFile(source, target)
    await rm(source, { force: true }).catch(() => {})
  }
  await chmod(target, mode)
}

/**
 * Restore or complete a binary/panel pair left half-published by a crash. The
 * next install calls this before its stage sweep; a status/preflight only
 * reports the half-published state.
 * @param layout - resolved install layout.
 * @param journal - the prior install journal, when one exists.
 * @returns what recovery did: consistent, completed, restored, or unrecoverable.
 */
async function recoverHalfPublishedPair(layout, journal) {
  const pair = await inspectPublishPair(layout, journal)
  if (!pair.halfPublished) return { status: 'consistent' }
  if (pair.binaryMatches) {
    // The binary rename landed first: publish the staged panel when its bytes
    // are the journaled target.
    const panelSource = join(layout.stageDir, 'static', 'management.html')
    if ((await lstatMaybe(panelSource))?.isFile() === true
      && await sha256File(panelSource) === journal.dashboardPanelSha256) {
      const staticInfo = await lstatMaybe(layout.staticDir)
      if (staticInfo !== undefined && !staticInfo.isDirectory()) return { status: 'unrecoverable' }
      if (staticInfo === undefined) await mkdir(layout.staticDir, { recursive: true, mode: 0o755 })
      await rename(panelSource, layout.dashboardPanelPath)
      await chmod(layout.dashboardPanelPath, 0o644)
      return { status: 'completed' }
    }
    // Completion is impossible; restore the previous binary so the old pair
    // stays internally consistent.
    if (journal.previousBinarySha256 !== undefined) {
      const backup = await findTransientWithDigest(layout.binDir, binTransient, journal.previousBinarySha256)
      if (backup !== undefined) {
        await promoteTransient(backup, layout.binaryPath, 0o700)
        return { status: 'restored' }
      }
    }
    return { status: 'unrecoverable' }
  }
  // A panel landed without its binary: restore the prior panel or absence.
  if (journal.previousDashboardPanelSha256 === undefined) {
    await unlink(layout.dashboardPanelPath).catch(() => {})
    return { status: 'restored' }
  }
  const backup = await findTransientWithDigest(layout.staticDir, panelTransient, journal.previousDashboardPanelSha256)
  if (backup === undefined) return { status: 'unrecoverable' }
  await promoteTransient(backup, layout.dashboardPanelPath, 0o644)
  return { status: 'restored' }
}

function systemdExecQuote(value) {
  return JSON.stringify(value).replaceAll('$', '$$').replaceAll('%', '%%')
}

function systemdPathQuote(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(' ', '\\x20')
    .replaceAll('%', '%%')
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Render the owned user unit. No credential appears in the unit. */
export function renderServiceDefinition(layout) {
  if (layout.serviceKind === SYSTEMD_KIND) {
    const exec = `${systemdExecQuote(layout.binaryPath)} --config ${systemdExecQuote(layout.configPath)}`
    return `[Unit]
Description=DSH CLIProxyAPI (${SERVICE_LABEL})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdPathQuote(layout.root)}
ExecStart=${exec}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`
  }
  if (layout.serviceKind === LAUNCHD_KIND) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(layout.binaryPath)}</string>
    <string>--config</string>
    <string>${xmlEscape(layout.configPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(layout.root)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(layout.stdoutLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(layout.stderrLogPath)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`
  }
  fail('PLATFORM_UNSUPPORTED', `no service definition for ${layout.serviceKind}`)
}

/** v8 seed config; only written when no owned config exists. */
export function renderSeedConfig({ port, authDir, managementKey, inferenceKey }) {
  return `config-version: 8
server:
  host: 127.0.0.1
  port: ${port}
management:
  allow-remote: false
  secret-key: ${managementKey}
  disable-control-panel: false
access:
  api-keys:
    - ${inferenceKey}
oauth:
  auth-dir: ${JSON.stringify(authDir)}
routing:
  strategy: fill-first
  session-affinity: true
  session-affinity-subagents: true
  session-affinity-ttl: 1h
  session-affinity-rebind-on: quota
`
}

async function atomicWrite(path, data, mode) {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temp = join(directory, `.${basename(path)}.tmp-${token()}`)
  let handle
  try {
    handle = await open(temp, 'wx', mode)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(temp, mode)
    await rename(temp, path)
    await syncDirectory(directory)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
}

function serviceResultCode(result) {
  if (result === false) return 1
  if (typeof result === 'number') return result
  if (typeof result?.code === 'number') return result.code
  if (typeof result?.status === 'number') return result.status
  if (typeof result?.exitCode === 'number') return result.exitCode
  return 0
}

async function serviceCall(runner, command, args, {
  optional = false,
  timeoutMs = DEFAULT_SERVICE_TIMEOUT_MS,
  signal,
} = {}) {
  if (signal?.aborted === true) {
    if (optional) return
    fail('ABORTED', `${command} was aborted before it started`)
  }
  let result
  // The default runner owns TERM/KILL and its own grace period. Injected
  // runners are bounded by a race, but that only stops waiting: a fake runner
  // must honor the passed signal itself to cancel real work.
  const raceTimeoutMs = runner === defaultServiceRunner ? timeoutMs + 2000 : timeoutMs
  let timer
  let onAbort
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new CliProxyInstallError('SERVICE_TIMEOUT', `${command} exceeded its ${timeoutMs}ms timeout`)),
      raceTimeoutMs,
    )
    if (signal !== undefined) {
      onAbort = () => reject(new CliProxyInstallError('ABORTED', `${command} was aborted`))
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    result = await Promise.race([
      Promise.resolve().then(() => runner(command, args, { timeoutMs, signal })),
      deadline,
    ])
  } catch (error) {
    if (error instanceof CliProxyInstallError) {
      if (optional) return
      throw error
    }
    if (signal?.aborted === true) {
      if (optional) return
      fail('ABORTED', `${command} was aborted`, { cause: error })
    }
    if (optional) return
    fail('SERVICE_FAILED', `${command} failed to run`, { cause: error })
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  }
  if (result?.timedOut === true) {
    if (optional) return
    fail('SERVICE_TIMEOUT', `${command} exceeded its ${timeoutMs}ms timeout`)
  }
  if (result?.aborted === true || signal?.aborted === true) {
    if (optional) return
    fail('ABORTED', `${command} was aborted`)
  }
  const code = serviceResultCode(result)
  if (code !== 0 && !optional) fail('SERVICE_FAILED', `${command} exited with code ${code}`)
}

function serviceTarget(layout, uid) {
  return `gui/${uid}/${layout.serviceLabel}`
}

async function startService(runner, layout, uid, serviceOptions = {}) {
  if (layout.serviceKind === SYSTEMD_KIND) {
    await serviceCall(runner, 'systemctl', ['--user', 'daemon-reload'], serviceOptions)
    await serviceCall(runner, 'systemctl', ['--user', 'enable', `${layout.serviceLabel}.service`], serviceOptions)
    await serviceCall(runner, 'systemctl', ['--user', 'restart', `${layout.serviceLabel}.service`], serviceOptions)
    return
  }
  const target = serviceTarget(layout, uid)
  await serviceCall(runner, 'launchctl', ['bootout', target], { ...serviceOptions, optional: true })
  await serviceCall(runner, 'launchctl', ['bootstrap', `gui/${uid}`, layout.unitPath], serviceOptions)
  await serviceCall(runner, 'launchctl', ['kickstart', '-k', target], serviceOptions)
}

async function stopService(runner, layout, uid, { disable = false, ...serviceOptions } = {}) {
  if (layout.serviceKind === SYSTEMD_KIND) {
    const args = disable
      ? ['--user', 'disable', '--now', `${layout.serviceLabel}.service`]
      : ['--user', 'stop', `${layout.serviceLabel}.service`]
    await serviceCall(runner, 'systemctl', args, { ...serviceOptions, optional: true })
    return
  }
  await serviceCall(runner, 'launchctl', ['bootout', serviceTarget(layout, uid)], {
    ...serviceOptions, optional: true,
  })
}

async function resumeService(runner, layout, uid, serviceOptions = {}) {
  if (layout.serviceKind === SYSTEMD_KIND) {
    await serviceCall(runner, 'systemctl', ['--user', 'start', `${layout.serviceLabel}.service`], serviceOptions)
    return
  }
  await serviceCall(runner, 'launchctl', ['kickstart', '-k', serviceTarget(layout, uid)], serviceOptions)
}

async function serviceActivity(runner, layout, uid, serviceOptions = {}) {
  try {
    if (serviceOptions.signal?.aborted === true) return 'unknown'
    const result = layout.serviceKind === SYSTEMD_KIND
      ? await runner('systemctl', ['--user', 'is-active', `${layout.serviceLabel}.service`], serviceOptions)
      : await runner('launchctl', ['print', serviceTarget(layout, uid)], serviceOptions)
    const code = serviceResultCode(result)
    const stdout = typeof result?.stdout === 'string' ? result.stdout.trim() : ''
    if (layout.serviceKind === SYSTEMD_KIND) {
      if (code === 0 && stdout === 'active') return 'active'
      if (code === 3 || stdout === 'inactive' || stdout === 'failed') return 'inactive'
      return 'unknown'
    }
    if (code === 0) {
      const pid = /\bpid\s*=\s*(\d+)/u.exec(stdout)
      if ((pid !== null && Number(pid[1]) > 0) || /\bstate\s*=\s*running\b/u.test(stdout)) return 'active'
      return 'inactive'
    }
    const stderr = typeof result?.stderr === 'string' ? result.stderr : ''
    return /could not find service|no such process/iu.test(stderr) ? 'inactive' : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function serviceIsActive(runner, layout, uid, serviceOptions = {}) {
  return await serviceActivity(runner, layout, uid, serviceOptions) === 'active'
}

export function processOwnsListeningPort(pid, port) {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0')
  const socketInodes = new Set()
  const fdDir = `/proc/${pid}/fd`
  return readdir(fdDir).then(async (entries) => {
    for (const entry of entries) {
      try {
        const link = await readlink(join(fdDir, entry))
        const match = /^socket:\[(\d+)\]$/u.exec(link)
        if (match !== null) socketInodes.add(match[1])
      } catch {
        // Racy fd entries are irrelevant.
      }
    }
    if (socketInodes.size === 0) return false
    for (const table of ['tcp', 'tcp6']) {
      let text
      try {
        text = await readFile(`/proc/${pid}/net/${table}`, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/u)
        if (fields.length < 10) continue
        const local = fields[1]
        if (!local?.endsWith(`:${portHex}`)) continue
        if (fields[3] !== '0A') continue
        if (socketInodes.has(fields[9])) return true
      }
    }
    return false
  }).catch(() => false)
}

async function verifyOwnedServiceListener(layout, runner, processRunner, uid, serviceOptions, port) {
  if (layout.serviceKind === SYSTEMD_KIND) {
    let result
    try {
      result = await runner('systemctl', [
        '--user', 'show', `${layout.serviceLabel}.service`, '--property=MainPID', '--value',
      ], serviceOptions)
    } catch {
      return false
    }
    if (serviceResultCode(result) !== 0) return false
    const pid = Number(String(result?.stdout ?? '').trim())
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    let cmdline
    try {
      cmdline = (await readFile(`/proc/${pid}/cmdline`)).toString('utf8').split('\0').filter(Boolean)
    } catch {
      return false
    }
    if (!cmdline.includes(layout.binaryPath) || !cmdline.includes(layout.configPath)) return false
    return await processOwnsListeningPort(pid, port)
  }
  if (layout.serviceKind !== LAUNCHD_KIND) return false
  let result
  try {
    result = await runner('launchctl', ['print', serviceTarget(layout, uid)], serviceOptions)
  } catch {
    return false
  }
  if (serviceResultCode(result) !== 0) return false
  const stdout = typeof result?.stdout === 'string' ? result.stdout : ''
  const pidMatch = /\bpid\s*=\s*(\d+)/u.exec(stdout)
  const pid = pidMatch === null ? Number.NaN : Number(pidMatch[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (!/\bstate\s*=\s*running\b/u.test(stdout)) return false
  let processResult
  try {
    processResult = await processRunner('ps', ['-o', 'args=', '-p', String(pid)], serviceOptions)
  } catch {
    return false
  }
  if (serviceResultCode(processResult) !== 0) return false
  const commandLine = typeof processResult?.stdout === 'string' ? processResult.stdout : ''
  if (!commandLine.includes(layout.binaryPath) || !commandLine.includes(layout.configPath)) return false
  let listenerResult
  try {
    listenerResult = await processRunner('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], serviceOptions)
  } catch {
    return false
  }
  if (serviceResultCode(listenerResult) !== 0) return false
  const listenerPids = String(listenerResult?.stdout ?? '').trim().split(/\s+/u).filter(Boolean).map(Number)
  return listenerPids.includes(pid)
}

export function defaultServiceRunner(command, args, {
  timeoutMs = DEFAULT_SERVICE_TIMEOUT_MS,
  signal,
} = {}) {
  return new Promise((resolveRun) => {
    if (signal?.aborted === true) {
      resolveRun({ code: -1, stdout: '', stderr: 'aborted before start', aborted: true })
      return
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false
    let timeoutTimer
    let killTimer
    let forceTimer
    const cleanup = () => {
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
      clearTimeout(forceTimer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      cleanup()
      resolveRun({ stdout, stderr, timedOut, aborted, ...result })
    }
    const terminate = (reason) => {
      if (reason === 'timeout') timedOut = true
      else aborted = true
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      if (killTimer === undefined) {
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          forceTimer = setTimeout(() => {
            finish({ code: -1, stderr: stderr || `${reason}: child did not exit after SIGKILL` })
          }, 1000)
        }, 500)
      }
    }
    const onAbort = () => terminate('abort')
    signal?.addEventListener('abort', onAbort, { once: true })
    timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => finish({ code: -1, stderr: error.message }))
    child.once('close', (code, childSignal) => finish({ code: code ?? -1, signal: childSignal }))
  })
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function waitForHealth({ fetchImpl, port, attempts, intervalMs, timeoutMs, signal }) {
  let last = 'no response'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted === true) fail('ABORTED', 'install aborted during health polling')
    const controller = new AbortController()
    const timeoutError = new CliProxyInstallError('HEALTH_TIMEOUT', 'health request timed out')
    const abortError = new CliProxyInstallError('ABORTED', 'install aborted during health polling')
    let timer
    let abortHandler
    const abortDeadline = signal === undefined
      ? undefined
      : new Promise((_, reject) => {
        abortHandler = () => {
          controller.abort()
          reject(abortError)
        }
        signal.addEventListener('abort', abortHandler, { once: true })
        if (signal.aborted) abortHandler()
      })
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(timeoutError)
      }, timeoutMs)
    })
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => fetchImpl(`http://127.0.0.1:${port}/healthz`, {
          signal: controller.signal,
          redirect: 'error',
        })),
        deadline,
        ...(abortDeadline === undefined ? [] : [abortDeadline]),
      ])
      if (response?.status !== 200) throw new Error(`status ${response?.status ?? 'missing'}`)
      if (typeof response?.json !== 'function') throw new Error('health response has no JSON body')
      const body = await Promise.race([
        response.json(),
        deadline,
        ...(abortDeadline === undefined ? [] : [abortDeadline]),
      ])
      if (signal?.aborted === true) fail('ABORTED', 'install aborted during health polling')
      if (body === null || typeof body !== 'object' || body.status !== 'ok') {
        throw new Error('health signature was not status ok')
      }
      return
    } catch (error) {
      if (signal?.aborted === true) fail('ABORTED', 'install aborted during health polling')
      last = error === timeoutError ? 'timeout' : error?.message ?? String(error)
    } finally {
      clearTimeout(timer)
      if (abortHandler !== undefined) signal?.removeEventListener('abort', abortHandler)
    }
    if (attempt + 1 < attempts) await delay(intervalMs)
  }
  fail('HEALTH_TIMEOUT', `service did not become ready on port ${port} (${last})`)
}

async function rollbackInstall(state, layout, runner, uid, serviceOptions = {}) {
  if (state.serviceAttempted) {
    // Cleanup runs even when the operation signal was aborted; only the upper
    // bound carries over, so a killed/aborted start does not leave the owned
    // service in an unknown state.
    await stopService(runner, layout, uid, {
      disable: !state.priorInstalled,
      timeoutMs: serviceOptions.timeoutMs,
    }).catch(() => {})
  }
  if (state.binaryPublished) {
    if (state.binaryBackupPath !== undefined) {
      try {
        await rename(state.binaryBackupPath, layout.binaryPath)
      } catch {
        await copyFile(state.binaryBackupPath, layout.binaryPath).catch(() => {})
      }
      await chmod(layout.binaryPath, 0o700).catch(() => {})
      state.binaryBackupPath = undefined
    } else {
      await unlink(layout.binaryPath).catch(() => {})
    }
    state.binaryPublished = false
  }
  if (state.unitWritten) {
    if (state.unitBackup !== undefined) {
      await atomicWrite(layout.unitPath, state.unitBackup.content, state.unitBackup.mode).catch(() => {})
    } else {
      await unlink(layout.unitPath).catch(() => {})
    }
    state.unitWritten = false
  }
  if (state.priorInstalled) {
    // An upgrade must leave the previous receipt usable; undo newly created
    // credentials. A normal upgrade drops its journal; an interrupted-upgrade
    // retry restores the journal describing the pre-retry partial state.
    if (state.configCreated) await unlink(layout.configPath).catch(() => {})
    if (state.bootstrapCreated) await unlink(layout.bootstrapPath).catch(() => {})
    if (state.priorIncompleteUpgrade) {
      if (state.priorJournalContent !== undefined) {
        await atomicWrite(layout.journalPath, state.priorJournalContent, 0o600).catch(() => {})
      }
    } else if (state.journalWritten) {
      await unlink(layout.journalPath).catch(() => {})
    }
  } else if (!state.journalWritten) {
    // A failure before durable ownership was recorded has no credentials to
    // preserve, so remove only what this attempt created.
    if (state.configCreated) await unlink(layout.configPath).catch(() => {})
    if (state.bootstrapCreated) await unlink(layout.bootstrapPath).catch(() => {})
  } else if (state.priorJournalContent !== undefined) {
    // Retrying a pre-existing incomplete install restores the journal that
    // described the pre-retry partial state, not this attempt's new targets.
    if (state.configCreated) await unlink(layout.configPath).catch(() => {})
    if (state.bootstrapCreated) await unlink(layout.bootstrapPath).catch(() => {})
    await atomicWrite(layout.journalPath, state.priorJournalContent, 0o600).catch(() => {})
  }
  if (state.originalServiceActive && state.priorInstalled && state.originalUnitSha256 !== undefined) {
    try {
      const unitInfo = await lstatMaybe(layout.unitPath)
      if (unitInfo?.isFile() === true && await sha256File(layout.unitPath) === state.originalUnitSha256) {
        await resumeService(runner, layout, uid, { timeoutMs: serviceOptions.timeoutMs })
      }
    } catch {
      // Best effort; never mask the original install failure.
    }
  }
  if (state.dashboardPanelPublished) {
    if (state.dashboardPanelBackupPath !== undefined) {
      try {
        await rename(state.dashboardPanelBackupPath, layout.dashboardPanelPath)
      } catch {
        await copyFile(state.dashboardPanelBackupPath, layout.dashboardPanelPath).catch(() => {})
      }
      await chmod(layout.dashboardPanelPath, 0o644).catch(() => {})
      state.dashboardPanelBackupPath = undefined
    } else {
      await unlink(layout.dashboardPanelPath).catch(() => {})
    }
    state.dashboardPanelPublished = false
  }
  if (state.dashboardPanelDirCreated) await rmdir(layout.staticDir).catch(() => {})
  if (state.stdoutLogCreated) await unlink(layout.stdoutLogPath).catch(() => {})
  if (state.stderrLogCreated) await unlink(layout.stderrLogPath).catch(() => {})
  if (state.logDirCreated) await rmdir(layout.logDir).catch(() => {})
  if (state.authsCreated) await rmdir(layout.authDir).catch(() => {})
  if (state.binCreated) await rmdir(layout.binDir).catch(() => {})
}

function normalizeError(error) {
  if (error instanceof CliProxyInstallError) return error
  return new CliProxyInstallError(error?.code ?? 'IO', error?.message ?? String(error), { cause: error })
}

export async function installCliProxyApi(options = {}) {
  if (options === null || typeof options !== 'object') fail('INVALID_OPTIONS', 'install options must be an object')
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  assertSupportedPlatform(platform, arch)
  const port = parsePort(options.port ?? DEFAULT_PORT)
  const healthAttempts = options.healthAttempts ?? 20
  const healthIntervalMs = options.healthIntervalMs ?? 250
  const healthTimeoutMs = options.healthTimeoutMs ?? 1000
  if (!Number.isSafeInteger(healthAttempts) || healthAttempts <= 0) {
    fail('INVALID_OPTIONS', 'healthAttempts must be a positive integer')
  }
  if (!Number.isSafeInteger(healthIntervalMs) || healthIntervalMs < 0) {
    fail('INVALID_OPTIONS', 'healthIntervalMs must be a non-negative integer')
  }
  if (!Number.isSafeInteger(healthTimeoutMs) || healthTimeoutMs <= 0) {
    fail('INVALID_OPTIONS', 'healthTimeoutMs must be a positive integer')
  }
  const serviceTimeoutMs = options.serviceTimeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS
  if (!Number.isSafeInteger(serviceTimeoutMs) || serviceTimeoutMs <= 0) {
    fail('INVALID_OPTIONS', 'serviceTimeoutMs must be a positive integer')
  }
  const serviceOptions = { timeoutMs: serviceTimeoutMs, signal: options.signal }
  const healthFetch = options.fetch ?? options.healthFetch ?? globalThis.fetch
  if (typeof healthFetch !== 'function') fail('INVALID_OPTIONS', 'fetch must be available for readiness checks')
  const downloadRelease = options.downloadRelease ?? options.download ?? await loadReleaseDownloader()
  if (typeof downloadRelease !== 'function') fail('INVALID_OPTIONS', 'downloadRelease must be a function')
  const probePort = options.probePort ?? options.portProbe ?? defaultProbePort
  if (typeof probePort !== 'function') fail('INVALID_OPTIONS', 'probePort must be a function')
  const runner = options.serviceRunner ?? options.runService ?? defaultServiceRunner
  if (typeof runner !== 'function') fail('INVALID_OPTIONS', 'serviceRunner must be a function')
  const processRunner = options.processRunner ?? options.runProcess ?? defaultServiceRunner
  if (typeof processRunner !== 'function') fail('INVALID_OPTIONS', 'processRunner must be a function')
  const verifyListener = options.verifyListener === undefined
    ? (context) => verifyOwnedServiceListener(
      context.layout, context.serviceRunner, context.processRunner, context.uid, context.serviceOptions, context.port,
    )
    : options.verifyListener
  if (typeof verifyListener !== 'function') fail('INVALID_OPTIONS', 'verifyListener must be a function')
  const layout = resolveCliProxyLayout({
    dshHome: options.dshHome ?? options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    platform,
    userHome: options.userHome ?? options.homeDir,
    xdgConfigHome: options.xdgConfigHome,
  })
  const uid = options.uid ?? process.getuid?.() ?? 501

  // Read-only ownership preflight before treating an occupied port as foreign.
  const preflightReceipt = await readReceipt(layout, { optional: true })
  const preflightJournal = await readJournal(layout, { optional: true })
  const preflightRemoved = await readRemovedState(layout, { optional: true })
  validateOwnershipMarkers({
    receipt: preflightReceipt,
    journal: preflightJournal,
    removed: preflightRemoved,
  })
  const hasOwnerMarker = preflightReceipt !== undefined
    || preflightJournal !== undefined
    || preflightRemoved !== undefined
  if (options.signal?.aborted === true) fail('ABORTED', 'install aborted before any change')
  const rootInfo = await lstatMaybe(layout.root)
  if (rootInfo !== undefined && !rootInfo.isDirectory()) {
    fail('FOREIGN_STATE', `refusing to use a non-directory install root: ${layout.root}`)
  }
  if (!hasOwnerMarker) {
    if (await rootHasForeignState(layout)) {
      fail('FOREIGN_STATE', `refusing to adopt a foreign directory at ${layout.root}`)
    }
    if (await lstatMaybe(layout.unitPath) !== undefined) {
      fail('FOREIGN_STATE', `refusing to adopt a foreign service unit at ${layout.unitPath}`)
    }
    if (await lstatMaybe(layout.binaryPath) !== undefined) {
      fail('FOREIGN_STATE', `refusing to adopt an unowned binary at ${layout.binaryPath}`)
    }
  } else if (preflightReceipt === undefined && preflightJournal === undefined && preflightRemoved !== undefined) {
    // Removed-state ownership covers the retained config root, not a service.
    // Leftover unit/binary are allowed only when they still match the last
    // known owned hashes; any foreign replacement is refused before mutation.
    await inspectUnit(layout, { removed: preflightRemoved })
    await inspectBinary(layout, { removed: preflightRemoved })
  }

  // Refusals that must happen before any filesystem mutation. An occupied
  // port is only tolerated for a receipt-owned install whose verified active
  // service is the current listener; an arbitrary listener is never assumed.
  if (await probePort(port, '127.0.0.1')) {
    if (preflightReceipt !== undefined) {
      const binary = await inspectBinary(layout, {
        receipt: preflightReceipt,
        journal: preflightJournal,
        removed: preflightRemoved,
      })
      if (!binary.exists) fail('BINARY_MODIFIED', 'owned binary is missing; refusing an occupied-port upgrade')
      const unit = await inspectUnit(layout, {
        receipt: preflightReceipt,
        journal: preflightJournal,
        removed: preflightRemoved,
      })
      if (!unit.exists) {
        fail('UNIT_MODIFIED', 'owned service unit is missing or modified; refusing an occupied-port upgrade')
      }
      if (!await serviceIsActive(runner, layout, uid, serviceOptions)) {
        fail('PORT_IN_USE', `port ${port} is in use but the owned service is not active; refusing an unattributed listener`)
      }
      if (!await verifyOwnedServiceListener(layout, runner, processRunner, uid, serviceOptions, port)) {
        fail('OWNED_UPGRADE_BLOCKED', `port ${port} is in use but the owned process/listener could not be verified; refusing to stop it`)
      }
    } else if (preflightJournal !== undefined) {
      const binary = await inspectBinary(layout, {
        journal: preflightJournal,
        removed: preflightRemoved,
      })
      const unit = await inspectUnit(layout, {
        journal: preflightJournal,
        removed: preflightRemoved,
      })
      const journalTargets = preflightRemoved === undefined
        ? binary.exists && unit.exists
          && await sha256File(layout.binaryPath) === preflightJournal.binarySha256
          && sha256(unit.content) === preflightJournal.unitSha256
        : binary.exists && unit.exists
      if (!journalTargets || !await serviceIsActive(runner, layout, uid, serviceOptions)) {
        fail('PORT_IN_USE', `port ${port} is in use but the incomplete owned install is not the verified listener`)
      }
      if (!await verifyOwnedServiceListener(layout, runner, processRunner, uid, serviceOptions, port)) {
        fail('OWNED_UPGRADE_BLOCKED', `port ${port} is in use but the incomplete owned process/listener could not be verified`)
      }
    } else {
      fail('PORT_IN_USE', `port ${port} is already in use; refusing to disturb the running service`)
    }
  }

  const rootExisted = rootInfo !== undefined
  await mkdir(layout.root, { recursive: true, mode: 0o700 })
  await chmod(layout.root, 0o700)
  let lock
  try {
    lock = await acquireInstallLock(layout, options.now)
  } catch (error) {
    if (!rootExisted) {
      await rm(layout.stageDir, { recursive: true, force: true }).catch(() => {})
      await rmdir(layout.root).catch(() => {})
    }
    throw error
  }

  const state = {
    authsCreated: false,
    binCreated: false,
    binaryBackupPath: undefined,
    binaryPublished: false,
    bootstrapCreated: false,
    configCreated: false,
    dashboardPanelBackupPath: undefined,
    dashboardPanelDirCreated: false,
    dashboardPanelPublished: false,
    journalWritten: false,
    logDirCreated: false,
    stderrLogCreated: false,
    stdoutLogCreated: false,
    originalServiceActive: false,
    originalUnitSha256: undefined,
    priorIncompleteUpgrade: false,
    priorInstalled: false,
    priorJournalContent: undefined,
    serviceAttempted: false,
    stagesOwned: false,
    unitBackup: undefined,
    unitWritten: false,
  }
  let stagePath
  let success = false
  try {
    const priorReceipt = await readReceipt(layout, { optional: true })
    const priorJournal = await readJournal(layout, { optional: true })
    const priorRemoved = await readRemovedState(layout, { optional: true })
    validateOwnershipMarkers({ receipt: priorReceipt, journal: priorJournal, removed: priorRemoved })
    state.priorInstalled = priorReceipt !== undefined
    state.priorIncompleteUpgrade = priorReceipt !== undefined && priorJournal !== undefined
    state.priorJournalContent = priorJournal === undefined
      ? undefined
      : await readFile(layout.journalPath)
    // A crash between the binary and panel renames leaves one half of the
    // journaled pair in place. Complete or restore it before the stage sweep
    // deletes the staged panel and rollback backups.
    await recoverHalfPublishedPair(layout, priorJournal).catch(() => {
      // Recovery is best effort: this install republishes both halves below.
    })
    if (priorReceipt === undefined && priorJournal === undefined && priorRemoved === undefined
      && await rootHasForeignState(layout)) {
      fail('FOREIGN_STATE', `install root contains foreign state: ${layout.root}`)
    }
    // Sweep only after ownership/foreign-state validation. Exact temp names and
    // the dedicated stage directory are the only generated artifacts removed.
    await removeKnownStages(layout)
    await mkdir(layout.stageDir, { recursive: true, mode: 0o700 })
    await chmod(layout.stageDir, 0o700)
    state.stagesOwned = true
    const unit = await inspectUnit(layout, {
      receipt: priorReceipt,
      journal: priorJournal,
      removed: priorRemoved,
    })
    await inspectBinary(layout, {
      receipt: priorReceipt,
      journal: priorJournal,
      removed: priorRemoved,
    })
    const credentials = await inspectCredentials(layout)
    const bootstrap = credentials.bootstrapExists ? await readBootstrap(layout) : undefined

    if (priorRemoved !== undefined && priorReceipt === undefined) {
      // A removed-state marker owns only the retained config root. Reinstall
      // must prove continued ownership through the private bootstrap token.
      if (bootstrap === undefined) {
        fail('CREDENTIAL_STATE_INVALID', 'removed-state reinstall requires the private bootstrap owner token')
      }
      if (sha256(bootstrap.ownerToken) !== priorRemoved.ownerTokenSha256
        || bootstrap.installId !== priorRemoved.installId) {
        fail('CREDENTIAL_STATE_INVALID', 'bootstrap owner token does not match the removed-state marker')
      }
    }

    if (priorReceipt !== undefined) {
      if (credentials.configExists && !credentials.bootstrapExists) {
        fail('CREDENTIAL_STATE_INVALID', 'owned config exists without bootstrap; refusing to reset credentials')
      }
      if (bootstrap !== undefined) {
        if (sha256(bootstrap.ownerToken) !== priorReceipt.ownerTokenSha256) {
          fail('CREDENTIAL_STATE_INVALID', 'bootstrap owner token does not match the receipt')
        }
        if (bootstrap.installId !== priorReceipt.installId) {
          fail('CREDENTIAL_STATE_INVALID', 'bootstrap does not belong to this receipt')
        }
      }
    } else if (priorJournal !== undefined) {
      if (credentials.configExists && !credentials.bootstrapExists) {
        fail('CREDENTIAL_STATE_INVALID', 'incomplete install has config without bootstrap; refusing to reset credentials')
      }
      if (bootstrap !== undefined) {
        if (sha256(bootstrap.ownerToken) !== priorJournal.ownerTokenSha256) {
          fail('CREDENTIAL_STATE_INVALID', 'bootstrap owner token does not match the install journal')
        }
        if (bootstrap.installId !== priorJournal.installId) {
          fail('CREDENTIAL_STATE_INVALID', 'bootstrap does not belong to this install journal')
        }
      }
    }

    await assertConfigPort(layout, port)
    if (priorReceipt !== undefined) {
      state.originalServiceActive = await serviceIsActive(runner, layout, uid, serviceOptions)
      state.originalUnitSha256 = priorReceipt.unitSha256
    }

    const binInfo = await lstatMaybe(layout.binDir)
    if (binInfo !== undefined && !binInfo.isDirectory()) fail('FOREIGN_STATE', 'bin path is not a directory')
    if (binInfo === undefined) {
      await mkdir(layout.binDir, { recursive: true, mode: 0o700 })
      state.binCreated = true
    }
    await chmod(layout.binDir, 0o700)
    const authInfo = await lstatMaybe(layout.authDir)
    if (authInfo !== undefined && !authInfo.isDirectory()) fail('FOREIGN_STATE', 'auth-dir path is not a directory')
    if (authInfo === undefined) {
      await mkdir(layout.authDir, { recursive: true, mode: 0o700 })
      state.authsCreated = true
    }
    await chmod(layout.authDir, 0o700)

    stagePath = join(layout.stageDir, `cli-proxy-api.stage-${token()}`)
    let downloaded
    try {
      downloaded = await downloadRelease({
        destination: stagePath,
        version: options.version,
        releasesApi: options.releasesApi,
        repo: options.repo,
        platform,
        arch,
        signal: options.signal,
        fetch: options.downloadFetch,
        timeoutMs: options.downloadTimeoutMs,
        requiredMajor: REQUIRED_CONFIG_MAJOR,
      })
    } catch (error) {
      throw normalizeError(error)
    }
    const stageInfo = await lstatMaybe(stagePath)
    if (stageInfo === undefined || !stageInfo.isFile()) fail('DOWNLOAD_FAILED', 'release download produced no regular binary')
    if (options.signal?.aborted === true) fail('ABORTED', 'install aborted after download')
    await chmod(stagePath, 0o700)
    const binarySha256 = await sha256File(stagePath)
    const unitText = renderServiceDefinition(layout)
    const unitSha256 = sha256(unitText)
    // Validate the downloaded panel before the journal names it as a target:
    // the journal's panel digest is the crash-recovery marker.
    let dashboardPanel
    if (downloaded?.dashboardPanel === 'installed') {
      const panelSource = join(layout.stageDir, 'static', 'management.html')
      const panelInfo = await lstatMaybe(panelSource)
      if (panelInfo === undefined || !panelInfo.isFile()) {
        fail('DOWNLOAD_FAILED', 'release download reported a dashboard panel but produced no regular file')
      }
      if (panelInfo.size > DASHBOARD_PANEL_MAX_BYTES) {
        fail('BOUNDS_EXCEEDED', `dashboard panel exceeds ${DASHBOARD_PANEL_MAX_BYTES} bytes`)
      }
      const priorPanel = await lstatMaybe(layout.dashboardPanelPath)
      if (priorPanel !== undefined && !priorPanel.isFile()) fail('FOREIGN_STATE', 'dashboard panel path is not a regular file')
      dashboardPanel = {
        source: panelSource,
        sha256: await sha256File(panelSource),
        previousSha256: priorPanel === undefined ? undefined : await sha256File(layout.dashboardPanelPath),
      }
    }

    const installId = priorReceipt?.installId ?? priorJournal?.installId ?? priorRemoved?.installId ?? randomUUID()
    const ownerToken = bootstrap?.ownerToken ?? randomBytes(32).toString('hex')
    const managementKey = bootstrap?.managementSecretKey ?? randomBytes(32).toString('hex')
    const inferenceKey = bootstrap?.inferenceKey ?? randomBytes(32).toString('hex')
    const ownerTokenSha256 = sha256(ownerToken)

    // Durable ownership precedes every credential, config, and unit publish.
    // "Previous" describes the bytes a crash would actually find on disk, not
    // an earlier interrupted journal target that was never published.
    const publishedBinary = await lstatMaybe(layout.binaryPath)
    const previousBinarySha256 = publishedBinary?.isFile() === true
      ? await sha256File(layout.binaryPath)
      : (priorJournal?.previousBinarySha256 ?? priorRemoved?.binarySha256 ?? priorReceipt?.binarySha256)
    const previousUnitSha256 = unit.exists
      ? sha256(unit.content)
      : (priorJournal?.previousUnitSha256 ?? priorRemoved?.unitSha256 ?? priorReceipt?.unitSha256)
    await writeJournal(layout, {
      installId,
      ownerTokenSha256,
      binarySha256,
      unitSha256,
      previousBinarySha256,
      previousUnitSha256,
      dashboardPanelSha256: dashboardPanel?.sha256,
      previousDashboardPanelSha256: dashboardPanel?.previousSha256,
      now: options.now,
    })
    state.journalWritten = true

    if (!credentials.bootstrapExists) {
      const payload = {
        version: 1,
        installId,
        ownerToken,
        configPath: layout.configPath,
        managementSecretKey: managementKey,
        inferenceKey,
        createdAt: new Date(nowMs(options.now)).toISOString(),
      }
      await atomicWrite(layout.bootstrapPath, `${JSON.stringify(payload, null, 2)}\n`, 0o600)
      state.bootstrapCreated = true
    }
    if (!credentials.configExists) {
      await atomicWrite(layout.configPath, renderSeedConfig({
        port, authDir: layout.authDir, managementKey, inferenceKey,
      }), 0o600)
      state.configCreated = true
    } else {
      await chmod(layout.configPath, 0o600)
    }
    if (credentials.bootstrapExists) await chmod(layout.bootstrapPath, 0o600)

    state.unitBackup = unit.exists ? { content: unit.content, mode: unit.mode } : undefined
    await atomicWrite(layout.unitPath, unitText, 0o644)
    state.unitWritten = true

    const oldBinary = await lstatMaybe(layout.binaryPath)
    if (oldBinary !== undefined) {
      state.binaryBackupPath = join(layout.binDir, `.rollback-binary-${token()}`)
      await copyFile(layout.binaryPath, state.binaryBackupPath)
      await chmod(state.binaryBackupPath, 0o700)
    }
    await rename(stagePath, layout.binaryPath)
    stagePath = undefined
    state.binaryPublished = true
    await chmod(layout.binaryPath, 0o700)

    if (dashboardPanel !== undefined) {
      await chmod(dashboardPanel.source, 0o644)
      const staticInfo = await lstatMaybe(layout.staticDir)
      if (staticInfo !== undefined && !staticInfo.isDirectory()) fail('FOREIGN_STATE', 'static path is not a directory')
      if (staticInfo === undefined) {
        await mkdir(layout.staticDir, { recursive: true, mode: 0o755 })
        state.dashboardPanelDirCreated = true
      }
      const priorPanel = await lstatMaybe(layout.dashboardPanelPath)
      if (priorPanel !== undefined) {
        if (!priorPanel.isFile()) fail('FOREIGN_STATE', 'dashboard panel path is not a regular file')
        state.dashboardPanelBackupPath = join(layout.staticDir, `.rollback-panel-${token()}`)
        await copyFile(layout.dashboardPanelPath, state.dashboardPanelBackupPath)
        await chmod(state.dashboardPanelBackupPath, 0o600)
      }
      await rename(dashboardPanel.source, layout.dashboardPanelPath)
      await chmod(layout.dashboardPanelPath, 0o644)
      state.dashboardPanelPublished = true
    }

    if (layout.serviceKind === LAUNCHD_KIND) {
      const logInfo = await lstatMaybe(layout.logDir)
      if (logInfo !== undefined && !logInfo.isDirectory()) fail('FOREIGN_STATE', 'log path is not a directory')
      if (logInfo === undefined) {
        await mkdir(layout.logDir, { recursive: true, mode: 0o700 })
        state.logDirCreated = true
      }
      await chmod(layout.logDir, 0o700)
      for (const [logPath, field] of [
        [layout.stdoutLogPath, 'stdoutLogCreated'],
        [layout.stderrLogPath, 'stderrLogCreated'],
      ]) {
        const info = await lstatMaybe(logPath)
        if (info === undefined) {
          await atomicWrite(logPath, '', 0o600)
          state[field] = true
        } else {
          if (!info.isFile()) fail('FOREIGN_STATE', `log path is not a regular file: ${logPath}`)
          await chmod(logPath, 0o600)
        }
      }
    }

    state.serviceAttempted = true
    await startService(runner, layout, uid, serviceOptions)
    await waitForHealth({
      fetchImpl: healthFetch,
      port,
      attempts: healthAttempts,
      intervalMs: healthIntervalMs,
      timeoutMs: healthTimeoutMs,
      signal: options.signal,
    })
    if (options.signal?.aborted === true) fail('ABORTED', 'install aborted before receipt publication')
    const startedActive = await serviceIsActive(runner, layout, uid, serviceOptions)
    if (options.signal?.aborted === true) fail('ABORTED', 'install aborted before receipt publication')
    if (!startedActive) fail('SERVICE_FAILED', 'started service is not running after health readiness')
    if (!state.priorInstalled) {
      // Health alone cannot attribute the listener: a foreign process could
      // answer /healthz after the free-port preflight. Prove the owned service
      // owns the port before publishing credentials-bearing receipt state.
      const listenerOwned = await verifyListener({
        layout,
        port,
        uid,
        serviceRunner: runner,
        processRunner,
        serviceOptions,
      })
      if (options.signal?.aborted === true) fail('ABORTED', 'install aborted before receipt publication')
      if (!listenerOwned) {
        fail('LISTENER_UNVERIFIED', `started service does not own port ${port}; refusing to publish the receipt`)
      }
    }

    const receipt = {
      version: RECEIPT_VERSION,
      installId,
      root: layout.root,
      binaryPath: layout.binaryPath,
      binarySha256,
      configPath: layout.configPath,
      authDir: layout.authDir,
      bootstrapPath: layout.bootstrapPath,
      unitPath: layout.unitPath,
      unitSha256,
      ownerTokenSha256,
      serviceLabel: layout.serviceLabel,
      serviceKind: layout.serviceKind,
      cliProxyVersion: typeof downloaded?.version === 'string' && downloaded.version.trim() !== ''
        ? downloaded.version.trim()
        : (typeof options.version === 'string' && options.version.trim() !== '' ? options.version.trim() : 'unknown'),
      port,
      installedAt: new Date(nowMs(options.now)).toISOString(),
    }
    await atomicWrite(layout.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 0o600)
    await unlink(layout.journalPath).catch(() => {})
    await unlink(layout.removedStatePath).catch(() => {})
    state.journalWritten = false
    success = true
    const finalConfigInfo = await lstatMaybe(layout.configPath)
    const finalBootstrapInfo = await lstatMaybe(layout.bootstrapPath)
    const finalConfigPort = finalConfigInfo?.isFile() === true
      ? extractServerPortFromConfig(await readFile(layout.configPath, 'utf8'))
      : undefined
    return {
      ok: true,
      action: 'install',
      installed: true,
      installId,
      version: receipt.cliProxyVersion,
      port,
      configPath: layout.configPath,
      authDir: layout.authDir,
      bootstrapPath: layout.bootstrapPath,
      managementKeyPath: layout.bootstrapPath,
      dashboardUrl: `http://127.0.0.1:${port}/management.html`,
      dashboardPanel: downloaded?.dashboardPanel === 'installed' ? 'installed' : 'embedded-or-absent',
      credentialsPresent: finalConfigInfo?.isFile() === true && finalBootstrapInfo?.isFile() === true,
      portMismatch: finalConfigInfo?.isFile() === true
        && (finalConfigPort === undefined || finalConfigPort !== port),
      service: { label: layout.serviceLabel, kind: layout.serviceKind, unitPath: layout.unitPath },
      receiptPath: layout.receiptPath,
    }
  } catch (error) {
    await rollbackInstall(state, layout, runner, uid, serviceOptions)
    throw normalizeError(error)
  } finally {
    if (stagePath !== undefined) await rm(stagePath, { force: true }).catch(() => {})
    if (state.stagesOwned) await rm(layout.stageDir, { recursive: true, force: true }).catch(() => {})
    if (state.binaryBackupPath !== undefined) {
      await rm(state.binaryBackupPath, { force: true }).catch(() => {})
    }
    if (state.dashboardPanelBackupPath !== undefined) {
      await rm(state.dashboardPanelBackupPath, { force: true }).catch(() => {})
    }
    await lock.release()
    if (!success && !rootExisted && !state.journalWritten) {
      await removeKnownStages(layout).catch(() => {})
      await rmdir(layout.binDir).catch(() => {})
      await rmdir(layout.authDir).catch(() => {})
      await rmdir(layout.root).catch(() => {})
    }
  }
}

export async function statusCliProxyApi(options = {}) {
  if (options === null || typeof options !== 'object') fail('INVALID_OPTIONS', 'status options must be an object')
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  assertSupportedPlatform(platform, arch)
  const layout = resolveCliProxyLayout({
    dshHome: options.dshHome ?? options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    platform,
    userHome: options.userHome ?? options.homeDir,
    xdgConfigHome: options.xdgConfigHome,
  })
  const receipt = await readReceipt(layout, { optional: true })
  const journal = await readJournal(layout, { optional: true })
  const publishPair = await inspectPublishPair(layout, journal)
  if (receipt === undefined) {
    const removed = await readRemovedState(layout, { optional: true })
    validateOwnershipMarkers({ journal, removed })
    const configInfo = await lstatMaybe(layout.configPath)
    const bootstrapInfo = await lstatMaybe(layout.bootstrapPath)
    const retainedConfig = (journal !== undefined || removed !== undefined)
      && configInfo?.isFile() === true
      && bootstrapInfo?.isFile() === true
    const configPort = configInfo?.isFile() === true
      ? extractServerPortFromConfig(await readFile(layout.configPath, 'utf8'))
      : undefined
    return {
      ok: true,
      action: 'status',
      installed: false,
      incomplete: journal !== undefined,
      halfPublished: publishPair.halfPublished,
      removedState: removed !== undefined,
      retainedConfig,
      ...(configPort === undefined ? {} : { port: configPort, configPort }),
      configPath: layout.configPath,
      bootstrapPath: layout.bootstrapPath,
      managementKeyPath: layout.bootstrapPath,
      credentialsPresent: configInfo?.isFile() === true && bootstrapInfo?.isFile() === true,
      service: { label: layout.serviceLabel, kind: layout.serviceKind, unitPath: layout.unitPath },
    }
  }
  if (journal !== undefined) validateOwnershipMarkers({ receipt, journal })
  const unitInfo = await lstatMaybe(layout.unitPath)
  const binaryInfo = await lstatMaybe(layout.binaryPath)
  const unitMatches = unitInfo?.isFile() === true && await sha256File(layout.unitPath) === receipt.unitSha256
  const binaryMatches = binaryInfo?.isFile() === true && await sha256File(layout.binaryPath) === receipt.binarySha256
  const configInfo = await lstatMaybe(layout.configPath)
  const bootstrapInfo = await lstatMaybe(layout.bootstrapPath)
  const configPort = configInfo?.isFile() === true
    ? extractServerPortFromConfig(await readFile(layout.configPath, 'utf8'))
    : undefined
  const actualPort = configPort ?? receipt.port
  const portMismatch = configInfo?.isFile() === true && (configPort === undefined || configPort !== receipt.port)
  return {
    ok: true,
    action: 'status',
    installed: true,
    incomplete: journal !== undefined,
    halfPublished: publishPair.halfPublished,
    removedState: false,
    retainedConfig: configInfo?.isFile() === true && bootstrapInfo?.isFile() === true,
    installId: receipt.installId,
    version: receipt.cliProxyVersion,
    port: actualPort,
    ...(configPort === undefined ? {} : { configPort }),
    portMismatch,
    configPath: layout.configPath,
    authDir: layout.authDir,
    bootstrapPath: layout.bootstrapPath,
    managementKeyPath: layout.bootstrapPath,
    dashboardUrl: `http://127.0.0.1:${actualPort}/management.html`,
    service: { label: layout.serviceLabel, kind: layout.serviceKind, unitPath: layout.unitPath },
    receiptPath: layout.receiptPath,
    binaryMatches,
    unitMatches,
    credentialsPresent: configInfo?.isFile() === true && bootstrapInfo?.isFile() === true,
  }
}

/**
 * Read-only preflight for a host that is about to create an install job. It
 * reports ownership, credential, configured-port, and bounded listener state
 * without creating, stopping, or changing anything.
 * @param options - layout, platform, port, and injectable port probe.
 * @returns the observed install state and whether the port is already in use.
 */
export async function preflightCliProxyApi(options = {}) {
  if (options === null || typeof options !== 'object') fail('INVALID_OPTIONS', 'preflight options must be an object')
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  assertSupportedPlatform(platform, arch)
  const port = parsePort(options.port ?? DEFAULT_PORT)
  const probePort = options.probePort ?? options.portProbe ?? defaultProbePort
  if (typeof probePort !== 'function') fail('INVALID_OPTIONS', 'probePort must be a function')
  const runner = options.serviceRunner ?? options.runService ?? defaultServiceRunner
  if (typeof runner !== 'function') fail('INVALID_OPTIONS', 'serviceRunner must be a function')
  const processRunner = options.processRunner ?? options.runProcess ?? defaultServiceRunner
  if (typeof processRunner !== 'function') fail('INVALID_OPTIONS', 'processRunner must be a function')
  const uid = options.uid ?? process.getuid?.() ?? 501
  const serviceTimeoutMs = options.serviceTimeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS
  if (!Number.isSafeInteger(serviceTimeoutMs) || serviceTimeoutMs <= 0) {
    fail('INVALID_OPTIONS', 'serviceTimeoutMs must be a positive integer')
  }
  const serviceOptions = { timeoutMs: serviceTimeoutMs, signal: options.signal }
  const layout = resolveCliProxyLayout({
    dshHome: options.dshHome ?? options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    platform,
    userHome: options.userHome ?? options.homeDir,
    xdgConfigHome: options.xdgConfigHome,
  })
  const receipt = await readReceipt(layout, { optional: true })
  const journal = await readJournal(layout, { optional: true })
  const removed = await readRemovedState(layout, { optional: true })
  validateOwnershipMarkers({ receipt, journal, removed })
  const configInfo = await lstatMaybe(layout.configPath)
  const bootstrapInfo = await lstatMaybe(layout.bootstrapPath)
  const configPort = configInfo?.isFile() === true
    ? extractServerPortFromConfig(await readFile(layout.configPath, 'utf8'))
    : undefined
  const actualPort = configPort ?? receipt?.port ?? port
  const portMismatch = receipt !== undefined && configInfo?.isFile() === true
    && (configPort === undefined || configPort !== receipt.port)
  const credentialsPresent = configInfo?.isFile() === true && bootstrapInfo?.isFile() === true
  const binaryMatches = receipt === undefined
    ? undefined
    : (await lstatMaybe(layout.binaryPath))?.isFile() === true
      && await sha256File(layout.binaryPath) === receipt.binarySha256
  const unitMatches = receipt === undefined
    ? undefined
    : (await lstatMaybe(layout.unitPath))?.isFile() === true
      && await sha256File(layout.unitPath) === receipt.unitSha256
  const publishPair = await inspectPublishPair(layout, journal)
  const observed = {
    action: 'preflight',
    installed: receipt !== undefined,
    incomplete: journal !== undefined,
    halfPublished: publishPair.halfPublished,
    removedState: removed !== undefined,
    installId: receipt?.installId,
    version: receipt?.cliProxyVersion,
    port: actualPort,
    ...(configPort === undefined ? {} : { configPort }),
    portMismatch,
    portInUse: await probePort(actualPort, '127.0.0.1'),
    credentialsPresent,
    configPath: layout.configPath,
    authDir: layout.authDir,
    bootstrapPath: layout.bootstrapPath,
    managementKeyPath: layout.bootstrapPath,
    service: { label: layout.serviceLabel, kind: layout.serviceKind, unitPath: layout.unitPath },
    ...(receipt === undefined ? {} : {
      receiptPath: layout.receiptPath,
      binaryMatches,
      unitMatches,
    }),
  }
  const refuse = (code, reason) => ({ ...observed, ok: false, code, reason })
  if (receipt !== undefined) {
    // An interrupted upgrade's journal names the published binary; only bytes
    // that match neither the receipt nor the journal are a modification.
    if (binaryMatches !== true && publishPair.binaryMatches !== true) {
      return refuse('BINARY_MODIFIED', 'the owned binary no longer matches the receipt')
    }
    // An interrupted upgrade writes the unit before the receipt is replaced;
    // a unit matching the journal target is a recoverable state, not a edit.
    if (unitMatches !== true && publishPair.unitMatches !== true) {
      return refuse('UNIT_MODIFIED', 'the owned service unit no longer matches the receipt')
    }
  }
  if (portMismatch) {
    return refuse('CONFIG_PORT_MISMATCH', 'config.yaml server.port differs from the receipt port; a job would refuse this install')
  }
  if (!observed.portInUse) return { ...observed, ok: true }
  if (receipt !== undefined) {
    if (!await serviceIsActive(runner, layout, uid, serviceOptions)) {
      return refuse('PORT_IN_USE', `port ${actualPort} is in use but the owned service is not active`)
    }
    return { ...observed, ok: true }
  }
  if (journal !== undefined) {
    if (!await serviceIsActive(runner, layout, uid, serviceOptions)) {
      return refuse('PORT_IN_USE', `port ${actualPort} is in use but the incomplete owned install is not active`)
    }
    return { ...observed, ok: true }
  }
  return refuse('PORT_IN_USE', `port ${actualPort} is in use by a listener this install does not own`)
}

async function unlinkOwned(path, expectedSha256, code) {
  const info = await lstatMaybe(path)
  if (info === undefined) return false
  if (!info.isFile()) fail(code, `owned path is not a regular file: ${path}`)
  if (await sha256File(path) !== expectedSha256) fail(code, `owned path no longer matches the receipt: ${path}`)
  await unlink(path)
  return true
}

async function inspectRemovalCredentials(layout) {
  const config = await lstatMaybe(layout.configPath)
  const bootstrap = await lstatMaybe(layout.bootstrapPath)
  if (config !== undefined && !config.isFile()) fail('CREDENTIAL_STATE_INVALID', 'config path is not a regular file')
  if (bootstrap !== undefined && !bootstrap.isFile()) fail('CREDENTIAL_STATE_INVALID', 'bootstrap path is not a regular file')
  if (config !== undefined && bootstrap === undefined) {
    fail('CREDENTIAL_STATE_INVALID', 'config.yaml exists without bootstrap.json; refusing removal before mutation')
  }
  return { configExists: config !== undefined, bootstrapExists: bootstrap !== undefined }
}

async function assertRemovalOwnership(layout, { receipt, journal, removed }, credentials) {
  const markers = [receipt, journal, removed].filter((value) => value !== undefined)
  if (markers.length === 0 || !credentials.bootstrapExists) return
  const bootstrap = await readBootstrap(layout)
  const ownerTokenSha256 = sha256(bootstrap.ownerToken)
  for (const marker of markers) {
    if (marker.ownerTokenSha256 !== ownerTokenSha256 || marker.installId !== bootstrap.installId) {
      fail('CREDENTIAL_STATE_INVALID', 'bootstrap owner token does not match the removal ownership markers')
    }
  }
}

async function removeOwnedFile(path, knownHashes, code) {
  const info = await lstatMaybe(path)
  if (info === undefined) return { removed: false, sha256: undefined }
  if (!info.isFile()) fail(code, `owned path is not a regular file: ${path}`)
  const hash = await sha256File(path)
  if (!knownHashes.includes(hash)) fail(code, `owned path matches no known ownership target: ${path}`)
  await unlink(path)
  return { removed: true, sha256: hash }
}

async function stopAndVerifyService(runner, layout, uid, serviceOptions) {
  await stopService(runner, layout, uid, { disable: true, ...serviceOptions })
  const activity = await serviceActivity(runner, layout, uid, serviceOptions)
  if (activity !== 'inactive') {
    fail('SERVICE_FAILED', `owned service state after stop is ${activity}; refusing to remove artifacts`)
  }
}

export async function removeCliProxyApi(options = {}) {
  if (options === null || typeof options !== 'object') fail('INVALID_OPTIONS', 'remove options must be an object')
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  assertSupportedPlatform(platform, arch)
  const layout = resolveCliProxyLayout({
    dshHome: options.dshHome ?? options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    platform,
    userHome: options.userHome ?? options.homeDir,
    xdgConfigHome: options.xdgConfigHome,
  })
  const uid = options.uid ?? process.getuid?.() ?? 501
  const runner = options.serviceRunner ?? options.runService ?? defaultServiceRunner
  if (typeof runner !== 'function') fail('INVALID_OPTIONS', 'serviceRunner must be a function')
  const serviceTimeoutMs = options.serviceTimeoutMs ?? DEFAULT_SERVICE_TIMEOUT_MS
  if (!Number.isSafeInteger(serviceTimeoutMs) || serviceTimeoutMs <= 0) {
    fail('INVALID_OPTIONS', 'serviceTimeoutMs must be a positive integer')
  }
  const serviceOptions = { timeoutMs: serviceTimeoutMs, signal: options.signal }
  const beforeLock = options.beforeLock
  if (beforeLock !== undefined && typeof beforeLock !== 'function') {
    fail('INVALID_OPTIONS', 'beforeLock must be a function')
  }

  const initialReceipt = await readReceipt(layout, { optional: true })
  const initialJournal = await readJournal(layout, { optional: true })
  const initialRemoved = await readRemovedState(layout, { optional: true })
  validateOwnershipMarkers({ receipt: initialReceipt, journal: initialJournal, removed: initialRemoved })
  if (initialReceipt === undefined && initialJournal === undefined && initialRemoved === undefined) {
    fail('NOT_INSTALLED', `no owned CLIProxyAPI receipt, journal, or removed-state marker at ${layout.root}`)
  }
  // Refuse config-without-bootstrap or a foreign owner token before any
  // lock/marker/service mutation.
  const initialCredentials = await inspectRemovalCredentials(layout)
  await assertRemovalOwnership(layout, {
    receipt: initialReceipt,
    journal: initialJournal,
    removed: initialRemoved,
  }, initialCredentials)
  if (beforeLock !== undefined) await beforeLock()
  const lock = await acquireInstallLock(layout, options.now)
  try {
    const receipt = await readReceipt(layout, { optional: true })
    const journal = await readJournal(layout, { optional: true })
    const removed = await readRemovedState(layout, { optional: true })
    validateOwnershipMarkers({ receipt, journal, removed })
    if (receipt === undefined && journal === undefined && removed === undefined) {
      fail('NOT_INSTALLED', `owned CLIProxyAPI state disappeared before removal could lock ${layout.root}`)
    }
    if (initialReceipt !== undefined && receipt !== undefined && receipt.installId !== initialReceipt.installId) {
      fail('RECEIPT_INVALID', 'receipt changed during removal')
    }
    if (initialJournal !== undefined && journal !== undefined
      && (journal.installId !== initialJournal.installId
        || journal.ownerTokenSha256 !== initialJournal.ownerTokenSha256)) {
      fail('RECEIPT_INVALID', 'install journal changed during removal')
    }
    if (initialRemoved !== undefined && removed !== undefined
      && (removed.installId !== initialRemoved.installId
        || removed.ownerTokenSha256 !== initialRemoved.ownerTokenSha256)) {
      fail('RECEIPT_INVALID', 'removed-state marker changed during removal')
    }
    const credentials = await inspectRemovalCredentials(layout)
    await assertRemovalOwnership(layout, { receipt, journal, removed }, credentials)
    const unit = await inspectUnit(layout, { receipt, journal, removed })
    const binary = await inspectBinary(layout, { receipt, journal, removed })

    const lastBinarySha256 = binary.exists
      ? await sha256File(layout.binaryPath)
      : (receipt?.binarySha256 ?? journal?.binarySha256 ?? journal?.previousBinarySha256 ?? removed?.binarySha256)
    const lastUnitSha256 = unit.exists
      ? sha256(unit.content)
      : (receipt?.unitSha256 ?? journal?.unitSha256 ?? journal?.previousUnitSha256 ?? removed?.unitSha256)
    const installId = receipt?.installId ?? journal?.installId ?? removed.installId
    const ownerTokenSha256 = receipt?.ownerTokenSha256
      ?? journal?.ownerTokenSha256
      ?? removed.ownerTokenSha256

    const mustStopService = receipt !== undefined
      || journal !== undefined
      || unit.exists
      || await serviceIsActive(runner, layout, uid, serviceOptions)
    if (mustStopService) await stopAndVerifyService(runner, layout, uid, serviceOptions)

    if (credentials.bootstrapExists) {
      await writeRemovedState(layout, {
        installId,
        ownerTokenSha256,
        binarySha256: lastBinarySha256,
        unitSha256: lastUnitSha256,
        now: options.now,
      })
    }

    const knownBinary = [
      receipt?.binarySha256,
      journal?.binarySha256,
      journal?.previousBinarySha256,
      removed?.binarySha256,
    ].filter((value) => typeof value === 'string')
    const knownUnit = [
      receipt?.unitSha256,
      journal?.unitSha256,
      journal?.previousUnitSha256,
      removed?.unitSha256,
    ].filter((value) => typeof value === 'string')
    const removedUnit = (await removeOwnedFile(layout.unitPath, knownUnit, 'UNIT_MODIFIED')).removed
    if (removedUnit && layout.serviceKind === SYSTEMD_KIND) {
      await serviceCall(runner, 'systemctl', ['--user', 'daemon-reload'], { ...serviceOptions, optional: true })
    }
    const removedBinary = (await removeOwnedFile(layout.binaryPath, knownBinary, 'BINARY_MODIFIED')).removed
    const removedReceipt = await unlink(layout.receiptPath).then(() => true).catch(() => false)
    const removedJournal = await unlink(layout.journalPath).then(() => true).catch(() => false)
    const removedMarker = credentials.bootstrapExists
      ? false
      : await unlink(layout.removedStatePath).then(() => true).catch(() => false)
    await rm(layout.stageDir, { recursive: true, force: true }).catch(() => {})
    await syncDirectory(layout.root)

    const markerInfo = await lstatMaybe(layout.removedStatePath)
    const configInfo = await lstatMaybe(layout.configPath)
    const bootstrapInfo = await lstatMaybe(layout.bootstrapPath)
    const didRemove = removedUnit || removedBinary || removedReceipt || removedJournal || removedMarker
    return {
      ok: true,
      action: 'remove',
      removed: didRemove,
      alreadyRemoved: !didRemove,
      incomplete: journal !== undefined,
      removedState: markerInfo?.isFile() === true,
      retainedConfig: configInfo?.isFile() === true && bootstrapInfo?.isFile() === true,
      removedUnit,
      removedBinary,
      removedJournal,
      service: { label: layout.serviceLabel, kind: layout.serviceKind, unitPath: layout.unitPath },
      retained: {
        configPath: layout.configPath,
        authDir: layout.authDir,
        bootstrapPath: layout.bootstrapPath,
      },
    }
  } finally {
    await lock.release()
  }
}

/**
 * Read the inference credential only after the owned receipt and private
 * bootstrap have been verified. This is for local owner/planner use and must
 * never be returned to a browser/frontend surface.
 */
export async function readOwnedInferenceCredential(dshHome, options = {}) {
  const layout = resolveCliProxyLayout({
    dshHome,
    platform: options.platform ?? process.platform,
    userHome: options.userHome ?? options.homeDir,
    xdgConfigHome: options.xdgConfigHome,
  })
  const receipt = await readReceipt(layout)
  const bootstrap = await readBootstrap(layout)
  if (sha256(bootstrap.ownerToken) !== receipt.ownerTokenSha256) {
    fail('CREDENTIAL_STATE_INVALID', 'bootstrap owner token does not match the receipt')
  }
  if (bootstrap.installId !== receipt.installId) {
    fail('CREDENTIAL_STATE_INVALID', 'bootstrap does not belong to this receipt')
  }
  // Config is user-mutable (the proxy bcrypt-hashes management secrets), so we
  // never treat parse failure as a live key. The bootstrap owner token proves
  // ownership, but cannot prove the current inference key after rotation.
  const configInfo = await lstatMaybe(layout.configPath)
  if (configInfo?.isFile() !== true) {
    fail(
      'CREDENTIAL_UNAVAILABLE',
      'config.yaml is missing; restore the owned config and read the current inference key from config.yaml access.api-keys',
    )
  }
  let current
  try {
    current = extractInferenceKeyFromConfig(await readFile(layout.configPath, 'utf8'))
  } catch (error) {
    fail('CREDENTIAL_UNAVAILABLE', 'config.yaml could not be read; read the current inference key directly from config.yaml', { cause: error })
  }
  if (current === undefined || current === '' || /^\$2[aby]\$/u.test(current)) {
    fail(
      'CREDENTIAL_UNAVAILABLE',
      'config.yaml access.api-keys could not be parsed into a current inference key; read the current key from config.yaml or edit config.yaml to expose a plaintext inference key',
    )
  }
  return current
}

const FLAG_MAP = new Map([
  ['--dsh-home', 'dshHome'],
  ['--user-home', 'userHome'],
  ['--port', 'port'],
  ['--version', 'version'],
  ['--releases-api', 'releasesApi'],
  ['--repo', 'repo'],
])

export function parseCliProxyArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : []
  let command
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]
    if (raw === '--help' || raw === '-h') return { command: 'help', options }
    if (raw === '--json') continue
    let flag = raw
    let inline
    if (typeof raw === 'string' && raw.startsWith('--') && raw.includes('=')) {
      const split = raw.indexOf('=')
      flag = raw.slice(0, split)
      inline = raw.slice(split + 1)
    }
    if (!flag.startsWith('-')) {
      if (command !== undefined) fail('INVALID_OPTIONS', `unexpected argument: ${flag}`)
      command = flag
      continue
    }
    const field = FLAG_MAP.get(flag)
    if (field === undefined) fail('INVALID_OPTIONS', `unknown flag: ${flag}`)
    const value = inline ?? args[index + 1]
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      fail('INVALID_OPTIONS', `${flag} needs a value`)
    }
    if (inline === undefined) index += 1
    options[field] = field === 'port' ? parsePort(value) : value
  }
  if (!['install', 'remove', 'status', 'preflight'].includes(command)) {
    fail('INVALID_OPTIONS', 'command must be install, remove, status, or preflight')
  }
  return { command, options }
}

export async function runCliProxyInstaller(argv, overrides = {}) {
  const { command, options } = parseCliProxyArgs(argv)
  if (command === 'help') {
    return { ok: true, action: 'help', usage: 'cliproxyapi-install.mjs install|remove|status|preflight [--dsh-home PATH] [--user-home PATH] [--port N] [--version V] [--releases-api URL] [--repo OWNER/NAME] [--json]' }
  }
  const shared = { ...options, ...overrides }
  if (command === 'install') return await installCliProxyApi(shared)
  if (command === 'remove') return await removeCliProxyApi(shared)
  if (command === 'preflight') return await preflightCliProxyApi(shared)
  return await statusCliProxyApi(shared)
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv.find((arg) => !arg.startsWith('-')) ?? 'unknown'
  try {
    const result = await runCliProxyInstaller(argv)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    const normalized = normalizeError(error)
    process.stdout.write(`${JSON.stringify({ ok: false, action: command, error: { code: normalized.code, message: normalized.message } }, null, 2)}\n`)
    return 1
  }
}

function invokedAsMain() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value
  try {
    const invoked = realpathSync(entry)
    const modulePath = realpathSync(fileURLToPath(import.meta.url))
    if (normalize(invoked) === normalize(modulePath)) return true
    const invokedStat = statSync(entry)
    const moduleStat = statSync(modulePath)
    return invokedStat.dev === moduleStat.dev && invokedStat.ino === moduleStat.ino
  } catch {
    // The invoked path or this module disappeared during startup; treat it as
    // a library import rather than running a partially resolved CLI.
    return false
  }
}

if (invokedAsMain()) {
  process.exitCode = await main()
}
