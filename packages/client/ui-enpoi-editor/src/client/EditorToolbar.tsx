/**
 * The editor's controls inside the document pane's single toolbar row: the
 * save state, the save icon, and the auto-save icon toggle.
 *
 * They live in the host's row through the keyed
 * `sidebar.right.tab.document.toolbar` seat, so the pane keeps one toolbar
 * line; the store is the channel to the editing body — the save icon raises
 * `saveRequested`, which the body consumes, and the toggle writes both the
 * preference and the bucket the body's schedule reads.
 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EditorStore } from './store.ts'
import { readAutosavePref, writeAutosavePref } from './prefs.ts'
import { IconAutosave16, IconSave16 } from './icons.tsx'
import css from './EditorToolbar.module.css'

/** The slot's composed props: owner data, the shared store, and copy. */
export type EditorToolbarProps =
  & PropsRuntime<'sidebar.right.tab.document.toolbar'>
  & PropsStore<EditorStore>
  & PropsLocale<'enpoiEditor'>

/**
 * Render the editor's toolbar segment.
 * @param props - owner data (compact), the store, and copy.
 * @returns the save state and controls, or nothing before the file is known.
 */
export function EditorToolbar({ useTabInfo, useStore, actions, compact, t }: EditorToolbarProps): ReactNode {
  const { tab } = useTabInfo()
  const key = tab.contentId
  const state = useStore(s => s.byAddress[key])
  const status = state?.status ?? 'idle'
  const dirty = state?.dirty ?? false
  const truncated = state?.truncated ?? false
  const saveState = state?.saveState ?? 'idle'
  const autoSave = state?.autoSave ?? null
  const ready = status === 'ready'

  // Seed the persisted auto-save choice once the bucket exists; the body reads
  // the same field, so either surface mounting first gets the same answer.
  useEffect(() => {
    if (state?.autoSave !== null && state?.autoSave !== undefined) return
    actions.autoSaveSet(key, readAutosavePref())
  }, [actions, key, state?.autoSave])

  if (state === undefined || (!ready && !dirty)) return null

  const saving = saveState === 'saving'
  const failed = saveState === 'failed'
  const savedAt = state.savedAt
  const stateText = saving
    ? t('saving')
    : failed && !dirty
      ? t('saveFailed')
      : dirty
        ? t('unsaved')
        : savedAt === null
          ? null
          : t('savedAt', { time: new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
  const toggleAutoSave = (): void => {
    const next = autoSave !== true
    writeAutosavePref(next)
    actions.autoSaveSet(key, next)
  }

  return (
    <span className={css.segment} data-enpoi-editor-controls>
      {stateText !== null && !compact && (
        <span
          className={clsx(css.state, failed && css.stateError)}
          data-enpoi-editor-saved={!dirty && !saving && !failed ? '' : undefined}
          data-enpoi-editor-saving={saving ? '' : undefined}
          data-enpoi-editor-dirty={dirty ? '' : undefined}
          data-enpoi-editor-save-failed={failed && !dirty ? '' : undefined}
        >
          {stateText}
        </span>
      )}
      {ready && !truncated && (dirty || autoSave === false) && (
        <Tooltip label={t('save')} side="bottom" delayMs={400}>
          <button
            type="button"
            className={clsx(css.tool, css.save)}
            aria-label={t('save')}
            data-enpoi-editor-save
            onClick={() => { actions.saveRequested(key) }}
          >
            <IconSave16 />
          </button>
        </Tooltip>
      )}
      <Tooltip label={autoSave === true ? t('autosave.disable') : t('autosave.enable')} side="bottom" delayMs={400}>
        <button
          type="button"
          className={clsx(css.tool, autoSave === true && css.pressed)}
          aria-pressed={autoSave === true}
          aria-label={t('autosave.aria')}
          data-enpoi-editor-autosave
          onClick={toggleAutoSave}
        >
          <IconAutosave16 />
        </button>
      </Tooltip>
    </span>
  )
}
