#!/usr/bin/env node
/**
 * doctor.mjs — standalone host diagnostics for an Enpoi Harness install
 * (`ds doctor`, `dsh doctor`).
 *
 * Runs with plain Node and standard libraries only: systemd/HTTP service
 * health, host and disk state, credentials and launch-env permissions,
 * configured LLM providers and API keys, the recurring-error store owned by
 * `enpoi-diagnostics`, journal error lines, and session/index inventory.
 *
 * Output is a human-readable aligned report on a terminal and machine-readable
 * JSON with `--json`. Exit status is 0 for a healthy host, 1 when any check
 * reports an error (or any warning with `--strict`), 2 for a usage failure.
 *
 * Environment: DSH_HOME (default ~/.dsh), DSH_PORT, DSH_PROFILE,
 * DSH_SERVICE_UNIT, DSH_NODE override the matching flags.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statfsSync, statSync } from 'node:fs'
import { arch, cpus, homedir, hostname, platform, release, uptime as osUptime } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

const VERSION = '1.0.0'
// A closed consumer (`| head`, a quit pager) is normal; exit like a SIGPIPE
// instead of crashing on the unhandled stream error.
process.stdout.on('error', error => {
  if (error.code === 'EPIPE') process.exit(141)
  process.stderr.write(`doctor: stdout error: ${error.message}\n`)
  process.exit(2)
})
const GLYPH = { ok: '✔', warn: '⚠', error: '✖', info: 'ℹ', skip: '·' }
const COLOR_NAME = { ok: 'green', warn: 'yellow', error: 'red', info: 'cyan', skip: 'dim' }
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
}
const MINIMUM_NODE = [22, 19]
const SEARCH_KEY_ENV = {
  exa: 'EXA_API_KEY',
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  searxng: 'SEARXNG_URL',
  jina: 'JINA_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}
const WEB_KEY_NAMES = ['EXA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'PERPLEXITY_API_KEY', 'JINA_API_KEY', 'SEARXNG_URL']

function parseArgs(argv) {
  const options = {
    json: false,
    color: undefined,
    strict: false,
    help: false,
    home: process.env.DSH_HOME ?? '',
    port: Number(process.env.DSH_PORT ?? 3080),
    service: process.env.DSH_SERVICE_UNIT ?? 'dsh-web.service',
    profile: process.env.DSH_PROFILE ?? 'web',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--no-color') options.color = false
    else if (arg === '--color') options.color = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--version') options.printVersion = true
    else if (arg === '--home') options.home = argv[(index += 1)] ?? ''
    else if (arg.startsWith('--home=')) options.home = arg.slice('--home='.length)
    else if (arg === '--port') options.port = Number(argv[(index += 1)] ?? NaN)
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length))
    else if (arg === '--service') options.service = argv[(index += 1)] ?? options.service
    else if (arg.startsWith('--service=')) options.service = arg.slice('--service='.length)
    else if (arg === '--profile') options.profile = argv[(index += 1)] ?? options.profile
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else {
      process.stderr.write(`doctor: unknown option ${arg}\n`)
      process.exit(2)
    }
  }
  return options
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: doctor.mjs [options]',
      '',
      'Enpoi Harness host diagnostics: service and HTTP health, host and disk state,',
      'credentials, providers and API keys, recurring errors, journal, and sessions.',
      '',
      'Options:',
      '  --json              print a machine-readable JSON report',
      '  --strict            exit non-zero on warnings as well as errors',
      '  --no-color          disable ANSI color even on a terminal',
      '  --home <path>       DSH_HOME (default: $DSH_HOME or ~/.dsh)',
      '  --port <port>       local web port (default: $DSH_PORT or 3080)',
      '  --service <unit>    systemd user unit (default: $DSH_SERVICE_UNIT or dsh-web.service)',
      '  --profile <name>    profile whose settings/cordis files are inspected (default: web)',
      '  -h, --help          print this help',
      '  --version           print the doctor version',
      '',
    ].join('\n'),
  )
}

function run(command, args, { timeout = 5000 } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error,
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'n/a'
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${total}s`
}

function stripQuotes(value) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

function truncate(value, max) {
  const text = String(value)
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function formatStamp(milliseconds) {
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').slice(0, 16) : 'unknown time'
}

/** Top-level YAML keys mapped to their raw block lines; a purpose-built read of settings.yaml, not a YAML parser. */
function parseTopLevelBlocks(text) {
  const blocks = new Map()
  let key = null
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(line)
    if (match) {
      key = match[1]
      blocks.set(key, [])
      continue
    }
    if (key !== null) blocks.get(key).push(line)
  }
  return blocks
}

function parseSettings(text) {
  const blocks = parseTopLevelBlocks(text)
  const providers = []
  const piAi = blocks.get('llm-pi-ai') ?? []
  let inProviders = false
  let current = null
  const flush = () => {
    if (current !== null) providers.push(current)
    current = null
  }
  for (const line of piAi) {
    if (/^ {2}providers:\s*$/.test(line)) {
      inProviders = true
      continue
    }
    if (!inProviders) continue
    const head = /^ {4}([A-Za-z0-9_.@-]+):\s*$/.exec(line)
    if (head) {
      flush()
      current = { id: head[1], displayName: null, apiKeyEnv: null, baseURL: null, models: 0 }
      continue
    }
    if (/^ {2}\S/.test(line)) break
    if (current === null) continue
    if (/^ {6}- id:/.test(line)) current.models += 1
    const display = /^ {6}displayName:\s*(.+)$/.exec(line)
    if (display) current.displayName = stripQuotes(display[1])
    const env = /^ {6}apiKeyEnv:\s*(.+)$/.exec(line)
    if (env) current.apiKeyEnv = stripQuotes(env[1])
    const base = /^ {6}baseURL:\s*(.+)$/.exec(line)
    if (base) current.baseURL = stripQuotes(base[1])
  }
  flush()
  for (const [topKey, block] of blocks) {
    if (!topKey.startsWith('llm-') || topKey === 'llm-pi-ai') continue
    const env = block.map(line => /^ {2}apiKeyEnv:\s*(.+)$/.exec(line)).find(Boolean)
    providers.push({
      id: topKey.replace(/^llm-/, ''),
      displayName: topKey,
      apiKeyEnv: env ? stripQuotes(env[1]) : null,
      baseURL: null,
      models: block.filter(line => /^ {2}- id:/.test(line)).length,
    })
  }
  const defaultBlock = blocks.get('agent-default-model') ?? []
  const provider = defaultBlock.map(line => /^ {2}provider:\s*(.+)$/.exec(line)).find(Boolean)
  const model = defaultBlock.map(line => /^ {2}model:\s*(.+)$/.exec(line)).find(Boolean)
  const defaultModel = provider
    ? { provider: stripQuotes(provider[1]), model: model ? stripQuotes(model[1]) : null }
    : null
  return { providers, defaultModel }
}

function parseCredentialRefs(text) {
  const refs = []
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^[A-Za-z0-9_-]+:/.test(line)) break
    const match = /^ {2}([A-Za-z0-9_.-]+):/.exec(line)
    if (match) refs.push(match[1])
  }
  return refs
}

function parseEnvFile(text) {
  const entries = {}
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match) entries[match[1]] = stripQuotes(match[2])
  }
  return entries
}

function detectSearchProvider(home, profile, settingsText) {
  const candidates = [
    join(home, 'profiles', profile, 'cordis.patch.yml'),
    join(home, 'profiles', profile, 'cordis.yml'),
    join(home, 'cordis.patch.yml'),
  ]
  for (const file of candidates) {
    const text = readText(file)
    if (text === null) continue
    const search = /searchProvider:\s*['"]?([A-Za-z0-9_-]+)/.exec(text)
    if (search) {
      const fetch = /fetchProvider:\s*['"]?([A-Za-z0-9_-]+)/.exec(text)
      return { provider: search[1], fetchProvider: fetch ? fetch[1] : null, source: file }
    }
  }
  if (settingsText !== null) {
    const search = /searchProvider:\s*['"]?([A-Za-z0-9_-]+)/.exec(settingsText)
    if (search) return { provider: search[1], fetchProvider: null, source: 'settings.yaml' }
  }
  return null
}

async function probeHttp(url, timeoutMs = 3000) {
  const started = performance.now()
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
  try {
    await response.arrayBuffer()
  } catch {
    // A failed body read still leaves the status and latency meaningful.
  }
  return { status: response.status, latencyMs: Math.round((performance.now() - started) * 10) / 10 }
}

async function rpcProbe(port, timeoutMs = 3000) {
  const response = await fetch(`http://127.0.0.1:${port}/api/llm.providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'ds-doctor', method: 'llm.providers', payload: {} }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) return { ok: false, status: response.status, note: oneLine(text).slice(0, 80) }
  try {
    const payload = JSON.parse(text)
    const providers = payload?.result?.value?.providers
    if (providers !== undefined && providers !== null) return { ok: true, providers }
  } catch {
    // Fall through to the unexpected-response result.
  }
  return { ok: false, status: response.status, note: 'unrecognized RPC response' }
}

function loadSqlite() {
  const deferred = []
  // Replace Node's default warning printer so the expected SQLite
  // experimental warning does not pollute the report; other warnings are
  // printed after the checks finish.
  process.removeAllListeners('warning')
  process.on('warning', warning => {
    if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return
    deferred.push(warning)
  })
  return import('node:sqlite').then(module => ({
    DatabaseSync: module.DatabaseSync,
    flush: () => {
      for (const warning of deferred) process.stderr.write(`doctor: warning: ${warning.message}\n`)
    },
  }))
}

function collectSessionInventory(sessionsDir) {
  let projects = 0
  let sessions = 0
  for (const project of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    projects += 1
    const projectPath = join(sessionsDir, project.name)
    let children = []
    try {
      children = readdirSync(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      try {
        const files = readdirSync(join(projectPath, child.name))
        if (files.some(name => name.startsWith('session.'))) sessions += 1
      } catch {
        // Unreadable session directories are skipped rather than failing the count.
      }
    }
  }
  return { projects, sessions }
}

function diskReport(path) {
  const stats = statfsSync(path)
  const used = stats.blocks - stats.bfree
  const total = used + stats.bavail
  const percent = total > 0 ? (used / total) * 100 : 0
  return { path, totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize, usedPercent: percent }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return 0
  }
  if (options.printVersion === true) {
    process.stdout.write(`dsh doctor ${VERSION}\n`)
    return 0
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    process.stderr.write(`doctor: invalid port ${options.port}; expected 1-65535\n`)
    return 2
  }
  const home = resolve(options.home !== '' ? options.home : join(homedir(), '.dsh'))
  const checks = []
  const suggestions = new Set()
  const data = {}
  const add = (section, label, status, detail, extra = {}) => {
    checks.push({ section, label, status, detail, ...extra })
    if (extra.suggestion !== undefined) suggestions.add(extra.suggestion)
  }
  const guard = async (section, label, fn) => {
    try {
      await fn()
    } catch (error) {
      add(section, label, 'warn', `check failed: ${oneLine(error?.message ?? error)}`)
    }
  }

  // ── Service & HTTP ────────────────────────────────────────────────────────
  let serviceStartMs = NaN
  await guard('Service & HTTP', 'systemd service', () => {
    if (platform() !== 'linux') {
      add('Service & HTTP', 'systemd service', 'skip', `systemctl checks are Linux-only (running ${platform()})`)
      return
    }
    const show = run('systemctl', [
      '--user', 'show', options.service,
      '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'MemoryCurrent',
      '-p', 'ActiveEnterTimestamp', '-p', 'NRestarts', '-p', 'ExecMainStatus',
    ])
    if (!show.ok) {
      add('Service & HTTP', options.service, 'warn', `systemctl show failed: ${oneLine(show.stderr || show.error?.message || 'unknown error')}`)
      return
    }
    const properties = Object.fromEntries(
      show.stdout.split('\n').filter(Boolean).map(line => {
        const separator = line.indexOf('=')
        return separator === -1 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
      }),
    )
    const activeState = properties.ActiveState ?? 'unknown'
    const subState = properties.SubState ?? ''
    const pid = properties.MainPID ?? '0'
    const memory = properties.MemoryCurrent ?? '0'
    const activeEnter = properties.ActiveEnterTimestamp ?? ''
    const restarts = properties.NRestarts ?? '0'
    const execStatus = properties.ExecMainStatus ?? '0'
    const startMs = Date.parse(activeEnter ?? '')
    if (Number.isFinite(startMs)) serviceStartMs = startMs
    data.service = {
      unit: options.service,
      activeState,
      subState,
      pid: Number(pid) > 0 ? Number(pid) : null,
      memoryBytes: Number(memory) > 0 ? Number(memory) : null,
      startedAt: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
      restarts: Number(restarts) || 0,
      execMainStatus: Number(execStatus),
    }
    if (activeState === 'active') {
      const uptimeSeconds = Number.isFinite(startMs) ? (Date.now() - startMs) / 1000 : NaN
      add(
        'Service & HTTP',
        options.service,
        'ok',
        `active (${subState}), PID ${data.service.pid ?? 'n/a'}, ${humanBytes(data.service.memoryBytes)}, up ${humanDuration(uptimeSeconds)}, restarts ${data.service.restarts}`,
      )
    } else {
      add(
        'Service & HTTP',
        options.service,
        'error',
        `${activeState}${subState && subState !== activeState ? ` (${subState})` : ''}, exec status ${execStatus}`,
        { suggestion: `start the service: systemctl --user start ${options.service} (or: ds start)` },
      )
    }
  })

  const localUrl = `http://127.0.0.1:${options.port}/`
  let httpReachable = false
  await guard('Service & HTTP', 'local HTTP', async () => {
    try {
      const probe = await probeHttp(localUrl)
      data.http = { url: localUrl, status: probe.status, latencyMs: probe.latencyMs }
      if (probe.status >= 500) {
        add('Service & HTTP', `local HTTP :${options.port}`, 'error', `${probe.status} in ${probe.latencyMs} ms`, {
          suggestion: `inspect the server: journalctl --user -u ${options.service} -n 50 --no-pager`,
        })
      } else {
        httpReachable = true
        const auth = probe.status === 401 || probe.status === 403 ? '; authentication required' : ''
        add('Service & HTTP', `local HTTP :${options.port}`, 'ok', `HTTP ${probe.status} in ${probe.latencyMs} ms (reachable${auth})`)
      }
    } catch (error) {
      data.http = { url: localUrl, error: oneLine(error?.message ?? error) }
      add('Service & HTTP', `local HTTP :${options.port}`, 'error', `unreachable: ${oneLine(error?.message ?? error)}`, {
        suggestion: `check the service and port: ds status; ss -ltnp | grep :${options.port}`,
      })
    }
  })

  // ── Host & Environment ────────────────────────────────────────────────────
  await guard('Host & Environment', 'Node.js runtime', () => {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
    const supported = major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1])
    data.node = { version: process.version, execPath: process.execPath, minimum: MINIMUM_NODE.join('.') }
    add(
      'Host & Environment',
      'Node.js runtime',
      supported ? 'ok' : 'error',
      `${process.version} (requires >=${MINIMUM_NODE.join('.')}) at ${process.execPath}`,
      supported ? {} : { suggestion: `install Node.js >=${MINIMUM_NODE.join('.')} (nvm install ${MINIMUM_NODE.join('.')})` },
    )
  })

  await guard('Host & Environment', 'platform', () => {
    const cpu = cpus()
    data.host = {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      arch: arch(),
      cpuModel: cpu[0]?.model ?? 'unknown',
      cpuCount: cpu.length,
      uptimeSeconds: osUptime(),
    }
    add(
      'Host & Environment',
      'platform',
      'ok',
      `${platform()} ${release()} ${arch()}, ${cpu.length} CPUs, up ${humanDuration(osUptime())}`,
    )
  })

  for (const [label, target] of [
    [`disk ${home}`, home],
    ['disk /', '/'],
  ]) {
    await guard('Host & Environment', label, () => {
      let disk = null
      try {
        disk = diskReport(target)
      } catch (error) {
        add('Host & Environment', label, 'warn', `statfs failed: ${oneLine(error?.message ?? error)}`)
        return
      }
      data[label] = disk
      const percent = Math.round(disk.usedPercent * 10) / 10
      const status = disk.usedPercent >= 97 ? 'error' : disk.usedPercent >= 90 ? 'warn' : 'ok'
      add('Host & Environment', label, status, `${humanBytes(disk.freeBytes)} free of ${humanBytes(disk.totalBytes)} (${percent}% used)`, status === 'ok' ? {} : { suggestion: `free disk space on ${target} (currently ${percent}% used)` })
    })
  }

  const credentialsPath = join(home, '.credentials.yaml')
  let credentialRefs = []
  await guard('Host & Environment', 'credentials file', () => {
    if (!existsSync(credentialsPath)) {
      add('Host & Environment', 'credentials file', 'warn', `missing ${credentialsPath}`, {
        suggestion: 'configure providers (or re-run the installer) to create $DSH_HOME/.credentials.yaml',
      })
      return
    }
    const mode = statSync(credentialsPath).mode & 0o777
    const text = readText(credentialsPath) ?? ''
    credentialRefs = parseCredentialRefs(text)
    data.credentials = { path: credentialsPath, mode: mode.toString(8), refs: credentialRefs }
    if ((mode & 0o077) !== 0) {
      add('Host & Environment', 'credentials file', 'warn', `${credentialsPath} is mode ${mode.toString(8)}; secret files must be 0600`, {
        suggestion: `chmod 600 ${credentialsPath} (or: ds heal)`,
      })
    } else {
      add('Host & Environment', 'credentials file', 'ok', `${credentialsPath} (mode ${mode.toString(8)}, ${credentialRefs.length} refs)`)
    }
  })

  const envPath = join(home, '.env')
  let launchEnv = {}
  await guard('Host & Environment', 'launch .env', () => {
    const text = readText(envPath)
    if (text === null) {
      data.env = { path: envPath, exists: false, keys: [] }
      add('Host & Environment', 'launch .env', 'info', `missing ${envPath} (provider keys may still come from the process environment)`)
      return
    }
    launchEnv = parseEnvFile(text)
    const mode = statSync(envPath).mode & 0o777
    data.env = { path: envPath, exists: true, mode: mode.toString(8), keys: Object.keys(launchEnv) }
    if ((mode & 0o077) !== 0) {
      add('Host & Environment', 'launch .env', 'warn', `${envPath} is mode ${mode.toString(8)}; it holds API keys and should be 0600`, {
        suggestion: `chmod 600 ${envPath}`,
      })
    } else {
      add('Host & Environment', 'launch .env', 'ok', `${envPath} (mode ${mode.toString(8)}, ${Object.keys(launchEnv).length} keys)`)
    }
  })

  // ── Providers & Keys ──────────────────────────────────────────────────────
  const settingsCandidates = [join(home, 'settings.yaml'), join(home, 'profiles', options.profile, 'settings.yaml')]
  const settingsPath = settingsCandidates.find(path => existsSync(path)) ?? null
  let providers = []
  let defaultModel = null
  await guard('Providers & Keys', 'settings.yaml', () => {
    if (settingsPath === null) {
      add('Providers & Keys', 'settings.yaml', 'warn', `no settings.yaml under ${home} (checked root and profiles/${options.profile})`, {
        suggestion: `boot the ${options.profile} profile once to create $DSH_HOME/profiles/${options.profile}/settings.yaml`,
      })
      return
    }
    const parsed = parseSettings(readText(settingsPath) ?? '')
    providers = parsed.providers
    defaultModel = parsed.defaultModel
    data.settings = { path: settingsPath }
    add('Providers & Keys', 'settings.yaml', 'ok', settingsPath)
  })

  const keyPresent = name => credentialRefs.includes(name) || launchEnv[name] !== undefined || process.env[name] !== undefined
  await guard('Providers & Keys', 'LLM providers', () => {
    if (providers.length === 0) {
      add('Providers & Keys', 'LLM providers', 'warn', 'no LLM providers configured', {
        suggestion: `add a provider to ${settingsPath ?? '$DSH_HOME/settings.yaml'} or run the web setup wizard`,
      })
      return
    }
    const rows = providers.map(provider => ({
      ...provider,
      keyPresent: provider.apiKeyEnv === null ? null : keyPresent(provider.apiKeyEnv),
    }))
    data.providers = rows
    const withModels = rows.reduce((sum, provider) => sum + provider.models, 0)
    const missing = rows.filter(provider => provider.keyPresent === false)
    const summary = rows
      .slice(0, 10)
      .map(provider => {
        const key = provider.apiKeyEnv === null ? 'no env key' : provider.keyPresent ? `${provider.apiKeyEnv} set` : `${provider.apiKeyEnv} MISSING`
        return `${provider.id} (${provider.models} models, ${key})`
      })
    if (rows.length > 10) summary.push(`+${rows.length - 10} more`)
    add(
      'Providers & Keys',
      'LLM providers',
      missing.length > 0 ? 'warn' : 'ok',
      `${rows.length} configured, ${withModels} models${missing.length > 0 ? `, ${missing.length} missing keys` : ''}`,
      {
        lines: summary,
        suggestion: missing.length > 0
          ? `set ${missing.map(provider => provider.apiKeyEnv).join(', ')} in the process environment or $DSH_HOME/.env`
          : undefined,
      },
    )
  })

  await guard('Providers & Keys', 'default model', () => {
    if (defaultModel === null) {
      add('Providers & Keys', 'default model', 'info', 'agent-default-model is not set')
      return
    }
    data.defaultModel = defaultModel
    const provider = providers.find(candidate => candidate.id === defaultModel.provider)
    if (provider === undefined && providers.length > 0) {
      add('Providers & Keys', 'default model', 'warn', `${defaultModel.provider}/${defaultModel.model ?? '?'} names an unknown provider`, {
        suggestion: `pick a configured provider for agent-default-model in settings.yaml`,
      })
    } else {
      add('Providers & Keys', 'default model', 'ok', `${defaultModel.provider}/${defaultModel.model ?? '?'}`)
    }
  })

  await guard('Providers & Keys', 'credential vault', () => {
    if (credentialRefs.length === 0) {
      add('Providers & Keys', 'credential vault', 'info', 'no credential refs recorded')
      return
    }
    add('Providers & Keys', 'credential vault', 'ok', `${credentialRefs.length} refs: ${credentialRefs.slice(0, 8).join(', ')}${credentialRefs.length > 8 ? ` +${credentialRefs.length - 8} more` : ''}`)
  })

  await guard('Providers & Keys', 'web search keys', () => {
    const present = WEB_KEY_NAMES.filter(name => keyPresent(name))
    data.webKeys = present
    add(
      'Providers & Keys',
      'web search keys',
      present.length > 0 ? 'ok' : 'warn',
      present.length > 0 ? `set: ${present.join(', ')}` : `none of ${WEB_KEY_NAMES.join(', ')} are set`,
      present.length > 0 ? {} : { suggestion: 'set EXA_API_KEY (or another search key) in $DSH_HOME/.env' },
    )
  })

  await guard('Providers & Keys', 'web search provider', () => {
    const detected = detectSearchProvider(home, options.profile, settingsPath === null ? null : readText(settingsPath))
    if (detected === null) {
      add('Providers & Keys', 'web search provider', 'info', 'not declared in profile cordis files or settings.yaml')
      return
    }
    data.webSearch = detected
    const expected = SEARCH_KEY_ENV[detected.provider] ?? null
    const present = expected === null ? null : keyPresent(expected)
    add(
      'Providers & Keys',
      'web search provider',
      present === false ? 'warn' : 'ok',
      `${detected.provider}${detected.fetchProvider ? ` (fetch: ${detected.fetchProvider})` : ''}${expected === null ? '' : present ? `, ${expected} set` : `, ${expected} MISSING`}`,
      present === false ? { suggestion: `set ${expected} in the process environment or $DSH_HOME/.env` } : {},
    )
  })

  await guard('Providers & Keys', 'live RPC', async () => {
    if (!httpReachable) {
      add('Providers & Keys', 'live RPC', 'skip', 'server not reachable; used settings.yaml instead')
      return
    }
    try {
      const probe = await rpcProbe(options.port)
      if (probe.ok) {
        data.rpc = { providers: probe.providers.length }
        add('Providers & Keys', 'live RPC', 'ok', `llm.providers returned ${probe.providers.length} providers`)
      } else {
        data.rpc = { status: probe.status, note: probe.note }
        add('Providers & Keys', 'live RPC', 'info', `unavailable (HTTP ${probe.status}${probe.note ? `: ${probe.note}` : ''}); settings.yaml used instead`)
      }
    } catch (error) {
      add('Providers & Keys', 'live RPC', 'info', `unavailable (${oneLine(error?.message ?? error)}); settings.yaml used instead`)
    }
  })

  // ── Diagnostics & Error Logs ──────────────────────────────────────────────
  const incidentsPath = join(home, 'diagnostics', 'incidents.sqlite')
  let sqliteFlush = null
  await guard('Diagnostics', 'incident store', async () => {
    if (!existsSync(incidentsPath)) {
      add('Diagnostics', 'incident store', 'info', `not created yet (${incidentsPath})`)
      return
    }
    data.diagnostics = { path: incidentsPath, sizeBytes: statSync(incidentsPath).size }
    add('Diagnostics', 'incident store', 'ok', `${incidentsPath} (${humanBytes(data.diagnostics.sizeBytes)})`)
    let DatabaseSync = null
    try {
      const sqlite = await loadSqlite()
      DatabaseSync = sqlite.DatabaseSync
      sqliteFlush = sqlite.flush
    } catch (error) {
      add('Diagnostics', 'patterns', 'warn', `node:sqlite unavailable (${oneLine(error?.message ?? error)})`)
      return
    }
    let database = null
    try {
      database = new DatabaseSync(incidentsPath, { readOnly: true })
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name))
      if (tables.has('patterns')) {
        const rows = database
          .prepare("SELECT fingerprint, count, severity_max, sample_message, code, kind, last_seen, muted_at FROM patterns WHERE severity_max IN ('warn', 'error', 'fatal') ORDER BY count DESC LIMIT 20")
          .all()
        const active = rows.filter(row => row.muted_at === null).slice(0, 5)
        const muted = rows.length - rows.filter(row => row.muted_at === null).length
        data.patterns = active.map(row => ({
          fingerprint: row.fingerprint,
          code: row.code,
          kind: row.kind,
          severity: row.severity_max,
          count: Number(row.count),
          lastSeen: new Date(Number(row.last_seen)).toISOString(),
          sample: oneLine(row.sample_message),
        }))
        if (active.length === 0) {
          add('Diagnostics', 'recurring patterns', 'ok', muted > 0 ? `no active warning/error patterns (${muted} muted)` : 'no warning/error patterns recorded')
        } else {
          const hasError = active.some(row => row.severity_max === 'error' || row.severity_max === 'fatal')
          const lines = active.map(row => `${String(row.severity_max).toUpperCase().padEnd(5)} ×${String(row.count).padEnd(6)} ${row.code || row.fingerprint}  ${truncate(oneLine(row.sample_message), 90)}`)
          add(
            'Diagnostics',
            'recurring patterns',
            'warn',
            `top ${active.length} recurring (${hasError ? 'includes errors' : 'warnings only'}${muted > 0 ? `, ${muted} muted` : ''})`,
            {
              lines,
              suggestion: 'review recurring errors: ds doctor --json | jq .diagnostics, then fix the top pattern',
            },
          )
        }
      } else {
        add('Diagnostics', 'recurring patterns', 'info', 'patterns table not created yet')
      }
      if (tables.has('incidents')) {
        const bySeverity = database
          .prepare('SELECT severity, COUNT(*) AS buckets, COALESCE(SUM(count), 0) AS occurrences FROM incidents WHERE at >= ? GROUP BY severity')
          .all(Date.now() - 24 * 3600 * 1000)
        data.incidents24h = bySeverity.map(row => ({ severity: row.severity, buckets: Number(row.buckets), occurrences: Number(row.occurrences) }))
        const total = bySeverity.reduce((sum, row) => sum + Number(row.occurrences), 0)
        const errors = bySeverity.filter(row => row.severity === 'error' || row.severity === 'fatal').reduce((sum, row) => sum + Number(row.occurrences), 0)
        add('Diagnostics', 'incidents (24h)', errors > 0 ? 'warn' : 'ok', errors > 0 ? `${total} occurrences, ${errors} at error/fatal severity` : `${total} occurrences, none above warning severity`)
      }
    } catch (error) {
      add('Diagnostics', 'incident store', 'warn', `could not read ${incidentsPath}: ${oneLine(error?.message ?? error)}`)
    } finally {
      database?.close()
    }
  })

  await guard('Diagnostics', 'journal errors', () => {
    if (platform() !== 'linux') {
      add('Diagnostics', 'journal errors', 'skip', 'journalctl checks are Linux-only')
      return
    }
    const result = run('journalctl', ['--user', '-u', options.service, '--priority', 'err', '-n', '10', '--no-pager', '-o', 'short-iso'], { timeout: 8000 })
    if (result.error?.code === 'ENOENT') {
      add('Diagnostics', 'journal errors', 'skip', 'journalctl is not installed')
      return
    }
    if (!result.ok && result.stdout === '') {
      add('Diagnostics', 'journal errors', 'info', `journalctl unavailable: ${oneLine(result.stderr || 'no output')}`)
      return
    }
    // journalctl prints "-- No entries --" when the unit has logged nothing.
    const lines = result.stdout.split('\n').filter(line => line !== '' && !line.startsWith('--'))
    data.journal = lines
    if (lines.length === 0) {
      add('Diagnostics', 'journal errors', 'ok', 'no error-priority journal entries')
      return
    }
    const latestMs = Date.parse(lines.at(-1).split(' ')[0])
    const historical = Number.isFinite(latestMs) && Number.isFinite(serviceStartMs) && latestMs < serviceStartMs
    add(
      'Diagnostics',
      'journal errors',
      historical ? 'info' : 'warn',
      historical
        ? `${lines.length} error line(s), all before the current service start (${formatStamp(serviceStartMs)})`
        : `${lines.length} error line(s); latest ${formatStamp(latestMs)}`,
      historical ? {} : { lines: lines.map(line => truncate(line, 150)), suggestion: `inspect recent failures: journalctl --user -u ${options.service} --priority err -n 50 --no-pager` },
    )
  })

  // ── Sessions ──────────────────────────────────────────────────────────────
  const sessionsDir = join(home, 'sessions')
  await guard('Sessions', 'session store', () => {
    if (!existsSync(sessionsDir)) {
      add('Sessions', 'session store', 'info', `no sessions directory yet (${sessionsDir})`)
      return
    }
    const inventory = collectSessionInventory(sessionsDir)
    data.sessions = inventory
    add('Sessions', 'session store', 'ok', `${inventory.sessions} sessions across ${inventory.projects} projects`)
  })

  const indexDbPath = join(home, 'cache', 'session-query', 'index.sqlite')
  await guard('Sessions', 'session query index', () => {
    if (!existsSync(indexDbPath)) {
      add('Sessions', 'session query index', 'warn', `missing ${indexDbPath}`, {
        suggestion: 'rebuild session projections: ds backfill',
      })
      return
    }
    const size = statSync(indexDbPath).size
    data.sessionIndex = { path: indexDbPath, sizeBytes: size }
    add('Sessions', 'session query index', 'ok', `${humanBytes(size)} at ${indexDbPath}`)
  })

  sqliteFlush?.()

  // ── Report ────────────────────────────────────────────────────────────────
  const summary = {
    ok: checks.filter(check => check.status === 'ok').length,
    warn: checks.filter(check => check.status === 'warn').length,
    error: checks.filter(check => check.status === 'error').length,
    info: checks.filter(check => check.status === 'info').length,
    skip: checks.filter(check => check.status === 'skip').length,
    suggestions: [...suggestions],
  }
  const report = {
    tool: 'dsh-doctor',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    home,
    host: data.host ?? null,
    node: data.node ?? null,
    checks,
    service: data.service ?? null,
    http: data.http ?? null,
    settings: data.settings ?? null,
    providers: data.providers ?? [],
    defaultModel: data.defaultModel ?? null,
    credentials: data.credentials ?? null,
    env: data.env ?? null,
    webKeys: data.webKeys ?? [],
    webSearch: data.webSearch ?? null,
    rpc: data.rpc ?? null,
    diagnostics: data.diagnostics ?? null,
    patterns: data.patterns ?? [],
    incidents24h: data.incidents24h ?? [],
    journal: data.journal ?? [],
    sessions: data.sessions ?? null,
    sessionIndex: data.sessionIndex ?? null,
    summary,
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    printHuman(report, options)
  }
  if (summary.error > 0) return 1
  if (options.strict && summary.warn > 0) return 1
  return 0
}

function printHuman(report, options) {
  const useColor = options.color ?? (process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb')
  const paint = (name, text) => (useColor && ANSI[name] !== undefined ? `${ANSI[name]}${text}${ANSI.reset}` : text)
  const line = '─'.repeat(66)
  const stamp = report.generatedAt.replace('T', ' ').slice(0, 19) + ' UTC'
  const labelWidth = Math.min(Math.max(...report.checks.map(check => check.label.length), 18) + 2, 40)

  process.stdout.write('\n')
  process.stdout.write(`${paint('bold', 'Enpoi Harness Doctor')}  ${paint('dim', stamp)}\n`)
  if (report.host !== null) {
    process.stdout.write(`${paint('dim', `${report.host.hostname} · ${report.host.platform} ${report.host.release} ${report.host.arch} · Node ${report.host.node ?? report.node?.version ?? '?'}`)}\n`)
  }
  process.stdout.write(`${paint('dim', line)}\n`)

  let section = null
  for (const check of report.checks) {
    if (check.section !== section) {
      section = check.section
      process.stdout.write(`\n${paint('bold', section)}\n`)
    }
    const glyph = paint(COLOR_NAME[check.status], GLYPH[check.status])
    process.stdout.write(`  ${glyph} ${check.label.padEnd(labelWidth)} ${check.detail}\n`)
    for (const continuation of check.lines ?? []) {
      process.stdout.write(`  ${' '.repeat(labelWidth + 2)}${paint('dim', '↳')} ${continuation}\n`)
    }
  }

  const { ok, warn, error, info, skip, suggestions } = report.summary
  process.stdout.write(`\n${paint('dim', line)}\n`)
  process.stdout.write(
    `  ${paint('green', GLYPH.ok)} ${ok} ok   ${paint('yellow', GLYPH.warn)} ${warn} warning${warn === 1 ? '' : 's'}   ${paint('red', GLYPH.error)} ${error} error${error === 1 ? '' : 's'}   ${paint('dim', `${info + skip} informational`)}\n`,
  )
  if (suggestions.length > 0) {
    process.stdout.write(`\n${paint('bold', 'Suggested next steps')}\n`)
    suggestions.forEach((suggestion, index) => {
      process.stdout.write(`  ${index + 1}. ${suggestion}\n`)
    })
  }
  process.stdout.write('\n')
}

main().then(
  code => {
    process.exitCode = code
  },
  error => {
    process.stderr.write(`doctor: unexpected failure: ${error?.stack ?? error}\n`)
    process.exitCode = 2
  },
)
