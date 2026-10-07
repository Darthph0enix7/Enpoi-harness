/**
 * `dsh web` pre-boot attach (fork): argument parsing, the endpoint decision
 * matrix, and the attach/occupied/serve outcomes against an injected state
 * file, liveness check, and probe.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hasFlag, optionValue, resolveAttachEndpoint, runAttach } from '../src/attach.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A temp dir for one state file. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-attach-'))
  dirs.push(dir)
  return dir
}

/** Capture one sink as a string. */
function sink(): { write: (chunk: string) => boolean; text: () => string } {
  let text = ''
  return { write: (chunk: string) => { text += chunk; return true }, text: () => text }
}

/** The production-shaped attach record. */
function stateFile(url: string, port = 3080, pid = 4242, host = '127.0.0.1'): string {
  const path = join(tempDir(), 'web-url.json')
  writeFileSync(path, `${JSON.stringify({ url, host, port, pid, startedAt: new Date(0).toISOString() })}\n`)
  return path
}

describe('attach argument parsing', () => {
  it('reads both --flag value and --flag=value forms', () => {
    expect(optionValue(['--port', '8080'], '--port')).toBe('8080')
    expect(optionValue(['--port=8080'], '--port')).toBe('8080')
    expect(optionValue(['--port', '--no-open'], '--port')).toBeUndefined()
    expect(optionValue([], '--port')).toBeUndefined()
  })

  it('detects boolean flags verbatim', () => {
    expect(hasFlag(['--no-open'], '--no-open')).toBe(true)
    expect(hasFlag([], '--foreground')).toBe(false)
  })

  it('refuses attach for forced serve, help, and the OS-assigned port', () => {
    expect(resolveAttachEndpoint(['--foreground'])).toBe('serve')
    expect(resolveAttachEndpoint(['-h'])).toBe('serve')
    expect(resolveAttachEndpoint(['--help'])).toBe('serve')
    expect(resolveAttachEndpoint(['--port', '0'])).toBe('serve')
    expect(resolveAttachEndpoint(['--port=0'])).toBe('serve')
    expect(resolveAttachEndpoint(['--port', 'abc'])).toBe('serve')
  })

  it('refuses attach for an option left without its value', () => {
    expect(resolveAttachEndpoint(['--port'])).toBe('serve')
    expect(resolveAttachEndpoint(['--port', '--no-open'])).toBe('serve')
    expect(resolveAttachEndpoint(['--host'])).toBe('serve')
  })

  it('resolves the default and explicit endpoints', () => {
    expect(resolveAttachEndpoint([])).toEqual({ host: '127.0.0.1', port: 3080 })
    expect(resolveAttachEndpoint(['--port', '8080'])).toEqual({ host: '127.0.0.1', port: 8080 })
    expect(resolveAttachEndpoint(['--host', 'localhost'])).toEqual({ host: 'localhost', port: 3080 })
  })
})

describe('runAttach outcomes', () => {
  it('serves unchanged without an interactive terminal', async () => {
    const outcome = await runAttach([], { tty: false, statePath: stateFile('http://127.0.0.1:3080/?token=x') })
    expect(outcome).toBe('serve')
  })

  it('serves when no instance answers', async () => {
    const err = sink()
    const outcome = await runAttach([], {
      tty: true,
      statePath: join(tempDir(), 'absent.json'),
      probe: async () => false,
      managedService: () => ({ kind: 'none' }),
      stderr: err,
    })
    expect(outcome).toBe('serve')
    expect(err.text()).toContain('this server is unsupervised')
  })

  it('attaches on a live recorded instance, printing the URL and opening the browser', async () => {
    const out = sink()
    let opened = ''
    const probed: Array<[string, number]> = []
    const outcome = await runAttach([], {
      tty: true,
      statePath: stateFile('http://127.0.0.1:3080/?token=abc'),
      pidAlive: () => true,
      probe: async (host, port) => { probed.push([host, port]); return true },
      openBrowser: (url) => { opened = url },
      stdout: out,
    })
    expect(outcome).toBe('attached')
    expect(out.text()).toContain('dsh web: http://127.0.0.1:3080/?token=abc')
    expect(out.text()).toContain('opening the default browser')
    expect(opened).toBe('http://127.0.0.1:3080/?token=abc')
    expect(probed).toEqual([['127.0.0.1', 3080]])
  })

  it('honors --no-open and suppresses the handoff over SSH', async () => {
    let opened = ''
    const noOpen = await runAttach(['--no-open'], {
      tty: true,
      statePath: stateFile('http://127.0.0.1:3080/?token=abc'),
      pidAlive: () => true,
      probe: async () => true,
      openBrowser: (url) => { opened = url },
      stdout: sink(),
    })
    expect(noOpen).toBe('attached')
    expect(opened).toBe('')
    const viaSsh = await runAttach([], {
      tty: true,
      env: { SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' },
      statePath: stateFile('http://127.0.0.1:3080/?token=abc'),
      pidAlive: () => true,
      probe: async () => true,
      openBrowser: (url) => { opened = url },
      stdout: sink(),
    })
    expect(viaSsh).toBe('attached')
    expect(opened).toBe('')
  })

  it('reports occupied when the endpoint answers without a valid record', async () => {
    const err = sink()
    const outcome = await runAttach([], {
      tty: true,
      statePath: join(tempDir(), 'absent.json'),
      probe: async () => true,
      stderr: err,
    })
    expect(outcome).toBe('occupied')
    expect(err.text()).toContain('already answers but has no attach state')
  })

  it('ignores a dead recorded process', async () => {
    const err = sink()
    const outcome = await runAttach([], {
      tty: true,
      statePath: stateFile('http://127.0.0.1:3080/?token=abc'),
      pidAlive: () => false,
      probe: async (host, port) => host === '127.0.0.1' && port === 3080,
      stderr: err,
    })
    expect(outcome).toBe('occupied')
  })

  it('never attaches a different explicit port to the default instance state', async () => {
    const probed: Array<[string, number]> = []
    const outcome = await runAttach(['--port', '9999'], {
      tty: true,
      statePath: stateFile('http://127.0.0.1:3080/?token=abc'),
      pidAlive: () => true,
      probe: async (host, port) => { probed.push([host, port]); return false },
      stdout: sink(),
      stderr: sink(),
    })
    expect(outcome).toBe('serve')
    expect(probed).toEqual([['127.0.0.1', 9999]])
  })

  it('treats a malformed record as absent', async () => {
    const dir = tempDir()
    const path = join(dir, 'web-url.json')
    writeFileSync(path, 'not json')
    const outcome = await runAttach([], {
      tty: true,
      statePath: path,
      probe: async () => false,
      managedService: () => ({ kind: 'none' }),
      stderr: sink(),
    })
    expect(outcome).toBe('serve')
  })

  it('matches a loopback alias between invocation and record', async () => {
    const outcome = await runAttach(['--host', 'localhost'], {
      tty: true,
      statePath: stateFile('http://127.0.0.1:3080/?token=abc', 3080, 4242, '127.0.0.1'),
      pidAlive: () => true,
      probe: async () => true,
      stdout: sink(),
      openBrowser: () => {},
    })
    expect(outcome).toBe('attached')
  })
})

describe('managed service delegation', () => {
  it('starts a stopped managed service and attaches to it', async () => {
    const out = sink()
    const err = sink()
    const path = join(tempDir(), 'web-url.json')
    let started = 0
    let live = false
    const outcome = await runAttach(['--no-open'], {
      tty: true,
      statePath: path,
      managedService: () => ({ kind: 'stopped', unit: 'dsh-web.service' }),
      startService: () => {
        started += 1
        live = true
        writeFileSync(path, JSON.stringify({ url: 'http://127.0.0.1:3080/?token=svc', host: '127.0.0.1', port: 3080, pid: 99 }))
        return 0
      },
      pidAlive: () => true,
      probe: async () => live,
      stdout: out,
      stderr: err,
    })
    expect(outcome).toBe('attached')
    expect(started).toBe(1)
    expect(out.text()).toContain('started the background service; attaching')
    expect(out.text()).toContain('dsh web: http://127.0.0.1:3080/?token=svc')
    expect(err.text()).toBe('')
  })

  it('names the start remedy and serves when the managed service fails to start', async () => {
    const err = sink()
    const outcome = await runAttach([], {
      tty: true,
      statePath: join(tempDir(), 'absent.json'),
      managedService: () => ({ kind: 'stopped', unit: 'dsh-web.service' }),
      startService: () => 1,
      probe: async () => false,
      stderr: err,
    })
    expect(outcome).toBe('serve')
    expect(err.text()).toContain('could not start the background service')
    expect(err.text()).toContain('`dsh service start`')
    expect(err.text()).toContain('this server is unsupervised')
  })

  it('names the install remedy and serves when the managed unit is missing', async () => {
    const err = sink()
    const outcome = await runAttach([], {
      tty: true,
      statePath: join(tempDir(), 'absent.json'),
      managedService: () => ({ kind: 'missing', unit: 'dsh-web.service' }),
      probe: async () => false,
      stderr: err,
    })
    expect(outcome).toBe('serve')
    expect(err.text()).toContain('`dsh service install`')
    expect(err.text()).toContain('this server is unsupervised')
  })

  it('serves a dev checkout with the unsupervised warning when no managed install exists', async () => {
    const err = sink()
    const outcome = await runAttach([], {
      tty: true,
      statePath: join(tempDir(), 'absent.json'),
      managedService: () => ({ kind: 'none' }),
      probe: async () => false,
      stderr: err,
    })
    expect(outcome).toBe('serve')
    expect(err.text()).toContain('this server is unsupervised')
  })

  it('waits out an active managed service and attaches to it', async () => {
    const out = sink()
    let probes = 0
    const outcome = await runAttach(['--no-open'], {
      tty: true,
      statePath: stateFile('http://127.0.0.1:3080/?token=svc'),
      managedService: () => ({ kind: 'active', unit: 'dsh-web.service' }),
      pidAlive: () => true,
      probe: async () => { probes += 1; return probes > 2 },
      stdout: out,
      stderr: sink(),
    })
    expect(outcome).toBe('attached')
    expect(out.text()).toContain('waiting for the background service; attaching')
    expect(out.text()).toContain('http://127.0.0.1:3080/?token=svc')
  })

  it('never boots a second server when a delegated managed service stays silent', async () => {
    const err = sink()
    const stopped = await runAttach([], {
      tty: true,
      statePath: join(tempDir(), 'absent.json'),
      managedService: () => ({ kind: 'stopped', unit: 'u' }),
      startService: () => 0,
      probe: async () => false,
      managedReadyTimeoutMs: 0,
      stdout: sink(),
      stderr: err,
    })
    expect(stopped).toBe('occupied')
    expect(err.text()).toContain('did not answer in time')
    const active = await runAttach([], {
      tty: true,
      statePath: join(tempDir(), 'absent.json'),
      managedService: () => ({ kind: 'active', unit: 'u' }),
      probe: async () => false,
      managedReadyTimeoutMs: 0,
      stdout: sink(),
      stderr: err,
    })
    expect(active).toBe('occupied')
    expect(err.text()).toContain('active but did not answer')
  })

  it('fails soft when the managed service state cannot be determined', async () => {
    const err = sink()
    const outcome = await runAttach([], {
      tty: true,
      statePath: join(tempDir(), 'absent.json'),
      managedService: () => ({ kind: 'unknown' }),
      probe: async () => false,
      stderr: err,
    })
    expect(outcome).toBe('serve')
    expect(err.text()).toContain('could not determine the background service state')
    expect(err.text()).toContain('this server is unsupervised')
  })

  it('does not inspect the managed service for --foreground or a non-managed endpoint', async () => {
    let inspected = 0
    const managedService = (): { kind: 'stopped'; unit: string } => {
      inspected += 1
      return { kind: 'stopped', unit: 'u' }
    }
    expect(await runAttach(['--foreground'], { tty: true, managedService })).toBe('serve')
    expect(await runAttach(['--port', '9999'], {
      tty: true,
      statePath: join(tempDir(), 'absent.json'),
      probe: async () => false,
      managedService,
      stderr: sink(),
    })).toBe('serve')
    expect(inspected).toBe(0)
  })
})
