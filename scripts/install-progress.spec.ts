import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Behavior guard for the update progress and no-hang work in
 * `scripts/install.sh`: the portable `file_size`, the non-TTY heartbeat
 * `run_logged` grows for long silent steps, the watched-download progress
 * line, the --quiet/--json suppression of that progress, the non-interactive
 * git/ssh exports, the timed profile fetch, and the update-lock release and
 * self-heal semantics an interrupted update depends on.
 *
 * The functions are exercised by sourcing install.sh as a library
 * (DSH_INSTALL_LIB_ONLY=1), which defines every helper without running a mode.
 */

const installSh = join(dirname(fileURLToPath(import.meta.url)), 'install.sh')

let root: string
let counter = 0

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-install-progress-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  counter += 1
  const dir = join(root, `case-${counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

interface BashResult {
  status: number
  stdout: string
  stderr: string
}

function runBash(script: string, env: Record<string, string> = {}): BashResult {
  const file = join(root, `script-${(counter += 1)}.sh`)
  writeFileSync(file, script)
  const result = spawnSync('bash', [file], {
    env: { ...process.env, INSTALL_SH: installSh, ...env },
    encoding: 'utf8',
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Library preamble: source install.sh, point PREFIX/LOG_FILE at the scratch. */
function libPreamble(dir: string): string {
  return [
    'export DSH_INSTALL_LIB_ONLY=1',
    '. "$INSTALL_SH" >/dev/null 2>&1',
    `PREFIX="${dir}/prefix"`,
    'mkdir -p "$PREFIX"',
    `LOG_FILE="${dir}/install.log"`,
  ].join('\n')
}

describe('file_size', () => {
  it('reports exact bytes and fails on a missing path', () => {
    const dir = scratch()
    const file = join(dir, 'asset.download')
    writeFileSync(file, Buffer.alloc(4096 + 17, 0x41))
    const result = runBash(
      [
        libPreamble(dir),
        `printf 'size=%s\\n' "$(file_size "${file}")"`,
        `file_size "${dir}/missing" 2>/dev/null; printf 'missing_rc=%s\\n' "$?"`,
      ].join('\n'),
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('size=4113')
    expect(result.stdout).toContain('missing_rc=1')
  })
})

describe('run_logged heartbeat', () => {
  it('prints a still-working line on a non-TTY and keeps the final check line', () => {
    const dir = scratch()
    const result = runBash(
      [libPreamble(dir), 'DSH_HEARTBEAT_INTERVAL=1', 'run_logged "heartbeat probe" 30 "$PREFIX" sleep 2'].join('\n'),
    )
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('still working: heartbeat probe')
    expect(result.stderr).toContain('✓ heartbeat probe')
  })

  it('reports watched-download bytes, expected total, and percentage', () => {
    const dir = scratch()
    const result = runBash(
      [
        libPreamble(dir),
        'DSH_PROGRESS_INTERVAL=1',
        `watch="${dir}/asset.download"`,
        // Fill to 1 MiB after the loop has started, then outlive one more
        // tick so a progress line observes the bytes.
        '( sleep 1; head -c 1048576 /dev/zero > "$watch" ) &',
        'writer=$!',
        'DSH_RUN_LOG_PROGRESS_FILE="$watch" DSH_RUN_LOG_PROGRESS_TOTAL=2097152 run_logged "download probe" 30 "$PREFIX" sleep 3',
        'wait "$writer" 2>/dev/null || true',
      ].join('\n'),
    )
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('download probe: 1 MB of 2 MB (50%)')
  })

  it('suppresses progress under QUIET and JSON_OUT', () => {
    const dir = scratch()
    const quiet = runBash(
      [libPreamble(dir), 'QUIET=1', 'DSH_HEARTBEAT_INTERVAL=1', 'run_logged "quiet probe" 30 "$PREFIX" sleep 2'].join('\n'),
    )
    expect(quiet.status).toBe(0)
    expect(quiet.stderr).not.toContain('still working')
    expect(quiet.stderr).not.toContain('quiet probe')

    const json = runBash(
      [libPreamble(dir), 'JSON_OUT=1', 'DSH_HEARTBEAT_INTERVAL=1', 'run_logged "json probe" 30 "$PREFIX" sleep 2'].join('\n'),
    )
    expect(json.status).toBe(0)
    expect(json.stderr).not.toContain('still working')
  })
})

describe('non-interactive git', () => {
  it('exports prompt-proof git settings for every child git/ssh', () => {
    const dir = scratch()
    const result = runBash(
      [
        'unset GIT_TERMINAL_PROMPT GIT_ASKPASS GIT_SSH_COMMAND 2>/dev/null || true',
        libPreamble(dir),
        'printf \'term=%s askpass=%s ssh=%s\\n\' "${GIT_TERMINAL_PROMPT:-}" "${GIT_ASKPASS:-}" "${GIT_SSH_COMMAND:-}"',
      ].join('\n'),
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('term=0 askpass=/bin/true ssh=ssh -oBatchMode=yes')
  })
})

describe('profile fetch', () => {
  it('downloads a tarball source through the timed, logged fetch', () => {
    const dir = scratch()
    const result = runBash(
      [
        libPreamble(dir),
        `mkdir -p "${dir}/rootz/profile"`,
        `printf '{"name":"fixture"}\\n' > "${dir}/rootz/profile/package.json"`,
        `tar -czf "${dir}/profile.tar.gz" -C "${dir}/rootz" profile`,
        `mkdir -p "${dir}/stage"`,
        `stage_profile_source "file://${dir}/profile.tar.gz" tarball "${dir}/stage"`,
        'rc=$?',
        `printf 'rc=%s manifest=%s\\n' "$rc" "$([ -f "${dir}/stage/package.json" ] && echo yes || echo no)"`,
      ].join('\n'),
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('rc=0 manifest=yes')
    expect(result.stderr).toContain('Downloading profile source')
  })
})

describe('copy_profile_tree', () => {
  it('still seeds every non-excluded file in seed mode', () => {
    const dir = scratch()
    const result = runBash(
      [
        libPreamble(dir),
        `mkdir -p "${dir}/src/pkg" "${dir}/src/node_modules/dep" "${dir}/src/.git"`,
        `printf 'a' > "${dir}/src/pkg/app.js"`,
        `printf 'b' > "${dir}/src/root.txt"`,
        `printf 'c' > "${dir}/src/node_modules/dep/index.js"`,
        `printf 'd' > "${dir}/src/.git/HEAD"`,
        `copy_profile_tree "${dir}/src" "${dir}/dst" seed; rc=$?`,
        `printf 'rc=%s app=%s root=%s node_modules=%s git=%s\\n' "$rc" "$([ -f "${dir}/dst/pkg/app.js" ] && echo yes || echo no)" "$([ -f "${dir}/dst/root.txt" ] && echo yes || echo no)" "$([ -e "${dir}/dst/node_modules" ] && echo yes || echo no)" "$([ -e "${dir}/dst/.git" ] && echo yes || echo no)"`,
      ].join('\n'),
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('rc=0 app=yes root=yes node_modules=no git=no')
  })
})

describe('update lock', () => {
  /** Minimal PATH without flock so the mkdir fallback is exercised. */
  function fakeBin(): string {
    const binDir = join(root, `fakebin-${counter}`)
    mkdirSync(binDir, { recursive: true })
    for (const tool of ['dirname', 'basename', 'date', 'mkdir', 'cat', 'rm', 'head', 'sleep']) {
      const resolved = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      symlinkSync(resolved, join(binDir, tool))
    }
    return binDir
  }

  function fallbackPreamble(dir: string, binDir: string): string {
    return [`export PATH="${binDir}"`, libPreamble(dir)].join('\n')
  }

  it('reclaims a lock left by a dead PID and releases it on normal exit', () => {
    const dir = scratch()
    const binDir = fakeBin()
    const result = runBash(
      [
        fallbackPreamble(dir, binDir),
        'mkdir -p "$PREFIX/harness/.update.lock.d"',
        'echo 4194303 > "$PREFIX/harness/.update.lock.d/pid"',
        'acquire_update_lock',
        'printf "acquired rc=%s pid=%s self=%s\\n" "$?" "$(cat "$PREFIX/harness/.update.lock.d/pid")" "$$"',
      ].join('\n'),
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/acquired rc=0 pid=(\d+) self=\1/)
    expect(existsSync(join(dir, 'prefix', 'harness', '.update.lock.d'))).toBe(false)
  })

  it('releases the lock when SIGTERM/SIGINT interrupt the update', () => {
    for (const [signal, code] of [['TERM', 143], ['INT', 130]] as const) {
      const dir = scratch()
      const binDir = fakeBin()
      const result = runBash(
        [fallbackPreamble(dir, binDir), 'acquire_update_lock', `kill -${signal} $$`].join('\n'),
      )
      expect(result.status).toBe(code)
      expect(existsSync(join(dir, 'prefix', 'harness', '.update.lock.d'))).toBe(false)
    }
  })

  it('refuses to run beside a live holder', () => {
    const dir = scratch()
    const binDir = fakeBin()
    const result = runBash(
      [
        fallbackPreamble(dir, binDir),
        'sleep 30 & holder=$!',
        'trap \'kill "$holder" 2>/dev/null || true\' EXIT',
        'mkdir -p "$PREFIX/harness/.update.lock.d"',
        'echo "$holder" > "$PREFIX/harness/.update.lock.d/pid"',
        'acquire_update_lock',
        'printf "SHOULD NOT REACH\\n"',
      ].join('\n'),
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('another update is already running')
    expect(result.stdout).not.toContain('SHOULD NOT REACH')
  })
})
