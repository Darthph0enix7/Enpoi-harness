#!/usr/bin/env node
/**
 * dsh-watch.mjs — zero-LLM, read-only progress watcher for running DSH sessions.
 *
 * Polls `session/digest` per session every `--interval` seconds and appends one
 * JSON line per session per tick to `<out>/<sessionId>.watch.jsonl`, plus one
 * compact human line per tick. One `session/list` call per tick supplies the
 * durable event count (`projections.asOfSeq`) and the context-pressure
 * projection; both stay null when the session is detached or the RPC fails.
 * The watcher never prompts and never opens a follow subscription, so it cannot
 * hold, mutate, or answer a session.
 *
 * Auth is the driver's: the same `--url`/`--unit`/`--cookie` options and the
 * same launch-token cookie exchange, reused from `dsh-e2e-drive.mjs` rather
 * than re-implemented.
 *
 * Usage:
 *   node scripts/dsh-watch.mjs SESSION_ID [SESSION_ID...] [options]
 *
 * Exit codes: 0 stopped by Ctrl-C or --until-idle; 4 --max-seconds reached;
 * 1 setup failure.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cookieFromFile, mintCookie, rpc } from './dsh-e2e-drive.mjs'

const DEFAULT_URL = 'http://127.0.0.1:3080'
const SLEEP_SLICE_MS = 250
const LIST_PAGE_LIMIT = 50

const HELP = `dsh-watch.mjs — poll DSH session digests and log progress (read-only).

  node scripts/dsh-watch.mjs SESSION_ID [SESSION_ID...] [options]

  --interval SEC        seconds between ticks (default 10)
  --out DIR             output directory for <sessionId>.watch.jsonl (default cwd)
  --max-seconds SEC     stop after SEC seconds; 0 = no limit (default 0)
  --until-idle ID       exit once ID's latch is idle and its last turn ended
                        (ID is watched even when not listed positionally)
  --recent-tools N      digest recent-tool budget, 0..50 (default 5)
  --url URL             server origin (default http://127.0.0.1:3080)
  --unit NAME           systemd user unit whose journal holds the launch URL
                        (default dsh-web.service)
  --cookie FILE         reuse a cookie instead of minting one from the journal
  --quiet               suppress the per-tick human lines
  --help                this text

Each JSONL line carries: timestamp, tick, sessionId, latch, source,
activeDescendants, pendingAsks, firstAsk, lastTurnEnd, lastTool,
contextPressure, eventCount, rpcMs, and error (null unless this tick failed).
`

class WatchError extends Error {}

function fail(message) {
  throw new WatchError(message)
}

function parseArgs(argv) {
  const opts = {
    interval: 10,
    out: process.cwd(),
    url: DEFAULT_URL,
    unit: 'dsh-web.service',
    recentTools: 5,
    maxSeconds: 0,
    sessionIds: [],
  }
  const take = (name, inline, args, index) => {
    if (inline !== undefined) return inline
    const value = args[index + 1]
    if (value === undefined) fail(`missing value for ${name}`)
    return value
  }
  const takesValue = [
    '--interval', '--out', '--max-seconds', '--until-idle', '--recent-tools',
    '--url', '--unit', '--cookie', '--session-id', '--sessions',
  ]
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('-')) {
      opts.sessionIds.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    switch (name) {
      case '--interval': opts.interval = Number(take(name, inline, argv, index)); break
      case '--out': opts.out = resolve(take(name, inline, argv, index)); break
      case '--max-seconds': opts.maxSeconds = Number(take(name, inline, argv, index)); break
      case '--until-idle': opts.untilIdle = take(name, inline, argv, index); break
      case '--recent-tools': opts.recentTools = Number(take(name, inline, argv, index)); break
      case '--session-id': opts.sessionIds.push(take(name, inline, argv, index)); break
      case '--sessions': opts.sessionIds.push(...take(name, inline, argv, index).split(',').filter(id => id !== '')); break
      case '--url': opts.url = take(name, inline, argv, index); break
      case '--unit': opts.unit = take(name, inline, argv, index); break
      case '--cookie': opts.cookieFile = take(name, inline, argv, index); break
      case '--quiet': opts.quiet = true; break
      case '--help': case '-h': console.log(HELP); process.exit(0)
      default: fail(`unknown argument ${arg}`)
    }
    if (inline === undefined && takesValue.includes(name)) index++
  }
  if (!Number.isFinite(opts.interval) || opts.interval <= 0) fail('--interval must be a positive number of seconds')
  if (!Number.isFinite(opts.maxSeconds) || opts.maxSeconds < 0) fail('--max-seconds must be >= 0')
  if (!Number.isInteger(opts.recentTools) || opts.recentTools < 0 || opts.recentTools > 50) fail('--recent-tools must be an integer 0..50')
  if (opts.untilIdle !== undefined) opts.sessionIds.push(opts.untilIdle)
  opts.sessionIds = [...new Set(opts.sessionIds)]
  if (opts.sessionIds.length === 0) fail('at least one session id is required')
  if (new URL(opts.url) === undefined) fail('--url must be a URL')
  return opts
}

let stopping = false

process.on('SIGINT', () => {
  if (stopping) {
    console.error('[watch] second interrupt — exiting now')
    process.exit(130)
  }
  stopping = true
})

/** Sleep that wakes early when Ctrl-C sets `stopping`. */
function sleep(ms) {
  return new Promise(resolveSleep => {
    const end = Date.now() + ms
    const probe = () => {
      if (stopping || Date.now() >= end) {
        resolveSleep()
        return
      }
      setTimeout(probe, Math.min(SLEEP_SLICE_MS, end - Date.now()))
    }
    probe()
  })
}

/** Newest-first Session list page indexed by id, for asOfSeq and context pressure. */
async function readListIndex(state) {
  const index = new Map()
  try {
    const list = await rpc(state, 'session/list', { request: { limit: LIST_PAGE_LIMIT } })
    for (const item of list?.items ?? []) index.set(String(item.sessionId), item)
    return { index, error: null }
  } catch (error) {
    return { index, error: error.message }
  }
}

/** Bounded recursive search for a context-pressure value inside the digest. */
function findPressure(node, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 3) return null
  if (!Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'contextPressure' && value !== null && typeof value === 'object') return value
      if (key === 'pressureTokens' && typeof value === 'number') return value
      const found = findPressure(value, depth + 1)
      if (found !== null) return found
    }
  }
  return null
}

/** Bounded first-ask row: pending question text or approval tool and reason. */
function summarizeAsk(ask) {
  if (ask === null || typeof ask !== 'object') return null
  if (ask.kind === 'question') {
    const questions = Array.isArray(ask.questions) ? ask.questions : []
    const summary = questions.map(question => String(question?.question ?? '')).filter(text => text !== '').join(' | ')
    return { kind: 'question', askId: ask.askId, count: questions.length, summary: summary.slice(0, 200), since: ask.since ?? null }
  }
  if (ask.kind === 'approval') {
    return { kind: 'approval', askId: ask.askId, tool: ask.toolName, summary: String(ask.reason ?? '').slice(0, 200), since: ask.since ?? null }
  }
  return { kind: String(ask.kind ?? 'unknown'), askId: ask.askId ?? null, summary: JSON.stringify(ask).slice(0, 200), since: ask.since ?? null }
}

/** One tick's JSONL line for one session; errors are recorded, never thrown. */
async function sampleSession(state, sessionId, tick, recentTools, list) {
  const startedAt = Date.now()
  const sample = {
    timestamp: new Date().toISOString(),
    tick,
    sessionId,
    latch: null,
    since: null,
    source: null,
    activeDescendants: null,
    descendantsExact: null,
    pendingAsks: null,
    firstAsk: null,
    lastTurnEnd: null,
    lastTool: null,
    contextPressure: null,
    contextPressureSource: null,
    eventCount: null,
    eventCountSource: null,
    rpcMs: null,
    error: null,
  }
  try {
    const digest = await rpc(state, 'session/digest', { request: { sessionId, recentTools } })
    const exec = digest?.state ?? {}
    sample.latch = exec.latch ?? null
    sample.since = exec.since ?? null
    sample.source = exec.source ?? null
    sample.activeDescendants = exec.activeDescendants ?? null
    sample.descendantsExact = exec.descendantsExact ?? null
    const asks = Array.isArray(digest?.pendingInteractions) ? digest.pendingInteractions
      : Array.isArray(exec.pendingAsks) ? exec.pendingAsks : []
    sample.pendingAsks = asks.length
    sample.firstAsk = asks.length === 0 ? null : summarizeAsk(asks[0])
    if (exec.lastTurnEnd != null) {
      const error = exec.lastTurnEnd.error
      sample.lastTurnEnd = {
        turn: exec.lastTurnEnd.turn,
        kind: exec.lastTurnEnd.reason,
        reason: error == null ? null : `${error.code ?? '?'}: ${error.message ?? ''}`,
        at: exec.lastTurnEnd.at ?? null,
      }
    }
    const tool = Array.isArray(digest?.recentToolCalls) ? digest.recentToolCalls[0] : undefined
    if (tool !== undefined && tool !== null) {
      sample.lastTool = {
        tool: tool.tool,
        status: tool.status,
        error: tool.error == null ? null : `${tool.error.name ?? '?'}/${tool.error.code ?? '?'}${tool.error.reason === undefined ? '' : `: ${tool.error.reason}`}`,
      }
    }
    const pressure = findPressure(digest)
    if (pressure !== null) {
      sample.contextPressure = pressure
      sample.contextPressureSource = 'session/digest'
    }
  } catch (error) {
    sample.error = error.message
  }
  const item = list.index.get(sessionId)
  if (item !== undefined) {
    const asOf = item.projections?.asOfSeq
    if (typeof asOf === 'number') {
      sample.eventCount = asOf
      sample.eventCountSource = 'session/list.asOfSeq'
    }
    const pressure = item.projections?.values?.contextPressure
    if (sample.contextPressure === null && pressure !== undefined && pressure !== null) {
      sample.contextPressure = pressure
      sample.contextPressureSource = 'session/list.contextPressure'
    }
  } else if (list.error !== null && sample.error === null) {
    sample.error = `session/list: ${list.error}`
  }
  sample.rpcMs = Date.now() - startedAt
  return sample
}

function formatPressure(value) {
  if (typeof value === 'number') return String(value)
  const pressure = value.pressureTokens ?? value.projectedTokens
  if (typeof pressure !== 'number') return JSON.stringify(value).slice(0, 48)
  const used = `${(pressure / 1000).toFixed(1)}k`
  const window = value.contextWindow
  return typeof window === 'number' && window > 0 ? `${used}/${(window / 1000).toFixed(1)}k` : used
}

/** One compact terminal line: latch, descendants, asks, turn, tool, events, ctx. */
function humanLine(sample) {
  const time = sample.timestamp.slice(11, 19)
  const short = sample.sessionId.length > 24 ? `${sample.sessionId.slice(0, 24)}…` : sample.sessionId
  if (sample.error !== null) return `[${time}] ${short} ERROR ${sample.error}`
  const bits = [sample.latch ?? 'unknown']
  if (sample.activeDescendants !== null) bits.push(`desc=${sample.activeDescendants}${sample.descendantsExact === false ? '?' : ''}`)
  const ask = sample.firstAsk
  bits.push(`asks=${sample.pendingAsks ?? '?'}${ask === null ? '' : `(${ask.kind}:${String(ask.summary ?? '').slice(0, 40)})`}`)
  if (sample.lastTurnEnd !== null) {
    bits.push(`turn=${sample.lastTurnEnd.turn}:${sample.lastTurnEnd.kind}${sample.lastTurnEnd.reason === null ? '' : `(${sample.lastTurnEnd.reason})`}`)
  }
  if (sample.lastTool !== null) {
    bits.push(`tool=${sample.lastTool.tool}:${sample.lastTool.status}${sample.lastTool.error === null ? '' : `(${sample.lastTool.error})`}`)
  }
  if (sample.eventCount !== null) bits.push(`events=${sample.eventCount}`)
  if (sample.contextPressure !== null) bits.push(`ctx=${formatPressure(sample.contextPressure)}`)
  return `[${time}] ${short} ${bits.join(' ')}`
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const state = { base: new URL(opts.url), cookie: undefined }
  if (opts.cookieFile !== undefined) {
    state.cookie = cookieFromFile(opts.cookieFile)
    console.log(`[watch] auth: cookie from ${opts.cookieFile}`)
  } else {
    state.cookie = await mintCookie(opts.url, opts.unit)
    console.log(`[watch] auth: minted launch-token cookie for ${state.base.host}`)
  }

  mkdirSync(opts.out, { recursive: true })
  const paths = new Map(opts.sessionIds.map(sessionId => [sessionId, join(opts.out, `${sessionId}.watch.jsonl`)]))
  const startedAt = Date.now()
  const deadline = opts.maxSeconds > 0 ? startedAt + opts.maxSeconds * 1000 : Infinity
  console.log(`[watch] watching ${opts.sessionIds.length} session(s) every ${opts.interval}s → ${opts.out}`
    + `${opts.untilIdle === undefined ? '' : ` · until ${opts.untilIdle} is idle`}`
    + `${opts.maxSeconds > 0 ? ` · max ${opts.maxSeconds}s` : ''}`)

  let tick = 0
  let lines = 0
  let stopReason = 'interrupted'
  while (!stopping) {
    if (Date.now() >= deadline) {
      stopReason = 'max-seconds'
      break
    }
    tick++
    const list = await readListIndex(state)
    if (list.error !== null) console.error(`[watch] session/list failed: ${list.error}`)
    for (const sessionId of opts.sessionIds) {
      const sample = await sampleSession(state, sessionId, tick, opts.recentTools, list)
      try {
        appendFileSync(paths.get(sessionId), `${JSON.stringify(sample)}\n`)
        lines++
      } catch (error) {
        console.error(`[watch] append failed for ${sessionId}: ${error.message}`)
      }
      if (!opts.quiet) console.log(humanLine(sample))
      if (sessionId === opts.untilIdle && sample.error === null
        && sample.latch === 'idle' && sample.lastTurnEnd !== null) {
        stopReason = 'until-idle'
        break
      }
    }
    if (stopReason === 'until-idle') break
    await sleep(opts.interval * 1000)
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`[watch] stopped (${stopReason}) after ${tick} tick(s), ${lines} line(s), ${elapsed}s → ${opts.out}`)
  if (stopReason === 'max-seconds') return 4
  return 0
}

try {
  const code = await main()
  process.exit(code)
} catch (error) {
  if (error instanceof WatchError) {
    console.error(`dsh-watch: ${error.message}`)
    process.exit(1)
  }
  console.error(`dsh-watch: unexpected failure\n${error?.stack ?? String(error)}`)
  process.exit(1)
}
