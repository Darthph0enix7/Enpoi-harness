/**
 * scripts/update-catalog.mjs: the per-channel update catalog generator
 * (docs/plan/ui-update-manifest.md P1).
 *
 * Every case builds a throwaway git repository under a unique mkdtemp
 * directory (parallel-safe) with deterministic committer dates, then asserts
 * the catalog contract: newest first, notes from the range since the previous
 * release tag, merge/noise subjects skipped, idempotent upsert, and the
 * 40-release cap.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  buildCatalog,
  loadExistingCatalog,
  parseExistingCatalog,
  type UpdateCatalog,
} from './update-catalog.mjs'

const script = join(import.meta.dirname, 'update-catalog.mjs')
const cleanups: string[] = []
let stamp = 0

/** One strictly increasing ISO date per use. */
function nextDate(): string {
  stamp += 1
  return new Date(Date.UTC(2026, 0, 1, 0, 0, stamp)).toISOString()
}

/** One throwaway repository or scratch directory. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-update-catalog-spec-'))
  cleanups.push(dir)
  return dir
}

/** Run git in `dir`; throw with stderr on failure. */
function git(dir: string, args: string[]): string {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: nextDate(),
      GIT_COMMITTER_DATE: nextDate(),
    },
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function initRepo(): string {
  const dir = scratch()
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  git(dir, ['config', 'tag.gpgsign', 'false'])
  return dir
}

function commit(dir: string, subject: string): void {
  const file = `file-${stamp + 1}.txt`
  writeFileSync(join(dir, file), `${subject}\n`)
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '--no-gpg-sign', '-m', subject])
}

function tag(dir: string, name: string): void {
  git(dir, ['tag', name])
}

function catalogRepo(rows: { subject: string; tag: string }[]): string {
  const dir = initRepo()
  for (const row of rows) {
    commit(dir, row.subject)
    tag(dir, row.tag)
  }
  return dir
}

afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
})

describe('buildCatalog', () => {
  it('first run with no catalog produces one entry with the full subject list', () => {
    const dir = initRepo()
    commit(dir, 'feat(a): first')
    commit(dir, 'fix(b): second')
    commit(dir, 'chore(c): third')
    tag(dir, 'v0.1.7-enpoi.2.1')
    const catalog = buildCatalog({ repo: dir, channel: 'stable' })
    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.channel).toBe('stable')
    expect(catalog.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(catalog.releases).toHaveLength(1)
    const [entry] = catalog.releases
    expect(entry?.version).toBe('0.1.7-enpoi.2.1')
    expect(entry?.commit).toMatch(/^[0-9a-f]{7}$/)
    expect(entry?.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    // No previous tag: the last-50 fallback still covers this short history.
    expect(entry?.notes).toEqual(['chore(c): third', 'fix(b): second', 'feat(a): first'])
  })

  it('prepends a new tag above the existing entries, with notes since the previous tag', () => {
    const dir = catalogRepo([{ subject: 'release one work', tag: 'v0.1.7-enpoi.2.1' }])
    const first = buildCatalog({ repo: dir, channel: 'stable' })
    commit(dir, 'release two work')
    tag(dir, 'v0.1.7-enpoi.2.2')
    const second = buildCatalog({ repo: dir, channel: 'stable', tag: 'v0.1.7-enpoi.2.2', existing: first })
    expect(second.releases.map(entry => entry.version)).toEqual(['0.1.7-enpoi.2.2', '0.1.7-enpoi.2.1'])
    expect(second.releases[0]?.notes).toEqual(['release two work'])
    expect(second.releases[1]?.notes).toEqual(['release one work'])
  })

  it('re-running for the same tag replaces that entry instead of duplicating it', () => {
    const dir = catalogRepo([{ subject: 'first work', tag: 'v0.1.7-enpoi.2.1' }])
    const first = buildCatalog({ repo: dir, channel: 'stable' })
    commit(dir, 'second work')
    tag(dir, 'v0.1.7-enpoi.2.2')
    const second = buildCatalog({ repo: dir, channel: 'stable', tag: 'v0.1.7-enpoi.2.2', existing: first })
    const rerun = buildCatalog({ repo: dir, channel: 'stable', tag: 'v0.1.7-enpoi.2.2', existing: second })
    expect(rerun.releases).toEqual(second.releases)
  })

  it('recomputes an entry whose tag moved, keeping its position', () => {
    const dir = catalogRepo([{ subject: 'first work', tag: 'v0.1.7-enpoi.2.1' }])
    const first = buildCatalog({ repo: dir, channel: 'stable' })
    commit(dir, 'second work')
    tag(dir, 'v0.1.7-enpoi.2.2')
    const second = buildCatalog({ repo: dir, channel: 'stable', tag: 'v0.1.7-enpoi.2.2', existing: first })
    git(dir, ['tag', '-d', 'v0.1.7-enpoi.2.2'])
    commit(dir, 'moved tag work')
    tag(dir, 'v0.1.7-enpoi.2.2')
    const replaced = buildCatalog({ repo: dir, channel: 'stable', tag: 'v0.1.7-enpoi.2.2', existing: second })
    expect(replaced.releases.map(entry => entry.version)).toEqual(['0.1.7-enpoi.2.2', '0.1.7-enpoi.2.1'])
    expect(replaced.releases[0]?.commit).not.toBe(second.releases[0]?.commit)
    expect(replaced.releases[0]?.notes).toEqual(['moved tag work', 'second work'])
  })

  it('caps the catalog at 40 releases, newest first', () => {
    const dir = catalogRepo([{ subject: 'base', tag: 'v0.1.7-enpoi.2.1' }])
    const fabricated = Array.from({ length: 40 }, (_, index) => ({
      version: `0.1.7-enpoi.2.${139 - index}`,
      commit: '0000000',
      releasedAt: '2026-01-01T00:00:00.000Z',
      notes: [] as string[],
    }))
    const existing: UpdateCatalog = {
      schemaVersion: 1,
      channel: 'stable',
      generatedAt: '2026-01-01T00:00:00.000Z',
      releases: fabricated,
    }
    commit(dir, 'newest actual work')
    tag(dir, 'v0.1.7-enpoi.2.200')
    const catalog = buildCatalog({ repo: dir, channel: 'stable', tag: 'v0.1.7-enpoi.2.200', existing })
    expect(catalog.releases).toHaveLength(40)
    expect(catalog.releases[0]?.version).toBe('0.1.7-enpoi.2.200')
    expect(catalog.releases[39]?.version).toBe('0.1.7-enpoi.2.101')
  })

  it('skips merge commits and noise subjects', () => {
    const dir = initRepo()
    commit(dir, 'feat: base work')
    git(dir, ['checkout', '-q', '-b', 'side'])
    commit(dir, 'fix: side work')
    git(dir, ['checkout', '-q', 'main'])
    commit(dir, '[skip ci] chore: bump')
    git(dir, ['merge', '-q', '--no-ff', '-m', "Merge branch 'side'", 'side'])
    tag(dir, 'v0.1.7-enpoi.2.1')
    const catalog = buildCatalog({ repo: dir, channel: 'stable' })
    const notes = catalog.releases[0]?.notes ?? []
    expect(notes).toContain('feat: base work')
    expect(notes).toContain('fix: side work')
    expect(notes.some(note => note.startsWith('Merge '))).toBe(false)
    expect(notes.some(note => note.startsWith('[skip ci]'))).toBe(false)
  })

  it('treats a malformed existing catalog as absent', () => {
    expect(parseExistingCatalog('{ not json')).toBeNull()
    expect(parseExistingCatalog('{"releases": "nope"}')).toBeNull()
    const file = join(scratch(), 'catalog.json')
    writeFileSync(file, '{ broken')
    expect(loadExistingCatalog(file)).toBeNull()
    expect(loadExistingCatalog(join(file, '..', 'missing.json'))).toBeNull()
  })

  it('rejects an unknown channel and a non-release tag', () => {
    const dir = catalogRepo([{ subject: 'work', tag: 'v0.1.7-enpoi.2.1' }])
    expect(() => buildCatalog({ repo: dir, channel: 'gamma' })).toThrow(/stable or beta/)
    expect(() => buildCatalog({ repo: dir, channel: 'stable', tag: 'backup/old' })).toThrow(/release tag/)
  })
})

describe('update-catalog CLI', () => {
  it('writes the catalog file and rejects an unknown channel', () => {
    const dir = catalogRepo([{ subject: 'cli work', tag: 'v0.1.7-enpoi.2.1' }])
    const out = join(scratch(), 'catalog.json')
    const ok = spawnSync(process.execPath, [
      script, '--channel', 'stable', '--tag', 'v0.1.7-enpoi.2.1', '--repo', dir, '--out', out,
    ], { encoding: 'utf8' })
    expect(ok.status).toBe(0)
    const document = JSON.parse(readFileSync(out, 'utf8')) as UpdateCatalog
    expect(document.channel).toBe('stable')
    expect(document.releases).toHaveLength(1)
    expect(document.releases[0]?.version).toBe('0.1.7-enpoi.2.1')

    const bad = spawnSync(process.execPath, [script, '--channel', 'gamma', '--repo', dir, '--out', out], { encoding: 'utf8' })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('stable or beta')
  })

  it('prints to stdout when --out is omitted', () => {
    const dir = catalogRepo([{ subject: 'stdout work', tag: 'v0.1.7-enpoi.2.1' }])
    const result = spawnSync(process.execPath, [script, '--channel', 'beta', '--repo', dir], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    const document = JSON.parse(result.stdout) as UpdateCatalog
    expect(document.channel).toBe('beta')
    expect(document.releases).toHaveLength(1)
  })

  it('starts from an empty catalog when --in is malformed', () => {
    const dir = catalogRepo([{ subject: 'work', tag: 'v0.1.7-enpoi.2.1' }])
    const broken = join(scratch(), 'broken.json')
    writeFileSync(broken, '{ broken')
    const out = join(scratch(), 'out.json')
    const result = spawnSync(process.execPath, [
      script, '--channel', 'stable', '--repo', dir, '--in', broken, '--out', out,
    ], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('malformed')
    const document = JSON.parse(readFileSync(out, 'utf8')) as UpdateCatalog
    expect(document.releases).toHaveLength(1)
  })
})
