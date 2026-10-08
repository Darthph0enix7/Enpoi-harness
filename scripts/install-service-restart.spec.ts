/**
 * Installer service-restart and fleet-pairings guards from `scripts/install.sh`.
 *
 * restart_service: on macOS a `launchctl kickstart` against a unit file that
 * exists but was never loaded fails with `Could not find service ... in
 * domain`; the restart path must bootstrap it (reusing the repair path's
 * probe), stay quiet-but-informative when the machine has no GUI domain, and
 * keep the plain failure warning when the plist is missing or bootstrap
 * genuinely fails.
 *
 * generate_peer_pairings: runs the profile's generator fail-soft — a missing
 * generator, missing Node, or a non-zero generator never fails the caller —
 * and pairings.yaml is part of the update-time user-file backup.
 *
 * The helpers are exercised by sourcing install.sh as a library
 * (DSH_INSTALL_LIB_ONLY=1), with a fake `launchctl` on PATH and a scratch HOME.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const installSh = join(dirname(fileURLToPath(import.meta.url)), 'install.sh')

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-install-service-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface RunOptions {
  home: string
  path?: string
  env?: Record<string, string>
}

function runBash(call: string, options: RunOptions): { status: number; output: string } {
  const script = ['export DSH_INSTALL_LIB_ONLY=1', '. "$INSTALL_SH" 2>/dev/null', 'VERBOSE=1', call].join('\n')
  const result = spawnSync('bash', ['-c', script], {
    env: {
      ...process.env,
      INSTALL_SH: installSh,
      HOME: options.home,
      ...(options.path === undefined ? {} : { PATH: options.path }),
      ...options.env,
    },
    encoding: 'utf8',
  })
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** A fake `launchctl` that records its argv and answers by scenario env. */
function fakeLaunchctl(root: string): { binDir: string; log: string } {
  const binDir = join(root, 'bin')
  const log = join(root, 'launchctl.log')
  mkdirSync(binDir, { recursive: true })
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"
case "$1" in
  print)
    case "$2" in
      gui/*/*) exit "\${PRINT_UNIT_EXIT:-1}";;
      gui/*) exit "\${PRINT_DOMAIN_EXIT:-1}";;
    esac
    ;;
  kickstart) exit "\${KICKSTART_EXIT:-0}";;
  bootstrap) exit "\${BOOTSTRAP_EXIT:-0}";;
esac
exit 1
`
  const path = join(binDir, 'launchctl')
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return { binDir, log }
}

const UNIT = 'com.enpoi.dsh-web'

function restart(overrides: Record<string, string> = {}, withPlist = true): { status: number; output: string; log: string; home: string } {
  const root = tempRoot()
  const home = join(root, 'home')
  const { binDir, log } = fakeLaunchctl(root)
  if (withPlist) {
    const plistDir = join(home, 'Library', 'LaunchAgents')
    mkdirSync(plistDir, { recursive: true })
    writeFileSync(join(plistDir, `${UNIT}.plist`), '<plist/>')
  }
  const call = `OS=darwin; SERVICE_UNIT=${UNIT}; restart_service 2>&1`
  const result = runBash(call, {
    home,
    path: `${binDir}:${process.env.PATH ?? ''}`,
    env: { LAUNCHCTL_LOG: log, ...overrides },
  })
  return {
    ...result,
    home,
    log: existsSync(log) ? readFileSync(log, 'utf8') : '',
  }
}

describe('installer restart_service on macOS', () => {
  it('kickstarts a loaded unit', () => {
    const result = restart({ PRINT_UNIT_EXIT: '0' })
    expect(result.status).toBe(0)
    expect(result.log).toContain('kickstart -k gui/')
    expect(result.log).toContain(UNIT)
    expect(result.log).not.toContain('bootstrap')
  })

  it('bootstraps a present-but-unloaded unit instead of failing', () => {
    const result = restart({ PRINT_UNIT_EXIT: '1', PRINT_DOMAIN_EXIT: '0', BOOTSTRAP_EXIT: '0' })
    expect(result.status).toBe(0)
    expect(result.log).toContain('bootstrap gui/')
    expect(result.log).toContain(`${UNIT}.plist`)
    expect(result.output).toContain('bootstrapped')
    expect(result.output).not.toContain('service restart failed')
  })

  it('reports the deferred desktop-login load when there is no GUI domain', () => {
    const result = restart({ PRINT_UNIT_EXIT: '1', PRINT_DOMAIN_EXIT: '1', BOOTSTRAP_EXIT: '1' })
    expect(result.status).toBe(0)
    expect(result.output).toContain('no GUI login session')
    expect(result.output).toContain('next desktop login')
    expect(result.output).not.toContain('service restart failed')
  })

  it('keeps the failure warning when the unit file is missing', () => {
    const result = restart({ PRINT_UNIT_EXIT: '1', PRINT_DOMAIN_EXIT: '0' }, false)
    expect(result.status).toBe(0)
    expect(result.output).toContain('does not exist')
    expect(result.log).not.toContain('bootstrap')
  })

  it('warns when bootstrap fails with a GUI domain present', () => {
    const result = restart({ PRINT_UNIT_EXIT: '1', PRINT_DOMAIN_EXIT: '0', BOOTSTRAP_EXIT: '1' })
    expect(result.status).toBe(0)
    expect(result.output).toContain('service restart failed')
  })
})

describe('installer fleet pairings generation', () => {
  it('runs the profile generator fail-soft and backs pairings.yaml up', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const profile = join(home, 'profiles', 'web')
    const marker = join(root, 'generated')
    mkdirSync(join(profile, 'scripts'), { recursive: true })
    writeFileSync(join(profile, 'scripts', 'generate-pairings.mjs'), [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(process.env.PAIRINGS_MARKER, "ran")',
      '',
    ].join('\n'))
    writeFileSync(join(home, 'pairings.yaml'), 'version: 1\ndevice: test\npairings: []\n')
    const call = [
      `DSH_HOME=${home}`,
      'NODE="$(command -v node)"',
      'PROFILE=web',
      'SERVICE_UNIT=""',
      'generate_peer_pairings',
      'rc=$?',
      `backup=${root}/backup`,
      'mkdir -p "$backup"',
      'backup_user_files "$backup"',
      'printf "rc=%s\\n" "$rc"',
    ].join('\n')
    const result = runBash(call, { home, env: { PAIRINGS_MARKER: marker } })
    expect(result.status).toBe(0)
    expect(result.output).toContain('rc=0')
    expect(result.output).toContain('fleet generator finished')
    expect(existsSync(marker)).toBe(true)
    const backedUp = join(root, 'backup', 'root', home.replace(/^\//u, ''), 'pairings.yaml')
    expect(existsSync(backedUp)).toBe(true)
  })

  it('never fails when the generator is absent, Node is missing, or the generator exits non-zero', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const profile = join(home, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })

    const absent = runBash('DSH_HOME="$HOME"; PROFILE=web; SERVICE_UNIT=""; generate_peer_pairings; printf "rc=%s\\n" "$?"', { home })
    expect(absent.output).toContain('rc=0')
    expect(absent.output).toContain('no fleet generator')

    mkdirSync(join(profile, 'scripts'), { recursive: true })
    writeFileSync(join(profile, 'scripts', 'generate-pairings.mjs'), 'process.exit(1)\n')
    const failed = runBash('DSH_HOME="$HOME"; NODE="$(command -v node)"; PROFILE=web; SERVICE_UNIT=""; generate_peer_pairings; printf "rc=%s\\n" "$?"', { home })
    expect(failed.output).toContain('rc=0')
    expect(failed.output).toContain('generator exited non-zero')

    const noNode = runBash('DSH_HOME="$HOME"; NODE=""; PROFILE=web; SERVICE_UNIT=""; generate_peer_pairings; printf "rc=%s\\n" "$?"', { home })
    expect(noNode.output).toContain('rc=0')
    expect(noNode.output).toContain('no Node.js available')
  })
})
