/**
 * enpoi-custom-tools — operator-authored command tools.
 *
 * Reads `enpoi-orchestration.customTools` (the same settings document the
 * Dynamic panel writes) and registers one real harness tool per record under
 * `custom_<id>`, hot-applied on `settings/document-updated` like the other
 * enpoi plugins. Execution renders the command template with every parameter
 * POSIX single-quoted (never raw interpolation) and runs it through the
 * harness shell service under the session's standing sandbox policy. The
 * trusted `DSH_*` overlay (`shellEnv.collect`) rides with the spec exactly like
 * `tool-bash` does, so a portable command template can reference `$DSH_HOME` /
 * `$DSH_PROFILE_DIR` instead of an absolute machine path; the subprocess scrub
 * otherwise strips every `DSH_*` name.
 *
 * Security: the plugin also provides the `customToolCommands` seam, which the
 * enpoi-capabilities `tools/pre-execute` listener uses to feed the rendered
 * command into the SAME policy evaluator bash uses (dangerous verbs, wrappers,
 * interpreters). A destructive match asks or denies per the operator's policy;
 * the tool's own `custom_<id>` permission row defaults to ask. The seam also
 * pins the rendered definition to the trusted session + call + tool identity;
 * execution consumes that single-use snapshot so a hot settings edit cannot
 * make the approved command A run as B. A duplicate/replayed identity is
 * rejected, not overwritten, and stays refused for the bounded rolling window.
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterPropertySpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-settings'
import { readOrchestrationDocument, type SettingsDocumentReader } from 'dsh-enpoi-contracts'
import {
  parseCustomToolRecord,
  recordFingerprint,
  recordIdOf,
  renderCommand,
  toolNameOf,
  type CustomToolRecord,
} from './render.js'

export const name = 'enpoi-custom-tools'
export const inject = ['tools', 'settings', 'shell', 'shellEnv']

export const Config = Schema.object({})

/** Default cooperative budget for one custom-tool command. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Structural view of one shell run result. */
interface ShellRunResultLike {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: { text: string }
  stderr: { text: string }
}

/** Structural view of the shell executor seam. */
interface ShellExecutorLike {
  sandboxMode?: string
  resolve(request: Record<string, unknown>): unknown
  execute(spec: unknown): Promise<{ result(): Promise<ShellRunResultLike> }>
}

/** Structural view of the sandbox policy service. */
interface SandboxPolicyLike {
  resolve(request?: { session?: unknown }): Record<string, unknown>
}

/** Structural view of the shell-env registry's trusted `DSH_*` overlay. */
interface ShellEnvLike {
  collect(execution: unknown): Record<string, string>
}

/** Structural view of one tool execution context. */
interface ToolRunLike {
  agent?: { id?: string; session?: { id?: string; header?: { id?: string } } }
  signal?: AbortSignal
  /** The call identity, used to match the pre-execute policy snapshot. */
  callId?: string | number
}

/** Trusted call identity supplied by the policy guard and the tool runtime. */
export interface CustomToolCallIdentity {
  readonly sessionId?: string
  readonly callId?: string | number
}

/** One pre-execute command snapshot, consumed by the matching execution. */
interface CommandSnapshot {
  readonly toolName: string
  readonly record: CustomToolRecord
  readonly command: string
  readonly key: string
}

/** Stable identity key: session + call + tool; no trusted identity = no key. */
function snapshotKeyOf(toolName: string, identity: CustomToolCallIdentity | undefined): string | undefined {
  if (identity === undefined || identity.sessionId === undefined || identity.sessionId === '' || identity.callId === undefined) return undefined
  return `${identity.sessionId}\u0000${String(identity.callId)}\u0000${toolName}`
}

/** Bound on policy snapshots awaiting execution; oldest entries drop first. */
const MAX_PENDING_SNAPSHOTS = 256

/** Bound on rejected identities (rolling dedupe window); oldest entries drop first. */
const MAX_REJECTED_SNAPSHOTS = 256

/** Why an identity cannot execute; used in the structured refusal. */
type SnapshotRejection = 'duplicate' | 'denied' | 'capacity'

/** The seam enpoi-capabilities reads to guard a custom tool's rendered command. */
export interface CustomToolCommandsSeam {
  /**
   * Render one registered custom tool's command for the policy guard and pin
   * that definition to the trusted session + call + tool identity, so execution
   * uses the same command version the policy saw even if settings hot-apply in
   * between. A duplicate identity is rejected, never overwritten.
   */
  render(toolName: string, args: unknown, identity?: CustomToolCallIdentity): { command: string } | undefined
  /** Drop a snapshot that will never execute (denied/cancelled before dispatch). */
  discard?(toolName: string, identity?: CustomToolCallIdentity): void
}

/** Canonical output schema in author-spec form (nullable fields use oneOf: the registry rejects type arrays). */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string' },
    exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    timedOut: { type: 'boolean' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    error: { type: 'string' },
  },
} as const

/** One canonical custom-tool result. */
interface CustomToolValue {
  command: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  error: string
}

/** Render one custom-tool result honestly: stdout, stderr, exit status, error. */
export function renderCustomToolResult(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const run = value as CustomToolValue
  const lines: string[] = [`custom tool: ${run.command}`]
  if (run.error !== '') lines.push(run.error)
  if (run.stdout !== '') lines.push(run.stdout.trimEnd())
  if (run.stderr !== '') lines.push(`[stderr]\n${run.stderr.trimEnd()}`)
  if (run.timedOut) lines.push(`[timed out after ${String(DEFAULT_TIMEOUT_MS / 1000)}s]`)
  if (run.exitCode !== null) lines.push(`[exit code: ${String(run.exitCode)}]`)
  else if (run.signal !== null) lines.push(`[killed by signal: ${run.signal}]`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Read and parse the `customTools` array from the live orchestration document. */
export function readCustomToolRecords(settings: SettingsDocumentReader | undefined): { records: CustomToolRecord[]; errors: string[] } {
  const document = readOrchestrationDocument(settings)
  const raw = document?.customTools
  if (raw === undefined) return { records: [], errors: [] }
  if (!Array.isArray(raw)) return { records: [], errors: ['customTools must be an array'] }
  const records: CustomToolRecord[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const parsed = parseCustomToolRecord(entry)
    if (parsed.record === undefined) {
      errors.push(parsed.error ?? 'invalid entry')
      continue
    }
    if (seen.has(parsed.record.id)) {
      errors.push(`duplicate tool id "${parsed.record.id}"`)
      continue
    }
    seen.add(parsed.record.id)
    records.push(parsed.record)
  }
  return { records, errors }
}

export function apply(ctx: Context, _config: unknown): void {
  const registered = new Map<string, { dispose: () => void; fingerprint: string }>()
  const live = new Map<string, CustomToolRecord>()
  const pending = new Map<string, CommandSnapshot>()
  const rejected = new Map<string, SnapshotRejection>()
  let warned = ''

  /**
   * Refuse one identity for the rolling dedupe window. The map is bounded by
   * MAX_REJECTED_SNAPSHOTS, so a stream of denied calls evicts the oldest
   * tombstone instead of wedging every future custom tool for the process.
   */
  const rejectSnapshot = (key: string, reason: SnapshotRejection): void => {
    pending.delete(key)
    rejected.delete(key)
    rejected.set(key, reason)
    while (rejected.size > MAX_REJECTED_SNAPSHOTS) {
      const oldest = rejected.keys().next().value
      if (oldest === undefined) break
      rejected.delete(oldest)
    }
  }

  /**
   * Remember one call's frozen command. A duplicate render for the same
   * session+call+tool identity is a replay/corruption signal: reject the
   * identity instead of overwriting the first approved command. The pending
   * entry is removed, so both the original and the duplicate execution refuse.
   * Identity ids are unique per core call contract; a duplicate is not a
   * legitimate retry and gets no new approval in this window.
   */
  const rememberSnapshot = (key: string, snapshot: CommandSnapshot): void => {
    if (rejected.has(key) || pending.has(key)) {
      rejectSnapshot(key, 'duplicate')
      return
    }
    pending.set(key, snapshot)
    while (pending.size > MAX_PENDING_SNAPSHOTS) {
      const oldest = pending.keys().next().value
      if (oldest === undefined) break
      rejectSnapshot(oldest, 'capacity')
    }
  }

  const shell = (): ShellExecutorLike | undefined => ctx.get('shell') as ShellExecutorLike | undefined

  /** Register one record as a real tool. */
  const register = (record: CustomToolRecord): void => {
    const executor = shell()
    if (executor === undefined) return
    const parameters: Record<string, ParameterPropertySpec> = {}
    for (const param of record.params) {
      const required = param.required ? { required: true as const } : {}
      parameters[param.name] = param.type === 'string'
        ? { type: 'string', ...required, description: param.description }
        : param.type === 'number'
          ? { type: 'number', ...required, description: param.description }
          : { type: 'boolean', ...required, description: param.description }
    }
    const definition = defineTool({
      name: toolNameOf(record.id),
      description: record.description,
      parameters,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: renderCustomToolResult,
      },
      isConcurrencySafe: () => true,
      async execute(args: unknown, exec: ToolRunLike): Promise<CustomToolValue> {
        const sessionId = typeof exec.agent?.id === 'string'
          ? exec.agent.id
          : typeof exec.agent?.session?.id === 'string'
            ? exec.agent.session.id
            : typeof exec.agent?.session?.header?.id === 'string' ? exec.agent.session.header.id : undefined
        const key = snapshotKeyOf(toolNameOf(record.id), sessionId === undefined ? undefined : {
          sessionId,
          ...exec.callId === undefined ? {} : { callId: exec.callId },
        })
        const snapshot = key === undefined ? undefined : pending.get(key)
        const rejection = key === undefined ? undefined : rejected.get(key)
        if (key !== undefined) pending.delete(key)
        if (snapshot === undefined || snapshot.toolName !== toolNameOf(record.id) || snapshot.key !== key) {
          return {
            command: '', exitCode: null, signal: null, timedOut: false, stdout: '', stderr: '',
            error: rejection === undefined
              ? `custom tool ${record.id}: no trusted execution snapshot for this call; refusing to run (policy approval and execution must share the same session/call identity)`
              : `custom tool ${record.id}: execution snapshot identity rejected (${rejection}); refusing to run`,
          }
        }
        const active = snapshot.record
        const rendered = { command: snapshot.command }
        const value: CustomToolValue = {
          command: rendered.command,
          exitCode: null,
          signal: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          error: '',
        }
        try {
          const policyService = executor.sandboxMode === undefined
            ? undefined
            : ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
          const policy = policyService?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
          const dshEnv = (ctx.get('shellEnv') as ShellEnvLike | undefined)?.collect(exec)
          const spec = executor.resolve({
            command: rendered.command,
            description: active.name,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            ...exec.signal === undefined ? {} : { signal: exec.signal },
            ...policy === undefined ? {} : { sandboxPolicy: policy },
            ...dshEnv === undefined ? {} : { dshEnv },
          })
          const execution = await executor.execute(spec)
          const result = await execution.result()
          value.exitCode = result.exitCode
          value.signal = result.signal
          value.timedOut = result.timedOut
          value.stdout = result.stdout.text
          value.stderr = result.stderr.text
        } catch (error) {
          value.error = `custom tool ${active.id} could not execute: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
        }
        return value
      },
    })
    const dispose = ctx.tools.register(definition)
    registered.set(record.id, { dispose, fingerprint: recordFingerprint(record) })
  }

  /** Diff the document against the live registrations and apply the delta. */
  const sync = (): void => {
    const { records, errors } = readCustomToolRecords(ctx.get('settings') as SettingsDocumentReader | undefined)
    const errorLine = errors.join('; ')
    if (errorLine !== warned) {
      warned = errorLine
      if (errorLine !== '') process.stderr.write(`[enpoi-custom-tools] skipped invalid records: ${errorLine}\n`)
    }
    const next = new Map(records.map(record => [record.id, record]))
    for (const [id, entry] of registered) {
      const record = next.get(id)
      if (record === undefined || recordFingerprint(record) !== entry.fingerprint) {
        entry.dispose()
        registered.delete(id)
        live.delete(id)
      }
    }
    for (const record of records) {
      if (registered.has(record.id)) continue
      try {
        register(record)
        live.set(record.id, record)
      } catch (error) {
        process.stderr.write(`[enpoi-custom-tools] could not register "${record.id}": ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }

  // The policy guard's seam: enpoi-capabilities renders the command through
  // this to evaluate the SAME danger rules bash uses, before execution.
  ctx.provide('customToolCommands', {
    render(toolName: string, args: unknown, identity?: CustomToolCallIdentity): { command: string } | undefined {
      const id = recordIdOf(toolName)
      if (id === undefined) return undefined
      const record = live.get(id)
      if (record === undefined) return undefined
      const rendered = renderCommand(record, args)
      if (rendered.command === undefined) return undefined
      const key = snapshotKeyOf(toolName, identity)
      if (key !== undefined) rememberSnapshot(key, { toolName, record, command: rendered.command, key })
      return { command: rendered.command }
    },
    discard(toolName: string, identity?: CustomToolCallIdentity): void {
      const key = snapshotKeyOf(toolName, identity)
      if (key !== undefined) rejectSnapshot(key, 'denied')
    },
  } satisfies CustomToolCommandsSeam)

  const onNamespaceChange = ((ns: unknown) => {
    if (String(ns) !== 'enpoi-orchestration') return
    sync()
  }) as (...args: unknown[]) => unknown
  ctx.on('settings/document-updated', onNamespaceChange)
  ctx.on('settings/updated', onNamespaceChange)
  ctx.effect(() => () => {
    for (const entry of registered.values()) entry.dispose()
    registered.clear()
    live.clear()
    pending.clear()
    rejected.clear()
  }, 'enpoi-custom-tools: registered tools')
  sync()
  process.stderr.write('[enpoi-custom-tools] mounted\n')
}
