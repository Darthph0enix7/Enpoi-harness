/**
 * Guard: profile plugins must declare producer-owned V4 message source kinds.
 *
 * Upstream retired the shared `kind: 'plugin'` message source; `assertV4MessageSources`
 * refuses it (session-format-v3-to-v4/src/message-sources.ts), which used to wedge
 * sessions when the keeper/oracle/verify-gate appended messages. This spec keeps the
 * class from returning:
 *   1. no profile plugin `src/**` may emit `kind: 'plugin'` (or a `plugin:`-tagged
 *      source object without a producer kind);
 *   2. every known producer declares its kind through the `MessageSourceMap`
 *      augmentation in the package that emits it;
 *   3. the declared kinds pass the engine's own admission helper (imported from the
 *      harness source when present, with a local replica of the rule as fallback).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const PROFILE_ROOT = resolve(TESTS_DIR, '..', '..', '..')
const PACKAGES_ROOT = join(PROFILE_ROOT, 'packages')

/** Harness root holding session-format-v3-to-v4; override when the checkout moves. */
const HARNESS_ROOT = process.env['DSH_HARNESS_ROOT'] ?? join(homedir(), 'deepseek-harness')
const ENGINE_SOURCES = join(
  HARNESS_ROOT,
  'packages/session/session-format-v3-to-v4/src/message-sources.ts',
)

/** Producers owned by this profile; each must brand its injected messages. */
const DECLARED_PRODUCER_KINDS: ReadonlyArray<{ file: string; kind: string }> = [
  { file: 'enpoi-context-keeper/src/index.ts', kind: 'enpoi-keeper' },
  { file: 'enpoi-oracle/src/index.ts', kind: 'enpoi-oracle' },
  { file: 'enpoi-verify-gate/src/index.ts', kind: 'enpoi-verify-gate' },
]

/** Every `.ts` file under the profile plugin sources. */
function sourceFiles(): string[] {
  const out: string[] = []
  for (const entry of readdirSync(PACKAGES_ROOT)) {
    const src = join(PACKAGES_ROOT, entry, 'src')
    if (!existsSync(src) || !statSync(src).isDirectory()) continue
    for (const file of readdirSync(src, { recursive: true })) {
      const path = join(src, String(file))
      if (path.endsWith('.ts') && statSync(path).isFile()) out.push(path)
    }
  }
  return out
}

const RETIRED_KIND = /kind\s*:\s*['"]plugin['"]/
const PLUGIN_TAGGED_SOURCE = /source\s*:\s*\{[^}]*\bplugin\s*:/

/** Local replica of the engine's admission rule, used when the harness source is absent. */
function localAssertV4MessageSources(event: unknown): void {
  const data = (event as { data?: Record<string, unknown> }).data ?? {}
  const message = (data['message'] as Record<string, unknown> | undefined) ?? data
  const source = message['source'] as Record<string, unknown> | undefined
  const kind = source?.['kind']
  if (typeof kind !== 'string' || kind.length === 0 || kind === 'plugin') {
    throw new Error('format v4 message requires a producer-owned source kind')
  }
}

const engine = existsSync(ENGINE_SOURCES)
  ? (await import(pathToFileURL(ENGINE_SOURCES).href)) as {
    assertV4MessageSources: (event: unknown) => void
  }
  : undefined

const assertV4MessageSources = engine?.assertV4MessageSources ?? localAssertV4MessageSources

describe('profile plugin V4 message sources', () => {
  it('no profile plugin source emits the retired `plugin` kind', () => {
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8')
      if (RETIRED_KIND.test(text) || PLUGIN_TAGGED_SOURCE.test(text)) {
        offenders.push(file.slice(PROFILE_ROOT.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })

  it('each producer declares its own kind in the MessageSourceMap', () => {
    for (const { file, kind } of DECLARED_PRODUCER_KINDS) {
      const text = readFileSync(join(PROFILE_ROOT, 'packages', file), 'utf8')
      expect(text, file).toContain("declare module '@deepseek-ai/dsh-llm'")
      expect(text, file).toContain(`'${kind}': { kind: '${kind}' }`)
    }
  })

  it('declared kinds pass the engine admission and the retired kind is refused', () => {
    for (const { kind } of DECLARED_PRODUCER_KINDS) {
      expect(() => { assertV4MessageSources({ type: 'user/message', data: { source: { kind } } }) }).not.toThrow()
    }
    expect(() => {
      assertV4MessageSources({ type: 'user/message', data: { source: { kind: 'plugin', plugin: 'enpoi-context-keeper' } } })
    }).toThrow(/producer-owned source kind/)
  })
})
