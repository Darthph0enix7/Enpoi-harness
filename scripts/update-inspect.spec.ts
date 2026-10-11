/**
 * scripts/update-inspect.mjs: the read-only `ds update --dry-run` planner.
 *
 * Every case runs the planner against fixture trees built under unique
 * mkdtemp directories (parallel-safe), asserts classification and ladder
 * decisions against hand-built or generated release metadata, and proves the
 * dry run performs no writes by snapshotting the fixture tree before and after.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'

import type { InspectionRelease, InspectionReport } from './update-inspect.d.mts'
import type { ReleaseManifestDocument, ReleaseManifestEntry } from './release-delta.d.mts'

import { buildManifest } from './release-delta.mjs'
import { INSPECTION_SCHEMA, buildReport, classifyLocal, compareManifests, diffAsset, formatReport, fullAsset, globToRegExp, parseManifestBuffer, planLadder, readPathList, statTree } from './update-inspect.mjs'

const root = join(import.meta.dirname, '..')
const win32 = process.platform === 'win32'
const cleanups: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-inspect-spec-'))
  cleanups.push(dir)
  return dir
}

function write(dir: string, rel: string, content: string, mode = 0o644): string {
  const file = join(dir, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

function manifestFor(entries: ReleaseManifestEntry[]): ReleaseManifestDocument {
  return { schema: 'dsh-release-manifest/1', version: 'v', platform: 'linux-x64', entries }
}

function release(version: string, assets: Record<string, number>): InspectionRelease {
  return { tag: `v${version}`, version, assets: new Map(Object.entries(assets)), urls: new Map(), createdAt: null }
}

/** Recursive lstat snapshot: proves the planner left the tree untouched. */
function snapshot(dir: string): string {
  const lines: string[] = []
  const walk = (rel: string) => {
    const abs = rel ? join(dir, rel) : dir
    for (const name of readdirSync(abs).sort()) {
      const relPath = rel ? `${rel}/${name}` : name
      const st = lstatSync(join(dir, relPath))
      lines.push(`${relPath}\t${st.mode}\t${st.size}\t${st.mtimeMs}`)
      if (st.isDirectory()) walk(relPath)
    }
  }
  walk('')
  return lines.join('\n')
}

describe('planLadder', () => {
  const platform = 'linux-x64'

  it('chooses rung 1 when the target release carries the direct diff', () => {
    const ladder = planLadder({
      releases: [release('0.1.7-enpoi.2.99', {
        [diffAsset(platform, '0.1.7-enpoi.2.98', '0.1.7-enpoi.2.99')]: 4096,
        [fullAsset('0.1.7-enpoi.2.99', platform)]: 319313407,
      })],
      platform,
      from: '0.1.7-enpoi.2.98',
      to: '0.1.7-enpoi.2.99',
    })
    expect(ladder).toMatchObject({ rung: 1, kind: 'consecutive-diff', downloadBytes: 4096 })
    expect(ladder.chain).toEqual([diffAsset(platform, '0.1.7-enpoi.2.98', '0.1.7-enpoi.2.99')])
  })

  it('chooses rung 2 for a verified chain of three consecutive diffs', () => {
    const diff = (from: string, to: string) => ({ [diffAsset(platform, from, to)]: 1000 })
    const ladder = planLadder({
      releases: [
        release('...97', { ...diff('...96', '...97'), [fullAsset('...97', platform)]: 9000 }),
        release('...96', { ...diff('...95', '...96') }),
        release('...95', { ...diff('...94', '...95') }),
        release('...94', {}),
      ],
      platform,
      from: '...94',
      to: '...97',
    })
    expect(ladder.rung).toBe(2)
    expect(ladder.chain).toHaveLength(3)
    expect(ladder.downloadBytes).toBe(3000)
    // Each chain asset lives on the release it updates to; the apply side
    // fetches every hop from its own release with this parallel array.
    expect(ladder.chainTags).toEqual(['...97', '...96', '...95'])
  })

  it('names the target release for a direct diff', () => {
    const ladder = planLadder({
      releases: [release('b', { [diffAsset('linux-x64', 'a', 'b')]: 10 })],
      platform: 'linux-x64',
      from: 'a',
      to: 'b',
    })
    expect(ladder.chainTags).toEqual(['b'])
  })

  it('falls back to rung 3 when the first chain link is missing and never guesses', () => {
    const ladder = planLadder({
      releases: [
        release('...97', { [fullAsset('...97', platform)]: 9000 }),
        release('...96', {}),
      ],
      platform,
      from: '...96',
      to: '...97',
    })
    expect(ladder.rung).toBe(3)
    expect(ladder.kind).toBe('full-tarball')
    expect(ladder.reason).toContain('full tarball')
    expect(ladder.downloadBytes).toBe(9000)
  })

  it('falls back to rung 3 beyond three hops', () => {
    const diff = (from: string, to: string) => ({ [diffAsset(platform, from, to)]: 1000 })
    const ladder = planLadder({
      releases: [
        release('...99', { ...diff('...98', '...99'), [fullAsset('...99', platform)]: 9000 }),
        release('...98', { ...diff('...97', '...98') }),
        release('...97', { ...diff('...96', '...97') }),
        release('...96', { ...diff('...95', '...96') }),
        release('...95', {}),
      ],
      platform,
      from: '...95',
      to: '...99',
    })
    expect(ladder.rung).toBe(3)
    expect(ladder.reason).toContain('within 3 hops')
  })

  it('reports rung 0 for an installed version that is the newest release', () => {
    const ladder = planLadder({ releases: [release('x', {})], platform, from: 'x', to: 'x' })
    expect(ladder.rung).toBe(0)
    expect(ladder.downloadBytes).toBe(0)
  })
})

describe('manifest reading', () => {
  function gz(doc: object): Buffer {
    return zlib.gzipSync(Buffer.from(JSON.stringify(doc)))
  }
  const entry = (extra: object = {}): object => ({ path: 'ok.txt', type: 'file', mode: '0644', size: 1, sha256: 'a'.repeat(64), target: null, binary: false, ...extra })
  const doc = (e: object): object => ({ schema: 'dsh-release-manifest/1', version: 'v', platform: 'p', entries: [e] })

  it('validates paths and entry fields before any value is used', () => {
    expect(parseManifestBuffer(gz(doc(entry()))).entries).toHaveLength(1)
    for (const path of ['../evil', '/abs', 'a\\b', 'a\nb', 'a\u0001b', 'a//b']) {
      expect(() => parseManifestBuffer(gz(doc(entry({ path }))))).toThrow()
    }
    expect(() => parseManifestBuffer(gz(doc(entry({ size: -1 }))))).toThrow()
    expect(() => parseManifestBuffer(gz(doc(entry({ mode: 'zzz' }))))).toThrow()
    expect(() => parseManifestBuffer(gz(doc(entry({ binary: 'yes' }))))).toThrow()
    expect(() => parseManifestBuffer(gz(doc(entry({ type: 'fifo' }))))).toThrow()
    expect(() => parseManifestBuffer(gz(doc(entry({ type: 'symlink', target: null }))))).toThrow()
    expect(() => parseManifestBuffer(gz({ schema: 'other/1', entries: [] }))).toThrow()
    expect(() => parseManifestBuffer(Buffer.from('not json'))).toThrow()
  })
})

describe('local classification', () => {
  it.skipIf(win32)('separates modified, mode-only, missing, untracked, and installer state', () => {
    const dir = scratch()
    write(dir, 'keep.txt', 'keep\n')
    write(dir, 'edited.txt', 'original\n')
    write(dir, 'modeonly.txt', 'same\n', 0o644)
    write(dir, 'deleted.txt', 'bye\n')
    symlinkSync('keep.txt', join(dir, 'link'))

    const baseline = buildManifest(dir)

    write(dir, 'edited.txt', 'original content grew\n')
    chmodSync(join(dir, 'modeonly.txt'), 0o755)
    rmSync(join(dir, 'deleted.txt'))
    write(dir, 'untracked.bin', 'user data\n')
    write(dir, '.dsh-install-complete', '{"version":"x"}\n')
    rmSync(join(dir, 'link'))
    symlinkSync('modeonly.txt', join(dir, 'link'))

    const result = classifyLocal(dir, statTree(dir), baseline)
    expect(result.modified.map((item: { path: string }) => item.path).sort()).toEqual(['edited.txt', 'link'])
    expect(result.modeOnly).toEqual([{ path: 'modeonly.txt', oldMode: '0644', newMode: '0755' }])
    expect(result.missing).toEqual(['deleted.txt'])
    expect(result.untracked).toEqual(['untracked.bin'])
    expect(result.installerState).toEqual(['.dsh-install-complete'])
  })
})

describe('buildReport', () => {
  function fixture(): {
    installedTree: string
    baseline: ReleaseManifestDocument
    target: ReleaseManifestDocument
    releases: InspectionRelease[]
    pins: string
    tombstones: string
  } {
    const installedTree = scratch()
    write(installedTree, 'keep.txt', 'keep\n')
    write(installedTree, 'edited.txt', 'shipped v1\n')
    write(installedTree, 'removed-clean.txt', 'old\n')
    write(installedTree, 'removed-edited.txt', 'ship\n')
    write(installedTree, 'removed-pinned.txt', 'pin me\n')
    const baseline = manifestFor(buildManifest(installedTree))

    // The locally modified install: edited.txt and removed-edited.txt diverge,
    // an untracked notes file appears, installer state is written.
    write(installedTree, 'edited.txt', 'locally edited!\n')
    write(installedTree, 'removed-edited.txt', 'locally edited!\n')
    write(installedTree, 'my-notes.txt', 'untracked\n')
    write(installedTree, '.dsh-install-complete', '{"version":"a"}\n')

    // Target release tree: keep + edited change, new.txt arrives, three files removed.
    const targetTree = scratch()
    write(targetTree, 'keep.txt', 'keep\n')
    write(targetTree, 'edited.txt', 'shipped v2\n')
    write(targetTree, 'new.txt', 'new file\n')
    const target = manifestFor(buildManifest(targetTree))

    const platform = 'linux-x64'
    const releases = [release('b', {
      [diffAsset(platform, 'a', 'b')]: 2048,
      [fullAsset('b', platform)]: 100000,
    })]
    const pins = join(scratch(), 'pins.yaml')
    writeFileSync(pins, 'paths:\n  - removed-pinned.txt\n')
    const tombstones = join(scratch(), 'tombstones.txt')
    writeFileSync(tombstones, '')
    return { installedTree, baseline, target, releases, pins, tombstones }
  }

  it('reports ladder, changed, applicable deletions, local state, and pins without writing', () => {
    const { installedTree, baseline, target, releases, pins, tombstones } = fixture()
    const before = snapshot(installedTree)
    const report = buildReport({
      channel: 'stable',
      platform: 'linux-x64',
      tag: 'vb',
      toVersion: 'b',
      fromVersion: 'a',
      treeDir: installedTree,
      targetManifest: target,
      baselineManifest: baseline,
      baselineAsset: 'manifest-linux-x64-a.json.gz',
      releases,
      pinsPath: pins,
      tombstonePaths: [tombstones],
      limit: 10,
    })
    expect(snapshot(installedTree)).toBe(before)

    expect(report.schema).toBe(INSPECTION_SCHEMA)
    expect(report.ladder).toMatchObject({ rung: 1, downloadBytes: 2048, fullTarball: { bytes: 100000 } })
    expect(report.changed.available).toBe(true)
    expect(report.changed.count).toBe(2) // edited.txt content, new.txt
    expect(report.changed.bytes).toBe(11 + 9)
    expect(report.deletions.candidates).toBe(3)
    expect(report.deletions.applicable).toBe(1) // removed-clean.txt only
    expect(report.deletions.applicableSample).toEqual(['removed-clean.txt'])
    expect(report.deletions.kept).toBe(2) // removed-edited.txt (modified), removed-pinned.txt (pinned)
    expect(report.pins.matched).toEqual(['removed-pinned.txt'])
    expect(report.localChanges.counts).toMatchObject({ modified: 2, missing: 0, untracked: 1, installerState: 1 })
    expect(report.localChanges.untracked).toEqual(['my-notes.txt'])
    expect(report.localChanges.installerState).toEqual(['.dsh-install-complete'])

    const parsed = JSON.parse(formatReport(report, { json: true })) as InspectionReport
    expect(parsed.schema).toBe(INSPECTION_SCHEMA)
    expect(parsed.ladder.rung).toBe(1)
    const human = formatReport(report, { json: false })
    expect(human).toContain('rung 1')
    expect(human).toContain('my-notes.txt')
    expect(human).toContain('would delete: removed-clean.txt')
    expect(human).toContain('kept: removed-pinned.txt (pinned)')
  })

  it('stays honest when the baseline manifest is unavailable', () => {
    const { installedTree, target, releases, pins, tombstones } = fixture()
    const report = buildReport({
      channel: 'stable',
      platform: 'linux-x64',
      tag: 'vb',
      toVersion: 'b',
      fromVersion: 'a',
      treeDir: installedTree,
      targetManifest: target,
      baselineManifest: null,
      baselineAsset: 'manifest-linux-x64-a.json.gz',
      baselineNote: 'baseline manifest unavailable (HTTP 404)',
      releases,
      pinsPath: pins,
      tombstonePaths: [tombstones],
      limit: 10,
    })
    expect(report.changed.available).toBe(false)
    expect(report.deletions.available).toBe(false)
    expect(report.deletions.applicable).toBeNull()
    expect(report.localChanges.available).toBe(false)
    expect(report.baseline.note).toContain('404')
    expect(formatReport(report, { json: false })).toContain('not classified')
  })

  it('stays honest when the target release predates manifest emission', () => {
    const { installedTree, baseline, releases, pins, tombstones } = fixture()
    const report = buildReport({
      channel: 'stable',
      platform: 'linux-x64',
      tag: 'vb',
      toVersion: 'b',
      fromVersion: 'a',
      treeDir: installedTree,
      targetManifest: null,
      targetManifestNote: 'target manifest manifest-linux-x64-b.json.gz unavailable (HTTP 404)',
      baselineManifest: baseline,
      baselineAsset: 'manifest-linux-x64-a.json.gz',
      releases,
      pinsPath: pins,
      tombstonePaths: [tombstones],
      limit: 10,
    })
    expect(report.changed.available).toBe(false)
    expect(report.localChanges.available).toBe(true) // baseline still classifies the local tree
    expect(report.notes.join(' ')).toContain('HTTP 404')
  })
})

describe('path lists', () => {
  it('parses YAML rows and plain lines, and globs match like path specs', () => {
    const dir = scratch()
    const file = join(dir, 'pins.yaml')
    writeFileSync(file, '# comment\npaths:\n  - config/*.yaml\n  - "deep/**/x.js"\nbare.txt\n')
    const list = readPathList(file)
    expect(list.entries).toEqual(['config/*.yaml', 'deep/**/x.js', 'bare.txt'])
    expect(globToRegExp('config/*.yaml').test('config/a.yaml')).toBe(true)
    expect(globToRegExp('config/*.yaml').test('config/sub/a.yaml')).toBe(false)
    expect(globToRegExp('deep/**/x.js').test('deep/a/b/x.js')).toBe(true)
    expect(readPathList(join(dir, 'missing.yaml'))).toEqual({ path: join(dir, 'missing.yaml'), present: false, entries: [] })
  })
})

describe('install.sh dry-run wiring', () => {
  it.skipIf(win32)('finds the local module and appends the inspection to --json output', () => {
    const dir = scratch()
    const probe = join(dir, 'probe.sh')
    writeFileSync(
      probe,
      [
        'export DSH_INSTALL_LIB_ONLY=1',
        '. "$INSTALL_SH" >/dev/null 2>&1',
        'module="$(update_inspect_module)"',
        'printf "module=%s\\n" "${module##*/}"',
        'JSON_OUT=1',
        'DRY_RUN=1',
        'DRY_INSPECTION_JSON=\'{"available": false, "note": "test"}\'',
        'emit_json update 1',
      ].join('\n'),
    )
    const result = spawnSync('bash', [probe], {
      env: { ...process.env, INSTALL_SH: join(root, 'scripts/install.sh'), REPO_ROOT: root },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('module=update-inspect.mjs')
    const json = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
    expect(json).toMatchObject({ action: 'update', dryRun: 1, inspection: { available: false, note: 'test' } })
  })
})

describe('compareManifests', () => {
  it('matches the release diff generator classification', () => {
    const tree = scratch()
    write(tree, 'a.txt', 'a\n')
    const base = buildManifest(tree)
    write(tree, 'a.txt', 'a changed\n')
    write(tree, 'b.txt', 'b\n')
    const next = buildManifest(tree)
    const diff = compareManifests(base, next)
    expect(diff.changed.map((entry: { path: string }) => entry.path)).toEqual(['a.txt', 'b.txt'])
    expect(diff.deleted).toEqual([])
  })
})

afterAll(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})
