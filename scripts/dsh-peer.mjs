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
 *   status [alias]                   Host summary; with alias: latch + model + asks
 *   list [alias]                     Discover peer sessions (alias, remoteSessionId, latch summary)
 *   ask <alias> <message>            Create/adopt, prompt, follow to terminal
 *   follow <alias>                   Stream frames (asks are printed loudly)
 *   asks <alias>                     List pending remote asks (questions show ids + options)
 *   answer <alias> <askId> <once|reject>
 *   answer <alias> <askId> --select <label> [--select <label> …]
 *   cancel <alias>
 *
 * Flags: --pairings <path> · --json · --header "k: v" (repeatable) ·
 *        --name <participant> · --wait <seconds> · --session <id> · --no-create ·
 *        --select <label> (repeatable; `questionId=label` for multi-question asks)
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

class LocalPeerClient {
  constructor(options) {
    this.endpoint = options.endpoint.replace(/\/+$/u, '')
    this.headers = options.headers ?? {}
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.webSocketFactory = options.webSocket ?? ((url) => new globalThis.WebSocket(url))
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    this.maxReconnects = options.maxReconnects
    this.pageSize = options.pageSize ?? 50
    this.device = options.device ?? hostname()
  }

  async handshake() {
    return this.rpc('handshake', {
      protocolVersion: 1,
      harnessVersion: '0.1.6-alpha.2',
      schemaDigest: '',
      device: this.device,
    })
  }

  state(target) { return this.rpc('state', { target }) }
  list(request) { return this.rpc('list', request ?? {}) }
  create(request) { return this.rpc('create', request) }
  prompt(request) { return this.rpc('prompt', request) }
  cancel(request) { return this.rpc('cancel', request) }
  answer(request) { return this.rpc('answer', request) }
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
        if (isPeerError(error) && error.code === 'peer/version-skew') throw error
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
    for (let page = 0; page < REPAIR_PAGE_LIMIT; page += 1) {
      if (signal.aborted || throughSeq <= fromExclusive) break
      const value = await this.page({ target, throughSeq, maxMessages: this.pageSize })
      if (value.records.length === 0) break
      for (const record of value.records) if (record.seq > fromExclusive && record.seq < toExclusive) collected.push(record)
      const oldest = value.records[0]?.seq
      if (oldest === undefined || oldest <= fromExclusive || !value.hasMore) break
      throughSeq = oldest - 1
    }
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
    '  status [alias]                  Host summary; with alias: latch + model + asks',
    '  list [alias]                    Discover peer sessions: alias, remoteSessionId, latch summary',
    '  ask <alias> <message>           Create/adopt, prompt, follow to a terminal state',
    '  follow <alias>                  Stream frames (asks printed loudly)',
    '  asks <alias>                    List pending remote asks (question options included)',
    '  answer <alias> <askId> <once|reject>',
    '  answer <alias> <askId> --select <label> [--select …]',
    '  cancel <alias>',
    'flags: --wait <seconds>  --session <id>  --no-create  --select <label|questionId=label>',
  ].join('\n')
}

function parseArgs(argv) {
  const flags = { header: [], select: [], wait: undefined, session: undefined, create: true, json: false, pairings: undefined, name: undefined }
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

async function runFollow(options) {
  const { client, target, pairing, flags, requestId, baselineTurn, log, onAsk } = options
  const controller = new AbortController()
  const deadline = flags.wait !== undefined && Number.isFinite(flags.wait) && flags.wait > 0 ? Date.now() + flags.wait * 1000 : undefined
  const timer = deadline === undefined ? undefined : setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()))
  const onSignal = () => controller.abort()
  process.on('SIGINT', onSignal)
  const seenAsks = new Set()
  const answerParts = []
  let terminal
  let admitted = false
  let latch = 'unknown'
  let cursor = 0
  try {
    for await (const frame of client.follow({ target }, controller.signal)) {
      if (frame.type === 'snapshot') {
        cursor = frame.cursor
        latch = frame.state.latch
        for (const record of frame.records) absorbRecord(record, { requestId, baselineTurn, answerParts, admitted: () => admitted, markAdmitted: () => { admitted = true }, terminal: () => terminal, setTerminal: (value) => { terminal = value } })
        for (const ask of frame.state.pendingAsks) if (!seenAsks.has(ask.askId)) { seenAsks.add(ask.askId); log(`ASK: ${askSummary(ask)}`); onAsk?.(ask) }
      } else if (frame.type === 'state') {
        cursor = frame.cursor
        latch = frame.state.latch
        for (const ask of frame.state.pendingAsks) if (!seenAsks.has(ask.askId)) { seenAsks.add(ask.askId); log(`ASK: ${askSummary(ask)}`); onAsk?.(ask) }
      } else if (frame.type === 'event') {
        cursor = Math.max(cursor, frame.record.seq)
        absorbRecord(frame.record, { requestId, baselineTurn, answerParts, admitted: () => admitted, markAdmitted: () => { admitted = true }, terminal: () => terminal, setTerminal: (value) => { terminal = value } })
        if (flags.json !== true) logFrame(frame.record)
      } else if (frame.type === 'end' && frame.reason === 'target-detached') {
        return { ok: false, pending: true, admitted, latch, cursor, asks: [...seenAsks], answer: answerParts.join('\n').trim(), note: 'remote target-detached (pairing/session binding gone)' }
      }
      if (terminal !== undefined && terminal.turn > baselineTurn) break
    }
  } catch (error) {
    if (deadline !== undefined && Date.now() >= deadline) {
      return { ok: false, pending: true, admitted, latch, cursor, asks: [...seenAsks], answer: answerParts.join('\n').trim(), note: `no terminal within ${String(flags.wait)}s — remote turn still live` }
    }
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    process.removeListener('SIGINT', onSignal)
  }
  if (terminal === undefined) {
    return { ok: false, pending: true, admitted, latch, cursor, asks: [...seenAsks], answer: answerParts.join('\n').trim(), note: deadline === undefined ? 'follow ended without a terminal' : 'wait elapsed without a terminal' }
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
    note: terminal.reason === 'completed' ? '' : `remote turn ${String(terminal.turn)} ended: ${terminal.reason}`,
  }
}

function absorbRecord(record, sink) {
  if (recordRpcId(record) === sink.requestId) sink.markAdmitted()
  if (sink.terminal() !== undefined) return
  const turn = recordTurn(record)
  if (record.type === 'assistant/message' && turn !== undefined && turn > sink.baselineTurn) {
    const text = recordAssistantText(record)
    if (text !== '') sink.answerParts.push(text)
    return
  }
  const end = recordTerminal(record)
  if (end !== undefined && end.turn > sink.baselineTurn) sink.setTerminal(end)
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

async function commandAsk(flags, positional) {
  const alias = positional[1]
  const message = positional[2]
  if (alias === undefined || message === undefined) throw new Error('ask needs <alias> and <message>')
  const pairingsPath = flags.pairings ?? defaultPairingsPath()
  const document = loadPairings(pairingsPath)
  const pairing = resolvePairing(document, alias)
  const { PeerClient, source } = await loadPeerClient()
  const participant = { kind: 'peer', name: flags.name ?? document.device, device: flags.name ?? document.device }
  const client = new PeerClient({ endpoint: pairing.endpoint, device: participant.device, headers: headersOf(flags, pairing), maxReconnects: 3 })
  await client.handshake()
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
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
    })
    created = true
    baseline = await client.state(target)
  }
  const requestId = `peer-cli-${globalThis.crypto.randomUUID()}`
  await client.prompt({ target, participant, requestId, content: [{ type: 'text', text: message }], hopCount: 0 })
  const result = await runFollow({
    client,
    target,
    pairing,
    flags: { ...flags, wait: flags.wait ?? 300 },
    requestId,
    baselineTurn: baseline.state.lastTurnEnd?.turn ?? 0,
    log: (line) => console.error(line),
  })
  return { alias, endpoint: pairing.endpoint, sessionId: baseline.target.sessionId, created, requestId, client: source, ...result }
}

async function commandFollow(flags, positional) {
  const alias = positional[1]
  if (alias === undefined) throw new Error('follow needs an alias')
  const pairingsPath = flags.pairings ?? defaultPairingsPath()
  const document = loadPairings(pairingsPath)
  const pairing = resolvePairing(document, alias)
  const { PeerClient, source } = await loadPeerClient()
  const client = new PeerClient({ endpoint: pairing.endpoint, device: flags.name ?? document.device, headers: headersOf(flags, pairing), maxReconnects: undefined })
  await client.handshake()
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
  const result = await runFollow({ client, target, pairing, flags, requestId: undefined, baselineTurn: -1, log: (line) => console.error(line) })
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

async function commandAnswer(flags, positional) {
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
  const client = new PeerClient({ endpoint: pairing.endpoint, device: flags.name ?? document.device, headers: headersOf(flags, pairing), maxReconnects: 0 })
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
  const participant = { kind: 'peer', name: flags.name ?? document.device, device: flags.name ?? document.device }
  if (flags.select.length > 0) {
    const value = await client.state(target)
    const ask = value.state.pendingAsks.find(candidate => candidate.askId === askId)
    if (ask === undefined) throw new Error(`no pending ask ${askId} on ${alias} — it may have settled; re-run asks`)
    if (ask.kind !== 'question') throw new Error(`ask ${askId} is an approval ask; answer it with once or reject`)
    const answers = buildQuestionAnswers(Array.isArray(ask.questions) ? ask.questions : [], flags.select)
    await client.answer({ target, participant, askId, answer: { kind: 'question', answer: { answers } } })
    const rendered = answers.map(answer => `${answer.id}=${answer.selected.join('+')}`).join(', ')
    return { ok: true, alias, askId, kind: 'question', answers, client: source, note: `question settled (${rendered}); the first answer won` }
  }
  await client.answer({
    target,
    participant,
    askId,
    answer: { kind: 'approval', outcome: outcome === 'once' ? 'allowed-once' : 'rejected' },
  })
  return { ok: true, alias, askId, outcome: outcome === 'once' ? 'allowed-once' : 'rejected', client: source, note: 'ask settled; the first answer won' }
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

async function commandCancel(flags, positional) {
  const alias = positional[1]
  if (alias === undefined) throw new Error('cancel needs an alias')
  const document = loadPairings(flags.pairings ?? defaultPairingsPath())
  const pairing = resolvePairing(document, alias)
  const { PeerClient, source } = await loadPeerClient()
  const client = new PeerClient({ endpoint: pairing.endpoint, device: flags.name ?? document.device, headers: headersOf(flags, pairing), maxReconnects: 0 })
  const target = flags.session !== undefined ? { kind: 'session', sessionId: flags.session } : pairing.remoteSessionId !== undefined ? { kind: 'session', sessionId: pairing.remoteSessionId } : { kind: 'alias', alias }
  const value = await client.cancel({ target, participant: { kind: 'peer', name: flags.name ?? document.device, device: flags.name ?? document.device } })
  return { ok: true, alias, cancelled: value.cancelled, client: source, note: value.cancelled ? 'remote turn cancelled' : 'remote session had no active turn' }
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
  if (command === 'ask' || command === 'follow') {
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

main().catch((error) => {
  const code = isPeerError(error) ? `[${error.code}] ` : ''
  console.error(`dsh-peer: ${code}${error instanceof Error ? error.message : String(error)}`)
  if (isPeerError(error) && error.endpoint !== undefined && error.endpoint !== '') console.error(`  endpoint: ${error.endpoint}`)
  process.exit(1)
})
