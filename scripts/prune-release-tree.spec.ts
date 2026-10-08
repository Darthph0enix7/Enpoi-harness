import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'

/**
 * Behavior guard for `scripts/prune-release-tree.sh`: which weight the prebuilt
 * harness asset drops, and which trees must survive (the updater's `scripts/`,
 * the unresolved `apps/desktop*` consumers, `.agents/skills`, LICENSE files,
 * and every runtime module). harness-release.yml runs this script and then
 * smoke-boots the pruned tree, so a wrong deletion here surfaces as a red
 * release too; this spec pins the categories without needing a built tree.
 */

const script = join(dirname(fileURLToPath(import.meta.url)), 'prune-release-tree.sh')

let root: string
let tree: string

function write(relative: string, contents = ''): void {
  const path = join(tree, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function exists(relative: string): boolean {
  return existsSync(join(tree, relative))
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-prune-'))
  tree = join(root, 'dsh-harness-1.2.3')

  // Removed: VCS and non-runtime trees.
  write('.git/config', '[core]\n')
  write('docs/architecture.md', '# doc\n')
  write('snapshots/case/expected.txt', 'x\n')
  write('benchmarks/bench.ts', 'x\n')
  write('python/README.md', 'x\n')
  write('website/index.md', 'x\n')
  write('dist/out.js', 'x\n')
  write('coverage/lcov.info', 'x\n')

  // Removed: source maps and incremental build metadata.
  write('tsconfig.host.tsbuildinfo', '{}')
  write('packages/foo/lib/index.js.map', '{}')
  write('apps/web/dist/assets/index.js.map', '{}')
  write('node_modules/dep/index.js.map', '{}')
  write('profile/web/node_modules/openai/internal/line.mjs.map', '{}')
  write('apps/web/dist/index.html', '<html></html>\n')

  // Removed: committed specs and tests outside installed dependencies.
  write('packages/foo/src/index.js', 'code\n')
  write('packages/foo/src/foo.spec.ts', 'test\n')
  write('packages/foo/tests/foo.spec.ts', 'test\n')
  write('packages/foo/tests/fixture.json', '{}\n')
  write('apps/cli/src/command.spec.mjs', 'test\n')
  write('apps/cli/tests/fixtures/web-browser-open/register.mjs', '// fixture\n')
  write('profile/web/tests/scaffold.ts', 'test\n')
  write('profile/web/packages/enpoi-demo/tests/keeper.spec.ts', 'test\n')
  write('lib/desktop-keyboard-test-types/tests/types.spec.ts', 'test\n')

  // Removed: Agent Notes (`.agents/skills` stays).
  write('.agents/notes/README.i18n.yaml', 'x\n')
  write('.agents/notes/implemented/process/note.md', 'x\n')
  write('.agents/skills/dsh-prose-standard/SKILL.md', '# skill\n')

  // Removed: installed-package docs. LICENSE files and runtime modules stay.
  write('node_modules/dep/index.js', 'code\n')
  write('node_modules/dep/README.md', '# readme\n')
  write('node_modules/dep/CHANGELOG.md', '# changes\n')
  write('node_modules/dep/HISTORY.md', '# history\n')
  write('node_modules/dep/LICENSE', 'MIT\n')
  write('node_modules/dep/license.txt', 'MIT\n')
  write('node_modules/dep/History.js', 'module.exports = 1\n')
  write('node_modules/dep/History.d.ts', 'export {}\n')
  write('profile/web/node_modules/openai/README.md', '# readme\n')
  write('profile/web/node_modules/openai/LICENSE', 'MIT\n')

  // Kept: the updater tree, the unresolved desktop consumers, and product files.
  write('scripts/install.sh', '#!/usr/bin/env bash\n')
  write('scripts/tests/install.spec.ts', 'test\n')
  write('scripts/install-profile-merge.spec.ts', 'test\n')
  write('apps/desktop/tests/desktop.spec.ts', 'test\n')
  write('apps/desktop/src/main.js', 'code\n')
  write('apps/desktop-host/tests/host.spec.ts', 'test\n')
  write('apps/desktop-host/src/host.js', 'code\n')
  write('apps/cli/lib/bin.js', '// bin\n')
  write('package.json', '{}\n')
  write('THIRD_PARTY_NOTICES.md', 'notices\n')

  const result = spawnSync('bash', [script, tree], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`prune-release-tree.sh failed (${result.status}):\n${result.stdout}${result.stderr}`)
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('prune-release-tree.sh', () => {
  it('removes the VCS, documentation, and build-output trees', () => {
    for (const path of ['docs', 'snapshots', 'benchmarks', 'python', 'website', 'dist', 'coverage', '.git', '.agents/notes']) {
      expect(exists(path), path).toBe(false)
    }
  })

  it('removes source maps and tsbuildinfo files everywhere, including node_modules', () => {
    for (const path of [
      'tsconfig.host.tsbuildinfo',
      'packages/foo/lib/index.js.map',
      'apps/web/dist/assets/index.js.map',
      'node_modules/dep/index.js.map',
      'profile/web/node_modules/openai/internal/line.mjs.map',
    ]) {
      expect(exists(path), path).toBe(false)
    }
  })

  it('removes committed specs and tests outside node_modules', () => {
    for (const path of [
      'packages/foo/src/foo.spec.ts',
      'apps/cli/src/command.spec.mjs',
      'apps/cli/tests',
      'packages/foo/tests',
      'profile/web/tests',
      'profile/web/packages/enpoi-demo/tests',
      'lib/desktop-keyboard-test-types/tests',
    ]) {
      expect(exists(path), path).toBe(false)
    }
  })

  it('removes installed-package docs without touching LICENSE files or runtime modules', () => {
    for (const path of ['node_modules/dep/README.md', 'node_modules/dep/CHANGELOG.md', 'node_modules/dep/HISTORY.md', 'profile/web/node_modules/openai/README.md']) {
      expect(exists(path), path).toBe(false)
    }
    for (const path of ['node_modules/dep/LICENSE', 'node_modules/dep/license.txt', 'node_modules/dep/History.js', 'node_modules/dep/History.d.ts', 'node_modules/dep/index.js', 'profile/web/node_modules/openai/LICENSE']) {
      expect(exists(path), path).toBe(true)
    }
  })

  it('keeps scripts/, apps/desktop*, .agents/skills, and product files', () => {
    for (const path of [
      'scripts/install.sh',
      'scripts/tests/install.spec.ts',
      'scripts/install-profile-merge.spec.ts',
      'apps/desktop/tests/desktop.spec.ts',
      'apps/desktop/src/main.js',
      'apps/desktop-host/tests/host.spec.ts',
      'apps/desktop-host/src/host.js',
      'apps/cli/lib/bin.js',
      '.agents/skills/dsh-prose-standard/SKILL.md',
      'apps/web/dist/index.html',
      'package.json',
      'THIRD_PARTY_NOTICES.md',
    ]) {
      expect(exists(path), path).toBe(true)
    }
  })

  it('fails with usage when the tree argument is missing or not a directory', () => {
    const missing = spawnSync('bash', [script], { encoding: 'utf8' })
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('usage: prune-release-tree.sh')
    const notDirectory = spawnSync('bash', [script, join(root, 'does-not-exist')], { encoding: 'utf8' })
    expect(notDirectory.status).toBe(2)
    expect(notDirectory.stderr).toContain('not a directory')
  })
})
