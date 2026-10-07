import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Behavior guard for the update-time profile merges in `scripts/install.sh`:
 * the additive `cordis.patch.yml` merge (new shipped rows/sections only, never
 * a live row modified or removed, operator-state rows gated) and the
 * package.json dependency union (shipped wins, user-only keys kept, an
 * unparseable manifest aborts instead of being clobbered).
 *
 * The functions are exercised by sourcing install.sh as a library
 * (DSH_INSTALL_LIB_ONLY=1), which defines every helper without running a mode.
 */

const installSh = join(dirname(fileURLToPath(import.meta.url)), 'install.sh')
const repoRoot = join(dirname(installSh), '..')

function extractQuotedList(source: string, name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`).exec(source)
  if (match === null) throw new Error(`no ${name} array in source`)
  const body = match[1] ?? ''
  return [...body.matchAll(/'([^']+)'/g)].map(entry => entry[1] ?? '')
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

function parseManifest(path: string): ProfileManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as ProfileManifest
}

let root: string
let counter = 0

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-profile-merge-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function fixture(name: string, content: string): string {
  counter += 1
  const path = join(root, `${counter}-${name}`)
  writeFileSync(path, content)
  return path
}

function runBash(call: string, shipped: string, live: string): { status: number; output: string } {
  const script = ['export DSH_INSTALL_LIB_ONLY=1', '. "$INSTALL_SH" 2>/dev/null', 'VERBOSE=1', call].join('\n')
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, INSTALL_SH: installSh, SHIPPED: shipped, LIVE: live },
    encoding: 'utf8',
  })
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function runPatchMerge(shipped: string, live: string) {
  return runBash('merge_profile_patch "$SHIPPED" "$LIVE" 2>&1', shipped, live)
}

function runPackageMerge(shipped: string, live: string) {
  return runBash('NODE="$(command -v node)"\nmerge_profile_package_json "$SHIPPED" "$LIVE" 2>&1', shipped, live)
}

const SHIPPED_TEMPLATE = `# shipped template
- id: subagent
  name: "@deepseek-ai/dsh-subagent"
  config:
    maxDepth: 2

- insert:
    - id: preset-orchestrator
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: orchestrator

- id: ui-sidebar-browser
  name: "@deepseek-ai/dsh-ui-sidebar-browser"
  disabled: true

- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
  config:
    parameters:
      keeper:
        structuralDistanceK: 24
    customTools:
      - id: research-verify
        name: Research verify
`

const LIVE_TEMPLATE = `# LIVE OPERATOR EDIT: keep this comment
- id: subagent
  name: "@deepseek-ai/dsh-subagent"
  config:
    maxDepth: 9

- id: ui-settings-models
  name: "@deepseek-ai/dsh-ui-settings-models"
  config:
    hidden: [operator-choice]

- insert:
    - id: preset-orchestrator
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: orchestrator

- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
  config:
    parameters:
      keeper:
        structuralDistanceK: 24
    capabilities:
      operator: true

- id: operator-tail
  name: operator-extension
`

describe('additive profile patch merge', () => {
  it('adds a missing shipped row and section while leaving every live row and edit untouched', () => {
    const shipped = fixture('shipped.patch.yml', SHIPPED_TEMPLATE)
    const live = fixture('cordis.patch.yml', LIVE_TEMPLATE)
    const result = runPatchMerge(shipped, live)
    expect(result.status).toBe(0)
    const merged = readFileSync(live, 'utf8')
    // Missing shipped row and section arrive.
    expect(merged).toContain('\n- id: ui-sidebar-browser\n')
    expect(merged).toContain('    customTools:\n')
    expect(merged).toContain('      - id: research-verify\n')
    // Operator edits and rows survive byte-for-byte.
    expect(merged).toContain('# LIVE OPERATOR EDIT: keep this comment')
    expect(merged).toContain('maxDepth: 9')
    expect(merged).not.toContain('maxDepth: 2')
    expect(merged).toContain('hidden: [operator-choice]')
    expect(merged).toContain('\n- id: operator-tail\n')
    expect(merged).toContain('    capabilities:\n      operator: true\n')
    // A timestamped backup of the pre-merge document exists.
    expect(readdirSync(root).some(name => /cordis\.patch\.yml.*\.backup-\d{8}-\d{6}/.test(name))).toBe(true)
  })

  it('does not let a nested id mask a shipped top-level row', () => {
    const shipped = fixture('nested-shipped.patch.yml', `- id: research-verify
  name: "@deepseek-ai/dsh-research-verify"

- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
  config:
    customTools:
      - id: other
`)
    const live = fixture('nested-live.patch.yml', `- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
  config:
    customTools:
      - id: research-verify
        name: operator nested
`)
    const result = runPatchMerge(shipped, live)
    expect(result.status).toBe(0)
    const merged = readFileSync(live, 'utf8')
    // The nested id stays nested; the shipped root-level row still arrives.
    expect(merged).toMatch(/^- id: research-verify$/m)
    expect(merged).toContain('operator nested')
    expect(result.output).toContain('added row: research-verify')
  })

  it('honors a top-of-file dsh-ignore opt-out and never re-adds a disabled live row', () => {
    const shipped = fixture('ignore-shipped.patch.yml', `- id: ignored-row
  name: "@deepseek-ai/dsh-ignored"

- id: disabled-row
  name: "@deepseek-ai/dsh-disabled"

- id: added-row
  name: "@deepseek-ai/dsh-added"
`)
    const live = fixture('ignore-live.patch.yml', `# LIVE header comment
# dsh-ignore: ignored-row

- id: disabled-row
  name: "@deepseek-ai/dsh-disabled"
  disabled: true
`)
    const result = runPatchMerge(shipped, live)
    expect(result.status).toBe(0)
    const merged = readFileSync(live, 'utf8')
    expect(merged).not.toContain('- id: ignored-row')
    expect(merged.match(/- id: disabled-row/g)).toHaveLength(1)
    expect(merged).toContain('\n- id: added-row\n')
    expect(result.output).toContain('skipped operator opt-out row: ignored-row')
  })

  it('never merges operator-state rows or sections from a shipped template', () => {
    const shipped = fixture('hostile-shipped.patch.yml', `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    routes: []

- id: clean-row
  name: "@deepseek-ai/dsh-clean"
  config:
    enabled: true

- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
  config:
    capabilities:
      operator: true
    parameters:
      keeper:
        structuralDistanceK: 24
`)
    const live = fixture('hostile-live.patch.yml', `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    routes:
      - operator: keep

- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
  config:
    parameters:
      keeper:
        structuralDistanceK: 1
`)
    const result = runPatchMerge(shipped, live)
    expect(result.status).toBe(0)
    const merged = readFileSync(live, 'utf8')
    expect(merged).toContain('\n- id: clean-row\n')
    // The operator row and its values are untouched; the operator-owned
    // `capabilities` section never arrives.
    expect(merged).toContain('- operator: keep')
    expect(merged).not.toContain('capabilities:')
    expect(merged.match(/- id: llm-pi-ai/g)).toHaveLength(1)
  })

  it('leaves a partially present insert block and the whole live file untouched', () => {
    const shipped = fixture('inserts-shipped.patch.yml', `- insert:
    - id: preset-a
      name: "@deepseek-ai/dsh-agent-preset"
      config:
        id: a

    - id: preset-b
      name: "@deepseek-ai/dsh-agent-preset"
      config:
        id: b
`)
    const live = fixture('inserts-live.patch.yml', `- insert:
    - id: preset-a
      name: "@deepseek-ai/dsh-agent-preset"
      config:
        id: a
        operator: edit
`)
    const before = readFileSync(live, 'utf8')
    const result = runPatchMerge(shipped, live)
    expect(result.status).toBe(0)
    expect(readFileSync(live, 'utf8')).toBe(before)
    expect(result.output).toContain('partially present')
    expect(result.output).toContain('left untouched')
  })

  it('leaves a malformed live file untouched', () => {
    const shipped = fixture('malformed-shipped.patch.yml', `- id: subagent
  name: "@deepseek-ai/dsh-subagent"
`)
    const live = fixture('malformed-live.patch.yml', 'this: is not [a valid yaml array\n  still: broken\n')
    const before = readFileSync(live, 'utf8')
    const result = runPatchMerge(shipped, live)
    expect(result.status).toBe(0)
    expect(readFileSync(live, 'utf8')).toBe(before)
    expect(result.output).toContain('left untouched')
  })

  it('is a no-op when the live patch already carries every shipped row and section', () => {
    const shipped = fixture('noop-shipped.patch.yml', `- id: subagent
  name: "@deepseek-ai/dsh-subagent"
`)
    const live = fixture('noop-live.patch.yml', `- id: subagent
  name: "@deepseek-ai/dsh-subagent"
`)
    const before = readFileSync(live, 'utf8')
    const result = runPatchMerge(shipped, live)
    expect(result.status).toBe(0)
    expect(readFileSync(live, 'utf8')).toBe(before)
    expect(existsSync(`${live}.backup-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`)).toBe(false)
  })
})

describe('operator-state gate', () => {
  it('stays pinned to the profile template guards', () => {
    const install = readFileSync(installSh, 'utf8')
    const rows = (/PROFILE_PATCH_OPERATOR_ROWS="([^"]*)"/.exec(install)?.[1] ?? '').split(' ').sort()
    const sections = (/PROFILE_PATCH_OPERATOR_SECTIONS="([^"]*)"/.exec(install)?.[1] ?? '').split(' ').sort()
    expect(rows).toBeDefined()
    expect(sections).toBeDefined()
    for (const guard of [
      'profile/web/scripts/verify-profile-template.mjs',
      'profile/web/packages/enpoi-capabilities/tests/profile-patch.spec.ts',
    ]) {
      const source = readFileSync(join(repoRoot, guard), 'utf8')
      expect(extractQuotedList(source, 'STATE_ROWS').sort()).toEqual(rows)
      expect(extractQuotedList(source, 'STATE_SECTIONS').sort()).toEqual(sections)
    }
  })
})

describe('rollback restore', () => {
  it('always restores migration-touched files and keeps other files whose content changed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-restore-'))
    const home = join(dir, 'dsh')
    const profile = join(home, 'profiles', 'web')
    const backup = join(dir, 'backup')
    const base = Math.floor(Date.now() / 1000) - 1000
    // Migration-touched files: the update pipeline rewrites these, so they are
    // restored from the pristine snapshot even though the live content differs.
    const settings = join(home, 'settings.yaml')
    const patch = join(profile, 'cordis.patch.yml')
    // A file the pipeline does not rewrite: differing content is an operator
    // edit and survives.
    const pools = join(home, 'pools', 'commandcode.json')
    // A file the update removed: it is recreated from the snapshot.
    const overlay = join(home, 'heavy-server-overlay.json')
    for (const [target, backupContent, liveContent] of [
      [settings, 'seed: before\n', 'seed: migrated\n'],
      [patch, '# before\n', '# migrated\n'],
      [pools, '{"pools":{"k":["old"]}}\n', '{"pools":{"k":["edited"]}}\n'],
      [overlay, '{"providers":{}}\n', null],
    ] as const) {
      const backupFile = join(backup, 'root', target.slice(1))
      mkdirSync(dirname(backupFile), { recursive: true })
      writeFileSync(backupFile, backupContent)
      utimesSync(backupFile, base, base)
      if (liveContent !== null) {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, liveContent)
        utimesSync(target, base + 60, base + 60) // newer mtime must not skip a migration-touched file
      }
    }
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'VERBOSE=1',
      'DSH_HOME="$HOME_VALUE"',
      'PROFILE_DIR="$PROFILE_VALUE"',
      'restore_user_files "$BACKUP" 2>&1',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, BACKUP: backup, HOME_VALUE: home, PROFILE_VALUE: profile },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(readFileSync(settings, 'utf8')).toBe('seed: before\n')
    expect(readFileSync(patch, 'utf8')).toBe('# before\n')
    expect(readFileSync(pools, 'utf8')).toBe('{"pools":{"k":["edited"]}}\n')
    expect(readFileSync(overlay, 'utf8')).toBe('{"providers":{}}\n')
    const output = `${result.stdout}${result.stderr}`
    expect(output).toContain('restored')
    expect(output).toContain('content differs')
  })
})

describe('pre-switch failure restore', () => {
  it('restores the pristine snapshot and disarms the EXIT-trap catch-all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-preswitch-'))
    const home = join(dir, 'dsh')
    const profile = join(home, 'profiles', 'web')
    const backup = join(dir, 'backup')
    const settings = join(home, 'settings.yaml')
    const backupFile = join(backup, 'root', settings.slice(1))
    mkdirSync(dirname(backupFile), { recursive: true })
    writeFileSync(backupFile, 'seed: pristine\n')
    mkdirSync(dirname(settings), { recursive: true })
    writeFileSync(settings, 'seed: migrated\n')
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'VERBOSE=1',
      'DSH_HOME="$HOME_VALUE"',
      'PROFILE_DIR="$PROFILE_VALUE"',
      'PRE_SWITCH_RESTORE="$BACKUP"',
      'restore_pre_switch "$BACKUP" "the build" 2>&1',
      'printf "MARKER=%s\\n" "$PRE_SWITCH_RESTORE"',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, BACKUP: backup, HOME_VALUE: home, PROFILE_VALUE: profile },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(readFileSync(settings, 'utf8')).toBe('seed: pristine\n')
    const output = `${result.stdout}${result.stderr}`
    expect(output).toContain('failed before the switch')
    expect(output).toContain('MARKER=')
  })

  it('wires a pristine-snapshot restore into every pre-switch failure path', () => {
    const install = readFileSync(installSh, 'utf8')
    const doUpdate = /do_update\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]
    expect(doUpdate).toBeDefined()
    expect(doUpdate!.match(/restore_pre_switch "\$backup"/g)).toHaveLength(4)
    expect(doUpdate).toMatch(/if ! install_tree; then[\s\S]*?restore_pre_switch/)
    expect(doUpdate).toMatch(/if ! prepare_profile; then[\s\S]*?restore_pre_switch/)
    expect(doUpdate).toMatch(/if ! run_migrations; then[\s\S]*?restore_pre_switch/)
    // The no-op "already up to date" path arms the same restore around its
    // profile refresh, so its self-check failure cannot leave merged files.
    expect(doUpdate).toMatch(/already up to date[\s\S]*?PRE_SWITCH_RESTORE="\$backup"/)
    expect(doUpdate).toMatch(/restore_pre_switch "\$backup" "already up to date self-check"/)
    // Rollback always restores the pristine early backup, never the late one.
    expect(doUpdate).toMatch(/rollback "\$current" "\$backup" "\$TREE_DIR_NAME"/)
    expect(install).not.toContain('${late_backup:-$backup}')
  })

  it('always restores the profile settings.yaml a baseline merge rewrites', () => {
    const install = readFileSync(installSh, 'utf8')
    const restore = /restore_user_files\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]
    expect(restore).toBeDefined()
    expect(restore).toContain('"${PROFILE_DIR:-}/settings.yaml"|')
  })

  it('never archives the tree being restored or a pre-existing reused tree', () => {
    const install = readFileSync(installSh, 'utf8')
    const rollback = /rollback\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]
    expect(rollback).toBeDefined()
    expect(rollback).toMatch(/\$failed" != "\$prev"/)
    expect(rollback).toContain('REUSED_TREE_DIR')
  })
})

describe('atomic current switch', () => {
  it('chains GNU mv -T, BSD mv -h, and Node rename without removing the link first', () => {
    const install = readFileSync(installSh, 'utf8')
    const fn = /switch_current\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]
    expect(fn).toBeDefined()
    expect(fn).toMatch(/mv -Tf "\$tmp" "\$link"/)
    expect(fn).toMatch(/mv -hf "\$tmp" "\$link"/)
    expect(fn).toMatch(/renameSync/)
    expect(fn).not.toMatch(/rm -f "\$link"/)
    const order = [fn!.indexOf('mv -Tf'), fn!.indexOf('mv -hf'), fn!.indexOf('renameSync')]
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})

describe('profile refresh wiring', () => {
  it('--no-profile-merge skips the patch merge but still unions dependencies', () => {
    const shippedRoot = join(root, 'shipped-root')
    const live = join(root, 'live-profile')
    const shipped = join(shippedRoot, 'profile', 'web')
    mkdirSync(shipped, { recursive: true })
    mkdirSync(live, { recursive: true })
    writeFileSync(join(shipped, 'cordis.patch.yml'), '- id: new-shipped-row\n  name: "@deepseek-ai/dsh-new"\n')
    writeFileSync(join(shipped, 'package.json'), JSON.stringify({ dependencies: { shipped: '1.0.0' } }))
    writeFileSync(join(live, 'cordis.patch.yml'), '# live patch\n')
    writeFileSync(join(live, 'package.json'), JSON.stringify({ dependencies: { 'user-only': '9.9.9' } }))
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'NODE="$(command -v node)"',
      'HARNESS="$SHIPPED_ROOT"',
      'PROFILE=web',
      'PROFILE_DIR="$LIVE"',
      'NO_PROFILE_MERGE=1',
      'VERBOSE=1',
      'refresh_profile_merges 2>&1',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, SHIPPED_ROOT: shippedRoot, LIVE: live },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    // The escape hatch holds the live patch byte-identical.
    expect(readFileSync(join(live, 'cordis.patch.yml'), 'utf8')).toBe('# live patch\n')
    // The dependency union still runs (it never drops user keys).
    expect(parseManifest(join(live, 'package.json')).dependencies).toEqual({ 'user-only': '9.9.9', shipped: '1.0.0' })
    expect(`${result.stdout}${result.stderr}`).toContain('--no-profile-merge')
  })
})

describe('update artifact pruning', () => {
  it('keeps the newest two archives and the newest five backup sets', () => {
    const prefix = join(root, 'prune-prefix')
    const profile = join(root, 'prune-profile')
    const cache = join(prefix, 'harness', '.cache')
    mkdirSync(cache, { recursive: true })
    mkdirSync(profile, { recursive: true })
    const base = Math.floor(Date.now() / 1000) - 100000
    for (let index = 0; index < 4; index += 1) {
      const tarball = join(cache, `dsh-harness-1.0.0-${index}-linux-x64.tar.gz`)
      writeFileSync(tarball, `archive ${index}`)
      writeFileSync(`${tarball}.sha256`, `hash ${index}`)
      utimesSync(tarball, base + index, base + index)
      utimesSync(`${tarball}.sha256`, base + index, base + index)
    }
    for (let index = 0; index < 7; index += 1) {
      const dir = join(prefix, 'harness', `.backup-2026010${index}-000000`)
      mkdirSync(dir, { recursive: true })
      utimesSync(dir, base + index, base + index)
      const patchBackup = join(profile, `cordis.patch.yml.backup-2026010${index}-000000`)
      writeFileSync(patchBackup, `backup ${index}`)
      utimesSync(patchBackup, base + index, base + index)
    }
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'PREFIX="$PREFIX_VALUE"',
      'PROFILE_DIR="$PROFILE_VALUE"',
      'prune_update_artifacts 2>&1',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, PREFIX_VALUE: prefix, PROFILE_VALUE: profile },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(readdirSync(cache).filter(name => name.endsWith('.tar.gz'))).toHaveLength(2)
    expect(readdirSync(cache).filter(name => name.endsWith('.sha256'))).toHaveLength(2)
    expect(readdirSync(join(prefix, 'harness')).filter(name => name.startsWith('.backup-'))).toHaveLength(5)
    expect(readdirSync(profile).filter(name => name.includes('.backup-'))).toHaveLength(5)
  })
})

describe('profile package.json dependency union', () => {
  it('keeps user-only dependencies and lets shipped versions win conflicts', () => {
    const shipped = fixture('shipped.package.json', JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { a: '2.0.0', b: '1.0.0' },
      devDependencies: { vitest: '^4.0.0' },
    }, null, 2))
    const live = fixture('live.package.json', JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { a: '1.0.0', 'user-only': '9.9.9' },
      scripts: { postinstall: 'node scripts/dsh-rebrand.mjs' },
    }, null, 2))
    const result = runPackageMerge(shipped, live)
    expect(result.status).toBe(0)
    const merged = parseManifest(live)
    expect(merged.dependencies).toEqual({ a: '2.0.0', 'user-only': '9.9.9', b: '1.0.0' })
    expect(merged.devDependencies).toEqual({ vitest: '^4.0.0' })
    expect(merged.scripts).toEqual({ postinstall: 'node scripts/dsh-rebrand.mjs' })
    // Re-running a merged manifest is a no-op.
    const before = readFileSync(live, 'utf8')
    const second = runPackageMerge(shipped, live)
    expect(second.status).toBe(0)
    expect(readFileSync(live, 'utf8')).toBe(before)
  })

  it('aborts instead of clobbering an unparseable live manifest', () => {
    const shipped = fixture('broken-shipped.package.json', JSON.stringify({ dependencies: { 'shipped-dep': '1.0.0' } }))
    const live = fixture('broken-live.package.json', '{"dependencies": ')
    const before = readFileSync(live, 'utf8')
    const result = runPackageMerge(shipped, live)
    expect(result.status).toBe(1)
    expect(readFileSync(live, 'utf8')).toBe(before)
    expect(result.output).toContain('refusing to overwrite')
    expect(result.output).toContain('shipped-dep')
  })
})

describe('peer CLI distribution', () => {
  const peerScript = join(repoRoot, 'scripts', 'dsh-peer.mjs')

  it('ships a self-contained caller-side script with every command', () => {
    const peer = readFileSync(peerScript, 'utf8')
    expect(peer.startsWith('#!/usr/bin/env node\n')).toBe(true)
    const imports = [...peer.matchAll(/^import .* from '([^']+)'/gmu)].map(match => match[1] ?? '')
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.every(specifier => specifier.startsWith('node:'))).toBe(true)
    for (const command of ['handshake', 'status', 'list', 'ask', 'follow', 'asks', 'answer', 'cancel']) {
      expect(peer).toContain(`${command}: command`)
    }
  })

  it('install seeds dsh-peer and update refreshes it, honoring the recorded bin dir', () => {
    const install = readFileSync(installSh, 'utf8')
    const doInstall = /do_install\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]
    const doUpdate = /do_update\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]
    expect(doInstall).toBeDefined()
    expect(doUpdate).toBeDefined()
    // Install seeds it; both update paths (full and already-current) refresh it.
    expect(doInstall!.match(/write_peer_cli/g) ?? []).toHaveLength(1)
    expect(doInstall).toMatch(/write_peer_cli \|\| warn/)
    expect(doUpdate!.match(/write_peer_cli/g) ?? []).toHaveLength(2)
    // The recorded binDir resolution comes first, exactly like the shim.
    const binResolve = doUpdate!.indexOf('recorded_bin="$(json_field "$state" binDir)"')
    expect(doUpdate).toContain('"$BIN_DIR_EXPLICIT" = 0')
    expect(binResolve).toBeGreaterThanOrEqual(0)
    expect(doUpdate!.indexOf('write_peer_cli')).toBeGreaterThan(binResolve)
    // The seeder writes into the resolved BIN_DIR from the harness tree and is fail-soft.
    const fn = /write_peer_cli\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]
    expect(fn).toBeDefined()
    expect(fn).toContain('scripts/dsh-peer.mjs')
    expect(fn).toContain('"$BIN_DIR/dsh-peer"')
    expect(fn).toContain('chmod 755')
    expect(fn).not.toMatch(/\bdie\b/)
  })

  it('seeds the script with mode 755 and fails soft when the source is absent', () => {
    const harness = join(root, 'peer-harness')
    const bin = join(root, 'peer-bin')
    mkdirSync(join(harness, 'scripts'), { recursive: true })
    writeFileSync(join(harness, 'scripts', 'dsh-peer.mjs'), '#!/usr/bin/env node\nconsole.log("peer")\n')
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'HARNESS="$HARNESS_VALUE"',
      'BIN_DIR="$BIN_VALUE"',
      'write_peer_cli',
      'printf "RC=%s\\n" "$?"',
    ].join('\n')
    const seeded = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, HARNESS_VALUE: harness, BIN_VALUE: bin },
      encoding: 'utf8',
    })
    expect(seeded.status).toBe(0)
    const target = join(bin, 'dsh-peer')
    expect(readFileSync(target, 'utf8')).toBe('#!/usr/bin/env node\nconsole.log("peer")\n')
    expect(statSync(target).mode & 0o777).toBe(0o755)
    // A harness tree without the script is a warning at the call site, not a failure.
    const missing = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, HARNESS_VALUE: join(root, 'peer-harness-empty'), BIN_VALUE: join(root, 'peer-bin-empty') },
      encoding: 'utf8',
    })
    expect(missing.status).toBe(0)
    expect(`${missing.stdout}${missing.stderr}`).toContain('RC=1')
    expect(existsSync(join(root, 'peer-bin-empty', 'dsh-peer'))).toBe(false)
  })

  it('fish ds.fish carries a peer function delegating to the installed CLI', () => {
    const fish = readFileSync(join(repoRoot, 'profile/web/fish/ds.fish'), 'utf8')
    const block = /case "peer"[\s\S]*?case "/.exec(fish)?.[0] ?? ''
    expect(block).toContain('command -v dsh-peer')
    expect(block).toContain('$bin_dir/dsh-peer')
    expect(block).toContain('$HOME/.local/bin/dsh-peer')
    expect(block).toMatch(/command \$peer_bin \$subargs/)
    expect(block).toContain('re-run the installer')
  })
})

describe('download resilience', () => {
  it('resumes partial prebuilt downloads and aborts stalled transfers', () => {
    const install = readFileSync(installSh, 'utf8')
    const window = /Downloading prebuilt harness[\s\S]{0,700}/.exec(install)?.[0] ?? ''
    expect(window).toContain('-C -')
    expect(window).toContain('--speed-time 60')
    expect(window).toContain('--retry-all-errors')
    // A killed attempt keeps its partial so the next run resumes it.
    expect(install).not.toContain('rm -f "$asset_file.download"')
    // The stall-aware options also guard the source-archive fetch.
    expect(install).toMatch(/Downloading release archive"[\s\S]{0,200}--speed-time 60/)
  })
})
