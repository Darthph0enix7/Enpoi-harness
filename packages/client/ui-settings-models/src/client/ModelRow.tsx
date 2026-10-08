/** Shared model fields and actions for both adapter catalog editors. */

import type { ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import { ModelInputTypes } from './ModelInputTypes.tsx'
import styles from './ModelsSection.module.css'

/** A capacity's editable text and adapter-specific inherited hint. */
interface CapacityInput {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onBlur?: () => void
}

/** Days after a model's release date during which the row reads as new. */
const NEW_MODEL_WINDOW_DAYS = 90

/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whether the row's models.dev release date falls inside the new-model window.
 * A missing or unreadable date never reads as new, and a future date does not
 * either — it is not a release that happened.
 * @param model - the drafted row.
 * @returns whether the "new" marker shows.
 */
function isNewModel(model: DeepSeekModelDraft): boolean {
  const released = model['releaseDate']
  if (typeof released !== 'string') return false
  const at = Date.parse(`${released}T00:00:00Z`)
  if (Number.isNaN(at)) return false
  const age = Date.now() - at
  return age >= 0 && age <= NEW_MODEL_WINDOW_DAYS * DAY_MS
}

/**
 * Whether the row carries a request-wide price tier at or above 200K context
 * tokens, which is how models.dev publishes the higher price a model charges
 * for large requests.
 * @param model - the drafted row.
 * @returns whether the usage-tier marker shows.
 */
function hasUsageTier(model: DeepSeekModelDraft): boolean {
  const tiers = model['costTiers']
  if (!Array.isArray(tiers)) return false
  return tiers.some((tier) => {
    if (tier === null || typeof tier !== 'object') return false
    const above = (tier as { inputTokensAbove?: unknown }).inputTokensAbove
    return typeof above === 'number' && above >= 200_000
  })
}

/** Adapter-owned data and actions for one model row. */
interface ModelRowProps {
  model: DeepSeekModelDraft
  position: number
  inputField: 'inputModalities' | 'input'
  inputFallback?: readonly string[] | undefined
  inputLoading?: boolean
  expanded: boolean
  disabled: boolean
  t: (key: ModelsKey) => string
  contextWindow: CapacityInput
  maxTokens: CapacityInput
  onFieldChange: (field: 'id' | 'name', value: string | undefined) => void
  onIdBlur?: (value: string) => void
  onChange: (model: DeepSeekModelDraft) => void
  onToggle: () => void
  onRemove: () => void
}

/**
 * Render consistent model identity, capacity, and input-type controls.
 * @param props - drafted fields and their owning editor's actions.
 * @returns one expandable model entry.
 */
export function ModelRow(props: ModelRowProps): ReactNode {
  const { model, position, t, disabled } = props
  return (
    <div className={styles['modelEntry']}>
      <div
        className={styles['modelRow']}
        data-release-date={typeof model['releaseDate'] === 'string' ? model['releaseDate'] : undefined}
        data-cost-tiers={Array.isArray(model['costTiers']) ? JSON.stringify(model['costTiers']) : undefined}
      >
        {(['id', 'name'] as const).map(field => (
          <input
            key={field}
            className={styles['input']}
            type="text"
            value={typeof model[field] === 'string' ? model[field] : ''}
            placeholder={t(field === 'id' ? 'modelId' : 'modelName')}
            aria-label={`${t(field === 'id' ? 'modelId' : 'modelName')} ${String(position)}`}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value
              props.onFieldChange(field, field === 'name' && value === '' ? undefined : value)
            }}
            onBlur={field === 'id' ? event => props.onIdBlur?.(event.target.value) : undefined}
          />
        ))}
        <span className={styles['modelBadges']}>
          {isNewModel(model)
            ? <span className={styles['modelBadge']} data-model-badge="new">{t('modelNewBadge')}</span>
            : null}
          {hasUsageTier(model)
            ? (
              <span
                className={styles['modelBadge']}
                data-model-badge="usage-tier"
                title={t('modelTieredPricingHint')}
              >
                {t('modelTieredPricingBadge')}
              </span>
            )
            : null}
        </span>
        <button
          type="button"
          className={styles['iconButton']}
          aria-label={`${t('modelAdvanced')} ${String(position)}`}
          aria-expanded={props.expanded}
          title={t('modelAdvanced')}
          onClick={props.onToggle}
        >
          {props.expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
        </button>
        <button
          type="button"
          className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
          aria-label={`${t('removeModel')} ${String(position)}`}
          title={t('removeModel')}
          disabled={disabled}
          onClick={props.onRemove}
        >
          <IconTrashOutlineRegular size={14} />
        </button>
      </div>
      {props.expanded
        ? (
          <div className={styles['modelAdvanced']}>
            {(['contextWindow', 'maxTokens'] as const).map(field => (
              <label className={styles['modelField']} key={field}>
                <span className={styles['modelFieldLabel']}>{t(field)}</span>
                <input
                  className={styles['input']}
                  type="text"
                  inputMode="numeric"
                  value={props[field].value}
                  placeholder={props[field].placeholder}
                  aria-label={`${t(field)} ${String(position)}`}
                  disabled={disabled}
                  onChange={(event) => { props[field].onChange(event.target.value) }}
                  onBlur={props[field].onBlur}
                />
              </label>
            ))}
            <ModelInputTypes
              model={model} field={props.inputField} position={position}
              fallback={props.inputFallback} disabled={disabled || props.inputLoading === true} t={t} onChange={props.onChange}
            />
          </div>
        )
        : null}
    </div>
  )
}
