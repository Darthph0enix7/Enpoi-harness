import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'
import { seedWorkerProfile, workerManifest, workerBundleDirectory } from './worker-profile.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

it('keeps the two human profile files byte-identical', () => {
  expect(sha(readFileSync(join(repo, 'profile/web/package.json')))).toBe('a22e98419aed0d753d5e987b7686506f15362855766c26dcd172670ab45abee1')
  expect(sha(readFileSync(join(repo, 'profile/web/cordis.patch.yml')))).toBe('b113b4a0c4344bc581054bcddec5ca77f5be118dd1c08e2da846c7e7f1a12ff6')
})

it('requires a version change for any modification to the knowledge manifest', () => {
  const manifest = workerManifest(repo)
  const versions: Record<number, string> = { 1: '52c06aba6ebc556e94c22e30af71a2728c9f60d760cd2bc02728076107838958' }
  expect(sha(readFileSync(join(workerBundleDirectory(repo), 'knowledge-tools.json')))).toBe(versions[manifest.version])
  expect(manifest.tools.map(tool => tool.name)).toEqual(['knowledge_search', 'knowledge_facts'])
})

it('keeps worker-only packages out of the human profile workspace during seed and refresh', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-worker-copy-'))
  try {
    const source = join(scratch, 'src')
    for (const packageName of ['enpoi-jarvis-worker', 'enpoi-job-guard', 'enpoi-worker-credentials', 'enpoi-human']) {
      const dir = join(source, 'packages', packageName)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), '{}\n')
    }
    const script = 'installer="$1"; src="$2"; dst="$3"; set --; . "$installer"; copy_profile_tree "$src" "$dst" seed && copy_profile_tree "$src" "$dst" refresh'
    const copied = spawnSync('bash', ['-c', script, 'worker-test', join(repo, 'scripts/install.sh'), source, join(scratch, 'web')], {
      env: { HOME: scratch, DSH_HOME: scratch, PATH: process.env.PATH, DSH_INSTALL_LIB_ONLY: '1' }, encoding: 'utf8',
    })
    expect(copied.status, copied.stderr).toBe(0)
    expect(readFileSync(join(scratch, 'web/packages/enpoi-human/package.json'), 'utf8')).toBe('{}\n')
    expect(() => lstatSync(join(scratch, 'web/packages/enpoi-jarvis-worker'))).toThrow(/ENOENT/u)
    expect(() => lstatSync(join(scratch, 'web/packages/enpoi-job-guard'))).toThrow(/ENOENT/u)
    expect(() => lstatSync(join(scratch, 'web/packages/enpoi-worker-credentials'))).toThrow(/ENOENT/u)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

it('selects only the version-owned worker composition and refuses overlay or release changes in an existing attempt', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-worker-profile-'))
  try {
    const home = join(scratch, 'attempt')
    mkdirSync(home, { mode: 0o700 })
    const seeded = spawnSync('bash', [join(repo, 'scripts/install.sh'), '--seed-worker', home], {
      env: { HOME: scratch, DSH_HOME: home, PATH: process.env.PATH }, encoding: 'utf8',
    })
    expect(seeded.stderr).toBe('')
    expect(seeded.status).toBe(0)
    const selected = seedWorkerProfile(repo, home)
    expect(lstatSync(selected).mode & 0o777).toBe(0o700)
    expect(readlinkSync(join(selected, 'node_modules/dsh-enpoi-jarvis-worker'))).toBe(workerBundleDirectory(repo))
    expect(seedWorkerProfile(repo, home)).toBe(selected)
    const loaded = loadProfile('dsh', 'jarvis-worker', join(repo, 'apps/cli/package.json'), home)
    expect(loaded.skippedBundles).toEqual([])
    expect(loaded.layers.map(layer => layer.packageName)).toEqual(['dsh-enpoi-jarvis-worker'])
    const entries = composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches])
    const ids = entries.filter(row => row.disabled !== true).map(row => row.id)
    expect(ids).toEqual([
      'llm', 'session', 'system-prompt', 'tools', 'agent', 'agent-loop',
      'agent-default-model', 'session-persistence-jsonl', 'session-projection', 'session-query-sqlite',
      'session-checkpoint-policy', 'token-meter', 'storage', 'storage-json', 'storage-domain', 'workspace',
      'approval', 'user-questions', 'sandbox-policy', 'fs-sandbox', 'commands', 'attachment-local',
      'credentials', 'connection', 'file-upload', 'typert', 'typert-loader', 'typert-gateway', 'session-controller',
      'api-remotes', 'peer-api', 'agent-preset-registry', 'worker-runtime', 'llm-pi-ai', 'worker-credentials',
      'worker-mcp', 'worker-job-guard', 'preset-jarvis-worker',
    ])
    writeFileSync(join(home, 'cordis.patch.yml'), '[]\n')
    expect(() => seedWorkerProfile(repo, home)).toThrow(/unexpected home override/u)
    rmSync(join(home, 'cordis.patch.yml'))
    const link = join(selected, 'node_modules/dsh-enpoi-jarvis-worker')
    rmSync(link)
    symlinkSync(scratch, link)
    expect(() => seedWorkerProfile(repo, home)).toThrow(/another release/u)
    expect(readlinkSync(link)).toBe(scratch)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
