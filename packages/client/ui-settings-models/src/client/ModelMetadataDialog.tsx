/**
 * One model's editable metadata, shared by the pi-ai catalog and the direct
 * DeepSeek catalog.
 *
 * The dialog only drafts: opening it writes nothing, Cancel discards, and Save
 * hands the draft to the owning panel, which performs one revision-fenced
 * write. The model ID is the settings and session identity — a changed ID adds
 * a separate entry and never renames the old row — so a catalog-derived row
 * keeps its ID read-only and only a materialized row may move it.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconCopyOutlineRegular, IconRefreshOutlineRegular, Modal, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ModelMetadataDraft, ModelMetadataKind, ModelMetadataValidationIssue,
} from './model-metadata.ts'
import { metadataDraftOf, validateMetadataDraft } from './model-metadata.ts'
import { ModelInputTypes } from './ModelInputTypes.tsx'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The materialized tier array `metadataDraftOf` always returns. */
function draftTiers(draft: ModelMetadataDraft): NonNullable<ModelMetadataDraft['pricingTiers']> {
  return draft.pricingTiers as NonNullable<ModelMetadataDraft['pricingTiers']>
}

/** One save request: the edited draft and the fields returning to inheritance. */
export interface ModelMetadataSaveRequest {
  readonly draft: ModelMetadataDraft
  /**
   * The immutable draft this dialog opened with. A fenced retry compares the
   * edit against this snapshot, not the fresh profile, so a concurrent writer's
   * untouched fields survive.
   */
  readonly baselineDraft: ModelMetadataDraft
  /** Canonical profile fields the operator asked to unset. */
  readonly resetFields: readonly string[]
}

/** Props of {@link ModelMetadataDialog}. */
export interface ModelMetadataDialogProps {
  /** Route whose profile owns the model row. */
  providerId: string
  /** The row's identity as currently stored; never the drafted id. */
  modelId: string
  /** Adapter family and ownership form of the edited row. */
  kind: ModelMetadataKind
  /**
   * The stored row the dialog drafts from. For a catalog override this is the
   * override entry, so inherited catalog fields stay blank and are not written
   * back wholesale.
   */
  model: Record<string, unknown>
  /**
   * The effective catalog row, when this dialog edits an override. Inherited
   * values appear as placeholders and are never part of the draft.
   */
  inherited?: Record<string, unknown>
  /**
   * Fields the operator explicitly overrode on this row, when the sync
   * reports them. A field absent here is inherited and therefore has no
   * override to reset.
   */
  manualFields?: readonly string[]
  /** Disable every mutation (read-only deployment). */
  readOnly: boolean
  /** Section copy. */
  t: (key: ModelsKey, params?: Record<string, unknown>) => string
  /** Discard the draft without writing. */
  onClose: () => void
  /**
   * Persist one draft through the owning panel's fenced write.
   * @param request - the edited draft and the fields to unset.
   * @returns the failure text to keep the dialog open, or undefined once saved.
   */
  onSave: (request: ModelMetadataSaveRequest) => Promise<string | undefined>
}

/** Fields a reset may target, in the helper's canonical vocabulary. */
const RESETTABLE_FIELDS = [
  'name', 'contextWindow', 'maxInputTokens', 'maxTokens', 'input',
  'tools', 'reasoning', 'reasoningEfforts', 'cost', 'costTiers', 'releaseDate',
] as const

/** Fields whose present value the dialog edits; everything else is preserved. */
const EDITABLE_MODEL_FIELDS: ReadonlySet<string> = new Set([
  'id', 'name', 'contextWindow', 'maxInputTokens', 'maxTokens', 'input',
  'inputModalities', 'tools', 'reasoning', 'reasoningEfforts', 'cost',
  'costTiers', 'pricingTiers', 'releaseDate',
])

/** Operator-owned deployment fields this dialog never rewrites. */
const PRESERVED_MODEL_FIELDS: ReadonlySet<string> = new Set([
  'compat', 'nativeFileInputs', 'description', 'imagePixelBudget', 'imageMaxBytes',
  'systemPromptUpdate', 'toolUpdate',
])

/** Fields the dialog edits for a pi-ai row; the DeepSeek layout supports fewer. */
const DEEPSEEK_UNSUPPORTED_FIELDS: ReadonlySet<string> = new Set([
  'maxInputTokens', 'tools', 'reasoning', 'reasoningEfforts', 'cost', 'costTiers', 'releaseDate',
])

/** Sync/source metadata fields that are not part of the operator's configuration. */
const SYNC_METADATA_FIELDS: ReadonlySet<string> = new Set([
  'capabilityHints', 'gated', 'gateReason', 'isFree', 'deprecated', 'unverified',
  'firstSeenAt', 'advertisedInputModalities', 'adapter', 'source', 'manualFields',
])

/** Map one helper validation code to its localized reason. */
const VALIDATION_REASON_KEYS: Readonly<Record<string, ModelsKey>> = {
  required: 'metadataReasonRequired',
  positiveInteger: 'metadataReasonPositive',
  nonnegativeNumber: 'metadataReasonNonNegative',
  invalidId: 'metadataReasonId',
  invalidModality: 'metadataReasonModality',
  invalidDate: 'metadataReasonDate',
  invalidEfforts: 'metadataReasonEfforts',
  duplicateThreshold: 'metadataReasonDuplicate',
}

/** The reset group one reported manual/storage field belongs to. */
const RESET_GROUPS: Readonly<Record<string, string>> = {
  input: 'input',
  inputModalities: 'input',
  pricingTiers: 'costTiers',
  costTiers: 'costTiers',
  cost: 'cost',
  'cost.input': 'cost',
  'cost.output': 'cost',
  'cost.cache_read': 'cost',
  'cost.cache_write': 'cost',
  inputPrice: 'cost',
  outputPrice: 'cost',
  cacheReadPrice: 'cost',
  cacheWritePrice: 'cost',
}

/** Normalize a reported manual field to its reset target. */
function canonicalResetTarget(field: string): string {
  return RESET_GROUPS[field] ?? field
}

/** Whether one validation failure belongs to the field group being rendered. */
function failureBelongs(field: string, group: string): boolean {
  if (field === group) return true
  return group === 'costTiers' && field.startsWith('pricingTiers')
}

/** The localized reason for one helper validation code. */
function reasonText(
  t: (key: ModelsKey, params?: Record<string, unknown>) => string,
  code: ModelMetadataValidationIssue['code'],
): string {
  return t(VALIDATION_REASON_KEYS[code] as ModelsKey)
}

/** A compact reset control shown only while the field group has an override. */
function ResetField(props: {
  label: string
  disabled: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={styles['metadataResetBtn']}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <IconRefreshOutlineRegular size={12} />
    </button>
  )
}

/**
 * Render one model's basic fields plus a details disclosure.
 * @param props - the effective row, adapter family, copy, and save callback.
 * @returns the metadata dialog.
 */
export function ModelMetadataDialog(props: ModelMetadataDialogProps): ReactNode {
  const {
    providerId, modelId, kind, model, inherited, manualFields = [], readOnly, t, onClose, onSave,
  } = props
  const initialDraft = useMemo(() => {
    const draft = metadataDraftOf(model, kind)
    return {
      ...draft,
      input: [...draft.input],
      // `metadataDraftOf` always materializes the tier list; clone it so the
      // baseline cannot share row objects with the draft.
      pricingTiers: draftTiers(draft).map(tier => ({ ...tier })),
    }
  }, [kind, model])
  const initialJson = useMemo(() => JSON.stringify(initialDraft), [initialDraft])
  const [draft, setDraft] = useState<ModelMetadataDraft>(initialDraft)
  const [resetFields, setResetFields] = useState<ReadonlySet<string>>(() => new Set())
  const [failures, setFailures] = useState<readonly ModelMetadataValidationIssue[]>([])
  const [saveFailure, setSaveFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const idEditable = kind !== 'pi-ai-catalog'
  const isPiAi = kind === 'pi-ai-models' || kind === 'pi-ai-catalog'
  const dirty = resetFields.size > 0 || JSON.stringify(draft) !== initialJson
  const saveDisabled = readOnly || busy || !dirty
  const overridden = (field: string): boolean =>
    manualFields.some(entry => canonicalResetTarget(entry) === field)
  const overridable = RESETTABLE_FIELDS.filter(overridden)

  const clearReset = (field: string): void => {
    setResetFields((current) => {
      if (!current.has(field)) return current
      const next = new Set(current)
      next.delete(field)
      return next
    })
  }

  const update = <Key extends keyof ModelMetadataDraft>(key: Key, value: ModelMetadataDraft[Key]): void => {
    setDraft(current => ({ ...current, [key]: value }))
    setFailures([])
    setSaveFailure(undefined)
    clearReset(RESET_GROUPS[key] ?? key)
  }

  const clearDraftField = (field: string): void => {
    setDraft((current) => {
      switch (field) {
        case 'input': return { ...current, input: [] }
        case 'tools': return { ...current, tools: 'inherit' }
        case 'reasoning': return { ...current, reasoning: 'inherit' }
        case 'cost': return {
          ...current, inputPrice: '', outputPrice: '', cacheReadPrice: '', cacheWritePrice: '',
        }
        case 'costTiers': return { ...current, pricingTiers: [] }
        default: return { ...current, [field]: '' }
      }
    })
  }

  const reset = (field: string): void => {
    setResetFields(current => new Set(current).add(field))
    setFailures([])
    setSaveFailure(undefined)
    clearDraftField(field)
  }

  const resetAll = (): void => {
    setResetFields(new Set(overridable))
    setFailures([])
    setSaveFailure(undefined)
    setDraft((current) => {
      let next = current
      for (const field of overridable) {
        switch (field) {
          case 'input': next = { ...next, input: [] }; break
          case 'tools': next = { ...next, tools: 'inherit' }; break
          case 'reasoning': next = { ...next, reasoning: 'inherit' }; break
          case 'cost': next = {
            ...next, inputPrice: '', outputPrice: '', cacheReadPrice: '', cacheWritePrice: '',
          }; break
          case 'costTiers': next = { ...next, pricingTiers: [] }; break
          default: next = { ...next, [field]: '' }
        }
      }
      return next
    })
  }

  const copyId = (): void => {
    void writeClipboard(draft.id).then((written) => {
      if (written) setCopied(true)
    })
  }

  const save = async (): Promise<void> => {
    const invalid = validateMetadataDraft(draft, kind)
    setFailures(invalid)
    setSaveFailure(undefined)
    if (invalid.length > 0) return
    setBusy(true)
    try {
      const failure = await onSave({
        draft,
        baselineDraft: initialDraft,
        resetFields: [...resetFields],
      })
      if (failure === undefined) onClose()
      else setSaveFailure(failure)
    } catch (error) {
      setSaveFailure(t('metadataSaveFailed', {
        message: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    if (!busy) onClose()
  }

  const fieldFailure = (group: string): string | undefined => {
    const found = failures.find(entry => failureBelongs(entry.field, group))
    return found === undefined ? undefined : reasonText(t, found.code)
  }

  const resetLabel = (label: string): string => t('metadataResetField', { field: label })

  const preservedCandidates = new Set(PRESERVED_MODEL_FIELDS)
  if (!isPiAi) for (const field of DEEPSEEK_UNSUPPORTED_FIELDS) preservedCandidates.add(field)
  const keptFields = [...preservedCandidates].filter(field => Reflect.has(model, field))
  const otherConfigured = Object.keys(model)
    .filter(field => !EDITABLE_MODEL_FIELDS.has(field) && !preservedCandidates.has(field))
    .filter(field => !SYNC_METADATA_FIELDS.has(field))

  const pricingTiers = draftTiers(draft)
  const inheritedDraft = useMemo(
    () => inherited === undefined ? undefined : metadataDraftOf(inherited, 'pi-ai-catalog'),
    [inherited],
  )
  type DraftTextField =
    | 'name' | 'contextWindow' | 'maxInputTokens' | 'maxTokens'
    | 'reasoningEfforts' | 'inputPrice' | 'outputPrice'
    | 'cacheReadPrice' | 'cacheWritePrice' | 'releaseDate'
  const inheritedValue = (field: DraftTextField): string => inheritedDraft?.[field] ?? ''
  const inheritedTierCount = inheritedDraft === undefined ? 0 : draftTiers(inheritedDraft).length
  const capacityFields = ([
    ['contextWindow', 'metadataContextWindow', 'metadataContextWindowHint'],
    ['maxInputTokens', 'metadataMaxInputTokens', 'metadataMaxInputTokensHint'],
    ['maxTokens', 'metadataMaxTokens', 'metadataMaxTokensHint'],
  ] as const).filter(([field]) => isPiAi || field !== 'maxInputTokens')

  return (
    <Modal
      open
      onClose={close}
      title={t('metadataDialogTitle')}
      description={t('metadataDialogDescription', { provider: providerId, id: modelId })}
      closeLabel={t('close')}
      className={styles['metadataDialog'] as string}
      footer={(
        <>
          {overridable.length > 0 && (
            <button
              type="button"
              className={styles['metadataResetAll']}
              disabled={readOnly || busy}
              onClick={resetAll}
            >
              {t('metadataResetAll')}
            </button>
          )}
          <Button variant="outline" onClick={close} disabled={busy}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => { void save() }} disabled={saveDisabled}>
            {busy ? t('metadataSaving') : t('save')}
          </Button>
        </>
      )}
    >
      <div className={styles['metadataBody']}>
        {readOnly && <p className={styles['metadataNotice']} role="status">{t('readOnly')}</p>}
        {saveFailure !== undefined && (
          <p className={styles['metadataError']} role="alert">{saveFailure}</p>
        )}

        <section className={styles['metadataSection']} aria-label={t('metadataBasic')}>
          <div className={styles['metadataGrid']}>
            <div className={`${styles['metadataField']} ${styles['metadataFieldWide']}`}>
              <label className={styles['metadataFieldLabel']} htmlFor="model-metadata-id">
                {t('modelId')}
              </label>
              <div className={styles['metadataInputRow']}>
                <input
                  id="model-metadata-id"
                  className={`${styles['input']} ${styles['metadataIdInput']}`}
                  type="text"
                  value={draft.id}
                  readOnly={!idEditable}
                  disabled={readOnly || busy}
                  onChange={(event) => { update('id', event.target.value) }}
                />
                <button
                  type="button"
                  className={styles['metadataCopyBtn']}
                  aria-label={t('metadataCopyId')}
                  title={copied ? t('metadataCopied') : t('metadataCopyId')}
                  onClick={copyId}
                >
                  <IconCopyOutlineRegular size={12} />
                </button>
              </div>
              <p className={styles['metadataHint']}>
                {idEditable ? t('metadataIdChangeHint') : t('metadataIdReadonly')}
              </p>
              {fieldFailure('id') !== undefined && (
                <p className={styles['metadataError']} role="alert">{fieldFailure('id')}</p>
              )}
            </div>

            <div className={`${styles['metadataField']} ${styles['metadataFieldWide']}`}>
              <div className={styles['metadataFieldHead']}>
                <label className={styles['metadataFieldLabel']} htmlFor="model-metadata-name">
                  {t('modelName')}
                </label>
                {overridden('name') && (
                  <ResetField
                    label={resetLabel(t('modelName'))}
                    disabled={readOnly || busy}
                    onClick={() => { reset('name') }}
                  />
                )}
              </div>
              <input
                id="model-metadata-name"
                className={styles['input']}
                type="text"
                value={draft.name}
                data-modal-autofocus
                placeholder={inheritedValue('name') === '' ? t('modelNamePlaceholder') : inheritedValue('name')}
                disabled={readOnly || busy}
                onChange={(event) => { update('name', event.target.value) }}
              />
              <p className={styles['metadataHint']}>{t('metadataNameHint')}</p>
            </div>

            {capacityFields.map(([field, label, hint]) => (
              <div className={styles['metadataField']} key={field}>
                <div className={styles['metadataFieldHead']}>
                  <label className={styles['metadataFieldLabel']} htmlFor={`model-metadata-${field}`}>
                    {t(label)}
                  </label>
                  {overridden(field) && (
                    <ResetField
                      label={resetLabel(t(label))}
                      disabled={readOnly || busy}
                      onClick={() => { reset(field) }}
                    />
                  )}
                </div>
                <input
                  id={`model-metadata-${field}`}
                  className={styles['input']}
                  type="text"
                  inputMode="numeric"
                  value={draft[field]}
                  placeholder={inheritedValue(field)}
                  disabled={readOnly || busy}
                  onChange={(event) => { update(field, event.target.value) }}
                />
                <p className={styles['metadataHint']}>{t(hint)}</p>
                {field === 'maxTokens' && draft.maxTokens.trim().length > 0 && (
                  <p className={styles['metadataWarning']}>{t('metadataMaxTokensWarning')}</p>
                )}
                {fieldFailure(field) !== undefined && (
                  <p className={styles['metadataError']} role="alert">{fieldFailure(field)}</p>
                )}
              </div>
            ))}

            <div className={`${styles['metadataField']} ${styles['metadataFieldWide']}`}>
              <div className={styles['metadataFieldHead']}>
                <span className={styles['metadataFieldLabel']}>{t('modelInputTypes')}</span>
                {overridden('input') && (
                  <ResetField
                    label={resetLabel(t('modelInputTypes'))}
                    disabled={readOnly || busy}
                    onClick={() => { reset('input') }}
                  />
                )}
              </div>
              <ModelInputTypes
                model={kind === 'deepseek' ? { inputModalities: draft.input } : { input: draft.input }}
                field={kind === 'deepseek' ? 'inputModalities' : 'input'}
                position={1}
                disabled={readOnly || busy}
                fallback={kind === 'pi-ai-catalog' ? inheritedDraft?.input : undefined}
                t={t}
                onChange={(next) => {
                  update('input', kind === 'deepseek'
                    ? next['inputModalities'] as string[]
                    : next['input'] as string[])
                }}
              />
              <p className={styles['metadataHint']}>{t('metadataInputTypesHint')}</p>
              {fieldFailure('input') !== undefined && (
                <p className={styles['metadataError']} role="alert">{fieldFailure('input')}</p>
              )}
            </div>
          </div>
        </section>

        <details className={styles['metadataDetails']}>
          <summary className={styles['metadataDetailsSummary']}>{t('metadataDetails')}</summary>
          <div className={styles['metadataGrid']}>
            {isPiAi && (
              <div className={styles['metadataField']}>
                <div className={styles['metadataFieldHead']}>
                  <label className={styles['metadataFieldLabel']} htmlFor="model-metadata-tools">
                    {t('metadataTools')}
                  </label>
                  {overridden('tools') && (
                    <ResetField
                      label={resetLabel(t('metadataTools'))}
                      disabled={readOnly || busy}
                      onClick={() => { reset('tools') }}
                    />
                  )}
                </div>
                <select
                  id="model-metadata-tools"
                  className={`${styles['input']} ${styles['selectInput']}`}
                  value={draft.tools}
                  disabled={readOnly || busy}
                  onChange={(event) => { update('tools', event.target.value as ModelMetadataDraft['tools']) }}
                >
                  <option value="inherit">{t('metadataInherit')}</option>
                  <option value="yes">{t('metadataYes')}</option>
                  <option value="no">{t('metadataNo')}</option>
                </select>
                {inheritedDraft !== undefined && draft.tools === 'inherit' && inheritedDraft.tools !== 'inherit' && (
                  <p className={styles['metadataHint']}>
                    {t('metadataInheritedValue', {
                      value: inheritedDraft.tools === 'yes' ? t('metadataYes') : t('metadataNo'),
                    })}
                  </p>
                )}
              </div>
            )}

            {isPiAi && (
              <div className={styles['metadataField']}>
                <div className={styles['metadataFieldHead']}>
                  <label className={styles['metadataFieldLabel']} htmlFor="model-metadata-reasoning">
                    {t('metadataReasoning')}
                  </label>
                  {overridden('reasoning') && (
                    <ResetField
                      label={resetLabel(t('metadataReasoning'))}
                      disabled={readOnly || busy}
                      onClick={() => { reset('reasoning') }}
                    />
                  )}
                </div>
                <select
                  id="model-metadata-reasoning"
                  className={`${styles['input']} ${styles['selectInput']}`}
                  value={draft.reasoning}
                  disabled={readOnly || busy}
                  onChange={(event) => { update('reasoning', event.target.value as ModelMetadataDraft['reasoning']) }}
                >
                  <option value="inherit">{t('metadataInherit')}</option>
                  <option value="yes">{t('metadataYes')}</option>
                  <option value="no">{t('metadataNo')}</option>
                </select>
                {inheritedDraft !== undefined && draft.reasoning === 'inherit' && inheritedDraft.reasoning !== 'inherit' && (
                  <p className={styles['metadataHint']}>
                    {t('metadataInheritedValue', {
                      value: inheritedDraft.reasoning === 'yes' ? t('metadataYes') : t('metadataNo'),
                    })}
                  </p>
                )}
              </div>
            )}

            {isPiAi && (
              <div className={`${styles['metadataField']} ${styles['metadataFieldWide']}`}>
                <div className={styles['metadataFieldHead']}>
                  <label className={styles['metadataFieldLabel']} htmlFor="model-metadata-efforts">
                    {t('metadataReasoningEfforts')}
                  </label>
                  {overridden('reasoningEfforts') && (
                    <ResetField
                      label={resetLabel(t('metadataReasoningEfforts'))}
                      disabled={readOnly || busy}
                      onClick={() => { reset('reasoningEfforts') }}
                    />
                  )}
                </div>
                <textarea
                  id="model-metadata-efforts"
                  className={`${styles['input']} ${styles['metadataTextarea']}`}
                  rows={3}
                  value={draft.reasoningEfforts}
                  placeholder={inheritedValue('reasoningEfforts') === ''
                    ? t('metadataReasoningEffortsPlaceholder')
                    : inheritedValue('reasoningEfforts')}
                  disabled={readOnly || busy}
                  onChange={(event) => { update('reasoningEfforts', event.target.value) }}
                />
                <p className={styles['metadataHint']}>{t('metadataReasoningEffortsHint')}</p>
                {fieldFailure('reasoningEfforts') !== undefined && (
                  <p className={styles['metadataError']} role="alert">{fieldFailure('reasoningEfforts')}</p>
                )}
              </div>
            )}

            {isPiAi && (
              <div className={styles['metadataField']}>
                <div className={styles['metadataFieldHead']}>
                  <label className={styles['metadataFieldLabel']} htmlFor="model-metadata-release">
                    {t('metadataReleaseDate')}
                  </label>
                  {overridden('releaseDate') && (
                    <ResetField
                      label={resetLabel(t('metadataReleaseDate'))}
                      disabled={readOnly || busy}
                      onClick={() => { reset('releaseDate') }}
                    />
                  )}
                </div>
                <input
                  id="model-metadata-release"
                  className={styles['input']}
                  type="date"
                  value={draft.releaseDate}
                  disabled={readOnly || busy}
                  onChange={(event) => { update('releaseDate', event.target.value) }}
                />
                {inheritedDraft !== undefined && draft.releaseDate === '' && inheritedDraft.releaseDate !== '' && (
                  <p className={styles['metadataHint']}>
                    {t('metadataInheritedValue', { value: inheritedDraft.releaseDate })}
                  </p>
                )}
                {fieldFailure('releaseDate') !== undefined && (
                  <p className={styles['metadataError']} role="alert">{fieldFailure('releaseDate')}</p>
                )}
              </div>
            )}

            {isPiAi && (
              <div className={`${styles['metadataField']} ${styles['metadataFieldWide']}`}>
                <div className={styles['metadataFieldHead']}>
                  <span className={styles['metadataFieldLabel']}>{t('metadataPricing')}</span>
                  {overridden('cost') && (
                    <ResetField
                      label={resetLabel(t('metadataPricing'))}
                      disabled={readOnly || busy}
                      onClick={() => { reset('cost') }}
                    />
                  )}
                </div>
                <div className={styles['metadataPriceGrid']}>
                  {([
                    ['inputPrice', 'metadataInputPrice'],
                    ['outputPrice', 'metadataOutputPrice'],
                    ['cacheReadPrice', 'metadataCacheReadPrice'],
                    ['cacheWritePrice', 'metadataCacheWritePrice'],
                  ] as const).map(([field, label]) => (
                    <label className={styles['metadataTierField']} key={field}>
                      <span className={styles['metadataHint']}>{t(label)}</span>
                      <input
                        className={styles['input']}
                        type="text"
                        inputMode="decimal"
                        value={draft[field]}
                        placeholder={inheritedValue(field)}
                        disabled={readOnly || busy}
                        onChange={(event) => { update(field, event.target.value) }}
                      />
                    </label>
                  ))}
                </div>
                <p className={styles['metadataHint']}>{t('metadataPricingHint')}</p>
                {[...new Set([fieldFailure('inputPrice'), fieldFailure('outputPrice'),
                  fieldFailure('cacheReadPrice'), fieldFailure('cacheWritePrice')]
                  .filter((failure): failure is string => failure !== undefined))]
                  .map((failure, index) => (
                    <p className={styles['metadataError']} role="alert" key={`${failure}-${String(index)}`}>{failure}</p>
                  ))}
              </div>
            )}

            {isPiAi && (
              <div className={`${styles['metadataField']} ${styles['metadataFieldWide']}`}>
                <div className={styles['metadataFieldHead']}>
                  <span className={styles['metadataFieldLabel']}>{t('metadataPricingTiers')}</span>
                  {overridden('costTiers') && (
                    <ResetField
                      label={resetLabel(t('metadataPricingTiers'))}
                      disabled={readOnly || busy}
                      onClick={() => { reset('costTiers') }}
                    />
                  )}
                </div>
                <p className={styles['metadataHint']}>{t('metadataPricingTiersHint')}</p>
                {inheritedDraft !== undefined && pricingTiers.length === 0
                  && inheritedTierCount > 0 && (
                  <p className={styles['metadataHint']}>
                    {t('metadataInheritedTiers', { count: inheritedTierCount })}
                  </p>
                )}
                {pricingTiers.map((tier, index) => (
                  <div className={styles['metadataTierRow']} key={`tier-${String(index)}`}>
                    {([
                      ['inputTokensAbove', 'metadataTierAbove'],
                      ['input', 'metadataTierInput'],
                      ['output', 'metadataTierOutput'],
                    ] as const).map(([field, label]) => (
                      <label className={styles['metadataTierField']} key={field}>
                        <span className={styles['metadataHint']}>{t(label)}</span>
                        <input
                          className={styles['input']}
                          type="text"
                          inputMode={field === 'inputTokensAbove' ? 'numeric' : 'decimal'}
                          value={tier[field]}
                          disabled={readOnly || busy}
                          onChange={(event) => {
                            const value = event.target.value
                            update('pricingTiers', pricingTiers.map((entry, at) =>
                              at === index ? { ...entry, [field]: value } : entry))
                          }}
                        />
                      </label>
                    ))}
                    <button
                      type="button"
                      className={styles['metadataTierRemove']}
                      aria-label={t('metadataRemoveTier', { index: index + 1 })}
                      title={t('metadataRemoveTier', { index: index + 1 })}
                      disabled={readOnly || busy}
                      onClick={() => {
                        update('pricingTiers', pricingTiers.filter((_entry, at) => at !== index))
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className={styles['textActionBtn']}
                  disabled={readOnly || busy}
                  onClick={() => {
                    update('pricingTiers', [...pricingTiers, { inputTokensAbove: '', input: '', output: '' }])
                  }}
                >
                  {t('metadataAddTier')}
                </button>
                {fieldFailure('costTiers') !== undefined && (
                  <p className={styles['metadataError']} role="alert">{fieldFailure('costTiers')}</p>
                )}
              </div>
            )}
          </div>

          {(keptFields.length > 0 || otherConfigured.length > 0) && (
            <div className={styles['metadataAdvanced']}>
              <span className={styles['metadataFieldLabel']}>{t('metadataAdvanced')}</span>
              <p className={styles['metadataHint']}>{t('metadataAdvancedNote')}</p>
              <p className={styles['metadataHint']}>
                {t('metadataPreservedFields', { fields: [...keptFields, ...otherConfigured].join(', ') })}
              </p>
            </div>
          )}
        </details>

      </div>
    </Modal>
  )
}
