/**
 * Real temp-tree fixtures for the update-engine suites: builders that write
 * base (previous release), release (new), and local (user-edited copy) trees,
 * plus a runner that drives plan + apply over them.
 */

import { chmod, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyPlan } from '../src/apply.ts'
import { scanTree } from '../src/manifest.ts'
import { buildPlan } from '../src/plan.ts'
import type { Manifest, ManifestEntry, UpdatePlan } from '../src/types.ts'

/** One path in a fixture tree: text, bytes, symlink, mode override, or empty directory. */
export type FileSpec = string | Buffer | { content?: string | Buffer; symlink?: string; mode?: number; dir?: true }

/**
 * Write a spec tree under a root.
 * @param root - Destination root (created as needed).
 * @param spec - Relative path → file spec.
 */
export async function writeTree(root: string, spec: Record<string, FileSpec>): Promise<void> {
  await mkdir(root, { recursive: true })
  for (const [path, value] of Object.entries(spec)) {
    const target = join(root, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      await writeFile(target, value)
      continue
    }
    if (value.dir === true) {
      await mkdir(target, { recursive: true })
      continue
    }
    if (value.symlink !== undefined) {
      await symlink(value.symlink, target)
      continue
    }
    const content = value.content ?? ''
    await writeFile(target, content)
    if (value.mode !== undefined) await chmod(target, value.mode)
  }
}

/**
 * Write one file under a tree, creating parent directories.
 * @param root - Tree root.
 * @param path - Relative path.
 * @param content - Text or bytes.
 */
export async function writeTreeFile(root: string, path: string, content: string | Buffer): Promise<void> {
  const target = join(root, ...path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

/**
 * Create a temp root for one fixture.
 * @param label - Prefix for the temp directory name.
 * @returns Absolute temp directory path.
 */
export async function tempRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `dsh-update-${label}-`))
}

/** Fixture with the three trees, their manifests, and staging/journal locations. */
export interface UpdateFixture {
  root: string
  baseRoot: string
  releaseRoot: string
  localRoot: string
  stagingRoot: string
  journalPath: string
  backupDir: string
  previous: Manifest
  next: Manifest
  local: Manifest
}

/**
 * Build a fixture: base tree, release tree, and a local copy of base mutated
 * by `edit`.
 * @param label - Temp-directory label.
 * @param base - Previous release spec.
 * @param release - New release spec.
 * @param edit - Optional local-tree mutations applied after copying base.
 * @returns Fixture paths and manifests.
 */
export async function makeUpdateFixture(
  label: string,
  base: Record<string, FileSpec>,
  release: Record<string, FileSpec>,
  edit?: (localRoot: string, fixture: { root: string }) => Promise<void>,
): Promise<UpdateFixture> {
  const root = await tempRoot(label)
  const baseRoot = join(root, 'base')
  const releaseRoot = join(root, 'release')
  const localRoot = join(root, 'local')
  await writeTree(baseRoot, base)
  await writeTree(releaseRoot, release)
  await cp(baseRoot, localRoot, { recursive: true, verbatimSymlinks: true })
  if (edit !== undefined) await edit(localRoot, { root })
  return {
    root,
    baseRoot,
    releaseRoot,
    localRoot,
    stagingRoot: join(root, 'staging'),
    journalPath: join(root, 'staging.journal.json'),
    backupDir: join(root, 'backup'),
    previous: await scanTree(baseRoot),
    next: await scanTree(releaseRoot),
    local: await scanTree(localRoot),
  }
}

/** Options for {@link runUpdate}. */
export interface RunUpdateOptions {
  tombstones?: readonly string[]
  pins?: readonly string[]
  stopAfterActions?: number
  timestamp?: string
}

/** Plan + apply result bundle. */
export interface UpdateRun {
  plan: UpdatePlan
  result: Awaited<ReturnType<typeof applyPlan>>
  staging: Manifest
}

/**
 * Build and apply the plan for a fixture.
 * @param fixture - Fixture to update.
 * @param options - Tombstones, pins, and interruption controls.
 * @returns Plan, apply result, and the staged manifest.
 */
export async function runUpdate(fixture: UpdateFixture, options: RunUpdateOptions = {}): Promise<UpdateRun> {
  const plan = await buildPlan({
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    previous: fixture.previous,
    next: fixture.next,
    local: fixture.local,
    localRoot: fixture.localRoot,
    baseRoot: fixture.baseRoot,
    releaseRoot: fixture.releaseRoot,
    tombstones: options.tombstones ?? [],
    pins: options.pins ?? [],
  })
  const result = await applyPlan({
    plan,
    localRoot: fixture.localRoot,
    baseRoot: fixture.baseRoot,
    releaseRoot: fixture.releaseRoot,
    stagingRoot: fixture.stagingRoot,
    journalPath: fixture.journalPath,
    timestamp: options.timestamp ?? '2026-01-01T00:00:00.000Z',
    ...(options.stopAfterActions === undefined ? {} : { stopAfterActions: options.stopAfterActions }),
  })
  let staging: Manifest = {}
  try {
    staging = await scanTree(fixture.stagingRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { plan, result, staging }
}

/**
 * Read a manifest entry or throw (test helper).
 * @param manifest - Manifest to look in.
 * @param path - Relative path.
 * @returns The entry.
 */
export function entry(manifest: Manifest, path: string): ManifestEntry {
  const found = manifest[path]
  if (found === undefined) throw new Error(`manifest entry not found: ${path}`)
  return found
}

/**
 * Read a staged file as UTF-8 text.
 * @param stagingRoot - Staging root.
 * @param path - Relative path.
 * @returns File content.
 */
export async function readStaged(stagingRoot: string, path: string): Promise<string> {
  return readFile(join(stagingRoot, ...path.split('/')), 'utf8')
}

/**
 * Read bytes from a fixture tree.
 * @param root - Tree root.
 * @param path - Relative path.
 * @returns File bytes.
 */
export async function readTreeFile(root: string, path: string): Promise<Buffer> {
  return readFile(join(root, ...path.split('/')))
}
