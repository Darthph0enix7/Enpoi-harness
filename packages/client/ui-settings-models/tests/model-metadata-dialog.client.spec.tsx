// @vitest-environment jsdom
/** The model-metadata dialog drafts every curated field and writes only on Save. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelMetadataDialog } from '../src/client/ModelMetadataDialog.tsx'
import type { ModelMetadataSaveRequest } from '../src/client/ModelMetadataDialog.tsx'
import { en } from '../src/client/locales.ts'
import { translateEn } from './translate.client.ts'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'clipboard')
})

const t = translateEn

/** One stored pi-ai row with every editable field populated. */
const MODEL = {
  id: 'gateway/alpha',
  name: 'Alpha',
  contextWindow: 128_000,
  maxInputTokens: 120_000,
  maxTokens: 8_192,
  input: ['text', 'image'],
  tools: true,
  reasoning: true,
  reasoningEfforts: { low: 'low', high: 'high' },
  cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
  releaseDate: '2026-01-02',
  costTiers: [{ inputTokensAbove: 200_000, input: 0.54, output: 2.2 }],
  compat: { supportsStrictTools: true },
  nativeFileInputs: { version: 1, encoder: 'native', mime: ['application/pdf'] },
}

function dialog(overrides: Partial<Parameters<typeof ModelMetadataDialog>[0]> = {}) {
  const onSave = vi.fn(async (_request: ModelMetadataSaveRequest): Promise<string | undefined> => undefined)
  const onClose = vi.fn()
  const props: Parameters<typeof ModelMetadataDialog>[0] = {
    providerId: 'gateway',
    modelId: 'gateway/alpha',
    kind: 'pi-ai-models',
    model: MODEL,
    readOnly: false,
    t,
    onClose,
    onSave,
    ...overrides,
  }
  render(<ModelMetadataDialog {...props} />)
  return { onSave, onClose }
}

describe('model metadata dialog', () => {
  it('shows basic fields and writes nothing until Save', () => {
    const { onSave, onClose } = dialog()

    expect(screen.getByRole('dialog', { name: en.metadataDialogTitle })).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.modelId).value).toBe(MODEL.id)
    expect(screen.getByLabelText<HTMLInputElement>(en.modelName).value).toBe(MODEL.name)
    expect(screen.getByLabelText<HTMLInputElement>(en.metadataContextWindow).value).toBe('128000')
    expect(screen.getByLabelText<HTMLInputElement>(en.metadataMaxInputTokens).value).toBe('120000')
    expect(screen.getByLabelText<HTMLInputElement>(en.metadataMaxTokens).value).toBe('8192')
    expect(screen.getByText(en.metadataIdChangeHint)).toBeTruthy()
    expect(screen.getByText(en.metadataNameHint)).toBeTruthy()

    const save = screen.getByRole<HTMLButtonElement>('button', { name: en.save })
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    // Details stay collapsed until asked for.
    const details = screen.getByText(en.metadataDetails).closest('details')
    expect(details?.open).toBe(false)
    fireEvent.click(screen.getByText(en.metadataDetails))
    expect(details?.open).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.metadataReleaseDate).value).toBe('2026-01-02')
    // Deployment-only fields are stated, never round-tripped through a JSON
    // textarea that could rewrite them.
    expect(screen.getByText(
      en.metadataPreservedFields.replace('{fields}', 'compat, nativeFileInputs'),
    )).toBeTruthy()
  })

  it('saves a changed display name once and closes on success', async () => {
    const { onSave, onClose } = dialog()
    fireEvent.change(screen.getByLabelText(en.modelName), { target: { value: 'Alpha Two' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1) })
    const request = onSave.mock.calls[0]?.[0]
    expect(request?.draft.name).toBe('Alpha Two')
    expect(request?.draft.id).toBe(MODEL.id)
    expect(request?.baselineDraft.name).toBe(MODEL.name)
    expect(request?.baselineDraft).not.toBe(request?.draft)
    expect(request?.resetFields).toEqual([])
    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1) })
  })

  it('rejects negative, fractional, and unreadable capacities before writing', async () => {
    const { onSave } = dialog()
    const context = screen.getByLabelText<HTMLInputElement>(en.metadataContextWindow)
    for (const value of ['-1', '1.5', 'not-a-number']) {
      fireEvent.change(context, { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: en.save }))
      await Promise.resolve()
      expect(onSave).not.toHaveBeenCalled()
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
    }
  })

  it('accepts a zero price and keeps an unknown price blank', async () => {
    const { onSave } = dialog({ model: { ...MODEL, costTiers: [] } })
    fireEvent.click(screen.getByText(en.metadataDetails))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.metadataInputPrice), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText<HTMLInputElement>(en.metadataOutputPrice), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText(en.modelName), { target: { value: 'Priced' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1) })
    const draft = onSave.mock.calls[0]?.[0].draft
    expect(draft?.inputPrice).toBe('0')
    expect(draft?.outputPrice).toBe('')
  })

  it('keeps a catalog ID read-only with its explanation and copies it', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    dialog({ kind: 'pi-ai-catalog' })

    const id = screen.getByLabelText<HTMLInputElement>(en.modelId)
    expect(id.readOnly).toBe(true)
    expect(screen.getByText(en.metadataIdReadonly)).toBeTruthy()
    expect(screen.queryByText(en.metadataIdChangeHint)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.metadataCopyId }))
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(MODEL.id) })
  })

  it('lets a materialized row change its ID and states the separate-entry rule', async () => {
    const { onSave } = dialog()
    const id = screen.getByLabelText<HTMLInputElement>(en.modelId)
    expect(id.readOnly).toBe(false)
    expect(screen.getByText(en.metadataIdChangeHint)).toBeTruthy()

    fireEvent.change(id, { target: { value: 'gateway/beta' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1) })
    expect(onSave.mock.calls[0]?.[0].draft.id).toBe('gateway/beta')
    expect(onSave.mock.calls[0]?.[0].resetFields).toEqual([])
  })

  it('resets only reported overrides and sends the reset target with the draft', async () => {
    const { onSave } = dialog({ manualFields: ['name', 'contextWindow'] })

    expect(screen.queryByRole('button', {
      name: en.metadataResetField.replace('{field}', en.metadataMaxTokens),
    })).toBeNull()

    fireEvent.click(screen.getByRole('button', {
      name: en.metadataResetField.replace('{field}', en.modelName),
    }))
    expect(screen.getByLabelText<HTMLInputElement>(en.modelName).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: en.metadataResetAll }))
    expect(screen.getByLabelText<HTMLInputElement>(en.metadataContextWindow).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1) })
    const request = onSave.mock.calls[0]?.[0]
    expect(request?.draft.name).toBe('')
    expect(request?.draft.contextWindow).toBe('')
    expect([...(request?.resetFields ?? [])].sort()).toEqual(['contextWindow', 'name'])
  })

  it('disables every control in a read-only deployment, including reset actions', () => {
    dialog({ readOnly: true, manualFields: ['name'] })
    expect(screen.getByLabelText<HTMLInputElement>(en.modelName).disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>(en.metadataContextWindow).disabled).toBe(true)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', {
      name: en.metadataResetField.replace('{field}', en.modelName),
    }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.metadataResetAll }).disabled).toBe(true)
  })

  it('localizes an unsupported modality refusal instead of showing the helper code', async () => {
    const onSave = vi.fn(async (_request: ModelMetadataSaveRequest): Promise<string | undefined> => undefined)
    render(<ModelMetadataDialog
      providerId="deepseek"
      modelId="legacy"
      kind="deepseek"
      model={{ id: 'legacy', name: 'Legacy', inputModalities: ['audio'] }}
      readOnly={false}
      t={t}
      onClose={vi.fn()}
      onSave={onSave}
    />)
    fireEvent.change(screen.getByLabelText(en.modelName), { target: { value: 'Legacy Two' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await Promise.resolve()
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(en.metadataReasonModality)).toBeTruthy()
    expect(screen.queryByText('invalidModality')).toBeNull()
  })

  it('hides DeepSeek-unsupported pricing and capability controls but keeps its preserved fields', () => {
    dialog({
      kind: 'deepseek',
      model: {
        id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128_000, maxTokens: 8_192,
        inputModalities: ['text', 'image'],
        compat: { supportsStrictTools: true },
      },
    })
    fireEvent.click(screen.getByText(en.metadataDetails))

    expect(screen.queryByText(en.metadataPricing)).toBeNull()
    expect(screen.queryByLabelText(en.metadataMaxInputTokens)).toBeNull()
    expect(screen.queryByText(en.metadataTools)).toBeNull()
    expect(screen.queryByText(en.metadataReasoning)).toBeNull()
    expect(screen.queryByLabelText(en.metadataReleaseDate)).toBeNull()
    expect(screen.queryByRole('checkbox', { name: en.modelInputAudio })).toBeNull()
    const image = screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage })
    expect(image.checked).toBe(true)
    fireEvent.click(image)
    expect(image.checked).toBe(false)
    expect(screen.getByText(en.metadataPreservedFields.replace('{fields}', 'compat'))).toBeTruthy()
  })

  it('keeps the dialog open with the fenced failure when the panel refuses the write', async () => {
    const onSave = vi.fn(async (): Promise<string | undefined> => 'another change moved the document')
    const onClose = vi.fn()
    render(<ModelMetadataDialog
      providerId="gateway"
      modelId="gateway/alpha"
      kind="pi-ai-models"
      model={MODEL}
      readOnly={false}
      t={t}
      onClose={onClose}
      onSave={onSave}
    />)
    fireEvent.change(screen.getByLabelText(en.modelName), { target: { value: 'Alpha Two' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect((await screen.findByRole('alert')).textContent).toContain('another change moved the document')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('model metadata dialog coverage of curated controls', () => {
  it('renders inherited catalog values as placeholders and read-only hints', () => {
    dialog({
      kind: 'pi-ai-catalog',
      model: { id: 'catalog-a' },
      inherited: {
        id: 'catalog-a',
        name: 'Catalog Name',
        contextWindow: 64_000,
        maxInputTokens: 60_000,
        maxTokens: 4_000,
        input: ['text', 'image'],
        tools: true,
        reasoning: false,
        reasoningEfforts: { low: 'low' },
        releaseDate: '2026-01-03',
        cost: { input: 0.2, output: 0.4, cache_read: 0.1, cache_write: 0.2 },
        costTiers: [{ inputTokensAbove: 200_000, input: 1, output: 2 }],
      },
    })
    expect(screen.getByLabelText<HTMLInputElement>(en.modelName).placeholder).toBe('Catalog Name')
    expect(screen.getByLabelText<HTMLInputElement>(en.metadataContextWindow).placeholder).toBe('64000')
    expect(screen.getByLabelText<HTMLInputElement>(en.metadataMaxInputTokens).placeholder).toBe('60000')
    expect(screen.getByLabelText<HTMLInputElement>(en.metadataMaxTokens).placeholder).toBe('4000')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.modelInputImage }).checked).toBe(true)

    fireEvent.click(screen.getByText(en.metadataDetails))
    expect(screen.getByLabelText<HTMLTextAreaElement>(en.metadataReasoningEfforts).placeholder).toBe('low=low')
    expect(screen.getByText(en.metadataInheritedValue.replace('{value}', en.metadataYes))).toBeTruthy()
    expect(screen.getByText(en.metadataInheritedValue.replace('{value}', en.metadataNo))).toBeTruthy()
    expect(screen.getByText(en.metadataInheritedValue.replace('{value}', '2026-01-03'))).toBeTruthy()
    expect(screen.getByText(en.metadataInheritedTiers.replace('{count}', '1'))).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>(en.metadataInputPrice).placeholder).toBe('0.2')
  })

  it('resets every override group and clears the reset when that field is edited again', async () => {
    const { onSave } = dialog({
      manualFields: [
        'name', 'contextWindow', 'maxInputTokens', 'maxTokens', 'input', 'tools',
        'reasoning', 'reasoningEfforts', 'cost', 'costTiers', 'releaseDate',
      ],
    })
    fireEvent.click(screen.getByText(en.metadataDetails))
    const resetButtons: Array<[string, string]> = [
      [en.modelName, en.modelName],
      [en.metadataContextWindow, en.metadataContextWindow],
      [en.metadataMaxInputTokens, en.metadataMaxInputTokens],
      [en.metadataMaxTokens, en.metadataMaxTokens],
      [en.modelInputTypes, en.modelInputTypes],
      [en.metadataTools, en.metadataTools],
      [en.metadataReasoning, en.metadataReasoning],
      [en.metadataReasoningEfforts, en.metadataReasoningEfforts],
      [en.metadataReleaseDate, en.metadataReleaseDate],
      [en.metadataPricing, en.metadataPricing],
      [en.metadataPricingTiers, en.metadataPricingTiers],
    ]
    for (const [fieldLabel] of resetButtons) {
      fireEvent.click(screen.getByRole('button', {
        name: en.metadataResetField.replace('{field}', fieldLabel),
      }))
    }
    // Editing a reset field removes its pending reset again; reset it once
    // more so the save request still states the operator's intent.
    fireEvent.change(screen.getByLabelText(en.metadataInputPrice), { target: { value: '0.5' } })
    fireEvent.change(screen.getByLabelText(en.metadataReleaseDate), { target: { value: '2026-03-03' } })
    for (const [fieldLabel] of resetButtons) {
      const button = screen.queryByRole('button', {
        name: en.metadataResetField.replace('{field}', fieldLabel),
      })
      if (button !== null) fireEvent.click(button)
    }
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1) })
    const request = onSave.mock.calls[0]?.[0]
    expect([...(request?.resetFields ?? [])].sort()).toEqual([
      'contextWindow', 'cost', 'costTiers', 'input', 'maxInputTokens', 'maxTokens',
      'name', 'reasoning', 'reasoningEfforts', 'releaseDate', 'tools',
    ])
  })

  it('resets all overrides in one action', async () => {
    const { onSave } = dialog({
      manualFields: [
        'name', 'contextWindow', 'maxInputTokens', 'maxTokens', 'input', 'tools',
        'reasoning', 'reasoningEfforts', 'cost', 'costTiers', 'releaseDate',
      ],
    })
    fireEvent.click(screen.getByRole('button', { name: en.metadataResetAll }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1) })
    const request = onSave.mock.calls[0]?.[0]
    expect([...(request?.resetFields ?? [])].sort()).toEqual([
      'contextWindow', 'cost', 'costTiers', 'input', 'maxInputTokens', 'maxTokens',
      'name', 'reasoning', 'reasoningEfforts', 'releaseDate', 'tools',
    ])
    expect(request?.draft.input).toEqual([])
    expect(request?.draft.tools).toBe('inherit')
    expect(request?.draft.reasoning).toBe('inherit')
    expect(request?.draft.inputPrice).toBe('')
    expect(request?.draft.pricingTiers).toEqual([])
  })

  it('edits every details control and both actions on a pricing tier', async () => {
    const { onSave } = dialog({
      model: {
        ...MODEL,
        costTiers: [
          { inputTokensAbove: 200_000, input: 0.54, output: 2.2 },
          { inputTokensAbove: 300_000, input: 0.8, output: 3 },
        ],
      },
    })
    fireEvent.click(screen.getByText(en.metadataDetails))
    fireEvent.click(screen.getByRole('checkbox', { name: en.modelInputImage }))
    fireEvent.change(screen.getByLabelText(en.metadataTools), { target: { value: 'no' } })
    fireEvent.change(screen.getByLabelText(en.metadataReasoning), { target: { value: 'no' } })
    fireEvent.change(screen.getByLabelText(en.metadataReasoningEfforts), { target: { value: 'high=high' } })
    fireEvent.change(screen.getByLabelText(en.metadataReleaseDate), { target: { value: '2026-04-04' } })
    fireEvent.change(screen.getByLabelText(en.metadataInputPrice), { target: { value: '0.3' } })
    fireEvent.change(screen.getByLabelText(en.metadataOutputPrice), { target: { value: '0.6' } })
    fireEvent.change(screen.getByLabelText(en.metadataCacheReadPrice), { target: { value: '0.1' } })
    fireEvent.change(screen.getByLabelText(en.metadataCacheWritePrice), { target: { value: '0.2' } })

    const thresholds = screen.getAllByLabelText<HTMLInputElement>(en.metadataTierAbove)
    fireEvent.change(thresholds[0]!, { target: { value: '210000' } })
    fireEvent.click(screen.getByRole('button', { name: en.metadataAddTier }))
    const addedThresholds = screen.getAllByLabelText<HTMLInputElement>(en.metadataTierAbove)
    fireEvent.change(addedThresholds[2]!, { target: { value: '400000' } })
    const addedInputs = screen.getAllByLabelText<HTMLInputElement>(en.metadataTierInput)
    fireEvent.change(addedInputs[2]!, { target: { value: '1' } })
    const addedOutputs = screen.getAllByLabelText<HTMLInputElement>(en.metadataTierOutput)
    fireEvent.change(addedOutputs[2]!, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: en.metadataRemoveTier.replace('{index}', '3') }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => { expect(onSave).toHaveBeenCalledTimes(1) })
    const request = onSave.mock.calls[0]?.[0]
    expect(request?.draft.tools).toBe('no')
    expect(request?.draft.reasoning).toBe('no')
    expect(request?.draft.reasoningEfforts).toBe('high=high')
    expect(request?.draft.releaseDate).toBe('2026-04-04')
    expect(request?.draft.input).toEqual(['text'])
    expect(request?.draft.pricingTiers).toHaveLength(2)
  })

  it('keeps an unreadable clipboard silent and reports a successful copy', async () => {
    const rejected = vi.fn(async () => { throw new Error('denied') })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: rejected } })
    dialog()
    fireEvent.click(screen.getByRole('button', { name: en.metadataCopyId }))
    await waitFor(() => { expect(rejected).toHaveBeenCalled() })
    expect(screen.getByRole('button', { name: en.metadataCopyId }).title).toBe(en.metadataCopyId)
  })

  it('ignores a close command while saving and closes once the write settles', async () => {
    const pending = Promise.withResolvers<string | undefined>()
    const { onClose } = dialog({ onSave: () => pending.promise })
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByLabelText(en.modelName), { target: { value: 'Pending' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => { pending.resolve(undefined) })
    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(2) })
  })

  it('reports both Error and non-Error save rejections locally', async () => {
    const first = dialog({
      onSave: async () => { throw new Error('boom') },
    })
    fireEvent.change(screen.getByLabelText(en.modelName), { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect((await screen.findByRole('alert')).textContent).toContain('boom')
    first.onClose.mockClear()

    cleanup()
    dialog({
      onSave: async () => { throw 'plain failure' },
    })
    fireEvent.change(screen.getByLabelText(en.modelName), { target: { value: 'B' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect((await screen.findByRole('alert')).textContent).toContain('plain failure')
  })

  it('marks an invalid ID and an incomplete pricing tier at their fields', async () => {
    const invalidId = dialog({ model: { id: '__proto__', name: 'Bad' } })
    fireEvent.change(screen.getByLabelText(en.modelName), { target: { value: 'Bad Two' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(await screen.findByText(en.metadataReasonId)).toBeTruthy()
    expect(invalidId.onSave).not.toHaveBeenCalled()

    cleanup()
    const invalidTier = dialog({ model: { id: 'm', name: 'M' } })
    fireEvent.click(screen.getByText(en.metadataDetails))
    fireEvent.change(screen.getByLabelText(en.metadataInputPrice), { target: { value: '-1' } })
    fireEvent.click(screen.getByRole('button', { name: en.metadataAddTier }))
    fireEvent.change(screen.getByLabelText(en.metadataTierOutput), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(await screen.findByText(en.metadataReasonNonNegative)).toBeTruthy()
    expect(screen.getByText(en.metadataReasonRequired)).toBeTruthy()
    expect(invalidTier.onSave).not.toHaveBeenCalled()

    cleanup()
    dialog()
    fireEvent.click(screen.getByText(en.metadataDetails))
    fireEvent.change(screen.getByLabelText(en.metadataReasoningEfforts), {
      target: { value: 'not-a-ladder' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(await screen.findByText(en.metadataReasonEfforts)).toBeTruthy()

    cleanup()
    dialog({ model: { id: 'm', name: 'M', releaseDate: 'not-a-date' } })
    fireEvent.change(screen.getByLabelText(en.modelName), { target: { value: 'M Three' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(await screen.findByText(en.metadataReasonDate)).toBeTruthy()
  })

  it('shows the inherited not-supported direction and omits sync-only fields', () => {
    dialog({
      kind: 'pi-ai-catalog',
      model: { id: 'catalog-b', gated: true, capabilityHints: { reasoning: true } },
      inherited: { id: 'catalog-b', tools: false, reasoning: true },
    })
    fireEvent.click(screen.getByText(en.metadataDetails))
    expect(screen.getByText(en.metadataInheritedValue.replace('{value}', en.metadataNo))).toBeTruthy()
    expect(screen.getByText(en.metadataInheritedValue.replace('{value}', en.metadataYes))).toBeTruthy()
    expect(screen.queryByText(en.metadataPreservedFields.replace('{fields}', 'gated'))).toBeNull()
    expect(screen.queryByText(/gated|capabilityHints/)).toBeNull()
  })
})
