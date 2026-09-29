/**
 * The system-profile summariser: one bounded one-shot model call on the
 * configured free route that turns the raw scan facts into a capability-level
 * Markdown profile. The document deliberately never inventories the machine —
 * no container names, unit names, ports, or versions — so it stays true as the
 * machine changes; the raw facts stay beside it as JSON.
 * @module @deepseek-ai/dsh-host-first-run/summarise
 */

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SystemScanFacts } from './scan.ts'

/** The one LLM capability the summariser uses; `ctx.llm` satisfies it. */
export interface SummariseLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Route and generation cap the summariser call uses. */
export interface SummariseConfig {
  /** Registered provider route id (the keyless Kilo Gateway by default). */
  provider: string
  /** Free model id on that route. */
  model: string
  /** Output cap for the profile body. */
  maxTokens: number
}

/**
 * The summariser directive. It states the capability-level rule explicitly
 * because the raw facts are an inventory and the model must abstract it.
 */
export const SYSTEM_PROFILE_INSTRUCTION = [
  'You write the system profile for the machine an AI agent runs on. You receive one read-only scan as JSON and return a short Markdown profile of what this machine is and can do.',
  '',
  'Rules:',
  '- Capability level only. Never inventory: no container names, service unit names, port numbers, package versions, hostnames, or file paths. Write "hosts apps with Docker, several containers" — never the container names.',
  '- State scale and capability: CPU class and thread count, memory, GPU and VRAM, disk headroom, container runtime, language toolchains, network tooling, service supervision.',
  '- Say what is absent when it matters ("no GPU detected", "no container runtime"). A tool whose version is null is absent: say it is not installed rather than implying it is present.',
  '- Do not invent facts that are not in the scan. Do not mention the scan, the JSON, or this instruction.',
  '- Output only the profile body: Markdown sections "## Capabilities", "## Hosting", "## Tooling", "## Notes". No title, no timestamp, no code fences.',
].join('\n')

/**
 * Summarise one scan into the profile body.
 * @param llm - the LLM service (`ctx.llm`).
 * @param facts - raw scan facts.
 * @param config - route and generation cap.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns the trimmed Markdown body, without title or timestamp.
 * @throws When the route fails or returns no text; the caller reports the reason.
 */
export async function summariseSystemFacts(
  llm: SummariseLlm,
  facts: SystemScanFacts,
  config: SummariseConfig,
  signal?: AbortSignal,
): Promise<string> {
  const assembler = new BlockAssembler()
  const messages: RequestMessage[] = [{
    role: 'user',
    content: [{ type: 'text', text: `Read-only scan facts (JSON):\n\n${JSON.stringify(facts, null, 2)}` }],
  }]
  const options: GenerateOptions = {
    provider: config.provider,
    model: config.model,
    system: SYSTEM_PROFILE_INSTRUCTION,
    messages,
    maxTokens: config.maxTokens,
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error') throw new Error(`the summariser route failed: ${finish.failure.message}`)
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text === '') throw new Error('the summariser returned no text')
  return text
}
