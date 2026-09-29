/**
 * Read-only system scan backing the system analysis: hardware, operating
 * system, running services, installed tooling, hosting hints, disk capacity,
 * and the NVIDIA GPU when one is present. Every probe is independent and
 * bounded; a missing tool or a failed command degrades that one section to a
 * named absence and never fails the scan. Nothing here writes to the host.
 * @module @deepseek-ai/dsh-host-first-run/scan
 */

import { execFile } from 'node:child_process'
import { readFileSync, statfsSync } from 'node:fs'
import { arch, cpus, hostname, platform, release, totalmem, type } from 'node:os'

/** Stages the scan itself runs, in execution order. */
export const SCAN_STAGES = ['hardware', 'operating system', 'services', 'tooling', 'hosting', 'disk', 'GPU'] as const

/** Every stage one analysis run reports, scan stages first. */
export const ANALYSIS_STAGES = [...SCAN_STAGES, 'summarising', 'writing profile'] as const

/** One stage name from {@link ANALYSIS_STAGES}. */
export type AnalysisStage = typeof ANALYSIS_STAGES[number]

/** One installed tool and the version its own command reported. */
export interface ToolFact {
  /** Stable tool name the summariser reads. */
  name: string
  /** Version string, or null when the tool is absent or answered nothing. */
  version: string | null
}

/** One filesystem's capacity. */
export interface DiskFact {
  /** Absolute path whose filesystem was measured. */
  path: string
  /** Free GiB, or null when the filesystem could not be measured. */
  freeGiB: number | null
  /** Total GiB, or null when the filesystem could not be measured. */
  totalGiB: number | null
}

/** The NVIDIA GPU as its management tool reported it. */
export interface GpuFact {
  name: string
  memory: string
  driver: string
}

/** Raw facts one scan collected; the JSON artifact beside the profile document. */
export interface SystemScanFacts {
  /** ISO timestamp of the scan. */
  scannedAt: string
  hostname: string
  hardware: {
    cpu: string | null
    threads: number
    memoryGiB: number
  }
  os: {
    type: string
    release: string
    platform: string
    arch: string
    distribution: string | null
  }
  services: {
    /** Running system service units, or null when the listing was unavailable. */
    system: number | null
    /** Running user service units, or null when the listing was unavailable. */
    user: number | null
    /** Unit names, capped; raw inventory that never reaches the profile document. */
    names: string[]
  }
  tooling: ToolFact[]
  hosting: {
    /** Running containers, or null when Docker did not answer. */
    containers: number | null
    /** Container names, capped; raw inventory that never reaches the profile document. */
    containerNames: string[]
    /** Distinct listening TCP ports, or null when the socket listing was unavailable. */
    listeningPorts: number[] | null
    /** Compose project names, or null when Docker Compose did not answer. */
    composeProjects: string[] | null
  }
  disk: DiskFact[]
  gpu: GpuFact | null
}

/** Facts the client renders from the completed scan. */
export interface SystemScanSummary {
  /** Logical CPU threads reported by the operating system. */
  threads: number
  /** Total memory in GiB, rounded to one decimal. */
  memoryGiB: number
  /** Running service units counted, or null when the listing was unavailable. */
  services: number | null
  /** GPU description when one was found, absent otherwise. */
  gpu?: string
  /** Running containers counted, absent when Docker did not answer. */
  containers?: number
  /** Installed tools counted, absent when no probe answered. */
  tools?: number
}

/** Completed scan: render summary plus the raw facts. */
export interface SystemScanResult {
  summary: SystemScanSummary
  facts: SystemScanFacts
}

/** Bound applied to each external probe command. */
const COMMAND_TIMEOUT_MS = 5_000

/** Cap on raw inventory names kept in the JSON artifact. */
const NAME_CAP = 60

const GIB = 1024 ** 3

/**
 * Run a bounded external command.
 * @param file - executable name resolved through PATH.
 * @param args - command arguments.
 * @returns stdout, or null when the command is missing, fails, or exceeds its bound.
 */
function probeCommand(file: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: COMMAND_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      resolve(error === null ? stdout : null)
    })
  })
}

/** Read the distribution's own name when the file is available. */
function distributionName(): string | null {
  try {
    const line = readFileSync('/etc/os-release', 'utf8')
      .split('\n')
      .find(entry => entry.startsWith('PRETTY_NAME='))
    return line === undefined ? null : line.slice('PRETTY_NAME='.length).replace(/^"|"$/gu, '')
  } catch (_absent) {
    return null
  }
}

/** Format a byte count as GiB with one decimal. */
function gib(bytes: number): number {
  return Number((bytes / GIB).toFixed(1))
}

/** First version-like token in a command's output, or null when none appears. */
function firstVersion(output: string): string | null {
  const match = /\d+\.\d+(?:\.\d+)?/u.exec(output)
  return match === null ? null : match[0]
}

/** Collect hardware facts: CPU model and thread count, total memory, host name. */
function scanHardware(): SystemScanFacts['hardware'] & { hostname: string } {
  const processors = cpus()
  const model = processors[0]?.model.trim()
  return {
    hostname: hostname(),
    cpu: model === undefined || model === '' ? null : model,
    threads: processors.length,
    memoryGiB: gib(totalmem()),
  }
}

/** Collect operating-system facts: kernel, platform, architecture, distribution. */
function scanOperatingSystem(): SystemScanFacts['os'] {
  return {
    type: type(),
    release: release(),
    platform: platform(),
    arch: arch(),
    distribution: distributionName(),
  }
}

/** Parse one `systemctl list-units` listing into running unit names. */
function parseUnitNames(output: string): string[] {
  return output
    .split('\n')
    .filter(line => line.includes(' loaded active running '))
    .map(line => line.trim().split(/\s+/u)[0])
    .filter((name): name is string => name !== undefined && name !== '')
    .sort()
}

/**
 * Count and name the running systemd services, system and user scope.
 * @returns the two counts and the capped unit-name inventory.
 */
async function scanServices(): Promise<SystemScanFacts['services']> {
  const [systemOutput, userOutput] = await Promise.all([
    probeCommand('systemctl', ['list-units', '--type=service', '--state=running', '--no-pager', '--plain']),
    probeCommand('systemctl', ['--user', 'list-units', '--type=service', '--state=running', '--no-pager', '--plain']),
  ])
  const systemNames = systemOutput === null ? null : parseUnitNames(systemOutput)
  const userNames = userOutput === null ? null : parseUnitNames(userOutput)
  const names = [...systemNames ?? [], ...userNames ?? []]
  return {
    system: systemNames === null ? null : systemNames.length,
    user: userNames === null ? null : userNames.length,
    names: names.slice(0, NAME_CAP),
  }
}

/** One tool probe: the command and the name the facts carry. */
interface ToolProbe {
  name: string
  file: string
  args: readonly string[]
}

/** Tools the analysis reports; a missing one stays a named null. */
const TOOL_PROBES: readonly ToolProbe[] = [
  { name: 'docker', file: 'docker', args: ['--version'] },
  { name: 'node', file: 'node', args: ['--version'] },
  { name: 'npm', file: 'npm', args: ['--version'] },
  { name: 'python', file: 'python3', args: ['--version'] },
  { name: 'cuda', file: 'nvcc', args: ['--version'] },
  { name: 'git', file: 'git', args: ['--version'] },
  { name: 'pnpm', file: 'pnpm', args: ['--version'] },
  { name: 'tailscale', file: 'tailscale', args: ['version'] },
]

/** Probe every tool in parallel; each probe is bounded and independent. */
async function scanTooling(): Promise<ToolFact[]> {
  return Promise.all(TOOL_PROBES.map(async (probe): Promise<ToolFact> => {
    const output = await probeCommand(probe.file, probe.args)
    return { name: probe.name, version: output === null ? null : firstVersion(output) }
  }))
}

/** Parse `ss -ltnH` output into distinct listening TCP ports. */
function parseListeningPorts(output: string): number[] {
  const ports = new Set<number>()
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/u)
    const local = fields[3]
    if (local === undefined) continue
    const port = Number(local.slice(local.lastIndexOf(':') + 1))
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port)
  }
  return [...ports].sort((left, right) => left - right)
}

/** Parse `docker compose ls --format json` into project names. */
function parseComposeProjects(output: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(output)
    if (!Array.isArray(parsed)) return null
    return parsed
      .map(entry => (typeof entry === 'object' && entry !== null ? (entry as { Name?: unknown }).Name : undefined))
      .filter((name): name is string => typeof name === 'string' && name !== '')
  } catch (_notJson) {
    // Older Compose releases print a table; fall back to its first column.
    const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (lines.length <= 1) return null
    return lines.slice(1).map(line => line.split(/\s+/u)[0]).filter((name): name is string => name !== undefined && name !== '')
  }
}

/** Collect hosting hints: running containers, listening ports, compose projects. */
async function scanHosting(): Promise<SystemScanFacts['hosting']> {
  const [containersOutput, portsOutput, composeOutput] = await Promise.all([
    probeCommand('docker', ['ps', '--format', '{{.Names}}']),
    probeCommand('ss', ['-ltnH']),
    probeCommand('docker', ['compose', 'ls', '--format', 'json']),
  ])
  const containerNames = containersOutput === null
    ? null
    : containersOutput.split('\n').map(line => line.trim()).filter(line => line !== '')
  return {
    containers: containerNames === null ? null : containerNames.length,
    containerNames: (containerNames ?? []).slice(0, NAME_CAP),
    listeningPorts: portsOutput === null ? null : parseListeningPorts(portsOutput),
    composeProjects: composeOutput === null ? null : parseComposeProjects(composeOutput),
  }
}

/**
 * Report free and total capacity for the filesystem carrying a path.
 * @param path - absolute path whose filesystem is measured.
 * @returns the capacity fact, or nulls when the filesystem cannot be measured.
 */
function scanDisk(path: string): DiskFact {
  try {
    const stats = statfsSync(path)
    return {
      path,
      freeGiB: gib(Number(stats.bavail) * Number(stats.bsize)),
      totalGiB: gib(Number(stats.blocks) * Number(stats.bsize)),
    }
  } catch (_unmeasurable) {
    return { path, freeGiB: null, totalGiB: null }
  }
}

/** Query the NVIDIA GPU through its management tool. */
async function scanGpu(): Promise<GpuFact | null> {
  const output = await probeCommand('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'])
  const first = output?.split('\n').map(line => line.trim()).find(line => line !== '')
  if (first === undefined) return null
  const [name, memory, driver] = first.split(',').map(part => part.trim())
  if (name === undefined || name === '') return null
  return { name, memory: memory ?? '', driver: driver ?? '' }
}

/**
 * Run every probe and assemble the raw facts.
 * @param onStage - observer called with the stage name as each stage begins.
 * @returns the render summary and the raw facts.
 */
export async function runSystemScan(
  onStage: (stage: AnalysisStage) => void = () => {},
): Promise<SystemScanResult> {
  onStage('hardware')
  const hardware = scanHardware()
  onStage('operating system')
  const operatingSystem = scanOperatingSystem()
  onStage('services')
  const services = await scanServices()
  onStage('tooling')
  const tooling = await scanTooling()
  onStage('hosting')
  const hosting = await scanHosting()
  onStage('disk')
  const disk = [scanDisk('/'), scanDisk(process.cwd())]
  onStage('GPU')
  const gpu = await scanGpu()

  const serviceTotal = services.system === null && services.user === null
    ? null
    : (services.system ?? 0) + (services.user ?? 0)
  const installed = tooling.filter(tool => tool.version !== null).length
  const summary: SystemScanSummary = {
    threads: hardware.threads,
    memoryGiB: hardware.memoryGiB,
    services: serviceTotal,
    ...gpu === null ? {} : { gpu: `${gpu.name} (${gpu.memory}, driver ${gpu.driver})` },
    ...hosting.containers === null ? {} : { containers: hosting.containers },
    ...installed === 0 ? {} : { tools: installed },
  }
  const facts: SystemScanFacts = {
    scannedAt: new Date().toISOString(),
    hostname: hardware.hostname,
    hardware: { cpu: hardware.cpu, threads: hardware.threads, memoryGiB: hardware.memoryGiB },
    os: operatingSystem,
    services,
    tooling,
    hosting,
    disk,
    gpu,
  }
  return { summary, facts }
}
