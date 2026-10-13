/**
 * Launcher ladder and launch environment: the runtime probe order (prefix
 * runtime, nvm newest, inherited PATH, system dirs), the composed wrapper
 * exports, platform ordering, spawn fallback, and the clear failure when no
 * Node.js runtime resolves.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  commandOnPath,
  launchPlan,
  launchUpdater,
  launchWrapper,
  LaunchEnvironmentError,
  resolveLaunchEnvironment,
  resolveRuntime,
  RUN_HOME_ENV,
  systemBinDirs,
  UPDATE_MODE_ENV,
  wrapperArgs,
  type LaunchChild,
  type LaunchPlanInput,
  type LaunchSpawn,
} from '../src/launcher.js'

const directories: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-launcher-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
})

/** Stage an executable `node` stub at `<dir>/node`. */
function fakeNode(binDir: string): string {
  mkdirSync(binDir, { recursive: true })
  const node = join(binDir, 'node')
  writeFileSync(node, '#!/bin/sh\nexit 0\n')
  chmodSync(node, 0o755)
  return node
}

function input(root: string, overrides: Partial<LaunchPlanInput> = {}): LaunchPlanInput {
  return {
    home: join(root, 'home'),
    prefix: join(root, 'prefix'),
    shim: join(root, 'bin', 'dsh'),
    flag: '--prepare',
    channel: 'stable',
    runId: 'run42',
    logPath: join(root, 'home', 'update-check', 'run.log'),
    pidFile: join(root, 'home', 'update-check', 'run.pid'),
    ...overrides,
  }
}

describe('resolveRuntime', () => {
  it('prefers the recorded prefix runtime', () => {
    const root = scratch()
    const runtimeBin = join(root, 'prefix', 'runtime', 'node', 'current', 'bin')
    const node = fakeNode(runtimeBin)
    // An nvm layout also exists; the prefix runtime still wins.
    fakeNode(join(root, 'home', '.local', 'share', 'nvm', 'v22.22.2', 'bin'))
    const { probe, probed } = resolveRuntime({ prefix: join(root, 'prefix'), homeDir: join(root, 'home') })
    expect(probe).toEqual({ binDir: runtimeBin, source: 'prefix-runtime' })
    expect(probed[0]).toBe(runtimeBin)
    expect(node).toBe(join(runtimeBin, 'node'))
  })

  it('finds the newest nvm version under ~/.local/share/nvm', () => {
    const root = scratch()
    const homeDir = join(root, 'home')
    fakeNode(join(homeDir, '.local', 'share', 'nvm', 'v18.20.4', 'bin'))
    const newest = fakeNode(join(homeDir, '.local', 'share', 'nvm', 'v22.22.2', 'bin'))
    const { probe } = resolveRuntime({ prefix: join(root, 'prefix'), homeDir })
    expect(probe).toEqual({ binDir: join(homeDir, '.local', 'share', 'nvm', 'v22.22.2', 'bin'), source: 'nvm' })
    expect(newest).toBe(join(probe!.binDir, 'node'))
  })

  it('finds the newest nvm version under ~/.nvm/versions/node', () => {
    const root = scratch()
    const homeDir = join(root, 'home')
    fakeNode(join(homeDir, '.nvm', 'versions', 'node', 'v20.11.0', 'bin'))
    const { probe } = resolveRuntime({ prefix: join(root, 'prefix'), homeDir })
    expect(probe?.source).toBe('nvm')
    expect(probe?.binDir).toContain(join('.nvm', 'versions', 'node'))
  })

  it('accepts an inherited PATH that resolves node, and prefers it over system dirs', () => {
    const root = scratch()
    const binDir = join(root, 'elsewhere', 'bin')
    fakeNode(binDir)
    const { probe } = resolveRuntime({
      prefix: join(root, 'prefix'),
      homeDir: join(root, 'home'),
      baseEnv: { PATH: binDir },
    })
    expect(probe).toEqual({ binDir: '', source: 'path' })
  })

  it('reports every probed location and null when nothing resolves', () => {
    const root = scratch()
    const platform = process.platform
    const { probe, probed } = resolveRuntime({
      prefix: join(root, 'prefix'),
      homeDir: join(root, 'home'),
      baseEnv: {},
      platform,
    })
    expect(probe).toBeNull()
    expect(probed).toEqual([
      join(root, 'prefix', 'runtime', 'node', 'current', 'bin'),
      join(root, 'home', '.local', 'share', 'nvm', '*/bin'),
      join(root, 'home', '.nvm', 'versions', 'node', '*/bin'),
      'PATH',
      ...systemBinDirs(platform),
    ])
  })
})

describe('resolveLaunchEnvironment', () => {
  it('composes PATH with the probe first, the inherited PATH next, and system dirs last', () => {
    const root = scratch()
    const runtimeBin = join(root, 'prefix', 'runtime', 'node', 'current', 'bin')
    fakeNode(runtimeBin)
    const environment = resolveLaunchEnvironment({
      ...input(root),
      baseEnv: { PATH: '/custom/bin' },
    })
    const segments = environment.path.split(delimiter)
    expect(segments[0]).toBe(runtimeBin)
    expect(segments).toContain('/custom/bin')
    for (const dir of systemBinDirs()) expect(segments).toContain(dir)
    expect(environment.source).toBe('prefix-runtime')
    expect(environment.nodePath).toBe(join(runtimeBin, 'node'))
    expect(environment.env[RUN_HOME_ENV]).toBe(input(root).home)
    expect(environment.env.PREFIX).toBe(input(root).prefix)
  })

  it('labels the one-shot rung with DSH_UPDATE_MODE=one-shot and leaves the phase rungs unlabelled', () => {
    const root = scratch()
    fakeNode(join(root, 'prefix', 'runtime', 'node', 'current', 'bin'))
    const oneShot = resolveLaunchEnvironment(input(root, { flag: 'one-shot' }))
    expect(oneShot.env[UPDATE_MODE_ENV]).toBe('one-shot')
    expect(resolveLaunchEnvironment(input(root, { flag: '--prepare' })).env[UPDATE_MODE_ENV]).toBeUndefined()
    expect(resolveLaunchEnvironment(input(root, { flag: '--apply' })).env[UPDATE_MODE_ENV]).toBeUndefined()
    const plan = launchPlan(input(root, { flag: 'one-shot', platform: 'linux', hasCommand: () => true }), oneShot)
    expect(plan[0]!.args).toContain(`--setenv=${UPDATE_MODE_ENV}=one-shot`)
    expect(plan[0]!.args.slice(-3)).toEqual(['update', '--channel', 'stable'])
    const preparePlan = launchPlan(
      input(root, { platform: 'linux', hasCommand: () => true }),
      resolveLaunchEnvironment(input(root)),
    )
    expect(preparePlan[0]!.args.some(arg => arg.startsWith(`--setenv=${UPDATE_MODE_ENV}=`))).toBe(false)
  })

  it('throws LaunchEnvironmentError naming every probed location when nothing resolves', () => {
    const root = scratch()
    let error: unknown
    try {
      resolveLaunchEnvironment({ ...input(root), baseEnv: {}, probeHomeDir: join(root, 'home') })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(LaunchEnvironmentError)
    expect((error as Error).message).toContain('no Node.js runtime found for the updater')
    expect((error as Error).message).toContain(join(root, 'prefix', 'runtime', 'node', 'current', 'bin'))
    expect((error as LaunchEnvironmentError).probed).toContain('PATH')
  })

  it('fails even without a runtime when node is not on the inherited PATH (the live failure)', () => {
    const root = scratch()
    // The service environment that produced "no usable Node.js found": no
    // PATH at all, no nvm under the probed home, no recorded prefix runtime.
    expect(() => resolveLaunchEnvironment({
      ...input(root),
      baseEnv: {},
      probeHomeDir: join(root, 'home'),
    })).toThrow(LaunchEnvironmentError)
  })
})

describe('commandOnPath', () => {
  it('finds only executable files on the given PATH', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'bin'))
    const unique = `dsh-launcher-spec-${String(process.pid)}`
    writeFileSync(join(dir, 'bin', `${unique}-yes`), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(dir, 'bin', `${unique}-no`), '#!/bin/sh\n', { mode: 0o644 })
    const path = join(dir, 'bin')
    expect(commandOnPath(`${unique}-yes`, path)).toBe(true)
    expect(commandOnPath(`${unique}-no`, path)).toBe(false)
    expect(commandOnPath(`${unique}-yes`, undefined)).toBe(false)
    expect(commandOnPath(`${unique}-yes`, '')).toBe(false)
    expect(commandOnPath(`${unique}-yes`, `${path}:`)).toBe(true)
  })
})

describe('launchWrapper and wrapperArgs', () => {
  it('exports the composed environment before recording the pid and exec’ing the updater', () => {
    const root = scratch()
    const runtimeBin = join(root, 'prefix', 'runtime', 'node', 'current', 'bin')
    fakeNode(runtimeBin)
    const planInput = input(root)
    const environment = resolveLaunchEnvironment(planInput)
    const wrapper = launchWrapper(environment)
    expect(wrapper).toContain(`export PATH='${environment.path}'`)
    expect(wrapper).toContain(`export ${RUN_HOME_ENV}='${planInput.home}'`)
    expect(wrapper).toContain(`export PREFIX='${planInput.prefix}'`)
    expect(wrapper).toContain('echo $$ > "$pid"')
    expect(wrapper.indexOf('export PATH')).toBeLessThan(wrapper.indexOf('exec "$@"'))
    expect(environment.path.split(delimiter)[0]).toBe(runtimeBin)
  })

  it('quotes a single quote inside an exported value', () => {
    const root = scratch()
    fakeNode(join(root, 'prefix', 'runtime', 'node', 'current', 'bin'))
    const planInput = input(root, { home: `${join(root, 'ho')}'me` })
    const wrapper = launchWrapper(resolveLaunchEnvironment(planInput))
    expect(wrapper).toContain(`export ${RUN_HOME_ENV}='${join(root, 'ho')}'\\''me'`)
  })

  it('runs prepare with the channel flag and apply without it', () => {
    const root = scratch()
    fakeNode(join(root, 'prefix', 'runtime', 'node', 'current', 'bin'))
    const environment = resolveLaunchEnvironment(input(root))
    const prepareArgs = wrapperArgs(input(root), environment)
    expect(prepareArgs.slice(-4)).toEqual(['update', '--channel', 'stable', '--prepare'])
    expect(prepareArgs[2]).toBe('dsh-update')
    expect(prepareArgs[3]).toBe(input(root).logPath)
    expect(prepareArgs[4]).toBe(input(root).pidFile)
    expect(prepareArgs[5]).toBe(input(root).shim)
    expect(wrapperArgs(input(root, { flag: '--apply' }), environment).slice(-2)).toEqual(['update', '--apply'])
  })
})

describe('launchPlan', () => {
  function planFor(root: string, overrides: Partial<LaunchPlanInput> = {}) {
    const planInput = input(root, overrides)
    fakeNode(join(root, 'prefix', 'runtime', 'node', 'current', 'bin'))
    return { planInput, plan: launchPlan(planInput, resolveLaunchEnvironment(planInput)) }
  }

  it('orders linux as systemd-run → setsid → spawn when every command exists', () => {
    const root = scratch()
    const { plan } = planFor(root, { platform: 'linux', hasCommand: () => true })
    expect(plan.map(step => step.rung)).toEqual(['systemd-run', 'setsid', 'spawn'])
    expect(plan[0]!.unit).toBe('dsh-update-run42')
    expect(plan[0]!.args.slice(0, 4)).toEqual(['--user', '--collect', '--quiet', '--wait'])
    expect(plan[0]!.args).toContain('--unit=dsh-update-run42')
    expect(plan[0]!.args).toContain(`--setenv=${RUN_HOME_ENV}=${join(root, 'home')}`)
    expect(plan[0]!.args).toContain(`--setenv=PREFIX=${join(root, 'prefix')}`)
    // The PATH carried into the transient unit is the composed one, so the
    // unit itself resolves node without the service environment.
    const pathArg = plan[0]!.args.find(arg => arg.startsWith('--setenv=PATH='))!
    expect(pathArg).toContain(join(root, 'prefix', 'runtime', 'node', 'current', 'bin'))
    expect(plan[0]!.args).toContain('--')
    expect(plan[0]!.args.slice(-12)).toEqual([
      '--',
      'sh', '-c', expect.any(String), 'dsh-update',
      join(root, 'home', 'update-check', 'run.log'),
      join(root, 'home', 'update-check', 'run.pid'),
      join(root, 'bin', 'dsh'),
      'update', '--channel', 'stable', '--prepare',
    ])
  })

  it('skips absent commands and always ends with the bare spawn fallback', () => {
    expect(planFor(scratch(), { platform: 'linux', hasCommand: () => false }).plan.map(step => step.rung)).toEqual(['spawn'])
    expect(planFor(scratch(), { platform: 'linux', hasCommand: command => command === 'setsid' }).plan.map(step => step.rung))
      .toEqual(['setsid', 'spawn'])
    expect(planFor(scratch(), { platform: 'freebsd', hasCommand: () => true }).plan.map(step => step.rung))
      .toEqual(['setsid', 'spawn'])
  })

  it('orders darwin as launchctl → setsid → spawn', () => {
    const { planInput, plan } = planFor(scratch(), { platform: 'darwin', hasCommand: () => true })
    expect(plan.map(step => step.rung)).toEqual(['launchctl', 'setsid', 'spawn'])
    const launchctl = plan[0]!
    expect(launchctl.unit).toBe('com.dsh.update.run42')
    expect(launchctl.args.slice(0, 8)).toEqual([
      'submit', '-l', 'com.dsh.update.run42', '-o', planInput.logPath, '-e', planInput.logPath, '--',
    ])
    expect(launchctl.args.slice(8, 11)).toEqual(['sh', '-c', expect.any(String)])
  })
})

describe('launchUpdater', () => {
  function child(pid: number): LaunchChild {
    return { pid, unref: vi.fn() }
  }

  it('spawns the first rung detached with the composed environment and unref', () => {
    const root = scratch()
    fakeNode(join(root, 'prefix', 'runtime', 'node', 'current', 'bin'))
    const spawn = vi.fn<LaunchSpawn>(() => child(1234))
    const outcome = launchUpdater({
      ...input(root, { platform: 'linux', hasCommand: () => true }),
      spawn,
    })
    expect(outcome).toEqual({ rung: 'systemd-run', unit: 'dsh-update-run42', pid: 1234 })
    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawn.mock.calls[0]!
    expect(command).toBe('systemd-run')
    expect(args).toContain('--unit=dsh-update-run42')
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' })
    const env = options.env as Record<string, string>
    expect(env[RUN_HOME_ENV]).toBe(join(root, 'home'))
    expect(env.PREFIX).toBe(join(root, 'prefix'))
    expect(env.PATH!.split(delimiter)[0]).toBe(join(root, 'prefix', 'runtime', 'node', 'current', 'bin'))
  })

  it('throws LaunchEnvironmentError before spawning anything when no runtime resolves', () => {
    const root = scratch()
    const spawn = vi.fn()
    expect(() => launchUpdater({
      ...input(root, { platform: 'linux', hasCommand: () => false }),
      baseEnv: {},
      probeHomeDir: join(root, 'home'),
      spawn,
    })).toThrow(LaunchEnvironmentError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('falls through to the next rung when a spawn throws synchronously', () => {
    const root = scratch()
    fakeNode(join(root, 'prefix', 'runtime', 'node', 'current', 'bin'))
    const spawn = vi.fn()
      .mockImplementationOnce(() => { throw new Error('spawn systemd-run ENOENT') })
      .mockImplementationOnce(() => child(777))
    const outcome = launchUpdater({
      ...input(root, { platform: 'linux', hasCommand: () => true }),
      spawn,
    })
    expect(outcome.rung).toBe('setsid')
    expect(outcome.pid).toBe(777)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[1]![0]).toBe('setsid')
  })

  it('reports a null pid when the platform does not name one, and throws when nothing spawns', () => {
    const root = scratch()
    fakeNode(join(root, 'prefix', 'runtime', 'node', 'current', 'bin'))
    const outcome = launchUpdater({
      ...input(root, { platform: 'linux', hasCommand: () => false }),
      spawn: () => ({ unref: vi.fn() }),
    })
    expect(outcome).toEqual({ rung: 'spawn', pid: null })
    expect(() => launchUpdater({
      ...input(root, { platform: 'linux', hasCommand: () => false }),
      spawn: () => { throw new Error('spawn sh ENOENT') },
    })).toThrow(/ENOENT/)
  })
})
