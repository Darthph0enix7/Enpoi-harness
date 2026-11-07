/**
 * Receipt-owned CLIProxyAPI installer: ownership, seeding, service rendering,
 * refusals, rollback, removal, and secret-free output. Every downloader,
 * port probe, service command, and health fetch is injected; no real
 * systemctl/launchctl/network runs in this suite.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultServiceRunner,
  installCliProxyApi,
  parseCliProxyArgs,
  preflightCliProxyApi,
  readOwnedInferenceCredential,
  removeCliProxyApi,
  resolveCliProxyLayout,
  runCliProxyInstaller,
  statusCliProxyApi,
} from '../scripts/cliproxyapi-install.mjs'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function mkScratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cliproxy-install-'))
  scratch.push(dir)
  return dir
}

function environment(platform = 'linux') {
  const base = mkScratch()
  const userHome = join(base, platform === 'darwin' ? 'home & space' : 'home space')
  mkdirSync(userHome, { recursive: true })
  return {
    base,
    userHome,
    dshHome: join(base, platform === 'darwin' ? 'dsh & home' : 'dsh home'),
    platform,
  }
}

function downloader(tag = 'v1') {
  const calls: Array<{
    destination: string
    version?: string
    requiredMajor?: number
    repo?: string
    releasesApi?: string
  }> = []
  const run = async (options: {
    destination: string
    version?: string
    requiredMajor?: number
    repo?: string
    releasesApi?: string
  }) => {
    calls.push({
      destination: options.destination,
      version: options.version,
      requiredMajor: options.requiredMajor,
      repo: options.repo,
      releasesApi: options.releasesApi,
    })
    mkdirSync(dirname(options.destination), { recursive: true })
    writeFileSync(options.destination, `#!/bin/sh\n# ${tag}\n`, { mode: 0o755 })
    return {
      destination: options.destination,
      version: options.version ?? '8.0.55',
      checksum: 'a'.repeat(64),
      bytes: tag.length,
    }
  }
  run.calls = calls
  return run
}

function panelDownloader(tag = 'v1', panel = '<html>panel</html>') {
  const base = downloader(tag)
  const run = async (options: {
    destination: string
    version?: string
    requiredMajor?: number
    repo?: string
    releasesApi?: string
  }) => {
    const result = await base(options)
    const panelPath = join(dirname(options.destination), 'static', 'management.html')
    mkdirSync(dirname(panelPath), { recursive: true })
    writeFileSync(panelPath, panel, { mode: 0o644 })
    return { ...result, dashboardPanel: 'installed' }
  }
  run.calls = base.calls
  return run
}

function runner(options: { failOn?: (line: string) => boolean; active?: boolean } = {}) {
  const calls: string[][] = []
  let active = options.active ?? true
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args])
    const line = [command, ...args].join(' ')
    if (args.includes('is-active')) return active
      ? { code: 0, stdout: 'active\n', stderr: '' }
      : { code: 3, stdout: 'inactive\n', stderr: '' }
    if (args.includes('print')) return { code: 0, stdout: 'state = running\npid = 123\n', stderr: '' }
    if (options.failOn?.(line)) {
      if (args.includes('restart')) active = false
      return { code: 1, stdout: '', stderr: 'forced' }
    }
    if (args.includes('daemon-reload') || args.includes('enable')) {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args.includes('disable') || args.includes('stop') || args.includes('bootout')) active = false
    if (args.includes('restart') || args.includes('start') || args.includes('kickstart')
      || args.includes('bootstrap')) active = true
    return { code: 0, stdout: '', stderr: '' }
  }
  run.calls = calls
  return run
}

function health(calls: string[] = [], body: unknown = { status: 'ok' }) {
  return async (url: string) => {
    calls.push(url)
    return { status: 200, json: async () => body }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function writeJournal(
  layout: ReturnType<typeof resolveCliProxyLayout>,
  values: {
    installId: string
    ownerTokenSha256: string
    binarySha256: string
    unitSha256: string
    previousBinarySha256?: string
    previousUnitSha256?: string
    dashboardPanelSha256?: string
    previousDashboardPanelSha256?: string
  },
): string {
  const journal = {
    version: 1,
    installId: values.installId,
    ownerTokenSha256: values.ownerTokenSha256,
    binarySha256: values.binarySha256,
    unitSha256: values.unitSha256,
    ...(values.previousBinarySha256 === undefined ? {} : { previousBinarySha256: values.previousBinarySha256 }),
    ...(values.previousUnitSha256 === undefined ? {} : { previousUnitSha256: values.previousUnitSha256 }),
    ...(values.dashboardPanelSha256 === undefined ? {} : { dashboardPanelSha256: values.dashboardPanelSha256 }),
    ...(values.previousDashboardPanelSha256 === undefined ? {} : { previousDashboardPanelSha256: values.previousDashboardPanelSha256 }),
    root: layout.root,
    binaryPath: layout.binaryPath,
    configPath: layout.configPath,
    authDir: layout.authDir,
    bootstrapPath: layout.bootstrapPath,
    unitPath: layout.unitPath,
    serviceLabel: layout.serviceLabel,
    serviceKind: layout.serviceKind,
    createdAt: new Date(0).toISOString(),
  }
  const text = `${JSON.stringify(journal, null, 2)}\n`
  writeFileSync(layout.journalPath, text, { mode: 0o600 })
  return text
}

function optionsFor(env: ReturnType<typeof environment>, overrides: Record<string, unknown> = {}) {
  return {
    dshHome: env.dshHome,
    userHome: env.userHome,
    platform: env.platform,
    arch: 'x64',
    port: 8317,
    downloadRelease: downloader(),
    probePort: async () => false,
    serviceRunner: runner(),
    fetch: health(),
    healthAttempts: 1,
    healthIntervalMs: 0,
    verifyListener: async () => true,
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    ...overrides,
  }
}

function layoutFor(env: ReturnType<typeof environment>) {
  return resolveCliProxyLayout({ dshHome: env.dshHome, userHome: env.userHome, platform: env.platform })
}

function configKeys(text: string) {
  return {
    management: /secret-key:\s*(\S+)/u.exec(text)?.[1],
    inference: /api-keys:\s*\n\s*-\s*(\S+)/u.exec(text)?.[1],
  }
}

describe('install', () => {
  it('writes a receipt-owned Linux layout, unique unit, and secret-free output', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const foreignUnit = join(env.userHome, '.config', 'systemd', 'user', 'cliproxyapi.service')
    mkdirSync(dirname(foreignUnit), { recursive: true })
    writeFileSync(foreignUnit, 'foreign existing unit\n')
    const download = downloader()
    const service = runner()
    const fetchCalls: string[] = []
    const result = await installCliProxyApi(optionsFor(env, {
      downloadRelease: download,
      serviceRunner: service,
      fetch: health(fetchCalls),
    }))

    expect(result.ok).toBe(true)
    expect(result.service).toEqual({
      label: 'dsh-cliproxyapi',
      kind: 'systemd-user',
      unitPath: layout.unitPath,
    })
    expect(result.dashboardUrl).toBe('http://127.0.0.1:8317/management.html')
    expect(result.bootstrapPath).toBe(layout.bootstrapPath)
    expect(result.managementKeyPath).toBe(layout.bootstrapPath)
    expect(download.calls[0]?.requiredMajor).toBe(8)
    expect(result.dashboardUrl).not.toMatch(/secret|key=/u)
    expect(result.dashboardPanel).toBe('embedded-or-absent')
    expect(result.credentialsPresent).toBe(true)
    expect(result.portMismatch).toBe(false)
    expect(fetchCalls).toEqual(['http://127.0.0.1:8317/healthz'])
    expect(statSync(layout.root).mode & 0o777).toBe(0o700)
    expect(statSync(layout.binDir).mode & 0o777).toBe(0o700)
    expect(statSync(layout.authDir).mode & 0o777).toBe(0o700)
    expect(statSync(layout.configPath).mode & 0o777).toBe(0o600)
    expect(statSync(layout.bootstrapPath).mode & 0o777).toBe(0o600)
    expect(statSync(layout.receiptPath).mode & 0o777).toBe(0o600)
    expect(statSync(layout.binaryPath).mode & 0o777).toBe(0o700)

    const config = readFileSync(layout.configPath, 'utf8')
    expect(config).toContain('config-version: 8\n')
    expect(config).toContain('server:\n  host: 127.0.0.1\n  port: 8317\n')
    expect(config).toContain('management:\n  allow-remote: false\n')
    expect(config).toContain('  disable-control-panel: false\n')
    expect(config).toContain('oauth:\n  auth-dir: ')
    expect(config).toContain('routing:\n  strategy: fill-first\n  session-affinity: true\n  session-affinity-subagents: true\n  session-affinity-ttl: 1h\n  session-affinity-rebind-on: quota\n')
    expect(config).not.toMatch(/^\s+ttl:/mu)
    expect(config).not.toMatch(/^\s+rebind-on:/mu)
    const keys = configKeys(config)
    expect(keys.management).toMatch(/^[a-f0-9]{64}$/u)
    expect(keys.inference).toMatch(/^[a-f0-9]{64}$/u)
    expect(keys.management).not.toBe(keys.inference)

    const bootstrap = JSON.parse(readFileSync(layout.bootstrapPath, 'utf8'))
    expect(bootstrap.managementSecretKey).toBe(keys.management)
    expect(bootstrap.inferenceKey).toBe(keys.inference)
    expect(bootstrap.ownerToken).toMatch(/^[a-f0-9]{64}$/u)
    expect(bootstrap.installId).toBe(result.installId)
    expect(await readOwnedInferenceCredential(env.dshHome, {
      platform: env.platform,
      userHome: env.userHome,
    })).toBe(keys.inference)

    const receipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    expect(receipt.version).toBe(1)
    expect(receipt.installId).toBe(result.installId)
    expect(receipt.root).toBe(layout.root)
    expect(receipt.binaryPath).toBe(layout.binaryPath)
    expect(receipt.unitPath).toBe(layout.unitPath)
    expect(receipt.serviceLabel).toBe('dsh-cliproxyapi')
    expect(receipt.serviceKind).toBe('systemd-user')
    expect(receipt.cliProxyVersion).toBe('8.0.55')
    expect(receipt.ownerTokenSha256).toBe(sha256(bootstrap.ownerToken))
    for (const field of ['binarySha256', 'unitSha256', 'ownerTokenSha256']) {
      expect(receipt[field]).toMatch(/^[a-f0-9]{64}$/u)
    }
    expect(receipt).not.toHaveProperty('configSha256')
    expect(receipt).not.toHaveProperty('bootstrapSha256')
    expect(existsSync(layout.journalPath)).toBe(false)

    const unit = readFileSync(layout.unitPath, 'utf8')
    expect(unit).toContain(`ExecStart=${JSON.stringify(layout.binaryPath)} --config ${JSON.stringify(layout.configPath)}`)
    expect(unit).toContain(`WorkingDirectory=${layout.root.replaceAll('\\', '\\\\').replaceAll(' ', '\\x20').replaceAll('%', '%%')}`)
    expect(service.calls).toContainEqual(['systemctl', '--user', 'daemon-reload'])
    expect(service.calls).toContainEqual(['systemctl', '--user', 'enable', 'dsh-cliproxyapi.service'])
    expect(service.calls).toContainEqual(['systemctl', '--user', 'restart', 'dsh-cliproxyapi.service'])
    expect(service.calls.flat()).not.toContain('cliproxyapi.service')
    expect(readFileSync(foreignUnit, 'utf8')).toBe('foreign existing unit\n')

    const output = JSON.stringify(result)
    expect(output).not.toContain(keys.management!)
    expect(output).not.toContain(keys.inference!)
    const status = await statusCliProxyApi(optionsFor(env, { serviceRunner: service }))
    expect(status.installed).toBe(true)
    expect(status.binaryMatches).toBe(true)
    expect(status.unitMatches).toBe(true)
    expect(status.dashboardUrl).toBe('http://127.0.0.1:8317/management.html')
    expect(status.bootstrapPath).toBe(layout.bootstrapPath)
    expect(status.managementKeyPath).toBe(layout.bootstrapPath)
    expect(JSON.stringify(status)).not.toContain(keys.inference!)
  })

  it('renders a launchd agent with XML escaping and darwin service commands', async () => {
    const env = environment('darwin')
    const dshHome = join(env.base, 'dsh & $home %conf')
    const layout = resolveCliProxyLayout({ dshHome, userHome: env.userHome, platform: 'darwin' })
    const service = runner()
    const result = await installCliProxyApi(optionsFor(env, {
      dshHome,
      serviceRunner: service,
    }))

    expect(result.service).toEqual({
      label: 'dev.enpoi.cliproxyapi',
      kind: 'launchd-agent',
      unitPath: layout.unitPath,
    })
    expect(layout.unitPath).toContain('Library/LaunchAgents/dev.enpoi.cliproxyapi.plist')
    const plist = readFileSync(layout.unitPath, 'utf8')
    expect(plist).toContain('<string>dev.enpoi.cliproxyapi</string>')
    expect(plist).toContain('dsh &amp; $home %conf')
    expect(plist).not.toContain('dsh & $home %conf')
    expect(plist).toContain(`<string>${layout.binaryPath.replaceAll('&', '&amp;')}</string>`)
    expect(plist).toContain('<key>StandardOutPath</key>')
    expect(plist).toContain(`<string>${layout.stdoutLogPath.replaceAll('&', '&amp;')}</string>`)
    expect(plist).toContain('<key>StandardErrorPath</key>')
    expect(plist).toContain(`<string>${layout.stderrLogPath.replaceAll('&', '&amp;')}</string>`)
    expect(statSync(layout.stdoutLogPath).mode & 0o777).toBe(0o600)
    expect(statSync(layout.stderrLogPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(layout.stdoutLogPath, 'utf8')).toBe('')
    expect(readFileSync(layout.stderrLogPath, 'utf8')).toBe('')
    expect(service.calls[0]).toEqual(['launchctl', 'bootout', `gui/${process.getuid?.() ?? 501}/dev.enpoi.cliproxyapi`])
    expect(service.calls).toContainEqual(['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, layout.unitPath])
    expect(service.calls).toContainEqual(['launchctl', 'kickstart', '-k', `gui/${process.getuid?.() ?? 501}/dev.enpoi.cliproxyapi`])
    expect(JSON.parse(readFileSync(layout.receiptPath, 'utf8')).serviceKind).toBe('launchd-agent')
  })

  it('refuses unsupported platforms and occupied ports before any mutation', async () => {
    const unsupported = environment('linux')
    const unsupportedDownload = downloader()
    await expect(installCliProxyApi(optionsFor(unsupported, {
      platform: 'win32',
      downloadRelease: unsupportedDownload,
      probePort: async () => { throw new Error('probe must not run') },
    }))).rejects.toMatchObject({ code: 'PLATFORM_UNSUPPORTED' })
    expect(existsSync(join(unsupported.dshHome, 'providers', 'cliproxyapi'))).toBe(false)
    expect(unsupportedDownload.calls).toHaveLength(0)

    const occupied = environment('linux')
    const occupiedDownload = downloader()
    const occupiedService = runner()
    const foreignUnit = join(occupied.userHome, '.config', 'systemd', 'user', 'cliproxyapi.service')
    mkdirSync(dirname(foreignUnit), { recursive: true })
    writeFileSync(foreignUnit, 'foreign runtime\n')
    await expect(installCliProxyApi(optionsFor(occupied, {
      probePort: async () => true,
      downloadRelease: occupiedDownload,
      serviceRunner: occupiedService,
    }))).rejects.toMatchObject({ code: 'PORT_IN_USE' })
    expect(existsSync(join(occupied.dshHome, 'providers', 'cliproxyapi'))).toBe(false)
    expect(occupiedDownload.calls).toHaveLength(0)
    expect(occupiedService.calls).toHaveLength(0)
    expect(readFileSync(foreignUnit, 'utf8')).toBe('foreign runtime\n')
  })

  it('does not follow a symlinked bin sweep directory', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const target = join(env.base, 'foreign-bin-target')
    rmSync(layout.binDir, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'cli-proxy-api'), '#!/bin/sh\n# v1\n', { mode: 0o700 })
    const transient = join(target, `.rollback-binary-${'a'.repeat(24)}`)
    writeFileSync(transient, 'outside the owned root\n')
    symlinkSync(target, layout.binDir)

    const download = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: download,
    }))).rejects.toMatchObject({ code: 'FOREIGN_STATE' })
    expect(download.calls).toHaveLength(0)
    expect(readFileSync(transient, 'utf8')).toBe('outside the owned root\n')
  })

  it('does not sweep a foreign transient-prefix file in a markerless root', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    mkdirSync(layout.root, { recursive: true })
    const foreign = join(layout.root, '.stage-important')
    writeFileSync(foreign, 'must survive\n')
    const download = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: download,
    }))).rejects.toMatchObject({ code: 'FOREIGN_STATE' })
    expect(download.calls).toHaveLength(0)
    expect(readFileSync(foreign, 'utf8')).toBe('must survive\n')
  })

  it('refuses to adopt foreign roots, binaries, or service units', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const download = downloader()
    const service = runner()
    mkdirSync(layout.root, { recursive: true })
    writeFileSync(layout.configPath, 'foreign config\n')
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: download,
      serviceRunner: service,
    }))).rejects.toMatchObject({ code: 'FOREIGN_STATE' })
    expect(readFileSync(layout.configPath, 'utf8')).toBe('foreign config\n')
    expect(download.calls).toHaveLength(0)
    expect(service.calls).toHaveLength(0)

    const unitEnv = environment('linux')
    const unitLayout = layoutFor(unitEnv)
    mkdirSync(dirname(unitLayout.unitPath), { recursive: true })
    writeFileSync(unitLayout.unitPath, 'foreign unit at owned path\n')
    await expect(installCliProxyApi(optionsFor(unitEnv, {
      downloadRelease: download,
      serviceRunner: service,
    }))).rejects.toMatchObject({ code: 'FOREIGN_STATE' })
    expect(readFileSync(unitLayout.unitPath, 'utf8')).toBe('foreign unit at owned path\n')
    expect(download.calls).toHaveLength(0)
    expect(service.calls).toHaveLength(0)
  })
})

describe('upgrade and rollback', () => {
  it('keeps mutable bcrypt/rotated config, bootstrap keys, auth files, and installId stable', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const first = await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const config = readFileSync(layout.configPath, 'utf8')
    const bootstrap = readFileSync(layout.bootstrapPath, 'utf8')
    const firstReceipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    const keys = configKeys(config)
    mkdirSync(layout.authDir, { recursive: true })
    writeFileSync(join(layout.authDir, 'account.json'), '{"secret":"kept"}\n')

    // The real proxy bcrypt-hashes the management secret and the dashboard can
    // rotate the inference key by rewriting config.yaml. Both are legitimate
    // owned-state mutations and must not be treated as foreign or immutable.
    const rotatedKey = 'dashboard-rotated-inference-key'
    const mutatedConfig = config
      .replace(`secret-key: ${keys.management}`, "secret-key: '$2a$10$bcrypt-after-first-launch'")
      .replace(keys.inference!, rotatedKey)
    writeFileSync(layout.configPath, mutatedConfig)
    expect(mutatedConfig).not.toBe(config)

    const second = await installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v2'),
      fetch: health(),
    }))
    expect(second.installId).toBe(first.installId)
    expect(second.version).toBe('8.0.55')
    expect(readFileSync(layout.configPath, 'utf8')).toBe(mutatedConfig)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(bootstrap)
    expect(readFileSync(join(layout.authDir, 'account.json'), 'utf8')).toBe('{"secret":"kept"}\n')
    expect(readFileSync(layout.binaryPath, 'utf8')).toContain('# v2')
    expect(await readOwnedInferenceCredential(env.dshHome, {
      platform: env.platform,
      userHome: env.userHome,
    })).toBe(rotatedKey)
    const secondReceipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    expect(secondReceipt.installId).toBe(first.installId)
    expect(secondReceipt.ownerTokenSha256).toBe(firstReceipt.ownerTokenSha256)
    expect(secondReceipt).not.toHaveProperty('configSha256')
    expect(existsSync(layout.journalPath)).toBe(false)
  })

  it('refuses a modified unit before downloading or overwriting', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    writeFileSync(layout.unitPath, `${readFileSync(layout.unitPath, 'utf8')}# foreign edit\n`)
    const modified = readFileSync(layout.unitPath, 'utf8')
    const oldBinary = readFileSync(layout.binaryPath, 'utf8')
    const nextDownload = downloader('v2')
    const service = runner()
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: nextDownload,
      serviceRunner: service,
    }))).rejects.toMatchObject({ code: 'UNIT_MODIFIED' })
    expect(nextDownload.calls).toHaveLength(0)
    expect(service.calls).toHaveLength(0)
    expect(readFileSync(layout.unitPath, 'utf8')).toBe(modified)
    expect(readFileSync(layout.binaryPath, 'utf8')).toBe(oldBinary)
  })

  it('rolls back the old binary/unit/config and retains auths after start failure', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const first = await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    mkdirSync(layout.authDir, { recursive: true })
    writeFileSync(join(layout.authDir, 'account.json'), '{"secret":"kept"}\n')
    const before = {
      binary: readFileSync(layout.binaryPath, 'utf8'),
      unit: readFileSync(layout.unitPath, 'utf8'),
      config: readFileSync(layout.configPath, 'utf8'),
      bootstrap: readFileSync(layout.bootstrapPath, 'utf8'),
      receipt: readFileSync(layout.receiptPath, 'utf8'),
    }
    const failing = runner({ failOn: (line) => line.includes(' restart ') })
    const fetchCalls: string[] = []
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v2'),
      serviceRunner: failing,
      fetch: health(fetchCalls),
    }))).rejects.toMatchObject({ code: 'SERVICE_FAILED' })

    expect(readFileSync(layout.binaryPath, 'utf8')).toBe(before.binary)
    expect(readFileSync(layout.unitPath, 'utf8')).toBe(before.unit)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(before.config)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(before.bootstrap)
    expect(readFileSync(layout.receiptPath, 'utf8')).toBe(before.receipt)
    expect(JSON.parse(readFileSync(layout.receiptPath, 'utf8')).installId).toBe(first.installId)
    expect(readFileSync(join(layout.authDir, 'account.json'), 'utf8')).toBe('{"secret":"kept"}\n')
    expect(fetchCalls).toHaveLength(0)
    expect(failing.calls).toContainEqual(['systemctl', '--user', 'stop', 'dsh-cliproxyapi.service'])
    expect(readdirSync(layout.root).filter((name) => name.startsWith('.rollback-'))).toHaveLength(0)
    expect(readdirSync(layout.binDir).filter((name) => name.startsWith('.rollback-') || name.includes('stage'))).toHaveLength(0)
    expect(existsSync(layout.lockPath)).toBe(false)
    expect(existsSync(layout.journalPath)).toBe(false)
  })

  it('restarts the previously active service after a failed upgrade rollback', async () => {
    const env = environment('linux')
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const calls: string[][] = []
    const service = async (command: string, args: string[]) => {
      calls.push([command, ...args])
      if (args.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' }
      if (args.includes('restart')) return { code: 1, stdout: '', stderr: 'restart failed' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v2'),
      serviceRunner: service,
    }))).rejects.toMatchObject({ code: 'SERVICE_FAILED' })
    expect(calls).toContainEqual(['systemctl', '--user', 'start', 'dsh-cliproxyapi.service'])
  })

  it('recovers an interrupted owned install after secret writes without key loss', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const failing = runner({ failOn: (line) => line.includes('daemon-reload') })
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v1'),
      serviceRunner: failing,
    }))).rejects.toMatchObject({ code: 'SERVICE_FAILED' })

    const config = readFileSync(layout.configPath, 'utf8')
    const bootstrap = readFileSync(layout.bootstrapPath, 'utf8')
    const keys = configKeys(config)
    expect(existsSync(layout.receiptPath)).toBe(false)
    expect(existsSync(layout.journalPath)).toBe(true)
    expect(existsSync(layout.configPath)).toBe(true)
    expect(existsSync(layout.bootstrapPath)).toBe(true)
    const incomplete = await statusCliProxyApi(optionsFor(env))
    expect(incomplete.installed).toBe(false)
    expect(incomplete.incomplete).toBe(true)

    const retried = await installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v2'),
      fetch: health(),
    }))
    expect(retried.ok).toBe(true)
    expect(existsSync(layout.receiptPath)).toBe(true)
    expect(existsSync(layout.journalPath)).toBe(false)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(config)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(bootstrap)
    expect(configKeys(readFileSync(layout.configPath, 'utf8'))).toEqual(keys)
    expect(await readOwnedInferenceCredential(env.dshHome, {
      platform: env.platform,
      userHome: env.userHome,
    })).toBe(keys.inference)
  })
  it('blocks an occupied-port upgrade when active-unit evidence lacks process/listener proof', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const oldBinary = readFileSync(layout.binaryPath, 'utf8')
    const calls: string[][] = []
    const active = async (command: string, args: string[]) => {
      calls.push([command, ...args])
      if (args.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    const fetchCalls: string[] = []
    const nextDownload = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      probePort: async () => true,
      downloadRelease: nextDownload,
      serviceRunner: active,
      fetch: health(fetchCalls),
    }))).rejects.toMatchObject({ code: 'OWNED_UPGRADE_BLOCKED' })
    expect(calls).toContainEqual(['systemctl', '--user', 'is-active', 'dsh-cliproxyapi.service'])
    expect(calls.some((call) => call.includes('show'))).toBe(true)
    expect(fetchCalls).toHaveLength(0)
    expect(nextDownload.calls).toHaveLength(0)
    expect(readFileSync(layout.binaryPath, 'utf8')).toBe(oldBinary)
  })

  it('refuses an occupied-port upgrade when the owned service is not active', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const oldBinary = readFileSync(layout.binaryPath, 'utf8')
    const service = runner({ active: false })
    const nextDownload = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      probePort: async () => true,
      downloadRelease: nextDownload,
      serviceRunner: service,
    }))).rejects.toMatchObject({ code: 'PORT_IN_USE' })
    expect(service.calls).toContainEqual(['systemctl', '--user', 'is-active', 'dsh-cliproxyapi.service'])
    expect(nextDownload.calls).toHaveLength(0)
    expect(readFileSync(layout.binaryPath, 'utf8')).toBe(oldBinary)
  })

  it('recovers an interrupted upgrade after only the new binary was published', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const first = await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const receipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    const config = readFileSync(layout.configPath, 'utf8')
    const bootstrap = readFileSync(layout.bootstrapPath, 'utf8')
    mkdirSync(layout.authDir, { recursive: true })
    writeFileSync(join(layout.authDir, 'account.json'), '{"secret":"kept"}\n')
    const v2Binary = '#!/bin/sh\n# v2\n'
    writeFileSync(layout.binaryPath, v2Binary, { mode: 0o700 })
    writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: receipt.ownerTokenSha256,
      binarySha256: sha256(v2Binary),
      unitSha256: receipt.unitSha256,
    })

    const retried = await installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v2'),
      fetch: health(),
    }))
    expect(retried.ok).toBe(true)
    expect(retried.installId).toBe(first.installId)
    expect(existsSync(layout.journalPath)).toBe(false)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(config)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(bootstrap)
    expect(readFileSync(join(layout.authDir, 'account.json'), 'utf8')).toBe('{"secret":"kept"}\n')
    const nextReceipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    expect(nextReceipt.installId).toBe(receipt.installId)
    expect(nextReceipt.binarySha256).toBe(sha256(v2Binary))
    expect(nextReceipt.ownerTokenSha256).toBe(receipt.ownerTokenSha256)
  })

  it('recovers an interrupted upgrade after only the new unit was published', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const receipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    const config = readFileSync(layout.configPath, 'utf8')
    const bootstrap = readFileSync(layout.bootstrapPath, 'utf8')
    const interruptedUnit = `${readFileSync(layout.unitPath, 'utf8')}# interrupted unit\n`
    writeFileSync(layout.unitPath, interruptedUnit)
    const v2Binary = '#!/bin/sh\n# v2\n'
    writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: receipt.ownerTokenSha256,
      binarySha256: sha256(v2Binary),
      unitSha256: sha256(interruptedUnit),
    })

    const retried = await installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v2'),
      fetch: health(),
    }))
    expect(retried.ok).toBe(true)
    expect(existsSync(layout.journalPath)).toBe(false)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(config)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(bootstrap)
    expect(readFileSync(layout.binaryPath, 'utf8')).toBe(v2Binary)
    expect(readFileSync(layout.unitPath, 'utf8')).not.toContain('# interrupted unit')
    expect(JSON.parse(readFileSync(layout.receiptPath, 'utf8')).installId).toBe(receipt.installId)
  })

  it('chains previous hashes to the last published bytes after repeated failed upgrades', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const receipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    const publishedBinary = readFileSync(layout.binaryPath, 'utf8')
    const publishedUnit = readFileSync(layout.unitPath, 'utf8')
    // First upgrade crashed before publishing either half: the journal names
    // targets that never reached disk.
    writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: receipt.ownerTokenSha256,
      binarySha256: sha256('#!/bin/sh\n# crashed-upgrade\n'),
      unitSha256: sha256(`${publishedUnit}# crashed upgrade unit\n`),
      previousBinarySha256: receipt.binarySha256,
      previousUnitSha256: receipt.unitSha256,
    })

    let written: { previousBinarySha256?: string; previousUnitSha256?: string } | undefined
    const calls: string[][] = []
    const service = async (command: string, args: string[]) => {
      calls.push([command, ...args])
      if (args.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' }
      if (args.includes('daemon-reload')) {
        written = JSON.parse(readFileSync(layout.journalPath, 'utf8'))
        return { code: 1, stdout: '', stderr: 'forced daemon-reload failure' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v2'),
      serviceRunner: service,
    }))).rejects.toMatchObject({ code: 'SERVICE_FAILED' })

    // The second attempt must name the bytes a crash would actually find, not
    // the first attempt's never-published target.
    expect(written?.previousBinarySha256).toBe(sha256(publishedBinary))
    expect(written?.previousUnitSha256).toBe(sha256(publishedUnit))
    expect(readFileSync(layout.binaryPath, 'utf8')).toBe(publishedBinary)
    expect(readFileSync(layout.unitPath, 'utf8')).toBe(publishedUnit)
  })

  it('restores the interrupted-upgrade target state when the retry fails', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const oldReceipt = readFileSync(layout.receiptPath, 'utf8')
    const config = readFileSync(layout.configPath, 'utf8')
    const bootstrap = readFileSync(layout.bootstrapPath, 'utf8')
    const receipt = JSON.parse(oldReceipt)
    const v2Binary = '#!/bin/sh\n# v2\n'
    const interruptedUnit = `${readFileSync(layout.unitPath, 'utf8')}# interrupted unit\n`
    writeFileSync(layout.binaryPath, v2Binary, { mode: 0o700 })
    writeFileSync(layout.unitPath, interruptedUnit)
    const journalText = writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: receipt.ownerTokenSha256,
      binarySha256: sha256(v2Binary),
      unitSha256: sha256(interruptedUnit),
    })

    const failing = runner({ failOn: (line) => line.includes(' restart ') })
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v3'),
      serviceRunner: failing,
    }))).rejects.toMatchObject({ code: 'SERVICE_FAILED' })
    expect(readFileSync(layout.binaryPath, 'utf8')).toBe(v2Binary)
    expect(readFileSync(layout.unitPath, 'utf8')).toBe(interruptedUnit)
    expect(readFileSync(layout.journalPath, 'utf8')).toBe(journalText)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(config)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(bootstrap)
    expect(readFileSync(layout.receiptPath, 'utf8')).toBe(oldReceipt)
    expect(readdirSync(layout.binDir).filter((name) => name.includes('stage') || name.startsWith('.rollback-'))).toHaveLength(0)

    const retried = await installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v2'),
      fetch: health(),
    }))
    expect(retried.ok).toBe(true)
    expect(existsSync(layout.journalPath)).toBe(false)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(config)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(bootstrap)
  })
  it('refuses interrupted-upgrade journals with foreign owner tokens or mixed hashes', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const receipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    const wrongOwner = 'f'.repeat(64)
    writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: wrongOwner,
      binarySha256: receipt.binarySha256,
      unitSha256: receipt.unitSha256,
    })
    const foreignOwnerDownload = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: foreignOwnerDownload,
    }))).rejects.toMatchObject({ code: 'FOREIGN_STATE' })
    expect(foreignOwnerDownload.calls).toHaveLength(0)

    writeFileSync(layout.unitPath, 'foreign unit not in either target\n')
    writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: receipt.ownerTokenSha256,
      binarySha256: receipt.binarySha256,
      unitSha256: sha256('some other target unit'),
    })
    const mixedDownload = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: mixedDownload,
    }))).rejects.toMatchObject({ code: 'UNIT_MODIFIED' })
    expect(mixedDownload.calls).toHaveLength(0)
    expect(readFileSync(layout.unitPath, 'utf8')).toBe('foreign unit not in either target\n')
  })
  it('refuses journal-only foreign unit/binary before overwrite', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const receipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    const originalUnit = readFileSync(layout.unitPath)
    writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: receipt.ownerTokenSha256,
      binarySha256: receipt.binarySha256,
      unitSha256: receipt.unitSha256,
    })
    unlinkSync(layout.receiptPath)

    writeFileSync(layout.unitPath, 'foreign journal unit\n')
    const unitDownload = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: unitDownload,
    }))).rejects.toMatchObject({ code: 'UNIT_MODIFIED' })
    expect(unitDownload.calls).toHaveLength(0)

    writeFileSync(layout.unitPath, originalUnit)
    writeFileSync(layout.binaryPath, 'foreign journal binary\n', { mode: 0o700 })
    const binaryDownload = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: binaryDownload,
    }))).rejects.toMatchObject({ code: 'BINARY_MODIFIED' })
    expect(binaryDownload.calls).toHaveLength(0)
  })
  it('refuses a requested port that differs from mutable config server.port', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const config = readFileSync(layout.configPath, 'utf8')
    const changed = config.replace('  port: 8317\n', '  port: 9000\n')
    expect(changed).not.toBe(config)
    writeFileSync(layout.configPath, changed)
    const download = downloader('v2')
    const service = runner()
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: download,
      serviceRunner: service,
    }))).rejects.toMatchObject({ code: 'CONFIG_PORT_MISMATCH' })
    expect(download.calls).toHaveLength(0)
    expect(service.calls).toHaveLength(0)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(changed)

    const status = await statusCliProxyApi(optionsFor(env))
    expect(status.port).toBe(9000)
    expect(status.configPort).toBe(9000)
    expect(status.portMismatch).toBe(true)
    expect(status.dashboardUrl).toBe('http://127.0.0.1:9000/management.html')
  })
})

  it('upgrades a running launchd-owned service when launchctl, ps, and lsof prove the listener', async () => {
    const env = environment('darwin')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))

    const service = runner()
    const processCalls: string[][] = []
    const processRunner = async (command: string, args: string[]) => {
      processCalls.push([command, ...args])
      if (command === 'ps') {
        return { code: 0, stdout: `${layout.binaryPath} --config ${layout.configPath}\n`, stderr: '' }
      }
      if (command === 'lsof') return { code: 0, stdout: '123\n', stderr: '' }
      return { code: 1, stdout: '', stderr: 'unexpected' }
    }
    const nextDownload = downloader('v2')
    const result = await installCliProxyApi(optionsFor(env, {
      probePort: async () => true,
      downloadRelease: nextDownload,
      serviceRunner: service,
      processRunner,
      fetch: health(),
    }))

    expect(result.ok).toBe(true)
    expect(readFileSync(layout.binaryPath, 'utf8')).toContain('# v2')
    expect(service.calls).toContainEqual([
      'launchctl', 'print', `gui/${process.getuid?.() ?? 501}/dev.enpoi.cliproxyapi`,
    ])
    expect(processCalls).toContainEqual(['ps', '-o', 'args=', '-p', '123'])
    expect(processCalls).toContainEqual(['lsof', '-nP', '-iTCP:8317', '-sTCP:LISTEN', '-t'])
  })

  it('refuses a macOS occupied-port upgrade with an unavailable or foreign listener proof', async () => {
    const unavailable = environment('darwin')
    const unavailableLayout = layoutFor(unavailable)
    await installCliProxyApi(optionsFor(unavailable, { downloadRelease: downloader('v1') }))
    const unavailableDownload = downloader('v2')
    await expect(installCliProxyApi(optionsFor(unavailable, {
      probePort: async () => true,
      downloadRelease: unavailableDownload,
      serviceRunner: runner(),
      processRunner: async () => ({ code: 1, stdout: '', stderr: 'ps unavailable' }),
    }))).rejects.toMatchObject({ code: 'OWNED_UPGRADE_BLOCKED' })
    expect(unavailableDownload.calls).toHaveLength(0)
    expect(readFileSync(unavailableLayout.binaryPath, 'utf8')).toContain('# v1')

    const foreign = environment('darwin')
    await installCliProxyApi(optionsFor(foreign, { downloadRelease: downloader('v1') }))
    const foreignDownload = downloader('v2')
    await expect(installCliProxyApi(optionsFor(foreign, {
      probePort: async () => true,
      downloadRelease: foreignDownload,
      serviceRunner: runner(),
      processRunner: async (command: string) => (command === 'ps'
        ? { code: 0, stdout: `${layoutFor(foreign).binaryPath} --config ${layoutFor(foreign).configPath}\n`, stderr: '' }
        : { code: 0, stdout: '999\n', stderr: '' }),
    }))).rejects.toMatchObject({ code: 'OWNED_UPGRADE_BLOCKED' })
    expect(foreignDownload.calls).toHaveLength(0)
  })
describe('dashboard panel handoff', () => {
  it('publishes the downloaded dashboard panel and reports it in the install result', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const download = panelDownloader('v1', '<html>v1 dashboard</html>')
    const result = await installCliProxyApi(optionsFor(env, {
      downloadRelease: download,
      fetch: health(),
    }))

    expect(result.dashboardPanel).toBe('installed')
    expect(readFileSync(layout.dashboardPanelPath, 'utf8')).toBe('<html>v1 dashboard</html>')
    expect(statSync(layout.dashboardPanelPath).mode & 0o777).toBe(0o644)
    expect(readdirSync(layout.staticDir)).toEqual(['management.html'])
  })

  it('restores the previous dashboard panel when an upgrade fails after publishing', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, {
      downloadRelease: panelDownloader('v1', '<html>v1 dashboard</html>'),
      fetch: health(),
    }))
    expect(readFileSync(layout.dashboardPanelPath, 'utf8')).toBe('<html>v1 dashboard</html>')

    const failing = runner({ failOn: (line) => line.includes(' restart ') })
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: panelDownloader('v2', '<html>v2 dashboard</html>'),
      serviceRunner: failing,
      fetch: health(),
    }))).rejects.toMatchObject({ code: 'SERVICE_FAILED' })

    expect(readFileSync(layout.dashboardPanelPath, 'utf8')).toBe('<html>v1 dashboard</html>')
    expect(statSync(layout.dashboardPanelPath).mode & 0o777).toBe(0o644)
  })

  it('passes a fork repository override to the release downloader', async () => {
    const env = environment('linux')
    const download = downloader('v1')
    await installCliProxyApi(optionsFor(env, {
      downloadRelease: download,
      repo: 'acme/fork',
      releasesApi: 'https://api.acme.test/releases/latest',
      fetch: health(),
    }))
    expect(download.calls[0]).toMatchObject({
      repo: 'acme/fork',
      releasesApi: 'https://api.acme.test/releases/latest',
    })
  })
})

describe('release helper hot reload', () => {
  it('reloads a replaced release helper without re-importing the cached install helper', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const scripts = join(mkScratch(), 'scripts')
    mkdirSync(scripts, { recursive: true })
    const sourceScripts = fileURLToPath(new URL('../scripts', import.meta.url))
    copyFileSync(join(sourceScripts, 'cliproxyapi-install.mjs'), join(scripts, 'cliproxyapi-install.mjs'))
    const releaseHelper = (tag: string) => [
      "import { writeFileSync } from 'node:fs'",
      '',
      'export async function downloadProxyRelease(options) {',
      `  writeFileSync(options.destination, '#!/bin/sh\\n# ${tag}\\n', { mode: 0o755 })`,
      "  return { destination: options.destination, version: '8.0.55', checksum: 'a'.repeat(64), bytes: 1 }",
      '}',
      '',
    ].join('\n')
    writeFileSync(join(scripts, 'cliproxyapi-release.mjs'), releaseHelper('release A'))
    const installUrl = pathToFileURL(join(scripts, 'cliproxyapi-install.mjs')).href
    const installer = await import(/* @vite-ignore */ installUrl) as typeof import('../scripts/cliproxyapi-install.mjs')
    const first = await installer.installCliProxyApi(optionsFor(env, { downloadRelease: undefined }))
    expect(first.ok).toBe(true)
    expect(readFileSync(layout.binaryPath, 'utf8')).toContain('# release A')

    // Only the release helper changes; the cached install-helper URL is stable.
    writeFileSync(join(scripts, 'cliproxyapi-release.mjs'), releaseHelper('release B with different bytes'))
    expect(await import(/* @vite-ignore */ installUrl)).toBe(installer)
    const second = await installer.installCliProxyApi(optionsFor(env, { downloadRelease: undefined }))
    expect(second.ok).toBe(true)
    expect(readFileSync(layout.binaryPath, 'utf8')).toContain('# release B')
  })
})

describe('half-published dashboard panel recovery', () => {
  function writeCrashState(
    layout: ReturnType<typeof resolveCliProxyLayout>,
    options: { stagedPanel: boolean; binaryBackup: boolean },
  ): { oldBinary: string; oldPanel: string; newBinary: string; newPanel: string } {
    const receipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8')) as {
      installId: string
      ownerTokenSha256: string
      unitSha256: string
    }
    const oldBinary = readFileSync(layout.binaryPath, 'utf8')
    const oldPanel = readFileSync(layout.dashboardPanelPath, 'utf8')
    const newBinary = '#!/bin/sh\n# v2 crash target\n'
    const newPanel = '<html>v2 crash target</html>'
    writeFileSync(layout.binaryPath, newBinary, { mode: 0o700 })
    if (options.stagedPanel) {
      mkdirSync(join(layout.stageDir, 'static'), { recursive: true })
      writeFileSync(join(layout.stageDir, 'static', 'management.html'), newPanel, { mode: 0o644 })
    }
    if (options.binaryBackup) {
      writeFileSync(join(layout.binDir, `.rollback-binary-${'a'.repeat(24)}`), oldBinary, { mode: 0o700 })
    }
    writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: receipt.ownerTokenSha256,
      binarySha256: sha256(newBinary),
      unitSha256: receipt.unitSha256,
      previousBinarySha256: sha256(oldBinary),
      dashboardPanelSha256: sha256(newPanel),
      previousDashboardPanelSha256: sha256(oldPanel),
    })
    return { oldBinary, oldPanel, newBinary, newPanel }
  }

  it('completes the journaled panel from the staged copy before the next install downloads', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, {
      downloadRelease: panelDownloader('v1', '<html>v1 dashboard</html>'),
      fetch: health(),
    }))
    const crash = writeCrashState(layout, { stagedPanel: true, binaryBackup: true })

    const before = await statusCliProxyApi(optionsFor(env))
    expect(before.installed).toBe(true)
    expect(before.incomplete).toBe(true)
    expect(before.halfPublished).toBe(true)
    const preflight = await preflightCliProxyApi(optionsFor(env))
    expect(preflight.ok).toBe(true)
    expect(preflight.halfPublished).toBe(true)

    let panelBeforeDownload: string | undefined
    const failingDownload = async () => {
      panelBeforeDownload = readFileSync(layout.dashboardPanelPath, 'utf8')
      throw new Error('network down')
    }
    await expect(installCliProxyApi(optionsFor(env, { downloadRelease: failingDownload })))
      .rejects.toMatchObject({ code: 'IO' })

    expect(panelBeforeDownload).toBe(crash.newPanel)
    expect(readFileSync(layout.binaryPath, 'utf8')).toBe(crash.newBinary)
    expect(readFileSync(layout.dashboardPanelPath, 'utf8')).toBe(crash.newPanel)
    expect(readdirSync(layout.staticDir).filter(name => name.startsWith('.rollback-panel-'))).toHaveLength(0)
    expect(readdirSync(layout.binDir).filter(name => name.startsWith('.rollback-binary-'))).toHaveLength(0)
    const after = await statusCliProxyApi(optionsFor(env))
    expect(after.incomplete).toBe(true)
    expect(after.halfPublished).toBe(false)
  })

  it('restores the previous binary when the staged panel cannot complete the pair', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, {
      downloadRelease: panelDownloader('v1', '<html>v1 dashboard</html>'),
      fetch: health(),
    }))
    const crash = writeCrashState(layout, { stagedPanel: false, binaryBackup: true })

    const before = await statusCliProxyApi(optionsFor(env))
    expect(before.halfPublished).toBe(true)

    const failingDownload = async () => { throw new Error('network down') }
    await expect(installCliProxyApi(optionsFor(env, { downloadRelease: failingDownload })))
      .rejects.toMatchObject({ code: 'IO' })

    expect(readFileSync(layout.binaryPath, 'utf8')).toBe(crash.oldBinary)
    expect(readFileSync(layout.dashboardPanelPath, 'utf8')).toBe(crash.oldPanel)
    const after = await statusCliProxyApi(optionsFor(env))
    expect(after.halfPublished).toBe(false)
  })

  it('accepts a journaled published pair as an interrupted upgrade, not a modification', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, {
      downloadRelease: panelDownloader('v1', '<html>v1 dashboard</html>'),
      fetch: health(),
    }))
    const crash = writeCrashState(layout, { stagedPanel: true, binaryBackup: true })
    // Crash after the panel rename but before receipt publication: both halves
    // match the journal while the receipt still names v1.
    writeFileSync(layout.dashboardPanelPath, crash.newPanel, { mode: 0o644 })
    rmSync(layout.stageDir, { recursive: true, force: true })

    const status = await statusCliProxyApi(optionsFor(env))
    expect(status.installed).toBe(true)
    expect(status.incomplete).toBe(true)
    expect(status.halfPublished).toBe(false)
    const preflight = await preflightCliProxyApi(optionsFor(env))
    expect(preflight.ok).toBe(true)

    const failingDownload = async () => { throw new Error('network down') }
    await expect(installCliProxyApi(optionsFor(env, { downloadRelease: failingDownload })))
      .rejects.toMatchObject({ code: 'IO' })
    expect(readFileSync(layout.binaryPath, 'utf8')).toBe(crash.newBinary)
    expect(readFileSync(layout.dashboardPanelPath, 'utf8')).toBe(crash.newPanel)
  })

  it('sweeps only the exact generated rollback-panel token', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, {
      downloadRelease: panelDownloader('v1', '<html>v1 dashboard</html>'),
      fetch: health(),
    }))
    const exact = join(layout.staticDir, `.rollback-panel-${'b'.repeat(24)}`)
    const nearMiss = join(layout.staticDir, '.rollback-panel-deadbeef')
    writeFileSync(exact, 'stale backup\n')
    writeFileSync(nearMiss, 'near miss\n')

    await installCliProxyApi(optionsFor(env, {
      downloadRelease: panelDownloader('v2', '<html>v2 dashboard</html>'),
      fetch: health(),
    }))
    expect(existsSync(exact)).toBe(false)
    expect(existsSync(nearMiss)).toBe(true)
    expect(readFileSync(layout.dashboardPanelPath, 'utf8')).toBe('<html>v2 dashboard</html>')
  })
})

describe('preflight', () => {
  it('reports a bounded, non-mutating port preflight result', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const receiptBefore = readFileSync(layout.receiptPath, 'utf8')
    const configBefore = readFileSync(layout.configPath, 'utf8')
    const service = runner()

    const result = await preflightCliProxyApi(optionsFor(env, {
      serviceRunner: service,
      probePort: async (port: number, host: string) => {
        expect(port).toBe(8317)
        expect(host).toBe('127.0.0.1')
        return true
      },
    }))

    expect(result).toMatchObject({
      ok: true,
      action: 'preflight',
      installed: true,
      incomplete: false,
      removedState: false,
      port: 8317,
      portInUse: true,
      portMismatch: false,
      credentialsPresent: true,
    })
    expect(readFileSync(layout.receiptPath, 'utf8')).toBe(receiptBefore)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(configBefore)
    expect(service.calls).toEqual([['systemctl', '--user', 'is-active', 'dsh-cliproxyapi.service']])
  })

  it('refuses a port held by an unowned listener before a job exists', async () => {
    const env = environment('linux')
    const service = runner()
    const result = await preflightCliProxyApi(optionsFor(env, {
      probePort: async () => true,
      serviceRunner: service,
    }))
    expect(result).toMatchObject({
      ok: false,
      action: 'preflight',
      code: 'PORT_IN_USE',
      installed: false,
      port: 8317,
      portInUse: true,
      credentialsPresent: false,
    })
    expect(result.reason).toContain('8317')
    expect(service.calls).toHaveLength(0)
    expect(existsSync(join(env.dshHome, 'providers', 'cliproxyapi'))).toBe(false)
  })

  it('refuses an occupied port when the owned service is not active', async () => {
    const env = environment('linux')
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const service = runner({ active: false })
    const result = await preflightCliProxyApi(optionsFor(env, {
      probePort: async () => true,
      serviceRunner: service,
    }))
    expect(result).toMatchObject({ ok: false, code: 'PORT_IN_USE', installed: true, portInUse: true })
    expect(service.calls).toContainEqual(['systemctl', '--user', 'is-active', 'dsh-cliproxyapi.service'])
  })

  it('refuses stale owned artifacts before a job exists', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    writeFileSync(layout.binaryPath, 'foreign replacement\n', { mode: 0o700 })
    const service = runner()
    const result = await preflightCliProxyApi(optionsFor(env, {
      probePort: async () => false,
      serviceRunner: service,
    }))
    expect(result).toMatchObject({
      ok: false,
      code: 'BINARY_MODIFIED',
      installed: true,
      binaryMatches: false,
      portInUse: false,
    })
    expect(service.calls).toHaveLength(0)
  })

  it('accepts an interrupted upgrade whose published unit matches the journal target', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const receipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    const interruptedUnit = `${readFileSync(layout.unitPath, 'utf8')}# interrupted unit\n`
    writeFileSync(layout.unitPath, interruptedUnit)
    writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: receipt.ownerTokenSha256,
      binarySha256: sha256('#!/bin/sh\n# v2 target\n'),
      unitSha256: sha256(interruptedUnit),
      previousBinarySha256: receipt.binarySha256,
      previousUnitSha256: receipt.unitSha256,
    })

    const result = await preflightCliProxyApi(optionsFor(env, {
      probePort: async () => false,
      serviceRunner: runner(),
    }))
    expect(result).toMatchObject({
      ok: true,
      installed: true,
      incomplete: true,
      unitMatches: false,
      binaryMatches: true,
      portInUse: false,
    })
  })

  it('refuses a stale configured port before a job exists', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const changed = readFileSync(layout.configPath, 'utf8').replace('  port: 8317\n', '  port: 9000\n')
    writeFileSync(layout.configPath, changed)
    const result = await preflightCliProxyApi(optionsFor(env, {
      probePort: async () => false,
      serviceRunner: runner(),
    }))
    expect(result).toMatchObject({
      ok: false,
      code: 'CONFIG_PORT_MISMATCH',
      installed: true,
      port: 9000,
      configPort: 9000,
      portMismatch: true,
      portInUse: false,
    })
  })

  it('parses a preflight command without performing work', () => {
    expect(parseCliProxyArgs(['preflight', '--dsh-home', '/tmp/dsh', '--port', '9000'])).toEqual({
      command: 'preflight',
      options: { dshHome: '/tmp/dsh', port: 9000 },
    })
  })

  it('dispatches the preflight command without mutating the home', async () => {
    const env = environment('linux')
    const result = await runCliProxyInstaller(['preflight', '--dsh-home', env.dshHome], {
      userHome: env.userHome,
      platform: 'linux',
      arch: 'x64',
      probePort: async () => false,
    })
    expect(result).toMatchObject({
      ok: true,
      action: 'preflight',
      installed: false,
      incomplete: false,
      port: 8317,
      portInUse: false,
      credentialsPresent: false,
    })
    expect(existsSync(join(env.dshHome, 'providers', 'cliproxyapi'))).toBe(false)
  })
})

describe('remove and status', () => {
  it('removes only receipt-owned artifacts and retains credentials and auths', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const config = readFileSync(layout.configPath, 'utf8')
    const bootstrap = readFileSync(layout.bootstrapPath, 'utf8')
    const keys = configKeys(config)
    writeFileSync(join(layout.authDir, 'account.json'), '{"secret":"kept"}\n')
    const service = runner()
    const result = await removeCliProxyApi(optionsFor(env, { serviceRunner: service }))

    expect(result.removed).toBe(true)
    expect(result.removedBinary).toBe(true)
    expect(result.removedUnit).toBe(true)
    expect(existsSync(layout.binaryPath)).toBe(false)
    expect(existsSync(layout.unitPath)).toBe(false)
    expect(existsSync(layout.receiptPath)).toBe(false)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(config)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(bootstrap)
    expect(readFileSync(join(layout.authDir, 'account.json'), 'utf8')).toBe('{"secret":"kept"}\n')
    expect(existsSync(layout.root)).toBe(true)
    expect(service.calls).toContainEqual(['systemctl', '--user', 'disable', '--now', 'dsh-cliproxyapi.service'])
    expect(JSON.stringify(result)).not.toContain(keys.management!)
    expect(JSON.stringify(result)).not.toContain(keys.inference!)
    await expect(readOwnedInferenceCredential(env.dshHome, {
      platform: env.platform,
      userHome: env.userHome,
    })).rejects.toMatchObject({ code: 'NOT_INSTALLED' })
  })

  it('refuses removal without a receipt and never issues a service command', async () => {
    const env = environment('linux')
    const service = runner()
    const foreignUnit = join(env.userHome, '.config', 'systemd', 'user', 'cliproxyapi.service')
    mkdirSync(dirname(foreignUnit), { recursive: true })
    writeFileSync(foreignUnit, 'foreign runtime\n')
    await expect(removeCliProxyApi(optionsFor(env, { serviceRunner: service })))
      .rejects.toMatchObject({ code: 'NOT_INSTALLED' })
    expect(service.calls).toHaveLength(0)
    expect(readFileSync(foreignUnit, 'utf8')).toBe('foreign runtime\n')
  })

  it('refuses to remove artifacts whose receipt hashes no longer match', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    writeFileSync(layout.unitPath, 'foreign edit\n')
    const service = runner()
    await expect(removeCliProxyApi(optionsFor(env, { serviceRunner: service })))
      .rejects.toMatchObject({ code: 'UNIT_MODIFIED' })
    expect(service.calls).toHaveLength(0)
    expect(readFileSync(layout.unitPath, 'utf8')).toBe('foreign edit\n')
    expect(existsSync(layout.receiptPath)).toBe(true)
  })
  it('removes a no-receipt journal-owned incomplete root without touching credentials', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const failing = runner({ failOn: (line) => line.includes('daemon-reload') })
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v1'),
      serviceRunner: failing,
    }))).rejects.toMatchObject({ code: 'SERVICE_FAILED' })
    const config = readFileSync(layout.configPath, 'utf8')
    const bootstrap = readFileSync(layout.bootstrapPath, 'utf8')
    expect(existsSync(layout.receiptPath)).toBe(false)
    expect(existsSync(layout.journalPath)).toBe(true)

    const remover = runner()
    const result = await removeCliProxyApi(optionsFor(env, { serviceRunner: remover }))
    expect(result.removed).toBe(true)
    expect(result.incomplete).toBe(true)
    expect(result.removedUnit).toBe(false)
    expect(result.removedBinary).toBe(false)
    expect(result.removedJournal).toBe(true)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(config)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(bootstrap)
    expect(existsSync(layout.root)).toBe(true)
    expect(existsSync(layout.journalPath)).toBe(false)
    expect(remover.calls).toContainEqual(['systemctl', '--user', 'disable', '--now', 'dsh-cliproxyapi.service'])
  })

  it('removes receipt-less owned unit/binary only when journal target hashes match', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const receipt = JSON.parse(readFileSync(layout.receiptPath, 'utf8'))
    const config = readFileSync(layout.configPath, 'utf8')
    const bootstrap = readFileSync(layout.bootstrapPath, 'utf8')
    const originalUnit = readFileSync(layout.unitPath)
    writeFileSync(join(layout.authDir, 'account.json'), '{"secret":"kept"}\n')
    writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: receipt.ownerTokenSha256,
      binarySha256: receipt.binarySha256,
      unitSha256: receipt.unitSha256,
    })
    unlinkSync(layout.receiptPath)

    const mismatched = runner()
    writeFileSync(layout.unitPath, 'foreign unit edit\n')
    await expect(removeCliProxyApi(optionsFor(env, { serviceRunner: mismatched })))
      .rejects.toMatchObject({ code: 'UNIT_MODIFIED' })
    expect(mismatched.calls).toHaveLength(0)
    expect(existsSync(layout.binaryPath)).toBe(true)
    expect(existsSync(layout.journalPath)).toBe(true)

    // Restore the exact journal target, then remove only the owned artifacts.
    writeFileSync(layout.unitPath, originalUnit)
    const unitBytes = readFileSync(layout.unitPath, 'utf8')
    writeJournal(layout, {
      installId: receipt.installId,
      ownerTokenSha256: receipt.ownerTokenSha256,
      binarySha256: receipt.binarySha256,
      unitSha256: sha256(unitBytes),
    })
    const remover = runner()
    const result = await removeCliProxyApi(optionsFor(env, { serviceRunner: remover }))
    expect(result.incomplete).toBe(true)
    expect(result.removedUnit).toBe(true)
    expect(result.removedBinary).toBe(true)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(config)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(bootstrap)
    expect(readFileSync(join(layout.authDir, 'account.json'), 'utf8')).toBe('{"secret":"kept"}\n')
    expect(existsSync(layout.root)).toBe(true)
    expect(existsSync(layout.journalPath)).toBe(false)
  })
  it('cleans a journal-only artifact state without credentials and allows fresh install', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    mkdirSync(layout.root, { recursive: true })
    writeJournal(layout, {
      installId: 'artifact-only',
      ownerTokenSha256: 'a'.repeat(64),
      binarySha256: 'b'.repeat(64),
      unitSha256: 'c'.repeat(64),
    })
    const removed = await removeCliProxyApi(optionsFor(env, { serviceRunner: runner() }))
    expect(removed.removed).toBe(true)
    expect(removed.removedState).toBe(false)
    expect(removed.retainedConfig).toBe(false)
    expect(existsSync(layout.journalPath)).toBe(false)
    expect(existsSync(layout.removedStatePath)).toBe(false)

    const reinstalled = await installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v2'),
      fetch: health(),
    }))
    expect(reinstalled.ok).toBe(true)
    expect(existsSync(layout.receiptPath)).toBe(true)
    expect(existsSync(layout.configPath)).toBe(true)
    expect(existsSync(layout.bootstrapPath)).toBe(true)
  })

  it('refuses config-without-bootstrap removal before any service or marker mutation', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    unlinkSync(layout.bootstrapPath)
    const service = runner()
    await expect(removeCliProxyApi(optionsFor(env, { serviceRunner: service })))
      .rejects.toMatchObject({ code: 'CREDENTIAL_STATE_INVALID' })
    expect(service.calls).toHaveLength(0)
    expect(existsSync(layout.receiptPath)).toBe(true)
    expect(existsSync(layout.unitPath)).toBe(true)
    expect(existsSync(layout.binaryPath)).toBe(true)
    expect(existsSync(layout.removedStatePath)).toBe(false)
  })

  it('finishes marker-only removal of matching leftovers and rejects foreign replacements', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const unit = readFileSync(layout.unitPath)
    const binary = readFileSync(layout.binaryPath)
    await removeCliProxyApi(optionsFor(env, { serviceRunner: runner() }))
    writeFileSync(layout.unitPath, unit)
    writeFileSync(layout.binaryPath, binary, { mode: 0o700 })

    const remover = runner()
    const finished = await removeCliProxyApi(optionsFor(env, { serviceRunner: remover }))
    expect(finished.removedUnit).toBe(true)
    expect(finished.removedBinary).toBe(true)
    expect(finished.removedState).toBe(true)
    expect(existsSync(layout.unitPath)).toBe(false)
    expect(existsSync(layout.binaryPath)).toBe(false)
    expect(existsSync(layout.removedStatePath)).toBe(true)
    expect(readFileSync(layout.configPath, 'utf8')).toContain('config-version: 8')

    writeFileSync(layout.unitPath, 'foreign unit after marker removal\n')
    const blocked = runner()
    await expect(removeCliProxyApi(optionsFor(env, { serviceRunner: blocked })))
      .rejects.toMatchObject({ code: 'UNIT_MODIFIED' })
    expect(blocked.calls).toHaveLength(0)
    expect(readFileSync(layout.unitPath, 'utf8')).toBe('foreign unit after marker removal\n')
  })

  it('refuses to unlink when the owned service remains active after stop', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const calls: string[][] = []
    const stillActive = async (command: string, args: string[]) => {
      calls.push([command, ...args])
      if (args.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await expect(removeCliProxyApi(optionsFor(env, { serviceRunner: stillActive })))
      .rejects.toMatchObject({ code: 'SERVICE_FAILED' })
    expect(calls).toContainEqual(['systemctl', '--user', 'disable', '--now', 'dsh-cliproxyapi.service'])
    expect(calls).toContainEqual(['systemctl', '--user', 'is-active', 'dsh-cliproxyapi.service'])
    expect(existsSync(layout.receiptPath)).toBe(true)
    expect(existsSync(layout.unitPath)).toBe(true)
    expect(existsSync(layout.binaryPath)).toBe(true)
    expect(existsSync(layout.removedStatePath)).toBe(false)
  })

  it('reinstalls after remove with the removed-state marker preserving keys and auths', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const first = await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    writeFileSync(join(layout.authDir, 'account.json'), '{"secret":"kept"}\n')
    const config = readFileSync(layout.configPath, 'utf8')
    const bootstrap = readFileSync(layout.bootstrapPath, 'utf8')
    const keys = configKeys(config)
    const inferenceBefore = await readOwnedInferenceCredential(env.dshHome, {
      platform: env.platform,
      userHome: env.userHome,
    })

    const removed = await removeCliProxyApi(optionsFor(env, { serviceRunner: runner() }))
    expect(removed.removed).toBe(true)
    expect(removed.removedState).toBe(true)
    expect(removed.retainedConfig).toBe(true)
    expect(existsSync(layout.removedStatePath)).toBe(true)
    expect(statSync(layout.removedStatePath).mode & 0o777).toBe(0o600)
    const marker = readFileSync(layout.removedStatePath, 'utf8')
    expect(marker).not.toContain(keys.management!)
    expect(marker).not.toContain(keys.inference!)
    expect(JSON.parse(marker).installId).toBe(first.installId)
    expect(JSON.parse(marker).ownerTokenSha256).toMatch(/^[a-f0-9]{64}$/u)

    const status = await statusCliProxyApi(optionsFor(env))
    expect(status.installed).toBe(false)
    expect(status.incomplete).toBe(false)
    expect(status.removedState).toBe(true)
    expect(status.retainedConfig).toBe(true)
    expect(status.credentialsPresent).toBe(true)

    const already = await removeCliProxyApi(optionsFor(env, { serviceRunner: runner() }))
    expect(already.removed).toBe(false)
    expect(already.alreadyRemoved).toBe(true)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(config)

    const reinstalled = await installCliProxyApi(optionsFor(env, {
      downloadRelease: downloader('v2'),
      fetch: health(),
    }))
    expect(reinstalled.ok).toBe(true)
    expect(reinstalled.installId).toBe(first.installId)
    expect(existsSync(layout.removedStatePath)).toBe(false)
    expect(existsSync(layout.receiptPath)).toBe(true)
    expect(readFileSync(layout.configPath, 'utf8')).toBe(config)
    expect(readFileSync(layout.bootstrapPath, 'utf8')).toBe(bootstrap)
    expect(readFileSync(join(layout.authDir, 'account.json'), 'utf8')).toBe('{"secret":"kept"}\n')
    expect(JSON.parse(readFileSync(layout.bootstrapPath, 'utf8')).managementSecretKey).toBe(keys.management)
    expect(await readOwnedInferenceCredential(env.dshHome, {
      platform: env.platform,
      userHome: env.userHome,
    })).toBe(inferenceBefore)
  })

  it('refuses foreign binary/unit replacements inserted after removal', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    await removeCliProxyApi(optionsFor(env, { serviceRunner: runner() }))

    writeFileSync(layout.unitPath, 'foreign unit after removal\n')
    const firstDownload = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: firstDownload,
    }))).rejects.toMatchObject({ code: 'UNIT_MODIFIED' })
    expect(firstDownload.calls).toHaveLength(0)
    expect(readFileSync(layout.unitPath, 'utf8')).toBe('foreign unit after removal\n')

    unlinkSync(layout.unitPath)
    writeFileSync(layout.binaryPath, 'foreign binary after removal\n', { mode: 0o700 })
    const secondDownload = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: secondDownload,
    }))).rejects.toMatchObject({ code: 'BINARY_MODIFIED' })
    expect(secondDownload.calls).toHaveLength(0)
    expect(readFileSync(layout.binaryPath, 'utf8')).toBe('foreign binary after removal\n')
  })

  it('reloads systemd after removing the owned unit', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const service = runner()
    const result = await removeCliProxyApi(optionsFor(env, { serviceRunner: service }))
    expect(result.removedUnit).toBe(true)
    expect(service.calls).toContainEqual(['systemctl', '--user', 'daemon-reload'])
  })

  it('refuses removal when the bootstrap owner token mismatches the receipt', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const bootstrap = JSON.parse(readFileSync(layout.bootstrapPath, 'utf8'))
    bootstrap.ownerToken = 'f'.repeat(64)
    writeFileSync(layout.bootstrapPath, `${JSON.stringify(bootstrap, null, 2)}\n`, { mode: 0o600 })
    const service = runner()

    await expect(removeCliProxyApi(optionsFor(env, { serviceRunner: service })))
      .rejects.toMatchObject({ code: 'CREDENTIAL_STATE_INVALID' })
    expect(service.calls).toHaveLength(0)
    expect(existsSync(layout.receiptPath)).toBe(true)
    expect(existsSync(layout.unitPath)).toBe(true)
    expect(existsSync(layout.binaryPath)).toBe(true)
    expect(existsSync(layout.removedStatePath)).toBe(false)
  })

  it('returns NOT_INSTALLED when another remover clears the markers before the lock', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    mkdirSync(layout.root, { recursive: true })
    writeJournal(layout, {
      installId: 'racing-remover',
      ownerTokenSha256: 'a'.repeat(64),
      binarySha256: 'b'.repeat(64),
      unitSha256: 'c'.repeat(64),
    })
    const service = runner()

    await expect(removeCliProxyApi(optionsFor(env, {
      serviceRunner: service,
      beforeLock: async () => {
        unlinkSync(layout.journalPath)
      },
    }))).rejects.toMatchObject({ code: 'NOT_INSTALLED' })

    expect(service.calls).toHaveLength(0)
    expect(existsSync(layout.journalPath)).toBe(false)
    expect(existsSync(layout.receiptPath)).toBe(false)
    expect(existsSync(layout.removedStatePath)).toBe(false)
  })

  it('returns NOT_INSTALLED when the removed-state marker vanishes before the lock', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    await removeCliProxyApi(optionsFor(env, { serviceRunner: runner() }))
    expect(existsSync(layout.removedStatePath)).toBe(true)
    const service = runner()

    await expect(removeCliProxyApi(optionsFor(env, {
      serviceRunner: service,
      beforeLock: async () => {
        unlinkSync(layout.removedStatePath)
      },
    }))).rejects.toMatchObject({ code: 'NOT_INSTALLED' })

    expect(service.calls).toHaveLength(0)
    expect(existsSync(layout.configPath)).toBe(true)
    expect(existsSync(layout.bootstrapPath)).toBe(true)
  })

  it('refuses a retained config root with neither receipt nor removed-state marker', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    mkdirSync(layout.root, { recursive: true })
    writeFileSync(layout.configPath, 'foreign config\n')
    writeFileSync(layout.bootstrapPath, '{}\n')
    mkdirSync(layout.authDir, { recursive: true })
    const download = downloader('v2')
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: download,
    }))).rejects.toMatchObject({ code: 'FOREIGN_STATE' })
    expect(download.calls).toHaveLength(0)
    expect(readFileSync(layout.configPath, 'utf8')).toBe('foreign config\n')
  })
})

describe('safety edges', () => {
  it('fails explicitly when the current inference config cannot be parsed', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    const bootstrap = JSON.parse(readFileSync(layout.bootstrapPath, 'utf8'))
    writeFileSync(layout.configPath, 'config-version: 8\n')
    await expect(readOwnedInferenceCredential(env.dshHome, {
      platform: env.platform,
      userHome: env.userHome,
    })).rejects.toMatchObject({
      code: 'CREDENTIAL_UNAVAILABLE',
      message: expect.not.stringContaining('bootstrap'),
    })

    unlinkSync(layout.configPath)
    await expect(readOwnedInferenceCredential(env.dshHome, {
      platform: env.platform,
      userHome: env.userHome,
    })).rejects.toMatchObject({
      code: 'CREDENTIAL_UNAVAILABLE',
      message: expect.not.stringContaining('bootstrap'),
    })
    // Bootstrap still proves ownership; it is not returned as a live key.
    expect(bootstrap.ownerToken).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('bounds a hung injected service runner instead of hanging the install', async () => {
    const env = environment('linux')
    await expect(installCliProxyApi(optionsFor(env, {
      serviceRunner: () => new Promise(() => {}),
      serviceTimeoutMs: 50,
    }))).rejects.toMatchObject({ code: 'SERVICE_TIMEOUT' })
    expect(existsSync(layoutFor(env).receiptPath)).toBe(false)
  })

  it('propagates the operation abort signal into the service runner', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const controller = new AbortController()
    const seenSignals: Array<AbortSignal | undefined> = []
    const service = async (
      _command: string,
      args: string[],
      serviceOptions?: { signal?: AbortSignal },
    ) => {
      seenSignals.push(serviceOptions?.signal)
      if (args.includes('restart')) controller.abort()
      return { code: 0, stdout: '', stderr: '' }
    }
    await expect(installCliProxyApi(optionsFor(env, {
      serviceRunner: service,
      signal: controller.signal,
    }))).rejects.toMatchObject({ code: 'ABORTED' })
    expect(seenSignals).toContain(controller.signal)
    expect(existsSync(layout.receiptPath)).toBe(false)
  })

  it('bounds real service child commands and honors abort signals', async () => {
    const timed = await defaultServiceRunner(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 100 },
    )
    expect(timed.timedOut).toBe(true)
    expect(timed.code === 0).toBe(false)

    const controller = new AbortController()
    const started = Date.now()
    const pending = defaultServiceRunner(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 10_000, signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 50)
    const aborted = await pending
    expect(aborted.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('aborts health polling and never publishes a receipt', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const controller = new AbortController()
    await expect(installCliProxyApi(optionsFor(env, {
      signal: controller.signal,
      healthAttempts: 1,
      healthTimeoutMs: 1000,
      fetch: async () => {
        controller.abort()
        return new Promise(() => {})
      },
    }))).rejects.toMatchObject({ code: 'ABORTED' })
    expect(existsSync(layout.receiptPath)).toBe(false)
  })

  it('rolls back a fresh install whose health answer came from a foreign listener', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const service = runner()
    const fetchCalls: string[] = []
    const verifyCalls: number[] = []
    await expect(installCliProxyApi(optionsFor(env, {
      serviceRunner: service,
      fetch: health(fetchCalls),
      verifyListener: async ({ port }: { port: number }) => {
        verifyCalls.push(port)
        return false
      },
    }))).rejects.toMatchObject({ code: 'LISTENER_UNVERIFIED' })

    expect(fetchCalls).toEqual(['http://127.0.0.1:8317/healthz'])
    expect(verifyCalls).toEqual([8317])
    expect(existsSync(layout.receiptPath)).toBe(false)
    expect(existsSync(layout.binaryPath)).toBe(false)
    expect(existsSync(layout.unitPath)).toBe(false)
    expect(service.calls).toContainEqual([
      'systemctl', '--user', 'disable', '--now', 'dsh-cliproxyapi.service',
    ])
  })

  it('respects XDG_CONFIG_HOME and systemd $/% escaping', async () => {
    const env = environment('linux')
    const dshHome = join(env.base, 'dsh $home %conf')
    const xdg = join(env.base, 'xdg $config %dir')
    const layout = resolveCliProxyLayout({
      dshHome,
      userHome: env.userHome,
      platform: 'linux',
      xdgConfigHome: xdg,
    })
    expect(layout.unitPath).toBe(join(xdg, 'systemd', 'user', 'dsh-cliproxyapi.service'))
    await installCliProxyApi(optionsFor(env, {
      dshHome,
      xdgConfigHome: xdg,
      downloadRelease: downloader('v1'),
      fetch: health(),
    }))
    const unit = readFileSync(layout.unitPath, 'utf8')
    const execQuote = (value: string) => JSON.stringify(value).replaceAll('$', '$$').replaceAll('%', '%%')
    const pathQuote = (value: string) => value.replaceAll('\\', '\\\\').replaceAll(' ', '\\x20').replaceAll('%', '%%')
    expect(unit).toContain(`ExecStart=${execQuote(layout.binaryPath)} --config ${execQuote(layout.configPath)}`)
    expect(unit).toContain(`WorkingDirectory=${pathQuote(layout.root)}`)

    if (spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' }).status === 0) {
      const verify = spawnSync('systemd-analyze', ['verify', layout.unitPath], { encoding: 'utf8' })
      expect(verify.status, verify.stderr).toBe(0)
    }
  })

  it('refuses 404, wrong health signatures, and a hanging health fetch', async () => {
    const notFound = environment('linux')
    await expect(installCliProxyApi(optionsFor(notFound, {
      fetch: async () => ({ status: 404, json: async () => ({ status: 'ok' }) }),
    }))).rejects.toMatchObject({ code: 'HEALTH_TIMEOUT' })
    expect(existsSync(layoutFor(notFound).receiptPath)).toBe(false)

    const wrong = environment('linux')
    await expect(installCliProxyApi(optionsFor(wrong, {
      fetch: health([], { status: 'starting' }),
    }))).rejects.toMatchObject({ code: 'HEALTH_TIMEOUT' })
    expect(existsSync(layoutFor(wrong).receiptPath)).toBe(false)

    const hanging = environment('linux')
    const started = Date.now()
    await expect(installCliProxyApi(optionsFor(hanging, {
      fetch: () => new Promise(() => {}),
      healthAttempts: 1,
      healthTimeoutMs: 25,
    }))).rejects.toMatchObject({ code: 'HEALTH_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(existsSync(layoutFor(hanging).receiptPath)).toBe(false)
  })

  it('cleans staged artifacts when the download is aborted', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    const service = runner()
    const aborting = async ({ destination }: { destination: string }) => {
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, 'partial binary\n')
      const error = new Error('release download aborted')
      error.name = 'AbortError'
      ;(error as Error & { code?: string }).code = 'ABORTED'
      throw error
    }
    await expect(installCliProxyApi(optionsFor(env, {
      downloadRelease: aborting,
      serviceRunner: service,
    }))).rejects.toMatchObject({ code: 'ABORTED' })
    expect(existsSync(layout.root)).toBe(false)
    expect(existsSync(layout.receiptPath)).toBe(false)
    expect(existsSync(layout.lockPath)).toBe(false)
    expect(service.calls).toHaveLength(0)
  })

  it('reclaims an old empty install lock instead of wedging every operation', async () => {
    const env = environment('linux')
    const layout = layoutFor(env)
    mkdirSync(layout.root, { recursive: true })
    writeFileSync(layout.lockPath, '')
    const old = new Date(Date.UTC(2025, 0, 1))
    utimesSync(layout.lockPath, old, old)

    const result = await installCliProxyApi(optionsFor(env, { downloadRelease: downloader('v1') }))
    expect(result.ok).toBe(true)
    expect(existsSync(layout.lockPath)).toBe(false)
  })

  it('refuses a recent malformed install lock and a live invalid owner', async () => {
    const recent = environment('linux')
    const recentLayout = layoutFor(recent)
    mkdirSync(recentLayout.root, { recursive: true })
    writeFileSync(recentLayout.lockPath, '')
    const fixed = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
    utimesSync(recentLayout.lockPath, fixed, fixed)
    await expect(installCliProxyApi(optionsFor(recent, { downloadRelease: downloader('v1') })))
      .rejects.toMatchObject({ code: 'LOCKED' })
    expect(readFileSync(recentLayout.lockPath, 'utf8')).toBe('')

    const live = environment('linux')
    const liveLayout = layoutFor(live)
    mkdirSync(liveLayout.root, { recursive: true })
    const invalid = JSON.stringify({ version: 1, pid: process.pid, token: '' })
    writeFileSync(liveLayout.lockPath, invalid)
    utimesSync(liveLayout.lockPath, new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2025, 0, 1)))
    const download = downloader('v1')
    await expect(installCliProxyApi(optionsFor(live, { downloadRelease: download })))
      .rejects.toMatchObject({ code: 'LOCKED' })
    expect(download.calls).toHaveLength(0)
    expect(readFileSync(liveLayout.lockPath, 'utf8')).toBe(invalid)
  })

  it('parses the documented CLI flags without performing work', () => {
    expect(parseCliProxyArgs([
      'install', '--dsh-home', '/tmp/dsh', '--user-home', '/tmp/user', '--port', '9000',
      '--version', '8.0.55', '--releases-api', 'https://api.test/releases/latest',
      '--repo', 'acme/fork',
    ])).toEqual({
      command: 'install',
      options: {
        dshHome: '/tmp/dsh',
        userHome: '/tmp/user',
        port: 9000,
        version: '8.0.55',
        releasesApi: 'https://api.test/releases/latest',
        repo: 'acme/fork',
      },
    })
    expect(() => parseCliProxyArgs(['install', '--home', '/tmp/dsh'])).toThrow(/unknown flag/u)
    expect(parseCliProxyArgs(['status', '--dsh-home=/tmp/other'])).toEqual({
      command: 'status',
      options: { dshHome: '/tmp/other' },
    })
    expect(() => parseCliProxyArgs(['install', '--port', '70000'])).toThrow(/port/u)
    expect(() => parseCliProxyArgs(['bogus'])).toThrow(/command/u)
  })
})

describe('helper entry guard', () => {
  it.skipIf(process.platform === 'win32')('runs status and remove through a symlinked helper path', () => {
    const dir = mkScratch()
    const link = join(dir, 'install-link.mjs')
    symlinkSync(new URL('../scripts/cliproxyapi-install.mjs', import.meta.url), link)
    const dshHome = join(dir, 'dsh home')

    const status = spawnSync(process.execPath, [link, 'status', '--dsh-home', dshHome], { encoding: 'utf8' })
    expect(status.status).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      action: 'status',
      installed: false,
    })

    const remove = spawnSync(process.execPath, [link, 'remove', '--dsh-home', dshHome], { encoding: 'utf8' })
    expect(remove.status).toBe(1)
    expect(JSON.parse(remove.stdout)).toMatchObject({
      ok: false,
      action: 'remove',
      error: { code: 'NOT_INSTALLED' },
    })
  })
})
