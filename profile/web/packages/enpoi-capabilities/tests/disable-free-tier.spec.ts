import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, SHIPPED_BUILTIN_CHAINS } from '../../enpoi-model-chains/src/index.ts'

/**
 * Boot-guard specs for `scripts/disable-free-tier.mjs`.
 *
 * The guard runs as an `ExecStartPre` against the live `cordis.patch.yml`, a
 * document the settings service rewrites. Its invariant is content, not a
 * chain name: no enabled chain may link an `opencode/*-free` model
 * (`403 FreeTierError`), every `chain:` reference must name an enabled
 * declared chain or a shipped built-in group, and the default seat must name a
 * resolvable provider/model pair or chain. Every case below spawns the real
 * script against a temporary patch file, so the parser the boot path uses is
 * the one under test.
 */

const SCRIPT = fileURLToPath(new URL('../../../scripts/disable-free-tier.mjs', import.meta.url))
const SCRIPT_SOURCE = readFileSync(SCRIPT, 'utf8')

/** Temporary fixture directories, removed after each case. */
const directories: string[] = []

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface FixtureParts {
  /** 4-space-indented `chains:` section; absent when the fixture has no chains map. */
  chains?: string
  /** 4-space-indented `personas:` section. */
  personas?: string
  /** 4-space-indented seat config fields; `null` omits the whole row. */
  seat?: string | null
}

/** Build a minimal profile patch document. */
function fixture({
  chains,
  personas,
  seat = '    provider: antigravity\n    model: gemini-3.8-flash-tiered\n',
}: FixtureParts = {}): string {
  const sections = [chains, personas].filter((section): section is string => section !== undefined)
  const config = sections.length === 0 ? '  config: {}\n' : `  config:\n${sections.join('')}`
  const seatRow = seat === null
    ? ''
    : `\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n${seat}`
  return `# fixture: profile patch
- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
${config}- id: subagent
  name: dsh-subagent
${seatRow}`
}

/** Write a fixture and return its path. */
function writeFixture(patch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'disable-free-tier-'))
  directories.push(dir)
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, patch)
  return path
}

/** Run the boot guard against one fixture. */
function run(path: string) {
  return spawnSync(process.execPath, [SCRIPT, path], { encoding: 'utf8' })
}

/** The selector-shaped `free` group the plugin ships by default. */
const SELECTOR_FREE_CHAIN = [
  '    chains:',
  '      free:',
  '        label: Free',
  '        selectors:',
  '          - when:',
  '              zeroPrice: true',
  '              tools: true',
  '              gated: false',
  '              visible: true',
  '              minContextWindow: 65536',
  '            adopt: true',
  '        disabled: false',
  '',
].join('\n')

describe('disable-free-tier boot guard', () => {
  it('accepts an enabled selector-based free chain and its seat attachment', () => {
    const path = writeFixture(fixture({
      chains: SELECTOR_FREE_CHAIN,
      seat: '    provider: antigravity\n    model: gemini-3.8-flash-tiered\n    chain: free\n',
    }))
    const before = readFileSync(path, 'utf8')
    const result = run(path)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('already clean')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('accepts personas.<seat>.chain: free against the shipped built-in group', () => {
    const path = writeFixture(fixture({
      personas: [
        '    personas:',
        '      compaction:',
        '        provider: kilo',
        '        model: kilo-auto/free',
        '        chain: free',
        '',
      ].join('\n'),
    }))
    const result = run(path)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('already clean')
  })

  it('fails an enabled chain that links an opencode/*-free model', () => {
    const path = writeFixture(fixture({
      chains: [
        '    chains:',
        '      bad:',
        '        label: Bad',
        '        links:',
        '          - provider: opencode',
        '            model: foo-free',
        '        disabled: false',
        '',
      ].join('\n'),
    }))
    const before = readFileSync(path, 'utf8')
    const result = run(path)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('enabled chain bad links gated free model foo-free')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('fails an enabled chain whose opencode/*-free link uses flow-map syntax', () => {
    const path = writeFixture(fixture({
      chains: [
        '    chains:',
        '      bad:',
        '        links: [{ provider: opencode, model: foo-free }]',
        '',
      ].join('\n'),
    }))
    const result = run(path)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('enabled chain bad links gated free model foo-free')
  })

  it('fails a default seat that names an opencode/*-free model', () => {
    const path = writeFixture(fixture({
      seat: '    provider: opencode\n    model: mimo-v2.5-free\n',
    }))
    const result = run(path)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('agent-default-model names gated free model mimo-v2.5-free')
  })

  it('fails a chain reference that names no declared or built-in group', () => {
    const path = writeFixture(fixture({
      personas: [
        '    personas:',
        '      compaction:',
        '        chain: ghost',
        '',
      ].join('\n'),
    }))
    const result = run(path)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('a config still references unusable chain ghost')
  })

  it('fails a reference to a built-in id shadowed by a disabled settings row', () => {
    const path = writeFixture(fixture({
      chains: [
        '    chains:',
        '      free:',
        '        links:',
        '          - provider: kilo',
        '            model: kilo-auto/free',
        '        disabled: true',
        '',
      ].join('\n'),
      personas: '    personas:\n      compaction:\n        chain: free\n',
    }))
    const result = run(path)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('a config still references unusable chain free')
  })

  it('warns about a disabled chain whose only members are gated free links without failing', () => {
    const path = writeFixture(fixture({
      chains: [
        '    chains:',
        '      free:',
        '        label: Free',
        '        links:',
        '          - provider: opencode',
        '            model: ling-3.0-flash-fin-free',
        '          - provider: opencode',
        '            model: mimo-v2.5-free',
        '        disabled: true',
        '',
      ].join('\n'),
    }))
    const result = run(path)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('chain "free" has only gated free links and is disabled')
  })

  it('repairs a missing agent-default-model row and is idempotent on the second run', () => {
    const path = writeFixture(fixture({ seat: null }))
    const first = run(path)
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toContain('applied 1 fix')
    const repaired = readFileSync(path, 'utf8')
    expect(repaired).toContain('- id: agent-default-model')
    expect(repaired).toContain('    provider: kilo\n    model: poolside/laguna-s-2.1:free\n')
    const second = run(path)
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('already clean')
    expect(readFileSync(path, 'utf8')).toBe(repaired)
  })

  it('changes nothing on a second run over an already valid document', () => {
    const path = writeFixture(fixture({
      seat: '    provider: antigravity\n    model: gemini-3.8-flash-tiered\n    chain: free\n',
    }))
    const first = run(path)
    expect(first.status, first.stderr).toBe(0)
    const afterFirst = readFileSync(path, 'utf8')
    const second = run(path)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toContain('already clean')
    expect(readFileSync(path, 'utf8')).toBe(afterFirst)
  })

  it('reads a hand-edited flow-map seat config', () => {
    const path = writeFixture([
      '# fixture: flow seat',
      '- id: enpoi-orchestration',
      '  name: dsh-enpoi-capabilities',
      '  config: {}',
      '- id: subagent',
      '  name: dsh-subagent',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config: { provider: kilo, model: kilo-auto/free, chain: free }',
      '',
    ].join('\n'))
    const accepted = run(path)
    expect(accepted.status, accepted.stderr).toBe(0)
    writeFileSync(path, readFileSync(path, 'utf8').replace('chain: free', 'chain: ghost'))
    const rejected = run(path)
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toContain('a config still references unusable chain ghost')
  })

  it('keeps BUILTIN_CHAIN_IDS in lockstep with the plugin default builtinChains', () => {
    const declaration = /const BUILTIN_CHAIN_IDS = \[([^\]]*)\]/.exec(SCRIPT_SOURCE)
    expect(declaration, 'BUILTIN_CHAIN_IDS declaration missing from the script').not.toBeNull()
    const ids = [...declaration![1]!.matchAll(/'([^']+)'|"([^"]+)"/g)].map(match => match[1] ?? match[2])
    expect(ids.length).toBeGreaterThan(0)
    // `Config({})` is the schema default the plugin applies when the profile
    // ships no `builtinChains` override.
    const defaults = Config({}).builtinChains ?? {}
    expect(ids).toEqual(Object.keys(defaults))
    expect(Object.keys(defaults)).toEqual(Object.keys(SHIPPED_BUILTIN_CHAINS))
    // A shipped group the boot guard lists must be usable as shipped.
    for (const id of ids) expect(SHIPPED_BUILTIN_CHAINS[id!]?.disabled, `built-in ${String(id)}`).not.toBe(true)
  })
})
