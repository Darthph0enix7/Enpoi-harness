/**
 * The sysadmin investigation behind the system analysis. Instead of a fixed
 * host-side probe list, one bounded agent session on the configured preset
 * investigates the machine read-only with the harness's own tools over a fixed
 * checklist, announces each checklist section through its todo list, and
 * writes the finished structured profile plus the comprehensive Markdown
 * document into a scratch workspace the run owns. The durable writes and the
 * decision belong to the runner; this module owns the session, the prompt, the
 * stage mapping, and the time bound.
 * @module @deepseek-ai/dsh-host-first-run/investigation
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
// Empty type imports carry the `agents`, `agentPresets`, `sessionTitle`, and
// `session/event` merges read below.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { brandString } from '@deepseek-ai/dsh-brand'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Checklist sections one investigation reports, in order, plus the write phase. */
export const INVESTIGATION_STAGES = [
  'machine', 'usage', 'hosting', 'tooling', 'runtimes', 'networking', 'resources', 'writing profile',
] as const

/** One stage name from {@link INVESTIGATION_STAGES}. */
export type InvestigationStage = typeof INVESTIGATION_STAGES[number]

/** The finished investigation as the runner consumes it. */
export interface InvestigationOutcome {
  /** Structured profile; the exact keys are {@link REQUIRED_PROFILE_KEYS}. */
  readonly profile: JsonValue
  /** Comprehensive Markdown profile body with full detail. */
  readonly document: string
}

/** Top-level keys the structured profile must carry. */
export const REQUIRED_PROFILE_KEYS = ['hostKind', 'usage', 'capabilities', 'hosting', 'tooling', 'networking'] as const

/** Scratch workspace one investigation owns, under the harness home. */
export function investigationWorkspacePath(): string {
  return dshHomePath('system-analysis-work')
}

/** Structured profile file the investigation writes into its workspace. */
export const PROFILE_JSON_FILENAME = 'profile.json'

/** Markdown body file the investigation writes into its workspace. */
export const PROFILE_DOCUMENT_FILENAME = 'system-profile.md'

/** The one message that opens the investigation. Kept verbatim and pinned by tests. */
export const SYSTEM_ANALYSIS_PROMPT = [
  'Investigate this machine read-only and produce its system profile. You are the sysadmin agent, and this is one bounded, commissioned investigation.',
  '',
  'Read-only means: do not change anything outside your working directory. Run only non-mutating host commands, each bounded with a timeout, and never read secrets (credentials, keys, .env contents, shell histories). The only files you write are the two profile files named below, inside your working directory.',
  '',
  'Keep a todo list with `todo_write` that holds exactly these items, in this order, and mark each one `in_progress` as you start it and `completed` as you finish it:',
  '`machine`, `usage`, `hosting`, `tooling`, `runtimes`, `networking`, `resources`, `write profile`.',
  'The operator watches that list as the run\'s progress.',
  '',
  'Work section by section and cover every section:',
  '',
  '1. `machine` — server or desktop: uptime, load average, kernel and distribution, virtualization or container hints, a graphical session (X11/Wayland/display manager), battery or power supply, package manager, hostname.',
  '2. `usage` — what this machine is used for: coding (git repositories, editors and IDEs, language toolchains with versions) and personal (media, games, user home layout).',
  '3. `hosting` — what it serves: container runtimes and running containers, Docker Compose projects, reverse proxies, listening ports and the processes behind them.',
  '4. `tooling` — installed tooling, done properly, above all accelerators. Check CUDA through EVERY path: the `nvcc` binary, conda environments (`conda env list`, `conda list` for cudatoolkit/pytorch), language runtimes (`python -c "import torch; print(torch.version.cuda)"`), package lists, and the driver (`nvidia-smi`). Also check compute libraries (cuDNN, NCCL), databases, and build chains.',
  '5. `runtimes` — other AI harnesses and local model servers (llama.cpp/llama-server, Ollama, vLLM, LM Studio, ComfyUI, other agent harnesses) and their service units.',
  '6. `networking` — VPN and ingress tooling: Tailscale, cloudflared, WireGuard, OpenVPN, plus DNS, proxy, and address facts.',
  '7. `resources` — disk capacity and headroom per filesystem, GPU inventory and VRAM, memory total and use, CPU class and thread count.',
  '',
  'Accuracy rules:',
  '- A capability is absent ONLY when every plausible path to it is absent. Check the system binary, the conda environment, and the language runtime before recording an absence.',
  '- Never invent a fact. State the evidence path behind every claim ("CUDA 12.8 through the conda PyTorch build; `nvcc` is not on PATH").',
  '- A failed or unavailable probe is reported as such, with what failed; it is not silently dropped.',
  '',
  'When every section is done, write both files in your working directory with the `write` tool:',
  `- \`${PROFILE_JSON_FILENAME}\`: the structured JSON profile, an object with the top-level keys ${REQUIRED_PROFILE_KEYS.map(key => `\`${key}\``).join(', ')}.`,
  '  `hostKind` is one of server, desktop, laptop, vm, other. `capabilities` carries `cpu`, `memory`, `gpu`, `disk`, `accelerators` as SHORT single-line strings (hardware class, count, and headroom only; the detail belongs in the document). `usage`, `hosting`, `tooling`, and `networking` are objects with the concrete facts: names, versions, paths, ports.',
  `- \`${PROFILE_DOCUMENT_FILENAME}\`: the comprehensive Markdown profile body. Open it with a short \`## At a glance\` capability summary — the machine kind and the CPU, memory, GPU, and disk facts, one line each — then the full detail under \`## Machine\`, \`## Usage\`, \`## Hosting\`, \`## Tooling\`, \`## Runtimes\`, \`## Networking\`, \`## Resources\`: name the actual hardware, toolchains, containers, services, ports, and paths, and state the evidence path for each. Mark fast-changing facts (running containers, free space, versions) as a snapshot of this investigation.`,
  '',
  'Then stop immediately: call no further tools and reply with one short confirmation sentence.',
].join('\n')

/** The one corrective message when a turn ended without a complete profile. */
export const SYSTEM_ANALYSIS_CORRECTION = [
  'The investigation turn ended before the profile was complete.',
  `Write both files in your working directory with the write tool: \`${PROFILE_JSON_FILENAME}\` (an object with the top-level keys ${REQUIRED_PROFILE_KEYS.join(', ')}) and \`${PROFILE_DOCUMENT_FILENAME}\` (the full Markdown body with all seven sections).`,
  'Then reply with one short confirmation sentence.',
].join('\n')

/** One todo entry as the stage mapping reads it. */
export interface StageTodo {
  readonly content: string
  readonly status: string
}

/**
 * Map the investigation's todo list to its current stage. The first
 * `in_progress` item decides; unknown or missing items keep the rail where it
 * is rather than inventing progress.
 * @param todos - the latest whole todo list from `todo_write`.
 * @returns the stage that item names, or undefined when none does.
 */
export function stageFromTodos(todos: readonly StageTodo[]): InvestigationStage | undefined {
  const active = todos.find(todo => todo.status === 'in_progress')
  if (active === undefined) return undefined
  const content = active.content.trim().toLowerCase()
  if (content.includes('profile') && /(write|writing|publish|final)/u.test(content)) return 'writing profile'
  for (const stage of INVESTIGATION_STAGES) {
    if (stage === 'writing profile') continue
    if (new RegExp(`\\b${stage}\\b`, 'u').test(content)) return stage
  }
  return undefined
}

/**
 * Validate a parsed structured profile at the file boundary.
 * @param value - parsed JSON value.
 * @returns whether it carries the required top-level keys and value kinds.
 */
export function isSystemProfile(value: unknown): value is JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record['hostKind'] !== 'string') return false
  return REQUIRED_PROFILE_KEYS
    .filter(key => key !== 'hostKind')
    .every((key) => {
      const member = record[key]
      return typeof member === 'object' && member !== null && !Array.isArray(member)
    })
}

/** Read the two artifacts out of the investigation workspace, or undefined while incomplete. */
function readPublished(workspace: string): InvestigationOutcome | undefined {
  try {
    const profile: unknown = JSON.parse(readFileSync(join(workspace, PROFILE_JSON_FILENAME), 'utf8'))
    const document = readFileSync(join(workspace, PROFILE_DOCUMENT_FILENAME), 'utf8').trim()
    if (document === '' || !isSystemProfile(profile)) return undefined
    return { profile, document }
  } catch (_missingOrMalformed) {
    return undefined
  }
}

/** What one investigation run needs from the deployment. */
export interface InvestigationOptions {
  /** Host context carrying the agent runtime and the optional preset/permission/title services. */
  readonly ctx: Context
  /** Scratch workspace the investigation session owns and writes its two artifacts into. */
  readonly workspace: string
  /** Provider route the investigation agent runs on. */
  readonly provider: string
  /** Model id on that route. */
  readonly model: string
  /** Agent preset that investigates (the sysadmin agent by default). */
  readonly preset: string
  /** Permission preset enforced for the investigation session. */
  readonly permissionPreset: string
  /** Hard bound on one investigation, in minutes. */
  readonly timeoutMinutes: number
}

/** Normalize an abort reason into an Error without replacing a real one. */
function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/** Reject when the signal aborts, so a run cannot outlive its bound. */
function aborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(abortError(signal.reason))
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(abortError(signal.reason)) }, { once: true })
  })
}

/** Wait a fixed time; only used to bound the settle after the last turn. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Await the investigation turn's end, or the caller's abort. */
function turnSettled(agent: Agent, signal: AbortSignal): Promise<void> {
  return Promise.race([agent.whenIdle(), aborted(signal)])
}

/** Let the published turn close, then release the investigation session. */
async function settle(ctx: Context, handle: AgentHandle, waitForIdle: boolean): Promise<void> {
  try {
    if (waitForIdle) await Promise.race([handle.agent.whenIdle(), delay(60_000)])
  } catch (error: unknown) {
    ctx.logger.warn('first-run: the investigation agent did not settle cleanly:', error)
  }
  try {
    await handle.dispose()
  } catch (error: unknown) {
    ctx.logger.warn('first-run: the investigation session did not dispose cleanly:', error)
  }
}

/**
 * Run one bounded read-only investigation on the configured agent preset and
 * return the published profile. The caller supplies the stage observer and the
 * cancellation signal; the session is released before this resolves.
 * @param options - deployment services, route, preset, bound, and workspace.
 * @param request - stage observer and cancellation signal.
 * @returns the published structured profile and Markdown document.
 * @throws When the runtime, preset, creation, the time bound, or the published files fail; the runner reports the reason.
 */
export async function runSystemInvestigation(
  options: InvestigationOptions,
  request: { onStage: (stage: InvestigationStage) => void; signal: AbortSignal },
): Promise<InvestigationOutcome> {
  const agents = options.ctx.get('agents')
  if (agents === undefined) {
    throw new Error('the system analysis needs the agent runtime: no AgentFactory is mounted')
  }
  const presets = options.ctx.get('agentPresets')
  if (presets === undefined) {
    throw new Error('the system analysis needs the agent preset registry (@deepseek-ai/dsh-agent-preset-registry)')
  }
  const preset = await presets.resolve(options.preset)
  await using presetScope = await presets.acquireScope(preset.id)
  void presetScope
  request.signal.throwIfAborted()

  // One run owns its workspace: a stale artifact from an earlier run must
  // never be mistaken for this run's publication.
  rmSync(options.workspace, { recursive: true, force: true })
  mkdirSync(options.workspace, { recursive: true })

  const timeout = new AbortController()
  const timer = setTimeout(() => {
    timeout.abort(new Error(`the investigation did not finish within ${options.timeoutMinutes} minute(s)`))
  }, options.timeoutMinutes * 60_000)
  const signal = AbortSignal.any([request.signal, timeout.signal])
  const sessionId = brandString<SessionId>(`system-analysis-${randomUUID()}`)

  let handle: AgentHandle | undefined
  try {
    handle = await agents.create({
      sessionId,
      signal,
      meta: { cwd: options.workspace, agentPreset: preset.id },
      agentOptions: { provider: options.provider, model: options.model },
      setup: async (agentCtx) => {
        await presets.mount(agentCtx, preset.id)
      },
    })
    const permissions = options.ctx.get('permissionPresets')
    if (permissions !== undefined) {
      try {
        permissions.set(handle.agent.session, options.permissionPreset)
      } catch (error: unknown) {
        // A deployment may name its presets differently; the prompt still
        // binds the agent to a read-only investigation, so a missing preset
        // only costs the executor-level guard and is reported, never fatal.
        options.ctx.logger.warn('first-run: permission preset "%s" is unavailable: %s', options.permissionPreset, error)
      }
    }
    options.ctx.get('sessionTitle')?.rename(handle.agent.session, 'System analysis')
    // The todo list is the model-facing progress surface; map it onto the
    // chip's stage rail for this session only.
    const stopWatching = options.ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId || event.type !== 'todo/write') return
      const stage = stageFromTodos(event.data.todos)
      if (stage !== undefined) request.onStage(stage)
    })
    try {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: SYSTEM_ANALYSIS_PROMPT }],
        source: { kind: 'user' },
      }))
      await turnSettled(handle.agent, signal)
      let outcome = readPublished(options.workspace)
      // One bounded correction: a model that ends the turn without both files
      // gets exactly two more chances before the run reports the failure.
      for (let attempt = 0; attempt < 2 && outcome === undefined; attempt += 1) {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: SYSTEM_ANALYSIS_CORRECTION }],
          source: { kind: 'user' },
        }))
        await turnSettled(handle.agent, signal)
        outcome = readPublished(options.workspace)
      }
      if (outcome === undefined) {
        throw new Error(`the investigation ended without writing ${PROFILE_JSON_FILENAME} and ${PROFILE_DOCUMENT_FILENAME} into its workspace`)
      }
      return outcome
    } finally {
      stopWatching()
    }
  } finally {
    clearTimeout(timer)
    // An aborted run is already being torn down; only a completed turn is
    // worth waiting for before the session is released.
    if (handle !== undefined) await settle(options.ctx, handle, !signal.aborted)
  }
}
