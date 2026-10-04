#!/usr/bin/env node
/**
 * Command-line entry for dsh.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'

/**
 * Run the standalone `scripts/doctor.mjs` diagnostic with this process's Node
 * binary and exit with its status.
 * @param args - raw `dsh doctor` arguments, forwarded verbatim (for example `--json`).
 * @returns never resolves; the process exits with the doctor's status.
 */
async function runDoctor(args: readonly string[]): Promise<never> {
  const script = fileURLToPath(new URL('../../../scripts/doctor.mjs', import.meta.url))
  const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' })
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', (exitCode) => {
      resolveExit(exitCode)
    })
  })
  process.exit(code ?? 1)
}

/**
 * Run the public dsh command-line interface.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(): Promise<void> {
  const [command, ...commandArgs] = process.argv.slice(2)
  if (command === 'doctor') await runDoctor(commandArgs)
  const version = getDshRuntimeVersion()
  const invocation = parseDshArgs(process.argv.slice(2), version)

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      try {
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args))
      break
    }
    case 'restart': {
      const { runRestart } = await import('./restart-after-turn.ts')
      process.exit(runRestart(invocation.args))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

/**
 * The oldest supported Node.js: `import.meta.main` exists since 22.18, so any
 * older runtime would otherwise install and exit without running `runCli`.
 */
const MINIMUM_NODE = [22, 19] as const

/** Exit loudly when the running Node.js predates the supported floor. */
function assertSupportedNode(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  const [minimumMajor, minimumMinor] = MINIMUM_NODE
  if (major > minimumMajor || (major === minimumMajor && minor >= minimumMinor)) return
  process.stderr.write(
    `dsh: Node.js ${process.versions.node} is unsupported: dsh requires Node.js >=${minimumMajor}.${minimumMinor}\n`,
  )
  process.exit(1)
}

assertSupportedNode()

if (import.meta.main) {
  await runCli()
}
