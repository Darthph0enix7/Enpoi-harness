import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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

function runPatchedDependenciesMerge(shipped: string, live: string) {
  return runBash('NODE="$(command -v node)"\nmerge_profile_workspace_patched_dependencies "$SHIPPED" "$LIVE" 2>&1', shipped, live)
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

  it('preserves operator personas across a template resync', () => {
    // The shipped template carries no personas (they are first-run seed
    // state), so re-applying it must leave the live customizations byte-intact.
    const shipped = fixture('resync-shipped.patch.yml', guardFixture(CLEAN_ENTRIES))
    const live = fixture('resync-live.patch.yml', `- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
  config:
    parameters:
      keeper:
        structuralDistanceK: 9
    roles:
      designer:
        label: Designer
        group: specialists
        seat: true
    personas:
      keeper:
        provider: operator-router
        model: operator/keeper
`)
    const result = runPatchMerge(shipped, live)
    expect(result.status).toBe(0)
    const merged = readFileSync(live, 'utf8')
    expect(merged).toContain('provider: operator-router')
    expect(merged).toContain('model: operator/keeper')
    expect(merged).toContain('structuralDistanceK: 9')
    expect(merged).not.toContain('structuralDistanceK: 24')
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

  it('keeps the roles template allowlists in lockstep across the guards', () => {
    const install = readFileSync(installSh, 'utf8')
    const shellValue = (source: string, name: string): string => {
      const match = new RegExp(`${name}="([^"]*)"`).exec(source)
      if (match === null) throw new Error(`no ${name} assignment in the guard`)
      return match[1] ?? ''
    }
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['TEMPLATE_ROLE_IDS', 'PROFILE_PATCH_TEMPLATE_ROLE_IDS'],
      ['TEMPLATE_ROLE_KEYS', 'PROFILE_PATCH_TEMPLATE_ROLE_KEYS'],
    ]
    for (const guard of [
      'profile/web/scripts/verify-profile-template.mjs',
      'profile/web/packages/enpoi-capabilities/tests/profile-patch.spec.ts',
    ]) {
      const source = readFileSync(join(repoRoot, guard), 'utf8')
      for (const [jsName, shName] of pairs) {
        expect(extractQuotedList(source, jsName).sort(), `${guard} ${jsName}`)
          .toEqual(shellValue(install, shName).split(' ').sort())
      }
    }
    // The web sandbox duplicates the fresh-patch stripper for its own homes;
    // its standalone allowlist constants must match install.sh's.
    const sandbox = readFileSync(join(repoRoot, 'apps/web/tests/scripts/sandbox.sh'), 'utf8')
    for (const [, shName] of pairs) {
      const sandboxName = shName.replace('PROFILE_PATCH_', '')
      expect(shellValue(sandbox, sandboxName).split(' ').sort(), `sandbox.sh ${sandboxName}`)
        .toEqual(shellValue(install, shName).split(' ').sort())
    }
    // Personas are route state now: no guard may keep a persona allowlist, and
    // install.sh must strip the section like every other operator section.
    for (const source of [install, readFileSync(join(repoRoot, 'apps/web/tests/scripts/sandbox.sh'), 'utf8')]) {
      expect(source).not.toMatch(/TEMPLATE_PERSONA_/)
    }
    expect(install).toMatch(/strip_patch_sections "\$file" [^\n]*personas/)
  })
})

/** One guard fixture: the minimal enpoi-orchestration row the gates inspect. */
function guardFixture(extra = ''): string {
  return `# fixture template
- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
  config:
    parameters:
      keeper:
        structuralDistanceK: 24
${extra}`
}

const CLEAN_ENTRIES = `    roles:
      designer:
        label: Designer
        group: specialists
        seat: true
      oracle:
        label: The Oracle
        group: supervision
        seat: true
`

const HOSTILE_ENTRIES = `    roles:
      designer:
        persona: |
          operator text
        label: Designer
        group: specialists
        seat: true
      toto:
        label: Operator
        group: specialists
    personas:
      keeper:
        provider: openrouter
        model: kilo-auto/free
        chain: free
      oracle:
        provider: kilo
        model: kilo-auto/free
      compaction:
        provider: kilo
        model: kilo-auto/free
`

describe('template entry allowlist gate', () => {
  const verifyScript = join(repoRoot, 'profile/web/scripts/verify-profile-template.mjs')

  function runVerify(file: string): { status: number; output: string } {
    const result = spawnSync(process.execPath, [verifyScript, file], { encoding: 'utf8' })
    return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  function runPatchGate(file: string): { status: number; output: string } {
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'if assert_fresh_patch "$SHIPPED"; then echo ASSERT=PASS; else echo ASSERT=FAIL; fi',
      'strip_fresh_patch "$SHIPPED"',
      'if assert_fresh_patch "$SHIPPED"; then echo STRIPPED=PASS; else echo STRIPPED=FAIL; fi',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, SHIPPED: file },
      encoding: 'utf8',
    })
    return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  it('accepts a clean template through the packaging script and the installer gates', () => {
    const clean = fixture('clean-template.patch.yml', guardFixture(CLEAN_ENTRIES))
    const verified = runVerify(clean)
    expect(verified.status).toBe(0)
    expect(verified.output).toContain('profile template clean')
    const gated = runPatchGate(clean)
    expect(gated.status).toBe(0)
    expect(gated.output).toContain('ASSERT=PASS')
    expect(gated.output).toContain('STRIPPED=PASS')
  })

  it('rejects a committed device patch beside the template', () => {
    counter += 1
    const dir = join(root, `${counter}-device-patch-template`)
    mkdirSync(join(dir, 'device-patches', 'serverlocal'), { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), guardFixture(CLEAN_ENTRIES))
    writeFileSync(join(dir, 'device-patches', 'serverlocal.yaml'), 'merge:\n')
    const flat = runVerify(join(dir, 'cordis.patch.yml'))
    expect(flat.status).toBe(1)
    expect(flat.output).toContain("device patch 'device-patches/serverlocal.yaml' is committed operator state")
    writeFileSync(join(dir, 'device-patches', 'serverlocal', 'preset.yml'), 'name: sysadmin\n')
    const nested = runVerify(join(dir, 'cordis.patch.yml'))
    expect(nested.status).toBe(1)
    expect(nested.output).toContain("device patch 'device-patches/serverlocal/preset.yml' is committed operator state")
  })

  it('accepts a device-patches directory that only keeps its README', () => {
    counter += 1
    const dir = join(root, `${counter}-device-patch-readme`)
    mkdirSync(join(dir, 'device-patches'), { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), guardFixture(CLEAN_ENTRIES))
    writeFileSync(join(dir, 'device-patches', 'README.md'), '# patches\n')
    const accepted = runVerify(join(dir, 'cordis.patch.yml'))
    expect(accepted.status).toBe(0)
    expect(accepted.output).toContain('profile template clean')
  })

  it('rejects every operator escape inside roles and strips it entry-by-entry', () => {
    const hostile = fixture('hostile-template.patch.yml', guardFixture(HOSTILE_ENTRIES))
    const verified = runVerify(hostile)
    expect(verified.status).toBe(1)
    for (const marker of [
      "role 'toto' is not a template role",
      "role 'designer' carries operator key 'persona'",
      "operator-owned section 'personas'",
    ]) {
      expect(verified.output, marker).toContain(marker)
    }
    const gated = runPatchGate(hostile)
    expect(gated.status).toBe(0)
    expect(gated.output).toContain('ASSERT=FAIL')
    expect(gated.output).toContain('STRIPPED=PASS')
    const stripped = readFileSync(hostile, 'utf8')
    expect(stripped).not.toContain('toto')
    expect(stripped).not.toContain('operator text')
    expect(stripped).not.toContain('openrouter')
    expect(stripped).not.toContain('chain: free')
    // Personas are route state written by the first-run seed: the whole
    // section drops. The clean designer entry survives entry-by-entry.
    expect(stripped).not.toContain('    personas:')
    expect(stripped).not.toContain('provider:')
    expect(stripped).not.toContain('model: kilo-auto/free')
    expect(stripped).toContain('      designer:\n        label: Designer')
  })
})

describe('promoted web composition merge', () => {
  it('adds the web rows and wizard inserts without merging the operator-owned sections', () => {
    const shipped = fixture('web-shipped.patch.yml', `# shipped template
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: exa
    fetchProvider: http

- insert:
    - id: web-search-exa
      name: "@deepseek-ai/dsh-web-search-exa"
      config:
        searchType: auto
        highlightsPerResult: 2

- insert:
    - id: web-setup
      name: "@deepseek-ai/dsh-web-setup"

- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
  config:
    parameters:
      keeper:
        structuralDistanceK: 24
    roles:
      designer:
        label: Designer
        group: specialists
        seat: true
    personas:
      keeper:
        provider: kilo
        model: kilo-auto/free
`)
    const live = fixture('web-live.patch.yml', `- id: enpoi-orchestration
  name: dsh-enpoi-capabilities
  config:
    parameters:
      keeper:
        structuralDistanceK: 24
    capabilities:
      operator: true
`)
    const result = runPatchMerge(shipped, live)
    expect(result.status).toBe(0)
    const merged = readFileSync(live, 'utf8')
    // Additive rows and inserts arrive.
    expect(merged).toContain('\n- id: web\n')
    expect(merged).toContain('    - id: web-search-exa\n')
    expect(merged).toContain('    - id: web-setup\n')
    // roles/personas stay operator-owned section names: the shipped template
    // entries never converge into an existing live document.
    expect(merged).not.toContain('    roles:')
    expect(merged).not.toContain('    personas:')
    expect(merged).toContain('    capabilities:\n      operator: true\n')
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
      // Release-version asset names (`<base>.<run number>`), no commit SHA.
      const tarball = join(cache, `dsh-harness-1.0.0.${index}-linux-x64.tar.gz`)
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

describe('profile patchedDependencies union', () => {
  const SHIPPED_WORKSPACE = `packages:
  - .

nodeLinker: hoisted

autoInstallPeers: false

allowBuilds:
  esbuild: true

patchedDependencies:
  dsh-compressor@0.1.0: patches/dsh-compressor@0.1.0.patch
  dsh-fast@0.2.14: patches/dsh-fast@0.2.14.patch
`

  it('adds the shipped declaration to an old workspace that has none', () => {
    const shipped = fixture('shipped.pnpm-workspace.yaml', SHIPPED_WORKSPACE)
    const liveBefore = `packages:
  - .

nodeLinker: hoisted

autoInstallPeers: false

allowBuilds:
  node-pty: true
`
    const live = fixture('live-old.pnpm-workspace.yaml', liveBefore)
    const result = runPatchedDependenciesMerge(shipped, live)
    expect(result.status).toBe(0)
    const merged = readFileSync(live, 'utf8')
    // Everything outside the appended block is byte-identical; no duplicate keys.
    expect(merged.startsWith(liveBefore)).toBe(true)
    expect(merged).toContain('patchedDependencies:\n  dsh-compressor@0.1.0: patches/dsh-compressor@0.1.0.patch\n  dsh-fast@0.2.14: patches/dsh-fast@0.2.14.patch')
    expect(merged.match(/dsh-compressor@0\.1\.0:/g)).toHaveLength(1)
    expect(result.output).toContain('added 2 patchedDependencies entries')
    // Idempotent: a second merge is a no-op and the file stays byte-identical.
    const after = readFileSync(live, 'utf8')
    const second = runPatchedDependenciesMerge(shipped, live)
    expect(second.status).toBe(0)
    expect(readFileSync(live, 'utf8')).toBe(after)
  })

  it('keeps user-only entries and lets shipped values win conflicts', () => {
    const shipped = fixture('shipped2.pnpm-workspace.yaml', SHIPPED_WORKSPACE)
    const liveBefore = `packages:
  - .

patchedDependencies:
  user-patch@1.0.0: patches/user.patch
  dsh-fast@0.2.14: patches/OLD-fast.patch

onlyBuiltDependencies:
  - esbuild
`
    const live = fixture('live2.pnpm-workspace.yaml', liveBefore)
    const result = runPatchedDependenciesMerge(shipped, live)
    expect(result.status).toBe(0)
    const merged = readFileSync(live, 'utf8')
    expect(merged).toContain('user-patch@1.0.0: patches/user.patch')
    expect(merged).toContain('dsh-fast@0.2.14: patches/dsh-fast@0.2.14.patch')
    expect(merged).not.toContain('OLD-fast.patch')
    expect(merged).toContain('dsh-compressor@0.1.0: patches/dsh-compressor@0.1.0.patch')
    // The block after the mapping is untouched.
    expect(merged).toContain('onlyBuiltDependencies:\n  - esbuild')
    expect(result.output).toContain('1 added, 1 updated, 1 user-only kept')
  })

  it('is a no-op when the live workspace already carries every shipped entry', () => {
    const shipped = fixture('shipped3.pnpm-workspace.yaml', SHIPPED_WORKSPACE)
    const live = fixture('live3.pnpm-workspace.yaml', SHIPPED_WORKSPACE)
    const before = readFileSync(live, 'utf8')
    const result = runPatchedDependenciesMerge(shipped, live)
    expect(result.status).toBe(0)
    expect(readFileSync(live, 'utf8')).toBe(before)
    expect(result.output).toContain('already carries every shipped patchedDependencies entry')
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

describe('fish function refresh', () => {
  function runSeedProfileHome(stage: string, home: string): { status: number; output: string } {
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'VERBOSE=1',
      'DSH_HOME="$HOME/.dsh"',
      'PROFILE_DIR="$DSH_HOME/profiles/web"',
      'seed_profile_home "$STAGE" 2>&1',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: {
        ...process.env,
        INSTALL_SH: installSh,
        STAGE: stage,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
      },
      encoding: 'utf8',
    })
    return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  function fishStage(name: string, fn: string, completion: string): string {
    const dir = join(root, name)
    mkdirSync(join(dir, 'fish', 'completions'), { recursive: true })
    writeFileSync(join(dir, 'fish', 'ds.fish'), fn)
    writeFileSync(join(dir, 'fish', 'completions', 'ds.fish'), completion)
    return dir
  }

  function fishHome(): { home: string; fn: string; comp: string } {
    const home = mkdtempSync(join(root, 'fish-home-'))
    const fish = join(home, '.config', 'fish')
    mkdirSync(fish, { recursive: true })
    return { home, fn: join(fish, 'functions', 'ds.fish'), comp: join(fish, 'completions', 'ds.fish') }
  }

  it('seeds both files and records the shipped hash on a fresh install', () => {
    const { home, fn, comp } = fishHome()
    const result = runSeedProfileHome(fishStage('seed-stage', 'function ds-v1\nend\n', 'complete -c ds -a v1\n'), home)
    expect(result.status).toBe(0)
    expect(readFileSync(fn, 'utf8')).toBe('function ds-v1\nend\n')
    expect(readFileSync(comp, 'utf8')).toBe('complete -c ds -a v1\n')
    expect(result.output).toContain('seeded')
    for (const target of [fn, comp]) {
      const record = readFileSync(`${target}.dsh-seeded`, 'utf8').trim().split('\n')
      expect(record).toHaveLength(2)
      expect(record[0]).toMatch(/^[0-9a-f]{64}$/)
      expect(record[1]).toBe(record[0])
    }
  })

  it('refreshes an untouched seeded copy on the next install/update', () => {
    const { home, fn, comp } = fishHome()
    runSeedProfileHome(fishStage('refresh-stage-v1', 'function ds-v1\nend\n', 'complete -c ds -a v1\n'), home)
    const result = runSeedProfileHome(fishStage('refresh-stage-v2', 'function ds-v2\nend\n', 'complete -c ds -a v2\n'), home)
    expect(result.status).toBe(0)
    expect(readFileSync(fn, 'utf8')).toBe('function ds-v2\nend\n')
    expect(readFileSync(comp, 'utf8')).toBe('complete -c ds -a v2\n')
    expect(result.output).toContain('refreshed')
    // The record now points at the refreshed shipped copy.
    const record = readFileSync(`${fn}.dsh-seeded`, 'utf8').trim().split('\n')
    expect(record[0]).toBe(record[1])
  })

  it('keeps a locally edited copy, parks the shipped update beside it, and warns once', () => {
    const { home, fn, comp } = fishHome()
    runSeedProfileHome(fishStage('drift-stage-v1', 'function ds-v1\nend\n', 'complete -c ds -a v1\n'), home)
    writeFileSync(fn, 'function ds-local\nend\n')
    const drift = runSeedProfileHome(fishStage('drift-stage-v2', 'function ds-v2\nend\n', 'complete -c ds -a v2\n'), home)
    expect(drift.status).toBe(0)
    // The local edit is preserved byte-identical, the shipped update is parked
    // beside it, and the notice names the profile tree copy.
    expect(readFileSync(fn, 'utf8')).toBe('function ds-local\nend\n')
    expect(drift.output).toContain('local edits')
    expect(drift.output).toContain(join(home, '.dsh', 'profiles', 'web', 'fish', 'ds.fish'))
    const backups = readdirSync(dirname(fn)).filter(name => name.startsWith('ds.fish.dsh-shipped-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dirname(fn), backups[0]!), 'utf8')).toBe('function ds-v2\nend\n')
    // The untouched completions file refreshes alongside the kept function.
    expect(readFileSync(comp, 'utf8')).toBe('complete -c ds -a v2\n')
    // The same local edit against the same shipped copy does not warn again.
    const again = runSeedProfileHome(fishStage('drift-stage-v2', 'function ds-v2\nend\n', 'complete -c ds -a v2\n'), home)
    expect(again.output).not.toContain('local edits')
  })

  it('routes both fish files through the refresh helper on the install and update paths', () => {
    const install = readFileSync(installSh, 'utf8')
    const seedProfileHome = /seed_profile_home\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]
    expect(seedProfileHome).toBeDefined()
    expect(seedProfileHome!.match(/refresh_seeded_fish/g) ?? []).toHaveLength(2)
    expect(seedProfileHome!).toContain('"$stage/fish/ds.fish"')
    expect(seedProfileHome!).toContain('"$stage/fish/completions/ds.fish"')
    // Install, the already-current update path, and the full update path all
    // reach seed_profile_home through prepare_profile.
    expect(/do_install\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]).toMatch(/prepare_profile/)
    const doUpdate = /do_update\(\) \{[\s\S]*?\n\}/.exec(install)?.[0]
    expect(doUpdate!.match(/prepare_profile/g) ?? []).toHaveLength(2)
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

  it('wires the parallel chunk engine with chunk preservation and checksum gating', () => {
    const install = readFileSync(installSh, 'utf8')
    expect(install).toContain('resolve_fast_downloader')
    expect(install).toContain('write_fast_downloader')
    // Parallel engine runs before single-stream curl fallback
    const prebuiltBlock = /stage_prebuilt\(\) \{[\s\S]*?\n\}/.exec(install)?.[0] ?? ''
    expect(prebuiltBlock).toContain('Fetching prebuilt release ($OS-$ARCH, parallel)')
    expect(prebuiltBlock).toContain('resolve_fast_downloader')
    // User abort exits 130 cleanly with chunks preserved rather than falling back to source build
    expect(prebuiltBlock).toContain('exit 130')
    // Falls back to single-stream curl on Range refusal
    expect(prebuiltBlock).toContain('falling back to single-stream curl')
  })
})

/**
 * The release/versioning scheme: one GitHub Release per build, tagged
 * `v<package version>.<workflow run number>`, holding exactly the three
 * platform tarballs plus their `.sha256` sidecars and a `SHA256SUMS` manifest.
 * Asset names carry the release tag and never a commit SHA; the installer
 * resolves the newest published release and accepts the tree's base version.
 */
describe('release-based prebuilt resolution', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'harness-release.yml'), 'utf8')

  it('names releases and assets with the version, never a commit SHA', () => {
    const install = readFileSync(installSh, 'utf8')
    // Installer: release tag -> version -> SHA-free asset.
    expect(install).toContain('tag="$(latest_release_tag)"')
    expect(install).toContain('version="${tag#v}"')
    expect(install).toContain('asset="dsh-harness-$version-$OS-$ARCH.tar.gz"')
    expect(install).toContain('url="$DSH_GITHUB_URL/releases/download/$tag/$asset"')
    expect(install).not.toMatch(/dsh-harness-\$version-\$TARGET_COMMIT/)
    expect(install).not.toMatch(/asset="[^"]*\$TARGET_COMMIT/)
    expect(install).not.toMatch(/releases\/download\/v\$version/)

    // Workflow: release version = package version + monotonic run number.
    expect(workflow).toContain('VERSION="$BASE.$GITHUB_RUN_NUMBER"')
    expect(workflow).toContain('ASSET="dsh-harness-$VERSION-${{ matrix.os }}-${{ matrix.arch }}.tar.gz"')
    expect(workflow).not.toMatch(/ASSET=.*COMMIT/)
    expect(workflow).not.toMatch(/TOP=.*COMMIT/)
  })

  it('smoke-boots the pruned stage and packs exactly that tree', () => {
    // Staging and pruning run before the smoke, so the boot gate covers the
    // bytes the tarball ships; the prune categories themselves are pinned by
    // scripts/prune-release-tree.spec.ts.
    expect(workflow).toContain('bash "$GITHUB_WORKSPACE/scripts/prune-release-tree.sh" "$STAGE/$TOP"')
    expect(workflow).toContain('ROOT="${{ steps.stage.outputs.tree }}"')
    expect(workflow).toContain('--import "$GITHUB_WORKSPACE/apps/cli/tests/fixtures/web-browser-open/register.mjs"')
    expect(workflow).toContain('tar -czf "$ASSET" -C "$STAGE" "$TOP"')
    // A no-op or partial prune must fail the release, not ship the weight.
    expect(workflow).toContain('test ! -e "$STAGE/$TOP/.agents/notes"')
    expect(workflow).toContain("test -z \"$(find \"$STAGE/$TOP\" -name '*.map' -print -quit)\"")
  })

  it('publishes exactly one release per commit through a draft that only publish flips', () => {
    // One trigger branch: stable and beta are pushed with the same commit, so
    // the stable run is the single build and beta resolves the same stream.
    expect(workflow).toMatch(/push:\n\s+branches:\n\s+- stable\n/)
    expect(workflow).not.toMatch(/branches:\n\s+- stable\n\s+- beta/)
    // Duplicate suppression runs before any build starts, and only a complete
    // new-style release (SHA256SUMS present) suppresses the run.
    expect(workflow).toContain('select(.draft == false)')
    expect(workflow).toContain('target_commitish ==')
    expect(workflow).toContain('any(.assets[]; .name == \\"SHA256SUMS\\")')
    // Draft until every platform (the matrix) landed; publish owns SHA256SUMS.
    expect(workflow).toContain('gh release create "$TAG" --draft')
    expect(workflow).toContain('gh release edit "$TAG" --draft=false')
    expect(workflow).toContain("gh release download \"$TAG\" --pattern '*.sha256'")
    expect(workflow).toContain('SHA256SUMS')
    // The installer skips drafts twice over: /releases/latest excludes them.
    expect(readFileSync(installSh, 'utf8')).toContain('/releases/latest')
  })

  it('accepts both the release version and its base in the staged-version check', () => {
    const install = readFileSync(installSh, 'utf8')
    expect(install).toContain('base="$(release_base_version "$version")"')
    expect(install).toContain('if [ "$staged_version" != "$version" ] && [ "$staged_version" != "$base" ]; then')
  })

  it('derives the tree base version from the release tag', () => {
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'printf "A=%s\\n" "$(release_base_version 0.1.7-enpoi.2.42)"',
      'printf "B=%s\\n" "$(release_base_version 1.2.3)"',
      'printf "C=%s\\n" "$(release_base_version 1.2.3-rc.4)"',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('A=0.1.7-enpoi.2')
    expect(result.stdout).toContain('B=1.2.3')
    // A numeric prerelease tail strips one component; the staged check also
    // accepts the tag's own version, so a base ending in a number still passes.
    expect(result.stdout).toContain('C=1.2.3-rc')
  })

  it('stages the newest release, verifies it, and accepts the tree base version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-release-'))
    try {
      const prefix = join(dir, 'prefix')
      const tarball = join(dir, 'asset.tar.gz')
      const releaseVersion = '0.1.7-enpoi.2.42'
      const treeTop = join(dir, 'stage-tree', `dsh-harness-${releaseVersion}`)
      mkdirSync(treeTop, { recursive: true })
      writeFileSync(join(treeTop, 'package.json'), JSON.stringify({ name: 'dsh-harness', version: '0.1.7-enpoi.2' }))
      writeFileSync(join(treeTop, 'MARKER'), 'prebuilt\n')
      expect(spawnSync('tar', ['-czf', tarball, '-C', join(dir, 'stage-tree'), `dsh-harness-${releaseVersion}`]).status).toBe(0)
      const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex')
      const shaFile = join(dir, 'asset.sha256')
      writeFileSync(shaFile, `${sha}  dsh-harness-${releaseVersion}-linux-x64.tar.gz\n`)

      // Stub curl serves the /releases/latest redirect, the probe headers, the
      // tarball, and the sidecar; stub git resolves the release tag's commit.
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'curl'), `#!/bin/sh
out=""; url=""; want_redirect=0; want_headers=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    -w) case "$2" in *redirect_url*) want_redirect=1;; esac; shift 2;;
    -D) [ "$2" = "-" ] && want_headers=1; shift 2;;
    -C|--retry|--retry-delay|--connect-timeout|--speed-limit|--speed-time|--max-time|--range) shift 2;;
    -*) shift;;
    *) url="$1"; shift;;
  esac
done
case "$url" in
  */releases/latest)
    [ "$want_redirect" = 1 ] && printf '%s\\n' "$FAKE_RELEASE_URL"
    exit 0;;
  *.sha256) cp "$FAKE_SHA_FILE" "$out"; exit 0;;
  *.tar.gz)
    if [ "$want_headers" = 1 ]; then printf 'content-range: bytes 0-0/1\\n%s' "\${FAKE_PROBE_STATUS:-200}"; exit 0; fi
    cp "$FAKE_TARBALL" "$out"; exit 0;;
esac
exit 1
`, { mode: 0o755 })
      writeFileSync(join(bin, 'git'), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    refs/heads/*) exit 0;;
    refs/tags/*)
      printf '%s\\t%s\\n' "2222222222222222222222222222222222222222" "$arg"
      exit 0;;
  esac
done
exit 0
`, { mode: 0o755 })

      const script = [
        'export DSH_INSTALL_LIB_ONLY=1',
        '. "$INSTALL_SH" 2>/dev/null',
        'NODE="$(command -v node)"',
        'PREFIX="$PREFIX_VALUE"',
        'OS=linux',
        'ARCH=x64',
        'CHANNEL=stable',
        'DSH_GITHUB_URL=https://github.com/example/repo',
        'LOG_FILE=/dev/null',
        'PATH="$STUB_BIN:$PATH"',
        'stage_prebuilt; rc=$?',
        'printf "RC=%s VERSION=%s PREBUILT=%s COMMIT=%s BASE=%s\\n" "$rc" "$VERSION" "$PREBUILT" "$RELEASE_COMMIT" "$(NODE="$NODE" read_version "$STAGED/package.json" 2>/dev/null || true)"',
      ].join('\n')
      const env = {
        ...process.env,
        INSTALL_SH: installSh,
        PREFIX_VALUE: prefix,
        STUB_BIN: bin,
        FAKE_RELEASE_URL: `https://github.com/example/repo/releases/tag/v${releaseVersion}`,
        FAKE_TARBALL: tarball,
        FAKE_SHA_FILE: shaFile,
        FAKE_PROBE_STATUS: '200',
      }
      const result = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('RC=0')
      expect(result.stdout).toContain(`VERSION=${releaseVersion}`)
      expect(result.stdout).toContain('PREBUILT=1')
      // The recorded commit is the release tag's own commit.
      expect(result.stdout).toContain('COMMIT=2222222222222222222222222222222222222222')
      // The tree keeps the base version and the check accepted it.
      expect(result.stdout).toContain('BASE=0.1.7-enpoi.2')
      // The verified tarball and sidecar stay cached under the release name.
      expect(existsSync(join(prefix, 'harness', '.cache', `dsh-harness-${releaseVersion}-linux-x64.tar.gz`))).toBe(true)
      expect(existsSync(join(prefix, 'harness', '.cache', `dsh-harness-${releaseVersion}-linux-x64.tar.gz.sha256`))).toBe(true)

      // A release without this platform's asset reads as a normal fallback:
      // the 404 probe returns before any download, leaving no partial file.
      const fallbackPrefix = join(dir, 'prefix-missing-asset')
      const missing = spawnSync('bash', ['-c', script], {
        env: { ...env, PREFIX_VALUE: fallbackPrefix, FAKE_PROBE_STATUS: '404' },
        encoding: 'utf8',
      })
      expect(missing.status).toBe(0)
      expect(missing.stdout).toContain('RC=1')
      expect(missing.stdout).toContain('PREBUILT=0')
      expect(existsSync(join(fallbackPrefix, 'harness', '.cache', `dsh-harness-${releaseVersion}-linux-x64.tar.gz.download`))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('tailnet peer exposure', () => {
  const GENERATED_UNIT = `# Generated by dsh service install; edits are overwritten only with --force.
[Unit]
Description=Enpoi Harness Web (dsh web)
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/dsh/apps/cli/lib/bin.js web --foreground --host 127.0.0.1 --port 3080 --no-open --trusted-host 127.0.0.1:3080
Restart=on-failure

[Install]
WantedBy=default.target
`

  const GENERATED_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Generated by dsh service install -->
  <key>Label</key><string>com.enpoi.dsh-web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/node</string>
    <string>/opt/dsh/apps/cli/lib/bin.js</string>
    <string>web</string>
    <string>--foreground</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>3080</string>
    <string>--no-open</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`

  /** A stub bin dir with the commands the Linux exposure path dispatches to. */
  function stubDirectory(): string {
    const bin = join(root, `tailnet-bin-${String(counter++)}`)
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'socat'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'hostname'), "#!/bin/sh\nprintf 'testhost\\n'\n", { mode: 0o755 })
    writeFileSync(join(bin, 'systemctl'), [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"',
      'case "$*" in',
      '  *"cat "*) exit 0;;',
      '  *"is-active --quiet "*) exit 1;;',
      '  *) exit 0;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 })
    return bin
  }

  function unitHome(unitContent: string): { home: string; unitPath: string } {
    const home = join(root, `tailnet-home-${String(counter++)}`)
    const dir = join(home, '.config', 'systemd', 'user')
    mkdirSync(dir, { recursive: true })
    const unitPath = join(dir, 'dsh-web.service')
    writeFileSync(unitPath, unitContent)
    return { home, unitPath }
  }

  function runExpose(home: string, stubBin: string, extraEnv: Record<string, string>): { status: number; output: string } {
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'VERBOSE=1',
      'OS=linux',
      'SERVICE_UNIT=dsh-web.service',
      'LOG_FILE=/dev/null',
      'PATH="$STUB_BIN:$PATH"',
      'ensure_tailnet_exposure 2>&1',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, HOME: home, STUB_BIN: stubBin, ...extraEnv },
      encoding: 'utf8',
    })
    return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  it('derives the tailnet IPv4 from interface lines and honors DSH_TAILNET_IP', () => {
    const result = spawnSync('bash', ['-c', [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'printf "A=%s\\n" "$(printf "10.0.0.5\\n192.168.1.7\\n127.0.0.1\\n100.63.9.9\\n100.101.102.103/32\\n100.127.255.254\\n" | tailnet_ipv4_from_lines)"',
      'printf "B=%s\\n" "$(printf "100.64.0.0/10\\n100.128.0.1\\n" | tailnet_ipv4_from_lines)"',
    ].join('\n')], { env: { ...process.env, INSTALL_SH: installSh }, encoding: 'utf8' })
    expect(result.status).toBe(0)
    // 10/8, 192.168/16, 127/8, 100.63.* and 100.128.* are outside 100.64.0.0/10.
    expect(result.stdout).toContain('A=100.101.102.103')
    expect(result.stdout).toContain('B=100.64.0.0')
    expect(result.stdout).not.toContain('100.128.0.1')

    // The ip(8) interface list is the Linux source; the override always wins.
    const bin = stubDirectory()
    writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(bin, 'ip'), [
      '#!/bin/sh',
      "printf '1: lo    inet 127.0.0.1/8 scope host lo\\n2: tailscale0    inet 100.101.102.103/32 scope global tailscale0\\n3: eth0    inet 192.168.1.7/24 scope global eth0\\n'",
      '',
    ].join('\n'), { mode: 0o755 })
    const derived = spawnSync('bash', ['-c', [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'OS=linux',
      'PATH="$STUB_BIN:$PATH"',
      'printf "IP=%s\\n" "$(tailnet_ipv4)"',
      'printf "OVERRIDE=%s\\n" "$(DSH_TAILNET_IP=100.90.10.20 tailnet_ipv4)"',
    ].join('\n')], { env: { ...process.env, INSTALL_SH: installSh, STUB_BIN: bin }, encoding: 'utf8' })
    expect(derived.status).toBe(0)
    expect(derived.stdout).toContain('IP=100.101.102.103')
    expect(derived.stdout).toContain('OVERRIDE=100.90.10.20')
  })

  it('adds the trusted hosts and the forwarder once; a re-run is a no-op', () => {
    const { home, unitPath } = unitHome(GENERATED_UNIT)
    const bin = stubDirectory()
    const env = { DSH_TAILNET_IP: '100.101.102.103', SYSTEMCTL_LOG: join(home, 'systemctl.log') }
    const first = runExpose(home, bin, env)
    expect(first.status).toBe(0)
    const afterFirst = readFileSync(unitPath, 'utf8')
    expect(afterFirst).toContain('--trusted-host 100.101.102.103:3080')
    expect(afterFirst).toContain('--trusted-host testhost:3080')
    // Operator flags and the CLI's own trusted host survive byte-for-byte.
    expect(afterFirst).toContain('--no-open')
    expect(afterFirst).toContain('--trusted-host 127.0.0.1:3080')
    expect(afterFirst.match(/--trusted-host 100\.101\.102\.103:3080/g)).toHaveLength(1)
    expect(afterFirst.match(/--trusted-host testhost:3080/g)).toHaveLength(1)
    const forwarder = join(home, '.config', 'systemd', 'user', 'dsh-tailnet.service')
    const forwarderText = readFileSync(forwarder, 'utf8')
    expect(forwarderText).toContain('ExecStart=')
    expect(forwarderText).toContain('TCP-LISTEN:3080,bind=100.101.102.103,fork,reuseaddr TCP:127.0.0.1:3080')
    expect(forwarderText).toContain('Requires=dsh-web.service')
    expect(forwarderText).toContain('WantedBy=default.target')
    expect(first.output).toContain('added trusted hosts to dsh-web.service')
    expect(first.output).toContain('installed (dsh-tailnet.service)')
    expect(first.output).toContain('tailnet: 100.101.102.103:3080 -> 127.0.0.1:3080')
    const systemctl = readFileSync(env.SYSTEMCTL_LOG, 'utf8')
    expect(systemctl).toContain('--user enable dsh-tailnet.service')
    expect(systemctl).toContain('--user restart dsh-tailnet.service')

    const second = runExpose(home, bin, env)
    expect(second.status).toBe(0)
    const afterSecond = readFileSync(unitPath, 'utf8')
    expect(afterSecond).toBe(afterFirst)
    expect(afterSecond.match(/--trusted-host/g)).toHaveLength(3)
    expect(second.output).toContain('already trusts')
    expect(second.output).toContain('already current (dsh-tailnet.service)')
    expect(readFileSync(forwarder, 'utf8')).toBe(forwarderText)
    expect(forwarderText.match(/TCP-LISTEN:3080/g)).toHaveLength(1)
  })

  it('reports an operator-managed unit with the exact flags instead of rewriting it', () => {
    const custom = [
      '[Unit]',
      'Description=Hand-managed web',
      '',
      '[Service]',
      'ExecStart=/opt/custom/node web --host 127.0.0.1 --port 3080',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n')
    const { home, unitPath } = unitHome(custom)
    const bin = stubDirectory()
    const result = runExpose(home, bin, { DSH_TAILNET_IP: '100.101.102.103', SYSTEMCTL_LOG: join(home, 'systemctl.log') })
    expect(result.status).toBe(0)
    expect(result.output).toContain('operator-managed')
    expect(result.output).toContain('--trusted-host 100.101.102.103:3080 --trusted-host testhost:3080')
    expect(result.output).toContain('manual flags needed')
    expect(readFileSync(unitPath, 'utf8')).toBe(custom)
    // The forwarder still installs: it requires the unit by name.
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'dsh-tailnet.service'))).toBe(true)
  })

  it('reports an operator-managed unit that already carries the trusted hosts', () => {
    const custom = [
      '[Unit]',
      'Description=Hand-managed web',
      '',
      '[Service]',
      'ExecStart=/opt/custom/node web --host 127.0.0.1 --port 3080 --trusted-host 100.101.102.103:3080 --trusted-host testhost:3080',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n')
    const { home, unitPath } = unitHome(custom)
    const bin = stubDirectory()
    const result = runExpose(home, bin, { DSH_TAILNET_IP: '100.101.102.103', SYSTEMCTL_LOG: join(home, 'systemctl.log') })
    expect(result.status).toBe(0)
    expect(result.output).toContain('already configured')
    expect(result.output).not.toContain('manual flags needed')
    expect(readFileSync(unitPath, 'utf8')).toBe(custom)
  })

  it('skips the forwarder with the package hint when socat is unavailable', () => {
    const { home, unitPath } = unitHome(GENERATED_UNIT)
    const bin = join(root, `tailnet-nosocat-${String(counter++)}`)
    mkdirSync(bin, { recursive: true })
    // A PATH with no socat: link only the utilities this path dispatches to.
    for (const tool of ['bash', 'date', 'grep', 'sed', 'awk', 'head', 'cmp', 'mv', 'rm', 'cat', 'dirname', 'mkdir', 'hostname', 'uname']) {
      const found = (spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout ?? '').trim()
      if (found !== '' && found.startsWith('/')) symlinkSync(found, join(bin, tool))
    }
    writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const bashPath = join(bin, 'bash')
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'VERBOSE=1',
      'OS=linux',
      'SERVICE_UNIT=dsh-web.service',
      'LOG_FILE=/dev/null',
      'DSH_TAILNET_IP=100.101.102.103',
      'ensure_tailnet_exposure 2>&1',
    ].join('\n')
    const result = spawnSync(bashPath, ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, HOME: home, PATH: bin },
      encoding: 'utf8',
    })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    expect(result.status).toBe(0)
    expect(output).toContain('socat is not installed')
    expect(output).toContain('sudo apt install socat')
    expect(output).toContain('skipped (socat not installed)')
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'dsh-tailnet.service'))).toBe(false)
    // The trusted-host patch still ran before the forwarder was skipped.
    expect(readFileSync(unitPath, 'utf8')).toContain('--trusted-host 100.101.102.103:3080')
  })

  it('does nothing with --no-tailnet / DSH_NO_TAILNET=1', () => {
    const { home, unitPath } = unitHome(GENERATED_UNIT)
    const bin = stubDirectory()
    const before = readFileSync(unitPath, 'utf8')
    const result = runExpose(home, bin, { DSH_TAILNET_IP: '100.101.102.103', DSH_NO_TAILNET: '1', SYSTEMCTL_LOG: join(home, 'systemctl.log') })
    expect(result.status).toBe(0)
    expect(result.output).toContain('skipped (DSH_NO_TAILNET=1 or --no-tailnet)')
    expect(readFileSync(unitPath, 'utf8')).toBe(before)
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'dsh-tailnet.service'))).toBe(false)
  })

  it('accepts --no-tailnet and reports the planned exposure in --dry-run', () => {
    const home = join(root, `tailnet-dry-${String(counter++)}`)
    mkdirSync(home, { recursive: true })
    const disabled = spawnSync('bash', [installSh, '--dry-run', '--no-tailnet'], {
      env: { ...process.env, HOME: home, DSH_TAILNET_IP: '100.101.102.103' },
      encoding: 'utf8',
    })
    expect(disabled.status).toBe(0)
    expect(disabled.stdout).toContain('tailnet:   disabled (--no-tailnet / DSH_NO_TAILNET=1)')
    const planned = spawnSync('bash', [installSh, '--dry-run'], {
      env: { ...process.env, HOME: home, DSH_TAILNET_IP: '100.101.102.103' },
      encoding: 'utf8',
    })
    expect(planned.status).toBe(0)
    expect(planned.stdout).toContain('would expose 100.101.102.103:3080 -> 127.0.0.1:3080')
  })

  it('wires macOS peer exposure through tailscale serve and the launchd plist', () => {
    const home = join(root, `tailnet-mac-${String(counter++)}`)
    const agents = join(home, 'Library', 'LaunchAgents')
    mkdirSync(agents, { recursive: true })
    const plistPath = join(agents, 'com.enpoi.dsh-web.plist')
    writeFileSync(plistPath, GENERATED_PLIST)
    const bin = join(root, `tailnet-mac-bin-${String(counter++)}`)
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'hostname'), "#!/bin/sh\nprintf 'testmac\\n'\n", { mode: 0o755 })
    const tailscaleLog = join(home, 'tailscale.log')
    writeFileSync(join(bin, 'tailscale'), [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$TAILSCALE_LOG"',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 })
    const launchctlLog = join(home, 'launchctl.log')
    writeFileSync(join(bin, 'launchctl'), [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$LAUNCHCTL_LOG"',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 })
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'VERBOSE=1',
      'OS=darwin',
      'SERVICE_UNIT=com.enpoi.dsh-web',
      'LOG_FILE=/dev/null',
      'PATH="$STUB_BIN:$PATH"',
      'ensure_tailnet_exposure 2>&1',
    ].join('\n')
    const env = {
      ...process.env,
      INSTALL_SH: installSh,
      HOME: home,
      STUB_BIN: bin,
      DSH_TAILNET_IP: '100.90.10.20',
      TAILSCALE_LOG: tailscaleLog,
      LAUNCHCTL_LOG: launchctlLog,
    }
    const first = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' })
    const firstOutput = `${first.stdout ?? ''}${first.stderr ?? ''}`
    expect(first.status).toBe(0)
    expect(readFileSync(tailscaleLog, 'utf8')).toContain('serve --bg --tcp=3080 tcp://127.0.0.1:3080')
    expect(firstOutput).toContain('tailscale serve')
    expect(firstOutput).toContain('added trusted hosts to com.enpoi.dsh-web')
    const patched = readFileSync(plistPath, 'utf8')
    expect(patched.match(/<string>--trusted-host<\/string>/g)).toHaveLength(2)
    expect(patched.match(/<string>100\.90\.10\.20:3080<\/string>/g)).toHaveLength(1)
    expect(patched.match(/<string>testmac:3080<\/string>/g)).toHaveLength(1)
    // The generated ProgramArguments survive, and the agent is reloaded.
    expect(patched).toContain('<string>--no-open</string>')
    expect(readFileSync(launchctlLog, 'utf8')).toContain('bootstrap')

    const second = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' })
    expect(second.status).toBe(0)
    const afterSecond = readFileSync(plistPath, 'utf8')
    expect(afterSecond).toBe(patched)
    expect(afterSecond.match(/<string>--trusted-host<\/string>/g)).toHaveLength(2)
    expect(`${second.stdout ?? ''}${second.stderr ?? ''}`).toContain('already trusts')
  })

  it('leaves a foreign launchd plist untouched and names the flags', () => {
    const home = join(root, `tailnet-mac-custom-${String(counter++)}`)
    const agents = join(home, 'Library', 'LaunchAgents')
    mkdirSync(agents, { recursive: true })
    const custom = GENERATED_PLIST.replace('  <!-- Generated by dsh service install -->\n', '')
    const plistPath = join(agents, 'com.enpoi.dsh-web.plist')
    writeFileSync(plistPath, custom)
    const bin = join(root, `tailnet-mac-custom-bin-${String(counter++)}`)
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'hostname'), "#!/bin/sh\nprintf 'testmac\\n'\n", { mode: 0o755 })
    writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'VERBOSE=1',
      'OS=darwin',
      'SERVICE_UNIT=com.enpoi.dsh-web',
      'LOG_FILE=/dev/null',
      'PATH="$STUB_BIN:$PATH"',
      'ensure_tailnet_exposure 2>&1',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, HOME: home, STUB_BIN: bin, DSH_TAILNET_IP: '100.90.10.20' },
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('operator-managed')
    expect(readFileSync(plistPath, 'utf8')).toBe(custom)
  })

  it('adds nothing when the host has no tailnet interface', () => {
    const { home, unitPath } = unitHome(GENERATED_UNIT)
    const bin = stubDirectory()
    writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(bin, 'ip'), [
      '#!/bin/sh',
      "printf '1: lo    inet 127.0.0.1/8 scope host lo\\n2: eth0    inet 192.168.1.7/24 scope global eth0\\n3: docker0    inet 172.17.0.1/16 scope global docker0\\n'",
      '',
    ].join('\n'), { mode: 0o755 })
    writeFileSync(join(bin, 'ifconfig'), [
      '#!/bin/sh',
      "printf 'eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\\n        inet 192.168.1.7  netmask 255.255.255.0  broadcast 192.168.1.255\\n'",
      '',
    ].join('\n'), { mode: 0o755 })
    const before = readFileSync(unitPath, 'utf8')
    const result = runExpose(home, bin, { SYSTEMCTL_LOG: join(home, 'systemctl.log') })
    expect(result.status).toBe(0)
    expect(result.output).toContain('no 100.64.0.0/10 interface')
    expect(readFileSync(unitPath, 'utf8')).toBe(before)
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'dsh-tailnet.service'))).toBe(false)
  })

  it('is wired into install and both update paths and parses under bash -n', () => {
    const install = readFileSync(installSh, 'utf8')
    expect(install.match(/\n\s*ensure_tailnet_exposure$/gm)).toHaveLength(3)
    expect(install).toMatch(/ensure_service\n  ensure_tailnet_exposure\n  write_state/)
    expect(install).toMatch(/ensure_service\n    ensure_tailnet_exposure\n    step "switch/)
    expect(install).toMatch(/ensure_service\n  ensure_tailnet_exposure\n  run_backfill/)
    const syntax = spawnSync('bash', ['-n', installSh], { encoding: 'utf8' })
    expect(syntax.status).toBe(0)
  })
})

describe('tailnet forwarder uninstall', () => {
  function runUninstallForwarder(home: string, bin: string): { status: number; output: string } {
    const script = [
      'export DSH_INSTALL_LIB_ONLY=1',
      '. "$INSTALL_SH" 2>/dev/null',
      'VERBOSE=1',
      'OS=linux',
      'LOG_FILE=/dev/null',
      'PATH="$STUB_BIN:$PATH"',
      'uninstall_tailnet_forwarder 2>&1',
    ].join('\n')
    const result = spawnSync('bash', ['-c', script], {
      env: { ...process.env, INSTALL_SH: installSh, HOME: home, STUB_BIN: bin, SYSTEMCTL_LOG: join(home, 'systemctl.log') },
      encoding: 'utf8',
    })
    return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  it('removes an installer-generated forwarder and leaves an operator-managed one', () => {
    const home = join(root, `tailnet-uninstall-${String(counter++)}`)
    const bin = join(root, `tailnet-uninstall-bin-${String(counter++)}`)
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'systemctl'), [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 })
    const dir = join(home, '.config', 'systemd', 'user')
    mkdirSync(dir, { recursive: true })
    const generated = join(dir, 'dsh-tailnet.service')
    writeFileSync(generated, '# Generated by dsh installer (tailnet peer exposure); re-run install/update to refresh.\n[Unit]\nDescription=forwarder\n')
    const removed = runUninstallForwarder(home, bin)
    expect(removed.status).toBe(0)
    expect(existsSync(generated)).toBe(false)
    const systemctl = readFileSync(join(home, 'systemctl.log'), 'utf8')
    expect(systemctl).toContain('--user stop dsh-tailnet.service')
    expect(systemctl).toContain('--user disable dsh-tailnet.service')

    const foreign = join(dir, 'dsh-tailnet.service')
    writeFileSync(foreign, '[Unit]\nDescription=hand-written\n')
    const kept = runUninstallForwarder(home, bin)
    expect(kept.status).toBe(0)
    expect(existsSync(foreign)).toBe(true)
  })
})
