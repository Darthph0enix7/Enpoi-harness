// Release gate: every workspace package a composition mounts by name must be
// resolvable in the running installation's dependency closure.
//
// The runtime resolution (packages/boot/app-boot) maps a bare `@deepseek-ai/dsh-*`
// name to a package directory ONLY when the CLI's dependency closure reaches it.
// A row mounted by name but absent from the closure imports fine in a workspace
// checkout (pnpm links everything) and fails on a prebuilt install — exactly the
// 0.1.7-enpoi.2.78 feedback-submit/-triage failure. This gate makes that class
// impossible: it computes the real resolution and compares it against every
// `name:` the bundled patches mount.
//
// Run after `pnpm build` (it reads the built app-boot): node scripts/verify-mounted-packages.mjs
// Exit 0 = all mounted workspace packages resolve; exit 1 = the missing list.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ANCHOR = join(ROOT, 'apps/cli/package.json')

/** Patch files that carry mounted plugin rows for the shipped compositions. */
const PATCH_FILES = [
  'packages/bundle/base/cordis.patch.yml',
  'packages/bundle/web-app/cordis.patch.yml',
  'profile/web/cordis.patch.yml',
]

/** Package names owned by the profile tree (profile scope, not installation scope). */
function profilePackageNames() {
  const names = new Set()
  const base = join(ROOT, 'profile/web/packages')
  if (!existsSync(base)) return names
  for (const dir of readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const manifest = join(base, dir.name, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      const name = JSON.parse(readFileSync(manifest, 'utf8')).name
      if (name) names.add(name)
    } catch { /* an unreadable manifest is reported by its own gate */ }
  }
  return names
}

/** Every `name:` value the shipped patches mount, deduplicated. */
function mountedNames() {
  const names = new Set()
  for (const file of PATCH_FILES) {
    const full = join(ROOT, file)
    if (!existsSync(full)) continue
    for (const match of readFileSync(full, 'utf8').matchAll(/name:\s*['"]?([@\w./-]+)['"]?/g)) names.add(match[1])
  }
  return names
}

const appBoot = await import(join(ROOT, 'packages/boot/app-boot/lib/index.js'))
const resolution = await appBoot.createRuntimeResolution({ installAnchor: ANCHOR })
const resolved = new Set(resolution.entries.map(entry => entry.name))
const profileScope = profilePackageNames()

/** Package part of a mounted name: rows may mount a subpath export (`pkg/sub`). */
function packageOf(name) {
  const segments = name.split('/')
  return name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const missing = [...mountedNames()]
  .filter(name => name.startsWith('@deepseek-ai/dsh-'))
  .map(name => packageOf(name))
  .filter(name => !resolved.has(name) && !profileScope.has(name))
  .filter((name, index, all) => all.indexOf(name) === index)

if (missing.length > 0) {
  console.error('verify-mounted-packages: mounted packages missing from the installation closure:')
  for (const name of missing) console.error(`  - ${name}`)
  console.error('Declare each in the bundle that composes it (packages/bundle/*/package.json), then pnpm install.')
  process.exit(1)
}

console.log(`verify-mounted-packages: ok — ${mountedNames().size} mounted names resolve (${resolution.entries.length} installation entries)`)
