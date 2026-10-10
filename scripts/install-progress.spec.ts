import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Behavior guard for the update progress and no-hang work in
 * `scripts/install.sh`: the portable `file_size`, the non-TTY heartbeat
 * `run_logged` grows for long silent steps, the watched-download progress
 * line, the --quiet/--json suppression of that progress, the width-clamped
 * TTY frames that must never wrap (a wrapped frame bloat the terminal when
 * `\r` + `\033[K` repaints only its last row), the non-interactive git/ssh
 * exports, the timed profile fetch, and the update-lock release and self-heal
 * semantics an interrupted update depends on.
 *
 * The functions are exercised by sourcing install.sh as a library
 * (DSH_INSTALL_LIB_ONLY=1), which defines every helper without running a mode.
 */

const installSh = join(dirname(fileURLToPath(import.meta.url)), 'install.sh')
const fastDownloader = join(dirname(installSh), 'download-fast.mjs')

const ENGINE_PROGRESS = '[███████░░░░░] 60% · 179.9/297.3 MB · 0.8 MB/s'
const LONG_DESC = 'Fetching prebuilt release (linux-x64, parallel)'

/** util-linux `script` gives the child a pty; macOS/BSD script has no `-c`. */
const ptyAvailable =
  process.platform !== 'win32' &&
  spawnSync('script', ['-qec', 'true', '/dev/null'], { encoding: 'utf8', timeout: 10_000 }).status === 0

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '')
}

/** Visible (ANSI-stripped) length in characters, never bytes. */
function visibleLength(line: string): number {
  return Array.from(line).length
}

/** Lines of a terminal capture, split at CR/LF and free of script(1) chrome. */
function visibleLines(raw: string): string[] {
  return stripAnsi(raw)
    .split(/[\r\n]/u)
    .filter(line => line.trim().length > 0 && !/^Script (started|done)/u.test(line))
}

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

/** A PATH directory holding only the named tools (so tput/stty stay hidden). */
function toolBin(tools: readonly string[]): string {
  counter += 1
  const binDir = join(root, `bin-${counter}`)
  mkdirSync(binDir, { recursive: true })
  for (const tool of tools) {
    const resolved = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    symlinkSync(resolved, join(binDir, tool))
  }
  return binDir
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
    return toolBin(['dirname', 'basename', 'date', 'mkdir', 'cat', 'rm', 'head', 'sleep'])
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

describe('width-safe text fitting', () => {
  it('fits by characters under a UTF-8 locale and never splits a glyph', () => {
    const dir = scratch()
    const result = runBash(
      [
        libPreamble(dir),
        'LANG=C.UTF-8; export LANG; LC_ALL=C.UTF-8; export LC_ALL',
        'bar="██████████"',
        'printf "utf8=[%s]\\n" "$(fit_text "$bar" 5)"',
        'LANG=C; export LANG; LC_ALL=C; export LC_ALL',
        'printf "c=[%s]\\n" "$(fit_text "$bar" 5)"',
      ].join('\n'),
    )
    expect(result.status).toBe(0)
    // UTF-8 locale: ${#s} counts characters, so 10 bars fit to 4 bars + ellipsis.
    expect(result.stdout).toContain('utf8=[████…]')
    // C locale: ${#s} counts bytes; the cut must still emit valid UTF-8.
    const cFitted = /c=\[(.*)\]/u.exec(result.stdout)?.[1] ?? ''
    expect(visibleLength(cFitted)).toBeLessThanOrEqual(5)
    expect(Buffer.from(cFitted, 'utf8').toString('utf8')).toBe(cFitted)
  })

  it('composes a frame within COLUMNS-1 and keeps spinner and desc', () => {
    const dir = scratch()
    const binDir = toolBin(['dirname', 'basename', 'date', 'mkdir', 'sed', 'tr'])
    const result = runBash(
      [
        `export PATH="${binDir}"`,
        libPreamble(dir),
        'COLUMNS=40; export COLUMNS',
        'LANG=C.UTF-8; export LANG; LC_ALL=C.UTF-8; export LC_ALL',
        `tty_frame "/" "${LONG_DESC}" "${ENGINE_PROGRESS}" "" "220"`,
      ].join('\n'),
    )
    expect(result.status).toBe(0)
    const frames = stripAnsi(result.stderr).split('\r').filter(frame => frame.trim().length > 0)
    expect(frames).toHaveLength(1)
    expect(visibleLength(frames[0] ?? '')).toBeLessThanOrEqual(39)
    expect(frames[0]).toContain('/')
    expect(frames[0]).toContain('Fetching')
    expect(frames[0]).toContain('…')
    expect(result.stderr).toContain('\x1b[K')
  })
})

describe.runIf(ptyAvailable)('narrow-pty progress frames', () => {
  /** Run run_logged for 2s inside a pty of the given width with a planted side channel. */
  function ptyRun(cols: number): { raw: string; result: BashResult } {
    const dir = scratch()
    const probe = join(dir, 'probe.sh')
    writeFileSync(
      probe,
      [
        'export DSH_INSTALL_LIB_ONLY=1',
        '. "$INSTALL_SH" >/dev/null 2>&1',
        `PREFIX="${dir}/prefix"`,
        'mkdir -p "$PREFIX/harness/.cache"',
        'LOG_FILE="$PREFIX/install.log"',
        `printf '%s' "${ENGINE_PROGRESS}" > "$PREFIX/harness/.cache/dsh-harness-x.tar.gz.progress"`,
        `run_logged "${LONG_DESC}" 30 "$PREFIX" sleep 2`,
      ].join('\n'),
    )
    const result = spawnSync('script', ['-qec', `stty cols ${cols}; bash ${probe}`, '/dev/null'], {
      // COLUMNS is emptied so the pty width (`stty size`) is the only source
      // when `tput` cannot answer; an inherited wide COLUMNS would mask it.
      env: { ...process.env, INSTALL_SH: installSh, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', COLUMNS: '' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    return {
      raw: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      result: { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' },
    }
  }

  it('at 60 columns stays within 59 cells and never wraps a frame', () => {
    const { raw } = ptyRun(60)
    const lines = visibleLines(raw)
    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(60)
    // Frames repaint with CR + erase, and the long desc still shows whole.
    expect(raw).toContain('\r')
    expect(raw).toContain('\x1b[K')
    expect(lines.some(line => line.includes('(linux-x64, parallel)'))).toBe(true)
  })

  it('at 40 columns keeps the spinner and a truncated desc within the width', () => {
    const { raw } = ptyRun(40)
    const lines = visibleLines(raw)
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(40)
    expect(lines.some(line => line.includes('/') && line.includes('Fetching') && line.includes('…'))).toBe(true)
  })

  it('at 80 columns degrades the engine bar to a compact segment that fits', () => {
    const { raw } = ptyRun(80)
    const lines = visibleLines(raw)
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(80)
    // [bar] was dropped and the speed field elided; MB counters remain.
    expect(lines.some(line => line.includes('60%') && line.includes('179.9/297.3 MB'))).toBe(true)
    expect(lines.some(line => line.includes('█'))).toBe(false)
  })
})

describe('engine renderer clamp', () => {
  it('keeps the standalone and inline downloader frames consistent', () => {
    const installSource = readFileSync(installSh, 'utf8')
    const standaloneSource = readFileSync(fastDownloader, 'utf8')
    const frameWrite = '\\r\\x1b[K${clampLine(msg, terminalLimit())}'
    for (const source of [installSource, standaloneSource]) {
      expect(source).toContain(frameWrite)
      expect(source).toContain('function terminalLimit()')
      expect(source).toContain('function clampLine(text, max)')
    }
    // Non-TTY behavior keeps its newline form in both copies.
    for (const source of [installSource, standaloneSource]) {
      expect(source).toContain('      console.log(msg)')
    }
  })
})
