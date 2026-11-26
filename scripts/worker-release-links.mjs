/** Project declared worker dependencies into the release, using relocatable links only. */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { workerManifest } from './worker-profile.mjs'

const release = fileURLToPath(new URL('..', import.meta.url))
workerManifest(release)
const byName = new Map()
function collect(parent) {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(parent, entry.name)
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) byName.set(JSON.parse(readFileSync(manifest, 'utf8')).name, dir)
  }
}
for (const group of readdirSync(join(release, 'packages'), { withFileTypes: true })) {
  if (group.isDirectory()) collect(join(release, 'packages', group.name))
}
collect(join(release, 'vendor'))
collect(join(release, 'profile/web/packages'))
for (const name of ['ws', '@types/ws']) {
  const dir = join(byName.get('@deepseek-ai/dsh-api-gateway'), 'node_modules', name)
  if (name.startsWith('@types/') && !existsSync(dir)) continue
  const target = realpathSync(dir)
  if (relative(release, target).startsWith('..')) throw new Error(`worker ${name} must resolve inside the versioned release`)
  byName.set(name, target)
}

for (const owner of ['dsh-enpoi-jarvis-worker', 'dsh-enpoi-job-guard', 'dsh-enpoi-worker-credentials']) {
  const dir = byName.get(owner)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const types = Object.keys(manifest.devDependencies ?? {}).filter(name => name.startsWith('@types/') && byName.has(name))
  for (const name of [...Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }), ...types]) {
    const target = byName.get(name)
    if (target === undefined) throw new Error(`worker release package ${name} is missing from the release`)
    const link = join(dir, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    const wanted = relative(dirname(link), target)
    const stat = lstatSync(link, { throwIfNoEntry: false })
    if (stat === undefined) symlinkSync(wanted, link, 'dir')
    else if (!stat.isSymbolicLink() || readlinkSync(link) !== wanted) {
      throw new Error(`worker release dependency ${name} has a conflicting link under ${owner}; use a clean release tree`)
    }
  }
}
