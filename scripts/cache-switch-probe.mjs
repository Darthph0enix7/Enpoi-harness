#!/usr/bin/env node
/**
 * cache-switch-probe — turn "the agent switch is cache-neutral" into a number.
 *
 * Creates two scratch sessions on `--from` (default orchestrator). Each runs the
 * same two trivial prompts. The control arm never switches; the treatment arm
 * switches to `--to` (default sysadmin) between the turns via the real
 * `agentPresets.select` RPC, exactly as the UI does. For turn 2 the probe reports
 * the provider usage buckets — cacheReadTokens, cacheWriteTokens, uncached input,
 * output — computed as the delta of the `tokenUsage` session projection before vs
 * after that turn, plus the treatment-minus-control delta.
 *
 * A cache-neutral switch keeps treatment cacheRead within `--tolerance`
 * (default 10%) of control and does not balloon cacheWrite. A switch that changes
 * the tool array rebuilds the prefix: cacheRead collapses toward 0 and cacheWrite
 * approaches the full prompt size. The probe also compares the two turn-2 request
 * captures (`system.sha256`, `tools`) so a measured result can be attributed to an
 * identical or changed surface.
 *
 * Usage:
 *   node scripts/cache-switch-probe.mjs                        # live, localhost dsh web
 *   node scripts/cache-switch-probe.mjs --from=orchestrator --to=sysadmin
 *   node scripts/cache-switch-probe.mjs --json                 # machine-readable report
 *   node scripts/cache-switch-probe.mjs --keep                 # keep both sessions
 *   node scripts/cache-switch-probe.mjs --model=opencode-go/deepseek-v4.1-flash
 *   node scripts/cache-switch-probe.mjs --self-test            # offline harness proof, no host
 *
 * Auth: mints the launch cookie from `journalctl --user -u dsh-web.service`
 * (same exchange as scripts/preset-tool-inventory.mjs); pass `--token=<value>`
 * when journal access is unavailable.
 *
 * Exit: 0 cache-neutral, 1 rebuild/partial/inconclusive (the number is printed),
 *       2 harness error.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const flag = name => process.argv.includes(`--${name}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const ORIGIN = arg('origin', process.env.DSH_ORIGIN ?? 'http://127.0.0.1:3080').replace(/\/+$/u, '')
const UNIT = arg('unit', 'dsh-web.service')
const FROM = arg('from', 'orchestrator')
const TO = arg('to', 'sysadmin')
const CWD = arg('cwd', join(tmpdir(), 'dsh-cache-probe'))
const TIMEOUT_MS = Number(arg('timeout-ms', '180000'))
const TOLERANCE = Number(arg('tolerance', '0.1'))
const MODEL = arg('model', undefined)
const TOKEN = arg('token', undefined)
const KEEP = flag('keep')
const JSON_OUT = flag('json')
const SELF_TEST = flag('self-test')

const PROMPT_1 = 'Reply with exactly OK. Do not call any tool.'
const PROMPT_2 = 'Reply with exactly OK again. Do not call any tool.'
const ZERO = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

function mintCookieSync() {
  if (TOKEN !== undefined) return undefined
  try {
    const journal = execFileSync('journalctl', ['--user', '-u', UNIT, '--no-pager', '-n', '2000'], { encoding: 'utf8' })
    return journal.match(/http:\/\/[^\s"]+\?token=[A-Za-z0-9_-]+/gu)?.at(-1)
  } catch (error) {
    throw new Error(`journalctl could not read ${UNIT}: ${String(error)} — pass --token instead`)
  }
}

async function exchange(tokenUrl) {
  const response = await fetch(tokenUrl, { redirect: 'manual' })
  if (response.status !== 303) throw new Error(`token exchange failed with HTTP ${String(response.status)}`)
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  const cookie = setCookies[0]?.split(';', 1)[0]
  if (!cookie?.startsWith('dsh-auth-')) throw new Error('token exchange returned no dsh-auth cookie')
  return cookie
}

/** One unary client-request RPC against the live web host. */
async function liveRpc(method, args, cookie, timeoutMs = 30_000) {
  const response = await fetch(`${ORIGIN}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const frame = JSON.parse(await response.text())
  if (frame?.result?.ok !== true) {
    throw new Error(`${method} failed: ${frame?.result?.error?.code ?? 'gateway/error'} ${frame?.result?.error?.message ?? ''}`)
  }
  return frame.result.value
}

const subtract = (after, before) => ({
  uncachedInputTokens: after.uncachedInputTokens - before.uncachedInputTokens,
  outputTokens: after.outputTokens - before.outputTokens,
  cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
  cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
})

async function promptTurn(client, sessionId, text) {
  await client.rpc('session.prompt', {
    request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
  })
}

/** Wait until the expected turn has committed a terminal and the session is idle again. */
async function waitForTurn(client, sessionId, expectedTurn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await client.rpc('session.executionState', { request: { sessionId } })
    const terminal = state?.lastTurnEnd
    if (terminal !== undefined && terminal.turn >= expectedTurn && state.latch === 'idle') {
      return { turn: terminal.turn, terminal }
    }
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} did not finish turn ${String(expectedTurn)} within ${String(timeoutMs)}ms (latch=${String(state?.latch)})`)
    }
    await sleep(500)
  }
}

/**
 * Cumulative usage buckets. Primary source: the `tokenUsage` projection view
 * (totals of provider-reported usage). Fallback: fold `assistant/message` usage
 * from the durable log up to the projection watermark.
 */
async function usageTotals(client, sessionId) {
  const baseline = await client.rpc('session.projections', { request: { sessionId } })
  const token = baseline?.values?.tokenUsage
  if (token !== undefined && typeof token.cacheReadTokens === 'number') {
    return { source: 'tokenUsage', buckets: { ...ZERO, ...token } }
  }
  const throughSeq = baseline?.asOfSeq
  if (typeof throughSeq !== 'number' || throughSeq < 0) throw new Error(`no projections baseline for ${sessionId} (tokenUsage projection absent)`)
  const page = await client.rpc('session.page', {
    request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 1000 },
  })
  const buckets = { ...ZERO }
  for (const record of page?.records ?? []) {
    const event = record?.event
    if (event?.type !== 'assistant/message' || event.data?.usage === undefined) continue
    const usage = event.data.usage
    buckets.uncachedInputTokens += usage.inputTokens ?? 0
    buckets.outputTokens += usage.outputTokens ?? 0
    buckets.cacheReadTokens += usage.cacheReadTokens ?? 0
    buckets.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  }
  return { source: 'page-fold', buckets }
}

/** One arm: two turns, an optional switch between them, and the turn-2 deltas. */
async function runArm(client, opts, switchTo) {
  const created = await client.rpc('session.create', { request: { cwd: opts.cwd, agentPreset: opts.from } })
  const sessionId = created.sessionId
  const arm = { arm: switchTo === null ? 'control' : 'treatment', sessionId, switchedTo: switchTo ?? null }
  try {
    if (opts.model !== undefined) {
      const slash = opts.model.indexOf('/')
      await client.rpc('session.selectModel', {
        request: { sessionId, provider: opts.model.slice(0, slash), model: opts.model.slice(slash + 1), persistDefault: false },
      })
    }
    const before = await client.rpc('session.executionState', { request: { sessionId } })
    await promptTurn(client, sessionId, opts.prompt1)
    const turn1 = await waitForTurn(client, sessionId, (before?.lastTurnEnd?.turn ?? 0) + 1, opts.timeoutMs)
    if (turn1.terminal.reason !== 'completed') throw new Error(`turn 1 ended ${String(turn1.terminal.reason)}: ${JSON.stringify(turn1.terminal.error ?? {})}`)
    const afterTurn1 = await usageTotals(client, sessionId)

    if (switchTo !== null) {
      const selected = await client.rpc('agentPresets.select', { agentId: sessionId, agentPreset: switchTo })
      arm.switchResult = selected
      if (selected !== switchTo) throw new Error(`switch returned ${JSON.stringify(selected)}, expected ${JSON.stringify(switchTo)}`)
    }

    await promptTurn(client, sessionId, opts.prompt2)
    const turn2 = await waitForTurn(client, sessionId, turn1.turn + 1, opts.timeoutMs)
    if (turn2.terminal.reason !== 'completed') throw new Error(`turn 2 ended ${String(turn2.terminal.reason)}: ${JSON.stringify(turn2.terminal.error ?? {})}`)
    const afterTurn2 = await usageTotals(client, sessionId)

    arm.turn2Usage = subtract(afterTurn2.buckets, afterTurn1.buckets)
    arm.usageSource = afterTurn2.source === afterTurn1.source ? afterTurn2.source : `${afterTurn1.source}->${afterTurn2.source}`
    arm.turn2Capture = await client.rpc('session.requestSnapshot', { request: { sessionId } }).catch(() => null)
    return arm
  } finally {
    if (!opts.keep) {
      await client.rpc('session.cancel', { request: { sessionId } }).catch(() => {})
      await client.rpc('session.delete', { request: { sessionId } }).catch(() => {})
    }
  }
}

function compare(a, b) {
  const c = a.turn2Usage
  const t = b.turn2Usage
  const readRatio = c.cacheReadTokens > 0 ? t.cacheReadTokens / c.cacheReadTokens : null
  let verdict
  if (c.cacheReadTokens <= 0) verdict = 'inconclusive-no-control-cache'
  else if (t.cacheReadTokens <= 0 && t.cacheWriteTokens >= c.cacheWriteTokens + Math.round(0.5 * c.cacheReadTokens)) verdict = 'rebuild'
  else if (readRatio !== null && readRatio >= 1 - TOLERANCE) verdict = 'cache-neutral'
  else verdict = 'partial-rebuild'
  const toolsA = Array.isArray(a.turn2Capture?.tools) ? a.turn2Capture.tools : null
  const toolsB = Array.isArray(b.turn2Capture?.tools) ? b.turn2Capture.tools : null
  return {
    delta: subtract(t, c),
    readRatio,
    verdict,
    exitCode: verdict === 'cache-neutral' ? 0 : 1,
    prefix: {
      systemShaEqual: a.turn2Capture?.system?.sha256 !== undefined && a.turn2Capture.system.sha256 === b.turn2Capture?.system?.sha256,
      toolsEqual: toolsA !== null && toolsB !== null && toolsA.length === toolsB.length && toolsA.every((name, index) => name === toolsB[index]),
      controlTools: toolsA?.length ?? null,
      treatmentTools: toolsB?.length ?? null,
    },
  }
}

async function runProbe(client, opts) {
  const control = await runArm(client, opts, null)
  const treatment = await runArm(client, opts, opts.to)
  return { from: opts.from, to: opts.to, control, treatment, ...compare(control, treatment) }
}

function reportHuman(report) {
  const fmt = buckets => `cacheRead=${String(buckets.cacheReadTokens)} cacheWrite=${String(buckets.cacheWriteTokens)} uncached=${String(buckets.uncachedInputTokens)} output=${String(buckets.outputTokens)}`
  const lines = [
    `cache-switch-probe · ${report.from} → ${report.to} · tolerance ${String(Math.round(TOLERANCE * 100))}%`,
    `control   (no switch)  ${report.control.sessionId}  turn2 ${fmt(report.control.turn2Usage)} [${String(report.control.usageSource)}]`,
    `treatment (switched)   ${report.treatment.sessionId}  turn2 ${fmt(report.treatment.turn2Usage)} [${String(report.treatment.usageSource)}]`,
    `delta treatment-control  cacheRead ${String(report.delta.cacheReadTokens)}${report.readRatio === null ? '' : ` (ratio ${report.readRatio.toFixed(3)})`}  cacheWrite ${String(report.delta.cacheWriteTokens)}  uncached ${String(report.delta.uncachedInputTokens)}`,
    `prefix  system sha equal=${String(report.prefix.systemShaEqual)} · tools equal=${String(report.prefix.toolsEqual)} (${String(report.prefix.controlTools ?? '?')}/${String(report.prefix.treatmentTools ?? '?')})`,
    `verdict: ${report.verdict.toUpperCase()}`,
  ]
  return lines.join('\n')
}

// ── offline harness proof: no host, no model, no network ─────────────────────

function fakeClient(scenario) {
  const sessions = new Map()
  let created = 0
  const state = id => sessions.get(id)
  return {
    rpc: async (method, args) => {
      switch (method) {
        case 'session.create': {
          const sessionId = `session-fake-${String(++created)}`
          sessions.set(sessionId, { arm: created === 1 ? 'control' : 'treatment', turn: 0, totals: undefined, switched: false })
          return { sessionId }
        }
        case 'session.prompt': {
          const session = state(args.request.sessionId)
          session.turn += 1
          session.totals = session.turn === 1
            ? { ...scenario.turn1 }
            : addBuckets(session.totals, scenario.turn2(session.arm))
          return { accepted: true }
        }
        case 'session.executionState': {
          const session = state(args.request.sessionId)
          return {
            latch: 'idle',
            since: 0,
            source: 'host-latch',
            activeDescendants: 0,
            descendantsExact: true,
            pendingAsks: [],
            ...session.turn === 0 ? {} : { lastTurnEnd: { turn: session.turn, reason: 'completed', at: 0 } },
          }
        }
        case 'session.projections': {
          const session = state(args.request.sessionId)
          return { asOfSeq: session.turn, values: { tokenUsage: session.totals ?? { ...ZERO } } }
        }
        case 'session.requestSnapshot':
          return { capturedAt: 0, sessionId: args.request.sessionId, provider: 'fake', model: 'fake', system: { chars: 1, sha256: scenario.sha }, tools: scenario.tools, messages: [], bodiesIncluded: false }
        case 'agentPresets.select': {
          state(args.agentId).switched = true
          return args.agentPreset
        }
        case 'session.cancel':
        case 'session.delete':
        case 'session.selectModel':
          return {}
        default:
          throw new Error(`self-test: unexpected RPC ${method}`)
      }
    },
  }
}

const addBuckets = (left, right) => ({
  uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
})

function assert(condition, message) {
  if (!condition) throw new Error(`self-test failed: ${message}`)
}

async function selfTest() {
  const opts = { from: FROM, to: TO, prompt1: PROMPT_1, prompt2: PROMPT_2, cwd: '/tmp/self-test', timeoutMs: 5_000, keep: true, model: undefined, origin: 'self-test' }
  const tools = ['read', 'write']
  const game = turn2 => ({
    turn1: { uncachedInputTokens: 120, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 4000 },
    turn2,
    tools,
    sha: 'sha-of-identical-surface',
  })
  const neutral = game(arm => arm === 'control'
    ? { uncachedInputTokens: 4, outputTokens: 2, cacheReadTokens: 3930, cacheWriteTokens: 75 }
    : { uncachedInputTokens: 5, outputTokens: 2, cacheReadTokens: 3910, cacheWriteTokens: 90 })
  const hostile = game(arm => arm === 'control'
    ? { uncachedInputTokens: 4, outputTokens: 2, cacheReadTokens: 3930, cacheWriteTokens: 75 }
    : { uncachedInputTokens: 4100, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 4050 })
  const neutralReport = await runProbe(fakeClient(neutral), opts)
  const hostileReport = await runProbe(fakeClient(hostile), opts)
  assert(neutralReport.verdict === 'cache-neutral', `neutral scenario verdict ${neutralReport.verdict}`)
  assert(hostileReport.verdict === 'rebuild', `hostile scenario verdict ${hostileReport.verdict}`)
  assert(neutralReport.treatment.turn2Usage.cacheReadTokens === 3910, 'neutral treatment delta math')
  assert(neutralReport.delta.cacheReadTokens === -20, 'neutral read delta math')
  assert(neutralReport.prefix.systemShaEqual && neutralReport.prefix.toolsEqual, 'neutral prefix equality')
  assert(neutralReport.exitCode === 0 && hostileReport.exitCode === 1, 'exit codes')
  process.stdout.write('cache-switch-probe self-test OK: neutral → cache-neutral (0), hostile → rebuild (1); deltas and prefix comparison verified offline\n')
}

async function main() {
  if (SELF_TEST) {
    await selfTest()
    return
  }
  const tokenUrl = TOKEN === undefined
    ? mintCookieSync()
    : `${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`
  const cookie = await exchange(tokenUrl)
  const client = { rpc: (method, args, timeoutMs) => liveRpc(method, args, cookie, timeoutMs) }
  const opts = { from: FROM, to: TO, prompt1: PROMPT_1, prompt2: PROMPT_2, cwd: CWD, timeoutMs: TIMEOUT_MS, keep: KEEP, model: MODEL, origin: ORIGIN }
  const report = await runProbe(client, opts)
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`${reportHuman(report)}\n`)
  if (process.env.DSH_CACHE_PROBE_OUT !== undefined) writeFileSync(process.env.DSH_CACHE_PROBE_OUT, `${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = report.exitCode
}

main().catch((error) => {
  process.stderr.write(`[cache-switch-probe] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
})
