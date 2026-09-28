/**
 * Read-only system scan backing the first-run analysis: hardware, operating
 * system, running services, disk capacity, and the NVIDIA GPU when one is
 * present. Every probe is independent and bounded; a missing tool or a failed
 * command degrades that one section to a named line and never fails the scan.
 * @module @deepseek-ai/dsh-host-first-run/scan
 */

import { execFile } from 'node:child_process'
import { readFileSync, statfsSync } from 'node:fs'
import { cpus, release, totalmem, type, platform, arch } from 'node:os'

/** Stages the analysis dock renders, in execution order. */
export const ANALYSIS_STAGES = ['hardware', 'operating system', 'services', 'disk', 'GPU', 'writing context'] as const

/** One stage name from {@link ANALYSIS_STAGES}. */
export type AnalysisStage = typeof ANALYSIS_STAGES[number]

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
}

/** Completed scan: render summary plus the Markdown document. */
export interface SystemScanResult {
  summary: SystemScanSummary
  markdown: string
}

/** Bound applied to each external probe command. */
const COMMAND_TIMEOUT_MS = 5_000

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
function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`
}

/**
 * Collect hardware facts: CPU model and thread count, total memory, host name.
 * @returns Markdown lines for the hardware section.
 */
function scanHardware(): { lines: string[]; threads: number; memoryGiB: number } {
  const processors = cpus()
  const model = processors[0]?.model.trim()
  const threads = processors.length
  const memoryGiB = Number((totalmem() / GIB).toFixed(1))
  return {
    threads,
    memoryGiB,
    lines: [
      `- CPU: ${model === undefined || model === '' ? 'unknown model' : model}, ${threads} threads`,
      `- Memory: ${gib(totalmem())}`,
    ],
  }
}

/**
 * Collect operating-system facts: kernel, platform, architecture, distribution.
 * @returns Markdown lines for the operating-system section.
 */
function scanOperatingSystem(): string[] {
  const distribution = distributionName()
  return [
    `- System: ${type()} ${release()} (${platform()} ${arch()})`,
    ...distribution === null ? [] : [`- Distribution: ${distribution}`],
  ]
}

/**
 * Count and name the running systemd services.
 * @returns the service count and Markdown lines, or null when the listing is unavailable.
 */
async function scanServices(): Promise<{ count: number; lines: string[] } | null> {
  const output = await probeCommand('systemctl', ['list-units', '--type=service', '--state=running', '--no-pager', '--plain'])
  if (output === null) return null
  const names = output
    .split('\n')
    .filter(line => line.includes(' loaded active running '))
    .map(line => line.trim().split(/\s+/u)[0])
    .filter(name => name !== undefined && name !== '')
    .sort()
  const shown = names.slice(0, 20)
  return {
    count: names.length,
    lines: [
      `- Running services: ${names.length}`,
      ...shown.length === 0 ? [] : [`- Units: ${shown.join(', ')}${names.length > shown.length ? ', and more' : ''}`],
    ],
  }
}

/**
 * Report free and total capacity for the filesystem carrying a path.
 * @param path - absolute path whose filesystem is measured.
 * @returns one Markdown line, or a named unavailable line when the filesystem cannot be measured.
 */
function scanDisk(path: string): string {
  try {
    const stats = statfsSync(path)
    const total = Number(stats.blocks) * Number(stats.bsize)
    const free = Number(stats.bavail) * Number(stats.bsize)
    return `- ${path}: ${gib(free)} free of ${gib(total)}`
  } catch (error) {
    return `- ${path}: capacity unavailable (${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * Query the NVIDIA GPU through its management tool.
 * @returns the GPU line when the tool answered, null when no GPU was reported.
 */
async function scanGpu(): Promise<string | null> {
  const output = await probeCommand('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'])
  const first = output?.split('\n').map(line => line.trim()).find(line => line !== '')
  return first === undefined ? null : `- GPU: ${first}`
}

/**
 * Run every probe and assemble the Markdown document.
 * @param onStage - observer called with the stage name and its zero-based index as each stage begins.
 * @returns the render summary and the Markdown document.
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
  onStage('disk')
  const disk = [scanDisk('/'), scanDisk(process.cwd())]
  onStage('GPU')
  const gpu = await scanGpu()

  const summary: SystemScanSummary = {
    threads: hardware.threads,
    memoryGiB: hardware.memoryGiB,
    services: services?.count ?? null,
    ...gpu === null ? {} : { gpu: gpu.slice('- GPU: '.length) },
  }
  onStage('writing context')
  const sections = [
    '# System context',
    '',
    `Read-only scan taken ${new Date().toISOString()}. Nothing was modified.`,
    '',
    '## Hardware',
    ...hardware.lines,
    '',
    '## Operating system',
    ...operatingSystem,
    '',
    '## Services',
    ...services?.lines ?? ['- Running services: unavailable (no systemd listing from this platform)'],
    '',
    '## Disk',
    ...disk,
    ...gpu === null ? [] : ['', '## GPU', gpu],
    '',
  ]
  return { summary, markdown: sections.join('\n') }
}
