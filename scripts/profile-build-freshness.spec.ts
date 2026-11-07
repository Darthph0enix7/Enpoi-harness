import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Behavior guard for `profile/web/build-plugins.sh` and its content
 * fingerprint helper. The profile ships prebuilt bundles, so a skipped build
 * must mean the fingerprint covers both the sources and the exact bytes in
 * `lib/index.js`; mtimes are deliberately not trusted.
 */

const win32 = process.platform === 'win32'
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildScript = join(repoRoot, 'profile/web/build-plugins.sh')
const fingerprintHelper = join(repoRoot, 'profile/web/scripts/profile-bundle-fingerprint.mjs')
const fingerprintFile = '.bundle-fingerprints.json'

interface Fixture {
  root: string
  profile: string
  packageDir: string
  esbuild: string
  log: string
}

interface Invocation {
  args: string[]
  cwd: string
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fakeEsbuild = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const log = process.env.FAKE_ESBUILD_LOG
if (log !== undefined) appendFileSync(log, JSON.stringify({ args, cwd: process.cwd() }) + '\\n')
const outfileArg = args.find((arg) => arg.startsWith('--outfile='))
if (outfileArg === undefined) {
  console.error('fake esbuild: missing --outfile')
  process.exit(2)
}
if (process.env.FAKE_ESBUILD_FAIL === '1') {
  console.error('fake esbuild: requested failure')
  process.exit(1)
}
const entry = args.find((arg) => !arg.startsWith('--'))
const source = readFileSync(join(process.cwd(), entry), 'utf8')
writeFileSync(outfileArg.slice('--outfile='.length), '// fake bundle\\n' + source)
const mutateSource = process.env.FAKE_ESBUILD_MUTATE_SOURCE
if (mutateSource !== undefined) appendFileSync(mutateSource, '\\n// mutated during build\\n')
`

function fixture(options: { spaces?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), options.spaces === true ? 'dsh profile freshness ' : 'dsh-profile-freshness-'))
  roots.push(root)
  const profile = join(root, options.spaces === true ? 'web profile' : 'web')
  const packageDir = join(profile, 'packages/enpoi-one')
  mkdirSync(join(packageDir, 'src'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), '{"name":"dsh-enpoi-one","private":true,"type":"module"}\n')
  writeFileSync(join(packageDir, 'src/data.json'), '{"value":1}\n')
  writeFileSync(join(packageDir, 'src/index.ts'), "import data from './data.json'\nexport default data.value\n")
  const esbuild = join(profile, 'node_modules/.bin/esbuild')
  mkdirSync(dirname(esbuild), { recursive: true })
  writeFileSync(esbuild, fakeEsbuild)
  chmodSync(esbuild, 0o755)
  return { root, profile, packageDir, esbuild, log: join(root, 'esbuild-calls.log') }
}

function runBuild(f: Fixture, overrides: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_BIN: process.execPath,
    FORCE_BUILD: '0',
    FAKE_ESBUILD_LOG: f.log,
    ...overrides,
  }
  delete env.ESBUILD_BIN
  delete env.HARNESS_ROOT
  return spawnSync('bash', [buildScript, f.profile], { encoding: 'utf8', env })
}

function invocations(f: Fixture): Invocation[] {
  if (!existsSync(f.log)) return []
  return readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Invocation)
}

function fingerprintPath(f: Fixture): string {
  return join(f.profile, fingerprintFile)
}

function sourceHash(f: Fixture): string {
  const result = spawnSync(process.execPath, [fingerprintHelper, 'source-hash', f.profile, 'enpoi-one'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  return result.stdout.trim()
}

describe.skipIf(win32)('profile plugin bundle freshness', () => {
  it('builds a package with no fingerprint, then records sources, output, and flags', () => {
    const f = fixture()
    const result = runBuild(f)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('BUILD enpoi-one')
    expect(result.stdout).toContain('OK   enpoi-one')
    expect(invocations(f)).toHaveLength(1)

    const fingerprints = JSON.parse(readFileSync(fingerprintPath(f), 'utf8')) as {
      version: number
      packages: Record<string, { sourceInputs: string; outputSha: string; buildFlags: string }>
    }
    expect(fingerprints.version).toBe(1)
    expect(Object.keys(fingerprints.packages)).toEqual(['enpoi-one'])
    expect(fingerprints.packages['enpoi-one']?.sourceInputs).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprints.packages['enpoi-one']?.outputSha).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprints.packages['enpoi-one']?.buildFlags).toMatch(/^[0-9a-f]{64}$/)
  })

  it('skips an unchanged prebuilt bundle without invoking esbuild', () => {
    const f = fixture()
    expect(runBuild(f).status).toBe(0)
    rmSync(f.esbuild)

    const result = runBuild(f)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('prebuilt fingerprint verified')
    expect(invocations(f)).toHaveLength(1)
  })

  it('rebuilds when JSON source content changes even if the mtime is preserved', () => {
    const f = fixture()
    expect(runBuild(f).status).toBe(0)
    const fingerprintBefore = JSON.parse(readFileSync(fingerprintPath(f), 'utf8')) as {
      packages: Record<string, { sourceInputs: string; outputSha: string }>
    }
    const source = join(f.packageDir, 'src/data.json')
    const before = statSync(source)
    writeFileSync(source, '{"value":2}\n')
    utimesSync(source, before.atime, before.mtime)

    const result = runBuild(f)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('BUILD enpoi-one  (source inputs changed)')
    expect(invocations(f)).toHaveLength(2)
    const fingerprintAfter = JSON.parse(readFileSync(fingerprintPath(f), 'utf8')) as typeof fingerprintBefore
    expect(fingerprintAfter.packages['enpoi-one']?.sourceInputs).not.toBe(fingerprintBefore.packages['enpoi-one']?.sourceInputs)
    expect(fingerprintAfter.packages['enpoi-one']?.outputSha).toBe(fingerprintBefore.packages['enpoi-one']?.outputSha)
  })

  it('rebuilds when lib/index.js no longer matches its recorded output hash', () => {
    const f = fixture()
    expect(runBuild(f).status).toBe(0)
    const bundle = join(f.packageDir, 'lib/index.js')
    writeFileSync(bundle, `${readFileSync(bundle, 'utf8')}// tampered\n`)

    const result = runBuild(f)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('BUILD enpoi-one  (bundle content changed)')
    expect(invocations(f)).toHaveLength(2)
    expect(readFileSync(bundle, 'utf8')).not.toContain('// tampered')
  })

  it('forces a rebuild even when the fingerprint matches', () => {
    const f = fixture()
    expect(runBuild(f).status).toBe(0)
    const before = readFileSync(fingerprintPath(f), 'utf8')

    const result = runBuild(f, { FORCE_BUILD: '1' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('BUILD enpoi-one  (forced by FORCE_BUILD=1)')
    expect(invocations(f)).toHaveLength(2)
    expect(readFileSync(fingerprintPath(f), 'utf8')).toBe(before)
  })

  it('keeps the previous bundle and fingerprint when the rebuild fails', () => {
    const f = fixture()
    expect(runBuild(f).status).toBe(0)
    const bundle = join(f.packageDir, 'lib/index.js')
    const previousBundle = readFileSync(bundle, 'utf8')
    const previousFingerprint = readFileSync(fingerprintPath(f), 'utf8')
    writeFileSync(join(f.packageDir, 'src/index.ts'), "export default 'broken'\n")

    const result = runBuild(f, { FAKE_ESBUILD_FAIL: '1' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAIL enpoi-one')
    expect(readFileSync(bundle, 'utf8')).toBe(previousBundle)
    expect(readFileSync(fingerprintPath(f), 'utf8')).toBe(previousFingerprint)
    expect(readdirSync(dirname(bundle)).filter(name => name.startsWith('.index.js.'))).toEqual([])
  })

  it('drops the temporary bundle when sources change during the build', () => {
    const f = fixture()
    expect(runBuild(f).status).toBe(0)
    const bundle = join(f.packageDir, 'lib/index.js')
    const previousBundle = readFileSync(bundle, 'utf8')
    const previousFingerprint = readFileSync(fingerprintPath(f), 'utf8')

    const racy = runBuild(f, {
      FORCE_BUILD: '1',
      FAKE_ESBUILD_MUTATE_SOURCE: join(f.packageDir, 'src/index.ts'),
    })
    expect(racy.status).toBe(1)
    expect(racy.stdout).toContain('source inputs changed during build')
    expect(invocations(f)).toHaveLength(2)
    expect(readFileSync(bundle, 'utf8')).toBe(previousBundle)
    expect(readFileSync(fingerprintPath(f), 'utf8')).toBe(previousFingerprint)
    expect(readdirSync(dirname(bundle)).filter(name => name.startsWith('.index.js.'))).toEqual([])

    const next = runBuild(f)
    expect(next.status).toBe(0)
    expect(invocations(f)).toHaveLength(3)
    expect(readFileSync(bundle, 'utf8')).not.toBe(previousBundle)
  })

  it('refuses to record when the expected pre-build source hash is stale', () => {
    const f = fixture()
    expect(runBuild(f).status).toBe(0)
    const previousFingerprint = readFileSync(fingerprintPath(f), 'utf8')
    const expected = sourceHash(f)
    writeFileSync(join(f.packageDir, 'src/index.ts'), "export default 'changed'\n")

    const result = spawnSync(process.execPath, [fingerprintHelper, 'record', f.profile, 'enpoi-one', expected], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('source inputs changed during build')
    expect(readFileSync(fingerprintPath(f), 'utf8')).toBe(previousFingerprint)
  })

  it('rejects source symlinks instead of ignoring them', () => {
    const f = fixture()
    expect(runBuild(f).status).toBe(0)
    const bundle = join(f.packageDir, 'lib/index.js')
    const previousBundle = readFileSync(bundle, 'utf8')
    const previousFingerprint = readFileSync(fingerprintPath(f), 'utf8')
    symlinkSync(join(f.packageDir, 'src/data.json'), join(f.packageDir, 'src/linked.ts'))

    const result = runBuild(f)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('source symlink is not supported')
    expect(invocations(f)).toHaveLength(1)
    expect(readFileSync(bundle, 'utf8')).toBe(previousBundle)
    expect(readFileSync(fingerprintPath(f), 'utf8')).toBe(previousFingerprint)
  })

  it('keeps paths with spaces as single argv entries', () => {
    const f = fixture({ spaces: true })
    writeFileSync(join(f.packageDir, 'src/nested data.json'), '{"value":2}\n')
    writeFileSync(join(f.packageDir, 'src/index.ts'), "import data from './nested data.json'\nexport default data.value\n")

    const result = runBuild(f)
    expect(result.status).toBe(0)
    const calls = invocations(f)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cwd).toBe(f.packageDir)
    const outfile = calls[0]?.args.find(arg => arg.startsWith('--outfile='))
    expect(outfile).toBeDefined()
    expect(outfile?.slice('--outfile='.length).startsWith(f.profile)).toBe(true)
    expect(existsSync(join(f.packageDir, 'lib/index.js'))).toBe(true)
  })
})
