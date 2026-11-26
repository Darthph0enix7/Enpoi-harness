/**
 * Keyless preset tool inventory capture — outer gate and fixture diff.
 *
 * This file NEVER imports the harness scaffold directly. It reads readiness
 * (opt-in + fresh profile-bundle fingerprints) using node-only code, and only
 * when ready does it spawn `scripts/tool-inventory/keyless-inventory-runner.mts` as a CHILD
 * PROCESS whose HOME/USERPROFILE/DSH_HOME/DSH_MEMORY_DB/DSH_WIRE_LOG and XDG
 * directories are set before any module loads. That ordering matters:
 * enpoi-file-revert captures `HOME` at module evaluation and enpoi-memory
 * defaults to `~/.dsh/memory.db`.
 *
 * While the source tree is active (no central build/fingerprint record) the
 * test reports CAPTURE_BLOCKED as a deliberate red release gate and does not
 * boot the composition. Fixtures are marked stale until that capture is
 * intentionally dispatched. A green blocked test is not proof; the parent
 * flips this only after the central build.
 *
 * Update fixtures (only after the central build and an explicit dispatch):
 *   DSH_KEYLESS_INVENTORY_CAPTURE=1 DSH_TOOL_INVENTORY_WRITE=1 \
 *     pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/keyless-tool-inventory.e2e.ts
 * A normal run only asserts. The capture scope is SHIPPED profile defaults;
 * live ~/.dsh operator state is never read. Host repo lib freshness after the
 * central build is an explicit orchestrator prerequisite (there is no
 * test-time source stamp); the receipt records the current compiled bytes.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  CAPTURE_CONFIG, REPO_ROOT, VITEST_BIN, captureReadiness,
} from './keyless-tool-inventory-bootstrap.ts'
const FIXTURE_DIR = join(REPO_ROOT, 'scripts', 'tool-inventory')
const COPY_FIXTURE_DIR = join(REPO_ROOT, 'profile', 'web', 'packages', 'enpoi-capabilities', 'tests', 'fixtures', 'tool-inventory')
const PRESETS = ['orchestrator', 'sysadmin', 'creator'] as const
const WRITE = process.env.DSH_TOOL_INVENTORY_WRITE === '1'
const CAPTURE_METHOD = 'keyless-profile-composition'
const CAPTURE_SOURCE = 'apps/web/tests/keyless-tool-inventory.e2e.ts'

interface Fixture {
  preset?: unknown
  stale?: unknown
  captureMethod?: unknown
  captureSource?: unknown
  captureReceipt?: unknown
  captureClientBuild?: unknown
  captureScope?: unknown
  tools?: unknown
}

interface RunnerResult {
  captured: Record<string, string[]>
  receipt: {
    version: string | null
    head: string | null
    profileFingerprints: Record<string, { dir: string; sourceInputs: string | null; outputSha: string | null }>
    externalBundles: Record<string, { version: string | null; packageJson: string | null; entry: string | null; missing?: boolean }>
    hostPackages: Record<string, { name: string; version: string | null; packageJson: string | null; entry: string | null }>
    combinedDigest: string
  }
  clientBuild: {
    artifacts: { fileCount: number; sha256: string }
    environment: Record<string, string>
  }
  diagnostics?: {
    sessionIds: string[]
    fakeRequests: Record<string, number>
    mainRequests: Record<string, number>
    network: { attempts: number; details: string[] }
  }
}

function childEnvironment(root: string, nonce: string, head: string, worker = false): NodeJS.ProcessEnv {
  const home = join(root, 'home')
  // Strict whitelist: never inherit HOME, credentials, proxy, Kubernetes,
  // Docker, SSH-agent or other ambient paths. DSH_* is set explicitly below.
  const allowed = [
    'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'TZ', 'TERM',
    'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'WINDIR',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  if (env.PATH === undefined) env.PATH = '/usr/bin:/bin'
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: home,
    DSH_MEMORY_DB: join(home, 'memory.db'),
    DSH_WIRE_LOG: join(root, 'wire', 'wire-last.json'),
    DSH_KEYLESS_INVENTORY_CAPTURE: '1',
    DSH_KEYLESS_INVENTORY_ALLOW: '1',
    DSH_KEYLESS_INVENTORY_ROOT: root,
    DSH_KEYLESS_INVENTORY_PARENT: tmpdir(),
    DSH_KEYLESS_INVENTORY_PARENT_HOME: process.env.HOME ?? '',
    DSH_KEYLESS_INVENTORY_NONCE: nonce,
    DSH_KEYLESS_INVENTORY_HEAD: head,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    TMPDIR: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
  })
  if (worker) {
    delete env.DSH_WIRE_LOG
    env.DSH_KEYLESS_INVENTORY_WORKER = '1'
  }
  return env
}

function diffRows(expected: readonly string[], actual: readonly string[]) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  return {
    missing: expected.filter(name => !actualSet.has(name)),
    extra: actual.filter(name => !expectedSet.has(name)),
  }
}

function readFixture(preset: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `expected-${preset}.json`), 'utf8')) as Fixture
}

it('captures the shipped presets keylessly, or reports BLOCKED until the central build', async () => {
  const readiness = await captureReadiness()
  if (!readiness.ready) {
    const lines = readiness.blockers.map(blocker => `  - ${blocker}`).join('\n')
    process.stderr.write(`[inventory-keyless] CAPTURE_BLOCKED (no composition, no session, no provider):\n${lines}\n`)
    expect(readiness.blockers.length, 'BLOCKED without an actionable reason').toBeGreaterThan(0)
    // This is a deliberate red release gate: fixtures are stale, and a green
    // test here would be mistaken for proof. The parent dispatches the write
    // only after the central build.
    expect.fail(`CAPTURE_BLOCKED:\n${lines}`)
  }

  const root = mkdtempSync(join(tmpdir(), 'dsh-keyless-inventory-'))
  process.stderr.write(`[inventory-keyless] isolatedRoot=${root}\n`)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(root, 'tmp'), { recursive: true })
  mkdirSync(join(root, 'wire'), { recursive: true })
  const nonce = randomUUID()
  writeFileSync(join(root, 'intent.json'), `${JSON.stringify({ capture: true, nonce }, null, 2)}\n`)
  // HEAD is informational provenance only: the parent reads it once; the child
  // never runs git. It is not an equality gate (atomic commit loops).
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout?.trim() ?? ''
  try {
    const run = spawnSync(VITEST_BIN, ['run', '--config', CAPTURE_CONFIG], {
      cwd: REPO_ROOT,
      env: childEnvironment(root, nonce, head),
      encoding: 'utf8',
      timeout: 300_000,
    })
    if (run.status !== 0) {
      process.stderr.write(run.stdout ?? '')
      process.stderr.write(run.stderr ?? '')
      expect.fail(`isolated capture failed (exit ${String(run.status)}); see runner output above`)
    }
    const resultPath = join(root, 'result.json')
    if (!existsSync(resultPath)) expect.fail('isolated capture produced no result.json')
    const result = JSON.parse(readFileSync(resultPath, 'utf8')) as RunnerResult
    if (result.diagnostics !== undefined) {
      const requests = Object.values(result.diagnostics.fakeRequests).reduce((sum, count) => sum + count, 0)
      process.stderr.write(
        `[inventory-keyless] sessions=${String(result.diagnostics.sessionIds.length)} fakeRequests=${String(requests)} `
        + `networkBlocked=${String(result.diagnostics.network.attempts)} details=${result.diagnostics.network.details.join(' | ')}\n`,
      )
    }

    for (const preset of PRESETS) {
      const actual = result.captured[preset]
      if (actual === undefined) expect.fail(`${preset}: capture missing`)
      expect(new Set(actual).size, `${preset}: duplicate tool names`).toBe(actual.length)
      const fixture = readFixture(preset)
      expect(fixture.preset, `${preset}: fixture names another preset`).toBe(preset)
      const expected = Array.isArray(fixture.tools) ? fixture.tools as string[] : []
      const { missing, extra } = diffRows(expected, actual)
      process.stderr.write(
        `[inventory-keyless] ${preset}: ${String(actual.length)} tools` +
        `${missing.length === 0 && extra.length === 0 ? ' (match)' : ` (-${String(missing.length)} +${String(extra.length)})`}\n`,
      )
      for (const name of missing) process.stderr.write(`[inventory-keyless] ${preset} - ${name}\n`)
      for (const name of extra) process.stderr.write(`[inventory-keyless] ${preset} + ${name}\n`)

      const body = {
        preset,
        captureMethod: CAPTURE_METHOD,
        captureSource: CAPTURE_SOURCE,
        captureReceipt: result.receipt,
        captureClientBuild: result.clientBuild,
        captureScope: 'shipped profile/web bundles and preset rows only; isolated child process with owned HOME/DSH_HOME/DSH_MEMORY_DB/DSH_WIRE_LOG/XDG paths, strict env whitelist, no operator settings or credentials; real runtime permissions/tool-group filtering; tools captured from GenerateOptions and cross-checked against the per-session wire capture',
        tools: actual,
      }
      if (WRITE) {
        const text = `${JSON.stringify(body, null, 2)}\n`
        writeFileSync(join(FIXTURE_DIR, `expected-${preset}.json`), text)
        mkdirSync(COPY_FIXTURE_DIR, { recursive: true })
        writeFileSync(join(COPY_FIXTURE_DIR, `expected-${preset}.json`), text)
        continue
      }
      if (missing.length > 0 || extra.length > 0) {
        expect.fail(`${preset}: fixture drift — ${missing.join(', ')} | + ${extra.join(', ')}`)
      }
      if (fixture.stale === true) {
        expect.fail(`${preset}: fixture is still marked stale; re-run with DSH_TOOL_INVENTORY_WRITE=1 after reviewing the diff`)
      }
      expect(fixture.captureMethod, `${preset}: fixture has no keyless capture provenance`).toBe(CAPTURE_METHOD)
      expect(fixture.captureSource, `${preset}: fixture has no capture source`).toBe(CAPTURE_SOURCE)
      const recorded = fixture.captureReceipt as RunnerResult['receipt'] | undefined
      expect(recorded?.combinedDigest, `${preset}: receipt digest`).toBe(result.receipt.combinedDigest)
      expect(Object.keys(recorded?.profileFingerprints ?? {}).length, `${preset}: no source fingerprints`).toBeGreaterThan(0)
      for (const [name, entry] of Object.entries(recorded?.profileFingerprints ?? {})) {
        expect(entry.sourceInputs, `${preset}: source fingerprint for ${name}`).toMatch(/^[0-9a-f]{64}$/u)
        expect(entry.outputSha, `${preset}: output fingerprint for ${name}`).toMatch(/^[0-9a-f]{64}$/u)
      }
      const clientBuild = fixture.captureClientBuild as RunnerResult['clientBuild'] | undefined
      expect(clientBuild?.artifacts, `${preset}: client artifact receipt`).toEqual(result.clientBuild.artifacts)
      expect(clientBuild?.environment, `${preset}: client build environment receipt`).toEqual(result.clientBuild.environment)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 300_000)

it('captures the isolated Jarvis worker roster and direct execution refusals', async () => {
  const readiness = await captureReadiness()
  if (!readiness.ready) expect.fail(`CAPTURE_BLOCKED:\n${readiness.blockers.map(blocker => `  - ${blocker}`).join('\n')}`)
  const root = mkdtempSync(join(tmpdir(), 'dsh-keyless-worker-inventory-'))
  try {
    for (const dir of ['home', 'tmp']) mkdirSync(join(root, dir), { mode: 0o700 })
    const nonce = randomUUID()
    writeFileSync(join(root, 'intent.json'), JSON.stringify({ capture: true, nonce }), { mode: 0o600 })
    const run = spawnSync(VITEST_BIN, ['run', '--config', CAPTURE_CONFIG], {
      cwd: REPO_ROOT, env: childEnvironment(root, nonce, '', true), encoding: 'utf8', timeout: 120_000,
    })
    if (run.status !== 0) expect.fail(`worker inventory failed: ${run.stdout ?? ''}\n${run.stderr ?? ''}`)
    const capture = JSON.parse(readFileSync(join(root, 'worker-result.json'), 'utf8')) as {
      tools: string[]
      profileHash: string
      receipt: Record<string, string>
    }
    const fixture = readFixture('jarvis-worker')
    expect(fixture.preset).toBe('jarvis-worker')
    expect(capture.tools).toEqual(fixture.tools)
    expect(capture.profileHash).toMatch(/^[0-9a-f]{64}$/u)
    if (WRITE) {
      writeFileSync(join(FIXTURE_DIR, 'expected-jarvis-worker.json'), `${JSON.stringify({ ...fixture, stale: false,
        captureMethod: CAPTURE_METHOD, captureSource: CAPTURE_SOURCE, captureScope: 'separate release-owned Jarvis worker host; fake adapter, loopback hub, direct executor refusal checks',
        captureReceipt: capture.receipt,
      }, null, 2)}\n`)
    } else {
      expect(fixture.stale, 'worker fixture must be recaptured by the central build').not.toBe(true)
      expect(fixture.captureMethod).toBe(CAPTURE_METHOD)
      expect(fixture.captureReceipt).toEqual(capture.receipt)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 130_000)
