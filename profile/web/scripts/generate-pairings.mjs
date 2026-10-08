#!/usr/bin/env node
/**
 * generate-pairings.mjs — render `$DSH_HOME/pairings.yaml` on this device from
 * the profile's fleet registry (`profile/web/fleet.yaml`), so device pairings
 * change only through `dsh update`. `scripts/install.sh` runs this after every
 * profile refresh (install, update, and the already-up-to-date path).
 *
 * Alias convention
 * ----------------
 * The serving host resolves an incoming alias against its OWN pairing table
 * (`PeerPairingsStore.resolve` in `packages/api/peer/src/pairings.ts`), and the
 * wire target carries no peer discriminator, so a pairing must use the same
 * alias string in both devices' files. The fleet convention: a pairing's alias
 * names its member device — the non-hub side (the live `serverlocal` file:
 * `alias: macbook`/`peer: macbook`, `alias: pc`/`peer: pc`). The hub's own
 * alias is never used; on a member device the entry for the hub carries that
 * member's alias, so one alias string resolves the pairing in both directions.
 * The member named by the alias also supplies the entry's `exposure` and
 * `create.agentPreset`.
 *
 * Safety
 * ------
 * The rendered document is validated with the harness peer package's own
 * `parsePairingsDocument` before any write; a rejection keeps the previous
 * file and only warns. Writes are atomic and 0600, and the previous file is
 * backed up beside the target first. A document whose first line is
 * `# dsh-managed: false` belongs to the operator and is never touched. The
 * script always exits 0: a missing registry, an unknown local device, or a
 * missing validator leaves `pairings.yaml` exactly as it was and never fails
 * an install or update.
 *
 * Environment
 * -----------
 * `DSH_HOME` (default `~/.dsh`), `DSH_PEER_DEVICE` (local member override),
 * `DSH_PEER_REGISTRY`, `DSH_PEER_PAIRINGS`, `DSH_PEER_PORT` (default 3080),
 * `DSH_HARNESS`/`DSH_HARNESS_ROOT` (harness tree carrying the peer package;
 * default `$DSH_HOME/harness/current`).
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** First line of a file this generator owns and may replace. */
export const MANAGED_MARKER = '# dsh-managed: true'
/** First line of a file the operator owns; generation is skipped entirely. */
export const OPT_OUT_MARKER = '# dsh-managed: false'

/** Exposures the peer document accepts. */
const EXPOSURES = ['answer-only', 'debug']
/** The peer document's alias grammar (`packages/api/peer/src/pairings.ts`). */
const ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/
/** Default preset for a member whose record names none. */
const DEFAULT_CREATE_PRESET = 'orchestrator'
/** Default web port of a managed install; a member record may override it. */
const DEFAULT_PORT = 3080

/** The registry path shipped beside this script. */
export const DEFAULT_REGISTRY_PATH = fileURLToPath(new URL('../fleet.yaml', import.meta.url))

function defaultDshHome() {
  const home = process.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}

function defaultHarnessRoot() {
  const configured = process.env.DSH_HARNESS ?? process.env.DSH_HARNESS_ROOT
  return configured !== undefined && configured !== '' ? configured : join(defaultDshHome(), 'harness', 'current')
}

function defaultLogger() {
  return {
    log: (message) => { process.stderr.write(`pairings: ${message}\n`) },
    warn: (message) => { process.stderr.write(`pairings: WARNING: ${message}\n`) },
  }
}

function firstLine(raw) {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return withoutBom.split(/\r?\n/u, 1)[0]?.trim() ?? ''
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value, subject) {
  if (value === undefined || value === null) return undefined
  assert(typeof value === 'string' && value.length > 0, `${subject} must be a non-empty string when present`)
  return value
}

/**
 * Validate one parsed fleet registry document. The schema is strict so a typo
 * degrades to "pairings left untouched plus a warning", never to a partial or
 * differently-addressed table.
 * @param parsed - the parsed YAML document.
 * @param path - registry path for diagnostics.
 * @returns the normalized registry `{ version, hub, members }`.
 */
export function validateRegistry(parsed, path) {
  assert(isRecord(parsed), `fleet registry ${path} must be a YAML mapping`)
  assert(parsed.version === 1, `fleet registry ${path} must declare version: 1`)
  const hub = parsed.hub
  assert(typeof hub === 'string' && hub.length > 0, `fleet registry ${path}: hub must name a member`)
  assert(Array.isArray(parsed.members) && parsed.members.length > 0, `fleet registry ${path}: members must be a non-empty list`)
  const members = parsed.members.map((member, index) => {
    const subject = `${path}#members[${String(index)}]`
    assert(isRecord(member), `${subject} must be a mapping`)
    const name = member.name
    assert(typeof name === 'string' && name.length > 0, `${subject}: name must be a non-empty string`)
    const alias = member.alias === undefined || member.alias === null ? name : member.alias
    assert(typeof alias === 'string' && ALIAS_PATTERN.test(alias), `${subject}: alias must match [A-Za-z0-9._-]+ (received ${JSON.stringify(alias)})`)
    const exposure = member.exposure
    assert(EXPOSURES.includes(exposure), `${subject}: exposure must be answer-only or debug (received ${JSON.stringify(exposure)})`)
    const create = member.create === undefined || member.create === null ? DEFAULT_CREATE_PRESET : member.create
    assert(typeof create === 'string' && create.length > 0, `${subject}: create must be a non-empty string when present`)
    const hostnames = member.hostnames === undefined || member.hostnames === null ? [] : member.hostnames
    assert(Array.isArray(hostnames) && hostnames.every(entry => typeof entry === 'string' && entry.length > 0), `${subject}: hostnames must be a list of non-empty strings when present`)
    const ip = optionalString(member.ip, `${subject}: ip`)
    const port = member.port
    assert(port === undefined || port === null || (Number.isSafeInteger(port) && port > 0 && port < 65536), `${subject}: port must be an integer in 1..65535 when present`)
    return { name, alias, exposure, create, hostnames, ip, ...(port === undefined || port === null ? {} : { port }) }
  })
  const names = new Set()
  const aliases = new Set()
  for (const member of members) {
    assert(!names.has(member.name), `fleet registry ${path}: repeats member name ${JSON.stringify(member.name)}`)
    names.add(member.name)
    assert(!aliases.has(member.alias), `fleet registry ${path}: repeats alias ${JSON.stringify(member.alias)}; pairing aliases are global`)
    aliases.add(member.alias)
  }
  assert(names.has(hub), `fleet registry ${path}: hub ${JSON.stringify(hub)} is not a member`)
  return { version: 1, hub, members }
}

function wildcardMatch(candidate, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '.*').replace(/\?/gu, '.')
  return new RegExp(`^${escaped}$`, 'iu').test(candidate)
}

/** Whether one member's name or hostname patterns identify any candidate. */
function memberMatchesCandidate(member, candidates) {
  for (const candidate of candidates) {
    for (const pattern of [member.name, ...member.hostnames]) {
      if (wildcardMatch(candidate, pattern)) return true
    }
  }
  return false
}

/**
 * Identify this device's member. `device` (from `DSH_PEER_DEVICE`) names the
 * member directly; otherwise every hostname candidate (the OS hostname and its
 * short form, plus the Tailscale self names) is matched against each member's
 * name and hostname patterns. An ambiguous match is refused rather than
 * guessed.
 * @param registry - validated registry.
 * @param options - device override and hostname candidates.
 * @returns the local member.
 * @throws when no member — or more than one — matches.
 */
export function identifyLocalMember(registry, options = {}) {
  const device = options.device
  if (device !== undefined && device !== '') {
    const found = registry.members.find(member => member.name.toLowerCase() === device.toLowerCase())
    assert(found !== undefined, `DSH_PEER_DEVICE=${JSON.stringify(device)} is not a fleet member`)
    return found
  }
  const candidates = (options.hostnames ?? []).filter(candidate => candidate !== '')
    .flatMap(candidate => [candidate, candidate.split('.', 1)[0]])
  const matches = registry.members.filter(member => memberMatchesCandidate(member, candidates))
  assert(matches.length > 0, `no fleet member matches this host (${candidates.join(', ')}); set DSH_PEER_DEVICE`)
  assert(matches.length === 1, `this host matches ${matches.map(member => member.name).join(', ')}; set DSH_PEER_DEVICE`)
  return matches[0]
}

function ipv4Of(value) {
  return typeof value === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value) ? value : undefined
}

function namesOfPeer(record) {
  const names = new Set()
  if (typeof record.HostName === 'string' && record.HostName !== '') names.add(record.HostName)
  if (typeof record.DNSName === 'string' && record.DNSName !== '') {
    const bare = record.DNSName.replace(/\.$/u, '')
    names.add(bare)
    const label = bare.split('.', 1)[0]
    if (label !== '') names.add(label)
  }
  return [...names]
}

function ipsOfPeer(record) {
  const ips = Array.isArray(record.TailscaleIPs) ? record.TailscaleIPs : []
  return ips.map(ipv4Of).filter(ip => ip !== undefined)
}

/**
 * Read this tailnet's member names and IPv4s from `tailscale status --json`.
 * The registry IP is the fallback when Tailscale is absent or does not know
 * the member; a failed probe is a normal condition, never an error.
 * @returns `{ selfNames, ips }` with lowercased name keys.
 */
export function collectTailnetFacts(options = {}) {
  const run = options.run ?? ((command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 }))
  const facts = { selfNames: [], ips: new Map() }
  let status
  try {
    const result = run('tailscale', ['status', '--json'])
    if (result.status !== 0 || typeof result.stdout !== 'string') return facts
    status = JSON.parse(result.stdout)
  } catch {
    return facts
  }
  if (!isRecord(status)) return facts
  const peers = isRecord(status.Peer) ? Object.values(status.Peer) : []
  for (const record of peers) {
    if (!isRecord(record)) continue
    const ip = ipsOfPeer(record)[0]
    if (ip === undefined) continue
    for (const name of namesOfPeer(record)) facts.ips.set(name.toLowerCase(), ip)
  }
  if (isRecord(status.Self)) facts.selfNames = namesOfPeer(status.Self)
  return facts
}

function commandIpv4(run, name) {
  try {
    const result = run('tailscale', ['ip', '-4', name])
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
    return result.stdout.split(/\r?\n/u).map(line => ipv4Of(line.trim())).find(ip => ip !== undefined)
  } catch {
    return undefined
  }
}

/**
 * Resolve one remote member's endpoint address: the live tailnet IPv4 first
 * (status index, then `tailscale ip -4 <name>`), then the registry fallback.
 * @returns the IPv4, or undefined when neither source answers.
 */
export function resolveMemberIp(member, facts, run) {
  const indexed = facts.ips.get(member.name.toLowerCase())
  if (indexed !== undefined) return indexed
  for (const pattern of member.hostnames) {
    if (pattern.includes('*') || pattern.includes('?')) continue
    const found = facts.ips.get(pattern.toLowerCase())
    if (found !== undefined) return found
  }
  const probed = commandIpv4(run, member.name)
  if (probed !== undefined) return probed
  return member.ip
}

function yamlScalar(value) {
  // Plain scalar when it starts with an alphanumeric and carries no YAML
  // indicator risk (`: ` or ` #` would change the meaning; the value never
  // carries those).
  return /^[A-Za-z0-9][A-Za-z0-9._@/:-]*$/u.test(value) ? value : JSON.stringify(value)
}

/** A usable port; an unset or malformed override falls back to the managed port. */
function positivePort(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT
}

/**
 * The member whose registry record governs one entry: the pairing's alias
 * names the non-hub side, so the entry for the hub on a member device carries
 * the member's own record, and every other entry carries the remote member's.
 * @param local - this device's member.
 * @param remote - the other member the entry addresses.
 * @param hub - the registry's hub member name.
 * @returns the record supplying alias, exposure, and create preset.
 */
export function aliasOwnerFor(local, remote, hub) {
  if (local.name === hub) return remote
  if (remote.name === hub) return local
  return remote
}

/**
 * Render the pairing document for one device. Entries keep registry order so a
 * re-run is byte-identical; the caller must already have resolved every
 * remote's IPv4.
 * @param registry - validated registry.
 * @param options - `local` member, `ips` map (name -> IPv4), and default port.
 * @returns the complete YAML document text.
 */
export function renderPairingsDocument(registry, options) {
  const { local, ips } = options
  const defaultPort = positivePort(options.port ?? DEFAULT_PORT)
  const lines = [
    MANAGED_MARKER,
    '# Generated by dsh update from the profile fleet registry; local edits are replaced.',
    `# Set the first line to \`${OPT_OUT_MARKER}\` to take ownership of this file.`,
    'version: 1',
    `device: ${yamlScalar(local.name)}`,
    'pairings:',
  ]
  for (const remote of registry.members) {
    if (remote.name === local.name) continue
    const owner = aliasOwnerFor(local, remote, registry.hub)
    const ip = ips.get(remote.name)
    assert(ip !== undefined, `no tailnet IPv4 for member ${remote.name} and no registry fallback`)
    const port = remote.port ?? defaultPort
    lines.push(
      `  - alias: ${yamlScalar(owner.alias)}`,
      `    peer: ${yamlScalar(remote.name)}`,
      `    exposure: ${yamlScalar(owner.exposure)}`,
      `    endpoint: ${yamlScalar(`http://${ip}:${String(port)}`)}`,
      '    create:',
      `      agentPreset: ${yamlScalar(owner.create)}`,
    )
  }
  return `${lines.join('\n')}\n`
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
}

function backupExisting(path) {
  const backup = `${path}.backup-${timestamp()}`
  copyFileSync(path, backup)
  // The document may carry pairing tokens; the backup never inherits a looser mode.
  chmodSync(backup, 0o600)
  return backup
}

function writePairingsAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.dsh-tmp-${String(process.pid)}`
  try {
    writeFileSync(tmp, content, { mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/**
 * Load the harness peer package's validator and the `yaml` parser from the
 * tree being installed. Both resolve from the peer package so the validator is
 * exactly the parser that will read the document at runtime.
 * @param harnessRoot - harness tree carrying `packages/api/peer`.
 * @returns `{ parseYaml, parsePairingsDocument }` or undefined when unavailable.
 */
export async function loadHarnessParser(harnessRoot) {
  const peerDir = join(harnessRoot, 'packages', 'api', 'peer')
  if (!existsSync(join(peerDir, 'lib', 'index.js'))) return undefined
  try {
    const require = createRequire(join(peerDir, 'package.json'))
    const yaml = require('yaml')
    if (typeof yaml?.parse !== 'function') return undefined
    const peer = await import(pathToFileURL(join(peerDir, 'lib', 'index.js')).href)
    if (typeof peer.parsePairingsDocument !== 'function') return undefined
    return { parseYaml: yaml.parse, parsePairingsDocument: peer.parsePairingsDocument }
  } catch {
    return undefined
  }
}

/**
 * Generate the local pairing document.
 * @param options - every path, identity, and collaborator is injectable; the
 *   defaults read the environment and the live tailnet.
 * @returns `{ action, path, reason?, entries?, backup? }`; `action` is
 *   `written`, `unchanged`, `skipped`, or `rejected`.
 */
export async function generatePairings(options = {}) {
  const logger = options.logger ?? defaultLogger()
  const registryPath = options.registryPath ?? process.env.DSH_PEER_REGISTRY ?? DEFAULT_REGISTRY_PATH
  const pairingsPath = options.pairingsPath ?? process.env.DSH_PEER_PAIRINGS ?? join(defaultDshHome(), 'pairings.yaml')
  const port = positivePort(options.port ?? process.env.DSH_PEER_PORT ?? DEFAULT_PORT)
  const parsePairings = options.parsePairings
  let existing
  try {
    existing = readFileSync(pairingsPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`cannot read ${pairingsPath}: ${error.message}; leaving it untouched`)
      return { action: 'skipped', path: pairingsPath, reason: 'unreadable-target' }
    }
    existing = undefined
  }
  if (existing !== undefined && firstLine(existing).startsWith(OPT_OUT_MARKER)) {
    logger.log(`${pairingsPath} is operator-owned (${OPT_OUT_MARKER}); leaving it untouched`)
    return { action: 'skipped', path: pairingsPath, reason: 'operator-marker' }
  }
  if (!existsSync(registryPath) && options.registry === undefined) {
    logger.log(`no fleet registry at ${registryPath}; ${pairingsPath} left untouched`)
    return { action: 'skipped', path: pairingsPath, reason: 'no-registry' }
  }
  let registry
  try {
    if (options.registry !== undefined) {
      registry = validateRegistry(options.registry, registryPath)
    } else {
      const parseYaml = options.parseYaml
      if (typeof parseYaml !== 'function') throw new Error('no YAML parser available')
      registry = validateRegistry(parseYaml(readFileSync(registryPath, 'utf8')), registryPath)
    }
  } catch (error) {
    logger.warn(`fleet registry rejected: ${error.message}; ${pairingsPath} left untouched`)
    return { action: 'skipped', path: pairingsPath, reason: 'registry-invalid' }
  }
  const run = options.run ?? ((command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 }))
  const facts = options.facts ?? collectTailnetFacts({ run: options.run })
  let local
  try {
    const hostnames = options.hostnames ?? [hostname(), hostname().split('.', 1)[0], ...(facts.selfNames ?? [])]
    local = identifyLocalMember(registry, { device: options.device ?? process.env.DSH_PEER_DEVICE, hostnames })
  } catch (error) {
    logger.warn(`${error.message}; ${pairingsPath} left untouched`)
    return { action: 'skipped', path: pairingsPath, reason: 'unknown-device' }
  }
  try {
    const ips = new Map()
    for (const member of registry.members) {
      if (member.name === local.name) continue
      const ip = resolveMemberIp(member, facts, run)
      if (ip === undefined) throw new Error(`no tailnet IPv4 for member ${member.name} (tailnet lookup and registry ip both missing)`)
      ips.set(member.name, ip)
    }
    const rendered = renderPairingsDocument(registry, { local, ips, port })
    if (typeof parsePairings !== 'function') {
      logger.warn(`no peer parser available to validate the generated document; ${pairingsPath} left untouched`)
      return { action: 'skipped', path: pairingsPath, reason: 'no-validator' }
    }
    try {
      parsePairings(rendered, pairingsPath)
    } catch (error) {
      logger.warn(`generated document rejected by the peer parser (${error.message}); keeping the previous ${pairingsPath}`)
      return { action: 'rejected', path: pairingsPath, reason: 'validation-failed' }
    }
    if (existing === rendered) return { action: 'unchanged', path: pairingsPath }
    let backup
    if (existing !== undefined) {
      try {
        backup = backupExisting(pairingsPath)
      } catch (error) {
        logger.warn(`could not back up ${pairingsPath}: ${error.message}; leaving it untouched`)
        return { action: 'skipped', path: pairingsPath, reason: 'backup-failed' }
      }
    }
    const mode = existsSync(pairingsPath) ? statSync(pairingsPath).mode & 0o777 : undefined
    writePairingsAtomic(pairingsPath, rendered)
    logger.log(`wrote ${pairingsPath} for device ${local.name} (${String(registry.members.length - 1)} pairing(s)${mode === undefined ? '' : `; previous mode ${mode.toString(8)}`})`)
    return { action: 'written', path: pairingsPath, entries: registry.members.length - 1, ...(backup === undefined ? {} : { backup }) }
  } catch (error) {
    logger.warn(`generation failed: ${error.message}; ${pairingsPath} left untouched`)
    return { action: 'skipped', path: pairingsPath, reason: 'render-failed' }
  }
}

/**
 * The CLI: run with the environment defaults, print the outcome, and always
 * exit 0 so an install or update is never failed by pairing generation.
 * @returns the process exit code (always 0).
 */
export async function main() {
  const logger = defaultLogger()
  try {
    const registryPath = process.env.DSH_PEER_REGISTRY ?? DEFAULT_REGISTRY_PATH
    const harnessRoot = defaultHarnessRoot()
    const loaded = await loadHarnessParser(harnessRoot)
    if (loaded === undefined) {
      logger.warn(`no built peer package under ${harnessRoot}; ${join(defaultDshHome(), 'pairings.yaml')} left untouched`)
      return 0
    }
    const result = await generatePairings({
      logger,
      parseYaml: loaded.parseYaml,
      parsePairings: loaded.parsePairingsDocument,
      registryPath,
    })
    if (result.action === 'unchanged') logger.log(`${result.path} is already current`)
    return 0
  } catch (error) {
    logger.warn(`unexpected failure: ${error instanceof Error ? error.message : String(error)}; pairings left untouched`)
    return 0
  }
}

function isMain() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isMain()) {
  await main()
}
