#!/usr/bin/env node
/**
 * context-eval-judge.mjs — the judge pass for findings that deterministic
 * checks could not decide. Drives a separate `ctx-eval-judge-a` session
 * (opencode-go/deepseek-v4.1-flash) through the official Remote surface with a
 * strict per-item rubric, parses its JSON verdict lines, and merges them into
 * findings.json (items keep `judged: true` so the report can attribute them).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const EVID = join(HOME, 'dsh-migration/evidence/context-eval')
const DRIVER = '/home/adam/deepseek-harness/scripts/dsh-e2e-drive.mjs'
const SERVER = 'http://127.0.0.1:3080'
const UNIT = 'dsh-web.service'
const JUDGE_SESSION = 'ctx-eval-judge-a'
const JUDGE_MODEL = 'opencode-go/deepseek-v4.1-flash'

const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n')

function findSessionLog(sid) {
  const root = join(HOME, '.dsh/sessions')
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sid, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return null
}

function readAssistantTexts(sid) {
  const logPath = findSessionLog(sid)
  if (logPath === null) return []
  const res = spawnSync('zstd', ['-dc', logPath], { maxBuffer: 512 * 1024 * 1024 })
  const out = []
  for (const line of res.stdout.toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'assistant/message') {
        const text = (e.data?.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
        if (text.trim() !== '') out.push(text)
      }
    } catch {}
  }
  return out
}

function journalCookie() {
  const journal = execFileSync('journalctl', ['--user', '-u', UNIT, '--no-pager', '-n', '500'], { encoding: 'utf8' })
  const tokenUrl = journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9_-]+/g)?.at(-1)
  if (tokenUrl === undefined) throw new Error('no launch token in journal')
  return (async () => {
    const response = await fetch(new URL(tokenUrl), { redirect: 'manual' })
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? '']
    return cookies[0]?.split(';', 1)[0]
  })()
}

async function rpc(cookie, method, request) {
  const response = await fetch(`${SERVER}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: `${method.replace('/', '-')}-${randomUUID()}`, method, payload: { args: { request } } }),
    signal: AbortSignal.timeout(60_000),
  })
  const body = await response.json()
  if (body?.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body).slice(0, 300)}`)
  return body.result.value
}

export async function phaseJudge(opts) {
  mkdirSync(EVID, { recursive: true })
  const findingsPath = join(EVID, 'findings.json')
  if (!existsSync(findingsPath)) throw new Error('run --phase analyze first')
  const findings = JSON.parse(readFileSync(findingsPath, 'utf8'))
  const items = findings.maybeJudge ?? []
  if (items.length === 0) {
    writeJson(join(EVID, 'judge.json'), { items: [], note: 'nothing ambiguous' })
    console.log('judge: nothing to judge')
    return
  }
  const capped = items.slice(0, 40)
  const prompt = [
    'You are a strict grader for a context-fidelity evaluation. For each numbered item decide how the ANSWER relates to the EXPECTED value:',
    '- recalled: the answer states the expected value or an unambiguous paraphrase carrying the same content',
    '- contradicted: the answer states a different concrete value for the same slot (wrong number, wrong name, wrong path, wrong decision)',
    '- fabricated: the answer invents content presented as fact that never appeared in the source (e.g. a new identifier or value)',
    '- ambiguous: none of the above decisive',
    'Reply with one JSON object per item on its own line and NOTHING else: {"i":<n>,"verdict":"recalled|contradicted|fabricated|ambiguous"}',
    '',
    ...capped.map((it, idx) => `ITEM ${idx + 1}\nEXPECTED: ${it.expected}\nANSWER: ${String(it.answer).slice(0, 600)}\nCONTEXT: ${it.note ?? ''}`),
  ].join('\n')

  const outDir = join(EVID, 'judge')
  mkdirSync(outDir, { recursive: true })
  if (findSessionLog(JUDGE_SESSION) === null) {
    const cookie = await journalCookie()
    await rpc(cookie, 'session/create', { cwd: '/home/adam/ctx-eval/workspace', sessionId: JUDGE_SESSION, agentPreset: 'orchestrator' })
    await rpc(cookie, 'session/selectModel', { sessionId: JUDGE_SESSION, provider: JUDGE_MODEL.split('/')[0], model: JUDGE_MODEL.split('/').slice(1).join('/') })
  }
  const res = spawnSync('timeout', ['900', process.execPath, DRIVER,
    '--cwd', '/home/adam/ctx-eval/workspace', '--session-id', JUDGE_SESSION, '--task', prompt,
    '--out', outDir, '--url', SERVER, '--unit', UNIT, '--approve', 'once', '--answer-questions', 'auto',
    '--timeout', '840', '--cancel-after', '0'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  const texts = readAssistantTexts(JUDGE_SESSION)
  const answer = texts.at(-1) ?? ''
  const verdicts = []
  for (const m of answer.matchAll(/\{\s*"i"\s*:\s*(\d+)\s*,\s*"verdict"\s*:\s*"(\w+)"\s*\}/g)) {
    verdicts.push({ i: Number(m[1]), verdict: m[2] })
  }
  const merged = capped.map((it, idx) => ({ ...it, judgeVerdict: verdicts.find(v => v.i === idx + 1)?.verdict ?? 'unjudged' }))
  writeJson(join(EVID, 'judge.json'), { generatedAt: new Date().toISOString(), exit: res.status, verdicts: merged, answerTail: answer.slice(-800) })
  findings.judged = merged
  writeJson(findingsPath, findings)
  console.log(`judge: ${merged.length} items, judged=${merged.filter(m => m.judgeVerdict !== 'unjudged').length}`)
}
