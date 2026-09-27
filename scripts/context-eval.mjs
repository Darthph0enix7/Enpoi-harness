#!/usr/bin/env node
/**
 * context-eval.mjs — measured context-compaction & recall evaluation (doc 66 §5).
 *
 * One honest long-horizon session is driven through real work until the
 * compaction engine cuts segments repeatedly; after every cycle the planted
 * facts are probed in fresh turns and scored (recalled / omitted / contradicted
 * / fabricated). Living Briefs and compaction summaries are anchor-checked
 * against the transcript span they summarise. Mechanical invariants (ghost
 * revert, promptability, pruner, cap escalation) are probed directly.
 *
 * Phases:
 *   setup     scratch workspace + facts.json
 *   load      drive turns until >=3 compaction cycles, probing after each
 *   analyze   parse session log + wire dumps -> findings.json / report.md
 *   mech      ghost-revert probe + keeper spec runs + error-audit cross-check
 *   judge     judge pass (separate ctx-eval-judge session) over ambiguous items
 *   status    print current state
 *
 * All writes stay under --evidence; the session under test is only ever driven
 * through the official Remote surface (scripts/dsh-e2e-drive.mjs).
 *
 * Usage: node scripts/context-eval.mjs --phase load --max-turns 24 --cycles 3
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = homedir()
const F = '/home/adam/deepseek-harness'
const DRIVER = join(F, 'scripts', 'dsh-e2e-drive.mjs')
const GHOST = join(HOME, 'dsh-migration/evidence/ghost-revert/ghost-revert-probe.mjs')
const EVID = join(HOME, 'dsh-migration/evidence/context-eval')
const WORKSPACE = '/home/adam/ctx-eval/workspace'
const LOGS = join(HOME, '.dsh/logs')
const SESSIONS = join(HOME, '.dsh/sessions')
const SERVER = 'http://127.0.0.1:3080'
const UNIT = 'dsh-web.service'

const DEFAULT_SESSION = 'ctx-eval-long-a'
const JUDGE_SESSION = 'ctx-eval-judge-a'
const DEFAULT_MODEL = 'opencode-go/minimax-m2.5'
const TURN_TIMEOUT_SEC = 900

// ── planted facts ───────────────────────────────────────────────────────────
// correct: regex proving the planted value was carried; contradict: a regex
// that proves a DIFFERENT value was stated in the same slot. Anything else
// non-empty is ambiguous -> judge.
const FACTS = [
  { id: 'F1', seedTurn: 1, kind: 'identifier', value: 'CTXEVAL-KEY-7F3A9', line: '# IDENTIFIER: the deployment key reference is CTXEVAL-KEY-7F3A9', correct: [/CTXEVAL-KEY-7F3A9/i], contradict: [/CTXEVAL-KEY-[A-Z0-9]{6}/i] },
  { id: 'F2', seedTurn: 1, kind: 'decision', value: 'audit log uses a ring buffer, not a queue', line: '# DECISION: the audit log uses a ring buffer, not a queue', correct: [/ring buffer/i], contradict: [/audit log[^.]*\bqueue\b/i] },
  { id: 'F3', seedTurn: 1, kind: 'constraint', value: 'retry budget is exactly 7 attempts', line: '# CONSTRAINT: the retry budget is exactly 7 attempts', correct: [/^\s*7\s*$/, /(retry budget|attempts?)[^.\n]*\b7\b|\b7\b[^.\n]*attempt/i], contradict: [/(retry budget|attempts?)[^.\n]*\b(4|5|6|8|9|10)\b/i] },
  { id: 'F4', seedTurn: 1, kind: 'path', value: '/home/adam/ctx-eval/workspace/ledger/ADR-0042.md', line: '# PATH: the decision record lives at /home/adam/ctx-eval/workspace/ledger/ADR-0042.md', correct: [/ADR-0042\.md/], contradict: [/ADR-00(4[0-35-9]|[0-3]\d)\.md/] },
  { id: 'F5', seedTurn: 2, kind: 'number', value: 'staging port 17777', line: '# PORT: staging listens on port 17777', correct: [/\b17777\b/], contradict: [/port[^0-9]{0,20}(1776|1778|18000|8080|8888|17771)\b/i] },
  { id: 'F6', seedTurn: 2, kind: 'owner', value: 'Mara Voss', line: '# OWNER: the migration owner is Mara Voss', correct: [/Mara\s+Voss/i], contradict: [/owner is ([A-Z][a-z]+ [A-Z][a-z]+)/] },
  { id: 'F7', seedTurn: 3, kind: 'date', value: '2026-11-03', line: '# DATEFREEZE: feature freeze is 2026-11-03', correct: [/2026-11-03/], contradict: [/2026-1[0-2]-(0[4-9]|[12]\d|3[01])/] },
  { id: 'F8', seedTurn: 3, kind: 'dependency', value: 'fastcsv-9.4.1', line: '# DEP: the CSV parser is pinned to fastcsv-9.4.1', correct: [/fastcsv-9\.4\.1/i], contradict: [/fastcsv-9\.[0-35-9]\.\d+/i] },
  { id: 'F9', seedTurn: 4, kind: 'invariant', value: 'tenant IDs never appear in logs', line: '# INVARIANT: tenant IDs never appear in logs', correct: [/tenant[^.\n]{0,40}(never|must not|no)[^.\n]{0,20}log/i], contradict: [/tenant[^.\n]{0,30}may (appear|be)[^.\n]{0,20}log/i] },
  { id: 'F10', seedTurn: 4, kind: 'threshold', value: 'quality score cutoff Qs=0.83', line: '# QS: the quality score cutoff is Qs=0.83', correct: [/0\.83/], contradict: [/Qs\s*[=:]\s*0\.(8[0-24-9]|9\d)/i] },
]

const WHITEBOARD_FACT = { id: 'WB-PIN-91C2', value: 'canary build is green', text: 'WB-PIN-91C2 = the canary build is green (pinned by the context eval)' }
const MEMORY_FACT = { id: 'MEM-8D1E', value: 'eu-central-3', text: 'MEM-8D1E: the archive bucket is eu-central-3' }
const PRUNE_CANARY = 'PRUNE-CANARY-MID-5566'
const PRUNE_MARKER = '[... tool result middle pruned ...]'

// ── tiny utils ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

function statePath() { return join(EVID, 'state.json') }
function factsPath() { return join(EVID, 'facts.json') }
function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  console.log(stamped)
  try { appendFileSync(join(EVID, 'run.log'), stamped + '\n') } catch {}
}

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Synthetic incident export; deterministic for a given turn. */
function makeCorpus(turn, lines) {
  const r = rng(1000 + turn * 7)
  const pick = (arr) => arr[Math.floor(r() * arr.length)]
  const svcs = ['api-gateway', 'ledger-writer', 'auth', 'billing', 'search', 'notify', 'ingest', 'replay']
  const codes = ['E1001', 'E2033', 'E3104', 'E4047', 'E5120', 'E6612', 'E7788', 'E8190', 'E9022', 'E9414']
  const out = []
  out.push(`# EXPORT ${turn} incident export generated ${new Date(1790000000000 + turn * 86400000).toISOString().slice(0, 10)}`)
  const seeded = FACTS.filter(f => f.seedTurn === turn)
  for (const f of seeded) out.push(f.line)
  for (let i = 0; i < lines; i++) {
    const svc = pick(svcs); const code = pick(codes)
    const sev = r() < 0.12 ? 'SEV1' : r() < 0.35 ? 'SEV2' : 'SEV3'
    const tenant = `t-${Math.floor(r() * 4096).toString(16).padStart(3, '0')}`
    const lat = Math.floor(40 + r() * 1800)
    const msg = pick([
      'upstream reset by peer', 'deadline exceeded', 'queue backlog high', 'token refresh failed',
      'write amplification spike', 'replication lag', 'cache miss storm', 'rate limit hit',
      'checksum mismatch', 'connection pool exhausted', 'schema drift detected', 'retry storm',
    ])
    out.push(`{"ts":"2026-10-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}T${String(Math.floor(r() * 24)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00Z","svc":"${svc}","sev":"${sev}","code":"${code}","tenant":"${tenant}","lat_ms":${lat},"msg":"${msg}"}`)
  }
  out.push(`# END EXPORT ${turn}`)
  return out.join('\n')
}

function workTurnText(n) {
  // Per-argument limit (MAX_ARG_STRLEN = 131072 bytes) caps what one prompt can
  // carry; 520 lines x ~150 B ≈ 78 KB keeps a safe margin under it.
  const corpus = makeCorpus(n, n <= 5 ? 640 : 480)
  return `WORK TURN ${n}. The block at the end is raw incident export #${n}. Do this real work:
1. Parse it and compute total records, per-severity counts (SEV1/SEV2/SEV3) and the top 3 error codes by frequency.
2. Append (do not rewrite the file) a section to ledger/incidents.md titled "## Export ${n}" containing those numbers.
3. Every line in the export starting with "# " is a governance marker. Append each marker's EXACT text (verbatim) as a bullet to ledger/CONSTITUTION.md under the matching heading, creating headings only if missing. Do not paraphrase markers.
4. Reply with exactly one line: \`EXPORT ${n}: total=<N> sev=<SEV1=n,SEV2=n,SEV3=n> top=<code,code,code>\`. Do not paste the corpus back.
${n === 3 ? '5. Read data/bigfile.txt with the read tool (the whole file), find the single line starting with "PRUNE-CANARY-MID", append it verbatim to ledger/notes.md, and add `CANARY=<its 4-digit suffix>` to your reply.\n' : ''}
--- EXPORT ${n} ---
${corpus}
--- END EXPORT ${n} ---`
}

const FACT_PROMPTS = {
  F1: 'the deployment key reference (a CTXEVAL identifier)',
  F2: 'the audit log data-structure decision',
  F3: 'the retry-budget constraint (exact number)',
  F4: 'the path of the decision record file (ADR .md)',
  F5: 'the staging port number',
  F6: 'the migration owner\'s full name',
  F7: 'the feature-freeze date',
  F8: 'the pinned CSV parser dependency (name and version)',
  F9: 'the tenant-ID logging invariant',
  F10: 'the quality-score cutoff (Qs value)',
}

function probeTurnText(cycle) {
  return `RECALL CHECK ${cycle}. Answer strictly from this conversation's context. Do NOT call any tool, do NOT read files.
For each slot below, give the exact value that was stated earlier in this session. If a value never appeared, write exactly: unknown
${FACTS.map(f => `${f.id} = ${FACT_PROMPTS[f.id]}`).join('\n')}
W1 = the pinned whiteboard entry WB-PIN-91C2 (what does it mean?)
Reply with exactly these lines, one per slot and nothing else: ${FACTS.map(f => `${f.id}=<value>`).join(' ')} W1=<value>`
}

function boardMemoryTurnText() {
  return `GOVERNANCE SETUP. Do exactly these three things and nothing else:
1. Call whiteboard_write to add an entry with id "${WHITEBOARD_FACT.id}" and text "${WHITEBOARD_FACT.text}".
2. Call whiteboard_pin for entry id "${WHITEBOARD_FACT.id}".
3. Call memory_save to store exactly: "${MEMORY_FACT.text}", then call memory_confirm for that saved fact.
Then reply with one line per action: \`whiteboard=<ok|error> pin=<ok|error> memory_save=<ok|error> memory_confirm=<ok|error>\`.`
}

function canaryTurnText() {
  return `CANARY READ. Read the file data/bigfile.txt in full with the read tool. Find the single line starting with "${PRUNE_CANARY}" and append it verbatim to ledger/notes.md. Reply with exactly one line: CANARY=<the full canary line verbatim>.`
}

function recallProbeTurnText() {
  return `RECALL-DEEP CHECK. The deployment-key identifier from an early export is no longer in the visible context. Use the session recall tools (session_event_search with query "CTXEVAL", then session_event_read on the hit) to retrieve the full identifier string from this session's log. Reply with exactly one line: R1=<the full identifier> or R1=unretrievable.`
}

function memoryProbeTurnText() {
  return `MEMORY RECALL CHECK. Use the memory_search tool to look up the archive bucket fact (id MEM-8D1E) that was saved to durable memory earlier in this session. Reply with exactly one line: MEM=<bucket> (the bucket name exactly as saved) or MEM=unretrievable if memory_search cannot find it.`
}

function prunerProbeTurnText() {
  return `PRUNER RECALL CHECK. Earlier in this session a tool result from reading data/bigfile.txt was shortened in the model context by the tool-result pruner. Use the session recall tools (session_event_search / session_event_read) to retrieve the FULL original tool result and report the exact line that starts with "${PRUNE_CANARY}" (the canary sits in the pruned middle). Reply with exactly one line: PRUNE=<the full canary line, verbatim> — or PRUNE=unretrievable if the recall tools cannot find it.`
}

// ── session-log + wire parsing ──────────────────────────────────────────────
function findSessionLog(sid) {
  const roots = [SESSIONS, join(SESSIONS, '--home-adam-ctx-eval-workspace--')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    const direct = join(root, sid, 'session.v4.jsonl.zstd')
    if (existsSync(direct)) return direct
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, sid, 'session.v4.jsonl.zstd')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function readSessionEvents(sid) {
  const logPath = findSessionLog(sid)
  if (logPath === null) return []
  const res = spawnSync('zstd', ['-dc', logPath], { maxBuffer: 512 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`zstd failed for ${logPath}: ${String(res.stderr).slice(0, 300)}`)
  const events = []
  for (const line of res.stdout.toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch {}
  }
  return events
}

function wireFiles(sid, sinceMs) {
  const out = []
  for (const name of readdirSync(LOGS)) {
    if (!name.startsWith('wire-') || !name.endsWith('.json')) continue
    const path = join(LOGS, name)
    try {
      if (sinceMs !== undefined && statSync(path).mtimeMs < sinceMs) continue
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed.sessionId === sid) out.push({ path, ...parsed })
    } catch {}
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

const isErr = (e) => e.data !== undefined && e.data !== null && typeof e.data === 'object' && 'error' in e.data && e.data.error !== undefined
const textOf = (blocks) => (blocks ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
const eventText = (e) => {
  const d = e.data ?? {}
  if (e.type === 'user/message') return textOf(d.content)
  if (e.type === 'assistant/message') return textOf(d.message?.content)
  return ''
}

/** Compact digest of the session at one point in time. */
function digest(events) {
  const turns = []
  let current = null
  const compactions = []
  const checkpoints = []
  const briefs = []
  const start = { kind: 'session-header', seq: events[0]?.seq ?? -1 }
  let seq = start.seq
  for (const e of events) {
    if (typeof e.seq === 'number') seq = e.seq
    switch (e.type) {
      case 'turn/start': current = { turn: e.data.turn, startSeq: seq, endSeq: null, reason: null, userSeq: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, toolCalls: 0, toolNames: [], toolErrors: 0, approvals: [], texts: [] }; turns.push(current); break
      case 'user/message': if (current !== null && (e.data.source?.kind === 'user' || e.data.source?.rpcId !== undefined)) current.userSeq = seq; break
      case 'tool/call': if (current !== null) { current.toolCalls++; current.toolNames.push(e.data.name); } break
      case 'tool/result': if (current !== null && isErr(e)) current.toolErrors++; break
      case 'approval/asked': if (current !== null) current.approvals.push({ asked: e.data.toolName ?? '?' }); break
      case 'approval/denied': if (current !== null) current.approvals.push({ denied: e.data.toolName ?? '?' }); break
      case 'assistant/message': {
        if (current !== null && e.data.usage !== undefined) {
          current.usage.inputTokens += e.data.usage.inputTokens ?? 0
          current.usage.outputTokens += e.data.usage.outputTokens ?? 0
          current.usage.cacheReadTokens += e.data.usage.cacheReadTokens ?? 0
        }
        if (current !== null) {
          const text = textOf(e.data.message?.content)
          if (text.trim() !== '') current.texts.push(text.slice(0, 1200))
        }
        break
      }
      case 'turn/end': if (current !== null) { current.endSeq = seq; current.reason = e.data.reason ?? null } break
      case 'compaction/start': compactions.push({ kind: 'start', seq, time: e.time, id: e.data.compactionId }); break
      case 'compaction/summary': compactions.push({ kind: 'summary', seq, time: e.time, id: e.data.compactionId, shadowedRange: e.data.shadowedRange, shadowedTokenCount: e.data.shadowedTokenCount, model: e.data.model, summary: typeof e.data.summary === 'string' ? e.data.summary : textOf(e.data.summary) }); break
      case 'compaction/end': compactions.push({ kind: 'end', seq, time: e.time, id: e.data.compactionId, error: e.data.error, startSeq: e.data.startSeq, endSeq: e.data.endSeq }); break
      case 'state/checkpoint': checkpoints.push({ seq, time: e.time, version: e.data.version, basedOnSeq: e.data.basedOnSeq, model: e.data.model, via: e.data.via, text: e.data.text }); break
      case 'brief/prose-updated': briefs.push({ seq, time: e.time, basedOnSeq: e.data.basedOnSeq, model: e.data.model, text: e.data.text }); break
      default: break
    }
  }
  return { turns, compactions, checkpoints, briefs, lastSeq: seq, totalEvents: events.length }
}

// ── RPC (create/select/title) ───────────────────────────────────────────────
function mintCookie() {
  const journal = execFileSync('journalctl', ['--user', '-u', UNIT, '--no-pager', '-n', '500'], { encoding: 'utf8' })
  const matches = journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9_-]+/g)
  const tokenUrl = matches?.at(-1)
  if (tokenUrl === undefined) throw new Error('no launch token in journal')
  return (async () => {
    const launched = new URL(tokenUrl)
    const response = await fetch(launched, { redirect: 'manual' })
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? '']
    const cookie = setCookies[0]?.split(';', 1)[0]
    if (cookie === undefined || !cookie.startsWith('dsh-auth-')) throw new Error('no dsh-auth cookie')
    return cookie
  })()
}

async function rpc(cookie, method, request) {
  const response = await fetch(`${SERVER}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `${method.replace('/', '-')}-${randomUUID()}`, method, payload: { args: { request } } }),
    signal: AbortSignal.timeout(60_000),
  })
  const body = await response.json()
  if (body?.type !== 'server-response' || body.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body).slice(0, 400)}`)
  return body.result.value
}

// ── phases ──────────────────────────────────────────────────────────────────
function phaseSetup() {
  mkdirSync(EVID, { recursive: true })
  mkdirSync(join(EVID, 'turns'), { recursive: true })
  mkdirSync(join(EVID, 'raw'), { recursive: true })
  mkdirSync(join(WORKSPACE, 'ledger'), { recursive: true })
  mkdirSync(join(WORKSPACE, 'data'), { recursive: true })
  writeFileSync(join(WORKSPACE, 'ledger', 'CONSTITUTION.md'), `# Project constitution\n\n## Decisions\n\n## Constraints\n\n## Ownership\n\n## Invariants\n`)
  writeFileSync(join(WORKSPACE, 'ledger', 'incidents.md'), `# Incident ledger\n`)
  writeFileSync(join(WORKSPACE, 'README.md'), `# ctx-eval workspace\n\nScratch project for the doc 66 context eval. Ledger files are updated by the eval session.\n`)
  // Big file whose middle will be pruned out of the model surface.
  const lines = []
  for (let i = 1; i <= 600; i++) {
    lines.push(i === 300 ? `${PRUNE_CANARY} = 7788` : `row-${String(i).padStart(4, '0')} checksum=${(i * 2654435761) % 100000}`)
  }
  writeFileSync(join(WORKSPACE, 'data', 'bigfile.txt'), lines.join('\n') + '\n')
  writeJson(factsPath(), { facts: FACTS, whiteboard: WHITEBOARD_FACT, memory: MEMORY_FACT, pruneCanary: PRUNE_CANARY })
  log(`setup: workspace at ${WORKSPACE}, evidence at ${EVID}`)
}

async function phaseLoad(opts) {
  const sid = opts.sessionId ?? DEFAULT_SESSION
  mkdirSync(join(EVID, 'turns'), { recursive: true })
  mkdirSync(join(EVID, 'raw'), { recursive: true })
  let state = existsSync(statePath()) ? readJson(statePath()) : null
  if (state === null) {
    const cookie = await mintCookie()
    const created = await rpc(cookie, 'session/create', { cwd: WORKSPACE, sessionId: sid, agentPreset: 'orchestrator' })
    await rpc(cookie, 'session/selectModel', { sessionId: sid, provider: opts.model.split('/')[0], model: opts.model.split('/').slice(1).join('/') })
    await rpc(cookie, 'session/title', { sessionId: sid, title: 'context-eval long-horizon load', source: { kind: 'user' } }).catch(() => {})
    state = { sid, model: opts.model, cycleCount: 0, probesDone: 0, turnsRun: 0, planIndex: 0, pending: null, history: [], startedAt: Date.now(), lastCompactionCount: 0, note: `session/create -> ${created.sessionId}` }
    writeJson(statePath(), state)
    log(state.note)
  }
  if (state.pending === 'pruner') { state.pending = null; state.prunerArmed = false; state.prunerDone = false }
  if (state.model !== opts.model) {
    const cookie = await mintCookie()
    await rpc(cookie, 'session/selectModel', { sessionId: sid, provider: opts.model.split('/')[0], model: opts.model.split('/').slice(1).join('/') })
    log(`model switch: ${state.model} -> ${opts.model}`)
    state.model = opts.model
    writeJson(statePath(), state)
  }
  const maxTurns = opts.maxTurns ?? 24
  const targetCycles = opts.cycles ?? 3

  while (state.turnsRun < maxTurns) {
    if (state.pending === 'probe' && state.probesDone < targetCycles) {
      await runTurn(opts, state, { kind: 'probe', cycle: state.cycleCount })
      state.pending = null
      continue
    }
    if (state.pending === 'memory') {
      state.pending = null
      await runTurn(opts, state, { kind: 'memory' })
      break
    }
    if (state.prunerArmed === true && state.prunerDone !== true) {
      if (state.canaryDone !== true) {
        state.canaryDone = true
        await runTurn(opts, state, { kind: 'canary' })
      } else {
        state.prunerDone = true
        await runTurn(opts, state, { kind: 'pruner' })
      }
      continue
    }
    // plan order: 4 seeded work turns, then board/memory, then more work turns
    const plan = []
    const next = state.planIndex
    if (next < 4) plan.push({ kind: 'work', n: next + 1 })
    else if (next === 4) plan.push({ kind: 'board' })
    else plan.push({ kind: 'work', n: next })
    const action = plan[0]
    await runTurn(opts, state, action)
    state.planIndex += 1
  }
  writeJson(statePath(), state)
  log(`load finished: turns=${state.turnsRun} cycles=${state.cycleCount} probes=${state.probesDone}`)
}

async function runTurn(opts, state, action) {
  const before = digest(readSessionEvents(state.sid))
  const n = state.turnsRun + 1
  const label = action.kind === 'probe' ? `probe${action.cycle}` : action.kind === 'board' ? 'board' : action.kind === 'pruner' ? 'pruner' : action.kind === 'memory' ? 'memory' : action.kind === 'canary' ? 'canary' : `work${action.n}`
  const outDir = join(EVID, 'turns', `${String(n).padStart(2, '0')}-${label}`)
  mkdirSync(outDir, { recursive: true })
  const task = action.kind === 'probe' ? probeTurnText(action.cycle)
    : action.kind === 'board' ? boardMemoryTurnText()
      : action.kind === 'pruner' ? prunerProbeTurnText()
        : action.kind === 'memory' ? memoryProbeTurnText()
          : action.kind === 'canary' ? canaryTurnText()
            : workTurnText(action.n)
  const args = ['timeout', String(TURN_TIMEOUT_SEC), process.execPath, DRIVER,
    '--cwd', WORKSPACE, '--session-id', state.sid, '--task', task,
    '--out', outDir, '--url', SERVER, '--unit', UNIT,
    '--approve', 'once', '--answer-questions', 'auto',
    '--timeout', String(TURN_TIMEOUT_SEC - 60), '--cancel-after', '0']
  log(`turn ${n} (${label}) … driver start`)
  const started = Date.now()
  let res = spawnSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (res.error !== undefined) {
    // Spawn failure (no prompt admitted) — one clean retry of the same action.
    log(`turn ${n} spawn error: ${String(res.error)} — retrying once`)
    log(`turn ${n} spawn error: ${String(res.error)}`)
    res = spawnSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  }
  const wallMs = Date.now() - started
  if (res.status !== 0 && res.status !== null && String(res.stderr ?? '').trim() !== '') log(`turn ${n} stderr: ${String(res.stderr).slice(-400)}`)
  const events = readSessionEvents(state.sid)
  const after = digest(events)
  const end = after.turns.at(-1) ?? null
  const terminal = res.status === 0 && end !== null && end.endSeq !== null
  // new compaction cycles closed in this turn
  const ends = after.compactions.filter(c => c.kind === 'end')
  const newEnds = ends.slice(state.lastCompactionCount)
  const fresh = newEnds.filter(c => c.error === undefined)
  const failed = newEnds.filter(c => c.error !== undefined)
  const freshSummaries = after.compactions.filter(c => c.kind === 'summary').slice(before.compactions.filter(c => c.kind === 'summary').length)
  const newCheckpoints = after.checkpoints.slice(before.checkpoints.length)
  const newBriefs = after.briefs.slice(before.briefs.length)
  const record = {
    turn: n, label, action, taskChars: task.length, wallMs, driverExit: res.status, terminal,
    turnSeq: end?.endSeq ?? null, usage: end?.usage ?? null, toolCalls: end?.toolCalls ?? 0,
    newCompactions: newEnds.length, freshCompactions: fresh.length, failedCompactions: failed.length,
    shadowed: freshSummaries.map(s => ({ range: s.shadowedRange, tokens: s.shadowedTokenCount })),
    checkpoints: newCheckpoints.map(c => ({ version: c.version, basedOnSeq: c.basedOnSeq, model: c.model, via: c.via, chars: (c.text ?? '').length })),
    briefs: newBriefs.map(b => ({ basedOnSeq: b.basedOnSeq, model: b.model, chars: (b.text ?? '').length })),
    driverLog: join(outDir, `${state.sid}.driver.log`),
    stdoutTail: String(res.stdout ?? '').split('\n').slice(-6).join('\n'),
  }
  state.turnsRun = n
  state.lastCompactionCount = ends.length
  state.cycleCount += fresh.length
  state.history.push(record)
  writeJson(join(outDir, 'turn.json'), record)
  writeJson(join(EVID, 'raw', `digest-${String(n).padStart(2, '0')}.json`), after)
  // probe sequencing
  if (fresh.length > 0) state.pending = 'probe'
  if (action.kind === 'probe') {
    state.probesDone += 1
    if (state.probesDone >= (opts.cycles ?? 3)) state.pending = 'memory'
  }
  // the pruner recall turn runs once, after work turn 3 has read data/bigfile.txt
  if (action.kind === 'work' && action.n === 3) state.prunerArmed = true
  writeJson(statePath(), state)
  log(`turn ${n} (${label}) done: exit=${res.status} wall=${(wallMs / 1000).toFixed(0)}s usage=${JSON.stringify(record.usage)} newCompactions=${newEnds.length} fresh=${fresh.length} checkpoints=${newCheckpoints.length} briefs=${newBriefs.length}${terminal ? '' : ' — NO TERMINAL'}`)
}

// ── analyze ─────────────────────────────────────────────────────────────────
function parseProbeAnswer(events, turn) {
  // assistant text after the probe user message within this turn
  const turnEndSeq = turn.endSeq ?? Number.MAX_SAFE_INTEGER
  let text = ''
  for (const e of events) {
    if (e.seq === undefined || e.seq < (turn.userSeq ?? 0) || e.seq > turnEndSeq) continue
    if (e.type === 'assistant/message') text += '\n' + textOf(e.data.message?.content)
  }
  return text
}

function scoreAnswer(answer, maybeJudge) {
  const lines = new Map()
  for (const line of answer.split('\n')) {
    const m = /^\s*F(\d{1,2})\s*[=:]\s*(.*?)\s*$/.exec(line)
    if (m !== null) lines.set(`F${m[1]}`, m[2])
  }
  const results = []
  for (const fact of FACTS) {
    const raw = lines.get(fact.id)
    if (raw === undefined || raw === '' || /^unknown\b/i.test(raw)) { results.push({ id: fact.id, verdict: 'omitted', answer: raw ?? null }); continue }
    if (fact.correct.some(re => re.test(raw))) { results.push({ id: fact.id, verdict: 'recalled', answer: raw }); continue }
    if (fact.contradict.some(re => re.test(raw))) { results.push({ id: fact.id, verdict: 'contradicted', answer: raw }); continue }
    results.push({ id: fact.id, verdict: 'ambiguous', answer: raw })
    maybeJudge.push({ fact: fact.id, expected: fact.value, answer: raw, note: 'no deterministic correct/contradict match' })
  }
  return results
}

function anchorsIn(text) {
  const hits = {}
  for (const f of FACTS) {
    const tokens = [f.value, ...(f.value.match(/[A-Za-z0-9_.:\/-]{4,}/g) ?? [])]
    hits[f.id] = tokens.some(t => t.length >= 4 && text.includes(t))
  }
  hits.WB = text.includes(WHITEBOARD_FACT.id) || /canary build is green/i.test(text)
  hits.MEM = text.includes('eu-central-3')
  hits.PRUNE = text.includes(PRUNE_CANARY)
  return hits
}

function phaseAnalyze(opts) {
  const state = existsSync(statePath()) ? readJson(statePath()) : null
  if (state === null) throw new Error('no state.json — run --phase load first')
  const sid = state.sid
  const events = readSessionEvents(sid)
  const d = digest(events)
  const transcriptText = events.map(eventText).join('\n')
  const wires = wireFiles(sid, state.startedAt - 60_000)
  const t0 = state.startedAt

  // compaction cycles (ends joined to summaries by compactionId)
  const summaries = d.compactions.filter(c => c.kind === 'summary')
  const ends = d.compactions.filter(c => c.kind === 'end')
  const cycles = ends.map((end, i) => {
    const summary = summaries.find(s => s.id === end.id) ?? null
    return {
      index: i + 1,
      compactionId: end.id,
      error: end.error,
      startSeq: end.startSeq,
      endSeq: end.endSeq,
      shadowed: summary?.shadowedRange ?? null,
      shadowedTokens: summary?.shadowedTokenCount ?? null,
      summaryModel: summary?.model ?? null,
      summaryText: summary?.summary ?? '',
      successful: end.error === undefined,
    }
  })

  // per-turn cost
  const cost = d.turns.map(t => ({
    turn: t.turn, terminal: t.endSeq !== null, reason: t.reason,
    input: t.usage.inputTokens, output: t.usage.outputTokens, cacheRead: t.usage.cacheReadTokens,
    cacheHitRatio: (t.usage.cacheReadTokens + t.usage.inputTokens) > 0 ? +(t.usage.cacheReadTokens / (t.usage.cacheReadTokens + t.usage.inputTokens)).toFixed(3) : null,
    seqRange: [t.startSeq, t.endSeq],
  }))

  // probe scoring — driven by the log (survives restarts/duplicates)
  const probes = []
  const maybeJudge = []
  const userPrompts = events.filter(e => e.type === 'user/message' && (e.data?.source?.kind === 'user' || e.data?.source?.rpcId !== undefined))
    .map(e => ({ seq: e.seq, text: textOf(e.data.content) }))
  const turnOfSeq = (seq) => {
    let found = null
    for (const t of d.turns) if (t.startSeq <= seq) found = t
    return found
  }
  for (const prompt of userPrompts.filter(p => p.text.startsWith('RECALL CHECK'))) {
    const turn = turnOfSeq(prompt.seq)
    if (turn === undefined || turn === null) continue
    const answer = parseProbeAnswer(events, turn)
    const results = scoreAnswer(answer, maybeJudge)
    // whiteboard slot (W1) — injected every request, no tools allowed in a probe
    const w1 = /^\s*W1\s*[=:]\s*(.*)$/m.exec(answer)?.[1] ?? null
    const w1Verdict = w1 === null || /unknown/i.test(w1) ? 'omitted'
      : /canary build is green|WB-PIN-91C2/i.test(w1) ? 'recalled'
        : 'ambiguous'
    // surface presence at the last request before the probe turn
    const probeTime = events.find(e => e.seq === prompt.seq)?.time ?? Date.now()
    const beforeProbe = wires.filter(w => w.time < probeTime)
    const surface = beforeProbe.length > 0 ? JSON.stringify({ system: beforeProbe.at(-1).system, messages: beforeProbe.at(-1).messages }) : ''
    const presence = anchorsIn(surface)
    const presenceWholeSession = anchorsIn(transcriptText)
    const cycle = d.compactions.filter(c => c.kind === 'end' && c.error === undefined && c.seq < prompt.seq).length
    probes.push({ turn: turn.turn, cycle, results, w1: { answer: w1, verdict: w1Verdict }, presence, presenceWholeSession, answerPreview: answer.slice(0, 1500), toolNames: turn.toolNames })
  }
  // dedicated memory + pruner + canary turns (log-driven)
  const otherProbes = []
  for (const prompt of userPrompts) {
    const isMemory = prompt.text.startsWith('MEMORY RECALL CHECK')
    const isPruner = prompt.text.startsWith('PRUNER RECALL CHECK')
    const isCanary = prompt.text.startsWith('CANARY READ')
    const isBoard = prompt.text.startsWith('GOVERNANCE SETUP')
    const isDeep = prompt.text.startsWith('RECALL-DEEP')
    const isRetrieve = prompt.text.startsWith('RETRIEVE CHECK')
    if (!isMemory && !isPruner && !isCanary && !isBoard && !isDeep && !isRetrieve) continue
    const turn = turnOfSeq(prompt.seq)
    if (turn === undefined || turn === null) continue
    const answer = parseProbeAnswer(events, turn)
    const kind = isMemory ? 'memory' : isPruner ? 'pruner' : isCanary ? 'canary' : isRetrieve ? 'retrieve' : isDeep ? 'recall-deep' : 'board'
    const line = isMemory ? /MEM\s*[=:]\s*(.*)/i.exec(answer)?.[1] ?? null
      : isPruner ? /PRUNE\s*[=:]\s*(.*)/i.exec(answer)?.[1] ?? null
        : isCanary ? /CANARY\s*[=:]\s*(.*)/i.exec(answer)?.[1] ?? null
          : isRetrieve ? /RETRIEVE\s*[=:]\s*(.*)/i.exec(answer)?.[1] ?? null
            : isDeep ? (/R1\s*[=:]\s*(.*)/i.exec(answer)?.[1] ?? /READ\s*[=:]\s*(.*)/i.exec(answer)?.[1] ?? null)
              : answer.split('\n').filter(l => /whiteboard|pin|memory_save|memory_confirm/i.test(l)).slice(0, 4).join(' | ')
    let verdict = 'ambiguous'
    if (isMemory) verdict = line !== null && /eu-central-3/i.test(line) ? 'recalled' : /unretrievable/i.test(line ?? '') ? 'omitted' : 'ambiguous'
    else if (isPruner) verdict = line !== null && /7788/.test(line) ? 'recalled' : /unretrievable/i.test(line ?? '') ? 'omitted' : 'ambiguous'
    else if (isCanary) verdict = line !== null && /7788/.test(line) ? 'recalled' : 'ambiguous'
    else if (isRetrieve || isDeep) verdict = line !== null && /CTXEVAL-KEY-7F3A9/i.test(line) ? 'recalled' : /unretrievable/i.test(line ?? '') || /error:/i.test(line ?? '') ? 'omitted' : 'ambiguous'
    else verdict = /ok/i.test(line ?? '') ? 'recalled' : 'ambiguous'
    otherProbes.push({ turn: turn.turn, kind, answer: (line ?? answer.replace(/\s+/g, ' ')).slice(0, 300), verdict, toolNames: (turn.toolNames ?? []).filter(n => !['read', 'bash'].includes(n)), toolCalls: turn.toolCalls })
  }

  // faithfulness: every brief/checkpoint/summary vs the transcript it covers
  const faithfulness = []
  for (const b of d.briefs) {
    const span = events.filter(e => e.seq !== undefined && e.seq <= b.basedOnSeq)
    const spanText = span.map(eventText).join('\n')
    faithfulness.push(checkFidelity(`brief-seq${b.seq}`, b.text, spanText, b.basedOnSeq, maybeJudge))
  }
  for (const c of d.checkpoints) {
    const span = events.filter(e => e.seq !== undefined && e.seq <= c.basedOnSeq)
    const spanText = span.map(eventText).join('\n')
    faithfulness.push(checkFidelity(`checkpoint-v${c.version}-seq${c.seq}`, c.text, spanText, c.basedOnSeq, maybeJudge))
  }
  for (const s of summaries) {
    const start = s.shadowedRange?.start ?? 0
    const end = s.shadowedRange?.end ?? 0
    const span = events.filter(e => e.seq !== undefined && e.seq >= start && e.seq <= end)
    const spanText = span.map(eventText).join('\n')
    faithfulness.push(checkFidelity(`compaction-summary-seq${s.seq}`, s.summary ?? '', spanText, start, maybeJudge))
  }

  // pruner: markers seen in wire surfaces, tool pairing integrity
  const prunedHits = []
  for (const w of wires) {
    if (!JSON.stringify(w.messages ?? []).includes(PRUNE_MARKER)) continue
    // count marker occurrences and find the pruned result's call id
    const text = JSON.stringify(w.messages)
    const idx = text.indexOf(PRUNE_MARKER)
    prunedHits.push({ time: w.time, maxTokens: w.maxTokens, model: w.model, around: text.slice(Math.max(0, idx - 120), idx + 160) })
  }
  const pairing = checkToolPairing(wires)

  // compaction replacement layer: the request immediately after each cut must
  // carry the framed summary and the live state checkpoint
  const summaryLayer = []
  for (const end of ends) {
    const endTime = events.find(e => e.seq === end.seq)?.time ?? 0
    const w = wires.find(x => x.time > endTime)
    if (w === undefined) continue
    const body = JSON.stringify(w.messages ?? [])
    summaryLayer.push({
      endSeq: end.seq,
      nextRequestTime: w.time,
      hasCompactedSummary: body.includes('<compacted-summary>'),
      hasStateCheckpoint: d.checkpoints.some(c => (c.text ?? '').length > 40 && body.includes((c.text ?? '').replace(/\n/g, '\\n').slice(0, 40))),
    })
  }
  // cost split around the first successful cut
  const firstEndSeq = ends.find(e => e.error === undefined)?.seq ?? null
  const firstCutTurn = firstEndSeq === null ? null : (d.turns.find(t => t.endSeq !== null && t.endSeq >= firstEndSeq)?.turn ?? null)
  const avg = (list) => list.length === 0 ? null : {
    turns: list.length,
    input: Math.round(list.reduce((s, t) => s + t.usage.inputTokens, 0) / list.length),
    output: Math.round(list.reduce((s, t) => s + t.usage.outputTokens, 0) / list.length),
    cacheRead: Math.round(list.reduce((s, t) => s + t.usage.cacheReadTokens, 0) / list.length),
    cacheHitRatio: +(list.reduce((s, t) => s + (t.usage.cacheReadTokens / Math.max(1, t.usage.cacheReadTokens + t.usage.inputTokens)), 0) / list.length).toFixed(3),
  }
  const beforeCut = firstCutTurn === null ? [] : d.turns.filter(t => t.turn < firstCutTurn)
  const afterCut = firstCutTurn === null ? [] : d.turns.filter(t => t.turn > firstCutTurn)

  // cap escalation + keeper calls from wire dumps
  const keeperCalls = wires.filter(w => (w.maxTokens ?? 0) <= 4096 && (w.messages ?? []).length === 1)
  const compactionCalls = wires.filter(w => JSON.stringify(w.messages ?? []).includes('acting as a compaction engine'))
  const compactionCallCost = compactionCalls.map(w => ({ time: w.time, model: w.model, maxTokens: w.maxTokens, inputChars: JSON.stringify(w.messages ?? []).length, inputTokensEstimate: Math.ceil(JSON.stringify(w.messages ?? []).length / 4) }))
  const escalatedPairs = []
  for (let i = 1; i < wires.length; i++) {
    const a = wires[i - 1]; const b = wires[i]
    if (a.maxTokens === 2048 && b.maxTokens === 4096 && JSON.stringify(a.messages) === JSON.stringify(b.messages)) {
      escalatedPairs.push({ time: b.time, chars: JSON.stringify(b.messages).length })
    }
  }
  // keeper input sizes as token proxy (chars/4)
  const keeperRefreshCost = keeperCalls.map(w => ({ time: w.time, maxTokens: w.maxTokens, inputChars: JSON.stringify(w.messages ?? []).length, inputTokensEstimate: Math.ceil(JSON.stringify(w.messages ?? []).length / 4) }))

  const findings = {
    generatedAt: new Date().toISOString(),
    sid, model: state.model,
    turnsRun: d.turns.length,
    cycles,
    cycleCount: cycles.filter(c => c.successful).length,
    cycleAttempts: cycles.length,
    contextWindow: null, cost, probes, otherProbes, faithfulness, maybeJudge, summaryLayer,
    costSplit: { firstCutTurn, beforeCut: avg(beforeCut), afterCut: avg(afterCut) },
    pruner: { marker: PRUNE_MARKER, hits: prunedHits.length, samples: prunedHits.slice(0, 3), pairing },
    whiteboard: {
      injectedRequests: wires.filter(w => JSON.stringify(w).includes(WHITEBOARD_FACT.id)).length,
      totalRequests: wires.length,
      afterBoardTurn: (() => {
        const boardRec = state.history.find(h => h.label === 'board')
        if (boardRec === undefined) return null
        const boardTurn = d.turns.find(t => t.turn === boardRec.turn)
        const boardEndTime = events.find(e => e.seq === boardTurn?.endSeq)?.time
        if (boardEndTime === undefined) return null
        const after = wires.filter(w => w.time > boardEndTime)
        return { requestsAfter: after.length, carryingWhiteboard: after.filter(w => JSON.stringify(w).includes(WHITEBOARD_FACT.id)).length }
      })(),
    },
    keeper: { callCount: keeperCalls.length, escalatedPairs, refreshCost: keeperRefreshCost, compactionCallCost, logLines: keeperLinesFor(sid) },
    sessionWeight: (() => {
      const p = join(HOME, '.dsh/storages/dsh_fast.json')
      if (!existsSync(p)) return null
      try {
        const all = JSON.parse(readFileSync(p, 'utf8'))
        const entry = all.tables?.[sid] ?? all[sid]
        return entry?.samples?.at(-1)?.snapshot ?? null
      } catch { return null }
    })(),
    journal: journalLines(),
    invariants: {},
    wires: { count: wires.length },
  }
  writeJson(join(EVID, 'findings.json'), findings)
  log(`analyze: turns=${cost.length} cycles=${cycles.length} probes=${probes.length} briefs=${d.briefs.length} checkpoints=${d.checkpoints.length} wires=${wires.length} maybeJudge=${maybeJudge.length}`)
}

function checkFidelity(label, text, spanText, basedOn, maybeJudge) {
  const checks = []
  for (const f of FACTS) {
    const inSpan = spanText.includes(f.value) || f.correct.some(re => re.test(spanText))
    if (!inSpan) continue
    const kept = f.correct.some(re => re.test(text)) || text.includes(f.value)
    const wrong = !kept && f.contradict.some(re => re.test(text))
    checks.push({ fact: f.id, inSpan: true, kept, contradicted: wrong })
    if (wrong) maybeJudge.push({ fact: f.id, expected: f.value, answer: `[in ${label}] ` + text.slice(0, 400), note: 'brief/checkpoint states a different value than the span' })
  }
  // hallucination candidates: paths / identifiers in text not present anywhere in span
  const suspicious = []
  for (const m of text.matchAll(/(?:\/[\w.-]+){3,}|[A-Z]{2,}-[A-Z0-9]{4,}(?:-[A-Z0-9]+)?|\b\d{5}\b/g)) {
    const token = m[0]
    if (token.length < 6) continue
    if (spanText.includes(token)) continue
    if (token.includes('ctx-eval') || token.includes('deepseek') || token.includes('enpoi')) continue
    // Path-shaped only: an absolute concrete path or a token with a file suffix.
    // Slash-separated seq shorthand (67/206/367) and marker taxonomies (PORT/PATH)
    // are detector artifacts, not hallucinated content.
    if (!/^\/(home|tmp|var|opt|usr|etc|srv|mnt)\b/.test(token) && !/\.[a-z0-9]{1,6}$/i.test(token)) continue
    suspicious.push(token)
  }
  return { label, basedOn, chars: text.length, factsInSpan: checks.length, factsKept: checks.filter(c => c.kept).length, checks, hallucinationCandidates: [...new Set(suspicious)].slice(0, 8) }
}

function checkToolPairing(wires) {
  const seenCalls = new Set(); const orphanResults = []; let calls = 0; let results = 0
  for (const w of wires) {
    for (const m of w.messages ?? []) {
      const blocks = Array.isArray(m.content) ? m.content : []
      const sourceCallId = m.source?.callId
      if (m.role === 'tool' && sourceCallId !== undefined) {
        results++
        if (!seenCalls.has(sourceCallId)) orphanResults.push({ time: w.time, id: sourceCallId })
      }
      for (const b of blocks) {
        if (b.type === 'tool-call' && b.id !== undefined) { seenCalls.add(b.id); calls++ }
      }
    }
  }
  return { calls, results, orphanResults: orphanResults.slice(0, 10), orphanCount: orphanResults.length }
}

function keeperLinesFor(sid) {
  const path = join(LOGS, 'enpoi-keeper.log')
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n')
  return lines.filter(l => l.includes(sid)).slice(-200)
}

function journalLines() {
  try {
    const out = execFileSync('journalctl', ['--user', '-u', UNIT, '--no-pager', '-n', '4000'], { encoding: 'utf8' })
    return out.split('\n').filter(l => /maxOutputTokens at|quarantined|compaction|ContextWindow/.test(l)).slice(-100)
  } catch { return [] }
}

function phaseReport() {
  const findings = readJson(join(EVID, 'findings.json'))
  const mech = existsSync(join(EVID, 'mech.json')) ? readJson(join(EVID, 'mech.json')) : null
  const judge = existsSync(join(EVID, 'judge.json')) ? readJson(join(EVID, 'judge.json')) : null
  const L = []
  const p = (s = '') => L.push(s)
  p(`# Context compaction & recall eval — measured report`)
  p()
  p(`Session \`${findings.sid}\` (orchestrator preset, ${findings.model}); ${findings.turnsRun} turns run, ${findings.cycleCount} successful compaction cycles out of ${findings.cycleAttempts} attempts. Generated ${findings.generatedAt}.`)
  p()
  p(`## Cycles`)
  p()
  p('| # | seqs | shadowed tokens | summary model | note |')
  p('|---|---|---|---|---|')
  findings.cycles.forEach((c, i) => p(`| ${i + 1} | ${c.shadowed === null ? 'no summary' : `${c.shadowed.start}-${c.shadowed.end}`} | ${c.shadowedTokens ?? '-'} | ${c.summaryModel ?? '-'} | ${c.successful ? 'ok' : 'FAILED: ' + JSON.stringify(c.error).slice(0, 80)} |`))
  p()
  p(`## Recall probes (after each cycle)`)
  p()
  p('| probe turn | cycles done | recalled | omitted | contradicted | ambiguous |')
  p('|---|---|---|---|---|---|')
  for (const probe of findings.probes) {
    const r = probe.results
    p(`| ${probe.turn} | ${probe.cycle} | ${r.filter(x => x.verdict === 'recalled').length} | ${r.filter(x => x.verdict === 'omitted').length} | ${r.filter(x => x.verdict === 'contradicted').length} | ${r.filter(x => x.verdict === 'ambiguous').length} |`)
  }
  const judgedProbe = findings.judged ?? []
  if (judgedProbe.length > 0) {
    p('')
    p(`Judge verdicts on the id-blind probe (no deterministic match): ${judgedProbe.filter(x => x.judgeVerdict === 'contradicted').length} contradicted of ${judgedProbe.length}.`)
  }
  p()
  p('Per-fact matrix (verdict / present-in-surface at probe time):')
  p()
  p(`| fact | value | ${findings.probes.map(x => `turn ${x.turn}`).join(' | ')} |`)
  p(`|---|---|${findings.probes.map(() => '---').join('|')}|`)
  for (const f of FACTS) {
    const cells = findings.probes.map(probe => {
      const r = probe.results.find(x => x.id === f.id)
      const present = probe.presence[f.id] ? 'present' : 'absent'
      return `${r?.verdict ?? '-'} (${present})`
    })
    p(`| ${f.id} ${f.kind} | ${f.value.replace(/\|/g, '\\|')} | ${cells.join(' | ')} |`)
  }
  p()
  p('Other probes:')
  p()
  for (const o of findings.otherProbes ?? []) p(`- turn ${o.turn} ${o.kind}: verdict=${o.verdict} answer=${JSON.stringify(o.answer)} tools=${JSON.stringify(o.toolNames ?? [])}`)
  for (const probe of findings.probes) p(`- whiteboard slot in probe turn ${probe.turn}: ${probe.w1.verdict} (${JSON.stringify(probe.w1.answer)})`)
  p()
  p(`## Faithfulness (anchors vs the span each artifact summarises)`)
  p()
  p('| artifact | seq/basedOn | chars | facts in span | kept | lost |')
  p('|---|---|---|---|---|---|')
  for (const f of findings.faithfulness) p(`| ${f.label} | ${f.basedOn} | ${f.chars} | ${f.factsInSpan} | ${f.factsKept} | ${f.factsInSpan - f.factsKept} |`)
  const halluc = findings.faithfulness.flatMap(f => f.hallucinationCandidates.map(h => ({ label: f.label, token: h })))
  p()
  p(`Hallucination candidates (tokens in briefs absent from the summarised span): ${halluc.length}`)
  for (const h of halluc.slice(0, 12)) p(`- ${h.label}: \`${h.token}\``)
  if (judge !== undefined && judge !== null) {
    p()
    p(`## Judge pass (${judge.verdicts?.length ?? 0} items)`) 
    for (const j of judge.verdicts ?? []) p(`- ${j.fact}: judge=${j.judgeVerdict} expected=\`${j.expected}\` answer=\`${String(j.answer).slice(0, 160)}\``)
  }
  p()
  p(`## Cost`)
  p()
  p(`- tokens/turn before first cut: ${JSON.stringify(findings.costSplit.beforeCut)}`)
  p(`- tokens/turn after first cut: ${JSON.stringify(findings.costSplit.afterCut)}`)
  p(`- keeper calls (<=4096 out, 1 msg): ${findings.keeper.callCount}; escalated 2048->4096 pairs: ${findings.keeper.escalatedPairs.length}`)
  p(`- compaction summarizer calls: ${findings.keeper.compactionCallCost.length} (input estimate tokens: ${findings.keeper.compactionCallCost.map(c => c.inputTokensEstimate).join(', ')})`)
  p()
  p(`## Mechanical invariants`)
  p()
  if (mech !== null) {
    for (const g of mech.ghost) p(`- ghost-revert ${g.label}: ${g.ok ? 'PASS (no shadow ranges, all rows rendered)' : 'FAIL ' + JSON.stringify(g).slice(0, 200)}`)
    p(`- cache discipline (main-request pairs): ${mech.wirePrefix.mainPairs} pairs, ${mech.wirePrefix.mainPrefixBreaks} non-add-only prefix breaks, ${mech.wirePrefix.explainedBreaks} explained by a compaction/checkpoint boundary, ${mech.wirePrefix.unexplainedBreaks.length} unexplained`)
    for (const u of mech.wirePrefix.unexplainedBreaks ?? []) p(`  - unexplained break at ${new Date(u.time).toISOString()}: ${u.removed} messages removed, stable prefix ${u.stable}`)
    p(`- keeper failure-injection specs: ${mech.keeperSpecs.summary?.numPassedTests}/${mech.keeperSpecs.summary?.numTotalTests} passed; covers ${JSON.stringify((mech.keeperSpecs.summary?.matchedTests ?? []).slice(0, 20))}`)
    p(`- error audit: ${JSON.stringify(mech.errorAudit.totals ?? mech.errorAudit.byClass)}`)
  } else p('- mech.json missing')
  p()
  p(`## Wires: pruner + layers`)
  p()
  p(`- requests carrying the pruner marker: ${findings.pruner.hits}; tool-call/result pairs: ${findings.pruner.pairing.calls}/${findings.pruner.pairing.results}, orphan results: ${findings.pruner.pairing.orphanCount}`)
  for (const s of findings.summaryLayer) p(`- after compaction end seq ${s.endSeq}: compacted-summary present=${s.hasCompactedSummary}, state checkpoint present=${s.hasStateCheckpoint}`)
  p(`- whiteboard injected in ${findings.whiteboard.injectedRequests}/${findings.whiteboard.totalRequests} requests`)
  writeFileSync(join(EVID, 'report.md'), L.join('\n') + '\n')
  console.log(`report: ${L.length} lines -> ${join(EVID, 'report.md')}`)
}

function phaseStatus() {
  const state = existsSync(statePath()) ? readJson(statePath()) : null
  console.log(JSON.stringify(state, null, 2))
}

// ── cli ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { phase: 'status', maxTurns: 24, cycles: 3, model: DEFAULT_MODEL, sessionId: DEFAULT_SESSION, judgeSession: JUDGE_SESSION }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    const take = () => inline ?? argv[++i]
    switch (name) {
      case '--phase': opts.phase = take(); break
      case '--max-turns': opts.maxTurns = Number(take()); break
      case '--cycles': opts.cycles = Number(take()); break
      case '--model': opts.model = take(); break
      case '--session-id': opts.sessionId = take(); break
      case '--help': console.log('phases: setup load analyze mech judge status'); process.exit(0)
      default: throw new Error(`unknown arg ${arg}`)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
mkdirSync(EVID, { recursive: true })
if (opts.phase === 'setup') phaseSetup()
else if (opts.phase === 'load') await phaseLoad(opts)
else if (opts.phase === 'analyze') phaseAnalyze(opts)
else if (opts.phase === 'status') phaseStatus()
else if (opts.phase === 'report') phaseReport()
else if (opts.phase === 'mech') { const { phaseMech } = await import('./context-eval-mech.mjs'); await phaseMech(opts) }
else if (opts.phase === 'judge') { const { phaseJudge } = await import('./context-eval-judge.mjs'); await phaseJudge(opts) }
else throw new Error(`unknown phase ${opts.phase}`)
