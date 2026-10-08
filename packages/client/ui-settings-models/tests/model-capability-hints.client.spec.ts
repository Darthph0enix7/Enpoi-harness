/**
 * Client half of the shared capability-hint table.
 *
 * The provider detail panel loads `model-capability-hints.generated.ts`, the
 * mirror generated from the sync package's `model-capability-hints.json`
 * (`scripts/write-client-mirror.mjs`). The sync package's
 * `tests/capability-hints.spec.ts` pins the committed fixture to the shipped
 * table; this spec pins the generated module to that same fixture and
 * guards the operands against drifting back into hand-maintained source.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { MODEL_CAPABILITY_HINTS } from '../src/client/model-capability-hints.generated.ts'
import { idCapabilityHints } from '../src/client/capability-hints.ts'

const here = dirname(fileURLToPath(import.meta.url))

it('the generated module equals the committed client-mirror fixture', () => {
  const fixture: unknown = JSON.parse(readFileSync(join(here, 'expected', 'model-capability-hints.json'), 'utf8'))
  expect({ version: 1, ...MODEL_CAPABILITY_HINTS }).toEqual(fixture)
})

it('resolves hinted capabilities from the shared table', () => {
  expect(idCapabilityHints('zzz-internvl-model')).toEqual({ input: ['image'], reasoning: false, toolsExcluded: false })
  expect(idCapabilityHints('zzz-omen-alpha-model')).toEqual({ input: [], reasoning: true, toolsExcluded: false })
  // The union table keeps both operands: `gpt-5` suggests image and document
  // input, and its reasoning operand is the one the sync table contributed.
  expect(idCapabilityHints('openai/gpt-5-mini')).toEqual({ input: ['image', 'pdf'], reasoning: true, toolsExcluded: false })
  expect(idCapabilityHints('zzz-mystery-endpoint-model-77')).toEqual({ input: [], reasoning: false, toolsExcluded: false })
  expect(idCapabilityHints('zzz-reward-model')).toMatchObject({ toolsExcluded: true })
})

it('keeps the heuristic operands in the shared table, not duplicated in the twin sources', () => {
  const panel = readFileSync(join(here, '../src/client/ProviderDetailPanel.tsx'), 'utf8')
  const sync = readFileSync(join(here, '../../../../profile/web/packages/enpoi-provider-sync/src/index.ts'), 'utf8')
  for (const operand of [
    'flash-tiered', 'space-bunny', 'omen-alpha', 'whisper', 'qwen3.8-vl', 'internvl', 'llava',
    'glm-5v', 'deepseek-r', 'longcat', 'text-01', 'dall-e',
  ]) {
    expect(panel, `ProviderDetailPanel.tsx still carries "${operand}"`).not.toContain(`'${operand}'`)
    expect(sync, `provider-sync still carries "${operand}"`).not.toContain(`'${operand}'`)
  }
})
