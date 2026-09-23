#!/usr/bin/env node
/**
 * dsh-e2e-harvest.mjs — extract every error-ish signal from DSH session logs.
 *
 * Doc 69 (P1 / section 9.4): given a session id (or every session touched since
 * a timestamp), decode the zstd JSONL session generation with `zstd -dc` and
 * report tool errors, turn endings, approvals, compaction/checkpoint events,
 * retry failures and any other `error` payload, then merge the matching
 * diagnostics-store rows (`~/.dsh/diagnostics/incidents.sqlite`) for the same
 * window. Emits one JSON and one markdown report per session.
 *
 * Usage:
 *   node scripts/dsh-e2e-harvest.mjs --session <id> [--session <id2>] [options]
 *   node scripts/dsh-e2e-harvest.mjs --all-since <ISO|epoch-ms> [options]
 *
 *   --session ID          session id to harvest (repeatable)
 *   --all-since TS        harvest every session whose log was written at/after TS
 *   --out DIR             output directory (default cwd)
 *   --sessions-root DIR   session store root (default ~/.dsh/sessions)
 *   --diagnostics-db FILE incidents sqlite (default ~/.dsh/diagnostics/incidents.sqlite)
 *   --no-diagnostics      skip the diagnostics merge
 *   --window-pad SEC      diagnostics window padding (default 120)
 *   --help                this text
 *
 * Exit codes: 0 success; 1 usage or total failure.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

class HarvestError extends Error {}

const HELP = `dsh-e2e-harvest.mjs — harvest error signals from DSH session logs.

  node scripts/dsh-e2e-harvest.mjs --session <id> [--session <id2>] [options]
  node scripts/dsh-e2e-harvest.mjs --all-since <ISO|epoch-ms> [options]

  --session ID          session id to harvest (repeatable)
  --all-since TS        harvest every session whose log was written at/after TS
  --out DIR             output directory (default cwd)
  --sessions-root DIR   session store root (default ~/.dsh/sessions)
  --diagnostics-db FILE incidents sqlite
                        (default ~/.dsh/diagnostics/incidents.sqlite)
  --no-diagnostics      skip the diagnostics merge
  --window-pad SEC      diagnostics window padding (default 120)
  --help                this text
`

function fail(message) {
  throw new HarvestError(message)
}

function parseArgs(argv) {
  const opts = {
    sessions: [],
    sessionsRoot: join(homedir(), '.dsh', 'sessions'),
    diagnosticsDb: join(homedir(), '.dsh', 'diagnostics', 'incidents.sqlite'),
    out: process.cwd(),
    windowPadSec: 120,
    diagnostics: true,
  }
  const take = (name, inline, args, index) => {
    if (inline !== undefined) return inline
    const value = args[index + 1]
    if (value === undefined) fail(`missing value for ${name}`)
    return value
  }
  const valueFlags = new Set(['--session', '--all-since', '--out', '--sessions-root', '--diagnostics-db', '--window-pad'])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    switch (name) {
      case '--session': opts.sessions.push(take(name, inline, argv, index)); break
      case '--all-since': opts.allSince = take(name, inline, argv, index); break
      case '--out': opts.out = take(name, inline, argv, index); break
      case '--sessions-root': opts.sessionsRoot = take(name, inline, argv, index); break
      case '--diagnostics-db': opts.diagnosticsDb = take(name, inline, argv, index); break
      case '--window-pad': opts.windowPadSec = Number(take(name, inline, argv, index)); break
      case '--no-diagnostics': opts.diagnostics = false; break
      case '--help': case '-h': console.log(HELP); process.exit(0)
      default: fail(`unknown argument ${arg}`)
    }
    if (inline === undefined && valueFlags.has(name)) index++
  }
  if (opts.sessions.length === 0 && opts.allSince === undefined) {
    fail('pass --session <id> (repeatable) or --all-since <ts>')
  }
  if (!Number.isFinite(opts.windowPadSec) || opts.windowPadSec < 0) fail('--window-pad must be >= 0')
  return opts
}

function parseSince(value) {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) fail(`--all-since is neither epoch-ms nor a parseable date: ${value}`)
  return parsed
}

/** Every canonical JSONL generation under the session store. */
function listLogs(root) {
  const logs = []
  let projects = []
  try {
    projects = readdirSync(root)
  } catch (error) {
    fail(`cannot read sessions root ${root}: ${error.message}`)
  }
  for (const project of projects) {
    const projectDir = join(root, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const sessionDirName of readdirSync(projectDir)) {
      const sessionDir = join(projectDir, sessionDirName)
      if (!statSync(sessionDir).isDirectory()) continue
      const files = readdirSync(sessionDir)
        .filter(name => /^session\..*\.jsonl(\.zstd)?(\.\d+)?$/.test(name) || /^session\.\d+\.jsonl(\.zstd)$/.test(name))
        .map(name => join(sessionDir, name))
      if (files.length === 0) continue
      logs.push({ sessionId: sessionDirName, sessionDir, files, mtime: Math.max(...files.map(file => statSync(file).mtimeMs)) })
    }
  }
  return logs
}

function findLog(logs, id) {
  const bare = id.replace(/^session-/, '')
  return logs.find(entry => entry.sessionId === id
    || entry.sessionId === bare
    || entry.sessionId.replace(/^session-/, '') === bare)
}

/** Decode one session generation (all version files merged by seq). */
function decodeSession(entry) {
  const events = new Map()
  let header
  const ordered = [...entry.files].sort()
  for (const file of ordered) {
    let text = ''
    try {
      text = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
    } catch (error) {
      fail(`zstd -dc ${file} failed: ${error.message}`)
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (record.type === 'session') {
        header ??= record
        continue
      }
      if (typeof record.seq !== 'number') continue
      events.set(record.seq, record)
    }
  }
  return { header, events: [...events.values()].sort((left, right) => left.seq - right.seq) }
}

function firstText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join(' ')
}

function truncate(text, length = 300) {
  const value = String(text ?? '')
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

function reasonText(reason) {
  if (reason === undefined) return 'unknown'
  const kind = reason.kind ?? JSON.stringify(reason)
  const error = reason.error
  if (error === undefined) return kind
  return `${kind}${error.code === undefined ? '' : ` (${error.code})`}: ${String(error.message ?? '').slice(0, 300)}`
}

function isErrorResult(event) {
  if (event.data?.error !== undefined) return true
  return event.data?.message?.content?.some?.(part => part.isError === true) === true
}

function resultText(event) {
  const parts = event.data?.message?.content
  if (!Array.isArray(parts)) return ''
  return parts.filter(part => part?.type === 'tool-result').map(part => firstText(part.content)).join(' ')
}

/** Walk event data and catalogue every `error` key by JSON path. */
function errorPayloads(event, limit = 40) {
  const found = []
  const walk = (value, path, depth) => {
    if (depth > 6 || found.length >= limit || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.slice(0, 5).forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1))
      return
    }
    for (const [key, child] of Object.entries(value)) {
      const next = `${path}.${key}`
      if (key === 'error' && child !== null && child !== undefined) {
        found.push({ path: next, value: child })
      } else if (key !== 'message' && key !== 'stream') {
        walk(child, next, depth + 1)
      }
    }
  }
  walk(event.data ?? {}, `${event.type}`, 0)
  return found
}

function extract(events) {
  const calls = new Map()
  const toolCalls = []
  const toolErrors = []
  const commandFailures = []
  const toolResults = []
  const turnEnds = []
  const turnErrors = []
  const approvalsAsked = []
  const approvalsDecided = []
  const compactions = []
  const checkpoints = []
  const retries = []
  const genericErrors = []
  const otherErrorish = []

  for (const event of events) {
    const data = event.data ?? {}
    switch (event.type) {
      case 'tool/call': {
        const call = { callId: data.callId, name: data.name, arguments: data.arguments, seq: event.seq, time: event.time, turn: data.turn, step: data.step }
        calls.set(data.callId, call)
        toolCalls.push(call)
        break
      }
      case 'tool/result': {
        const callId = data.message?.source?.callId
        const call = calls.get(callId)
        const error = data.error
        const isError = isErrorResult(event)
        const fullText = resultText(event)
        const row = {
          seq: event.seq,
          time: event.time,
          turn: data.turn,
          step: data.step,
          callId,
          tool: call?.name ?? null,
          arguments: call?.arguments === undefined ? null : truncate(call.arguments, 200),
          durationMs: call === undefined ? null : event.time - call.time,
          isError,
          errorName: error?.name ?? null,
          errorCode: error?.code ?? null,
          errorReason: error?.reason ?? null,
          structured: error !== undefined,
          message: truncate(fullText, 500),
        }
        toolResults.push(row)
        if (isError) toolErrors.push({ ...row, label: `${row.tool ?? callId ?? '?'} ${error === undefined ? '(unstructured isError)' : `${error.name ?? '?'}/${error.code ?? '?'}`}` })
        else {
          const exit = /\[exit code:\s*(-?\d+)\]/.exec(fullText)
          row.exitCode = exit === null ? null : Number(exit[1])
          if (row.exitCode !== null && row.exitCode !== 0) commandFailures.push(row)
        }
        break
      }
      case 'turn/end': {
        const row = { seq: event.seq, time: event.time, turn: data.turn, kind: data.reason?.kind ?? null, error: data.reason?.error ?? null, reason: data.reason ?? null, label: reasonText(data.reason) }
        turnEnds.push(row)
        if (row.kind !== 'completed') turnErrors.push(row)
        break
      }
      case 'approval/asked':
        approvalsAsked.push({ seq: event.seq, time: event.time, id: data.id ?? null, tool: data.toolName ?? null, callId: data.callId ?? null, reason: truncate(data.reason, 300) })
        break
      case 'approval/decided':
        approvalsDecided.push({ seq: event.seq, time: event.time, id: data.id ?? null, outcome: data.outcome ?? null })
        break
      case 'state/checkpoint':
        checkpoints.push({ seq: event.seq, time: event.time, reason: data.reason ?? null, keys: Object.keys(data) })
        break
      case 'llm/retry':
        retries.push({ seq: event.seq, time: event.time, turn: data.turn, step: data.step, retry: data.retry, maxRetries: data.maxRetries, failure: data.failure ?? null, delayMs: data.delayMs ?? null })
        break
      default:
        if (event.type.startsWith('compaction/')) {
          compactions.push({ seq: event.seq, time: event.time, type: event.type, reason: data.reason ?? null, error: data.error ?? null, keys: Object.keys(data) })
        }
        break
    }
    for (const payload of errorPayloads(event)) {
      const entry = { seq: event.seq, time: event.time, type: event.type, path: payload.path, value: payload.value }
      const covered = (event.type === 'tool/result' && payload.path.startsWith('tool/result.error'))
        || (event.type === 'turn/end' && payload.path === 'turn/end.reason.error')
      if (covered) continue
      if (event.type === 'llm/retry' || event.type === 'compaction/error') {
        otherErrorish.push(entry)
        continue
      }
      genericErrors.push(entry)
    }
  }
  return {
    toolCalls, toolResults, toolErrors, commandFailures, turnEnds, turnErrors,
    approvalsAsked, approvalsDecided, compactions, checkpoints, retries,
    genericErrors, otherErrorish,
  }
}

async function readDiagnostics(dbPath, { start, end, sessionId }) {
  const select = 'SELECT id, at, severity, source, kind, code, fingerprint, message, context_json AS contextJson, session_id AS sessionId, provider, model, count FROM incidents'
  const query = `${select} WHERE at BETWEEN ? AND ? ORDER BY at`
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db.prepare(query).all(start, end)
      const matched = db.prepare(`${select} WHERE session_id = ? ORDER BY at`).all(sessionId)
      const seen = new Set(rows.map(row => row.id))
      return {
        available: true,
        driver: 'node:sqlite',
        rows: [...rows, ...matched.filter(row => !seen.has(row.id))].map(row => ({ ...row, windowMatch: row.at >= start && row.at <= end })),
      }
    } finally {
      db.close()
    }
  } catch (error) {
    try {
      const sql = `${select.replace(/ AS \w+/g, '')} WHERE at BETWEEN ${Number(start)} AND ${Number(end)} ORDER BY at`
      const json = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      const rows = json.trim() === '' ? [] : JSON.parse(json)
      return { available: true, driver: 'sqlite3', rows: rows.map(row => ({ ...row, windowMatch: true })) }
    } catch (fallbackError) {
      return { available: false, driver: null, rows: [], error: `${error.message}; sqlite3 fallback: ${fallbackError.message}` }
    }
  }
}

function windowOf(events) {
  const times = events.map(event => event.time).filter(time => typeof time === 'number')
  return { start: Math.min(...times), end: Math.max(...times) }
}

function buildReport(session, extraction, diagnostics, diagnosticsWindow, logPath) {
  const events = session.events
  const window = windowOf(events)
  const incidents = diagnostics.rows
  const counts = {
    events: events.length,
    toolCalls: extraction.toolCalls.length,
    toolResults: extraction.toolResults.length,
    toolErrors: extraction.toolErrors.length,
    commandFailures: extraction.commandFailures.length,
    turnEnds: extraction.turnEnds.length,
    abnormalTurnEnds: extraction.turnErrors.length,
    approvalsAsked: extraction.approvalsAsked.length,
    approvalsDecided: extraction.approvalsDecided.length,
    compactions: extraction.compactions.length,
    checkpoints: extraction.checkpoints.length,
    llmRetries: extraction.retries.length,
    genericErrorPayloads: extraction.genericErrors.length,
    diagnosticsRows: incidents.length,
  }
  return {
    sessionId: session.header?.id ?? session.entry.sessionId,
    header: session.header ?? null,
    logPath,
    window: {
      start: window.start,
      end: window.end,
      startIso: new Date(window.start).toISOString(),
      endIso: new Date(window.end).toISOString(),
      diagnosticsQuery: { start: diagnosticsWindow.start, end: diagnosticsWindow.end },
    },
    diagnostics,
    counts,
    toolCalls: extraction.toolCalls,
    toolErrors: extraction.toolErrors,
    commandFailures: extraction.commandFailures,
    turnEnds: extraction.turnEnds,
    abnormalTurnEnds: extraction.turnErrors,
    approvals: { asked: extraction.approvalsAsked, decided: extraction.approvalsDecided },
    compactions: extraction.compactions,
    checkpoints: extraction.checkpoints,
    llmRetries: extraction.retries,
    genericErrorPayloads: extraction.genericErrors,
    otherErrorish: extraction.otherErrorish,
  }
}

function table(rows, columns) {
  if (rows.length === 0) return 'None.\n'
  const head = `| ${columns.map(column => column.label).join(' | ')} |`
  const rule = `|${columns.map(() => '---').join('|')}|`
  const body = rows.map(row => `| ${columns.map(column => {
    const value = column.value(row)
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  }).join(' | ')} |`)
  return `${[head, rule, ...body].join('\n')}\n`
}

function buildMarkdown(report) {
  const lines = []
  lines.push(`# Error harvest — ${report.sessionId}`, '')
  lines.push('| field | value |', '|---|---|')
  lines.push(`| log | \`${report.logPath}\` |`)
  lines.push(`| window | ${report.window.startIso} → ${report.window.endIso} |`)
  lines.push(`| cwd | \`${report.header?.cwd ?? '?'}\` |`)
  lines.push(`| agent preset | ${report.header?.agentPreset ?? '?'} |`)
  lines.push(`| diagnostics store | ${report.diagnostics.available ? `yes (${report.diagnostics.driver})` : `unavailable — ${report.diagnostics.error ?? 'unknown'}`} |`)
  lines.push('')
  lines.push('## Counts', '')
  lines.push('| signal | count |', '|---|---|')
  for (const [key, value] of Object.entries(report.counts)) lines.push(`| ${key} | ${value} |`)
  lines.push('')
  lines.push(`## Tool errors (${report.toolErrors.length})`, '')
  lines.push(table(report.toolErrors, [
    { label: 'seq', value: row => row.seq },
    { label: 'turn.step', value: row => `${row.turn}.${row.step}` },
    { label: 'tool', value: row => row.tool ?? row.callId },
    { label: 'error', value: row => row.structured ? `${row.errorName}/${row.errorCode}${row.errorReason === null ? '' : `: ${row.errorReason}`}` : 'unstructured isError' },
    { label: 'duration', value: row => row.durationMs === null ? '—' : `${(row.durationMs / 1000).toFixed(2)}s` },
    { label: 'message', value: row => truncate(row.message, 160) },
  ]))
  lines.push(`## Nonzero-exit tool results (${report.commandFailures.length})`, '')
  lines.push('Structured `error` is absent for these; the exit code is embedded in the result text.', '')
  lines.push(table(report.commandFailures, [
    { label: 'seq', value: row => row.seq },
    { label: 'turn.step', value: row => `${row.turn}.${row.step}` },
    { label: 'tool', value: row => row.tool ?? row.callId },
    { label: 'exit', value: row => row.exitCode },
    { label: 'duration', value: row => row.durationMs === null ? '—' : `${(row.durationMs / 1000).toFixed(2)}s` },
    { label: 'text', value: row => truncate(row.message, 200) },
  ]))
  lines.push(`## Turn endings (${report.turnEnds.length}; ${report.abnormalTurnEnds.length} abnormal)`, '')
  lines.push(table(report.abnormalTurnEnds, [
    { label: 'seq', value: row => row.seq },
    { label: 'turn', value: row => row.turn },
    { label: 'kind', value: row => row.kind },
    { label: 'error', value: row => row.error === null ? '' : `${row.error.code ?? ''}: ${row.error.message ?? ''}` },
  ]))
  lines.push(`Completed turns: ${report.turnEnds.filter(row => row.kind === 'completed').length}\n`)
  lines.push(`## Approvals (${report.counts.approvalsAsked} asked, ${report.counts.approvalsDecided} decided)`, '')
  lines.push(table([...report.approvals.asked.map(row => ({ ...row, kind: 'asked', detail: `${row.tool ?? ''} ${row.reason ?? ''}` })),
    ...report.approvals.decided.map(row => ({ ...row, kind: 'decided', detail: row.outcome ?? '' }))], [
    { label: 'seq', value: row => row.seq },
    { label: 'id', value: row => row.id },
    { label: 'kind', value: row => row.kind },
    { label: 'detail', value: row => truncate(row.detail, 160) },
  ]))
  lines.push(`## Compaction (${report.compactions.length})`, '')
  lines.push(table(report.compactions, [
    { label: 'seq', value: row => row.seq }, { label: 'type', value: row => row.type },
    { label: 'reason', value: row => row.reason }, { label: 'error', value: row => row.error === null ? '' : JSON.stringify(row.error).slice(0, 160) },
  ]))
  lines.push(`## Checkpoints (${report.checkpoints.length})`, '')
  lines.push(table(report.checkpoints, [
    { label: 'seq', value: row => row.seq }, { label: 'reason', value: row => row.reason },
  ]))
  lines.push(`## LLM retries (${report.llmRetries.length})`, '')
  lines.push(table(report.llmRetries, [
    { label: 'seq', value: row => row.seq }, { label: 'turn.step', value: row => `${row.turn}.${row.step}` },
    { label: 'attempt', value: row => `${row.retry}/${row.maxRetries}` },
    { label: 'failure', value: row => `${row.failure?.code ?? ''}: ${truncate(row.failure?.message, 140)}` },
  ]))
  lines.push(`## Other error payloads (${report.genericErrorPayloads.length + report.otherErrorish.length})`, '')
  lines.push(table([...report.genericErrorPayloads, ...report.otherErrorish], [
    { label: 'seq', value: row => row.seq }, { label: 'type', value: row => row.type },
    { label: 'path', value: row => row.path },
    { label: 'value', value: row => truncate(typeof row.value === 'string' ? row.value : JSON.stringify(row.value), 200) },
  ]))
  lines.push(`## Diagnostics incidents (${report.counts.diagnosticsRows})`, '')
  lines.push(table(report.diagnostics.rows, [
    { label: 'id', value: row => row.id }, { label: 'at', value: row => new Date(row.at).toISOString() },
    { label: 'severity', value: row => row.severity }, { label: 'source', value: row => row.source },
    { label: 'kind', value: row => row.kind }, { label: 'code', value: row => row.code },
    { label: 'session', value: row => row.sessionId ?? '' }, { label: 'window', value: row => row.windowMatch ? 'yes' : 'session-match' },
    { label: 'message', value: row => truncate(row.message, 160) },
  ]))
  return `${lines.join('\n')}\n`
}

async function harvestOne(entry, opts, outDir) {
  const { header, events } = decodeSession(entry)
  const extraction = extract(events)
  const window = windowOf(events)
  const pad = opts.windowPadSec * 1000
  const diagnosticsWindow = { start: window.start - pad, end: window.end + pad }
  const sessionId = header?.id ?? entry.sessionId
  let diagnostics = { available: false, driver: null, rows: [], error: 'disabled (--no-diagnostics)' }
  if (opts.diagnostics) {
    diagnostics = await readDiagnostics(opts.diagnosticsDb, { ...diagnosticsWindow, sessionId })
  }
  const report = buildReport(
    { header, events, entry }, extraction, diagnostics, diagnosticsWindow,
    entry.files.length === 1 ? entry.files[0] : entry.files.join(','),
  )
  const jsonPath = join(outDir, `${sessionId}.harvest.json`)
  const mdPath = join(outDir, `${sessionId}.harvest.md`)
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(mdPath, buildMarkdown(report))
  return { sessionId, entry, report, jsonPath, mdPath }
}

async function main(opts) {
  const logs = listLogs(opts.sessionsRoot)
  const results = []
  if (opts.sessions.length > 0) {
    for (const id of opts.sessions) {
      const entry = findLog(logs, id)
      if (entry === undefined) fail(`session ${id} not found under ${opts.sessionsRoot}`)
      results.push(await harvestOne(entry, opts, opts.out))
    }
  }
  if (opts.allSince !== undefined) {
    const since = parseSince(opts.allSince)
    const selected = logs.filter(entry => entry.mtime >= since)
    if (selected.length === 0) fail(`no session logs written at/after ${new Date(since).toISOString()}`)
    for (const entry of selected) results.push(await harvestOne(entry, opts, opts.out))
    const aggregate = {
      since: new Date(since).toISOString(),
      generatedAt: new Date().toISOString(),
      sessions: results.map(result => ({
        sessionId: result.sessionId,
        logPath: result.report.logPath,
        counts: result.report.counts,
      })),
      totals: results.reduce((totals, result) => {
        for (const [key, value] of Object.entries(result.report.counts)) totals[key] = (totals[key] ?? 0) + value
        return totals
      }, {}),
    }
    const stamp = new Date(since).toISOString().replace(/[:.]/g, '-')
    const aggregatePath = join(opts.out, `all-since-${stamp}.harvest.json`)
    writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`)
    const md = [`# Harvest since ${aggregate.since}`, '', '| session | tool errors | nonzero exits | abnormal turns | approvals | diagnostics | log |', '|---|---|---|---|---|---|---|']
    for (const entry of aggregate.sessions) {
      md.push(`| ${entry.sessionId} | ${entry.counts.toolErrors} | ${entry.counts.commandFailures ?? 0} | ${entry.counts.abnormalTurnEnds} | ${entry.counts.approvalsAsked} | ${entry.counts.diagnosticsRows} | \`${entry.logPath}\` |`)
    }
    md.push('', `Totals: ${JSON.stringify(aggregate.totals)}`)
    writeFileSync(join(opts.out, `all-since-${stamp}.harvest.md`), `${md.join('\n')}\n`)
    console.log(JSON.stringify({ aggregate: aggregatePath, sessions: results.map(result => result.sessionId) }, null, 2))
  }
  for (const result of results) {
    console.log(JSON.stringify({
      sessionId: result.sessionId,
      log: result.entry.files.join(','),
      counts: result.report.counts,
      json: result.jsonPath,
      markdown: result.mdPath,
    }, null, 2))
  }
  return 0
}

try {
  const code = await main(parseArgs(process.argv.slice(2)))
  process.exit(code)
} catch (error) {
  if (error instanceof HarvestError) {
    console.error(`dsh-e2e-harvest: ${error.message}`)
    process.exit(1)
  }
  console.error(`dsh-e2e-harvest: unexpected failure\n${error?.stack ?? String(error)}`)
  process.exit(1)
}
