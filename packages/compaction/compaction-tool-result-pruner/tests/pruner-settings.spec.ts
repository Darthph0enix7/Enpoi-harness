/**
 * Live `parameters.compaction` prune budgets: settings reads, config overlay,
 * and the pruner's use of the effective values.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import ToolResultPruner, {
  applySettingsOverrides,
  resolveConfig,
} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { readPruneSettings } from '@deepseek-ai/dsh-compaction-tool-result-pruner/src/settings.ts'

/** Per-context document holder so a spec can replace the document in place. */
const documents = new WeakMap<Context, { current: Record<string, unknown> }>()

/** Provide (once) one structurally valid `enpoi-orchestration` document. */
function withDocument(ctx: Context, document: Record<string, unknown>): void {
  const existing = documents.get(ctx)
  if (existing !== undefined) {
    existing.current = document
    return
  }
  const holder = { current: document }
  documents.set(ctx, holder)
  ctx.reflect.provide('settings', {
    describe: () => [{ ns: 'enpoi-orchestration', value: holder.current }],
  })
}

function service(ctx: Context): ToolResultPruner {
  return new ToolResultPruner(ctx, { thresholdChars: 50, headChars: 4, tailChars: 3 })
}

const LONG: ContentBlock[] = [{ type: 'text', text: 'x'.repeat(100) }]

describe('prune settings reads', () => {
  it('validates each field independently and reads the compaction group', () => {
    const ctx = new Context()
    expect(readPruneSettings(ctx)).toEqual({})
    withDocument(ctx, {
      parameters: {
        compaction: { pruneThresholdChars: 4096, pruneHeadChars: 2048, pruneTailChars: 512 },
      },
    })
    expect(readPruneSettings(ctx)).toEqual({
      thresholdChars: 4096,
      headChars: 2048,
      tailChars: 512,
    })
    withDocument(ctx, {
      parameters: {
        compaction: { pruneThresholdChars: 0, pruneHeadChars: -1, pruneTailChars: 1.5 },
      },
    })
    expect(readPruneSettings(ctx)).toEqual({})
  })

  it('fails open on a throwing or absent settings service', () => {
    const ctx = new Context()
    ctx.reflect.provide('settings', {
      describe: () => { throw new Error('settings offline') },
    })
    expect(readPruneSettings(ctx)).toEqual({})
  })

  it('overlays settings and ignores a combination that would exceed the threshold', () => {
    const config = resolveConfig({ thresholdChars: 100, headChars: 10, tailChars: 5 })
    expect(applySettingsOverrides(config, {})).toEqual(config)
    const widened = applySettingsOverrides(config, { thresholdChars: 500, headChars: 400, tailChars: 50 })
    expect(widened).toMatchObject({ thresholdChars: 500, headChars: 400, tailChars: 50 })
    // head + marker + tail exceed the threshold: the whole overlay is ignored.
    expect(applySettingsOverrides(config, { thresholdChars: 20, headChars: 10, tailChars: 5 }))
      .toEqual(config)
  })

  it('prunes under the live settings budget instead of the plugin config', () => {
    const ctx = new Context()
    withDocument(ctx, { parameters: { compaction: { pruneThresholdChars: 10_000 } } })
    const pruner = service(ctx)
    expect(pruner.pruneContent(LONG)).toBeNull()

    withDocument(ctx, { parameters: { compaction: { pruneThresholdChars: 60, pruneHeadChars: 10, pruneTailChars: 10 } } })
    const pruned = pruner.pruneContent(LONG)
    expect(pruned).not.toBeNull()
    expect(pruner.measureContent(pruned!)).toBeLessThanOrEqual(60)
  })
})
