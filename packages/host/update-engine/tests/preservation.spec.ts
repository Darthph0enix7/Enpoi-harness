/**
 * The §3.3 preservation suite: each fixture drives plan + apply over real
 * temp trees and asserts that nothing the user added or changed is lost, that
 * sidecars carry the shipped/conflicted bytes, that reports are accurate, and
 * that qualified verification passes for every legitimately preserved path.
 */

import { chmod, lstat, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashBytes, scanTree } from '../src/manifest.ts'
import { entry, makeUpdateFixture, readStaged, runUpdate, writeTreeFile, type FileSpec, type UpdateFixture } from './fixture.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(
  label: string,
  base: Record<string, FileSpec>,
  release: Record<string, FileSpec>,
  edit?: (localRoot: string) => Promise<void>,
): Promise<UpdateFixture> {
  const built = await makeUpdateFixture(label, base, release, edit)
  roots.push(built.root)
  return built
}

describe('§3.3 preservation suite', () => {
  it('keeps an edited core file and reports it as preserved', async () => {
    const f = await fixture(
      'edited-core',
      { 'core/app.js': 'one\ntwo\nthree\n' },
      { 'core/app.js': 'one\ntwo\nthree\n', 'other.txt': 'v2\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'core/app.js'), 'one\nUSER\ntwo\nthree\n')
      },
    )
    const { plan, result, staging } = await runUpdate(f)
    expect(plan.actions.find(action => action.path === 'core/app.js')?.kind).toBe('keep-local')
    expect(result.status).toBe('applied')
    expect(result.verification?.ok).toBe(true)
    expect(entry(staging, 'core/app.js').sha256).toBe(f.local['core/app.js']?.sha256)
    expect(result.report.preserved.some(item => item.path === 'core/app.js')).toBe(true)
  })

  it('merges a both-changed config file with both edits present', async () => {
    const f = await fixture(
      'edited-merged',
      { 'cfg/app.conf': 'a=1\nb=2\nc=3\nd=4\n' },
      { 'cfg/app.conf': 'a=1\nb=2\nc=3\nd=RELEASE\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'cfg/app.conf'), 'a=1\nb=LOCAL\nc=3\nd=4\n')
      },
    )
    const { plan, result, staging } = await runUpdate(f)
    const action = plan.actions.find(candidate => candidate.path === 'cfg/app.conf')
    expect(action?.kind).toBe('merge')
    expect(action?.merge?.status).toBe('clean')
    expect(plan.conflicts).toHaveLength(0)
    expect(await readStaged(f.stagingRoot, 'cfg/app.conf')).toBe('a=1\nb=LOCAL\nc=3\nd=RELEASE\n')
    expect(entry(staging, 'cfg/app.conf').sha256).toBe(action?.outcome.sha256)
    expect(result.verification?.ok).toBe(true)
    expect(result.verification?.preservedChecked).toBe(1)
  })

  it('preserves added text and binary files', async () => {
    const f = await fixture(
      'added-files',
      { 'core.txt': 'x\n' },
      { 'core.txt': 'x\n' },
      async (localRoot) => {
        await writeTreeFile(localRoot, 'user/notes.txt', 'notes\n')
        await writeTreeFile(localRoot, 'user/blob.bin', Buffer.from([0x00, 0x11, 0x22]))
      },
    )
    const { result, staging } = await runUpdate(f)
    expect(result.status).toBe('applied')
    expect(entry(staging, 'user/notes.txt').sha256).toBe(hashBytes('notes\n'))
    expect(entry(staging, 'user/blob.bin').sha256).toBe(hashBytes(Buffer.from([0x00, 0x11, 0x22])))
    expect(result.verification?.untrackedPresent).toBe(3)
    expect(result.report.preserved.map(item => item.path)).toEqual(['user/blob.bin', 'user/notes.txt'])
  })

  it('preserves an added plugin package and skill', async () => {
    const f = await fixture(
      'added-plugin',
      { 'core.txt': 'x\n' },
      { 'core.txt': 'x\n' },
      async (localRoot) => {
        await writeTreeFile(localRoot, 'profiles/main/packages/my-plugin/package.json', '{"name":"my-plugin"}\n')
        await writeTreeFile(localRoot, 'profiles/main/packages/my-plugin/index.js', 'export default {}\n')
        await writeTreeFile(localRoot, 'skills/my-skill/SKILL.md', '# my skill\n')
      },
    )
    const { result, staging } = await runUpdate(f)
    expect(result.status).toBe('applied')
    expect(entry(staging, 'profiles/main/packages/my-plugin/index.js').sha256).toBe(hashBytes('export default {}\n'))
    expect(entry(staging, 'skills/my-skill/SKILL.md').sha256).toBe(hashBytes('# my skill\n'))
    expect(result.verification?.ok).toBe(true)
  })

  it('respects a tombstoned deletion and restores a missing path without one', async () => {
    const base = { 'core/gone.txt': 'v1\n', 'core/lost.txt': 'v1\n' }
    const release = { 'core/gone.txt': 'v2\n', 'core/lost.txt': 'v2\n' }
    const f = await fixture('tombstone-split', base, release, async (localRoot) => {
      await rm(join(localRoot, 'core/gone.txt'))
      await rm(join(localRoot, 'core/lost.txt'))
    })
    const { plan, result, staging } = await runUpdate(f, { tombstones: ['core/gone.txt'] })
    expect(plan.actions.find(action => action.path === 'core/gone.txt')?.kind).toBe('tombstone')
    expect(plan.actions.find(action => action.path === 'core/lost.txt')?.kind).toBe('restore')
    expect(staging['core/gone.txt']).toBeUndefined()
    expect(entry(staging, 'core/lost.txt').sha256).toBe(hashBytes('v2\n'))
    expect(result.verification?.ok).toBe(true)
    expect(result.verification?.tombstonesAbsent).toBe(1)
    expect(result.report.preserved.some(item => item.path === 'core/lost.txt')).toBe(false)
  })

  it('keeps local on a config conflict, writes the .new sidecar, and continues', async () => {
    const f = await fixture(
      'config-conflict',
      { 'cfg/app.yaml': 'a: 1\nb: 2\nc: 3\n' },
      { 'cfg/app.yaml': 'a: SHIPPED\nb: 2\nc: 3\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'cfg/app.yaml'), 'a: LOCAL\nb: 2\nc: 3\n')
      },
    )
    const { plan, result, staging } = await runUpdate(f)
    expect(result.status).toBe('applied')
    expect(plan.switchDecision).toBe('proceed')
    const conflict = plan.conflicts.find(item => item.path === 'cfg/app.yaml')
    expect(conflict?.severity).toBe('config-data')
    expect(conflict?.abort).toBe(false)
    expect(await readStaged(f.stagingRoot, 'cfg/app.yaml')).toBe('a: LOCAL\nb: 2\nc: 3\n')
    const sidecar = 'cfg/app.yaml.new-2.0.0'
    expect(entry(staging, sidecar).sha256).toBe(plan.actions.find(action => action.path === 'cfg/app.yaml')?.outcome.sidecars[sidecar])
    const sidecarText = await readStaged(f.stagingRoot, sidecar)
    expect(sidecarText).toContain('<<<<<<< local')
    expect(sidecarText).toContain('a: SHIPPED')
    expect(result.verification?.ok).toBe(true)
    expect(result.verification?.sidecarsPresent).toBe(1)
  })

  it('aborts the switch on a runtime-code conflict, keeps the current tree active, and leaves an inspection sidecar', async () => {
    const f = await fixture(
      'runtime-abort',
      { 'core/runtime.js': 'export const a = 1\nb\nc\nd\n' },
      { 'core/runtime.js': 'export const a = 2\nb\nc\nd\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'core/runtime.js'), 'export const a = 3\nb\nc\nd\n')
      },
    )
    const before = await lstat(join(f.localRoot, 'core/runtime.js'))
    const { plan, result } = await runUpdate(f)
    expect(plan.switchDecision).toBe('abort')
    expect(result.status).toBe('aborted')
    expect(result.verification).toBeNull()
    expect((await lstat(join(f.localRoot, 'core/runtime.js'))).ino).toBe(before.ino)
    expect(await readFile(join(f.localRoot, 'core/runtime.js'), 'utf8')).toBe('export const a = 3\nb\nc\nd\n')
    const sidecar = await readFile(join(f.localRoot, 'core/runtime.js.new-2.0.0'), 'utf8')
    expect(sidecar).toContain('<<<<<<< local')
    expect(sidecar).toContain('export const a = 2')
    await expect(lstat(f.stagingRoot)).rejects.toThrow()
  })

  it('never text-merges a both-changed binary: keeps local with the shipped bytes in the sidecar', async () => {
    const f = await fixture(
      'binary-conflict',
      { 'assets/logo.bin': Buffer.from([0x00, 0x01, 0x02]) },
      { 'assets/logo.bin': Buffer.from([0x00, 0x09, 0x09]) },
      async (localRoot) => {
        await writeFile(join(localRoot, 'assets/logo.bin'), Buffer.from([0x00, 0x07, 0x07]))
      },
    )
    const { plan, result, staging } = await runUpdate(f)
    expect(result.status).toBe('applied')
    const action = plan.actions.find(candidate => candidate.path === 'assets/logo.bin')
    expect(action?.merge?.status).toBe('binary')
    expect(entry(staging, 'assets/logo.bin').sha256).toBe(hashBytes(Buffer.from([0x00, 0x07, 0x07])))
    const sidecar = await readFile(join(f.stagingRoot, 'assets/logo.bin.new-2.0.0'))
    expect(sidecar.equals(Buffer.from([0x00, 0x09, 0x09]))).toBe(true)
    expect(result.verification?.ok).toBe(true)
  })

  it('keeps the user file when a newly shipped path collides with an untracked path', async () => {
    const f = await fixture(
      'untracked-collision',
      { 'core.txt': 'x\n' },
      { 'core.txt': 'x\n', 'docs/readme.md': 'shipped docs\n' },
      async (localRoot) => {
        await writeTreeFile(localRoot, 'docs/readme.md', 'user docs\n')
      },
    )
    const { plan, result } = await runUpdate(f)
    expect(result.status).toBe('applied')
    expect(plan.switchDecision).toBe('proceed')
    expect(await readStaged(f.stagingRoot, 'docs/readme.md')).toBe('user docs\n')
    const sidecar = await readFile(join(f.stagingRoot, 'docs/readme.md.shipped-2.0.0'), 'utf8')
    expect(sidecar).toBe('shipped docs\n')
    expect(plan.conflicts.find(conflict => conflict.path === 'docs/readme.md')?.kind).toBe('untracked-collision')
    expect(result.verification?.ok).toBe(true)
  })

  it('preserves edits and additions inside profile trees', async () => {
    const f = await fixture(
      'profile-tree',
      {
        'profiles/main/packages/pkg/index.js': 'line1\nline2\nline3\nline4\n',
        'profiles/main/scripts/run.sh': '#!/bin/sh\necho old\n',
      },
      {
        'profiles/main/packages/pkg/index.js': 'line1\nline2\nline3\nline4-release\n',
        'profiles/main/scripts/run.sh': '#!/bin/sh\necho old\n',
      },
      async (localRoot) => {
        await writeFile(join(localRoot, 'profiles/main/packages/pkg/index.js'), 'line1-user\nline2\nline3\nline4\n')
        await writeFile(join(localRoot, 'profiles/main/scripts/run.sh'), '#!/bin/sh\necho user\n')
        await writeTreeFile(localRoot, 'profiles/main/packages/extra-plugin/index.js', 'export default {}\n')
      },
    )
    const { result, staging } = await runUpdate(f)
    expect(result.status).toBe('applied')
    expect(await readStaged(f.stagingRoot, 'profiles/main/packages/pkg/index.js')).toBe('line1-user\nline2\nline3\nline4-release\n')
    expect(await readStaged(f.stagingRoot, 'profiles/main/scripts/run.sh')).toBe('#!/bin/sh\necho user\n')
    expect(entry(staging, 'profiles/main/packages/extra-plugin/index.js').sha256).toBe(hashBytes('export default {}\n'))
    expect(result.verification?.ok).toBe(true)
  })

  it('runs the merge net inside node_modules and preserves user additions there', async () => {
    const f = await fixture(
      'node-modules',
      { 'node_modules/dep/index.js': 'l1\nl2\nl3\nl4\n' },
      { 'node_modules/dep/index.js': 'l1\nl2\nl3\nl4-release\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'node_modules/dep/index.js'), 'l1-user\nl2\nl3\nl4\n')
        await writeTreeFile(localRoot, 'node_modules/dep/user-addon.js', 'export const addon = 1\n')
      },
    )
    const { result, staging } = await runUpdate(f)
    expect(await readStaged(f.stagingRoot, 'node_modules/dep/index.js')).toBe('l1-user\nl2\nl3\nl4-release\n')
    expect(entry(staging, 'node_modules/dep/user-addon.js').sha256).toBe(hashBytes('export const addon = 1\n'))
    expect(result.verification?.ok).toBe(true)
  })

  it('preserves symlink edits and conflicts', async () => {
    const f = await fixture(
      'symlink-edits',
      { 'target-a.txt': 'a\n', 'target-b.txt': 'b\n', 'link-keep': { symlink: 'target-a.txt' }, 'link-conflict': { symlink: 'target-a.txt' } },
      { 'target-a.txt': 'a\n', 'target-b.txt': 'b\n', 'link-keep': { symlink: 'target-a.txt' }, 'link-conflict': { symlink: 'target-b.txt' } },
      async (localRoot) => {
        await rm(join(localRoot, 'link-keep'))
        await symlink('target-b.txt', join(localRoot, 'link-keep'))
        await rm(join(localRoot, 'link-conflict'))
        await symlink('target-b.txt', join(localRoot, 'link-conflict'))
      },
    )
    const { plan, result } = await runUpdate(f)
    expect(result.status).toBe('applied')
    expect(entry(await scanTree(f.stagingRoot), 'link-keep').target).toBe('target-b.txt')
    // The retargeted link-keep matches its local state, so no sidecar is needed.
    expect(plan.actions.find(action => action.path === 'link-keep')?.kind).toBe('keep-local')
    expect(entry(await scanTree(f.stagingRoot), 'link-conflict').target).toBe('target-b.txt')
    expect(await readFile(join(f.stagingRoot, 'link-conflict.new-2.0.0'), 'utf8')).toBe('target-b.txt\n')
    expect(result.verification?.ok).toBe(true)
  })

  it('preserves a user mode-bit edit when the release did not change the file', async () => {
    const f = await fixture(
      'mode-edit',
      { 'bin/tool.sh': { content: '#!/bin/sh\n', mode: 0o755 } },
      { 'bin/tool.sh': { content: '#!/bin/sh\n', mode: 0o755 } },
      async (localRoot) => {
        await chmod(join(localRoot, 'bin/tool.sh'), 0o700)
      },
    )
    const { result, staging } = await runUpdate(f)
    expect(result.status).toBe('applied')
    expect(entry(staging, 'bin/tool.sh').mode).toBe(0o700)
    expect(result.verification?.ok).toBe(true)
  })

  it('reports and skips pinned paths for replacement, merge, and deletion', async () => {
    const f = await fixture(
      'pins',
      { 'pin.txt': 'v1\n', 'pin-mod.txt': 'v1\n', 'pin-delete.txt': 'gone\n' },
      { 'pin.txt': 'v2\n', 'pin-mod.txt': 'v2\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'pin-mod.txt'), 'user\n')
      },
    )
    const { plan, result, staging } = await runUpdate(f, { pins: ['pin.txt', 'pin-mod.txt', 'pin-delete.txt'] })
    expect(await readStaged(f.stagingRoot, 'pin.txt')).toBe('v1\n')
    expect(await readStaged(f.stagingRoot, 'pin-mod.txt')).toBe('user\n')
    expect(entry(staging, 'pin-delete.txt').sha256).toBe(hashBytes('gone\n'))
    expect(plan.counts['pin-skip']).toBe(3)
    expect(result.report.pinned).toEqual(['pin-delete.txt', 'pin-mod.txt', 'pin.txt'])
    expect(result.verification?.ok).toBe(true)
  })

  it('is idempotent: a second plan + apply is a verified no-op', async () => {
    const f = await fixture(
      'idempotent',
      { 'core/app.js': 'a\nb\nc\nd\n', 'keep.txt': 'keep\n', 'gone.txt': 'gone\n' },
      { 'core/app.js': 'a\nb\nc\nd-rel\n', 'keep.txt': 'keep\n', 'new.txt': 'new\n' },
      async (localRoot) => {
        await writeFile(join(localRoot, 'core/app.js'), 'a-user\nb\nc\nd\n')
        await writeTreeFile(localRoot, 'user/added.txt', 'added\n')
      },
    )
    const first = await runUpdate(f)
    expect(first.result.status).toBe('applied')
    const stagingAfterFirst = first.staging

    const secondPlan = await runUpdate(f)
    expect(secondPlan.result.status).toBe('noop')
    expect(secondPlan.result.resumed).toBe(false)
    expect(secondPlan.staging).toEqual(stagingAfterFirst)
    expect(secondPlan.plan.fingerprint).toBe(first.plan.fingerprint)
  })

  it('resumes an interrupted apply to the same end state as an uninterrupted run', async () => {
    const base = { 'a.txt': 'a\nb\nc\n', 'b.txt': 'b\n', 'gone.txt': 'gone\n', 'keep.txt': 'keep\n' }
    const release = { 'a.txt': 'a\nb\nc-REL\n', 'b.txt': 'b\n', 'keep.txt': 'keep\n', 'new.txt': 'new\n' }
    const edit = async (localRoot: string): Promise<void> => {
      await writeFile(join(localRoot, 'a.txt'), 'a-LOCAL\nb\nc\n')
      await writeTreeFile(localRoot, 'user.txt', 'user\n')
    }
    const reference = await fixture('resume-reference', base, release, edit)
    const referenceRun = await runUpdate(reference)
    expect(referenceRun.result.status).toBe('applied')

    const interrupted = await fixture('resume-interrupted', base, release, edit)
    const first = await runUpdate(interrupted, { stopAfterActions: 2 })
    expect(first.result.status).toBe('interrupted')
    expect(first.result.liveTreeIntact).toBe(true)
    const journal = JSON.parse(await readFile(interrupted.journalPath, 'utf8')) as { phase: string; completed: string[] }
    expect(journal.phase).toBe('applying')
    expect(journal.completed).toHaveLength(2)

    const second = await runUpdate(interrupted)
    expect(second.result.status).toBe('applied')
    expect(second.result.resumed).toBe(true)
    expect(second.result.verification?.ok).toBe(true)
    expect(second.staging).toEqual(referenceRun.staging)
  })
})
