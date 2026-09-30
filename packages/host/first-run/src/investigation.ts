/**
 * The sysadmin investigation behind the system analysis. Instead of a fixed
 * host-side probe list, one bounded agent session on the configured preset
 * investigates the machine read-only with the harness's own tools over a fixed
 * checklist, announces each checklist section through its todo list, and
 * writes the finished general profile — a structured JSON summary plus a short
 * Markdown document — into a scratch workspace the run owns. The durable
 * writes and the decision belong to the runner; this module owns the session,
 * the prompt, the stage mapping, the specificity check, and the time bound.
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
  'machine', 'usage', 'hosting', 'networking', 'tooling', 'writing profile',
] as const

/** One stage name from {@link INVESTIGATION_STAGES}. */
export type InvestigationStage = typeof INVESTIGATION_STAGES[number]

/** The finished investigation as the runner consumes it. */
export interface InvestigationOutcome {
  /** Structured profile; the exact keys are {@link REQUIRED_PROFILE_KEYS}. */
  readonly profile: JsonValue
  /** General Markdown profile body. */
  readonly document: string
}

/** Top-level keys the structured profile must carry. */
export const REQUIRED_PROFILE_KEYS = [
  'hostKind', 'purpose', 'hardware', 'usage', 'hosting', 'networking', 'tooling',
] as const

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
  'Investigate this machine read-only and produce a general system profile. You are the sysadmin agent, and this is one bounded, commissioned investigation. The profile must stay useful as the machine changes: describe what kind of machine this is and what it is for, not a snapshot inventory of what happens to run today.',
  '',
  'Read-only means: do not change anything outside your working directory. Run only non-mutating host commands, each bounded with a timeout, and never read secrets (credentials, keys, .env contents, shell histories). The only files you write are the two profile files named below, inside your working directory.',
  '',
  'Keep a todo list with `todo_write` that holds exactly these items, in this order, and mark each one `in_progress` as you start it and `completed` as you finish it:',
  '`machine`, `usage`, `hosting`, `networking`, `tooling`, `write profile`.',
  'The operator watches that list as the run\'s progress.',
  '',
  'Work section by section and cover every section. A few broad commands per section are enough, and the whole investigation should take about a dozen commands; prefer one grouped command over several narrow ones:',
  '',
  '1. `machine` — what kind of machine this is: server, desktop, laptop, vm, or other; virtualization or container hints; a graphical session (X11/Wayland); battery or power supply; package manager. Hardware in classes: CPU class and thread count, memory size class, GPU presence and class (or an explicit absence), disk type and roughly how much room is left.',
  '2. `usage` — what the user does with this machine, in general terms: programs or develops software (language runtimes, editors and IDEs, repositories), hosts services, runs AI experiments or local models, keeps personal media, games or does not.',
  '3. `hosting` — what this machine serves, as categories only: containerized services, reverse-proxied web services, a VPN mesh, tunnels to the outside. State which categories are in use, never which projects, containers, ports, or domains.',
  '4. `networking` — how the machine reaches the network, in general terms: a VPN mesh, outbound tunnels, remote access, DNS or proxy tooling. No addresses, domains, or hostnames.',
  '5. `tooling` — the general tooling and interests: language runtimes, GPU or AI toolchains, databases, build chains, editors and terminals. Confirm an accelerator through the paths that exist on this machine (the driver command, the system binary, the language runtime) before recording it present or absent.',
  '6. `write profile` — write both files described below.',
  '',
  'Generalization rules for everything you publish:',
  '- No exact version numbers, no exact folder, repository, or project names, no domains, no IP addresses, no hostnames, no port numbers, and no container or service names.',
  '- Never enumerate an inventory; describe categories, roles, and rough sizes, enough for a new maintainer to understand the machine.',
  '- Hardware is the exception: class-level hardware facts are wanted, because hardware does not change often.',
  '- Base every claim on what you actually observed. When a probe fails, note what was unavailable in general terms or leave it out; never invent a fact, and never pad the document with the probes themselves.',
  '- Keep the document stable: it should read the same after a reboot or a new container, so an operator rarely has to regenerate it.',
  '',
  'When every section is done, write both files in your working directory with the `write` tool:',
  `- \`${PROFILE_JSON_FILENAME}\`: the structured JSON profile, an object with the top-level keys ${REQUIRED_PROFILE_KEYS.map(key => `\`${key}\``).join(', ')}.`,
  '  `hostKind` is one of server, desktop, laptop, vm, other. `purpose` is one short line on what the machine is for. `hardware` carries `cpu`, `memory`, `gpu`, `disk` as short class-level single-line strings (for example "server-class x86-64, high core count" or "memory in the tens of GiB"). `usage`, `hosting`, `networking`, and `tooling` are objects holding short general statements or booleans under the categories above.',
  `- \`${PROFILE_DOCUMENT_FILENAME}\`: the Markdown profile body, around 60 to 120 lines. Open with \`## At a glance\` — the machine kind and its purpose in a few lines — then \`## Hardware\`, \`## Usage & purpose\`, \`## Hosting & services\`, \`## Networking\`, \`## Tooling & interests\`, and \`## Notes & limitations\`. Keep every section short and consistent with the JSON profile.`,
  '',
  'Then stop immediately: call no further tools and reply with one short confirmation sentence.',
].join('\n')

/** The one corrective message when a turn ended without a complete profile. */
export const SYSTEM_ANALYSIS_CORRECTION = [
  'The investigation turn ended before the profile was complete.',
  `Write both files in your working directory with the write tool: \`${PROFILE_JSON_FILENAME}\` (an object with the top-level keys ${REQUIRED_PROFILE_KEYS.join(', ')}) and \`${PROFILE_DOCUMENT_FILENAME}\` (the general Markdown body with all sections, no version numbers, folder or project names, domains, addresses, or hostnames).`,
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
  if (typeof record['purpose'] !== 'string') return false
  return REQUIRED_PROFILE_KEYS
    .filter(key => key !== 'hostKind' && key !== 'purpose')
    .every((key) => {
      const member = record[key]
      return typeof member === 'object' && member !== null && !Array.isArray(member)
    })
}

/** Kinds of unnecessary specificity a generalized document must not carry. */
export type DocumentViolationKind = 'IPv4 address' | 'version number' | 'domain-like string'

/** One forbidden specificity found in a published document. */
export interface DocumentViolation {
  readonly kind: DocumentViolationKind
  readonly match: string
}

/** One bare IPv4 address. */
const IPV4_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}\b/gu

/** One dotted version number such as `12.8` or `24.04.1`. */
const VERSION_PATTERN = /\b\d+\.\d+(?:\.\d+)*\b/gu

/** Top-level labels that make a dotted string read as a domain. */
const DOMAIN_TLDS = [
  'com|net|org|io|ai|app|dev|cloud|vip|xyz|me|sh|gg|co|info|biz',
  'online|site|tech|store|pro|link|live|world|space|fun|club',
  'local|internal|lan',
].join('|')

/**
 * One domain-like string. File extensions such as `.md` or `.json` and
 * relative paths do not qualify; a real top-level label does.
 */
const DOMAIN_PATTERN = new RegExp(
  `(?<![a-z0-9-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${DOMAIN_TLDS})\\b`,
  'giu',
)

/**
 * Find the exact machine facts a generalized profile must not publish: IP
 * addresses, dotted version numbers, and domain-like strings. The runner warns
 * with the matched facts before publishing; the tests hold documents against
 * the same rules.
 * @param document - the Markdown profile body, or the whole stored document.
 * @returns one entry per distinct match, empty for a generalized document.
 */
export function documentViolations(document: string): DocumentViolation[] {
  const found: DocumentViolation[] = []
  const collect = (kind: DocumentViolationKind, pattern: RegExp): void => {
    for (const match of document.matchAll(pattern)) {
      const matchText = match[0]
      if (!found.some(entry => entry.kind === kind && entry.match === matchText)) {
        found.push({ kind, match: matchText })
      }
    }
  }
  collect('IPv4 address', IPV4_PATTERN)
  collect('version number', VERSION_PATTERN)
  collect('domain-like string', DOMAIN_PATTERN)
  return found
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
      // A document that leaked exact machine facts still publishes — the
      // analysis is advisory and never fatal — but the operator gets the
      // matched facts so the profile can be corrected or regenerated.
      const violations = documentViolations(outcome.document)
      if (violations.length > 0) {
        options.ctx.logger.warn(
          'first-run: the investigation published exact machine facts: %s',
          violations.map(entry => `${entry.kind} "${entry.match}"`).join(', '),
        )
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
