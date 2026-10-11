/**
 * Decision-matrix pins (§3.2): every row of the total matrix produces the
 * expected action, conflict severity splits runtime from config/data, pins
 * exclude replacement/merge/deletion, and plans are deterministic and
 * round-trip through their serialized form.
 */

import { chmod, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashBytes } from '../src/manifest.ts'
import { buildPlan, parsePlan, serializePlan } from '../src/plan.ts'
import type { PlanAction, UpdatePlan } from '../src/types.ts'
import { makeUpdateFixture, writeTreeFile, type FileSpec } from './fixture.ts'
import { rm as rmDir } from 'node:fs/promises'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rmDir(root, { recursive: true, force: true })))
})

function actionOf(plan: UpdatePlan, path: string): PlanAction {
  const found = plan.actions.find(candidate => candidate.path === path)
  if (found === undefined) throw new Error(`no action for ${path}`)
  return found
}

const BASE: Record<string, FileSpec> = {
  'stable.txt': 'stable\n',
  'changed.txt': 'v1\n',
  'modified.txt': 'v1\n',
  'merge-ok.txt': 'a\nb\nc\nd\n',
  'core/config.yaml': 'a: 1\nb: 2\nc: 3\n',
  'core/runtime.js': 'export const foo = 1\nexport const bar = 2\n',
  'assets/logo.bin': Buffer.from([0x00, 0x01, 0x02]),
  'delete-ok.txt': 'gone\n',
  'forgotten.txt': 'forgotten v1\n',
  'restore.txt': 'restore v1\n',
  'restore-stable.txt': 'restore-stable\n',
  'pin-me.txt': 'v1\n',
  'collide.txt': 'shipped v1\n',
  'bin/tool.sh': { content: '#!/bin/sh\n', mode: 0o755 },
  'link-keep': { symlink: 'stable.txt' },
  'link-conflict': { symlink: 'stable.txt' },
}

const RELEASE: Record<string, FileSpec> = {
  'stable.txt': 'stable\n',
  'changed.txt': 'v2\n',
  'modified.txt': 'v1\n',
  'merge-ok.txt': 'a\nb\nc\nd-RELEASE\n',
  'core/config.yaml': 'a: NEW\nb: 2\nc: 3\n',
  'core/runtime.js': 'export const foo = 1\nexport const bar = 2\n',
  'assets/logo.bin': Buffer.from([0x00, 0x09, 0x09]),
  'forgotten.txt': 'forgotten v2\n',
  'restore.txt': 'restore v2\n',
  'restore-stable.txt': 'restore-stable\n',
  'pin-me.txt': 'v2\n',
  'collide.txt': 'shipped v2\n',
  'bin/tool.sh': { content: '#!/bin/sh\n', mode: 0o755 },
  'link-keep': { symlink: 'stable.txt' },
  'link-conflict': { symlink: 'changed.txt' },
  'new-added.txt': 'added\n',
  'new-collision.txt': 'shipped-new\n',
}

async function editLocal(localRoot: string): Promise<void> {
  await writeFile(join(localRoot, 'modified.txt'), 'local\n')
  await writeFile(join(localRoot, 'merge-ok.txt'), 'a\nb-LOCAL\nc\nd\n')
  await writeFile(join(localRoot, 'core/config.yaml'), 'a: LOCAL\nb: 2\nc: 3\n')
  await writeFile(join(localRoot, 'assets/logo.bin'), Buffer.from([0x00, 0x07, 0x07]))
  await chmod(join(localRoot, 'bin/tool.sh'), 0o700)
  await rm(join(localRoot, 'forgotten.txt'))
  await rm(join(localRoot, 'restore.txt'))
  await rm(join(localRoot, 'restore-stable.txt'))
  await rm(join(localRoot, 'link-keep'))
  await symlink('changed.txt', join(localRoot, 'link-keep'))
  await rm(join(localRoot, 'link-conflict'))
  await symlink('modified.txt', join(localRoot, 'link-conflict'))
  await writeTreeFile(localRoot, 'user/notes.txt', 'user notes\n')
  await writeTreeFile(localRoot, 'new-collision.txt', 'user-new\n')
}

describe('buildPlan decision matrix', () => {
  it('classifies every matrix row deterministically', async () => {
    const fixture = await makeUpdateFixture('plan-matrix', BASE, RELEASE, editLocal)
    roots.push(fixture.root)
    const plan = await buildPlan({
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      previous: fixture.previous,
      next: fixture.next,
      local: fixture.local,
      localRoot: fixture.localRoot,
      baseRoot: fixture.baseRoot,
      releaseRoot: fixture.releaseRoot,
      tombstones: ['forgotten.txt'],
      pins: ['pin-me.txt'],
    })

    expect(actionOf(plan, 'stable.txt').kind).toBe('skip')
    expect(actionOf(plan, 'stable.txt').reason).toBe('unchanged/unchanged')
    expect(actionOf(plan, 'changed.txt').kind).toBe('replace')
    expect(actionOf(plan, 'modified.txt').kind).toBe('keep-local')
    expect(actionOf(plan, 'modified.txt').reason).toBe('modified/unchanged')
    expect(actionOf(plan, 'bin/tool.sh').kind).toBe('keep-local')
    expect(actionOf(plan, 'link-keep').kind).toBe('keep-local')
    expect(actionOf(plan, 'delete-ok.txt').kind).toBe('delete')
    expect(actionOf(plan, 'forgotten.txt').kind).toBe('tombstone')
    expect(actionOf(plan, 'restore.txt').kind).toBe('restore')
    expect(actionOf(plan, 'restore.txt').reason).toBe('missing/changed')
    expect(actionOf(plan, 'restore-stable.txt').kind).toBe('restore')
    expect(actionOf(plan, 'restore-stable.txt').reason).toBe('missing/unchanged')
    expect(actionOf(plan, 'pin-me.txt').kind).toBe('pin-skip')
    expect(actionOf(plan, 'pin-me.txt').pinned).toBe(true)
    expect(actionOf(plan, 'user/notes.txt').kind).toBe('keep-untracked')
    expect(actionOf(plan, 'new-added.txt').kind).toBe('add')
    expect(actionOf(plan, 'collide.txt').kind).toBe('replace')

    // modified/changed text merge: clean.
    const mergeAction = actionOf(plan, 'merge-ok.txt')
    expect(mergeAction.kind).toBe('merge')
    expect(mergeAction.merge?.status).toBe('clean')
    expect(mergeAction.outcome.sha256).toBe(hashBytes('a\nb-LOCAL\nc\nd-RELEASE\n'))

    // Config conflict: kept local + .new sidecar, apply continues.
    const configAction = actionOf(plan, 'core/config.yaml')
    expect(configAction.kind).toBe('keep-local-sidecar')
    expect(configAction.outcome.disposition).toBe('local')
    expect(configAction.outcome.sidecars['core/config.yaml.new-2.0.0']).toBeDefined()
    expect(plan.conflicts.find(conflict => conflict.path === 'core/config.yaml')?.severity).toBe('config-data')

    // Untracked collision: user file kept + .shipped sidecar.
    const collision = actionOf(plan, 'new-collision.txt')
    expect(collision.kind).toBe('keep-local-sidecar')
    expect(collision.outcome.sha256).toBe(fixture.local['new-collision.txt']?.sha256)
    expect(collision.outcome.sidecars['new-collision.txt.shipped-2.0.0']).toBe(hashBytes('shipped-new\n'))
    expect(plan.conflicts.find(conflict => conflict.path === 'new-collision.txt')?.kind).toBe('untracked-collision')

    // Binary both-changed: never text-merged.
    const binary = actionOf(plan, 'assets/logo.bin')
    expect(binary.kind).toBe('keep-local-sidecar')
    expect(binary.merge?.status).toBe('binary')
    expect(binary.outcome.sidecars['assets/logo.bin.new-2.0.0']).toBe(hashBytes(Buffer.from([0x00, 0x09, 0x09])))

    // Symlink conflict: kept local + sidecar carrying the shipped target.
    const linkConflict = actionOf(plan, 'link-conflict')
    expect(linkConflict.kind).toBe('keep-local-sidecar')
    expect(linkConflict.outcome.sidecars['link-conflict.new-2.0.0']).toBe(hashBytes('changed.txt\n'))

    expect(plan.switchDecision).toBe('proceed')
    expect(plan.counts.delete).toBe(1)
    expect(plan.counts.tombstone).toBe(1)
    expect(plan.counts.restore).toBe(2)
    expect(plan.counts['pin-skip']).toBe(1)
    expect(plan.counts.merge).toBe(1)
  })

  it('aborts the switch on runtime-code merge conflicts and keeps the sidecar for inspection', async () => {
    const base = { 'core/runtime.js': 'export const a = 1\nb\nc\nd\n' }
    const release = { 'core/runtime.js': 'export const a = 2\nb\nc\nd\n' }
    const fixture = await makeUpdateFixture('plan-abort', base, release, async (localRoot) => {
      await writeFile(join(localRoot, 'core/runtime.js'), 'export const a = 3\nb\nc\nd\n')
    })
    roots.push(fixture.root)
    const plan = await buildPlan({
      fromVersion: '1.0.0', toVersion: '2.0.0',
      previous: fixture.previous, next: fixture.next, local: fixture.local,
      localRoot: fixture.localRoot, baseRoot: fixture.baseRoot, releaseRoot: fixture.releaseRoot,
    })
    expect(plan.switchDecision).toBe('abort')
    const action = actionOf(plan, 'core/runtime.js')
    expect(action.kind).toBe('keep-local-sidecar')
    expect(action.merge?.severity).toBe('runtime-code')
    const conflict = plan.conflicts.find(candidate => candidate.path === 'core/runtime.js')
    expect(conflict?.abort).toBe(true)
    expect(conflict?.sidecar).toBe('core/runtime.js.new-2.0.0')
  })

  it('treats a runtime-code collision with an untracked file as keep-user, not an abort', async () => {
    const fixture = await makeUpdateFixture('plan-collision-runtime', {}, { 'plugin/index.js': 'shipped\n' }, async (localRoot) => {
      await writeTreeFile(localRoot, 'plugin/index.js', 'user\n')
    })
    roots.push(fixture.root)
    const plan = await buildPlan({
      fromVersion: null, toVersion: '2.0.0',
      previous: fixture.previous, next: fixture.next, local: fixture.local,
      localRoot: fixture.localRoot, baseRoot: fixture.baseRoot, releaseRoot: fixture.releaseRoot,
    })
    expect(plan.switchDecision).toBe('proceed')
    const action = actionOf(plan, 'plugin/index.js')
    expect(action.kind).toBe('keep-local-sidecar')
    expect(action.outcome.sidecars['plugin/index.js.shipped-2.0.0']).toBeDefined()
  })

  it('keeps a missed tombstoned directory non-empty but preserves untracked content', async () => {
    const fixture = await makeUpdateFixture('plan-tombstone-dir', { 'forgotten/keep.txt': 'x\n' }, {}, async (localRoot) => {
      await writeTreeFile(localRoot, 'forgotten/user.txt', 'user\n')
    })
    roots.push(fixture.root)
    const plan = await buildPlan({
      fromVersion: '1.0.0', toVersion: '2.0.0',
      previous: fixture.previous, next: fixture.next, local: fixture.local,
      localRoot: fixture.localRoot, baseRoot: fixture.baseRoot, releaseRoot: fixture.releaseRoot,
      tombstones: ['forgotten/keep.txt'],
    })
    // The local file is unmodified relative to the baseline, so the tombstone is respected.
    expect(actionOf(plan, 'forgotten/keep.txt').kind).toBe('tombstone')
    // The untracked file inside the tombstoned directory stays untracked.
    expect(actionOf(plan, 'forgotten/user.txt').kind).toBe('keep-untracked')
  })

  it('is deterministic and round-trips through serialize/parse', async () => {
    const fixture = await makeUpdateFixture('plan-determinism', BASE, RELEASE, async (localRoot) => {
      await writeFile(join(localRoot, 'modified.txt'), 'local\n')
    })
    roots.push(fixture.root)
    const options = {
      fromVersion: '1.0.0' as const,
      toVersion: '2.0.0' as const,
      previous: fixture.previous,
      next: fixture.next,
      local: fixture.local,
      localRoot: fixture.localRoot,
      baseRoot: fixture.baseRoot,
      releaseRoot: fixture.releaseRoot,
    }
    const first = await buildPlan(options)
    const second = await buildPlan(options)
    expect(first.fingerprint).toBe(second.fingerprint)
    const reparsed = parsePlan(serializePlan(first))
    expect(reparsed.fingerprint).toBe(first.fingerprint)
    expect(reparsed.actions.length).toBe(first.actions.length)
  })

  it('rejects a tampered plan fingerprint', async () => {
    const fixture = await makeUpdateFixture('plan-tamper', { 'a.txt': 'a\n' }, { 'a.txt': 'b\n' })
    roots.push(fixture.root)
    const plan = await buildPlan({
      fromVersion: '1.0.0', toVersion: '2.0.0',
      previous: fixture.previous, next: fixture.next, local: fixture.local,
      localRoot: fixture.localRoot, baseRoot: fixture.baseRoot, releaseRoot: fixture.releaseRoot,
    })
    const serialized = serializePlan(plan)
    const tampered = serialized.replace(/"sha256": "[0-9a-f]{64}"/u, `"sha256": "${'0'.repeat(64)}"`)
    expect(() => parsePlan(tampered)).toThrow(/fingerprint mismatch/u)
  })
})
