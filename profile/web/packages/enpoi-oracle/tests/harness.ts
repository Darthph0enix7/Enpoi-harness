/**
 * Dependency-light harness for the Oracle specs: a fake context with the
 * services the plugin reads, a fake subagent runtime that records spawns and
 * host-delivered prompts, and a mutable child log the wait path reads.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export type TurnEnd = 'completed' | 'error' | 'aborted' | 'max-tokens'

export interface SpawnRecord {
  childId: string
  messageId: string
  label: string
  prompt: string
  persona?: string
  quiet?: boolean
  toolFilter?: unknown
  agentOptions?: Record<string, unknown>
}

export interface PromptRecord {
  childId: string
  messageId: string
  content: string
  source: unknown
}

export interface DeliveryCall {
  kind: 'followup' | 'steer' | 'send'
  message: { source?: { kind?: string }; content: Array<{ text?: string }> }
  target?: string
  wakeup?: boolean
}

/** One fake oracle parent Agent plus the services `oracle_review` consumes. */
export interface OracleHarness {
  readonly ctx: Record<string, unknown>
  readonly parent: Record<string, unknown>
  readonly settings: Record<string, unknown>
  readonly spawns: SpawnRecord[]
  readonly prompts: PromptRecord[]
  readonly deliveries: DeliveryCall[]
  readonly interruptions: Array<{ childId: string; authority: unknown }>
  readonly drained: Array<{ parentId: string; childIds: string[] }>
  readonly emitListeners: (event: string, payload: unknown) => void
  setSettings: (value: Record<string, unknown>) => void
  setParentStatus: (status: 'idle' | 'running') => void
  setLivingBrief: (text: string | null) => void
  pushHuman: (text: string) => number
  seedChild: (childId: string, label: string, mode?: 'continuable' | 'one-shot') => void
  seedPrompt: (childId: string, messageId: string, text: string) => void
  settle: (childId: string, messageId: string, text: string, reason?: TurnEnd) => void
  settleLastSpawn: (text: string, reason?: TurnEnd) => void
  tool: (name?: string) => RegisteredTool
}

/** The subset of a registered tool definition these specs drive. */
export interface RegisteredTool {
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { agent: unknown; signal: AbortSignal }) => Promise<Record<string, unknown>>
}

/** Poll until a harness condition holds (real timers). */
export async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for harness state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Join the text blocks of one prompt. */
export function promptText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Build one isolated harness.
 * @param options - initial orchestration document and human prompt.
 * @returns the fake context, parent Agent, and recording helpers.
 */
export function createOracleHarness(options: {
  settings?: Record<string, unknown>
  parentId?: string
  humanText?: string
  parentStatus?: 'idle' | 'running'
  livingBrief?: string | null
} = {}): OracleHarness {
  const parentId = options.parentId ?? 'parent-1'
  const spawns: SpawnRecord[] = []
  const prompts: PromptRecord[] = []
  const deliveries: DeliveryCall[] = []
  const interruptions: Array<{ childId: string; authority: unknown }> = []
  const drained: Array<{ parentId: string; childIds: string[] }> = []
  const logs = new Map<string, Array<Record<string, unknown>>>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const children: Array<{ id: string; mode: 'continuable' | 'one-shot'; label: string; createdAt: number; seq: number }> = []
  const tools = new Map<string, Record<string, unknown>>()
  const settings: Record<string, unknown> = options.settings ?? { parameters: { oracle: { timeoutMs: 120_000 } } }
  let parentStatus: 'idle' | 'running' = options.parentStatus ?? 'idle'
  let livingBriefText: string | null = options.livingBrief ?? null
  let messageSeq = 0
  let spawnSeq = 0
  let parentEvents: Array<Record<string, unknown>> = []
  let humanSeq = 0

  const emit = (event: string, payload: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(payload)
  }

  const pushHuman = (text: string): number => {
    humanSeq += 1
    parentEvents = [...parentEvents, {
      type: 'user/message',
      seq: humanSeq,
      data: { id: `parent-msg-${humanSeq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    }]
    return humanSeq
  }
  if (options.humanText !== undefined) pushHuman(options.humanText)

  const appendPrompt = (childId: string, messageId: string, content: readonly ContentBlock[]): void => {
    const log = logs.get(childId) ?? []
    log.push({
      type: 'user/message',
      seq: log.length,
      data: { id: messageId, role: 'user', source: { kind: 'user' }, content },
    })
    logs.set(childId, log)
  }

  const settle = (childId: string, messageId: string, text: string, reason: TurnEnd = 'completed'): void => {
    const log = logs.get(childId) ?? []
    log.push({
      type: 'assistant/message',
      seq: log.length,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `assistant-${childId}-${log.length}`,
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'text', text }],
        },
      },
    })
    log.push({
      type: 'turn/end',
      seq: log.length,
      data: {
        turn: 1,
        reason: reason === 'completed'
          ? { kind: 'completed' }
          : reason === 'max-tokens'
            ? { kind: 'max-tokens' }
            : reason === 'aborted'
              ? { kind: 'aborted', reason: { kind: 'user' } }
              : { kind: 'error', error: { message: 'provider exploded', code: 'UNKNOWN' } },
      },
    })
    logs.set(childId, log)
    emit('subagent/end', { id: childId, messageId, stopReason: reason })
  }

  const runtime: Record<PropertyKey, unknown> = {
    [Symbol.for('dsh.subagent.deliverPrompt')]: async (
      _parent: unknown,
      childId: string,
      content: ContentBlock[],
      source: unknown,
    ) => {
      messageSeq += 1
      const messageId = `oracle-msg-${messageSeq}`
      prompts.push({ childId, messageId, content: promptText(content), source })
      appendPrompt(childId, messageId, content)
      return messageId
    },
  }

  const subagents = {
    startContinuable: async (spec: {
      label?: string
      quiet?: boolean
      request: {
        prompt: ContentBlock[]
        persona?: string
        quiet?: boolean
        toolFilter?: unknown
        agentOptions?: Record<string, unknown>
      }
    }) => {
      spawnSeq += 1
      messageSeq += 1
      const childId = `oracle-child-${spawnSeq}`
      const messageId = `oracle-msg-${messageSeq}`
      const label = spec.label ?? ''
      spawns.push({
        childId,
        messageId,
        label,
        prompt: promptText(spec.request.prompt),
        persona: spec.request.persona,
        quiet: spec.request.quiet ?? spec.quiet,
        toolFilter: spec.request.toolFilter,
        agentOptions: spec.request.agentOptions,
      })
      children.push({ id: childId, mode: 'continuable', label, createdAt: spawnSeq, seq: children.length })
      appendPrompt(childId, messageId, spec.request.prompt)
      return { childId, messageId }
    },
    listChildren: async () => [...children],
    interrupt: (childId: string, authority: unknown) => { interruptions.push({ childId, authority }) },
    drainContinuableChildren: async (parent: { session: { id: string } }, childIds: string[]) => {
      drained.push({ parentId: parent.session.id, childIds: [...childIds] })
    },
    sendMessage: async () => { throw new Error('sendMessage is unused in these specs') },
  }

  const parent = {
    session: {
      id: parentId,
      seq: 0,
      header: { cwd: '/workspace/project' },
      snapshotEvents: () => parentEvents,
      append: () => undefined,
    },
    get status() { return parentStatus },
    followup(message: DeliveryCall['message']) { deliveries.push({ kind: 'followup', message }) },
    steer(message: DeliveryCall['message']) { deliveries.push({ kind: 'steer', message }) },
    send(message: DeliveryCall['message'], target: string, wakeup: boolean) {
      deliveries.push({ kind: 'send', message, target, wakeup })
    },
  }

  const agents = { get: (id: string) => (id === parentId ? parent : undefined) }
  const sessionProjections = {
    snapshot: () => ({
      values: livingBriefText === null ? {} : {
        livingBrief: { goal: 'test goal', decisions: [], openThreads: [], prose: { text: livingBriefText }, freshness: 'fresh' },
      },
    }),
  }
  const sessionPersistence = {
    open: async (childId: string) => ({
      read: async () => ({ events: logs.get(childId) ?? [], eventState: 'detached' }),
      close: async () => undefined,
    }),
  }
  const ctx = {
    agents,
    sessionPersistence,
    sessionProjections,
    get: (name: string): unknown => {
      if (name === 'settings') return { get: () => settings }
      if (name === 'agents') return agents
      if (name === 'sessionPersistence') return sessionPersistence
      if (name === 'sessionProjections') return sessionProjections
      return (ctx as Record<string, unknown>)[name]
    },
    on: (event: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => { set.delete(listener) }
    },
    inject: (_names: unknown, callback: (scope: unknown) => void) => { callback(ctx); return () => undefined },
    tools: {
      register: (definition: { name: string } & Record<string, unknown>) => { tools.set(definition.name, definition) },
    },
    subagents: Object.assign(runtime, subagents),
    logger: { warn: () => undefined, info: () => undefined },
  }

  return {
    ctx,
    parent,
    settings,
    spawns,
    prompts,
    deliveries,
    interruptions,
    drained,
    emitListeners: emit,
    setSettings: (value) => {
      for (const key of Object.keys(settings)) delete settings[key]
      Object.assign(settings, value)
    },
    setParentStatus: (status) => { parentStatus = status },
    setLivingBrief: (text) => { livingBriefText = text },
    pushHuman,
    seedChild: (childId, label, mode = 'continuable') => {
      children.push({ id: childId, mode, label, createdAt: children.length, seq: children.length })
    },
    seedPrompt: (childId, messageId, text) => { appendPrompt(childId, messageId, [{ type: 'text', text }]) },
    settle,
    settleLastSpawn: (text, reason) => {
      const last = spawns[spawns.length - 1]
      if (last === undefined) throw new Error('no spawn to settle')
      settle(last.childId, last.messageId, text, reason)
    },
    tool: (name = 'oracle_review') => {
      const definition = tools.get(name)
      if (definition === undefined) throw new Error(`tool ${name} is not registered`)
      return definition as unknown as RegisteredTool
    },
  }
}
