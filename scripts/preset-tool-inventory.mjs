#!/usr/bin/env node
/**
 * Per-preset tool inventory diff: one snapshot of each Enpoi preset's wire Tool
 * list per run, diffed against the committed expected set.
 *
 * Why: a merge or composition change can silently add (the 0.1.7 `run_code`
 * surprise), drop, or rename a model-facing Tool on a preset surface. The tool
 * list the model actually receives is only observable through the wire capture,
 * so this probe promotes the tiny live turn to an explicit fixture diff.
 *
 * Method: for each preset it `session.create`s a scratch session, sends one
 * throwaway prompt, polls `session.requestSnapshot` until the capture exists,
 * reads the summary's `tools` names, cancels the turn, and deletes the session
 * (unless `--keep`). One model call per preset; nothing is written outside the
 * scratch cwd.
 *
 * Fixtures: `scripts/tool-inventory/expected-<preset>.json` (sorted names).
 * Update them intentionally with `--update` after reviewing the printed diff —
 * a diff on every sync is the point, so never regenerate blindly.
 *
 * Usage: node scripts/preset-tool-inventory.mjs [options]
 *   --origin=<url>       dsh web origin (default http://127.0.0.1:3080)
 *   --token=<launch>     process launch token; without it the script mints the
 *                        auth cookie from `journalctl --user -u dsh-web.service`
 *   --unit=<name>        systemd user unit to read the token from
 *   --presets=a,b,c      presets to survey (default orchestrator,sysadmin,creator)
 *   --cwd=<dir>          scratch workspace for created sessions
 *   --timeout-ms=<n>     per-preset snapshot wait (default 90000)
 *   --keep               keep the scratch sessions instead of deleting them
 *   --update             write the observed lists to the fixtures
 *   --print              print the observed lists even when they match
 *   --json               machine-readable result on stdout
 * Exit: 0 pass, 1 diff found, 2 harness error.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(SCRIPT_DIR, 'tool-inventory')
const DEFAULT_PRESETS = ['orchestrator', 'sysadmin', 'creator']

function arg(name, fallback) {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const ORIGIN = arg('origin', process.env.DSH_ORIGIN ?? 'http://127.0.0.1:3080').replace(/\/+$/u, '')
const UNIT = arg('unit', 'dsh-web.service')
const PRESETS = arg('presets', DEFAULT_PRESETS.join(',')).split(',').map(value => value.trim()).filter(Boolean)
const CWD = arg('cwd', join(tmpdir(), 'dsh-tool-inventory'))
const TIMEOUT_MS = Number(arg('timeout-ms', '90000'))
const KEEP = process.argv.includes('--keep')
const UPDATE = process.argv.includes('--update')
const PRINT = process.argv.includes('--print')
const JSON_OUT = process.argv.includes('--json')
const TOKEN = arg('token', undefined)

let COOKIE = ''

/** Exchange a launch token for the signed browser cookie. */
async function mintCookie() {
  if (TOKEN !== undefined) {
    const response = await fetch(`${ORIGIN}/?token=${encodeURIComponent(TOKEN)}`, { redirect: 'manual' })
    if (response.status !== 303) throw new Error(`token exchange failed with HTTP ${String(response.status)}`)
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? '']
    const cookie = setCookies[0]?.split(';', 1)[0]
    if (!cookie?.startsWith('dsh-auth-')) throw new Error('token exchange returned no dsh-auth cookie')
    COOKIE = cookie
    return
  }
  let journal = ''
  try {
    journal = execFileSync('journalctl', ['--user', '-u', UNIT, '--no-pager', '-n', '2000'], { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`journalctl could not read ${UNIT}: ${String(error)} — pass --token instead`)
  }
  const tokenUrl = journal.match(/http:\/\/[^\s"]+\?token=[A-Za-z0-9_-]+/gu)?.at(-1)
  if (tokenUrl === undefined) throw new Error(`no launch token URL in ${UNIT} journal — pass --token instead`)
  const response = await fetch(tokenUrl, { redirect: 'manual' })
  if (response.status !== 303) throw new Error(`token exchange failed with HTTP ${String(response.status)}`)
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? '']
  const cookie = setCookies[0]?.split(';', 1)[0]
  if (!cookie?.startsWith('dsh-auth-')) throw new Error('token exchange returned no dsh-auth cookie')
  COOKIE = cookie
}

/** One unary client-request RPC; throws the gateway code on failure. */
async function rpc(method, args, timeoutMs = 30_000) {
  const response = await fetch(`${ORIGIN}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    throw new Error(`${method} returned non-JSON (HTTP ${String(response.status)})`)
  }
  if (frame?.result?.ok !== true) {
    throw new Error(`${method} failed: ${frame?.result?.error?.code ?? 'gateway/error'} ${frame?.result?.error?.message ?? ''}`)
  }
  return frame.result.value
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Create, prompt, snapshot, and (unless kept) delete one scratch session. */
async function surveyPreset(preset) {
  const created = await rpc('session.create', { request: { cwd: CWD, agentPreset: preset } })
  const sessionId = created.sessionId
  let tools
  try {
    await rpc('session.prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'Reply with exactly OK. Do not call any tool.' }],
      },
    })
    const deadline = Date.now() + TIMEOUT_MS
    for (;;) {
      try {
        const snapshot = await rpc('session.requestSnapshot', { request: { sessionId } })
        const names = Array.isArray(snapshot?.tools)
          ? snapshot.tools.filter(value => typeof value === 'string').sort()
          : undefined
        if (names !== undefined) {
          tools = names
          break
        }
      } catch (error) {
        // The capture lands with the first model request; `session/not-found`
        // is the documented not-yet state. Anything else is a real failure.
        if (!String(error).includes('session/not-found')) throw error
      }
      if (Date.now() > deadline) throw new Error(`no request capture for preset "${preset}" within ${String(TIMEOUT_MS)}ms`)
      await sleep(500)
    }
  } finally {
    await rpc('session.cancel', { request: { sessionId } }).catch(() => {})
    if (!KEEP) await rpc('session.delete', { request: { sessionId } }).catch(() => {})
  }
  return tools
}

function fixturePath(preset) {
  return join(FIXTURE_DIR, `expected-${preset}.json`)
}

function readExpected(preset) {
  try {
    const parsed = JSON.parse(readFileSync(fixturePath(preset), 'utf8'))
    return Array.isArray(parsed.tools) ? parsed.tools : undefined
  } catch {
    return undefined
  }
}

function writeExpected(preset, tools) {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(fixturePath(preset), `${JSON.stringify({ preset, tools }, null, 2)}\n`)
}

/** Explicit missing/extra rows so a stray Tool cannot hide in a count. */
function diffRows(expected, actual) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = expected.filter(name => !actualSet.has(name))
  const extra = actual.filter(name => !expectedSet.has(name))
  return { missing, extra }
}

async function main() {
  mkdirSync(CWD, { recursive: true })
  await mintCookie()
  const results = []
  let failed = false
  for (const preset of PRESETS) {
    const tools = await surveyPreset(preset)
    const expected = readExpected(preset)
    if (expected === undefined) {
      writeExpected(preset, tools)
      results.push({ preset, status: 'seeded', tools })
      if (!JSON_OUT) process.stdout.write(`[inventory] ${preset}: seeded fixture with ${String(tools.length)} tools\n`)
      continue
    }
    const { missing, extra } = diffRows(expected, tools)
    const status = missing.length === 0 && extra.length === 0 ? 'match' : 'diff'
    if (status === 'diff') failed = true
    results.push({ preset, status, tools, missing, extra })
    if (!JSON_OUT) {
      process.stdout.write(`[inventory] ${preset}: ${status.toUpperCase()} (${String(tools.length)} tools)\n`)
      for (const name of missing) process.stdout.write(`  - missing: ${name}\n`)
      for (const name of extra) process.stdout.write(`  + extra:   ${name}\n`)
      if (status === 'match' && PRINT) for (const name of tools) process.stdout.write(`  = ${name}\n`)
    }
    if (UPDATE && status === 'diff') {
      writeExpected(preset, tools)
      if (!JSON_OUT) process.stdout.write(`[inventory] ${preset}: fixture updated intentionally\n`)
      failed = false
    }
  }
  if (UPDATE && results.some(result => result.status === 'diff')) failed = false
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  process.stderr.write(`[inventory] harness error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
})
