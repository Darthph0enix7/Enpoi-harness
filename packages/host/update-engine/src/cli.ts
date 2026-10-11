/**
 * Command-line face of the update engine, invoked by the updater over the
 * shipped tree (P3 owns the install.sh wiring). Commands operate on explicit
 * directories and manifest files; the CLI never guesses a prefix.
 */

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { writeBufferAtomic } from './atomic.ts'
import { loadPins, loadTombstones } from './pins.ts'
import { readManifest, scanTree, writeManifest } from './manifest.ts'
import { buildPlan, parsePlan, serializePlan } from './plan.ts'
import { applyPlan, discardStaging } from './apply.ts'
import type { UpdatePlan } from './types.ts'

/** Output sinks, injectable for tests. */
export interface CliIo {
  /** Write a line to standard output. */
  stdout(text: string): void
  /** Write a line to standard error. */
  stderr(text: string): void
}

const USAGE = `usage: dsh-update-engine <command> [options]

commands:
  hash    --root <dir> --out <manifest.json> [--ignore <glob>]...
  plan    --previous <manifest> --next <manifest> --local <dir> --base <dir>
          --release <dir> --to-version <v> [--from-version <v>]
          [--tombstones <file>] [--pins <file>] [--out <plan.json>]
  apply   --plan <plan.json> --local <dir> --base <dir> --release <dir>
          --staging <dir> [--journal <file>] [--timestamp <iso>]
          [--backup <dir>]
  discard --staging <dir> [--journal <file>]
`

interface ParsedArgs {
  flags: Map<string, string>
  lists: Map<string, string[]>
  positionals: string[]
}

/**
 * Run one CLI invocation.
 * @param argv - Arguments after the program name.
 * @param io - Output sinks; defaults to the process streams.
 * @returns Process exit code.
 */
export async function main(argv: readonly string[], io: CliIo = consoleIo()): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'hash':
        return await runHash(rest, io)
      case 'plan':
        return await runPlan(rest, io)
      case 'apply':
        return await runApply(rest, io)
      case 'discard':
        return await runDiscard(rest, io)
      case '--help':
      case '-h':
      case undefined:
        io.stdout(USAGE)
        return 0
      default:
        io.stderr(`unknown command: ${command}`)
        io.stderr(USAGE)
        return 2
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

async function runHash(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv)
  const root = required(args, 'root')
  const out = required(args, 'out')
  const manifest = await scanTree(root, { ignore: args.lists.get('ignore') ?? [] })
  await writeManifest(out, manifest)
  io.stdout(`hashed ${Object.keys(manifest).length} paths -> ${out}`)
  return 0
}

async function runPlan(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv)
  const previous = await readManifest(required(args, 'previous'))
  const next = await readManifest(required(args, 'next'))
  const localRoot = required(args, 'local')
  const local = await scanTree(localRoot)
  const plan = await buildPlan({
    fromVersion: args.flags.get('from-version') ?? null,
    toVersion: required(args, 'to-version'),
    previous,
    next,
    local,
    localRoot,
    baseRoot: required(args, 'base'),
    releaseRoot: required(args, 'release'),
    tombstones: args.flags.has('tombstones') ? await loadTombstones(required(args, 'tombstones')) : [],
    pins: args.flags.has('pins') ? await loadPins(required(args, 'pins')) : [],
  })
  const out = args.flags.get('out')
  if (out !== undefined) await writeManifestFile(out, serializePlan(plan))
  io.stdout(planSummary(plan))
  return plan.switchDecision === 'abort' ? 3 : 0
}

async function runApply(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv)
  const planText = await readFile(required(args, 'plan'), 'utf8')
  const plan = parsePlan(planText)
  const journal = args.flags.get('journal')
  const backup = args.flags.get('backup')
  const timestamp = args.flags.get('timestamp')
  const result = await applyPlan({
    plan,
    localRoot: required(args, 'local'),
    baseRoot: required(args, 'base'),
    releaseRoot: required(args, 'release'),
    stagingRoot: required(args, 'staging'),
    ...(journal === undefined ? {} : { journalPath: journal }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(backup === undefined ? {} : { backupDir: backup }),
  })
  io.stdout(result.report.human.trimEnd())
  switch (result.status) {
    case 'applied':
    case 'noop':
    case 'interrupted':
      return 0
    case 'aborted':
      return 3
    case 'rollback-required':
      return 4
    case 'failed':
      return 1
  }
}

async function runDiscard(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv)
  const staging = required(args, 'staging')
  const journal = args.flags.get('journal')
  if (journal === undefined) await discardStaging(staging)
  else await discardStaging(staging, journal)
  io.stdout(`discarded ${staging}`)
  return 0
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>()
  const lists = new Map<string, string[]>()
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? ''
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const key = equals === -1 ? token.slice(2) : token.slice(2, equals)
    const value = equals === -1 ? argv[index + 1] ?? '' : token.slice(equals + 1)
    if (equals === -1 && (argv[index + 1] === undefined || String(argv[index + 1]).startsWith('--'))) {
      throw new Error(`missing value for --${key}`)
    }
    if (equals === -1) index++
    if (key === 'ignore') {
      const list = lists.get(key) ?? []
      list.push(value)
      lists.set(key, list)
    } else {
      flags.set(key, value)
    }
  }
  return { flags, lists, positionals }
}

function required(args: ParsedArgs, key: string): string {
  const value = args.flags.get(key)
  if (value === undefined || value === '') throw new Error(`missing required --${key}`)
  return value
}

function planSummary(plan: UpdatePlan): string {
  const lines = [
    `plan: ${plan.fromVersion ?? 'cold'} -> ${plan.toVersion} (switch ${plan.switchDecision})`,
    `actions: ${plan.actions.length} (replace ${plan.counts.replace}, add ${plan.counts.add}, merge ${plan.counts.merge},`
    + ` keep-local ${plan.counts['keep-local']}, keep-untracked ${plan.counts['keep-untracked']}, restore ${plan.counts.restore},`
    + ` delete ${plan.counts.delete}, pin-skip ${plan.counts['pin-skip']}, tombstone ${plan.counts.tombstone}, skip ${plan.counts.skip})`,
    `conflicts: ${plan.conflicts.length}`,
    `fingerprint: ${plan.fingerprint}`,
  ]
  return lines.join('\n')
}

async function writeManifestFile(path: string, text: string): Promise<void> {
  await writeBufferAtomic(path, Buffer.from(text, 'utf8'), 0o644)
}

function consoleIo(): CliIo {
  return {
    stdout: text => process.stdout.write(text + '\n'),
    stderr: text => process.stderr.write(text + '\n'),
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}
