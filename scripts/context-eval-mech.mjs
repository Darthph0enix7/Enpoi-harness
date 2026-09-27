#!/usr/bin/env node
/**
 * context-eval-mech.mjs — mechanical invariant probes for the doc 66 context eval.
 *
 *  1. ghost-revert probe: the transcript is never hidden by compaction
 *     (run on the live log and on a decompressed prefix ending at every
 *     successful compaction/end, so the guarantee is checked per cycle).
 *  2. cache discipline: consecutive wire requests must be add-only except at a
 *     compaction boundary.
 *  3. keeper failure-injection specs (empty output failover + route quarantine
 *     + output-cap escalation) run as the package's own vitest suites.
 *  4. error-audit scoped to the eval session (wasted-call classes).
 *  5. session promptability: every driver turn in state.history ended in a
 *     terminal turn/end.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const EVID = join(HOME, 'dsh-migration/evidence/context-eval')
const GHOST = join(HOME, 'dsh-migration/evidence/ghost-revert/ghost-revert-probe.mjs')
const F = '/home/adam/deepseek-harness'
const P = '/home/adam/.dsh/profiles/web'
const LOGS = join(HOME, '.dsh/logs')
const SESSIONS = join(HOME, '.dsh/sessions')

const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n')

function findSessionLog(sid) {
  for (const root of [SESSIONS]) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(root, entry.name, sid, 'session.v4.jsonl.zstd')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function readEvents(logPath) {
  const res = spawnSync('zstd', ['-dc', logPath], { maxBuffer: 512 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`zstd failed: ${String(res.stderr).slice(0, 200)}`)
  return res.stdout.toString('utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
}

function ghostProbe(path, label) {
  const res = spawnSync('timeout', ['180', process.execPath, GHOST, path, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let parsed = null
  try { parsed = JSON.parse(res.stdout) } catch {}
  const out = parsed === null
    ? { label, ok: false, error: String(res.stderr).slice(-400) }
    : {
        label,
        ok: parsed.foldState.shadowRanges.length === 0
          && parsed.before.renderedMessageRows === parsed.before.totalMessageRows
          && parsed.after.renderedMessageRows === parsed.after.totalMessageRows,
        foldEngine: parsed.foldEngine,
        shadowRanges: parsed.foldState.shadowRanges,
        before: { renderedMessages: parsed.before.renderedMessageRows, totalMessages: parsed.before.totalMessageRows, lastVisibleSeq: parsed.before.lastVisibleSeq },
        afterSyntheticKeeperReplace: { renderedMessages: parsed.after.renderedMessageRows, totalMessages: parsed.after.totalMessageRows, shadowRange: parsed.syntheticStep?.shadowRange ?? null },
      }
  return out
}

function wirePrefixCheck(sid, sinceMs, events) {
  const wires = []
  for (const name of readdirSync(LOGS)) {
    if (!name.startsWith('wire-') || !name.endsWith('.json')) continue
    const path = join(LOGS, name)
    try {
      if (statSync(path).mtimeMs < sinceMs) continue
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed.sessionId === sid) wires.push(parsed)
    } catch {}
  }
  wires.sort((a, b) => a.time - b.time)
  // Main-session requests only (keeper/claims calls are single-message and do
  // not share the conversation prefix; interleaving them is not a cache fact).
  const isCompactionReplay = (w) => JSON.stringify(w.messages ?? []).includes('acting as a compaction engine')
  const main = wires.filter(w => (w.messages ?? []).length >= 5 && !isCompactionReplay(w))
  // A keeper checkpoint commit lands a few ms after its LLM call, and provider
  // retries replay the same request; allow a 3 s attribution window.
  const boundaryBetween = (t0, t1) => events.some(e => e.time > t0 - 3_000 && e.time <= t1 + 3_000
    && (e.type === 'compaction/end' || e.type === 'state/checkpoint' || e.type === 'compaction/prune'))
  const rows = []
  for (let i = 1; i < main.length; i++) {
    const prev = main[i - 1].messages ?? []
    const cur = main[i].messages ?? []
    let stable = 0
    while (stable < prev.length && stable < cur.length && JSON.stringify(prev[stable]) === JSON.stringify(cur[stable])) stable++
    const removed = prev.length - stable
    // A tool-group attach revises the system-prompt section: message 0 changes,
    // everything after it stays add-only.
    let systemRev = false
    if (removed === 1 && stable === 0) {
      let s2 = 1
      while (s2 > 0 && s2 < prev.length - 1 && s2 < cur.length - 1
        && JSON.stringify(prev[s2]) === JSON.stringify(cur[s2])) s2++
      systemRev = s2 >= prev.length - 1
    }
    rows.push({
      time: main[i].time,
      prevLen: prev.length, curLen: cur.length, stablePrefixMessages: stable,
      added: cur.length - stable, removed,
      systemRev,
      explainedByBoundary: removed > 0 ? (systemRev || boundaryBetween(main[i - 1].time, main[i].time)) : null,
    })
  }
  const breaks = rows.filter(r => r.removed > 0)
  return {
    mainPairs: rows.length, mainPrefixBreaks: breaks.length,
    explainedBreaks: breaks.filter(r => r.explainedByBoundary === true).length,
    systemRevBreaks: breaks.filter(r => r.systemRev === true).length,
    unexplainedBreaks: breaks.filter(r => r.explainedByBoundary === false).map(r => ({ time: r.time, removed: r.removed, stable: r.stablePrefixMessages })),
    samples: breaks.slice(0, 8),
  }
}

function keeperSpecs() {
  const vitest = join(P, 'node_modules/.bin/vitest')
  if (!existsSync(vitest)) return { ok: false, error: 'vitest binary missing' }
  const specs = [
    'packages/enpoi-context-keeper/tests/keeper-prose-rejection.spec.ts',
    'packages/enpoi-context-keeper/tests/keeper-chains.spec.ts',
    'packages/enpoi-context-keeper/tests/keeper-checkpoint.spec.ts',
  ].filter(s => existsSync(join(P, s)))
  const outFile = join(EVID, 'mech-keeper-specs.json')
  const res = spawnSync('timeout', ['420', vitest, 'run', ...specs, '--reporter=json', `--outputFile=${outFile}`], {
    cwd: P, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  })
  let summary = null
  if (existsSync(outFile)) {
    try {
      const parsed = JSON.parse(readFileSync(outFile, 'utf8'))
      summary = {
        numTotalTests: parsed.numTotalTests, numPassedTests: parsed.numPassedTests,
        numFailedTests: parsed.numFailedTests, success: parsed.success,
        failed: (parsed.testResults ?? []).flatMap(r => (r.assertionResults ?? []).filter(a => a.status === 'failed').map(a => `${a.ancestorTitles?.join(' > ')} > ${a.title}`)),
        matchedTests: (parsed.testResults ?? []).flatMap(r => (r.assertionResults ?? []).map(a => a.title)).filter(Boolean).slice(0, 40),
      }
    } catch {}
  }
  return { ok: res.status === 0 && summary?.success === true, exit: res.status, stderrTail: String(res.stderr).slice(-300), specs, summary }
}

function errorAudit(logPath) {
  const res = spawnSync('timeout', ['300', process.execPath, join(F, 'scripts/error-audit.mjs'), '--session', logPath, '--no-comms', '--no-adam', '--no-journals', '--json-only'], {
    cwd: F, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  })
  let parsed = null
  try { parsed = JSON.parse(res.stdout) } catch {}
  if (parsed === null) return { exit: res.status, stderrTail: String(res.stderr).slice(-400), stdoutTail: String(res.stdout).slice(-400) }
  const signals = parsed.signals ?? parsed.report?.signals ?? []
  const byClass = {}
  for (const s of signals) byClass[s.class] = (byClass[s.class] ?? 0) + 1
  return { exit: res.status, totals: parsed.totals ?? parsed.report?.totals ?? null, byClass, sample: signals.slice(0, 8) }
}

export async function phaseMech(opts) {
  mkdirSync(EVID, { recursive: true })
  const statePath = join(EVID, 'state.json')
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null
  const sid = opts?.sessionId ?? state?.sid ?? 'ctx-eval-long-a'
  const startedAt = state?.startedAt ?? 0
  const logPath = findSessionLog(sid)
  if (logPath === null) throw new Error(`session log not found for ${sid}`)
  const events = readEvents(logPath)

  // per-compaction-end prefixes (decompressed JSONL) for the ghost probe
  const prefixDir = join(EVID, 'raw', 'prefixes')
  mkdirSync(prefixDir, { recursive: true })
  const ghost = []
  ghost.push(ghostProbe(logPath, 'live-final'))
  const ends = events.filter(e => e.type === 'compaction/end' && (e.data?.error === undefined))
  for (const end of ends) {
    const prefix = events.filter(e => (e.seq ?? -1) <= end.seq)
    const file = join(prefixDir, `prefix-through-compaction-${end.data.compactionId}-seq${end.seq}.jsonl`)
    writeFileSync(file, prefix.map(e => JSON.stringify(e)).join('\n') + '\n')
    ghost.push(ghostProbe(file, `through-compaction-end-seq${end.seq}`))
  }

  const sessionWires = wirePrefixCheck(sid, startedAt - 60_000, events)
  const specs = keeperSpecs()
  const audit = errorAudit(logPath)
  const promptability = (state?.history ?? []).map(h => ({ turn: h.turn, label: h.label, terminal: h.terminal, driverExit: h.driverExit, wallMs: h.wallMs }))

  const result = { generatedAt: new Date().toISOString(), sid, ghost, wirePrefix: sessionWires, keeperSpecs: specs, errorAudit: audit, promptability }
  writeJson(join(EVID, 'mech.json'), result)
  console.log(JSON.stringify({
    ghost: ghost.map(g => ({ label: g.label, ok: g.ok, shadowRanges: g.shadowRanges?.length ?? g.error })),
    wirePrefixBreaks: sessionWires.mainPrefixBreaks,
    wirePrefixBreaksExplained: sessionWires.explainedBreaks,
    keeperSpecs: specs.summary,
    errorAudit: audit.totals ?? audit.exit,
    promptabilityAllTerminal: promptability.every(p => p.terminal),
  }, null, 2))
}
