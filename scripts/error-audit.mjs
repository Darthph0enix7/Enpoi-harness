#!/usr/bin/env node
/**
 * error-audit.mjs — the measured error gate (safeguard #18)
 *
 * Extracts every error-class signal from DSH session logs + plugin journals and
 * assigns each a verdict: `expected` (designed deny / deliberate refusal / test
 * fixture / correct tool semantics for a missing path) vs `unexplained` (a defect).
 *
 * Exit contract: exit 1 if ANY unexplained signal exists; 0 otherwise.
 * Exit 2 only for usage/harness failures (no input at all).
 *
 * Default corpora (per playbook safeguard 18):
 *   - eval:    ~/dsh-migration/evidence/tool-eval/raw/sessions*  (every session.v4.jsonl[.zstd] below)
 *   - comms:   ~/dsh-migration/evidence/agent-comms-e2e/{out,witness}/**
 *   - adam:    ~/.dsh/sessions/--home-adam--/*\/session.v4.jsonl.zstd (N most recent)
 *   - journal: ~/.dsh/logs/*.log, lines inside a rolling `--journal-hours` window
 *
 * Cost model (ranking by impact, not count) — documented, deliberately coarse:
 *   tokens(chars) = ceil(chars / 4)
 *   tool-error signal        : tokens = TOK(arguments) + TOK(result text); calls = 1
 *   llm/attempt-failed       : attempts = 1; tokens = clamp(800 + session text tokens, 800, 64000)
 *   non-completed turn/end   : tokens = TOK(all message/tool text inside that turn)
 *   journal degraded fallback: tokens = 6000 per route-failure line (summary payload estimate)
 *   unexplained journal line : tokens = 2000 flat (payload unknown; basis recorded)
 *   impact score = tokens + 400 * wastedCalls
 *
 * Usage:
 *   node scripts/error-audit.mjs [--out DIR] [--adam-limit N] [--journal-hours N]
 *                                [--json-only] [--eval-root DIR] [--comms-root DIR]
 *                                [--sessions-home DIR] [--journals-dir DIR]
 *                                [--include-historical] [--ack FILE]
 *
 * Companion inputs:
 *   --session FILE[:corpus]  add one explicit session log (repeatable)
 *   --no-comms --no-adam --no-journals  disable a default source
 *
 * `--ack FILE` reads a reviewed acknowledgement list
 * (`{ "acknowledged": [{ class, session?, seq?, witnessIncludes, reason }] }`)
 * and reclassifies matching signals as `acknowledged` — the documented
 * historical remainder after a fix. Each entry MUST name the defect and the
 * shipped fix; the gate still fails on any unexplained signal not listed.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

const HOME = process.env.HOME ?? '/home/adam'

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const opt = {
  out: null,
  jsonOnly: false,
  evalRoot: path.join(HOME, 'dsh-migration/evidence/tool-eval/raw'),
  commsRoot: path.join(HOME, 'dsh-migration/evidence/agent-comms-e2e'),
  sessionsHome: path.join(HOME, '.dsh/sessions'),
  journalsDir: path.join(HOME, '.dsh/logs'),
  adamLimit: 30,
  journalHours: 24,
  noComms: false,
  noAdam: false,
  noJournals: false,
  includeHistorical: false,
  ack: null,
  explicit: [],
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const next = () => { i++; if (i >= argv.length) fail(`missing value for ${a}`); return argv[i] }
  if (a === '--out') opt.out = next()
  else if (a === '--json-only') opt.jsonOnly = true
  else if (a === '--eval-root') opt.evalRoot = next()
  else if (a === '--comms-root') opt.commsRoot = next()
  else if (a === '--sessions-home') opt.sessionsHome = next()
  else if (a === '--journals-dir') opt.journalsDir = next()
  else if (a === '--adam-limit') opt.adamLimit = Number(next())
  else if (a === '--journal-hours') opt.journalHours = Number(next())
  else if (a === '--include-historical') opt.includeHistorical = true
  else if (a === '--ack') opt.ack = next()
  else if (a === '--no-comms') opt.noComms = true
  else if (a === '--no-adam') opt.noAdam = true
  else if (a === '--no-journals') opt.noJournals = true
  else if (a === '--session') opt.explicit.push(next())
  else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 40).join('\n')); process.exit(0) }
  else fail(`unknown option: ${a}`)
}
function fail(msg) { console.error(`error-audit: ${msg}`); process.exit(2) }

const TOK = (chars) => Math.ceil(Math.max(0, chars) / 4)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = opt.out ?? path.join(HOME, 'dsh-migration/evidence/error-audit', stamp)

// ── classification rules ────────────────────────────────────────────────────
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const CLASS = {
  // tool-result classes
  'auto-deny': { verdict: 'expected', hyp: 'designed deny: delegated subagent runs with approval prompts disabled (no user was asked by design)' },
  'approval-rejected': { verdict: 'expected', hyp: 'deliberate user refusal at an approval prompt that was shown' },
  'advertised-unconfigured': { verdict: 'unexplained', hyp: 'tool is advertised in the wire catalog but not configured; every call raises a default approval prompt and is then refused (tool-surface defect)' },
  'mislabeled-denial': { verdict: 'unexplained', hyp: 'denial text reports "the user rejected" although no approval/asked exists for this callId (attribution defect)' },
  'silent-auto-deny': { verdict: 'unexplained', hyp: 'top-level call auto-denied without an approval ask or any reason surfaced to the user' },
  'orphan-job': { verdict: 'unexplained', hyp: 'job_output/job_list called against an id that is not a registered job (continuable subagent session id mistaken for a job; tool-jobs advertised while job producers are disabled)' },
  'validation': { verdict: 'unexplained', hyp: 'bad-argument rejection: the model emitted an argument shape the tool schema rejects before execution' },
  'shape-variance': { verdict: 'unexplained', hyp: 'same tool called with two different argument-key shapes in one session, one of them failing validation' },
  'unavailable-tool': { verdict: 'unexplained', hyp: 'a call to a tool name the host did not resolve (advertised/session catalog drift)' },
  'not-found': { verdict: 'expected', hyp: 'tool correctly reported a path that does not exist (model picked a wrong path; tool semantics healthy)' },
  'resource-error': { verdict: 'unexplained', hyp: 'environment/resource failure surfaced from a tool (EAGAIN/EMFILE/exit!=0 under contention)' },
  'provider-capacity': { verdict: 'unexplained', hyp: 'provider identity without capacity stayed in routing and its 402/429 surfaced as a tool error the model had to handle' },
  'tool-aborted': { verdict: 'expected', hyp: 'call cancelled by a user/parent stop-intent while in flight' },
  'tool-aborted-unexplained': { verdict: 'unexplained', hyp: 'call aborted with no aborted turn/stop-intent recorded (spontaneous cancellation/timeout)' },
  'tool-error-other': { verdict: 'unexplained', hyp: 'unclassified tool error (see witness)' },
  // turn classes
  'turn-aborted-user': { verdict: 'expected', hyp: 'deliberate user stop (stop intent recorded on turn/end)' },
  'turn-aborted-parent': { verdict: 'expected', hyp: 'parent-scoped abort (subagent teardown / council or test cancellation)' },
  'turn-aborted-other': { verdict: 'unexplained', hyp: 'turn ended aborted for an unrecorded reason' },
  'turn-failed': { verdict: 'unexplained', hyp: 'turn ended in a non-completed, non-aborted terminal state' },
  // llm classes
  'llm-quota': { verdict: 'expected', hyp: 'designed pool failover: identity hit its usage limit, next identity advanced' },
  'llm-auth': { verdict: 'expected', hyp: 'designed pool failover: identity lacks entitlement for the route, next identity advanced' },
  'llm-timeout': { verdict: 'expected', hyp: 'designed pool failover: provider timeout, next identity advanced' },
  'llm-attempt-failed': { verdict: 'expected', hyp: 'designed multi-route failover (attempt recorded, turn continued)' },
  // journal classes
  'degraded-fallback': { verdict: 'expected', hyp: 'designed degraded path engaged after a route failed (template/mechanical fallback)' },
  'keeper-route-failed': { verdict: 'unexplained', hyp: 'keeper summary/brief chain exhausted every route and landed nothing (stale Living Brief; route chain or output cap too small)' },
  'fixture-fallback': { verdict: 'expected', hyp: 'keeper e2e fixture exercised its negative path (mock provider / named fixture session)' },
  'journal-aborted': { verdict: 'expected', hyp: 'in-flight journal work cancelled at session teardown (AbortError)' },
  'settings-import': { verdict: 'unexplained', hyp: 'settings/profile entry was rejected silently at import ("not imported"/"not volatile"/"needs an api")' },
  'journal-write-failed': { verdict: 'unexplained', hyp: 'session/journal write failed (plugin append wedged or handle closed)' },
  'journal-error': { verdict: 'unexplained', hyp: 'plugin journal reported a failure that was not a designed fallback' },
  // comms classes
  'peer-protocol-error': { verdict: 'unexplained', hyp: 'peer/protocol call failed outside the known negative-probe fixture set' },
  'peer-protocol-fixture': { verdict: 'expected', hyp: 'peer error from a deliberate negative probe / teardown (empty body, unpaired, forbidden exposure, abort)' },
  'comms-terminal': { verdict: 'expected', hyp: 'comms case subagent terminal was aborted/cancelled by the case script' },
  'verify-unmet': { verdict: 'expected', hyp: 'internal verify gate recorded an unmet expectation (ignorable bookkeeping; the underlying tool error is counted separately)' },
}

// peer-protocol error codes/names that are produced by deliberate negative probes
const FIXTURE_ERROR_CODES = new Set([
  'ABORTED', 'ASK_ABORTED', 'AbortError', 'UserQuestionError', 'peer/forbidden',
  'peer/not-paired', 'peer/conflict', 'peer/unknown-session', 'peer/exposure',
  'peer/unauthorized', 'peer/disabled', 'peer/unavailable',
])
const FIXTURE_FILE = /(empty|unpaired|skew|late|nobody|no-such|orphan|watchdog|detach-cancel|stopall-cancel|cancel-empty|handshake-empty|answer-localid)/i

// known journaling fallbacks that are *designed* behaviour (verdict expected)
const FALLBACK_LINE = /(using template|advancing to |mechanical fallback|retrying once|referee unavailable|chair unavailable|provider exploded)/i
// journal patterns that are hard defects
const IMPORT_LINE = /(not imported|is not volatile|needs an api)/i
const WRITE_FAIL_LINE = /(background write failed|write failed|flush on a closed handle)/i

// ── helpers ─────────────────────────────────────────────────────────────────
function readLines(file) {
  let buf
  try { buf = fs.readFileSync(file) } catch (e) { return { error: `read failed: ${e.message}` } }
  let text
  if (file.endsWith('.zstd')) {
    // DSH persists one zstd FRAME per event; zlib.zstdDecompressSync decodes only the
    // first frame, so the CLI (which concatenates all frames) is the reliable decoder.
    try {
      text = execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8')
    } catch (e1) {
      try { text = zlib.zstdDecompressSync(buf).toString('utf8') }
      catch (e2) { return { error: `zstd decode failed (${e2.message.split('\n')[0]})` } }
    }
  } else text = buf.toString('utf8')
  const lines = text.split('\n')
  const out = []
  let bad = 0
  for (const line of lines) {
    const t = line.trim()
    if (t === '') continue
    try { out.push(JSON.parse(t)) } catch { bad++ }
  }
  return { events: out, badLines: bad, bytes: buf.length }
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
}
const trunc = (s, n = 420) => (s.length > n ? `${s.slice(0, n)}…` : s)
const norm = (s) => s.replace(UUID, '<uuid>').replace(/\b\d{4,}\b/g, '<n>')

function lastAtOrBefore(list, seq) {
  let found = null
  for (const h of list) { if (h.seq <= seq) found = h; else break }
  return found
}

// ── session-log parser ──────────────────────────────────────────────────────
function auditSessionFile(file, corpus) {
  const res = readLines(file)
  const sessionId = path.basename(path.dirname(file)) || path.basename(file)
  const base = { file, corpus, session: sessionId, signals: [], skipped: null, badLines: 0, events: 0, calls: 0 }
  if (res.error) { base.skipped = res.error; return base }
  const ev = res.events
  base.badLines = res.badLines
  if (ev.length === 0 || ev[0].type !== 'session') {
    base.skipped = 'not a v4 session log (no session header)'
    return base
  }
  base.session = ev[0].id ?? sessionId
  base.agentPreset = ev[0].agentPreset ?? null
  base.delegationDepth = ev[0].delegationDepth ?? 0
  base.events = ev.length

  const callById = new Map()
  const askedByCall = new Map()
  const askedIds = new Set()
  const decidedList = []
  const headers = [] // {seq, tools:Set}
  const turnText = new Map()
  // pre-pass: turns that end aborted (turn/end follows its tool results in the log,
  // so classification of an in-flight tool error must know the future outcome)
  const abortedTurns = new Set()
  for (const e of ev) {
    if (e.type === 'turn/end' && e.data?.reason?.kind === 'aborted') abortedTurns.add(e.data.turn)
  }
  const turnCalls = new Map()
  const shapesByTool = new Map()
  const validationCalls = new Set()
  let sessionTextChars = 0
  const sig = (s) => { base.signals.push(s) }

  for (const e of ev) {
    const t = e.type
    const d = e.data ?? {}
    const seq = e.seq ?? null
    const at = e.time ?? null
    if (t === 'request/header') {
      const tools = d?.header?.tools
      if (Array.isArray(tools)) headers.push({ seq: seq ?? Number.MAX_SAFE_INTEGER, tools: new Set(tools.map((x) => x.name)) })
    } else if (t === 'tool/call') {
      base.calls++
      const info = { name: d.name, args: typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? {}), turn: d.turn, seq, callId: d.callId }
      callById.set(d.callId, info)
      turnCalls.set(d.turn, (turnCalls.get(d.turn) ?? 0) + 1)
      let sigSet
      try { sigSet = Object.keys(JSON.parse(info.args)).sort().join(',') } catch { sigSet = '<unparseable>' }
      if (!shapesByTool.has(d.name)) shapesByTool.set(d.name, new Set())
      shapesByTool.get(d.name).add(sigSet)
    } else if (t === 'approval/asked') {
      askedIds.add(d.id)
      if (!askedByCall.has(d.callId)) askedByCall.set(d.callId, [])
      askedByCall.get(d.callId).push({ id: d.id, reason: d.reason ?? '', toolName: d.toolName ?? null, seq })
    } else if (t === 'approval/decided') {
      decidedList.push({ id: d.id, outcome: d.outcome, seq, at })
    } else if (t === 'turn/end') {
      const r = d.reason ?? {}
      if (r.kind !== 'completed') {
        const turn = d.turn
        const chars = turnText.get(turn) ?? 0
        if (r.kind === 'aborted') {
          abortedTurns.add(turn)
          const rk = r.reason?.kind
          if (rk === 'user') {
            sig({ class: 'turn-aborted-user', verdict: 'expected', seq, time: at, tool: null, witness: trunc(JSON.stringify(e)), detail: `intent=${r.reason?.intent ?? 'n/a'}`, tokens: TOK(chars), calls: 0, basis: 'turn text tokens' })
          } else if (rk === 'parent') {
            sig({ class: 'turn-aborted-parent', verdict: 'expected', seq, time: at, tool: null, witness: trunc(JSON.stringify(e)), detail: 'parent-scoped abort', tokens: TOK(chars), calls: 0, basis: 'turn text tokens' })
          } else {
            sig({ class: 'turn-aborted-other', verdict: 'unexplained', seq, time: at, tool: null, witness: trunc(JSON.stringify(e)), detail: `aborted reason=${rk ?? 'none'}`, tokens: TOK(chars), calls: 0, basis: 'turn text tokens' })
          }
        } else {
          const err = r.error?.message ?? r.message ?? ''
          // a failed turn is user-visible and forces a re-ask: turn text + one full retry round-trip
          const turnTokens = Math.max(TOK(chars), TOK(sessionTextChars)) + 8000
          sig({ class: 'turn-failed', verdict: 'unexplained', seq, time: at, tool: null, witness: trunc(JSON.stringify(e)), detail: `kind=${r.kind}${err ? `: ${trunc(err, 160)}` : ''}`, tokens: turnTokens, calls: 0, basis: 'turn text + 8k retry round-trip' })
        }
      }
    } else if (t === 'llm/attempt-failed') {
      const code = String(d.code ?? 'UNKNOWN').toUpperCase()
      const cls = code === 'QUOTA' ? 'llm-quota' : code === 'AUTH' ? 'llm-auth' : /TIMEOUT|STREAM/.test(code) ? 'llm-timeout' : 'llm-attempt-failed'
      const tokens = Math.min(64000, 800 + TOK(sessionTextChars))
      // group identical codes per session into one signal with a count
      const prev = base.signals.find((s) => s.class === cls && s.groupedAttempts)
      if (prev) { prev.groupedAttempts++; prev.tokens += tokens; prev.witness = trunc(JSON.stringify(e)) }
      else sig({ class: cls, verdict: 'expected', seq, time: at, tool: null, witness: trunc(JSON.stringify(e)), detail: `${d.provider ?? '?'}/${d.model ?? '?'} code=${code}`, tokens, calls: 0, basis: 'attempts × clamp(800+session tokens,800,64k)', groupedAttempts: 1 })
    } else if (t === 'tool/result') {
      const m = d.message ?? {}
      const call = callById.get(m.toolCallId)
      const txt = textOfContent(m.content)
      const chars = txt.length + (call?.args?.length ?? 0)
      if (m.isError === true) {
        const callId = m.toolCallId
        const asks = askedByCall.get(callId) ?? []
        const askShown = asks.length > 0
        const seenUnconfigured = asks.some((a) => /unconfigured tool|requires approval \(default\)/i.test(a.reason))
        const inAbortedTurn = call && abortedTurns.has(call.turn)
        let cls, verdict, detail
        if (/denied automatically|approval policy denied/i.test(txt)) {
          if (/delegated subagent/i.test(txt)) { cls = 'auto-deny'; verdict = 'expected'; detail = 'prompts disabled for delegated subagent' }
          else { cls = 'silent-auto-deny'; verdict = 'unexplained'; detail = 'auto-denied at top level with no ask' }
        } else if (askShown && /user rejected|the user rejected|user denied/i.test(txt)) {
          if (seenUnconfigured) { cls = 'advertised-unconfigured'; verdict = 'unexplained'; detail = `ask reason: ${asks[0].reason}` }
          else { cls = 'approval-rejected'; verdict = 'expected'; detail = `ask shown seq=${asks[0].seq}` }
        } else if (/user rejected|the user rejected|user denied/i.test(txt)) {
          cls = 'mislabeled-denial'; verdict = 'unexplained'; detail = 'result says user rejected but no approval/asked for callId'
        } else if (/unknown job/i.test(txt)) {
          cls = 'orphan-job'; verdict = 'unexplained'; detail = 'job id not registered'
        } else if (/invalid arguments|must be an object|must be of type|schema|expected .* received|unknown (property|key)/i.test(txt)) {
          cls = 'validation'; verdict = 'unexplained'; detail = 'schema rejected before execution'
          if (call) validationCalls.add(callId)
        } else if (/aborted|cancelled|canceled|interrupted/i.test(txt)) {
          cls = inAbortedTurn ? 'tool-aborted' : 'tool-aborted-unexplained'
          verdict = inAbortedTurn ? 'expected' : 'unexplained'
          detail = inAbortedTurn ? `turn ${call?.turn} ended aborted` : 'no aborted turn for this call'
        } else if (/not found|ENOENT|no such file|does not exist/i.test(txt)) {
          cls = 'not-found'; verdict = 'expected'; detail = 'path missing; tool semantics correct'
        } else if (/resource temporarily unavailable|EAGAIN|EMFILE|ENOMEM|exit code [1-9]|exit [1-9]|ENOSPC/i.test(txt)) {
          cls = 'resource-error'; verdict = 'unexplained'; detail = 'environment resource/exit failure'
        } else if (/insufficient balance|http 402|429|quota|rate limit|overloaded/i.test(txt)) {
          cls = 'provider-capacity'; verdict = 'unexplained'; detail = 'external capacity surfaced as tool error'
        } else if (/unknown tool|tool .*not (found|available)|no such tool/i.test(txt)) {
          cls = 'unavailable-tool'; verdict = 'unexplained'; detail = 'tool name unresolved'
        } else {
          cls = 'tool-error-other'; verdict = 'unexplained'; detail = 'unclassified'
        }
        // availability: advertised but absent from the latest catalog snapshot
        const hdr = call ? lastAtOrBefore(headers, call.seq) : null
        const notAdvertised = call && hdr && !hdr.tools.has(call.name) ? `not in catalog@${hdr.seq}` : null
        sig({
          class: cls, verdict, seq, time: at, tool: call?.name ?? null, callId,
          witness: trunc(JSON.stringify(e)),
          detail: [detail, notAdvertised].filter(Boolean).join('; '),
          args: trunc(call?.args ?? '', 200),
          tokens: TOK(chars), calls: 1, basis: 'args+result chars',
        })
      }
      sessionTextChars += txt.length
      const turn = call?.turn
      if (turn !== undefined) turnText.set(turn, (turnText.get(turn) ?? 0) + txt.length)
    } else if (t === 'assistant/message') {
      const txt = textOfContent(d.content)
      sessionTextChars += txt.length
      const turn = d.turn ?? e.turn
      if (turn !== undefined) turnText.set(turn, (turnText.get(turn) ?? 0) + txt.length)
    } else if (t === 'user/message') {
      const txt = textOfContent(d.content)
      sessionTextChars += txt.length
      const turn = d.turn ?? e.turn
      if (turn !== undefined) turnText.set(turn, (turnText.get(turn) ?? 0) + txt.length)
    } else if (t === 'verify/unmet') {
      sig({ class: 'verify-unmet', verdict: 'expected', seq, time: at, tool: d.tool ?? null, witness: trunc(JSON.stringify(e)), detail: `reason=${d.reason ?? '?'} tool=${d.tool ?? '?'}`, tokens: 0, calls: 0, basis: 'bookkeeping; underlying error counted separately' })
    }
  }

  // shape variance: a tool with multiple arg-key signatures where at least one call failed validation
  for (const [name, sigs] of shapesByTool) {
    if (sigs.size < 2) continue
    const failed = [...validationCalls].some((cid) => callById.get(cid)?.name === name)
    if (failed) {
      sig({ class: 'shape-variance', verdict: 'unexplained', seq: null, time: null, tool: name, witness: `shapes in ${base.session}: ${[...sigs].join(' | ')}`, detail: `${sigs.size} argument shapes`, tokens: 0, calls: 0, basis: 'attribute of the validation failure' })
    }
  }

  // approval orphans & stale asks
  for (const d of decidedList) {
    if (!askedIds.has(d.id)) {
      sig({ class: 'approval-orphan', verdict: 'unexplained', seq: d.seq, time: d.at, tool: null, witness: `approval/decided id=${d.id} outcome=${d.outcome}`, detail: 'decided without a matching approval/asked', tokens: 0, calls: 0, basis: 'n/a' })
    }
  }
  const resultCallIds = new Set(ev.filter((e) => e.type === 'tool/result').map((e) => e.data?.message?.toolCallId))
  for (const [callId, asks] of askedByCall) {
    for (const a of asks) {
      if (!resultCallIds.has(callId)) {
        sig({ class: 'approval-orphan', verdict: 'unexplained', seq: a.seq, time: null, tool: a.toolName, witness: `approval/asked callId=${callId} reason=${a.reason}`, detail: 'ask with no tool result (dropped/interrupted ask)', tokens: 0, calls: 0, basis: 'n/a' })
      }
    }
  }
  base.askIds = [...askedIds]
  return base
}

// ── generic JSON/JSONL structured scan (comms corpora) ──────────────────────
function scanCommsJson(file, corpus, signalsOut) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { signalsOut({ file, corpus, skipped: `read failed: ${e.message}` }); return }
  const isSessionLog = raw.startsWith('{"type":"session"')
  if (isSessionLog) return // handled by session parser
  const lines = file.endsWith('.jsonl') ? raw.split('\n').filter(Boolean) : [raw]
  const fixture = FIXTURE_FILE.test(path.basename(file))
  let count = 0
  const visit = (obj, ctx) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { for (const v of obj) visit(v, ctx); return }
    if (obj.terminal && typeof obj.terminal === 'object' && typeof obj.terminal.kind === 'string' && obj.terminal.kind !== 'completed') {
      const expected = obj.terminal.kind === 'aborted' || obj.terminal.kind === 'cancelled'
      signalsOut({ file, corpus, session: null, seq: null, time: null, tool: null, class: 'comms-terminal', verdict: expected ? 'expected' : 'unexplained', witness: trunc(JSON.stringify({ step: ctx, terminal: obj.terminal })), detail: `terminal=${obj.terminal.kind}`, tokens: 0, calls: 0, basis: 'n/a' })
    }
    if (obj.error && typeof obj.error === 'object' && (obj.error.code || obj.error.name || obj.error.message)) {
      const code = String(obj.error.code ?? obj.error.name ?? '')
      const expected = fixture || FIXTURE_ERROR_CODES.has(code)
      signalsOut({ file, corpus, session: null, seq: null, time: null, tool: null, class: expected ? 'peer-protocol-fixture' : 'peer-protocol-error', verdict: expected ? 'expected' : 'unexplained', witness: trunc(JSON.stringify(obj.error)), detail: `code=${code}`, tokens: 0, calls: 0, basis: 'n/a' })
    } else if (obj.ok === false) {
      signalsOut({ file, corpus, session: null, seq: null, time: null, tool: null, class: fixture ? 'peer-protocol-fixture' : 'peer-protocol-error', verdict: fixture ? 'expected' : 'unexplained', witness: trunc(JSON.stringify(obj)), detail: 'ok:false', tokens: 0, calls: 0, basis: 'n/a' })
    }
    for (const [k, v] of Object.entries(obj)) { if (k === 'error' || k === 'terminal') continue; visit(v, k) }
  }
  for (const line of lines) {
    if (line.trim() === '') continue
    count++
    try { visit(JSON.parse(line), path.basename(file)) } catch { /* meta files etc. */ }
    if (count > 5000) break
  }
}

// ── journal scan ────────────────────────────────────────────────────────────
function scanJournals(dir, hours, outSignals) {
  let files = []
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')) } catch (e) { return { dir, error: e.message } }
  const since = hours === 0 && opt.includeHistorical ? 0 : Date.now() - hours * 3600e3
  const windowApplied = !(hours === 0 && opt.includeHistorical)
  const groups = new Map()
  for (const f of files) {
    const p = path.join(dir, f)
    let text
    try { text = fs.readFileSync(p, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const tsMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/)
      const ts = tsMatch ? Date.parse(tsMatch[1]) : null
      if (windowApplied && ts !== null && ts < since) continue
      if (windowApplied && ts === null) continue // undated lines outside a rolling window are historical
      let cls = null, verdict = null
      if (IMPORT_LINE.test(line)) { cls = 'settings-import'; verdict = 'unexplained' }
      else if (WRITE_FAIL_LINE.test(line)) { cls = 'journal-write-failed'; verdict = 'unexplained' }
      else if (/AbortError|This operation was aborted/i.test(line)) { cls = 'journal-aborted'; verdict = 'expected' }
      else if (/all summary routes failed|landed \(failed/i.test(line)) {
        const fixture = /test-session|prefetch-negative|prose-session|upstream down|provider exploded/i.test(line)
        cls = fixture ? 'fixture-fallback' : 'keeper-route-failed'
        verdict = fixture ? 'expected' : 'unexplained'
      }
      else if (FALLBACK_LINE.test(line)) { cls = 'degraded-fallback'; verdict = 'expected' }
      else if (/quarantined until/i.test(line)) { cls = 'route-quarantined'; verdict = 'expected' }
      else if (/(error|fail)/i.test(line)) { cls = 'journal-error'; verdict = 'unexplained' }
      if (!cls) continue
      const sess = line.match(UUID)?.[0] ?? line.match(/session[= ]([\w-]{3,64})/)?.[1] ?? null
      const key = `${f}|${cls}|${norm(line).slice(0, 160)}`
      const g = groups.get(key) ?? { file: f, cls, verdict, session: sess, count: 0, first: ts, last: ts, sample: line.trim() }
      g.count++
      if (ts !== null) { g.first = g.first === null ? ts : Math.min(g.first, ts); g.last = g.last === null ? ts : Math.max(g.last, ts) }
      groups.set(key, g)
    }
  }
  for (const g of groups.values()) {
    let tokens = 0
    let basis = 'n/a'
    if (g.cls === 'degraded-fallback' || g.cls === 'keeper-route-failed') { tokens = 6000 * g.count; basis = 'route payload estimate ×count' }
    else if (g.cls === 'journal-aborted' || g.cls === 'fixture-fallback') { tokens = 0; basis = 'teardown/fixture' }
    else { tokens = 2000 * g.count; basis = 'flat estimate ×count' }
    outSignals({
      file: path.join(dir, g.file), corpus: 'journal', session: g.session, seq: null, time: g.last, tool: null,
      class: g.cls, verdict: g.verdict, witness: trunc(g.sample), detail: `×${g.count}${windowApplied ? ` in last ${hours}h` : ''}`,
      tokens, calls: 0, basis, groupedCount: g.count,
    })
  }
  return { dir, files: files.length, windowHours: windowApplied ? hours : 'all', groups: groups.size }
}

// ── main ────────────────────────────────────────────────────────────────────
const inputs = { files: [], skipped: [], corpora: {} }
const sessions = []

// eval corpora
if (opt.evalRoot && fs.existsSync(opt.evalRoot)) {
  let n = 0
  try {
    const entries = fs.readdirSync(opt.evalRoot, { recursive: true, withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isFile()) continue
      if (!/session\.v4\.jsonl(\.zstd)?$/.test(ent.name)) continue
      const full = path.join(ent.parentPath ?? ent.path, ent.name)
      if (full.includes('/node_modules/')) continue
      n++
      inputs.files.push({ file: full, corpus: 'eval' })
    }
  } catch (e) { inputs.skipped.push({ file: opt.evalRoot, reason: `eval root scan failed: ${e.message}` }) }
  inputs.corpora.eval = n
}

// agent-comms corpora
if (!opt.noComms && fs.existsSync(opt.commsRoot)) {
  let n = 0
  const walk = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) { walk(full); continue }
      if (/\.(json|jsonl)$/.test(ent.name) && !ent.name.endsWith('.meta')) {
        n++
        inputs.files.push({ file: full, corpus: 'comms' })
      }
    }
  }
  walk(opt.commsRoot)
  inputs.corpora.comms = n
}

// Adam's recent sessions
if (!opt.noAdam && opt.adamLimit > 0) {
  const root = path.join(opt.sessionsHome, '--home-adam--')
  let candidates = []
  // v3 logs sit beside v4 in the same session dirs. They are a frozen
  // predecessor generation: the v4 log is the authoritative record for the
  // session, so scanning both would double-count every event. Counted here so
  // the scope decision is visible in the report instead of silent.
  let v3OutOfScope = 0
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const p = path.join(root, ent.name, 'session.v4.jsonl.zstd')
      if (fs.existsSync(p)) candidates.push({ p, mtime: fs.statSync(p).mtimeMs })
      if (fs.existsSync(path.join(root, ent.name, 'session.v3.jsonl.zstd'))) v3OutOfScope++
    }
  } catch (e) { inputs.skipped.push({ file: root, reason: `adam sessions scan failed: ${e.message}` }) }
  candidates.sort((a, b) => b.mtime - a.mtime)
  const chosen = candidates.slice(0, opt.adamLimit)
  inputs.corpora.adam = chosen.length
  inputs.corpora.v3OutOfScope = v3OutOfScope
  for (const c of chosen) inputs.files.push({ file: c.p, corpus: 'adam' })
}

for (const spec of opt.explicit) {
  const [file, corpus = 'explicit'] = spec.split(':')
  inputs.files.push({ file, corpus })
}

if (inputs.files.length === 0) fail('no input files found; refusing to emit a vacuous green gate')

for (const { file, corpus } of inputs.files) {
  if (corpus === 'comms' && !/session\.v4/.test(file) && !file.endsWith('.jsonl')) {
    // structured JSON: scan directly
    scanCommsJson(file, corpus, (s) => sessions.push({ file, corpus, signals: [s], skipped: s.skipped }))
    continue
  }
  if (corpus === 'comms' && file.endsWith('.jsonl')) {
    const head = (() => { try { return fs.readFileSync(file, 'utf8').slice(0, 40) } catch { return '' } })()
    if (!head.startsWith('{"type":"session"')) {
      scanCommsJson(file, corpus, (s) => sessions.push({ file, corpus, signals: [s], skipped: s.skipped }))
      continue
    }
  }
  sessions.push(auditSessionFile(file, corpus))
}

if (!opt.noJournals && opt.journalHours >= 0) {
  const jr = scanJournals(opt.journalsDir, opt.journalHours, (s) => sessions.push({ file: s.file, corpus: 'journal', signals: [s], skipped: s.skipped }))
  inputs.corpora.journal = jr
}

// ── aggregate ───────────────────────────────────────────────────────────────
const allSignals = []
for (const s of sessions) {
  if (s.skipped) { inputs.skipped.push({ file: s.file, reason: s.skipped }); continue }
  for (const sig of s.signals ?? []) allSignals.push({ ...sig, corpus: s.corpus })
}

// foreign-approval post-pass: a decided id whose ask lives in another session
const askOwner = new Map()
for (const s of sessions) for (const id of s.askIds ?? []) askOwner.set(id, s.session)
for (const s of sessions) {
  if (s.skipped) continue
  for (const sig of s.signals ?? []) {
    if (sig.class === 'approval-orphan') {
      const id = sig.witness.match(/id=([0-9a-f-]{36})/)?.[1]
      if (id && askOwner.has(id) && askOwner.get(id) !== s.session) {
        sig.class = 'foreign-approval'
        sig.verdict = 'unexplained'
        sig.detail = `ask id belongs to session ${askOwner.get(id)} (replayed foreign approval)`
      }
    }
  }
}
// refresh aggregated verdicts after post-pass
allSignals.length = 0
for (const s of sessions) { if (s.skipped) continue; for (const sig of s.signals ?? []) allSignals.push({ ...sig, corpus: s.corpus, session: s.session }) }

// Reviewed acknowledgements: reclassify exact historical signals already fixed
// in code, so the gate measures NEW defects instead of permanently failing on
// a frozen baseline. The acknowledgement names the defect and the fix; it is
// never a blanket class waiver (class + optional session/seq + witness text).
const acknowledged = []
if (opt.ack) {
  let doc
  try { doc = JSON.parse(fs.readFileSync(opt.ack, 'utf8')) } catch (e) { fail(`--ack ${opt.ack} is unreadable: ${e.message}`) }
  const entries = Array.isArray(doc?.acknowledged) ? doc.acknowledged : []
  if (entries.length === 0) fail(`--ack ${opt.ack} lists no acknowledged signals`)
  for (const s of allSignals) {
    if (s.verdict !== 'unexplained') continue
    const hit = entries.find(entry => entry.class === s.class
      && (entry.session === undefined || entry.session === s.session)
      && (entry.seq === undefined || entry.seq === s.seq)
      && (entry.witnessIncludes === undefined || String(s.witness ?? '').includes(entry.witnessIncludes)))
    if (hit === undefined) continue
    s.verdict = 'acknowledged'
    s.ackReason = hit.reason ?? 'acknowledged'
    acknowledged.push(s)
  }
}

const byClass = new Map()
for (const s of allSignals) {
  const c = byClass.get(s.class) ?? { class: s.class, verdict: s.verdict, count: 0, calls: 0, tokens: 0, attempts: 0, sessions: new Set(), signals: [] }
  c.count++
  c.calls += s.calls ?? 0
  c.tokens += s.tokens ?? 0
  if (s.groupedAttempts) c.attempts += s.groupedAttempts
  if (s.groupedCount) c.attempts += s.groupedCount
  if (s.session) c.sessions.add(s.session)
  c.signals.push(s)
  byClass.set(s.class, c)
}
for (const c of byClass.values()) {
  const verdicts = new Set(c.signals.map(s => s.verdict))
  c.verdict = verdicts.has('unexplained') ? 'unexplained' : verdicts.has('acknowledged') ? 'acknowledged' : 'expected'
  c.impact = c.tokens + 400 * c.calls
  c.sessionCount = c.sessions.size
  delete c.sessions
}

// sanity: CLASS map must cover every produced class
for (const c of byClass.keys()) if (!CLASS[c]) { CLASS[c] = { verdict: 'unexplained', hyp: 'unregistered class (script bug)' } }

const unexplained = allSignals.filter((s) => s.verdict === 'unexplained')
const expected = allSignals.filter((s) => s.verdict === 'expected')
const totalCalls = sessions.reduce((n, s) => n + (s.calls ?? 0), 0)
const totalSessions = sessions.filter((s) => !s.skipped && (s.events ?? 0) > 0).length
const totalEvents = sessions.reduce((n, s) => n + (s.events ?? 0), 0)

const ranked = [...byClass.values()].sort((a, b) => b.impact - a.impact)
const report = {
  generatedAt: new Date().toISOString(),
  script: 'F/scripts/error-audit.mjs',
  contract: 'exit 0 = zero unexplained error-class signals; exit 1 = at least one unexplained (defect)',
  exitCode: unexplained.length > 0 ? 1 : 0,
  inputs: {
    corpora: inputs.corpora,
    adamLimit: opt.adamLimit,
    journalHours: opt.journalHours,
    filesScanned: inputs.files.length,
    sessionsParsed: totalSessions,
    eventsParsed: totalEvents,
    toolCalls: totalCalls,
    parseWarningLines: sessions.reduce((n, s) => n + (s.badLines ?? 0), 0),
    skipped: inputs.skipped,
  },
  totals: { signals: allSignals.length, expected: expected.length, acknowledged: acknowledged.length, unexplained: unexplained.length, classes: byClass.size },
  acknowledged: acknowledged.map((s) => ({ class: s.class, session: s.session, seq: s.seq, corpus: s.corpus, witness: s.witness, reason: s.ackReason })),
  classes: ranked.map((c) => ({
    class: c.class, verdict: c.verdict, count: c.count, sessionCount: c.sessionCount,
    wastedCalls: c.calls, wastedAttempts: c.attempts, estimatedTokens: c.tokens, impact: c.impact,
    hypothesis: CLASS[c.class].hyp,
  })),
  unexplained: unexplained.map((s) => ({ class: s.class, session: s.session, seq: s.seq, time: s.time, tool: s.tool, corpus: s.corpus, witness: s.witness, detail: s.detail, estimatedTokens: s.tokens ?? 0, impact: (s.tokens ?? 0) + 400 * (s.calls ?? 0) })),
  byClass: Object.fromEntries([...byClass.entries()].map(([k, c]) => [k, c.signals])),
}

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))

// human table
const pad = (s, n) => String(s).padEnd(n)
const lines = []
lines.push(`# Error audit — ${report.generatedAt}`)
lines.push('')
lines.push(`Contract: **exit ${report.exitCode}** — ${unexplained.length} unexplained / ${acknowledged.length} acknowledged / ${expected.length} expected signals across ${totalSessions} sessions, ${totalCalls} tool calls, ${totalEvents} events.`)
lines.push('')
lines.push('## Per-class baseline')
lines.push('')
lines.push(`| class | verdict | count | sessions | wasted calls | wasted attempts/events | est. tokens | impact |`)
lines.push(`|---|---|---:|---:|---:|---:|---:|---:|`)
for (const c of ranked) lines.push(`| ${c.class} | ${c.verdict} | ${c.count} | ${c.sessionCount} | ${c.calls} | ${c.attempts} | ${c.tokens} | ${c.impact} |`)
lines.push('')
lines.push('## Ranked unexplained offenders')
lines.push('')
if (unexplained.length === 0) lines.push('_none_')
else {
  const sigRanked = [...unexplained].sort((a, b) => ((b.tokens ?? 0) + 400 * (b.calls ?? 0)) - ((a.tokens ?? 0) + 400 * (a.calls ?? 0)))
  for (const s of sigRanked.slice(0, 25)) {
    const imp = (s.tokens ?? 0) + 400 * (s.calls ?? 0)
    lines.push(`- **[${s.class}] impact≈${imp} tok** · session \`${s.session ?? 'journal'}\`${s.seq != null ? ` seq ${s.seq}` : ''}${s.tool ? ` · tool \`${s.tool}\`` : ''}`)
    lines.push(`  - witness: \`${String(s.witness).replace(/`/g, '\\`')}\``)
    lines.push(`  - hypothesis: ${s.detail ? s.detail + ' — ' : ''}${CLASS[s.class].hyp}`)
  }
}
lines.push('')
if (acknowledged.length > 0) {
  lines.push('## Acknowledged (fixed historical remainder)')
  lines.push('')
  for (const s of acknowledged) {
    lines.push(`- [${s.class}] session \`${s.session ?? 'journal'}\`${s.seq != null ? ` seq ${s.seq}` : ''} — ${s.ackReason ?? 'acknowledged'}`)
  }
  lines.push('')
}
lines.push('## Expected (designed denials, deliberate refusals, fixtures, failovers)')
lines.push('')
for (const c of ranked.filter((c) => c.verdict === 'expected')) lines.push(`- ${c.class}: ${c.count} (${c.calls} calls, ${c.attempts} attempts, ~${c.tokens} tok) — ${CLASS[c.class].hyp}`)
lines.push('')
lines.push('## Inputs & unclassifiable')
lines.push('')
lines.push(`- corpora: ${JSON.stringify(inputs.corpora)}`)
if (inputs.corpora.v3OutOfScope !== undefined) lines.push(`- v3 out of scope: ${inputs.corpora.v3OutOfScope} session.v3.jsonl.zstd logs (frozen predecessor generation; the v4 log in the same dir is authoritative, so scanning both would double-count. Any future v3 read must decode with \`zstd -dc\` frame loops — one zstd frame per event — never \`zlib.zstdDecompressSync\`.)`)
lines.push(`- skipped/unreadable: ${inputs.skipped.length}`)
for (const s of inputs.skipped.slice(0, 20)) lines.push(`  - ${path.basename(String(s.file))}: ${s.reason}`)
if (inputs.skipped.length > 20) lines.push(`  - … ${inputs.skipped.length - 20} more (see report.json)`)
lines.push('')
fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'))

if (!opt.jsonOnly) console.log(lines.join('\n'))
console.log(`\nerror-audit: ${outDir}/report.{json,md} — exit ${report.exitCode} (${unexplained.length} unexplained)`)
process.exit(report.exitCode)
