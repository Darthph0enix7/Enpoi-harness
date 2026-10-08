import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { resolveDshVersionLine } from '../src/version-identity.ts'

const gitAvailable = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/**
 * A fake managed install: the CLI module sits inside `home/harness/<tree>/apps/cli/lib`,
 * and the optional string is written verbatim to `harness/install-state.json`.
 */
async function managedInstall(state: string | undefined): Promise<{ home: string; moduleUrl: URL }> {
  const home = await tempDirectory('dsh-version-managed-')
  const moduleDirectory = join(home, 'harness', '0.1.7-enpoi.2.42', 'apps', 'cli', 'lib')
  await mkdir(moduleDirectory, { recursive: true })
  const moduleFile = join(moduleDirectory, 'bin.js')
  await writeFile(moduleFile, '')
  if (state !== undefined) await writeFile(join(home, 'harness', 'install-state.json'), state)
  return { home, moduleUrl: pathToFileURL(moduleFile) }
}

/** A source checkout whose module lives at `<root>/apps/cli/bin.js`. */
async function sourceCheckout(prefix: string): Promise<{ root: string; moduleUrl: URL }> {
  const root = await tempDirectory(prefix)
  const moduleDirectory = join(root, 'apps', 'cli')
  await mkdir(moduleDirectory, { recursive: true })
  const moduleFile = join(moduleDirectory, 'bin.js')
  await writeFile(moduleFile, '')
  return { root, moduleUrl: pathToFileURL(moduleFile) }
}

describe('resolveDshVersionLine', () => {
  it('reports the installed release identity from install-state.json', async () => {
    const { home, moduleUrl } = await managedInstall(JSON.stringify({
      version: '0.1.7-enpoi.2.42',
      commit: '6f4293f9f1e2d3c4b5a697887766554433221100',
      channel: 'stable',
    }))
    expect(resolveDshVersionLine({ packageVersion: '0.1.7-enpoi.2', home, moduleUrl }))
      .toBe('0.1.7-enpoi.2.42 (stable, commit 6f4293f)')
  })

  it('keeps whichever qualifiers the install record carries', async () => {
    const commitOnly = await managedInstall(JSON.stringify({ version: '1.0.0', commit: 'abcdef1234567890' }))
    expect(resolveDshVersionLine({ packageVersion: '0.1.7-enpoi.2', home: commitOnly.home, moduleUrl: commitOnly.moduleUrl }))
      .toBe('1.0.0 (commit abcdef1)')
    const channelOnly = await managedInstall(JSON.stringify({ version: '1.0.0', channel: 'beta' }))
    expect(resolveDshVersionLine({ packageVersion: '0.1.7-enpoi.2', home: channelOnly.home, moduleUrl: channelOnly.moduleUrl }))
      .toBe('1.0.0 (beta)')
  })

  it('falls back to the harness/current target and then the package version', async () => {
    const linked = await managedInstall(JSON.stringify({}))
    await symlink(
      join(linked.home, 'harness', '0.1.7-enpoi.2.42'),
      join(linked.home, 'harness', 'current'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    expect(resolveDshVersionLine({ packageVersion: '0.1.7-enpoi.2', home: linked.home, moduleUrl: linked.moduleUrl }))
      .toBe('0.1.7-enpoi.2.42 (installed)')

    const unlinked = await managedInstall(JSON.stringify({}))
    expect(resolveDshVersionLine({ packageVersion: '9.9.9', home: unlinked.home, moduleUrl: unlinked.moduleUrl }))
      .toBe('9.9.9 (installed)')
  })

  it('tolerates malformed, non-object, and blank install records', async () => {
    for (const state of ['{', '[]', 'null', JSON.stringify({ version: '  ', channel: 7, commit: null })]) {
      const { home, moduleUrl } = await managedInstall(state)
      expect(resolveDshVersionLine({ packageVersion: '9.9.9', home, moduleUrl })).toBe('9.9.9 (installed)')
    }
  })

  it('tolerates a managed tree whose home does not exist', async () => {
    const missingHome = join(tmpdir(), `dsh-version-missing-${process.pid}-${Date.now()}`)
    const moduleUrl = pathToFileURL(join(missingHome, 'harness', 'x', 'apps', 'cli', 'bin.js'))
    expect(resolveDshVersionLine({ packageVersion: '1.2.3', home: missingHome, moduleUrl }))
      .toBe('1.2.3 (installed)')
  })

  it.skipIf(!gitAvailable)('marks a source checkout with its repository commit', async () => {
    const { root, moduleUrl } = await sourceCheckout('dsh-version-source-')
    const git = (args: string[]) => spawnSync(
      'git',
      ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: root, encoding: 'utf8' },
    )
    expect(git(['init']).status).toBe(0)
    await writeFile(join(root, 'tracked.txt'), 'fixture\n')
    expect(git(['add', '.']).status).toBe(0)
    expect(git(['commit', '-m', 'fixture']).status).toBe(0)
    const commit = git(['rev-parse', '--short=7', 'HEAD']).stdout.trim()
    expect(commit).toMatch(/^[0-9a-f]{7,}$/u)
    expect(resolveDshVersionLine({ packageVersion: '1.2.3', home: await tempDirectory('dsh-version-source-home-'), moduleUrl }))
      .toBe(`1.2.3 (source checkout, commit ${commit})`)
  })

  it('marks a source checkout without a repository commit', async () => {
    const { moduleUrl } = await sourceCheckout('dsh-version-unversioned-')
    expect(resolveDshVersionLine({ packageVersion: '1.2.3', home: await tempDirectory('dsh-version-unversioned-home-'), moduleUrl }))
      .toBe('1.2.3 (source checkout)')
  })

  it('defaults the home from $DSH_HOME and the module from this process', async () => {
    const home = await tempDirectory('dsh-version-default-')
    vi.stubEnv('DSH_HOME', home)
    onTestFinished(() => { vi.unstubAllEnvs() })
    // This spec file lives in the repository, outside the fixture harness home.
    expect(resolveDshVersionLine({ packageVersion: '1.2.3' }))
      .toMatch(/^1\.2\.3 \(source checkout(, commit [0-9a-f]+)?\)$/u)
  })
})
