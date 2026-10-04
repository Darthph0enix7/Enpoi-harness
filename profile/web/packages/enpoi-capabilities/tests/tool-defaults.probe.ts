/**
 * Tool-defaults evidence probe (operator decision 2026-10-02).
 *
 * Prints the shipped-default decision table and drives the REAL
 * `tools/pre-execute` listener (fake Cordis ctx) so the evidence file shows,
 * call by call, which tools reach `next()` with no approval card and which
 * still ask or are seat-denied.
 *
 * Run (no package build; probe bundle only):
 *   npx esbuild tests/tool-defaults.probe.ts --bundle --format=esm --platform=node \
 *     --target=node22 --external:@deepseek-ai/* --external:schemastery --external:dsh-enpoi-* \
 *     --outfile=tests/.tool-defaults.probe.mjs \
 *     && node tests/.tool-defaults.probe.mjs
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index'
import { SHIPPED_TOOL_DEFAULTS, SHIPPED_TOOL_DEFAULT_EXEMPTIONS } from '../src/policy'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = process.env.DSH_TOOL_INVENTORY_DIR
  ?? join(homedir(), 'deepseek-harness', 'scripts', 'tool-inventory')

interface FakeEvent {
  type?: string
  data?: Record<string, unknown>
}

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const ctx = {
    on: (name: string, handler: (...args: any[]) => any) => {
      handlers.set(name, handler)
      return () => {}
    },
    effect: (callback: () => unknown) => {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') (dispose as () => void)() }
    },
    inject: () => {},
    provide: () => {},
    get: () => undefined,
    tools: { guard: () => () => {}, schemas: () => [] },
    setTimeout: () => 0,
    setInterval: () => 0,
    logger: { debug: () => {} },
  }
  apply(ctx as any, {} as any)
  const handler = handlers.get('tools/pre-execute')
  if (handler === undefined) throw new Error('tools/pre-execute listener was not registered')
  return (exec: Record<string, unknown>, next: () => Promise<{ kind: string }>) => handler(exec, next)
}

const NORMAL_MODE: FakeEvent[] = [
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'approval/policy', data: { policy: 'ask', source: 'user' } },
]

function agentFor(seat: string) {
  return { id: `${seat}-1`, session: { header: { agentPreset: seat }, seq: NORMAL_MODE.length, eventAt: (i: number) => NORMAL_MODE[i] } }
}

async function drive(call: ReturnType<typeof harness>, seat: string, tool: string, args: Record<string, unknown> = {}) {
  let nextCalled = 0
  const decision = await call(
    { name: tool, arguments: args, agent: agentFor(seat), callId: `probe-${seat}-${tool}` },
    async () => { nextCalled += 1; return { kind: 'allow' } },
  )
  return { tool, seat, decision, nextCalled }
}

function row(result: Awaited<ReturnType<typeof drive>>): string {
  const reason = 'reason' in result.decision ? String((result.decision as { reason?: string }).reason ?? '') : ''
  const source = 'source' in result.decision ? String((result.decision as { source?: string }).source ?? '') : ''
  const detail = reason !== '' ? ` — ${reason}` : source !== '' ? ` — ${source}` : ''
  const card = result.decision.kind === 'ask' ? 'CARD' : result.decision.kind === 'deny' ? 'DENIED' : 'NO CARD'
  return `| ${result.tool.padEnd(22)} | ${result.seat.padEnd(12)} | ${result.decision.kind.padEnd(5)} | ${card.padEnd(7)} | next=${result.nextCalled} |${detail}`
}

function fixtureTools(): string[] {
  const union = new Set<string>()
  for (const preset of ['orchestrator', 'sysadmin', 'creator']) {
    const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, `expected-${preset}.json`), 'utf8')) as { tools: string[] }
    for (const tool of parsed.tools) union.add(tool)
  }
  return [...union].sort()
}

async function main(): Promise<void> {
  const call = harness()

  console.log('## Shipped-default audit (union of the three main-agent fixtures)')
  console.log('')
  console.log('| tool | shipped default | account |')
  console.log('|---|---|---|')
  for (const tool of fixtureTools()) {
    const shipped = SHIPPED_TOOL_DEFAULTS[tool]
    const exemption = SHIPPED_TOOL_DEFAULT_EXEMPTIONS.find(entry => tool.startsWith(entry.prefix))
    const account = shipped !== undefined
      ? `explicit row: ${shipped}`
      : exemption !== undefined
        ? `family exemption ${exemption.prefix}: ask via defaults.unknownTools`
        : 'UNACCOUNTED'
    console.log(`| ${tool} | ${shipped ?? '(none)'} | ${account} |`)
  }

  console.log('')
  console.log('## Pre-execute decisions, normal-mode root (approval ask + workspace-write)')
  console.log('')
  console.log('| tool | seat | kind | card | next | detail |')
  console.log('|---|---|---|---|---|---|')

  const integrated = ['create_goal', 'get_goal', 'update_goal', 'exit_plan_mode', 'ralph', 'workflow', 'tool_groups']
  for (const seat of ['orchestrator', 'sysadmin', 'creator']) {
    for (const tool of integrated) console.log(row(await drive(call, seat, tool)))
  }
  for (const seat of ['orchestrator', 'sysadmin', 'creator']) {
    for (const tool of ['plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query']) {
      console.log(row(await drive(call, seat, tool)))
    }
  }
  console.log(row(await drive(call, 'orchestrator', 'bash', { command: 'rm -rf /tmp/x' })))
  console.log(row(await drive(call, 'orchestrator', 'bash', { command: 'git status' })))
  for (const tool of ['str_replace_editor', 'interrupt_agent', 'job_kill', 'council_register', 'brand_new_tool']) {
    console.log(row(await drive(call, 'orchestrator', tool)))
  }

  console.log('')
  console.log(`fixtures: ${FIXTURE_DIR}`)
  console.log(`shipped rows: ${Object.keys(SHIPPED_TOOL_DEFAULTS).length}; exemptions: ${SHIPPED_TOOL_DEFAULT_EXEMPTIONS.length}`)
}

await main()
