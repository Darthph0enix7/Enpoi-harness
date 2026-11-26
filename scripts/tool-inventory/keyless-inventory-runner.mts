/**
 * Keyless inventory capture runner — executes ONLY in a child process whose
 * HOME/DSH_HOME/DSH_MEMORY_DB are already set to an owned temp root.
 *
 * The outer test (`keyless-tool-inventory.e2e.ts`) refuses to spawn this file
 * until the central build records fresh profile-bundle fingerprints and the
 * operator explicitly dispatches the capture. The first code in this module
 * re-validates that contract BEFORE the dynamic harness import, because
 * enpoi-file-revert and friends capture `HOME` at module evaluation.
 *
 * It never reads or writes the operator's `~/.dsh`: the temp home has no
 * `.config/.hermes`, credentials are absent, the memory DB path is forced under
 * the temp root, and model requests go only to a local fake adapter.
 */
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PROFILE_DIR = join(REPO_ROOT, 'profile', 'web')
const PROFILE_PACKAGE = join(PROFILE_DIR, 'package.json')
const PROFILE_PATCH = join(PROFILE_DIR, 'cordis.patch.yml')
const COMPATIBILITY_FILE = join(PROFILE_DIR, 'compatibility.json')
const PRESETS = ['orchestrator', 'sysadmin', 'creator'] as const
const PROVIDER = 'inventory-capture'
const MODEL = 'inventory-capture'
const REQUIRED_TOOLS = ['compressor_retrieve', 'custom_research-fetch', 'custom_research-verify', 'run_code', 'web_fetch'] as const

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

function fail(message: string): never {
  throw new Error(`keyless inventory runner BLOCKED: ${message}`)
}

/**
 * Validate the child contract before any harness module can capture HOME or
 * open a database. The outer test owns the temp root and injects an intent
 * file + nonce; the parent's real HOME is passed explicitly so this check is
 * valid even though `os.homedir()` here already resolves to the fake home.
 */
function assertOwnedEnvironment(): { root: string; home: string } {
  const root = process.env.DSH_KEYLESS_INVENTORY_ROOT
  const home = process.env.HOME
  const parent = process.env.DSH_KEYLESS_INVENTORY_PARENT
  const nonce = process.env.DSH_KEYLESS_INVENTORY_NONCE
  if (process.env.DSH_KEYLESS_INVENTORY_CAPTURE !== '1' || process.env.DSH_KEYLESS_INVENTORY_ALLOW !== '1'
    || root === undefined || home === undefined || parent === undefined || nonce === undefined) {
    fail('missing capture intent/root/HOME/parent/nonce (spawn only via keyless-tool-inventory.e2e.ts)')
  }
  if (!resolve(root).startsWith('/') || !resolve(home).startsWith('/')) fail('owned paths must be absolute')
  const realRoot = realpathSync(root)
  const realParent = realpathSync(parent)
  if (realRoot === realParent || !pathWithin(realRoot, realParent)) fail(`root (${root}) is not a child of the owned parent (${parent})`)
  const realHome = realpathSync(home)
  if (realHome === realRoot || !pathWithin(realHome, realRoot)) fail(`HOME (${home}) is not a child of the owned root`)
  const tmp = process.env.TMPDIR
  if (tmp === undefined) fail('TMPDIR is not set')
  const realTmp = realpathSync(tmp)
  if (!pathWithin(realTmp, realRoot)) fail(`TMPDIR (${tmp}) is not under the owned root`)
  const parentHome = process.env.DSH_KEYLESS_INVENTORY_PARENT_HOME
  if (parentHome !== undefined && existsSync(parentHome)) {
    const realParentHome = realpathSync(parentHome)
    if (realRoot === realParentHome || realHome === realParentHome) fail('owned root/home must not be the parent real HOME')
  }
  const intentPath = join(realRoot, 'intent.json')
  if (!existsSync(intentPath)) fail('capture intent file is missing')
  let intent: { nonce?: unknown; capture?: unknown }
  try {
    intent = JSON.parse(readFileSync(intentPath, 'utf8')) as { nonce?: unknown; capture?: unknown }
  } catch {
    fail('capture intent file is not valid JSON')
  }
  if (intent.capture !== true || intent.nonce !== nonce) fail('capture intent nonce mismatch')
  for (const [name, value] of Object.entries({
    USERPROFILE: process.env.USERPROFILE,
    DSH_HOME: process.env.DSH_HOME,
    DSH_MEMORY_DB: process.env.DSH_MEMORY_DB,
  })) {
    if (typeof value !== 'string' || !pathWithin(resolve(value), realRoot)) fail(`${name} is not under the owned temp root`)
  }
  if (process.env.USERPROFILE !== home || process.env.DSH_HOME !== home) fail('USERPROFILE/DSH_HOME must equal HOME')
  if (process.env.DSH_MEMORY_DB !== join(home, 'memory.db')) fail('DSH_MEMORY_DB must be the owned temp memory.db')
  if (process.env.DSH_WIRE_LOG !== undefined && process.env.DSH_WIRE_LOG !== join(realRoot, 'wire', 'wire-last.json')) {
    fail('DSH_WIRE_LOG must be the owned wire file')
  }
  // Whitelisted child env: these names must never survive from the parent.
  for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'KUBECONFIG', 'DOCKER_CONFIG', 'SSH_AUTH_SOCK',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'HF_TOKEN']) {
    if (process.env[name] !== undefined) fail(`forbidden ambient env ${name} survived into the isolated child`)
  }
  const credential = Object.entries(process.env).find(([key, value]) =>
    value !== undefined && value !== '' && /(?:API_KEY|ACCESS_KEY|SECRET|PASSWORD|_TOKEN)$/iu.test(key))
  if (credential !== undefined) fail(`ambient credential env ${credential[0]} survived into the isolated child`)
  for (const forbidden of [join(home, '.hermes'), join(home, '.config', '.hermes'), join(home, '.aws'), join(home, '.ssh')]) {
    if (existsSync(forbidden)) fail(`credential/home path exists in the fake home: ${forbidden}`)
  }
  return { root: realRoot, home: realHome }
}

function pathWithin(child: string, base: string): boolean {
  return child === base || child.startsWith(`${base}${sep}`)
}

/** Replace one writable property and return an exact descriptor restore. */
function replaceProperty(owner: object, key: PropertyKey, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key)
  Object.defineProperty(owner, key, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    value,
  })
  let restored = false
  return () => {
    if (restored) return
    restored = true
    if (descriptor === undefined) Reflect.deleteProperty(owner, key)
    else Object.defineProperty(owner, key, descriptor)
  }
}

/** Read one property from a non-null object without asserting a shape. */
function propertyOf(owner: object, key: PropertyKey): unknown {
  return Reflect.get(owner, key)
}

/** Normalized connect arguments: Node/undici may pass `[options, callback]` as one slot. */
function normalizedArgs(args: readonly unknown[]): readonly unknown[] {
  const first = args[0]
  return Array.isArray(first) ? first : args
}

interface ConnectTarget {
  readonly host: string | undefined
  readonly port: number | undefined
}

/** Resolve host/port from the typed shapes net/tls/http callers actually pass. */
function targetOf(input: unknown, fallback?: unknown): ConnectTarget {
  try {
    if (typeof input === 'string' || input instanceof URL) {
      const url = input instanceof URL ? input : new URL(input)
      return { host: url.hostname, port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port) }
    }
    if (typeof input === 'number') {
      return { host: typeof fallback === 'string' ? fallback : undefined, port: input }
    }
    if (input !== null && typeof input === 'object') {
      const hostname = propertyOf(input, 'hostname')
      const host = propertyOf(input, 'host')
      const rawPort = propertyOf(input, 'port')
      return {
        host: typeof hostname === 'string' ? hostname.replace(/:\d+$/u, '') : typeof host === 'string' ? host.replace(/:\d+$/u, '') : undefined,
        port: typeof rawPort === 'number' ? rawPort : typeof rawPort === 'string' ? Number(rawPort) : undefined,
      }
    }
  } catch {
    // fall through to the blocked path
  }
  return { host: undefined, port: undefined }
}

/**
 * Narrow outbound guard for the transports the shipped harness actually uses.
 * Loopback is allowed only on the scaffold's own port after boot; any other
 * port fails closed. Known limit, logged honestly: raw dgram and child-process
 * networking are not intercepted, and this is not an OS sandbox.
 */
function installNetworkGuard(root: string): { restore: () => void; seal: (port: number) => void; diagnostics: () => { attempts: number; details: string[] } } {
  const originalFetch: typeof fetch = globalThis.fetch
  const originalHttpRequest: typeof http.request = http.request
  const originalHttpsRequest: typeof https.request = https.request
  const originalNetConnect: typeof net.Socket.prototype.connect = net.Socket.prototype.connect
  const originalTlsConnect: typeof tls.connect = tls.connect
  const originalListen: typeof net.Server.prototype.listen = net.Server.prototype.listen
  const restores: Array<() => void> = []
  let allowedPort: number | undefined
  let boundPort: number | undefined
  let ownedServer: net.Server | undefined
  let listenViolation: string | undefined
  let blockedAttempts = 0
  const blockedDetails = new Set<string>()
  const loopback = (host: string | undefined): boolean => {
    const value = typeof host === 'string' ? host.replace(/^\[|\]$/gu, '') : ''
    return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === ''
  }
  const blocked = (detail: string): never => {
    blockedAttempts += 1
    blockedDetails.add(detail)
    throw new Error(`keyless inventory network guard: blocked ${detail}`)
  }
  const admit = (detail: string, target: ConnectTarget): void => {
    if (!loopback(target.host)) blocked(`external ${detail} to ${String(target.host)}`)
    const port = target.port
    if (port === undefined || !Number.isInteger(port)) blocked(`unaddressable ${detail}`)
    // Before the owned server binds, every loopback target is rejected: no
    // allow-any-port window that a live 3080 or ambient MCP probe could use.
    if (allowedPort === undefined) blocked(`${detail} before the owned server port is known`)
    if (allowedPort !== port) blocked(`${detail} to non-owned loopback port ${String(port)}`)
  }

  restores.push(replaceProperty(globalThis, 'fetch', (...args: unknown[]) => {
    admit('fetch', targetOf(args[0]))
    return Reflect.apply(originalFetch, globalThis, args)
  }))
  restores.push(replaceProperty(http, 'request', (...args: unknown[]) => {
    admit('http request', targetOf(args[0], args[1]))
    return Reflect.apply(originalHttpRequest, http, args)
  }))
  restores.push(replaceProperty(https, 'request', (...args: unknown[]) => {
    admit('https request', targetOf(args[0], args[1]))
    return Reflect.apply(originalHttpsRequest, https, args)
  }))
  restores.push(replaceProperty(net.Socket.prototype, 'connect', function patchedConnect(this: net.Socket, ...args: unknown[]) {
    const normalized = normalizedArgs(args)
    admit('net connect', targetOf(normalized[0], normalized[1]))
    return Reflect.apply(originalNetConnect, this, args)
  }))
  restores.push(replaceProperty(tls, 'connect', (...args: unknown[]) => {
    const normalized = normalizedArgs(args)
    admit('tls connect', targetOf(normalized[0], normalized[1]))
    return Reflect.apply(originalTlsConnect, tls, args)
  }))
  restores.push(replaceProperty(net.Server.prototype, 'listen', function patchedListen(this: net.Server, ...args: unknown[]) {
    const first = args[0]
    const requestedValue = typeof first === 'number'
      ? first
      : first !== null && typeof first === 'object'
        ? propertyOf(first, 'port')
        : undefined
    const requested = typeof requestedValue === 'number' ? requestedValue : undefined
    if (ownedServer !== undefined) {
      listenViolation = 'a second server.bind was attempted'
      throw new Error('keyless inventory network guard: only one owned server may bind')
    }
    if (requested !== 0) {
      listenViolation = `server.bind(${String(requested)}) is not the owned ephemeral port 0`
      throw new Error(`keyless inventory network guard: ${listenViolation}`)
    }
    const server = this
    ownedServer = server
    // Register BEFORE calling listen; EventEmitter runs this listener before
    // any scaffold callback, so the port is sealed before the login fetch.
    server.once('listening', () => {
      const address = server.address()
      if (address === null || typeof address === 'string' || !Number.isInteger(address.port) || address.port <= 0) {
        listenViolation = 'owned server did not report an ephemeral TCP port'
        return
      }
      boundPort = address.port
      allowedPort = address.port
    })
    return Reflect.apply(originalListen, this, args)
  }))

  process.stderr.write(`[inventory-keyless] network guard active (fetch/http/https/net/tls; loopback rejected until the single owned port 0 server binds; root=${root})\n`)
  return {
    diagnostics: () => ({ attempts: blockedAttempts, details: [...blockedDetails] }),
    restore: () => {
      for (const restore of restores.reverse()) restore()
    },
    seal: (port: number) => {
      if (listenViolation !== undefined) fail(`owned server contract violated: ${listenViolation}`)
      if (boundPort === undefined) fail('owned server never bound an ephemeral port')
      if (boundPort !== port) fail(`owned server bound ${String(boundPort)}, scaffold reported ${String(port)}`)
      allowedPort = port
    },
  }
}

interface WriteCapture {
  restore(): void
}

/**
 * Capture BOTH stdout and stderr through one shared sink while forwarding the
 * exact original arguments to each stream. This preserves encoding/callback
 * forms and the backpressure return value; the callback is never invoked here,
 * so there is no double-callback path. Restoration uses the original
 * property descriptors and stays idempotent.
 */
function captureProcessWrites(sink: (text: string) => void): WriteCapture {
  const streams: NodeJS.WriteStream[] = [process.stdout, process.stderr]
  const originals: Array<typeof process.stdout.write> = streams.map(stream => stream.write)
  const restores: Array<() => void> = []
  let restored = false
  for (const [index, stream] of streams.entries()) {
    const original = originals[index]
    if (original === undefined) continue
    restores.push(replaceProperty(stream, 'write', (...args: unknown[]) => {
      const chunk = args[0]
      let text = ''
      try {
        if (typeof chunk === 'string') text = chunk
        else if (chunk instanceof Uint8Array) text = Buffer.from(chunk).toString('utf8')
      } catch {
        text = ''
      }
      if (text !== '') sink(text)
      return Reflect.apply(original, stream, args)
    }))
  }
  return {
    restore: () => {
      if (restored) return
      restored = true
      for (const restore of restores.reverse()) restore()
    },
  }
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: unknown } }
}

/** Copy a package's runtime files without its node_modules/tests. */
function copyPackage(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    filter: (path) => {
      const parts = path.split(sep)
      return !parts.includes('node_modules') && !parts.includes('tests') && !parts.includes('.git')
    },
  })
}

/** Repo profile package directories keyed by package name. */
function localPackageDirs(): Map<string, string> {
  const packages = join(PROFILE_DIR, 'packages')
  const out = new Map<string, string>()
  for (const entry of readdirSync(packages)) {
    const dir = join(packages, entry)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
    if (typeof pkg.name === 'string') out.set(pkg.name, dir)
  }
  return out
}

/** Resolve one profile dependency to its installed source directory. */
function dependencySource(name: string): string {
  const local = localPackageDirs().get(name)
  if (local !== undefined) return local
  return realpathSync(join(PROFILE_DIR, 'node_modules', name))
}

/** Build the isolated profile: copied bundles + a temp resolver to repo builds/3P deps. */
function buildIsolatedProfile(root: string, profileDir: string): {
  profileRoot: string
  packages: Array<{ dir: string; enabled: boolean }>
  overlayPath: string
} {
  const manifest = JSON.parse(readFileSync(PROFILE_PACKAGE, 'utf8')) as ProfileManifest
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) fail('profile bundle list malformed')
  const bundleSet = new Set(bundles as string[])
  const profileRoot = join(root, 'profile')
  mkdirSync(join(profileRoot, 'node_modules'), { recursive: true })
  for (const file of ['package.json', 'compatibility.json']) copyFileSync(join(PROFILE_DIR, file), join(profileRoot, file))
  // The scaffold's own profile root needs the same shipped exemption file.
  mkdirSync(profileDir, { recursive: true })
  copyFileSync(COMPATIBILITY_FILE, join(profileDir, 'compatibility.json'))

  // Split the profile patch: the settings-owned row must be a profile/anchor
  // layer (writable), every other row stays in the test overlay.
  const patchText = readFileSync(PROFILE_PATCH, 'utf8')
  const rowMarker = '- id: enpoi-orchestration\n'
  const rowStart = patchText.indexOf(rowMarker)
  if (rowStart < 0) fail('profile patch has no enpoi-orchestration settings row')
  const rowEnd = patchText.indexOf('\n- ', rowStart + rowMarker.length)
  if (rowEnd < 0) fail('profile patch has no row after enpoi-orchestration')
  // The settings row is the scaffold profile's OWN patch, so a legitimate
  // settings write is not rejected as overlay-overridden. The anchor package
  // only supplies resolution and carries an empty patch.
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patchText.slice(rowStart, rowEnd + 1))
  writeFileSync(join(profileRoot, 'cordis.patch.yml'), '[]\n')
  const overlayPath = join(root, 'profile-overlay.yml')
  writeFileSync(overlayPath, `${patchText.slice(0, rowStart)}${patchText.slice(rowEnd + 1)}`)

  const packages: Array<{ dir: string; enabled: boolean }> = []
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const src = dependencySource(name)
    const dest = join(profileRoot, 'node_modules', name)
    mkdirSync(dirname(dest), { recursive: true })
    copyPackage(src, dest)
    packages.push({ dir: dest, enabled: bundleSet.has(name) })
  }

  // Temp resolver: every repo workspace/vendor package under @deepseek-ai/*,
  // so copied profile bundles resolve the repo build, never the live harness.
  const linked = new Set<string>()
  const linkRepoPackage = (sourceDir: string): void => {
    const pkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as { name?: unknown }
    if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@deepseek-ai/') || linked.has(pkg.name)) return
    const dest = join(profileRoot, 'node_modules', pkg.name)
    if (existsSync(dest)) return
    mkdirSync(dirname(dest), { recursive: true })
    symlinkSync(sourceDir, dest, 'junction')
    linked.add(pkg.name)
  }
  for (const group of readdirSync(join(REPO_ROOT, 'packages'))) {
    const groupDir = join(REPO_ROOT, 'packages', group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const child of readdirSync(groupDir)) {
      const dir = join(groupDir, child)
      if (!existsSync(join(dir, 'package.json'))) continue
      linkRepoPackage(dir)
    }
  }
  for (const vendor of readdirSync(join(REPO_ROOT, 'vendor'))) {
    const dir = join(REPO_ROOT, 'vendor', vendor)
    if (existsSync(join(dir, 'package.json'))) linkRepoPackage(dir)
  }

  // Third-party transitive deps stay read-only links from the profile install.
  const thirdParty = join(PROFILE_DIR, 'node_modules')
  for (const entry of readdirSync(thirdParty)) {
    if (entry === '@deepseek-ai' || entry === '.bin' || entry === '.pnpm' || entry.startsWith('.')) continue
    const source = join(thirdParty, entry)
    if (entry.startsWith('@')) {
      for (const child of readdirSync(source)) {
        const name = `${entry}/${child}`
        const dest = join(profileRoot, 'node_modules', name)
        if (!existsSync(dest)) {
          mkdirSync(dirname(dest), { recursive: true })
          symlinkSync(join(source, child), dest, 'junction')
        }
      }
      continue
    }
    const dest = join(profileRoot, 'node_modules', entry)
    if (!existsSync(dest)) symlinkSync(source, dest, 'junction')
  }

  // Fail LOUD before any session if a copied profile plugin's @deepseek-ai peer
  // still resolves into the live install instead of the repo build.
  const repoPrefix = `${resolve(REPO_ROOT)}${sep}`
  const localNames = new Set(localPackageDirs().keys())
  for (const entry of packages) {
    const pkg = JSON.parse(readFileSync(join(entry.dir, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    // Verify loaded profile plugins only: enabled bundles and the local
    // preset-row packages. Client-only transitive deps are not plugin roots.
    if (!entry.enabled && (pkg.name === undefined || !localNames.has(pkg.name))) continue
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies }
    const requireFrom = createRequire(join(entry.dir, 'package.json'))
    for (const name of Object.keys(deps).filter(name => name.startsWith('@deepseek-ai/'))) {
      let resolved: string
      try {
        resolved = resolve(requireFrom.resolve(name))
      } catch (error) {
        fail(`${pkg.name ?? entry.dir} ${name} does not resolve in the isolated profile: ${String(error)}`)
      }
      if (!resolved.startsWith(repoPrefix)) {
        fail(`${pkg.name ?? entry.dir} ${name} resolves outside the repo build (${resolved}); run the central build and retry`)
      }
    }
  }
  return { profileRoot, packages, overlayPath }
}

/** Cross-check the runtime's per-session wire capture. */
async function wireTools(llm: typeof import('@deepseek-ai/dsh-llm'), root: string, sessionId: string): Promise<string[]> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const capture = await llm.readSessionWireCapture(sessionId, { root })
    if (capture !== undefined) return [...capture.summary.tools]
    if (Date.now() > deadline) throw new Error(`no wire capture for ${sessionId} within 5s`)
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
}

async function main(): Promise<void> {
  const { root, home } = assertOwnedEnvironment()
  // Re-verify the build readiness in the child, read-only, BEFORE the harness
  // import. This is the same gate the parent used; a direct/standalone driver
  // invocation fails here without a profile fingerprint/opt-in contract.
  const { captureReadiness } = await import('../../apps/web/tests/keyless-tool-inventory-bootstrap.ts')
  const readiness = await captureReadiness()
  if (!readiness.ready) fail(`build readiness recheck failed: ${readiness.blockers.join('; ')}`)

  if (process.env.DSH_KEYLESS_INVENTORY_WORKER === '1') {
    const { captureWorker } = await import('./worker-capture.mts')
    const capture = await captureWorker(true)
    const failures = capture.rows.filter(row => [0, 1, 2, 4, 14].includes(row.step) && row.status !== 'pass')
    if (failures.length > 0) fail(`worker capture did not pass: ${JSON.stringify(failures)}`)
    const paths = [
      'profile/web/packages/enpoi-jarvis-worker/cordis.patch.yml',
      'profile/web/packages/enpoi-jarvis-worker/knowledge-tools.json',
      'profile/web/packages/enpoi-jarvis-worker/restrict.mjs',
      'profile/web/packages/enpoi-jarvis-worker/lib/index.js',
      'profile/web/packages/enpoi-worker-credentials/lib/index.js',
      'profile/web/packages/enpoi-job-guard/lib/index.js',
      'packages/api/peer/lib/index.js', 'packages/mcp/mcp-client/lib/index.js',
    ]
    const receipt = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(REPO_ROOT, path))).digest('hex')]))
    writeFileSync(join(root, 'worker-result.json'), JSON.stringify({ ...capture, receipt }, null, 2))
    return
  }
  if (process.env.DSH_WIRE_LOG === undefined) fail('human inventory requires the owned wire file')
  const guard = installNetworkGuard(root)
  let scaffold: Awaited<ReturnType<typeof import('../../apps/web/tests/scaffold.ts').launchWebScaffold>> | undefined
  // Partial composition is never accepted: any auto-disabled profile row
  // fails, and every absolute plugin-log path must stay under the owned root.
  // BOTH stdout and stderr are captured for the whole run; checks re-run at
  // each boundary and once more during shutdown.
  const disabledRows: string[] = []
  const escapedPaths = new Set<string>()
  // Absolute plugin-log paths may name read-only repo sources (the project
  // root is under the real HOME). Only the owned temp root and the repo are
  // allowed; any live ~/.dsh/credential/cache path still fails closed.
  const allowedReadRoots = [root, resolve(REPO_ROOT)]
  let writeCarry = ''
  const writeCapture = captureProcessWrites((text) => {
    const combined = `${writeCarry}${text}`
    writeCarry = combined.slice(-512)
    for (const match of combined.matchAll(/disabling profile plugin row "([^"]+)"/gu)) disabledRows.push(match[1]!)
    for (const pathMatch of combined.matchAll(/(?:store|home|state|root)=([^\s,;)]+)/gu)) {
      const path = pathMatch[1]
      if (path !== undefined && path.startsWith('/') && !allowedReadRoots.some(base => pathWithin(path, base))) escapedPaths.add(path)
    }
  })
  const assertClean = (stage: string): void => {
    if (disabledRows.length > 0) fail(`${stage}: partial composition, profile row(s) disabled: ${[...new Set(disabledRows)].join(', ')}`)
    if (escapedPaths.size > 0) fail(`${stage}: plugin log path(s) escaped the owned root: ${[...escapedPaths].join(', ')}`)
  }
  try {
    // Dynamic import only after HOME/DSH_* are proven owned: module-level
    // homedir() captures in profile plugins must see the fake home.
    const llm = await import('@deepseek-ai/dsh-llm')
    const { launchWebScaffold } = await import('../../apps/web/tests/scaffold.ts')
    const { profileRoot, packages, overlayPath } = buildIsolatedProfile(root, join(home, 'profiles', 'scaffold'))

    class CaptureAdapter extends llm.LlmAdapter {
      readonly mainTools = new Map<string, string[]>()
      readonly requestCount = new Map<string, number>()

      override async listModels(provider: string) { return [{ provider, id: MODEL, name: MODEL, contextWindow: 128_000 }] }

      override resolveModel(provider: string, model: string): Promise<import('@deepseek-ai/dsh-llm').LlmResolvedModelInfo> {
        return Promise.resolve({ provider, id: model, name: model, contextWindow: 128_000, tools: true })
      }

      override async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
        if (options.provider !== PROVIDER || options.model !== MODEL) {
          fail(`unexpected model route ${options.provider}/${options.model}; only the fake adapter may answer`)
        }
        const sessionId = options.sessionId ?? ''
        this.requestCount.set(sessionId, (this.requestCount.get(sessionId) ?? 0) + 1)
        if (options.purpose === undefined && options.sessionId !== undefined) {
          this.mainTools.set(options.sessionId, (options.tools ?? []).map(tool => tool.name))
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'OK' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
        yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }

    scaffold = await launchWebScaffold({
      harnessHome: home,
      extraOverlayPath: overlayPath,
      extraInstallAnchors: [join(profileRoot, 'package.json')],
      profile: { packages },
    })
    const ctx = scaffold.ctx
    const ownedPort = new URL(scaffold.baseUrl).port
    if (ownedPort === '') fail('scaffold baseUrl has no owned port')
    guard.seal(Number(ownedPort))
    assertClean('boot')
    if (!existsSync(process.env.DSH_MEMORY_DB!)) fail('memory DB was not created under the owned temp home')
    for (const owned of [process.env.DSH_MEMORY_DB!, process.env.DSH_WIRE_LOG!, join(home, '.dsh', 'logs')]) {
      if (!pathWithin(owned, root)) fail(`runtime path escaped the owned root: ${owned}`)
    }

    const adapter = new CaptureAdapter()
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'keyless inventory fake adapter')

    const remote = async <T,>(endpoint: string, args: Record<string, unknown>): Promise<T> => {
      const response = await scaffold!.hostFetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `${endpoint}-${String(Date.now())}`, method: endpoint, payload: { args } }),
      })
      if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}: ${await response.text()}`)
      const result = (await response.json() as { result: RpcResult<T> }).result
      if (!result.ok) throw new Error(`${endpoint}: ${result.error.code}: ${result.error.message}`)
      return result.value
    }

    const creatorTrio = ['cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager']
    const captured: Record<string, string[]> = {}
    const presetsSeen = new Set<string>()
    for (const preset of PRESETS) {
      const created = await remote<{ sessionId: string }>('session/create', {
        request: { cwd: scaffold.workspaceCwd, agentPreset: preset },
      })
      assertClean(`session/create ${preset}`)
      const sessionId = created.sessionId
      const selected = await remote<{ selected: { provider: string; model: string } }>('session/selectModel', {
        request: { sessionId, provider: PROVIDER, model: MODEL },
      })
      if (selected.selected.provider !== PROVIDER || selected.selected.model !== MODEL) {
        fail(`session ${sessionId} selected ${selected.selected.provider}/${selected.selected.model}, not the fake route`)
      }
      const agent = ctx.agents.get(sessionId as never)
      const actualPreset = agent?.session.header.agentPreset
      if (actualPreset !== preset) fail(`session ${sessionId} preset is ${String(actualPreset)}, expected ${preset}`)
      presetsSeen.add(actualPreset)

      const settled = scaffold.whenTurnSettled()
      await remote('session/prompt', {
        request: {
          requestId: `inventory-${preset}-${String(Date.now())}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: 'Reply with exactly OK. Do not call any tool.' }],
        },
      })
      if (await settled !== sessionId) fail(`${preset}: another session settled first`)
      assertClean(`turn/settle ${preset}`)
      const tools = adapter.mainTools.get(sessionId)
      if (tools === undefined) fail(`${preset}: no main agent request reached the fake adapter`)
      const wire = await wireTools(llm, dirname(process.env.DSH_WIRE_LOG!), sessionId)
      if (JSON.stringify(wire) !== JSON.stringify(tools)) fail(`${preset}: adapter tools differ from the runtime wire capture`)
      if (adapter.requestCount.get(sessionId) === undefined || adapter.requestCount.get(sessionId)! < 1) {
        fail(`${preset}: fake adapter saw no request`)
      }
      captured[preset] = [...tools].sort()
      for (const required of REQUIRED_TOOLS) {
        if (!captured[preset]!.includes(required)) fail(`${preset}: required shipped tool ${required} is missing (partial composition)`)
      }
      const trio = creatorTrio.filter(name => captured[preset]!.includes(name))
      if (preset === 'creator' && trio.length !== creatorTrio.length) {
        fail(`creator: missing harness-authoring tool(s) ${creatorTrio.filter(name => !trio.includes(name)).join(', ')}`)
      }
      if (preset !== 'creator' && trio.length > 0) {
        fail(`${preset}: creator trio leaked into a non-creator seat (${trio.join(', ')})`)
      }
      if (captured[preset]!.includes('peer_sessions')) fail(`${preset}: peer_sessions must stay in the detached peer group`)
    }
    if (presetsSeen.size !== PRESETS.length) fail('the three canonical presets did not resolve to distinct sessions')
    assertClean('final')

    const { buildArtifactReceipt } = await import('./artifact-receipt.mjs')
    const receipt = await buildArtifactReceipt(REPO_ROOT)
    if (Object.keys(receipt.profileFingerprints).length === 0) fail('receipt has no profile source fingerprints')
    for (const [name, entry] of Object.entries(receipt.externalBundles)) {
      if (entry.missing === true || entry.version === null || entry.packageJson === null || entry.entry === null) {
        fail(`external profile package ${name} has no tracked version/artifact in the receipt`)
      }
    }
    if (readiness.clientBuild === undefined) fail('client build record unavailable after readiness check')
    writeFileSync(join(root, 'result.json'), JSON.stringify({
      captured,
      receipt,
      clientBuild: { artifacts: readiness.clientBuild.artifacts, environment: readiness.clientBuild.environment },
      diagnostics: {
        sessionIds: Object.keys(captured),
        fakeRequests: Object.fromEntries(adapter.requestCount),
        mainRequests: Object.fromEntries([...adapter.mainTools.keys()].map(id => [id, 1])),
        network: guard.diagnostics(),
      },
    }, null, 2))
  } finally {
    await scaffold?.close().catch(() => undefined)
    // Catch late async writes raised during shutdown before claiming a clean
    // capture, then restore the exact original stream writes.
    try { assertClean('shutdown') } catch (error) { process.stderr.write(`[inventory-keyless] ${String(error)}\n`); process.exitCode = 1 }
    writeCapture.restore()
    guard.restore()
  }
}

export { main as runCapture }

// Direct standalone invocation still fails closed at the ownership gate; the
// authorized path runs this module as a Vitest test file so the existing
// scaffold (which imports vitest) keeps its real test context.
const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`[inventory-keyless] FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
