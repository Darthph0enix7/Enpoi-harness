#!/usr/bin/env node
/**
 * dsh-e2e-drive.mjs — drive one sandbox session through the DSH Remote surface.
 *
 * Doc 69 (P1 / section 9.4): create a session in a sandbox cwd, send one task
 * prompt, follow its durable event stream over /api/remote.mux, and on a
 * terminal turn/end persist the full transcript plus a compact summary.
 *
 * Transport: unary RPC `POST /api/<ns>/<method>` with
 * `{type:'client-request', rpcId, method, payload:{args:{request}}}` and WS mux
 * `/api/remote.mux` (`open|item|error|end`). Auth is the `dsh web` launch-token
 * cookie: over loopback the WS upgrade needs it too, and Node's global
 * WebSocket cannot set headers, so a tiny loopback proxy injects Host+Cookie
 * on the upgrade request.
 *
 * Usage:
 *   node scripts/dsh-e2e-drive.mjs --cwd DIR --task "PROMPT" [options]
 *
 *   --cwd DIR             sandbox working directory (required)
 *   --task TEXT           task prompt admitted as one user turn (required)
 *   --agent-preset NAME   agent preset for session/create (default orchestrator)
 *   --model P/M           call session/selectModel after create (optional)
 *   --timeout SEC         overall deadline before cancel+report (default 900)
 *   --cancel-after SEC    cancel the running turn after SEC (default 60; 0 disables)
 *   --out DIR             output directory (default cwd)
 *   --url URL             server origin (default http://127.0.0.1:3080)
 *   --unit NAME           systemd user unit whose journal holds the launch URL
 *                         (default dsh-web.service)
 *   --cookie FILE         reuse a cookie instead of minting one from the journal
 *   --session-id ID       adopt an existing session instead of session/create
 *   --approve MODE        answer approval/request waterfalls: once|always|reject|off
 *                         (default off: approvals are printed and may park)
 *   --answer TEXT         answer user-questions/request with TEXT as free-form input
 *   --answer-questions M  answer user-questions/request: off|auto|<path-to-json>
 *                         off (default) leaves questions for a human; auto selects
 *                         the first option of every question; a JSON path is an
 *                         object mapping question text (exact or substring) to a
 *                         label, label[], or {selected?, custom?}. Passing the
 *                         flag at all attaches a passive observer, so even `off`
 *                         records every question seen as unanswered.
 *   --summarize FILE      rebuild <sessionId>.summary.md from a transcript.json
 *   --quiet               suppress the live event log
 *
 * Every question seen is appended to <out>/<sessionId>.questions.jsonl, with the
 * chosen answer when one was sent and `answered:false` plus a reason when not.
 * A request is answered only when every question in it is answerable; otherwise
 * the whole request is left unanswered and fails closed as before.
 *
 * Exit codes: 0 terminal turn observed; 3 timeout without terminal; 1 hard failure.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_URL = 'http://127.0.0.1:3080'
const RPC_TIMEOUT_MS = 30_000
const FOLLOW_RECONNECT_LIMIT = 5

const HELP = `dsh-e2e-drive.mjs — drive one DSH session from the command line.

  node scripts/dsh-e2e-drive.mjs --cwd DIR --task "PROMPT" [options]

  --cwd DIR             sandbox working directory (required)
  --task TEXT           task prompt admitted as one user turn (required)
  --agent-preset NAME   agent preset for session/create (default orchestrator)
  --model P/M           call session/selectModel after create (optional)
  --timeout SEC         overall deadline before cancel+report (default 900)
  --cancel-after SEC    cancel the running turn after SEC (default 60; 0 disables)
  --out DIR             output directory (default cwd)
  --url URL             server origin (default http://127.0.0.1:3080)
  --unit NAME           systemd user unit holding the launch URL
                        (default dsh-web.service)
  --cookie FILE         reuse a cookie instead of minting one from the journal
  --session-id ID       adopt an existing session instead of session/create
  --approve MODE        answer approval/request waterfalls: once|always|reject|off
                        (default off: approvals are printed and may park)
  --answer TEXT         answer user-questions/request with TEXT as free-form input
  --answer-questions M  answer user-questions/request: off|auto|<path-to-json>
                        off (default) leaves questions for a human; auto selects
                        the first option of every question; a JSON path maps
                        question text (exact or substring) to a label, label[],
                        or {selected?, custom?}; passing the flag at all attaches
                        a passive observer, so even "off" records questions seen
                        as unanswered
  --summarize FILE      rebuild <sessionId>.summary.md from a transcript.json and exit
  --quiet               suppress the live event log
  --help                this text
`

class DriverError extends Error {}

function fail(message) {
  throw new DriverError(message)
}

function parseArgs(argv) {
  const opts = {
    agentPreset: 'orchestrator',
    timeout: 900,
    cancelAfter: 60,
    out: process.cwd(),
    url: DEFAULT_URL,
    unit: 'dsh-web.service',
    approve: 'off',
    answerQuestions: 'off',
  }
  const take = (name, inline, args, index) => {
    if (inline !== undefined) return inline
    const value = args[index + 1]
    if (value === undefined) fail(`missing value for ${name}`)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    switch (name) {
      case '--cwd': opts.cwd = resolve(take(name, inline, argv, index)); break
      case '--task': opts.task = take(name, inline, argv, index); break
      case '--agent-preset': opts.agentPreset = take(name, inline, argv, index); break
      case '--model': opts.model = take(name, inline, argv, index); break
      case '--timeout': opts.timeout = Number(take(name, inline, argv, index)); break
      case '--cancel-after': opts.cancelAfter = Number(take(name, inline, argv, index)); break
      case '--no-cancel': opts.cancelAfter = 0; break
      case '--out': opts.out = resolve(take(name, inline, argv, index)); break
      case '--url': opts.url = take(name, inline, argv, index); break
      case '--unit': opts.unit = take(name, inline, argv, index); break
      case '--cookie': opts.cookieFile = take(name, inline, argv, index); break
      case '--session-id': opts.sessionId = take(name, inline, argv, index); break
      case '--summarize': opts.summarize = take(name, inline, argv, index); break
      case '--approve': opts.approve = take(name, inline, argv, index); break
      case '--answer': opts.answer = take(name, inline, argv, index); break
      case '--answer-questions': opts.answerQuestions = take(name, inline, argv, index); opts.answerQuestionsGiven = true; break
      case '--quiet': opts.quiet = true; break
      case '--help': case '-h': console.log(HELP); process.exit(0)
      default: fail(`unknown argument ${arg}`)
    }
    if (inline !== undefined) continue
    if (['--cwd', '--task', '--agent-preset', '--model', '--timeout', '--cancel-after', '--out', '--url', '--unit', '--cookie', '--session-id', '--approve', '--answer', '--answer-questions', '--summarize'].includes(name)) index++
  }
  if (opts.summarize !== undefined) return opts
  if (opts.cwd === undefined) fail('--cwd is required')
  if (opts.task === undefined || opts.task.trim() === '') fail('--task is required')
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) fail('--timeout must be a positive number of seconds')
  if (!Number.isFinite(opts.cancelAfter) || opts.cancelAfter < 0) fail('--cancel-after must be >= 0')
  if (opts.model !== undefined && !/^[^/]+\/.+$/.test(opts.model)) fail('--model must be provider/model')
  if (!['once', 'always', 'reject', 'off'].includes(opts.approve)) fail('--approve must be once|always|reject|off')
  if (opts.answerQuestions === 'off' || opts.answerQuestions === 'auto') {
    opts.questionMode = { mode: opts.answerQuestions }
  } else {
    opts.questionMode = { mode: 'map', entries: loadQuestionMap(resolve(opts.answerQuestions)) }
  }
  return opts
}

/** Read the `--answer-questions <path>` JSON map into ordered match entries. */
function loadQuestionMap(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`--answer-questions map ${path} is not readable JSON: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`--answer-questions map ${path} must be a JSON object of question text → label(s)`)
  }
  const entries = []
  for (const [key, value] of Object.entries(parsed)) {
    if (key.trim() === '') fail(`--answer-questions map ${path} has an empty question key`)
    let selected = []
    let custom
    if (typeof value === 'string') {
      selected = [value]
    } else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
      selected = value
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (value.selected !== undefined) {
        if (!Array.isArray(value.selected) || !value.selected.every(item => typeof item === 'string')) {
          fail(`--answer-questions map ${path} entry ${JSON.stringify(key)} .selected must be a string[]`)
        }
        selected = value.selected
      }
      if (value.custom !== undefined) {
        if (typeof value.custom !== 'string') fail(`--answer-questions map ${path} entry ${JSON.stringify(key)} .custom must be a string`)
        custom = value.custom
      }
    } else {
      fail(`--answer-questions map ${path} entry ${JSON.stringify(key)} must be a string, string[], or {selected?, custom?}`)
    }
    if (selected.length === 0 && custom === undefined) fail(`--answer-questions map ${path} entry ${JSON.stringify(key)} chooses nothing`)
    entries.push({ key, selected, custom })
  }
  if (entries.length === 0) fail(`--answer-questions map ${path} is empty`)
  return entries
}

/** Exact question-text match wins; otherwise the longest substring key. */
function matchQuestionMap(entries, text) {
  let best
  for (const entry of entries) {
    if (text === entry.key) return entry
    if (text.includes(entry.key) && (best === undefined || entry.key.length > best.key.length)) best = entry
  }
  return best
}

/** Extract the first dsh-auth cookie from a cookie/header file. */
function cookieFromFile(path) {
  const text = readFileSync(path, 'utf8')
  const match = /dsh-auth-[A-Za-z0-9_-]+=[^\s;]+/.exec(text)
  if (match === null) fail(`no dsh-auth cookie found in ${path}`)
  return match[0]
}

/** Read the last launch-token URL the unit printed and exchange it once. */
async function mintCookie(baseUrl, unit) {
  let journal = ''
  try {
    journal = execFileSync('journalctl', ['--user', '-u', unit, '--no-pager', '-n', '500'], { encoding: 'utf8' })
  } catch (error) {
    fail(`journalctl --user -u ${unit} failed: ${error.message}`)
  }
  const matches = journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9_-]+/g)
  const tokenUrl = matches?.at(-1)
  if (tokenUrl === undefined) fail(`no launch token URL in journalctl -u ${unit}; pass --cookie <file>`)
  const launched = new URL(tokenUrl)
  const base = new URL(baseUrl)
  launched.protocol = base.protocol
  launched.host = base.host
  const response = await fetch(launched, { redirect: 'manual' })
  if (response.status !== 303) fail(`launch-token exchange returned HTTP ${response.status} (expected 303)`)
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  const cookie = setCookies[0]?.split(';', 1)[0]
  if (cookie === undefined || !cookie.startsWith('dsh-auth-')) fail('launch-token exchange returned no dsh-auth cookie')
  return cookie
}

/** TCP proxy that rewrites Host and adds Cookie on one HTTP/WS upgrade path. */
function startCookieProxy({ cookie, authority }) {
  return new Promise((resolveProxy, rejectProxy) => {
    const target = new URL(`http://${authority}`)
    const server = net.createServer((client) => {
      client.on('error', () => {})
      const upstream = net.connect(Number(target.port), target.hostname)
      upstream.on('error', () => client.destroy())
      let buffered = Buffer.alloc(0)
      let rewritten = false
      const onData = (chunk) => {
        if (rewritten) { upstream.write(chunk); return }
        buffered = Buffer.concat([buffered, chunk])
        const headerEnd = buffered.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const head = buffered.subarray(0, headerEnd).toString('latin1')
        const rest = buffered.subarray(headerEnd + 4)
        const lines = head.split('\r\n')
        const kept = [lines[0]]
        for (const line of lines.slice(1)) {
          const name = line.slice(0, Math.max(0, line.indexOf(':'))).toLowerCase()
          if (name === 'host' || name === 'cookie') continue
          kept.push(line)
        }
        kept.push(`Host: ${authority}`)
        if (cookie !== undefined) kept.push(`Cookie: ${cookie}`)
        upstream.write(`${kept.join('\r\n')}\r\n\r\n`)
        if (rest.length > 0) upstream.write(rest)
        rewritten = true
        client.removeListener('data', onData)
        client.pipe(upstream)
        upstream.pipe(client)
      }
      client.on('data', onData)
    })
    server.on('error', rejectProxy)
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      resolveProxy({ server, port: server.address().port })
    })
  })
}

function createState(opts, base) {
  return {
    opts,
    base,
    authority: base.host,
    cookie: undefined,
    logLines: [],
    sessionId: opts.sessionId,
    promptRequestId: randomUUID(),
    events: new Map(),
    log: [],
    snapshotCursor: -1,
    maxSeq: -1,
    promptSeq: undefined,
    terminal: undefined,
    cancelled: false,
    timedOut: false,
    gaps: [],
    streamErrors: [],
    followDown: false,
    startedAt: undefined,
    endedAt: undefined,
  }
}

function note(state, message) {
  const line = `[${new Date().toISOString()}] ${message}`
  state.logLines.push(line)
  if (!state.opts.quiet) console.log(line)
}

/** One unary Remote RPC; returns `result.value` or throws on a structured error. */
async function rpc(state, method, args = {}) {
  const response = await fetch(`${state.base.origin}/api/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...state.cookie === undefined ? {} : { cookie: state.cookie },
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `${method.replace('/', '-')}-${randomUUID()}`,
      method,
      payload: { args },
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) fail(`${method} failed over HTTP ${response.status}: ${text.slice(0, 400)}`)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    fail(`${method} returned non-JSON: ${text.slice(0, 200)}`)
  }
  if (body?.type !== 'server-response' || body.result === undefined) {
    fail(`${method} returned an unexpected frame: ${text.slice(0, 300)}`)
  }
  if (body.result.ok !== true) {
    const error = body.result.error ?? {}
    fail(`${method} failed: ${error.code ?? 'unknown'}: ${error.message ?? JSON.stringify(error)}`)
  }
  return body.result.value
}

function eventPreview(event) {
  const data = event.data ?? {}
  switch (event.type) {
    case 'turn/start': return `turn ${data.turn} start`
    case 'turn/end': return `turn ${data.turn} end · ${reasonText(data.reason)}`
    case 'step/end': return `step ${data.turn}.${data.step} end`
    case 'tool/call': return `tool ${data.name}(${String(data.arguments ?? '').slice(0, 120)})`
    case 'tool/result': return toolResultLine(event)
    case 'assistant/message': return `assistant: ${firstText(data.message?.content).slice(0, 200)}`
    case 'user/message': return `user[${data.source?.kind ?? '?'}]: ${firstText(data.content).slice(0, 120)}`
    case 'approval/asked': return `APPROVAL asked: ${data.toolName ?? '?'} — ${data.reason ?? ''}`
    case 'approval/decided': return `APPROVAL decided: ${data.id ?? '?'} → ${data.outcome ?? '?'}`
    case 'subagent/catalog': return `subagent spawned: ${data.label ?? data.childId ?? '?'}`
    case 'subagent/descriptor': return `subagent ${data.label ?? '?'} (${data.mode ?? '?'})`
    case 'compaction/start': case 'compaction/end': case 'compaction/error':
      return `${event.type}: ${String(data.reason ?? data.error ?? JSON.stringify(data)).slice(0, 140)}`
    case 'state/checkpoint': return `state/checkpoint ${String(data.reason ?? '').slice(0, 80)}`
    case 'llm/retry': return `LLM RETRY ${data.retry}/${data.maxRetries}: ${data.failure?.code ?? '?'} ${String(data.failure?.message ?? '').slice(0, 120)}`
    case 'session/end-seed': return 'session end-seed'
    default: return ''
  }
}

function reasonText(reason) {
  if (reason === undefined) return 'unknown'
  const kind = reason.kind ?? JSON.stringify(reason)
  const error = reason.error
  if (error === undefined) return kind
  return `${kind}${error.code === undefined ? '' : ` (${error.code})`}: ${String(error.message ?? '').slice(0, 160)}`
}

function firstText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join(' ')
}

function resultText(event) {
  const parts = event.data?.message?.content
  if (!Array.isArray(parts)) return ''
  const chunks = []
  for (const part of parts) {
    if (part?.type !== 'tool-result') continue
    chunks.push(firstText(part.content))
  }
  return chunks.join(' ')
}

function toolResultLine(event) {
  const data = event.data ?? {}
  const callId = data.message?.source?.callId ?? '?'
  const error = data.error
  if (error !== undefined) return `tool ${callId} ERROR ${error.name ?? '?'}/${error.code ?? '?'}${error.reason === undefined ? '' : `: ${error.reason}`} — ${resultText(event).slice(0, 120)}`
  const isError = data.message?.content?.some?.(part => part.isError === true) === true
  return `tool ${callId}${isError ? ' ERROR(isError)' : ' ok'} — ${resultText(event).slice(0, 120)}`
}

/** Follow one session over the mux, transparently reconnecting on gaps. */
class FollowClient {
  constructor(state, handlers) {
    this.state = state
    this.handlers = handlers
    this.socket = undefined
    this.socketProxy = undefined
    this.closed = false
  }

  async connect() {
    this.closed = false
    const { authority, cookie } = this.state
    const proxy = await startCookieProxy({ cookie, authority })
    this.socketProxy = proxy
    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/remote.mux`)
    this.socket = socket
    const streamId = `drive-${randomUUID()}`
    const opened = new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error('follow stream did not publish a snapshot in 15s')), 15_000)
      const failed = () => { clearTimeout(timer); rejectOpen(new Error('follow carrier failed before its snapshot')) }
      socket.addEventListener('error', failed, { once: true })
      socket.addEventListener('close', failed, { once: true })
      socket.addEventListener('message', (event) => {
        let frame
        try {
          frame = JSON.parse(typeof event.data === 'string' ? event.data : '')
        } catch {
          return
        }
        if (frame.streamId !== streamId) return
        if (frame.type === 'error') {
          clearTimeout(timer)
          this.state.streamErrors.push(frame.error ?? { code: 'unknown' })
          this.handlers.onStreamError?.(frame.error)
          rejectOpen(new Error(`follow stream error: ${JSON.stringify(frame.error)}`))
          return
        }
        if (frame.type === 'end') {
          clearTimeout(timer)
          rejectOpen(new Error('follow stream ended before its snapshot'))
          return
        }
        if (frame.type !== 'item') return
        const value = frame.value
        if (value?.type === 'snapshot') {
          this.state.snapshotCursor = typeof value.cursor === 'number' ? value.cursor : -1
          this.state.followDown = false
          this.handlers.onSnapshot?.(value)
          clearTimeout(timer)
          resolveOpen()
          return
        }
        if (value?.type === 'event') this.handlers.onEvent(value.event)
        else if (value?.type === 'assistant-stream') this.handlers.onAssistantFrame?.(value.frame)
      })
      socket.addEventListener('close', () => { if (!this.closed) this.handlers.onClose?.() }, { once: true })
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: { args: { request: { address: { kind: 'session', sessionId: this.state.sessionId }, maxMessages: 20 } } },
        }))
      })
    })
    await opened
  }

  close() {
    this.closed = true
    try { this.socket?.close() } catch { /* already closed */ }
    this.socketProxy?.server.close()
  }
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/**
 * Optional `$events` client that answers approval/user-question waterfalls.
 * There is no respond RPC: the Host forwards the waterfall over the same mux
 * (`endpoint: '$events'`) and accepts a unary `$events/result` reply.
 *
 * `answerQuestions` is `{mode:'off'|'auto'}` or `{mode:'map', entries}` from
 * `loadQuestionMap`. Every question is appended to
 * `<out>/<sessionId>.questions.jsonl`; a request is answered only when every
 * question in it has an answer, so a partially answerable request fails closed
 * whole and every line records `answered:false` with the reason.
 */
class EventAnswerer {
  constructor(state, { approve, answer, answerQuestions, outDir }) {
    this.state = state
    this.approve = approve
    this.answer = answer
    this.answerQuestions = answerQuestions
    this.questionsPath = join(outDir, `${state.sessionId}.questions.jsonl`)
    this.clientId = undefined
    this.socket = undefined
    this.proxy = undefined
  }

  async connect() {
    const { authority, cookie } = this.state
    const proxy = await startCookieProxy({ cookie, authority })
    this.proxy = proxy
    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/remote.mux`)
    this.socket = socket
    const streamId = `events-${randomUUID()}`
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }))
    })
    socket.addEventListener('error', () => note(this.state, 'answerer: $events carrier failed'))
    socket.addEventListener('close', () => { if (this.closing !== true) note(this.state, 'answerer: $events carrier closed') })
    socket.addEventListener('message', (event) => {
      let frame
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      if (frame.streamId !== streamId || frame.type !== 'item') return
      const value = frame.value
      if (value?.type === 'ready') {
        this.clientId = value.clientId
        note(this.state, `answerer: $events ready (client ${value.clientId})`)
        return
      }
      if (value?.type === 'waterfall') this.onWaterfall(value)
      if (value?.type === 'cancel') note(this.state, `answerer: waterfall ${value.eventId} cancelled by host`)
    })
  }

  onWaterfall(frame) {
    if (this.clientId === undefined) return
    if (frame.event === 'approval/request') {
      if (this.approve === 'off') {
        note(this.state, `answerer: approval/request left for a human (${String(frame.request?.toolName ?? '?')})`)
        return
      }
      const outcome = this.approve === 'always' ? 'allowed-always' : this.approve === 'reject' ? 'rejected' : 'allowed-once'
      note(this.state, `answerer: approval/request ${String(frame.request?.toolName ?? '?')} → ${outcome}`)
      this.reply(frame, outcome)
      return
    }
    if (frame.event === 'user-questions/request') {
      const questions = Array.isArray(frame.request?.questions) ? frame.request.questions : []
      if (questions.length === 0) {
        note(this.state, 'answerer: user-questions/request with no questions')
        return
      }
      const plans = questions.map(question => this.questionPlan(question))
      const blocked = plans.find(plan => !plan.answered)
      if (blocked !== undefined) {
        const reason = `request left unanswered because question ${blocked.questionId} ${blocked.reason}`
        for (const plan of plans) {
          if (plan.answered) {
            plan.answered = false
            plan.reason = reason
          }
          this.logQuestion(frame, plan)
        }
        note(this.state, `answerer: user-questions/request left unanswered (${blocked.reason})`)
        return
      }
      for (const plan of plans) this.logQuestion(frame, plan)
      const value = {
        answers: plans.map(plan => ({
          id: plan.questionId,
          selected: plan.selected,
          ...plan.custom === undefined ? {} : { custom: plan.custom },
        })),
      }
      const summary = plans.map(plan => plan.selected.join('/') || plan.custom || '?').join(', ')
      note(this.state, `answerer: user-questions/request → ${plans.length} answer(s) [${summary}] (mode ${this.answerQuestions.mode})`)
      this.reply(frame, value)
      return
    }
    note(this.state, `answerer: unhandled waterfall ${frame.event}`)
  }

  /** Decide one question under the configured mode, without side effects. */
  questionPlan(question) {
    const options = (Array.isArray(question?.options) ? question.options : [])
      .map(option => option !== null && typeof option === 'object' ? String(option.label ?? '') : '')
      .filter(label => label !== '')
    const plan = {
      questionId: String(question?.id ?? '?'),
      question: String(question?.question ?? ''),
      options,
      selected: [],
      custom: undefined,
      answered: false,
      reason: undefined,
      mode: this.answerQuestions.mode,
    }
    if (this.answerQuestions.mode === 'auto') {
      if (options.length === 0) {
        plan.reason = 'offers no options for auto to choose'
        return plan
      }
      plan.selected = [options[0]]
      plan.answered = true
      return plan
    }
    if (this.answerQuestions.mode === 'map') {
      const entry = matchQuestionMap(this.answerQuestions.entries, plan.question)
      if (entry === undefined) {
        plan.reason = 'matched no entry of the answer map'
        return plan
      }
      plan.selected = [...entry.selected]
      plan.custom = entry.custom
      plan.answered = true
      return plan
    }
    if (this.answer !== undefined) {
      plan.mode = 'custom'
      plan.custom = this.answer
      plan.answered = true
      return plan
    }
    plan.reason = 'answer-questions is off and no --answer text was given'
    return plan
  }

  /** Append one `<sessionId>.questions.jsonl` line for a seen question. */
  logQuestion(frame, plan) {
    const line = {
      timestamp: new Date().toISOString(),
      sessionId: this.state.sessionId,
      eventId: frame.eventId,
      questionId: plan.questionId,
      question: plan.question,
      options: plan.options,
      selected: plan.selected,
      custom: plan.custom ?? null,
      answered: plan.answered,
      mode: plan.mode,
      reason: plan.reason ?? null,
    }
    try {
      appendFileSync(this.questionsPath, `${JSON.stringify(line)}\n`)
    } catch (error) {
      note(this.state, `answerer: question log append failed: ${error.message}`)
    }
  }

  reply(frame, value) {
    rpc(this.state, '$events/result', {
      clientId: this.clientId,
      eventId: frame.eventId,
      outcome: { kind: 'result', value },
    }).catch(error => note(this.state, `answerer: reply failed: ${error.message}`))
  }

  close() {
    this.closing = true
    try { this.socket?.close() } catch { /* already closed */ }
    this.proxy?.server.close()
  }
}

/** Page events with `fromSeq <= seq <= toSeq`, ascending. */
async function fetchRange(state, fromSeq, toSeq) {
  const collected = []
  let beforeSeq
  for (;;) {
    const page = await rpc(state, 'session/page', {
      request: {
        address: { kind: 'session', sessionId: state.sessionId },
        throughSeq: toSeq,
        ...beforeSeq === undefined ? {} : { beforeSeq },
        maxMessages: 50,
      },
    })
    collected.unshift(...page.records.map(record => record.event))
    const oldest = collected[0]?.seq
    if (!page.hasMore || oldest === undefined || oldest <= fromSeq) break
    beforeSeq = oldest
    if (collected.length > 50_000) break
  }
  return collected.filter(event => event.seq >= fromSeq)
}

function recordEvent(state, event, { live }) {
  const seq = event.seq
  if (typeof seq !== 'number') return
  if (seq <= state.snapshotCursor && !state.events.has(seq)) {
    // Snapshot prefix: retained for the transcript but never re-logged.
    state.events.set(seq, event)
    state.maxSeq = Math.max(state.maxSeq, seq)
    return
  }
  if (state.events.has(seq)) return
  const expected = state.maxSeq + 1
  if (state.maxSeq >= 0 && seq > expected) {
    state.gaps.push({ expected, got: seq, at: new Date().toISOString() })
  }
  state.events.set(seq, event)
  state.maxSeq = seq
  if (live) {
    const preview = eventPreview(event)
    if (preview !== '') note(state, `#${seq} ${preview}`)
    if (event.type === 'user/message' && event.data?.source?.rpcId === state.promptRequestId) {
      state.promptSeq = seq
      state.startedAt = event.time
    } else if (event.type === 'user/message' && state.promptSeq === undefined
      && seq > state.snapshotCursor && event.data?.source?.kind === 'user') {
      // Fallback: the first real user message after our prompt is ours even if
      // the rpcId correlation is absent from the durable source.
      state.promptSeq = seq
      state.startedAt = event.time
    }
    if (event.type === 'turn/end' && state.promptSeq !== undefined && seq > state.promptSeq && state.terminal === undefined) {
      state.terminal = { turn: event.data?.turn, reason: event.data?.reason, seq, time: event.time }
      state.endedAt = event.time
    }
  }
}

async function repairGap(state, follow, gap) {
  note(state, `stream gap: expected seq ${gap.expected}, got ${gap.got} — repairing from page`)
  try {
    const events = await fetchRange(state, gap.expected, gap.got - 1)
    for (const event of events) recordEvent(state, event, { live: false })
    note(state, `gap repair recovered ${events.length} event(s)`)
  } catch (error) {
    note(state, `gap repair failed: ${error.message}`)
  }
  follow.close()
}

async function run(opts) {
  const base = new URL(opts.url)
  const state = createState(opts, base)
  const outDir = opts.out
  mkdirSync(outDir, { recursive: true })

  if (opts.cookieFile !== undefined) {
    state.cookie = cookieFromFile(opts.cookieFile)
    note(state, `auth: cookie from ${opts.cookieFile}`)
  } else {
    state.cookie = await mintCookie(opts.url, opts.unit)
    note(state, `auth: minted launch-token cookie for ${state.authority}`)
  }

  if (opts.sessionId === undefined) {
    const created = await rpc(state, 'session/create', {
      request: { cwd: opts.cwd, agentPreset: opts.agentPreset },
    })
    state.sessionId = created.sessionId
    note(state, `session/create → ${state.sessionId}${created.agentPreset === undefined ? '' : ` (preset ${created.agentPreset})`}`)
  } else {
    note(state, `adopting session ${state.sessionId}`)
  }

  if (opts.model !== undefined) {
    const slash = opts.model.indexOf('/')
    const selected = await rpc(state, 'session/selectModel', {
      request: { sessionId: state.sessionId, provider: opts.model.slice(0, slash), model: opts.model.slice(slash + 1) },
    })
    note(state, `session/selectModel → ${JSON.stringify(selected.selected)}`)
  }

  let terminalResolve
  const terminalSeen = new Promise(resolveTerminal => { terminalResolve = resolveTerminal })
  const terminalPoll = setInterval(() => {
    if (state.terminal !== undefined) terminalResolve(state.terminal)
  }, 250)

  const follow = new FollowClient(state, {
    onSnapshot: (snapshot) => {
      note(state, `follow open: cursor ${snapshot.cursor}, snapshot ${snapshot.records?.length ?? 0} record(s), hasMore=${snapshot.hasMore}`)
    },
    onEvent: (event) => {
      recordEvent(state, event, { live: true })
      if (state.terminal !== undefined) terminalResolve(state.terminal)
    },
    onStreamError: (error) => {
      note(state, `follow stream error frame: ${JSON.stringify(error)}`)
    },
    onClose: () => {
      this.state.followDown = true
      note(state, 'follow carrier closed')
    },
  })

  let reconnects = 0
  const ensureOpen = async () => {
    while (true) {
      try {
        await follow.connect()
        return
      } catch (error) {
        reconnects++
        if (reconnects > FOLLOW_RECONNECT_LIMIT) fail(`follow stream unavailable after ${FOLLOW_RECONNECT_LIMIT} reconnects: ${error.message}`)
        note(state, `follow reconnect ${reconnects}/${FOLLOW_RECONNECT_LIMIT} in 2s: ${error.message}`)
        await sleep(2_000)
      }
    }
  }

  await ensureOpen()
  const answerer = new EventAnswerer(state, {
    approve: opts.approve,
    answer: opts.answer,
    answerQuestions: opts.questionMode,
    outDir,
  })
  if (opts.approve !== 'off' || opts.answer !== undefined || opts.questionMode.mode !== 'off' || opts.answerQuestionsGiven === true) {
    try {
      await answerer.connect()
    } catch (error) {
      note(state, `answerer unavailable: ${error.message}`)
    }
  }
  const promptTime = Date.now()
  await rpc(state, 'session/prompt', {
    request: {
      requestId: state.promptRequestId,
      sessionId: state.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: opts.task }],
    },
  })
  note(state, `session/prompt accepted (requestId ${state.promptRequestId})`)

  const deadline = Date.now() + opts.timeout * 1000
  const cancelAt = opts.cancelAfter > 0 ? promptTime + opts.cancelAfter * 1000 : Infinity
  let cancelSent = false
  const cancel = async (why) => {
    cancelSent = true
    state.cancelled = true
    note(state, `session/cancel (${why})`)
    try {
      await rpc(state, 'session/cancel', { request: { sessionId: state.sessionId } })
    } catch (error) {
      note(state, `session/cancel failed: ${error.message}`)
    }
  }

  while (state.terminal === undefined && Date.now() < deadline) {
    await Promise.race([terminalSeen, sleep(500)])
    if (state.terminal !== undefined) break
    const latestGap = state.gaps.at(-1)
    if (latestGap !== undefined && state.events.has(latestGap.got)) {
      state.gaps.pop()
      await repairGap(state, follow, latestGap)
      await ensureOpen()
      continue
    }
    if (state.followDown) {
      state.followDown = false
      await ensureOpen()
      if (state.maxSeq >= 0 && state.snapshotCursor > state.maxSeq) {
        try {
          const missing = await fetchRange(state, state.maxSeq + 1, state.snapshotCursor)
          for (const event of missing) recordEvent(state, event, { live: false })
          note(state, `follow resumed: recovered ${missing.length} event(s) to cursor ${state.snapshotCursor}`)
        } catch (error) {
          note(state, `follow resume repair failed: ${error.message}`)
        }
      }
      continue
    }
    if (!cancelSent && Date.now() >= cancelAt) {
      await cancel(`cancel-after ${opts.cancelAfter}s`)
    }
  }
  if (state.terminal === undefined) {
    state.timedOut = true
    note(state, `timeout after ${opts.timeout}s with no terminal turn/end`)
    await cancel('timeout')
    await Promise.race([terminalSeen, sleep(20_000)])
  }
  clearInterval(terminalPoll)
  follow.close()
  answerer.close()

  const lastSeq = Math.max(state.snapshotCursor, state.maxSeq)
  let records = []
  try {
    const tailThrough = state.terminal?.seq !== undefined ? state.terminal.seq : lastSeq
    records = await fetchRange(state, -1, tailThrough)
  } catch (error) {
    note(state, `transcript page failed (${error.message}); using live events only`)
  }
  const merged = new Map()
  for (const event of state.events.values()) merged.set(event.seq, event)
  for (const event of records) merged.set(event.seq, event)
  const events = [...merged.values()].sort((left, right) => left.seq - right.seq)

  const transcript = {
    sessionId: state.sessionId,
    cwd: opts.cwd,
    agentPreset: opts.agentPreset,
    requestedModel: opts.model ?? null,
    url: base.origin,
    task: opts.task,
    promptRequestId: state.promptRequestId,
    generatedAt: new Date().toISOString(),
    snapshotCursor: state.snapshotCursor,
    lastSeq,
    eventCount: events.length,
    terminal: state.terminal ?? null,
    cancelled: state.cancelled,
    timedOut: state.timedOut,
    streamGaps: state.gaps,
    streamErrors: state.streamErrors,
    driverLog: state.logLines,
    events,
  }
  const transcriptPath = join(outDir, `${state.sessionId}.transcript.json`)
  writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`)
  const summaryPath = join(outDir, `${state.sessionId}.summary.md`)
  writeFileSync(summaryPath, buildSummary(transcript))
  const logPath = join(outDir, `${state.sessionId}.driver.log`)
  writeFileSync(logPath, `${state.logLines.join('\n')}\n`)

  console.log(JSON.stringify({
    sessionId: state.sessionId,
    terminal: state.terminal ?? null,
    timedOut: state.timedOut,
    cancelled: state.cancelled,
    transcript: transcriptPath,
    summary: summaryPath,
    log: logPath,
  }, null, 2))

  if (state.terminal !== undefined) return 0
  return state.timedOut ? 3 : 1
}

export function buildSummary(transcript) {
  const events = transcript.events
  const lines = []
  const terminal = transcript.terminal
  const terminalText = terminal === null ? '**none** (no terminal turn/end observed)' : `turn ${terminal.turn} · **${reasonText(terminal.reason)}**`
  lines.push(`# E2E session summary — ${transcript.sessionId}`, '')
  lines.push('| field | value |', '|---|---|')
  lines.push(`| cwd | \`${transcript.cwd}\` |`)
  lines.push(`| agent preset | ${transcript.agentPreset} |`)
  lines.push(`| requested model | ${transcript.requestedModel ?? '—'} |`)
  lines.push(`| terminal | ${terminalText} |`)
  lines.push(`| timed out | ${transcript.timedOut} |`)
  lines.push(`| cancelled | ${transcript.cancelled} |`)
  lines.push(`| stream gaps | ${transcript.streamGaps.length} |`)
  lines.push(`| events (durable) | ${events.length} |`)
  lines.push(`| generated | ${transcript.generatedAt} |`)
  lines.push('')

  const turns = new Map()
  const calls = new Map()
  const toolRows = []
  const errors = []
  const approvals = []
  for (const event of events) {
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        turns.set(data.turn, { turn: data.turn, start: event.time, end: undefined, reason: undefined, steps: 0, tools: 0, errors: 0 })
        break
      case 'turn/end': {
        const turn = turns.get(data.turn)
        if (turn !== undefined) {
          turn.end = event.time
          turn.reason = data.reason
        }
        if (data.reason?.kind !== 'completed') {
          errors.push({
            kind: 'turn', seq: event.seq, time: event.time, turn: data.turn,
            label: reasonText(data.reason),
          })
        }
        break
      }
      case 'step/start': {
        const turn = turns.get(data.turn)
        if (turn !== undefined) turn.steps++
        break
      }
      case 'tool/call': {
        calls.set(data.callId, { name: data.name, args: data.arguments, time: event.time, turn: data.turn, step: data.step })
        const turn = turns.get(data.turn)
        if (turn !== undefined) turn.tools++
        break
      }
      case 'tool/result': {
        const callId = data.message?.source?.callId
        const call = calls.get(callId) ?? { name: callId ?? '?', args: '', time: event.time, turn: data.turn, step: data.step }
        const error = data.error
        const text = resultText(event)
        const exitMatch = /\[exit code:\s*(-?\d+)\]/.exec(text)
        const exitCode = exitMatch === null ? undefined : Number(exitMatch[1])
        const isError = error !== undefined || data.message?.content?.some?.(part => part.isError === true) === true
        const failed = isError || (exitCode !== undefined && exitCode !== 0)
        toolRows.push({
          turn: data.turn, step: data.step, name: call.name, callId,
          durationMs: typeof call.time === 'number' ? event.time - call.time : undefined,
          isError: failed, error: error ?? undefined, exitCode, text,
        })
        if (failed) {
          const turn = turns.get(data.turn)
          if (turn !== undefined) turn.errors++
          errors.push({
            kind: 'tool', seq: event.seq, time: event.time, turn: data.turn, step: data.step,
            label: `${call.name} ${error !== undefined
              ? `${error.name ?? '?'}/${error.code ?? '?'}`
              : exitCode === undefined ? '(unstructured isError)' : `exit code ${String(exitCode)}`}`,
            detail: text.slice(0, 400),
          })
        }
        break
      }
      case 'approval/asked': approvals.push({ asked: true, id: data.id, tool: data.toolName, reason: data.reason, at: event.time }); break
      case 'approval/decided': approvals.push({ asked: false, id: data.id, outcome: data.outcome, at: event.time }); break
      default: break
    }
  }

  lines.push('## Turns', '', '| turn | duration | steps | tools | tool errors | end reason |', '|---|---|---|---|---|---|')
  for (const turn of [...turns.values()].sort((a, b) => a.turn - b.turn)) {
    const duration = turn.end === undefined ? '—' : `${((turn.end - turn.start) / 1000).toFixed(1)}s`
    lines.push(`| ${turn.turn} | ${duration} | ${turn.steps} | ${turn.tools} | ${turn.errors} | ${turn.reason === undefined ? 'open' : reasonText(turn.reason)} |`)
  }
  lines.push('')

  lines.push(`## Tool calls (${toolRows.length}; ${toolRows.filter(row => row.isError).length} error)`, '')
  lines.push('| turn.step | tool | duration | status | detail |', '|---|---|---|---|---|')
  for (const row of toolRows) {
    const status = row.isError
      ? `ERROR ${row.error === undefined ? (row.exitCode === undefined ? '' : `exit ${String(row.exitCode)}`) : `${row.error.name ?? '?'}/${row.error.code ?? '?'}`}`
      : 'ok'
    const detail = (row.text || String(row.error?.reason ?? '')).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160)
    lines.push(`| ${row.turn}.${row.step} | ${row.name} | ${row.durationMs === undefined ? '—' : `${(row.durationMs / 1000).toFixed(2)}s`} | ${status} | ${detail} |`)
  }
  lines.push('')

  lines.push(`## Errors and abnormal endings (${errors.length})`, '')
  if (errors.length === 0) lines.push('None.', '')
  for (const error of errors) {
    lines.push(`- [seq ${error.seq}] turn ${error.turn}${error.step === undefined ? '' : `.${error.step}`} ${error.kind}: ${error.label}${error.detail === undefined ? '' : ` — ${error.detail.replace(/\n/g, ' ')}`}`)
  }
  lines.push('')

  lines.push(`## Approvals (${approvals.length})`, '')
  if (approvals.length === 0) lines.push('None.', '')
  for (const approval of approvals) {
    lines.push(`- ${approval.asked ? 'asked' : 'decided'} ${approval.id ?? ''} ${approval.asked ? `${approval.tool ?? ''} — ${approval.reason ?? ''}` : `→ ${approval.outcome ?? ''}`}`)
  }
  lines.push('')

  const finalMessage = [...events].reverse().find(event => event.type === 'assistant/message' && firstText(event.data?.message?.content) !== '')
  lines.push('## Final assistant message', '')
  lines.push(finalMessage === undefined ? '_none_' : firstText(finalMessage.data.message.content).slice(0, 4_000), '')
  return `${lines.join('\n')}\n`
}

/** Regenerate one summary.md from an existing transcript.json. */
function summarize(transcriptPath) {
  const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8'))
  const path = join(dirname(resolve(transcriptPath)), `${transcript.sessionId}.summary.md`)
  writeFileSync(path, buildSummary(transcript))
  return path
}

const invokedAsScript = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedAsScript) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.summarize !== undefined) {
      console.log(summarize(opts.summarize))
      process.exit(0)
    }
    const code = await run(opts)
    process.exit(code)
  } catch (error) {
    if (error instanceof DriverError) {
      console.error(`dsh-e2e-drive: ${error.message}`)
      process.exit(1)
    }
    console.error(`dsh-e2e-drive: unexpected failure\n${error?.stack ?? String(error)}`)
    process.exit(1)
  }
}

export { cookieFromFile, mintCookie, rpc }
