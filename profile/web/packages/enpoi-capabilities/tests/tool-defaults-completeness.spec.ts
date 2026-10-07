/**
 * Tool-defaults completeness guard (operator decision 2026-10-02).
 *
 * Every tool a shipped main-agent preset can advertise must be ACCOUNTED FOR:
 * an explicit `SHIPPED_TOOL_DEFAULTS` row, or a documented family exemption
 * (`SHIPPED_TOOL_DEFAULT_EXEMPTIONS`). A tool that appears in a tool-inventory
 * fixture without either fails this spec — the registry grew and nobody
 * decided whether the new surface works by default or asks.
 *
 * The first-party on-demand peer family is not in the preset fixtures (it
 * mounts from enpoi-peer-bridge only while the peer driver runs), so the
 * documented `peer_` exemption is exercised directly by name here.
 *
 * The fixtures are the committed wire captures of
 * `deepseek-harness/scripts/preset-tool-inventory.mjs`. Copies live beside this
 * spec so the guard runs self-contained; when the canonical directory exists
 * the copies must equal it (a fixture update fails until it is synced here,
 * and the synced tool then fails the completeness assertion until decided).
 * Override the canonical location with `DSH_TOOL_INVENTORY_DIR`.
 *
 * The same spec verifies `HOST_DEFAULTS_DIGEST` in the client's generated
 * permissions mirror (`deepseek-harness/packages/client/ui-brand-enpoi`)
 * when that checkout is present, so a default change here fails until the
 * mirror is regenerated; the client parity spec verifies the reverse.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolvePolicy, SHIPPED_TOOL_DEFAULTS, SHIPPED_TOOL_DEFAULT_EXEMPTIONS } from '../src/policy'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOCAL_FIXTURE_DIR = join(HERE, 'fixtures', 'tool-inventory')
const CANONICAL_FIXTURE_DIR = process.env.DSH_TOOL_INVENTORY_DIR
  ?? join(homedir(), 'deepseek-harness', 'scripts', 'tool-inventory')
const CLIENT_MIRROR_FILE = process.env.DSH_CLIENT_PERMISSIONS_MIRROR
  ?? join(homedir(), 'deepseek-harness', 'packages', 'client', 'ui-brand-enpoi', 'src', 'client', 'permissions-defaults.generated.ts')

/** The main-agent presets the inventory probe surveys by default. */
const PRESETS = ['orchestrator', 'sysadmin', 'creator'] as const

function readTools(directory: string, preset: string): string[] {
  const parsed = JSON.parse(readFileSync(join(directory, `expected-${preset}.json`), 'utf8')) as {
    preset?: unknown
    tools?: unknown
  }
  if (parsed.preset !== preset) throw new Error(`${directory}/expected-${preset}.json names preset ${String(parsed.preset)}`)
  if (!Array.isArray(parsed.tools) || parsed.tools.some(tool => typeof tool !== 'string')) {
    throw new Error(`${directory}/expected-${preset}.json has no string tools array`)
  }
  return parsed.tools as string[]
}

/** Exemption prefix matching one tool name, or undefined. */
function exemptionFor(tool: string): { prefix: string; except?: readonly string[]; reason: string } | undefined {
  return SHIPPED_TOOL_DEFAULT_EXEMPTIONS.find(exemption =>
    tool.startsWith(exemption.prefix) && !(exemption.except ?? []).includes(tool))
}

describe('tool-defaults completeness guard', () => {
  it('ships a local fixture copy for every main-agent preset', () => {
    for (const preset of PRESETS) {
      const tools = readTools(LOCAL_FIXTURE_DIR, preset)
      expect(tools.length, `${preset} fixture is empty`).toBeGreaterThan(0)
      expect(new Set(tools).size, `${preset} fixture has duplicate names`).toBe(tools.length)
    }
  })

  it('keeps the local fixture copies equal to the canonical inventory when present', () => {
    if (!existsSync(join(CANONICAL_FIXTURE_DIR, 'expected-orchestrator.json'))) return
    for (const preset of PRESETS) {
      const local = readTools(LOCAL_FIXTURE_DIR, preset).slice().sort()
      const canonical = readTools(CANONICAL_FIXTURE_DIR, preset).slice().sort()
      expect(
        local,
        `${preset}: the local fixture copy drifted from ${CANONICAL_FIXTURE_DIR} — run ` +
        `\`cp ${CANONICAL_FIXTURE_DIR}/expected-*.json ${LOCAL_FIXTURE_DIR}/\` and account for the diff`,
      ).toEqual(canonical)
    }
  })

  it('accounts for every advertised tool with an explicit default or a documented family exemption', () => {
    const unaccounted = new Map<string, string[]>()
    for (const preset of PRESETS) {
      const tools = readTools(LOCAL_FIXTURE_DIR, preset)
      for (const tool of tools) {
        if (SHIPPED_TOOL_DEFAULTS[tool] !== undefined) continue
        if (exemptionFor(tool) !== undefined) continue
        const presets = unaccounted.get(tool) ?? []
        presets.push(preset)
        unaccounted.set(tool, presets)
      }
    }
    const report = [...unaccounted.entries()]
      .map(([tool, presets]) => `${tool} (${presets.join(', ')})`)
      .sort()
    expect(
      report,
      'a registry tool reached a shipped preset with no shipped default and no family exemption. ' +
      'Add a SHIPPED_TOOL_DEFAULTS row (allow/ask/deny with a reason) or add a documented ' +
      'SHIPPED_TOOL_DEFAULT_EXEMPTIONS prefix, then re-run this spec.',
    ).toEqual([])
  })

  it('keeps the exemption list documented and non-overlapping with explicit rows', () => {
    for (const exemption of SHIPPED_TOOL_DEFAULT_EXEMPTIONS) {
      expect(exemption.prefix.length, 'exemption prefix must be non-empty').toBeGreaterThan(0)
      expect(exemption.reason.length, `exemption ${exemption.prefix} needs a reason`).toBeGreaterThan(20)
    }
    const explicitWithPrefix = Object.keys(SHIPPED_TOOL_DEFAULTS).filter(tool => exemptionFor(tool) !== undefined)
    expect(
      explicitWithPrefix,
      'an explicit SHIPPED_TOOL_DEFAULTS row inside an exempted family is dead code — decide: remove the row or retire the exemption',
    ).toEqual([])
  })

  it('resolves every fixture tool through its shipped row, not defaults.unknownTools', () => {
    // The guard above is structural; this is the behavioral twin: with no
    // operator config every advertised tool with an explicit row must resolve
    // from that row ('matrix:global'), never fall through to the unknown-tools
    // ask. An exempted tool is allowed to fall through by design.
    const config = { defaults: { unknownTools: 'ask' as const } }
    for (const preset of PRESETS) {
      for (const tool of readTools(LOCAL_FIXTURE_DIR, preset)) {
        const row = SHIPPED_TOOL_DEFAULTS[tool]
        if (row === undefined) continue
        // bash is per-command: its command-less resolution is the empty-command
        // guard (deny), not its policy; policy.spec.ts owns that behavior.
        if (tool === 'bash') {
          expect(row).toBe('ask')
          continue
        }
        const decision = resolvePolicy({ toolName: tool, agent: preset, config })
        expect(decision.kind, `${tool} on ${preset} must resolve its shipped '${row}'`).toBe(row)
        expect(decision.source, `${tool} on ${preset} fell through to defaults.unknownTools`).toBe('matrix:global')
      }
    }
  })

  it('accounts for the first-party on-demand peer tools: orchestrator seat allows, every other seat asks', () => {
    const peerTools = ['peer_ask', 'peer_asks', 'peer_answer', 'peer_cancel', 'peer_status', 'peer_sessions'] as const
    const config = { defaults: { unknownTools: 'ask' as const } }
    for (const tool of peerTools) {
      expect(SHIPPED_TOOL_DEFAULTS[tool], `${tool} must stay on the documented exemption, not a hand row`).toBeUndefined()
      expect(exemptionFor(tool)?.prefix, `${tool} matches no documented exemption`).toBe('peer_')
      const orchestrator = resolvePolicy({ toolName: tool, agent: 'orchestrator', config })
      expect(orchestrator, `${tool} must be allowed on the orchestrator seat`).toMatchObject({ kind: 'allow', source: 'seat:orchestrator' })
      for (const seat of ['sysadmin', 'creator'] as const) {
        const decision = resolvePolicy({ toolName: tool, agent: seat, config })
        expect(decision.kind, `${tool} must ask on ${seat} until the operator sets a row`).toBe('ask')
        expect(decision.source, `${tool} must fall through to the unknown-tools ask on ${seat}`).toBe('defaults')
      }
    }
  })

  it('matches the client permissions mirror digest when the harness checkout is present', () => {
    if (!existsSync(CLIENT_MIRROR_FILE)) return
    const mirror = readFileSync(CLIENT_MIRROR_FILE, 'utf8')
    // The generator renders lint-clean single-quoted literals; accept either
    // quote so a pre-format mirror still parses.
    const embedded = /export const HOST_DEFAULTS_DIGEST = ['"]([0-9a-f]{64})['"]/.exec(mirror)?.[1]
    expect(embedded, `${CLIENT_MIRROR_FILE} carries no HOST_DEFAULTS_DIGEST`).toBeDefined()
    const defaults: Record<string, string> = {}
    for (const key of Object.keys(SHIPPED_TOOL_DEFAULTS).sort()) {
      defaults[key] = SHIPPED_TOOL_DEFAULTS[key] as string
    }
    const exemptions = SHIPPED_TOOL_DEFAULT_EXEMPTIONS.map(entry => ({
      prefix: entry.prefix,
      ...(entry.except === undefined ? {} : { except: entry.except }),
      reason: entry.reason,
    }))
    const digest = createHash('sha256')
      .update(JSON.stringify({ shippedToolDefaults: defaults, shippedToolDefaultExemptions: exemptions }))
      .digest('hex')
    expect(
      embedded,
      'the client permissions mirror is stale — regenerate with `pnpm exec tsx ' +
      'packages/client/ui-brand-enpoi/scripts/generate-permissions-mirror.ts --write` in deepseek-harness',
    ).toBe(digest)
  })
})
