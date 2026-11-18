#!/usr/bin/env node
/**
 * dsh-peer — `ds peer` CLI for the caller side of the device-to-device peer API.
 *
 * Zero dependencies (Node 22 builtins only). Prefers the harness caller client
 * `@deepseek-ai/dsh-api-peer/client` when it resolves from the profile, and
 * falls back to a local copy of the same envelope/follow semantics (the
 * harness package is not a profile dependency today, so the local copy is
 * what runs). Pairings come from `--pairings <path>` or `$DSH_HOME/pairings.yaml`;
 * only caller-role entries (`peer` + `endpoint`) are dialable.
 *
 * Commands:
 *   handshake <endpoint>             Handshake only (no pairing needed)
 *   status [alias]                   Host summary; with alias: latch + model + budget + asks
 *   list [alias]                     Discover peer sessions (alias, remoteSessionId, latch summary)
 *   models <alias>                   Policy-filtered chains and models this caller may select
 *   switch <alias> <provider/model>  Switch an idle remote session's model for its next turn
 *   switch <alias> --chain <id>      Switch by chain id instead of an explicit route
 *   ask <alias> <message>            Create/adopt, prompt, follow until the session settles
 *   follow <alias>                   Stream frames until the session settles (asks are printed loudly)
 *   asks <alias>                     List pending remote asks (questions show ids + options)
 *   answer <alias> <askId> <once|reject>
 *   answer <alias> <askId> --select <label> [--select <label> …]
 *   cancel <alias>
 *
 * `models` and `switch` need a host that advertises `model-discovery` and
 * `model-switch` in its handshake; the command says so plainly when it does
 * not, instead of forwarding an opaque refusal. `switch` mints a requestId
 * per call (or takes `--request-id`) so a retry replays the same selection
 * instead of switching twice.
 *
 * `ask`/`follow` return the FINAL assistant text: after the first `turn/end`
 * they keep following while the remote session is not settled — a live
 * descendant (a fan-out child), a pending ask, or a new turn that starts
 * within the quiet window — and only then return the newest turn's text.
 * `--once` restores the historical behavior (return at the first turn/end).
 *
 * Turn attribution is causal and exclusive. `admitted` means the host accepted
 * and recorded the prompt (the `prompt` response, or the durable `user/message`
 * when following another driver's run), so a recorded prompt is never reported
 * as unadmitted. Once our admitted turn has a terminal, a later turn opened by
 * a different operator prompt cannot replace that answer or terminal: the
 * result freezes on our own turn and reports `superseded: true`. A terminal
 * only carries the answer text committed for that same turn; a later turn with
 * no text clears the stale one.
 *
 * `ask` persists the minted requestId per (alias, target, message) under
 * `<pairing dir>/peer-bridge/ask-state.json` until the follow reports a
 * terminal. Re-running the same message after a transport failure reuses that
 * requestId, so an already-admitted prompt is deduplicated by the host instead
 * of queued twice; a settled run clears the entry, and a stale entry older
 * than one hour is ignored. The state file is the only place the requestId
 * survives a process restart.
 *
 * Flags: --pairings <path> · --json · --header "k: v" (repeatable) ·
 *        --name <participant> · --wait <seconds> · --session <id> · --no-create ·
 *        --once · --settle-ms <ms> · --select <label> (repeatable;
 *        `questionId=label` for multi-question asks) · --cursor <c> ·
 *        --limit <n> · --zero-price · --tools · --chain <id> · --effort <e> ·
 *        --request-id <id> · --model <provider/model> · --max-tokens <n>
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── Errors ───────────────────────────────────────────────────────────────────

class PeerError extends Error {
  constructor(code, message, endpoint = '', details = {}) {
    super(message)
    this.name = 'PeerError'
    this.code = code
    this.endpoint = endpoint
    this.details = details
  }
}

function isPeerError(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string'
}

// ── Local client (fallback; same wire contract as the harness client) ────────

const DEFAULT_BACKOFF = { initialMs: 250, maxMs: 4000, factor: 2 }
const REPAIR_PAGE_LIMIT = 20
/**
 * Default quiet window after a terminal turn/end before `ask`/`follow` accept
 * the session as settled. A settlement notice can start a follow-up turn
 * within this window; `--settle-ms` overrides it.
 */
export const DEFAULT_SETTLE_QUIET_MS = 2000

/** How long a persisted `ask` requestId stays reusable across process restarts. */
export const ASK_RETRY_TTL_MS = 60 * 60 * 1000

/**
 * Error frames that cannot be fixed by retrying the same follow: the pairing,
 * session, or exposure is gone or refused. A healthy reconnect cannot change
 * them, so `follow` surfaces them instead of reconnecting at backoff cadence.
 */
const CALLER_TERMINAL_CODES = new Set(['peer/version-skew', 'peer/not-paired', 'peer/not-found', 'peer/forbidden'])

/**
 * Env override for the caller identity this CLI reports in its handshake. The
 * resolver below reads the installed harness identity first; this variable is
 * the documented escape hatch for a copied script on a machine with no
 * harness installation beside it.
 */
export const CALLER_HARNESS_VERSION_ENV = 'DSH_PEER_HARNESS_VERSION'

/**
 * Read one string `version` out of a JSON manifest.
 * @param path - manifest path.
 * @param key - field to read (defaults to `version`).
 * @returns the trimmed value, or undefined when the file is absent, unreadable,
 * malformed, or the field is not a non-empty string (advisory identity, so a
 * broken manifest is skipped rather than fatal here).
 */
function manifestStringAt(path, key = 'version') {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const value = parsed !== null && typeof parsed === 'object' ? parsed[key] : undefined
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Find the `@deepseek-ai/dsh-api-peer` manifest the profile resolves, which is
 * the same package manifest the library client reads its version from.
 * @param profileRoot - profile root whose `node_modules` links the harness packages.
 * @returns the manifest path, or undefined when it is not resolvable.
 */
function resolveProfileManifestPath(profileRoot) {
  try {
    return createRequire(join(profileRoot, 'package.json')).resolve('@deepseek-ai/dsh-api-peer/package.json')
  } catch {
    return undefined
  }
}

/**
 * Resolve the harness version this caller reports in `peer.handshake`.
 *
 * The value is advisory on the wire (the host checks the protocol version, not
 * this string), but it must still be real: the resolver reads, in order, the
 * installed identity the `dsh` shim itself reads
 * (`<DSH_HOME>/harness/install-state.json`), the source checkout's root
 * manifest beside this script, and the `@deepseek-ai/dsh-api-peer` manifest
 * the library client would report. Only when none exists does it fail closed
 * with the env override named, instead of inventing a version.
 * @param options - explicit override plus test seams for the lookup roots.
 * @returns the non-empty harness version string.
 * @throws {PeerError} `gateway/internal` when no source resolves.
 */
export function resolveCallerHarnessVersion(options = {}) {
  const explicit = options.harnessVersion ?? process.env[CALLER_HARNESS_VERSION_ENV]
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const dshHome = options.dshHome ?? (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh'))
  const state = manifestStringAt(join(dshHome, 'harness', 'install-state.json'))
  if (state !== undefined) return state
  const treeManifest = options.treeManifestPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const tree = manifestStringAt(treeManifest)
  if (tree !== undefined) return tree
  const profileRoot = options.profileRoot ?? (process.env.DSH_PEER_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'web'))
  const profileManifest = options.profileManifestPath ?? resolveProfileManifestPath(profileRoot)
  if (profileManifest !== undefined) {
    const peer = manifestStringAt(profileManifest)
    if (peer !== undefined) return peer
  }
  throw new PeerError(
    'gateway/internal',
    `cannot determine the caller harness version (no ${CALLER_HARNESS_VERSION_ENV}, no harness/install-state.json under ${dshHome}, no tree manifest at ${treeManifest}, and no resolvable @deepseek-ai/dsh-api-peer manifest under ${profileRoot}) — set ${CALLER_HARNESS_VERSION_ENV} to this build's version`,
    '',
  )
}

export class LocalPeerClient {
  constructor(options) {
    this.endpoint = options.endpoint.replace(/\/+$/u, '')
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.webSocketFactory = options.webSocket ?? ((url) => new globalThis.WebSocket(url))
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    this.maxReconnects = options.maxReconnects
    this.pageSize = options.pageSize ?? 50
    this.device = options.device ?? hostname()
    this.harnessVersion = options.harnessVersion
    this.onWarning = options.onWarning
  }

  async handshake() {
    return this.rpc('handshake', {
      protocolVersion: 1,
      harnessVersion: resolveCallerHarnessVersion({ harnessVersion: this.harnessVersion }),
      schemaDigest: '',
      device: this.device,
    })
  }

  state(target) { return this.rpc('state', { target }) }
  list(request) { return this.rpc('list', request ?? {}) }
  models(request) { return this.rpc('models', request) }
  create(request) { return this.rpc('create', request) }
  prompt(request) { return this.rpc('prompt', request) }
  cancel(request) { return this.rpc('cancel', request) }
  answer(request) { return this.rpc('answer', request) }
  selectModel(request) { return this.rpc('selectModel', request) }
  page(request) { return this.rpc('page', request) }

  async *followOnce(request, signal) {
    const socket = this.webSocketFactory(this.muxUrl())
    const streamId = `peer-${globalThis.crypto.randomUUID()}`
    const queue = []
    let wake
    let closed = false
    const notify = () => { if (wake !== undefined) { const resume = wake; wake = undefined; resume() } }
    const onMessage = (event) => {
      const text = messageText(event)
      if (text === undefined) return
      let parsed
      try { parsed = JSON.parse(text) } catch { return }
      if (typeof parsed !== 'object' || parsed === null) return
      if (parsed.streamId !== streamId || typeof parsed.type !== 'string') return
      queue.push(parsed)
      notify()
    }
    const onClose = () => { closed = true; notify() }
    const onAbort = () => { closed = true; notify(); socket.close() }
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await new Promise((resolve, reject) => {
        const onOpen = () => {
          socket.removeEventListener('open', onOpen)
          socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'peer/follow', payload: { args: { request } } }))
          resolve()
        }
        const onOpenError = () => {
          socket.removeEventListener('error', onOpenError)
          reject(new PeerError('peer/target-unreachable', `peer target ${this.endpoint} is unreachable`, this.endpoint))
        }
        socket.addEventListener('open', onOpen)
        socket.addEventListener('error', onOpenError)
      })
      while (true) {
        const frame = queue.shift()
        if (frame === undefined) {
          if (closed) return
          await new Promise((resolve) => { wake = resolve })
          continue
        }
        if (frame.type === 'item') { yield frame.value; continue }
        if (frame.type === 'error') throw decodeFailure(frame.value, this.endpoint)
        return
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      socket.close()
      queue.length = 0
    }
  }

  async *follow(request, signal) {
    let lastCursor
    let attempt = 0
    while (!signal.aborted) {
      let progressed = false
      try {
        for await (const frame of this.followOnce(request, signal)) {
          progressed = true
          if (frame.type === 'snapshot') {
            if (lastCursor !== undefined && frame.records.length > 0) {
              const oldest = frame.records[0]?.seq
              if (oldest !== undefined && oldest > lastCursor + 1) yield* this.repairForward(request.target, lastCursor, oldest, signal)
            }
            lastCursor = frame.cursor
          } else if (frame.type === 'event') {
            lastCursor = Math.max(lastCursor ?? -1, frame.record.seq)
          } else if (frame.type === 'state') {
            lastCursor = Math.max(lastCursor ?? -1, frame.cursor)
          }
          yield frame
        }
      } catch (error) {
        if (signal.aborted) return
        if (isPeerError(error) && CALLER_TERMINAL_CODES.has(error.code)) throw error
      }
      if (signal.aborted) return
      attempt = progressed ? 1 : attempt + 1
      if (this.maxReconnects !== undefined && attempt > this.maxReconnects) {
        throw new PeerError('peer/target-unreachable', `peer target ${this.endpoint} is unreachable`, this.endpoint)
      }
      await delay(backoffDelay(this.backoff, attempt), signal)
    }
  }

  async *repairForward(target, fromExclusive, toExclusive, signal) {
    const collected = []
    let throughSeq = toExclusive - 1
    let hole
    let pages = 0
    while (pages < REPAIR_PAGE_LIMIT) {
      if (signal.aborted || throughSeq <= fromExclusive) break
      const value = await this.page({ target, throughSeq, maxMessages: this.pageSize })
      pages += 1
      if (value.records.length === 0) {
        hole = { from: fromExclusive + 1, to: throughSeq + 1 }
        break
      }
      for (const record of value.records) if (record.seq > fromExclusive && record.seq < toExclusive) collected.push(record)
      const oldest = value.records[0]?.seq
      if (oldest === undefined || oldest <= fromExclusive + 1 || !value.hasMore) {
        if (oldest !== undefined && oldest > fromExclusive + 1) hole = { from: fromExclusive + 1, to: oldest }
        break
      }
      throughSeq = oldest - 1
    }
    if (hole === undefined && !signal.aborted && throughSeq > fromExclusive) {
      hole = { from: fromExclusive + 1, to: throughSeq + 1 }
    }
    if (hole !== undefined) this.onWarning?.(hole)
    collected.sort((left, right) => left.seq - right.seq)
    for (const record of collected) yield { type: 'event', record, cursor: record.seq }
  }

  async rpc(method, args) {
    const endpoint = `${this.endpoint}/api/peer/${method}`
    let response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `peer-${globalThis.crypto.randomUUID()}`,
          method: `peer/${method}`,
          payload: { args: { request: args } },
        }),
      })
    } catch (error) {
      throw new PeerError('peer/target-unreachable', `peer target ${this.endpoint} is unreachable`, this.endpoint, { cause: String(error) })
    }
    if (!response.ok) {
      throw new PeerError('peer/target-unreachable', `peer ${method} failed over HTTP ${String(response.status)}`, this.endpoint)
    }
    const body = await response.json()
    const result = body.result
    if (result === undefined) throw new PeerError('gateway/internal', `peer ${method} returned no result envelope`, this.endpoint)
    if (result.ok) return result.value
    throw decodeFailure(result.error, this.endpoint)
  }

  muxUrl() {
    const url = new URL(this.endpoint)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/api/remote.mux'
    url.search = ''
    return url.toString()
  }
}

function decodeFailure(value, endpoint) {
  if (typeof value !== 'object' || value === null) return new PeerError('peer/target-unreachable', `peer target ${endpoint} is unreachable`, endpoint)
  return new PeerError(
    typeof value.code === 'string' ? value.code : 'gateway/internal',
    typeof value.message === 'string' ? value.message : 'peer call failed',
    endpoint,
    typeof value.details === 'object' && value.details !== null ? value.details : {},
  )
}

function backoffDelay(backoff, attempt) {
  return Math.min(backoff.maxMs, Math.round(backoff.initialMs * backoff.factor ** Math.max(0, attempt - 1)))
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const onAbort = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function messageText(event) {
  if (typeof event === 'string') return event
  if (typeof event !== 'object' || event === null) return undefined
  const data = event.data
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  return undefined
}

/** Prefer the harness client when the profile resolves it; else the local copy. */
async function loadPeerClient() {
  const profileRoot = process.env.DSH_PEER_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'web')
  try {
    const require = createRequire(join(profileRoot, 'package.json'))
    const resolved = require.resolve('@deepseek-ai/dsh-api-peer/client')
    const mod = await import(pathToFileURL(resolved).href)
    if (typeof mod.PeerClient === 'function') return { PeerClient: mod.PeerClient, source: 'profile @deepseek-ai/dsh-api-peer/client' }
  } catch {
    // Not resolvable from the profile: the local copy is the contract carrier.
  }
  return { PeerClient: LocalPeerClient, source: 'local envelope copy (harness client not resolvable from the profile)' }
}

// ── Pairing document (YAML subset; mirrors the plugin parser) ────────────────

function stripComment(raw) {
  let quote
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote !== undefined) { if (char === quote) quote = undefined; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#' && (index === 0 || /\s/u.test(raw[index - 1]))) return raw.slice(0, index)
  }
  return raw
}

function significantLines(raw) {
  return raw.split(/\r?\n/u).flatMap((row, index) => {
    const text = stripComment(row)
    if (text.trim() === '') return []
    return [{ indent: text.length - text.trimStart().length, text: text.trim(), line: index + 1 }]
  })
}

function findColon(text) {
  let quote
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== undefined) { if (char === quote) quote = undefined; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === ':') return index
  }
  return -1
}

function unquote(text) {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\nt])/gu, (_m, esc) => esc === 'n' ? '\n' : esc === 't' ? '\t' : esc)
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/gu, "'")
  return text
}

function parseScalar(text) {
  if (text === 'null' || text === '~') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === '[]') return []
  if (text === '{}') return {}
  if (/^-?\d+$/u.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d+\.\d+$/u.test(text)) return Number.parseFloat(text)
  return unquote(text)
}

function isSequenceLine(text) { return text === '-' || text.startsWith('- ') }

function parseBlock(lines, start, indent) {
  const first = lines[start]
  if (first === undefined || first.indent < indent) return [null, start]
  if (isSequenceLine(first.text)) return parseSequence(lines, start, first.indent)
  return parseMapping(lines, start, first.indent)
}

function parseMapping(lines, start, indent, firstPair) {
  const out = {}
  let index = start
  let pending = firstPair
  while (true) {
    let text
    let line
    if (pending !== undefined) { text = pending.text; line = pending.line; pending = undefined }
    else {
      const current = lines[index]
      if (current === undefined || current.indent !== indent || isSequenceLine(current.text)) break
      text = current.text
      line = current.line
      index += 1
    }
    const colon = findColon(text)
    if (colon < 0) throw new Error(`expected "key: value" (line ${String(line)})`)
    const key = unquote(text.slice(0, colon).trim())
    const rest = text.slice(colon + 1).trim()
    if (rest === '') {
      const next = lines[index]
      if (next !== undefined && next.indent > indent) { const [value, consumed] = parseBlock(lines, index, next.indent); out[key] = value; index = consumed }
      else out[key] = null
    } else out[key] = parseScalar(rest)
  }
  return [out, index]
}

function parseSequence(lines, start, indent) {
  const out = []
  let index = start
  while (index < lines.length) {
    const current = lines[index]
    if (current.indent !== indent || !isSequenceLine(current.text)) break
    const rest = current.text.slice(1).trim()
    index += 1
    if (rest === '') {
      const next = lines[index]
      if (next !== undefined && next.indent > indent) { const [value, consumed] = parseBlock(lines, index, next.indent); out.push(value); index = consumed }
      else out.push(null)
      continue
    }
    const colon = findColon(rest)
    if (colon < 0) { out.push(parseScalar(rest)); continue }
    const next = lines[index]
    const childIndent = next !== undefined && next.indent > indent ? next.indent : indent + 2
    const [value, consumed] = parseMapping(lines, index, childIndent, { text: rest, line: current.line })
    out.push(value)
    index = consumed
  }
  return [out, index]
}

function parsePairingDocument(raw, path) {
  const lines = significantLines(raw)
  if (lines.length === 0) throw new Error(`peer pairings ${path} is empty`)
  const [document, next] = parseBlock(lines, 0, lines[0].indent)
  if (next !== lines.length) throw new Error(`peer pairings ${path} has trailing content (line ${String(lines[next].line)})`)
  if (typeof document !== 'object' || document === null || Array.isArray(document)) throw new Error(`peer pairings ${path} must be a mapping`)
  if (document.version !== 1) throw new Error(`peer pairings ${path} must declare version: 1`)
  if (typeof document.device !== 'string' || document.device === '') throw new Error(`peer pairings ${path}: device must be a non-empty string`)
  if (!Array.isArray(document.pairings)) throw new Error(`peer pairings ${path} must declare a pairings list`)
  return { version: 1, device: document.device, pairings: document.pairings }
}

function loadPairings(path) {
  let raw
  try { raw = readFileSync(path, 'utf8') } catch (error) { throw new Error(`peer pairings ${path} could not be read: ${error.message}`) }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  return parsePairingDocument(raw, path)
}

function resolvePairing(document, alias) {
  const dialable = document.pairings.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.endpoint === 'string' && entry.endpoint !== '')
  const found = dialable.find(entry => entry.alias === alias)
  if (found === undefined) {
    const available = dialable.length === 0
      ? 'no caller-role entries (an entry needs `endpoint` and `peer`)'
      : `available: ${dialable.map(entry => String(entry.alias)).join(', ')}`
    throw new Error(`no caller-role pairing with alias ${JSON.stringify(alias)} — ${available}`)
  }
  return found
}

// ── Argument parsing ─────────────────────────────────────────────────────────

function usage() {
  return [
    'usage: dsh-peer [--pairings PATH] [--json] [--header "k: v"] [--name NAME] <command> [args]',
    '  handshake <endpoint>            Handshake only (no pairing needed)',
    '  status [alias]                  Host summary; with alias: latch + model + budget + asks',
    '  list [alias]                    Discover peer sessions: alias, remoteSessionId, latch summary',
    '  models <alias> [--cursor c] [--limit n] [--zero-price] [--tools]',
    '                                  Chains (member states) and selectable models for this caller',
    '  switch <alias> <provider/model> [--effort e] [--request-id id]',
    '  switch <alias> --chain <id> [--effort e] [--request-id id]',
    '                                  Switch an idle remote session’s model for its next turn',
    '  ask <alias> <message>           Create/adopt, prompt, follow until the session settles;',
    '                                  a same-message retry reuses the last requestId (host dedup)',
    '                                  create-only route flags: --model p/m | --chain id, --effort e, --max-tokens n',
    '  follow <alias>                  Stream frames until the session settles (asks printed loudly)',
    '  asks <alias>                    List pending remote asks (question options included)',
    '  answer <alias> <askId> <once|reject>',
    '  answer <alias> <askId> --select <label> [--select …]',
    '  cancel <alias>',
    'flags: --wait <seconds>  --session <id>  --no-create  --once  --settle-ms <ms>  --select <label|questionId=label>',
  ].join('\n')
}

export function parseArgs(argv) {
  const flags = {
    header: [], select: [], wait: undefined, session: undefined, create: true, json: false, pairings: undefined,
    name: undefined, once: false, settleMs: undefined, cursor: undefined, limit: undefined, zeroPrice: false,
    tools: false, chain: undefined, effort: undefined, requestId: undefined, model: undefined, maxTokens: undefined,
  }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--json': flags.json = true; break
      case '--pairings': flags.pairings = argv[++index]; break
      case '--header': flags.header.push(argv[++index]); break
      case '--name': flags.name = argv[++index]; break
      case '--select': flags.select.push(argv[++index]); break
      case '--wait': flags.wait = Number(argv[++index]); break
      case '--session': flags.session = argv[++index]; break
      case '--no-create': flags.create = false; break
      case '--once': flags.once = true; break
      case '--settle-ms': flags.settleMs = Number(argv[++index]); break
      case '--cursor': flags.cursor = argv[++index]; break
      case '--limit': flags.limit = Number(argv[++index]); break
      case '--zero-price': flags.zeroPrice = true; break
      case '--tools': flags.tools = true; break
      case '--chain': flags.chain = argv[++index]; break
      case '--effort': flags.effort = argv[++index]; break
      case '--request-id': flags.requestId = argv[++index]; break
      case '--model': flags.model = argv[++index]; break
      case '--max-tokens': flags.maxTokens = Number(argv[++index]); break
      case '--help': case '-h': flags.help = true; break
      default:
        if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`)
        positional.push(arg)
    }
  }
  return { flags, positional }
}

function headersOf(flags, pairing) {
  const headers = {}
  for (const header of flags.header) {
    const colon = header.indexOf(':')
    if (colon < 0) throw new Error(`--header expects "name: value" (received ${JSON.stringify(header)})`)
    headers[header.slice(0, colon).trim().toLowerCase()] = header.slice(colon + 1).trim()
  }
  if (pairing !== undefined && typeof pairing.token === 'string' && pairing.token !== '') headers.authorization = `Bearer ${pairing.token}`
  return headers
}

// ── Follow orchestration (shared by ask/follow) ──────────────────────────────

function recordRpcId(record) {
  if (record.type !== 'user/message' || typeof record.data !== 'object' || record.data === null) return undefined
  const source = record.data.source
  return typeof source === 'object' && source !== null && typeof source.rpcId === 'string' ? source.rpcId : undefined
}

function recordTurn(record) {
  return typeof record.data === 'object' && record.data !== null && typeof record.data.turn === 'number' ? record.data.turn : undefined
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

function recordAssistantText(record) {
  if (record.type !== 'assistant/message' || typeof record.data !== 'object' || record.data === null) return ''
  const message = record.data.message
  return contentText(typeof message === 'object' && message !== null ? message.content : undefined)
}

function recordTerminal(record) {
  if (record.type !== 'turn/end' || typeof record.data !== 'object' || record.data === null) return undefined
  const turn = record.data.turn
  const reason = record.data.reason
  if (typeof turn !== 'number') return undefined
  const kind = typeof reason === 'object' && reason !== null && typeof reason.kind === 'string' ? reason.kind : 'unknown'
  const error = typeof reason === 'object' && reason !== null ? reason.error : undefined
  return { turn, reason: kind, ...(error === undefined ? {} : { error }) }
}

function askSummary(ask) {
  if (ask.kind === 'approval') {
    const reason = typeof ask.reason === 'string' && ask.reason !== '' ? ` (${ask.reason})` : ''
    return `approval ${ask.askId} tool=${String(ask.toolName ?? 'unknown')}${reason}`
  }
  const questions = Array.isArray(ask.questions) ? ask.questions : []
  const rendered = questions.map(question => {
    const options = Array.isArray(question.options) ? question.options.map(option => option?.label ?? String(option)).join(', ') : ''
    return `"${String(question.question ?? '')}" (id=${String(question.id ?? '')}${question.multiSelect === true ? ' multi' : ''}${options === '' ? '' : `; options: ${options}`})`
  }).join('; ')
  return `question ${ask.askId} (${String(questions.length)} item(s))${rendered === '' ? '' : `: ${rendered}`}`
}

export async function followToSettled(options) {
  const { client, target, flags, requestId, baselineTurn, baselineState, log, onAsk, promptAccepted } = options
  const controller = new AbortController()
  const deadline = flags.wait !== undefined && Number.isFinite(flags.wait) && flags.wait > 0 ? Date.now() + flags.wait * 1000 : undefined
  const timer = deadline === undefined ? undefined : setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()))
  const onSignal = () => controller.abort()
  process.on('SIGINT', onSignal)
  const once = flags.once === true
  const quietMs = Number.isFinite(flags.settleMs) && flags.settleMs >= 0 ? flags.settleMs : DEFAULT_SETTLE_QUIET_MS
  const seenAsks = new Set()
  const seenSeqs = new Set()
  const answerParts = []
  let currentTurn
  let terminal
  let admitted = promptAccepted === true
  let latch = baselineState?.latch ?? 'unknown'
  let activeDescendants = baselineState?.activeDescendants ?? 0
  let descendantsExact = baselineState?.descendantsExact
  let pendingAskCount = Array.isArray(baselineState?.pendingAsks) ? baselineState.pendingAsks.length : 0
  let cursor = 0
  let quietExpired = false
  let quietTimer

  const settledNow = () => isPeerSessionSettled({ terminal, latch, activeDescendants, descendantsExact, pendingAskCount })
  const clearQuiet = () => { if (quietTimer !== undefined) { clearTimeout(quietTimer); quietTimer = undefined } }
  const armQuiet = () => {
    clearQuiet()
    quietTimer = setTimeout(() => { quietExpired = true; controller.abort() }, quietMs)
  }
  const absorption = {
    requestId,
    baselineTurn,
    seen: seenSeqs,
    admittedTurn: undefined,
    observedTurn: undefined,
    admissionSeen: false,
    answerTurn: undefined,
    abandoned: false,
    addAnswer: (turn, text) => {
      if (currentTurn === undefined || turn > currentTurn) { currentTurn = turn; absorption.answerTurn = turn; answerParts.length = 0 }
      if (turn === currentTurn) {
        absorption.answerTurn = turn
        answerParts.push(text)
      }
    },
    clearAnswer: () => { currentTurn = undefined; absorption.answerTurn = undefined; answerParts.length = 0 },
    markAdmitted: () => { admitted = true },
    setTerminal: (value) => { terminal = value },
  }
  const absorb = (record) => absorbRecord(record, absorption)
  const absorbState = (state) => {
    latch = state.latch
    activeDescendants = state.activeDescendants
    descendantsExact = state.descendantsExact
    pendingAskCount = state.pendingAsks.length
  }
  const surfaceAsks = (state) => {
    for (const ask of state.pendingAsks) {
      if (seenAsks.has(ask.askId)) continue
      seenAsks.add(ask.askId)
      log(`ASK: ${askSummary(ask)}`)
      onAsk?.(ask)
    }
  }
  try {
    for await (const frame of client.follow({ target }, controller.signal)) {
      if (frame.type === 'snapshot') {
        cursor = frame.cursor
        absorbState(frame.state)
        for (const record of frame.records) absorb(record)
        surfaceAsks(frame.state)
      } else if (frame.type === 'state') {
        cursor = frame.cursor
        absorbState(frame.state)
        surfaceAsks(frame.state)
      } else if (frame.type === 'event') {
        cursor = Math.max(cursor, frame.record.seq)
        absorb(frame.record)
        if (flags.json !== true) logFrame(frame.record)
      } else if (frame.type === 'end' && frame.reason === 'target-detached') {
        return { ok: false, pending: true, admitted, latch, cursor, asks: [...seenAsks], answer: answerParts.join('\n').trim(), note: 'remote target-detached (pairing/session binding gone)' }
      }
      // A different operator's prompt opened a later turn after our admitted
      // turn already had its terminal: our result is complete, and continuing
      // would return their answer as ours.
      if (absorption.abandoned === true && terminal !== undefined) break
      if (terminal !== undefined) {
        if (once) break
        // Keep following while a child, an ask, or a follow-up turn can still
        // move the session; only a settled state starts the quiet clock.
        if (settledNow()) armQuiet()
        else clearQuiet()
      }
    }
  } catch (error) {
    if (quietExpired) {
      // The quiet window elapsed after the session had settled: fall through.
    } else if (deadline !== undefined && Date.now() >= deadline) {
      return pendingResult({
        terminal, answerParts, admitted, latch, cursor, seenAsks,
        activeDescendants, pendingAskCount, wait: flags.wait,
      })
    } else {
      throw error
    }
  } finally {
    clearQuiet()
    if (timer !== undefined) clearTimeout(timer)
    process.removeListener('SIGINT', onSignal)
  }
  // The quiet window aborts the follow, so a frame in flight at the cut can be
  // lost. Confirm the session is still quiet before accepting the terminal.
  if (quietExpired && typeof client.state === 'function') {
    try {
      const confirmed = await client.state(target)
      absorbState(confirmed.state)
      cursor = Math.max(cursor, confirmed.cursor)
    } catch {
      // Without the confirming read the last observed settled signals stand.
    }
  }
  if (terminal === undefined) {
    return {
      ok: false,
      pending: true,
      admitted,
      latch,
      cursor,
      asks: [...seenAsks],
      answer: answerParts.join('\n').trim(),
      note: deadline === undefined ? 'follow ended without a terminal' : 'wait elapsed without a terminal',
    }
  }
  if (absorption.abandoned === true) {
    return {
      ok: terminal.reason === 'completed',
      admitted,
      turn: terminal.turn,
      terminal: terminal.reason,
      ...(terminal.error === undefined ? {} : { remoteError: terminal.error }),
      answer: answerParts.join('\n').trim(),
      asks: [...seenAsks],
      cursor,
      latch,
      settled: true,
      superseded: true,
      note: `a different operator's prompt opened a later turn after turn ${String(terminal.turn)} ended; returning this turn's own result — follow again to collect the session remainder`,
    }
  }
  const settled = once || settledNow()
  const context = { terminal, activeDescendants, pendingAskCount, latch }
  if (!settled) {
    return {
      ok: false,
      pending: true,
      admitted,
      turn: terminal.turn,
      terminal: terminal.reason,
      ...(terminal.error === undefined ? {} : { remoteError: terminal.error }),
      answer: answerParts.join('\n').trim(),
      asks: [...seenAsks],
      cursor,
      latch,
      settled: false,
      note: `remote turn ${String(terminal.turn)} ended: ${terminal.reason}; the session was not settled when following stopped (${unsettledSummary(context)}) — follow again to collect the remainder`,
    }
  }
  return {
    ok: terminal.reason === 'completed',
    admitted,
    turn: terminal.turn,
    terminal: terminal.reason,
    ...(terminal.error === undefined ? {} : { remoteError: terminal.error }),
    answer: answerParts.join('\n').trim(),
    asks: [...seenAsks],
    cursor,
    latch,
    settled: true,
    note: terminal.reason === 'completed' ? '' : `remote turn ${String(terminal.turn)} ended: ${terminal.reason}`,
  }
}

/**
 * The pending result the wait deadline (or an ended stream) produces. A
 * terminal that arrived while children or asks were still live is reported
 * with its turn and the busy reason, not as a missing terminal.
 */
function pendingResult(context) {
  const base = {
    ok: false,
    pending: true,
    admitted: context.admitted,
    latch: context.latch,
    cursor: context.cursor,
    asks: [...context.seenAsks],
    answer: context.answerParts.join('\n').trim(),
  }
  if (context.terminal === undefined) {
    return {
      ...base,
      note: context.wait === undefined ? 'follow ended without a terminal' : `no terminal within ${String(context.wait)}s — remote turn still live`,
    }
  }
  return {
    ...base,
    turn: context.terminal.turn,
    terminal: context.terminal.reason,
    ...(context.terminal.error === undefined ? {} : { remoteError: context.terminal.error }),
    note: `remote turn ${String(context.terminal.turn)} ended: ${context.terminal.reason} but the session was still busy at the wait limit (${unsettledSummary(context)}) — follow again to collect the remainder`,
  }
}

/** Human summary of why the latest terminal did not settle the session. */
function unsettledSummary(context) {
  if ((context.activeDescendants ?? 0) > 0) return `${String(context.activeDescendants)} live descendant(s)`
  if ((context.pendingAskCount ?? 0) > 0) return `${String(context.pendingAskCount)} pending ask(s)`
  if (context.latch === 'running') return 'a turn is still running'
  if (context.latch === 'waiting_subagents') return 'descendants are still settling'
  if (context.latch === 'waiting_approval') return 'an ask is pending'
  return 'the quiet window had not elapsed'
}

/**
 * Whether the remote session is settled given the latest observed signals: a
 * terminal turn/end has been seen, no ask is pending, no descendant is live,
 * and the latch is not running/waiting. Absent signals (older hosts, no state
 * frame yet) count as unknown and leave settling to the quiet window.
 * @param state - the latest signals; `pendingAskCount` is the pending-ask count.
 * @returns true only when the session is provably quiet.
 */
export function isPeerSessionSettled(state) {
  if (state === undefined || state.terminal === undefined) return false
  if ((state.pendingAskCount ?? 0) > 0) return false
  if ((state.activeDescendants ?? 0) > 0) return false
  if (state.descendantsExact === false) return false
  const latch = state.latch
  return latch === undefined || latch === 'unknown' || latch === 'idle'
}

/**
 * Fold one durable record into the follow sink. The answer text is kept per
 * turn — a later turn REPLACES the previous turn's text, so a fan-out
 * dispatch announcement is superseded by the settled summary. Records are
 * deduplicated by seq, so a reconnect snapshot never doubles the text.
 *
 * With a `requestId`, answers and terminals are attributed causally: only the
 * turn whose `turn/start` preceded our admitted `user/message` (or a later
 * turn) feeds the answer. A concurrent third-party turn that ended before our
 * admission is ignored. Once our admitted turn has a terminal, a later turn
 * opened by a different operator's `user/message` marks the sink abandoned so
 * the caller's own result cannot be replaced by that operator's answer.
 * Without a `requestId` (the `follow` command) every turn after
 * `baselineTurn` counts.
 */
function absorbRecord(record, sink) {
  if (sink.requestId !== undefined && recordRpcId(record) === sink.requestId) {
    sink.markAdmitted()
    if (sink.admissionSeen !== true) {
      sink.admissionSeen = true
      const turn = recordTurn(record) ?? sink.observedTurn
      if (turn !== undefined) sink.admittedTurn = turn
    }
  }
  const seq = typeof record.seq === 'number' ? record.seq : undefined
  if (seq !== undefined) {
    if (sink.seen.has(seq)) return
    sink.seen.add(seq)
  }
  const turn = recordTurn(record)
  // A different operator's prompt claims a later turn: what that turn answers
  // belongs to their run, not ours.
  if (record.type === 'user/message' && sink.requestId !== undefined
    && sink.admittedTurn !== undefined && recordRpcId(record) !== sink.requestId) {
    const promptTurn = turn ?? sink.observedTurn
    const source = typeof record.data?.source === 'object' && record.data.source !== null ? record.data.source : undefined
    if (promptTurn !== undefined && promptTurn !== sink.admittedTurn && source?.kind === 'user') sink.abandoned = true
  }
  if (record.type === 'turn/start' && turn !== undefined) {
    sink.observedTurn = turn
    if (sink.requestId !== undefined && sink.admissionSeen === true && sink.admittedTurn === undefined) sink.admittedTurn = turn
    return
  }
  // The first turn-bound record after admission is the turn carrying our
  // prompt when the snapshot window cut its `turn/start`.
  if (sink.requestId !== undefined && sink.admissionSeen === true && sink.admittedTurn === undefined && turn !== undefined) {
    sink.admittedTurn = turn
  }
  const attributed = sink.requestId === undefined
    || (turn !== undefined && sink.admittedTurn !== undefined && turn >= sink.admittedTurn
      && (sink.abandoned !== true || turn <= sink.admittedTurn))
  if (!attributed) return
  if (record.type === 'assistant/message' && turn !== undefined && turn > sink.baselineTurn) {
    const text = recordAssistantText(record)
    if (text !== '') sink.addAnswer(turn, text)
    return
  }
  const end = recordTerminal(record)
  if (end !== undefined && end.turn > sink.baselineTurn) {
    // A terminal owns only the text committed for its own turn: a later turn
    // that produced no answer must not report the previous turn's text.
    if (sink.answerTurn !== undefined && sink.answerTurn !== end.turn) sink.clearAnswer()
    sink.setTerminal(end)
  }
}

function logFrame(record) {
  if (record.type === 'assistant/message') {
    const text = recordAssistantText(record)
    if (text !== '') console.log(`[assistant] ${text}`)
  } else if (record.type === 'user/message') {
    console.log(`[user] ${contentText(record.data?.content)}`)
  } else if (record.type === 'turn/end') {
    const end = recordTerminal(record) ?? { turn: '?', reason: '?' }
    console.log(`[turn ${String(end.turn)}] ${String(end.reason)}${end.error ? ` ${String(end.error.code ?? '')}: ${String(end.error.message ?? '')}` : ''}`)
  } else if (record.type !== 'turn/start') {
    console.log(`[${record.type}]`)
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function commandHandshake(flags, positional) {
  const endpoint = positional[1]
  if (endpoint === undefined) throw new Error('handshake needs an endpoint, e.g. https://host:8443')
  const { PeerClient, source } = await loadPeerClient()
  const client = new PeerClient({
    endpoint,
    device: flags.name ?? hostname(),
    headers: headersOf(flags, undefined),
    backoff: { initialMs: 200, maxMs: 2000, factor: 2 },
    maxReconnects: 0,
  })
  const value = await client.handshake()
  return { ok: true, client: source, host: value }
}

async function commandStatus(flags, positional) {
  const pairingsPath = flags.pairings ?? defaultPairingsPath()
  const alias = positional[1]
  const { PeerClient, source } = await loadPeerClient()
  if (alias === undefined) {
    // No alias: report the local caller-role document (a handshake needs an endpoint).
    try {
      const document = loadPairings(pairingsPath)
      return {
        ok: true,
        client: source,
        device: document.device,
        pairings: document.pairings.map(entry => ({ alias: entry.alias, peer: entry.peer, endpoint: entry.endpoint ?? null, remoteSessionId: entry.remoteSessionId ?? null, dialable: typeof entry.endpoint === 'string' })),
      }
    } catch (error) {
      return { ok: true, client: source, pairingsPath, pairings: [], note: error instanceof Error ? error.message : String(error) }
    }
  }
  const document = loadPairings(pairingsPath)
  const pairing = resolvePairing(document, alias)
  const client = new PeerClient({ endpoint: pairing.endpoint, device: flags.name ?? document.device, headers: headersOf(flags, pairing), maxReconnects: 0 })
  const handshake = await client.handshake()
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
  try {
    const value = await client.state(target)
    return {
      ok: true,
      client: source,
      alias,
      peer: pairing.peer,
      endpoint: pairing.endpoint,
      host: { device: handshake.hostDevice, harnessVersion: handshake.harnessVersion, protocolVersion: handshake.protocolVersion, capabilities: handshake.capabilities },
      exposure: value.target.exposure,
      sessionId: value.target.sessionId,
      bound: true,
      latch: value.state.latch,
      latchSource: value.state.source,
      activeDescendants: value.state.activeDescendants,
      model: value.state.model ?? null,
      lastTurnEnd: value.state.lastTurnEnd ?? null,
      budget: value.state.budget ?? null,
      pendingAsks: value.state.pendingAsks.map(askSummary),
      cursor: value.cursor,
    }
  } catch (error) {
    if (isPeerError(error) && (error.code === 'peer/not-paired' || error.code === 'peer/not-found')) {
      return {
        ok: true,
        client: source,
        alias,
        peer: pairing.peer,
        endpoint: pairing.endpoint,
        host: { device: handshake.hostDevice, harnessVersion: handshake.harnessVersion, protocolVersion: handshake.protocolVersion, capabilities: handshake.capabilities },
        bound: false,
        note: 'alias is not bound to a session; ask creates one when the host pairing has a create block',
      }
    }
    throw error
  }
}

async function commandList(flags, positional) {
  const pairingsPath = flags.pairings ?? defaultPairingsPath()
  const filter = positional[1]
  const { PeerClient, source } = await loadPeerClient()
  let document
  try {
    document = loadPairings(pairingsPath)
  } catch (error) {
    return { ok: false, client: source, device: '', sessions: [], note: error instanceof Error ? error.message : String(error) }
  }
  const dialable = document.pairings.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.endpoint === 'string' && entry.endpoint !== '')
  const selected = filter === undefined ? dialable : dialable.filter(entry => entry.alias === filter)
  if (selected.length === 0) {
    return {
      ok: filter === undefined,
      client: source,
      device: document.device,
      sessions: [],
      note: filter === undefined
        ? 'no caller-role entries in the pairing document (an entry needs `endpoint` and `peer`)'
        : `no caller-role pairing with alias ${JSON.stringify(filter)}`,
    }
  }
  const sessions = []
  for (const pairing of selected) {
    const client = new PeerClient({ endpoint: pairing.endpoint, device: flags.name ?? document.device, headers: headersOf(flags, pairing), maxReconnects: 0 })
    const base = {
      alias: pairing.alias,
      peer: pairing.peer,
      endpoint: pairing.endpoint,
      remoteSessionId: pairing.remoteSessionId ?? '',
      exposure: pairing.exposure ?? '',
    }
    try {
      const listed = await client.list({})
      const entry = listed.pairings.find(candidate => candidate.alias === pairing.alias)
      sessions.push({
        ...base,
        remoteSessionId: pairing.remoteSessionId ?? entry?.sessionId ?? '',
        exposure: entry?.exposure ?? base.exposure,
        bound: entry?.bound ?? false,
        ...(entry?.latch === undefined ? {} : { latch: entry.latch }),
        ...(entry?.lastActivity === undefined ? {} : { lastActivity: new Date(entry.lastActivity).toISOString() }),
        summary: entry === undefined ? 'the host lists no pairing under this alias' : entry.summary,
      })
    } catch (error) {
      sessions.push({
        ...base,
        bound: false,
        summary: '',
        error: {
          code: isPeerError(error) ? error.code : 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          endpoint: isPeerError(error) && error.endpoint !== '' ? error.endpoint : pairing.endpoint,
        },
      })
    }
  }
  return { ok: true, client: source, device: document.device, sessions }
}

// ── Ask retry state ──────────────────────────────────────────────────────────
// A transport failure after remote admission makes a re-run ambiguous: a new
// requestId queues a duplicate user message, while the host deduplicates a
// same-requestId retry (session-controller `hasPromptRequest`). Persist the
// minted requestId per (alias, message digest) together with the baseline turn
// that preceded the original attempt, reuse it on retry, and clear it once the
// follow reports a terminal. The entry is the only cross-process memory.

/** Retry-state path beside the pairing document: `<dir>/peer-bridge/ask-state.json`. */
export function askStatePath(pairingsPath) {
  return join(dirname(pairingsPath), 'peer-bridge', 'ask-state.json')
}

function readAskState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.version === 1 && parsed.entries !== null && typeof parsed.entries === 'object') {
      return { version: 1, entries: parsed.entries }
    }
  } catch {
    // Missing or corrupt state starts fresh; the only cost is retry dedup.
  }
  return { version: 1, entries: {} }
}

function writeAskState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  } catch {
    // A read-only DSH_HOME still runs `ask`; the cost is retry dedup.
  }
}

/**
 * Mint or reuse the requestId for one `ask`. Reuse requires the same alias,
 * target, and message digest and an entry younger than `ASK_RETRY_TTL_MS`; the
 * stored baseline turn is returned so a retry collects a turn that settled
 * since the first attempt.
 * @param options - state path, alias, target key, message, baseline turn, and clock.
 * @returns the requestId, whether it was reused, and the baseline turn to follow from.
 */
export function beginAsk(options) {
  const { statePath, alias, message, baselineTurn, now, target } = options
  const digest = createHash('sha256').update(message, 'utf8').digest('hex')
  const state = readAskState(statePath)
  const entry = state.entries[alias]
  const reusable = entry !== undefined
    && entry.digest === digest
    && entry.target === target
    && typeof entry.requestId === 'string'
    && typeof entry.at === 'number'
    && now - entry.at <= ASK_RETRY_TTL_MS
  const requestId = reusable ? entry.requestId : `peer-cli-${globalThis.crypto.randomUUID()}`
  const followBaselineTurn = reusable && typeof entry.baselineTurn === 'number' ? entry.baselineTurn : baselineTurn
  state.entries[alias] = { digest, target, requestId, at: now, baselineTurn: followBaselineTurn }
  writeAskState(statePath, state)
  return { requestId, reused: reusable, baselineTurn: followBaselineTurn }
}

/**
 * Drop the retry entry once the follow reported a terminal (settled or failed).
 * A pending follow keeps the entry so a retry reuses the admitted requestId.
 * @param statePath - the ask-state file.
 * @param alias - pairing alias.
 * @param requestId - the requestId whose entry to clear.
 */
export function finishAsk(statePath, alias, requestId) {
  const state = readAskState(statePath)
  const entry = state.entries[alias]
  if (entry === undefined || entry.requestId !== requestId) return
  delete state.entries[alias]
  writeAskState(statePath, state)
}

// ── Model control (caller side) ─────────────────────────────────────────────

/**
 * Parse a `provider/model` route argument.
 * @param value - the route string (the model id may itself contain `/`).
 * @returns the provider and model identifiers.
 * @throws Error when the value is not `<provider>/<model>`.
 */
export function parseModelRoute(value) {
  const slash = typeof value === 'string' ? value.indexOf('/') : -1
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`expected "provider/model" (received ${JSON.stringify(value)})`)
  }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/**
 * Turn the create-only `ask` flags into `peer.create` routing fields. Route
 * flags (`--model`, `--chain`) replace the pairing's `create` route for this
 * call; `--effort` and `--max-tokens` travel with whichever route applies.
 * @param flags - parsed CLI flags.
 * @returns the requested create fields; empty when no such flag was given.
 * @throws Error on a malformed route or a non-positive token ceiling.
 */
export function createRoutingFlags(flags) {
  const routing = {}
  if (flags.model !== undefined) Object.assign(routing, parseModelRoute(flags.model))
  if (flags.chain !== undefined) {
    if (flags.chain === '') throw new Error('--chain needs a non-empty chain id')
    routing.chain = flags.chain
  }
  if (flags.effort !== undefined) {
    if (flags.effort === '') throw new Error('--effort needs a non-empty effort')
    routing.reasoningEffort = flags.effort
  }
  if (flags.maxTokens !== undefined) {
    if (!Number.isSafeInteger(flags.maxTokens) || flags.maxTokens <= 0) throw new Error('--max-tokens must be a positive integer')
    routing.maxTotalTokens = flags.maxTokens
  }
  return routing
}

/**
 * Read the routing fields a pairing's `create` block pins, per the parser's
 * rule that `chain` and `reasoningEffort` travel only with `provider`+`model`.
 * @param defaults - the pairing's `create` block.
 * @returns the forwarded routing fields.
 */
function pairingCreateRouting(defaults) {
  if (typeof defaults !== 'object' || defaults === null) return {}
  const routing = {}
  if (typeof defaults.provider === 'string' && typeof defaults.model === 'string') {
    routing.provider = defaults.provider
    routing.model = defaults.model
    if (typeof defaults.chain === 'string') routing.chain = defaults.chain
    if (typeof defaults.reasoningEffort === 'string') routing.reasoningEffort = defaults.reasoningEffort
  }
  return routing
}

/**
 * The failure value a capability-gated command returns instead of forwarding
 * an opaque refusal to a host that cannot serve the call.
 * @param handshake - the host's handshake value.
 * @param capability - the capability the command needs (`model-discovery` / `model-switch`).
 * @returns the failure value, or undefined when the host advertises it.
 */
function capabilityFailure(handshake, capability) {
  const capabilities = Array.isArray(handshake?.capabilities) ? handshake.capabilities : []
  if (capabilities.includes(capability)) return undefined
  return {
    ok: false,
    error: {
      code: 'peer/capability-missing',
      message: `host does not advertise ${capability}; upgrade the host`,
    },
    capabilities,
  }
}

/** Parse a positive integer flag, or fail loudly instead of clamping silently. */
function positiveIntegerFlag(value, name) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

export async function commandModels(flags, positional, deps = {}) {
  const alias = positional[1]
  if (alias === undefined) throw new Error('models needs an alias')
  const document = loadPairings(flags.pairings ?? defaultPairingsPath())
  const pairing = resolvePairing(document, alias)
  const { PeerClient, source } = await loadPeerClient()
  const clientOptions = { endpoint: pairing.endpoint, device: flags.name ?? document.device, headers: headersOf(flags, pairing), maxReconnects: 0 }
  const client = deps.clientFactory === undefined ? new PeerClient(clientOptions) : deps.clientFactory(clientOptions)
  const handshake = await client.handshake()
  const unsupported = capabilityFailure(handshake, 'model-discovery')
  if (unsupported !== undefined) return { ...unsupported, alias, client: source }
  const request = {
    alias,
    participant: { kind: 'peer', name: flags.name ?? document.device, device: flags.name ?? document.device },
    ...(flags.cursor === undefined ? {} : { cursor: flags.cursor }),
    ...(positiveIntegerFlag(flags.limit, '--limit') === undefined ? {} : { limit: flags.limit }),
    ...(flags.zeroPrice || flags.tools
      ? { filter: { ...(flags.zeroPrice ? { zeroPrice: true } : {}), ...(flags.tools ? { tools: true } : {}) } }
      : {}),
  }
  const value = await client.models(request)
  return { ok: true, alias, client: source, ...value }
}

export async function commandSwitch(flags, positional, deps = {}) {
  const alias = positional[1]
  const route = positional[2]
  if (alias === undefined || (route === undefined && flags.chain === undefined)) {
    throw new Error('switch needs <alias> and either <provider/model> or --chain <id>')
  }
  const model = route === undefined ? undefined : parseModelRoute(route)
  if (flags.chain !== undefined && flags.chain === '') throw new Error('--chain needs a non-empty chain id')
  const requestId = flags.requestId ?? `peer-cli-${globalThis.crypto.randomUUID()}`
  if (requestId === '') throw new Error('--request-id needs a non-empty id')
  if (flags.effort !== undefined && flags.effort === '') throw new Error('--effort needs a non-empty effort')
  const document = loadPairings(flags.pairings ?? defaultPairingsPath())
  const pairing = resolvePairing(document, alias)
  const { PeerClient, source } = await loadPeerClient()
  const clientOptions = { endpoint: pairing.endpoint, device: flags.name ?? document.device, headers: headersOf(flags, pairing), maxReconnects: 0 }
  const client = deps.clientFactory === undefined ? new PeerClient(clientOptions) : deps.clientFactory(clientOptions)
  const handshake = await client.handshake()
  const unsupported = capabilityFailure(handshake, 'model-switch')
  if (unsupported !== undefined) return { ...unsupported, alias, client: source }
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
  const value = await client.selectModel({
    target,
    participant: { kind: 'peer', name: flags.name ?? document.device, device: flags.name ?? document.device },
    requestId,
    provider: model?.provider ?? '',
    model: model?.model ?? '',
    ...(flags.chain === undefined ? {} : { chain: flags.chain }),
    ...(flags.effort === undefined ? {} : { reasoningEffort: flags.effort }),
  })
  return { ok: true, alias, requestId, client: source, ...value }
}

export async function commandAsk(flags, positional, deps = {}) {
  const alias = positional[1]
  const message = positional[2]
  if (alias === undefined || message === undefined) throw new Error('ask needs <alias> and <message>')
  const pairingsPath = flags.pairings ?? defaultPairingsPath()
  const document = loadPairings(pairingsPath)
  const pairing = resolvePairing(document, alias)
  const { PeerClient, source } = await loadPeerClient()
  const participant = { kind: 'peer', name: flags.name ?? document.device, device: flags.name ?? document.device }
  const clientOptions = {
    endpoint: pairing.endpoint,
    device: participant.device,
    headers: headersOf(flags, pairing),
    // `ask` follows until --wait expires, exactly like `follow`: a bounded
    // reconnect budget would throw while the remote turn is still alive.
    maxReconnects: undefined,
    onWarning: deps.onWarning ?? (hole => console.error(`[peer] durable history hole [${String(hole.from)}, ${String(hole.to)}) — records in that range are missing locally`)),
  }
  const client = deps.clientFactory === undefined ? new PeerClient(clientOptions) : deps.clientFactory(clientOptions)
  await client.handshake()
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
  // Route and ceiling flags are create-only: a bound session's model changes
  // through `switch`, never by silently dropping a flag on an existing turn.
  const createFlags = createRoutingFlags(flags)
  const routeFlags = createFlags.provider !== undefined || createFlags.chain !== undefined
  const createRouting = { ...(routeFlags ? {} : pairingCreateRouting(pairing.create)), ...createFlags }
  if (createRouting.reasoningEffort !== undefined && createRouting.provider === undefined && createRouting.chain === undefined) {
    throw new Error('--effort needs --model or --chain (the pairing pins no route either)')
  }
  const createOnly = Object.keys(createRouting).length > 0
  let baseline
  let created = false
  try {
    baseline = await client.state(target)
  } catch (error) {
    if (!flags.create || target.kind !== 'alias' || !isPeerError(error) || (error.code !== 'peer/not-paired' && error.code !== 'peer/not-found')) throw error
    const defaults = typeof pairing.create === 'object' && pairing.create !== null ? pairing.create : {}
    await client.create({
      alias,
      participant,
      ...(typeof defaults.cwd === 'string' ? { cwd: defaults.cwd } : {}),
      ...(typeof defaults.agentPreset === 'string' ? { agentPreset: defaults.agentPreset } : {}),
      ...createRouting,
    })
    created = true
    baseline = await client.state(target)
  }
  if (!created && createOnly) {
    throw new Error('ask --model/--chain/--effort/--max-tokens apply only when ask creates or adopts a session; this alias is already bound — use `switch` to change its model and `models` to list the allowed routes')
  }
  const statePath = deps.askStatePath ?? askStatePath(pairingsPath)
  const started = beginAsk({
    statePath,
    alias,
    target: target.kind === 'session' ? target.sessionId : alias,
    message,
    baselineTurn: baseline.state.lastTurnEnd?.turn ?? 0,
    now: deps.now === undefined ? Date.now() : deps.now(),
  })
  // The entry survives a prompt failure on purpose: a retry of the same
  // message reuses this requestId and the host dedups the admission.
  await client.prompt({ target, participant, requestId: started.requestId, content: [{ type: 'text', text: message }], hopCount: 0 })
  const result = await followToSettled({
    client,
    target,
    pairing,
    flags: { ...flags, wait: flags.wait ?? 300 },
    requestId: started.requestId,
    baselineTurn: started.baselineTurn,
    baselineState: baseline.state,
    promptAccepted: true,
    log: (line) => console.error(line),
  })
  if (result.pending !== true) finishAsk(statePath, alias, started.requestId)
  return {
    alias,
    endpoint: pairing.endpoint,
    sessionId: baseline.target.sessionId,
    created,
    requestId: started.requestId,
    requestReused: started.reused,
    client: source,
    ...result,
  }
}

async function commandFollow(flags, positional) {
  const alias = positional[1]
  if (alias === undefined) throw new Error('follow needs an alias')
  const pairingsPath = flags.pairings ?? defaultPairingsPath()
  const document = loadPairings(pairingsPath)
  const pairing = resolvePairing(document, alias)
  const { PeerClient, source } = await loadPeerClient()
  const client = new PeerClient({
    endpoint: pairing.endpoint,
    device: flags.name ?? document.device,
    headers: headersOf(flags, pairing),
    maxReconnects: undefined,
    onWarning: hole => console.error(`[peer] durable history hole [${String(hole.from)}, ${String(hole.to)}) — records in that range are missing locally`),
  })
  await client.handshake()
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
  const result = await followToSettled({ client, target, pairing, flags, requestId: undefined, baselineTurn: -1, log: (line) => console.error(line) })
  return { alias, endpoint: pairing.endpoint, client: source, ...result }
}

async function commandAsks(flags, positional) {
  const alias = positional[1]
  if (alias === undefined) throw new Error('asks needs an alias')
  const document = loadPairings(flags.pairings ?? defaultPairingsPath())
  const pairing = resolvePairing(document, alias)
  const { PeerClient, source } = await loadPeerClient()
  const client = new PeerClient({ endpoint: pairing.endpoint, device: flags.name ?? document.device, headers: headersOf(flags, pairing), maxReconnects: 0 })
  await client.handshake()
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
  const value = await client.state(target)
  return {
    ok: true,
    alias,
    client: source,
    sessionId: value.target.sessionId,
    latch: value.state.latch,
    asks: value.state.pendingAsks.map(ask => ({
      askId: ask.askId,
      kind: ask.kind,
      toolName: ask.toolName ?? null,
      reason: ask.reason ?? null,
      questions: ask.kind === 'question' ? ask.questions ?? [] : null,
      since: ask.since,
    })),
  }
}

/**
 * Send one `peer.answer`. A transport failure may hide a settled answer, so a
 * transport error re-reads the pending asks: an ask that is gone means
 * "settled remotely, confirmation lost"; one still pending keeps the failure.
 */
export async function answerWithConfirmation(client, request) {
  try {
    await client.answer(request)
    return { settled: true, confirmation: 'confirmed' }
  } catch (error) {
    if (isPeerError(error) && error.code === 'peer/target-unreachable' && typeof client.state === 'function') {
      try {
        const value = await client.state(request.target)
        if (!value.state.pendingAsks.some(ask => ask.askId === request.askId)) {
          return {
            settled: false,
            confirmation: 'lost',
            note: 'the answer transport failed with no confirmation, but the remote ask is no longer pending — it was settled remotely (by this answer or another participant); re-run asks before resending',
          }
        }
      } catch {
        // The confirming read failed too; report the original transport failure.
      }
    }
    throw error
  }
}

export async function commandAnswer(flags, positional, deps = {}) {
  const alias = positional[1]
  const askId = positional[2]
  const outcome = positional[3]
  if (alias === undefined || askId === undefined) throw new Error('answer needs <alias> <askId> <once|reject> or <alias> <askId> --select <label>')
  if (flags.select.length > 0 && outcome !== undefined) throw new Error('answer takes either <once|reject> or --select labels, not both')
  if (flags.select.length === 0 && outcome === undefined) throw new Error('answer needs <once|reject> or --select <label>')
  if (outcome !== undefined && outcome !== 'once' && outcome !== 'reject') {
    throw new Error('answer outcome must be once or reject (allowed-always is not grantable from a peer)')
  }
  const document = loadPairings(flags.pairings ?? defaultPairingsPath())
  const pairing = resolvePairing(document, alias)
  const { PeerClient, source } = await loadPeerClient()
  const clientOptions = { endpoint: pairing.endpoint, device: flags.name ?? document.device, headers: headersOf(flags, pairing), maxReconnects: 0 }
  const client = deps.clientFactory === undefined ? new PeerClient(clientOptions) : deps.clientFactory(clientOptions)
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
  const participant = { kind: 'peer', name: flags.name ?? document.device, device: flags.name ?? document.device }
  if (flags.select.length > 0) {
    const value = await client.state(target)
    const ask = value.state.pendingAsks.find(candidate => candidate.askId === askId)
    if (ask === undefined) throw new Error(`no pending ask ${askId} on ${alias} — it may have settled; re-run asks`)
    if (ask.kind !== 'question') throw new Error(`ask ${askId} is an approval ask; answer it with once or reject`)
    const answers = buildQuestionAnswers(Array.isArray(ask.questions) ? ask.questions : [], flags.select)
    const confirmation = await answerWithConfirmation(client, { target, participant, askId, answer: { kind: 'question', answer: { answers } } })
    const rendered = answers.map(answer => `${answer.id}=${answer.selected.join('+')}`).join(', ')
    return {
      ok: true,
      alias,
      askId,
      kind: 'question',
      answers,
      client: source,
      ...confirmation,
      note: confirmation.note ?? `question settled (${rendered}); the first answer won`,
    }
  }
  const confirmation = await answerWithConfirmation(client, {
    target,
    participant,
    askId,
    answer: { kind: 'approval', outcome: outcome === 'once' ? 'allowed-once' : 'rejected' },
  })
  return {
    ok: true,
    alias,
    askId,
    outcome: outcome === 'once' ? 'allowed-once' : 'rejected',
    client: source,
    ...confirmation,
    note: confirmation.note ?? 'ask settled; the first answer won',
  }
}

/**
 * Turn `--select` values into a validated answers[] for one question ask.
 * Accepts `<questionId>=<label>` (unambiguous for multi-question asks) or a
 * bare `<label>` for single-question asks; every question needs a selection.
 */
function buildQuestionAnswers(questions, selectors) {
  if (questions.length === 0) throw new Error('the remote ask carries no questions')
  const byId = new Map(questions.map(question => [question.id, question]))
  const picked = new Map()
  for (const selector of selectors) {
    if (typeof selector !== 'string' || selector === '') throw new Error('--select needs a non-empty label')
    const equals = selector.indexOf('=')
    let id
    let label
    if (equals > 0 && byId.has(selector.slice(0, equals))) {
      id = selector.slice(0, equals)
      label = selector.slice(equals + 1)
    } else if (questions.length === 1) {
      id = questions[0].id
      label = selector
    } else {
      throw new Error(`--select ${JSON.stringify(selector)}: the ask has ${String(questions.length)} questions; use --select <questionId>=<label> (ids: ${questions.map(question => question.id).join(', ')})`)
    }
    if (label === '') throw new Error(`--select ${JSON.stringify(selector)} has no label`)
    const question = byId.get(id)
    const labels = Array.isArray(question.options) ? question.options.map(option => option?.label).filter(candidate => typeof candidate === 'string') : []
    if (labels.length > 0 && !labels.includes(label)) {
      throw new Error(`${JSON.stringify(label)} is not an option of question ${JSON.stringify(id)} (options: ${labels.join(', ')})`)
    }
    const current = picked.get(id) ?? []
    if (question.multiSelect !== true && current.length >= 1) throw new Error(`question ${JSON.stringify(id)} is single-select; pass one label only`)
    if (current.includes(label)) throw new Error(`${JSON.stringify(label)} was selected twice for question ${JSON.stringify(id)}`)
    current.push(label)
    picked.set(id, current)
  }
  const answers = []
  for (const question of questions) {
    const selected = picked.get(question.id) ?? []
    if (selected.length === 0) throw new Error(`question ${JSON.stringify(question.id)} was not answered; add --select ${question.id}=<label>`)
    answers.push({ id: question.id, selected })
  }
  return answers
}

/**
 * Send one `peer.cancel`. A transport failure may hide a preempted turn, so a
 * transport error re-reads the latch: no running turn means "confirmation
 * lost", a still-running turn keeps the failure.
 */
export async function cancelWithConfirmation(client, request) {
  try {
    const value = await client.cancel(request)
    return {
      cancelled: value.cancelled,
      confirmation: 'confirmed',
      note: value.cancelled ? 'remote turn cancelled' : 'remote session had no active turn',
    }
  } catch (error) {
    if (isPeerError(error) && error.code === 'peer/target-unreachable' && typeof client.state === 'function') {
      try {
        const value = await client.state(request.target)
        if (value.state.latch !== 'running') {
          return {
            cancelled: false,
            confirmation: 'lost',
            note: 'the cancel confirmation was lost (transport failure); the remote reports no active turn — it may have completed or been cancelled',
          }
        }
      } catch {
        // The confirming read failed too; report the original transport failure.
      }
    }
    throw error
  }
}

export async function commandCancel(flags, positional, deps = {}) {
  const alias = positional[1]
  if (alias === undefined) throw new Error('cancel needs an alias')
  const document = loadPairings(flags.pairings ?? defaultPairingsPath())
  const pairing = resolvePairing(document, alias)
  const { PeerClient, source } = await loadPeerClient()
  const clientOptions = { endpoint: pairing.endpoint, device: flags.name ?? document.device, headers: headersOf(flags, pairing), maxReconnects: 0 }
  const client = deps.clientFactory === undefined ? new PeerClient(clientOptions) : deps.clientFactory(clientOptions)
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
  const result = await cancelWithConfirmation(client, {
    target,
    participant: { kind: 'peer', name: flags.name ?? document.device, device: flags.name ?? document.device },
  })
  return { ok: true, alias, client: source, ...result }
}

function defaultPairingsPath() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'pairings.yaml')
}

// ── Rendering + main ─────────────────────────────────────────────────────────

function render(command, result, flags) {
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return }
  if (command === 'handshake') {
    const host = result.host
    console.log(`host ${host.hostDevice} · harness ${host.harnessVersion} · protocol ${String(host.protocolVersion)} · client ${result.client}`)
    console.log(`capabilities: ${host.capabilities.join(', ')}`)
    for (const pairing of host.pairings) console.log(`pairing ${pairing.alias} peer=${pairing.peer} exposure=${pairing.exposure} tokenRequired=${String(pairing.tokenRequired)}`)
    return
  }
  if (command === 'status') {
    if (result.bound === true) {
      console.log(`peer ${result.alias} → ${result.host.device} @ ${result.endpoint} (client: ${result.client})`)
      console.log(`session ${result.sessionId} (${result.exposure}) · latch ${result.latch} (${result.latchSource}) · descendants ${String(result.activeDescendants)}`)
      console.log(`model ${result.model === null ? 'unknown' : `${result.model.provider}/${result.model.model}`} · cursor ${String(result.cursor)}`)
      const lastTurn = result.lastTurnEnd
      if (lastTurn !== null && lastTurn !== undefined && lastTurn.ran !== undefined && lastTurn.ran !== null) {
        const ran = lastTurn.ran
        const chain = ran.chain === undefined ? '' : ` (${String(ran.chain)})`
        const hops = typeof ran.hops === 'number' && ran.hops > 0 ? ` · ${String(ran.hops)} hop(s)` : ''
        console.log(`last turn ${String(lastTurn.turn)} ${String(lastTurn.reason)} · ran ${String(ran.provider)}/${String(ran.model)}${chain}${hops}`)
      }
      if (result.budget !== null && result.budget !== undefined) {
        console.log(`budget ${String(result.budget.usedTokens)}/${String(result.budget.maxTotalTokens)} tokens · ${result.budget.metered === true ? 'metered' : 'UNMETERED'}${result.budget.exceeded === true ? ' · exceeded' : ''}`)
      }
      if (result.pendingAsks.length > 0) console.log(`pending: ${result.pendingAsks.join('; ')}`)
    } else if (result.alias !== undefined) {
      console.log(`peer ${result.alias} → ${result.host.device} @ ${result.endpoint}: not bound to a session`)
      console.log(result.note ?? '')
    } else if (result.pairings.length === 0) {
      console.log(result.note ?? 'no caller-role pairings')
    } else {
      console.log(`device ${result.device} · client ${result.client}`)
      for (const pairing of result.pairings) console.log(`pairing ${pairing.alias} peer=${pairing.peer} endpoint=${String(pairing.endpoint)}${pairing.remoteSessionId === null ? '' : ` remoteSessionId=${pairing.remoteSessionId}`}`)
    }
    return
  }
  if (command === 'list') {
    if (!Array.isArray(result.sessions) || result.sessions.length === 0) {
      console.log(result.note ?? `no caller-role pairings on ${String(result.device ?? '')}`)
      return
    }
    console.log(`device ${String(result.device)} · ${String(result.sessions.length)} pairing(s)`)
    for (const session of result.sessions) {
      if (session.error !== undefined) {
        console.log(`• ${session.alias} → ${session.peer} @ ${session.endpoint} · unreachable [${session.error.code ?? 'unknown'}] ${session.error.message}`)
        continue
      }
      const target = session.remoteSessionId === '' ? 'not bound' : `session ${session.remoteSessionId}`
      console.log(`• ${session.alias} → ${session.peer} @ ${session.endpoint} · ${target} (${session.exposure}) bound=${String(session.bound)} latch=${session.latch ?? 'unknown'}${session.summary === '' ? '' : ` — ${session.summary}`}`)
    }
    return
  }
  if (command === 'models') {
    if (result.ok !== true) {
      const error = result.error ?? {}
      console.log(`models failed [${String(error.code ?? 'unknown')}]: ${String(error.message ?? '')}`)
      return
    }
    const chains = Array.isArray(result.chains) ? result.chains : []
    const models = Array.isArray(result.models) ? result.models : []
    console.log(`peer ${result.alias} · ${String(chains.length)} chain(s) · ${String(models.length)} model(s) (client: ${String(result.client)})`)
    for (const chain of chains) {
      const members = (chain.members ?? []).map(member => {
        const until = member.state === 'cooldown' && typeof member.cooldownUntil === 'number' ? ` until ${new Date(member.cooldownUntil).toISOString()}` : ''
        return `${String(member.provider)}/${String(member.model)}=${String(member.state)}${until}`
      })
      console.log(`  chain ${String(chain.id)}${chain.label === undefined ? '' : ` (${String(chain.label)})`}${chain.dynamic === true ? ' dynamic' : ''}: ${members.join(', ')}`)
    }
    for (const model of models) {
      const flags = [
        model.tools === true ? 'tools' : model.tools === 'unknown' ? 'tools?' : '',
        model.zeroPrice === true ? 'zero-price' : model.zeroPrice === 'unknown' ? 'zero-price?' : '',
        model.gated === true ? 'gated' : '',
        `trains=${String(model.trainsOnData)}`,
        typeof model.contextWindow === 'number' ? `ctx=${String(model.contextWindow)}` : '',
        Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0 ? `efforts=${model.reasoningEfforts.join(',')}` : '',
      ].filter(part => part !== '')
      console.log(`  ${String(model.provider)}/${String(model.model)}${flags.length === 0 ? '' : ` · ${flags.join(' · ')}`}`)
    }
    const policy = result.selectableByThisAlias ?? {}
    console.log(`selectable: chains=${(policy.chains ?? []).join(',') || '-'} models=${(policy.models ?? []).join(',') || '-'} switch=${String(policy.allowSwitch ?? 'never')}${policy.requireZeroPrice === true ? ' zero-price-only' : ''}${policy.requireNoTraining === true ? ' no-training-only' : ''}${policy.requireTools === true ? ' tools-only' : ''}`)
    if (result.nextCursor !== undefined) console.log(`next cursor: ${String(result.nextCursor)} (pass --cursor)`)
    return
  }
  if (command === 'switch') {
    if (result.ok !== true) {
      const error = result.error ?? {}
      console.log(`switch failed [${String(error.code ?? 'unknown')}]: ${String(error.message ?? '')}`)
      return
    }
    const selected = result.selected ?? {}
    const chain = selected.chain === undefined ? '' : ` (chain ${String(selected.chain)})`
    const effort = selected.reasoningEffort === undefined ? '' : ` effort=${String(selected.reasoningEffort)}`
    console.log(`switched ${String(result.alias)} → ${String(selected.provider)}/${String(selected.model)}${chain}${effort} · replayed=${String(result.replayed === true)} · requestId ${String(result.requestId)}`)
    if (result.previous !== undefined) console.log(`previous ${String(result.previous.provider)}/${String(result.previous.model)}${result.previous.chain === undefined ? '' : ` (chain ${String(result.previous.chain)})`}`)
    return
  }
  if (command === 'ask' || command === 'follow') {
    if (result.requestReused === true) console.log(`(retry: reused requestId ${result.requestId} — the host dedups a repeated prompt)`)
    if (result.pending === true) { console.log(`PENDING on ${result.alias}: ${result.note}`); return }
    if (result.ok !== true) {
      console.log(`REMOTE TURN FAILED on ${result.alias}: ${String(result.terminal)}${result.remoteError === undefined ? '' : ` [${String(result.remoteError.code)}] ${String(result.remoteError.message)}`}`)
    } else {
      console.log(`remote answer from ${result.alias} (turn ${String(result.turn)}):`)
    }
    if (result.answer !== '') console.log(result.answer)
    if (result.asks.length > 0) console.log(`asks: ${result.asks.join('; ')}`)
    return
  }
  if (command === 'asks') {
    if (result.asks.length === 0) { console.log(`no pending asks on ${result.alias} (latch ${result.latch})`); return }
    console.log(`${String(result.asks.length)} pending ask(s) on ${result.alias}:`)
    for (const ask of result.asks) {
      if (ask.kind === 'question') {
        const questions = (ask.questions ?? []).map(question => {
          const options = (question.options ?? []).map(option => option?.label ?? String(option)).join(', ')
          return `"${String(question.question)}" (id=${String(question.id)}${options === '' ? '' : `; options: ${options}`})`
        }).join('; ')
        console.log(`• ${ask.askId} question ${questions}`)
        console.log(`  answer: answer ${result.alias} ${ask.askId} --select <label> (or --select <questionId>=<label>)`)
      } else {
        console.log(`• ${ask.askId} ${ask.kind} ${ask.toolName ?? ''} ${ask.reason ?? ''}`.trim())
      }
    }
    return
  }
  console.log(result.note ?? JSON.stringify(result))
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const command = positional[0]
  if (flags.help === true) { console.log(usage()); process.exit(0) }
  if (command === undefined) { console.log(usage()); process.exit(2) }
  const commands = {
    handshake: commandHandshake,
    status: commandStatus,
    list: commandList,
    models: commandModels,
    switch: commandSwitch,
    ask: commandAsk,
    follow: commandFollow,
    asks: commandAsks,
    answer: commandAnswer,
    cancel: commandCancel,
  }
  const handler = commands[command]
  if (handler === undefined) { console.error(`unknown command ${JSON.stringify(command)}\n${usage()}`); process.exit(2) }
  const result = await handler(flags, positional)
  render(command, result, flags)
  if (result !== undefined && result.ok === false && result.pending !== true) process.exit(1)
}

// Run only when executed as a program: specs import the settled-follow logic
// (followToSettled/isPeerSessionSettled) without spawning a run.
const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href
if (invokedPath !== undefined && import.meta.url === invokedPath) {
  main().catch((error) => {
    const code = isPeerError(error) ? `[${error.code}] ` : ''
    console.error(`dsh-peer: ${code}${error instanceof Error ? error.message : String(error)}`)
    if (isPeerError(error) && error.endpoint !== undefined && error.endpoint !== '') console.error(`  endpoint: ${error.endpoint}`)
    process.exit(1)
  })
}
