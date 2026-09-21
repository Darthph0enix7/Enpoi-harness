/**
 * Model groups row on the Providers page — the ONLY creation surface for
 * failover groups.
 *
 * Collapsed it is one line (`Model groups · <n>`); expanded it lists the stored
 * groups (label, link count, ordered provider preview, enable/disable, edit,
 * delete) plus an editor drawer whose link list adds and reorders links through
 * the shared model picker, with `attempts` and `onCut` behind an Advanced
 * disclosure. The row renders nothing at all while the namespace carries no
 * group and this browser has never shown one, so a zero-group install looks
 * exactly as it did before the feature.
 */
import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelSelect } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import {
  groupWriteOps, isValidGroupId, linkLabel, linkProviderPreview,
  readModelGroups, writeGroupOps,
  type GroupWriteFailure, type ModelGroup, type ModelGroupLink,
} from './model-groups.ts'
import type { ModelPickerFace } from './picker-face.ts'
import type { ModelsWire } from './store.ts'
import type { en } from './locales.ts'
import css from './ModelGroups.module.css'

/** Props of {@link ModelGroupsRow}: mirrored namespace, wire face, and copy seats. */
export interface ModelGroupsRowProps {
  /** The `enpoi-orchestration` namespace view, or undefined before the first load. */
  namespace: SettingsNamespaceView | undefined
  /** Settings Remote face for the fenced writes. */
  api: ModelsWire
  /** Whether the settings document accepts writes. */
  readOnly: boolean
  /** Catalog-backed picker face for the link editor, or null when unavailable. */
  picker: ModelPickerFace | null
  /** Providers-page copy seat. */
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
  /** Shared picker's own copy seat. */
  modelT: TranslateNS<'model'>
  /** Ask the page to re-read its settings mirror after a committed write. */
  onSaved: () => void
}

/** One editor draft (attempts stays text while the operator types). */
interface GroupDraft {
  id: string
  label: string
  links: ModelGroupLink[]
  attempts: string
  onCut: 'failover' | 'continue'
}

/** Monochrome chain glyph (stroke currentColor, same style as the picker icons). */
function ChainGlyph({ size = 13 }: { size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

/** Monochrome grip glyph for link reordering. */
function GripGlyph(): ReactNode {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="8" cy="5" r="2.2" />
      <circle cx="16" cy="5" r="2.2" />
      <circle cx="8" cy="12" r="2.2" />
      <circle cx="16" cy="12" r="2.2" />
      <circle cx="8" cy="19" r="2.2" />
      <circle cx="16" cy="19" r="2.2" />
    </svg>
  )
}

/** The Model groups row. */
export function ModelGroupsRow({
  namespace, api, readOnly, picker, t, modelT, onSaved,
}: ModelGroupsRowProps): ReactNode {
  const stored = useMemo(() => readModelGroups(namespace), [namespace])
  const [expanded, setExpanded] = useState(false)
  const [optimistic, setOptimistic] = useState<ModelGroup[] | null>(null)
  const [editorId, setEditorId] = useState<string | null>(null)
  const [draft, setDraft] = useState<GroupDraft | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [dragLink, setDragLink] = useState<number | null>(null)

  const groups = optimistic ?? stored

  // The mirror refresh after a write replaces the optimistic overlay.
  useEffect(() => { setOptimistic(null) }, [namespace])

  // The row is always rendered: it is the ONLY creation surface for groups, so
  // hiding it while the registry is empty would make the first group impossible
  // to create from the UI. With no groups it is a single collapsed line.

  const failureText = (failure: GroupWriteFailure): string => {
    if (failure.message !== undefined) return failure.message
    if (failure.code === 'conflict') return t('groupsWriteConflict')
    if (failure.code === 'timeout') return t('groupsWriteTimeout')
    if (failure.code === 'unavailable') return t('groupsWriteUnavailable')
    return t('groupsWriteRejected')
  }

  const persist = async (ops: SettingsPathOpView[], previous: ModelGroup[]): Promise<boolean> => {
    setBusy(true)
    setStatus(null)
    const failure = await writeGroupOps(api, ops)
    setBusy(false)
    if (failure !== null) {
      setOptimistic(previous)
      setStatus(failureText(failure))
      return false
    }
    // The picker reads the registry through its own cache: wake it up now
    // (ui-model-selection's `dsh:model-groups-changed` event).
    window.dispatchEvent(new CustomEvent('dsh:model-groups-changed'))
    onSaved()
    return true
  }

  const openEditor = (group: ModelGroup | null): void => {
    setStatus(null)
    setAdvanced(false)
    setConfirmRemove(null)
    if (group === null) {
      setEditorId('')
      setDraft({ id: '', label: '', links: [], attempts: '2', onCut: 'failover' })
      return
    }
    setEditorId(group.id)
    setDraft({
      id: group.id,
      label: group.label,
      links: group.links.map(link => ({ ...link })),
      attempts: String(group.attempts),
      onCut: group.onCut,
    })
  }

  const closeEditor = (): void => {
    setEditorId(null)
    setDraft(null)
    setStatus(null)
  }

  const applyGroup = (group: ModelGroup): void => {
    setOptimistic((current) => {
      const list = current ?? stored
      return list.some(item => item.id === group.id)
        ? list.map(item => item.id === group.id ? group : item)
        : [...list, group]
    })
  }

  const toggleEnabled = async (group: ModelGroup): Promise<void> => {
    const next = { ...group, disabled: !group.disabled }
    const previous = groups
    applyGroup(next)
    // A leaf write: enable/disable must never clobber a concurrent link edit.
    await persist([{ op: 'set', path: ['chains', group.id, 'disabled'], value: next.disabled }], previous)
  }

  const removeGroup = async (group: ModelGroup): Promise<void> => {
    setConfirmRemove(null)
    const previous = groups
    setOptimistic(previous.filter(item => item.id !== group.id))
    await persist([{ op: 'unset', path: ['chains', group.id] }], previous)
  }

  const saveDraft = async (): Promise<void> => {
    if (draft === null) return
    setStatus(null)
    const id = draft.id.trim()
    const label = draft.label.trim()
    const creating = editorId === null || editorId === ''
    if (id === '') { setStatus(t('groupsIdRequired')); return }
    if (!isValidGroupId(id)) { setStatus(t('groupsIdInvalid')); return }
    if (creating && groups.some(group => group.id === id)) { setStatus(t('groupsIdTaken')); return }
    if (label === '') { setStatus(t('groupsLabelRequired')); return }
    if (draft.links.length === 0) { setStatus(t('groupsLinksRequired')); return }
    const attempts = Number(draft.attempts)
    if (!Number.isInteger(attempts) || attempts < 1) { setStatus(t('groupsAttemptsInvalid')); return }
    const group: ModelGroup = {
      id,
      label,
      links: draft.links,
      attempts,
      onCut: draft.onCut,
      disabled: groups.find(item => item.id === id)?.disabled ?? false,
    }
    const previous = groups
    applyGroup(group)
    if (await persist(groupWriteOps(group), previous)) closeEditor()
  }

  const addLink = (selection: { provider: string; model: string }): void => {
    setDraft(current => current === null
      ? current
      : { ...current, links: [...current.links, { provider: selection.provider, model: selection.model }] })
  }

  const removeLink = (index: number): void => {
    setDraft(current => current === null ? current : { ...current, links: current.links.filter((_, i) => i !== index) })
  }

  const moveLink = (from: number, to: number): void => {
    setDraft((current) => {
      if (current === null || from === to) return current
      const links = [...current.links]
      const moved = links[from]
      if (moved === undefined) return current
      links.splice(from, 1)
      links.splice(to, 0, moved)
      return { ...current, links }
    })
  }

  const handleLinkDrop = (event: DragEvent, targetIndex: number): void => {
    event.preventDefault()
    if (dragLink !== null) moveLink(dragLink, targetIndex)
    setDragLink(null)
  }

  const addLinkOverride = {
    current: null,
    placeholder: t('groupsAddModel'),
    select: (selection: { provider: string; model: string }) => {
      addLink(selection)
      return Promise.resolve(true)
    },
  }

  return (
    <section className={css.row}>
      <div className={css.header}>
        <button
          type="button"
          className={css.headerToggle}
          aria-expanded={expanded}
          onClick={() => { setExpanded(!expanded); setStatus(null) }}
        >
          <span className={css.chevron} aria-hidden>{expanded ? '▾' : '▸'}</span>
          <span className={css.headerGlyph} aria-hidden><ChainGlyph /></span>
          <span className={css.headerTitle}>{t('groupsTitle')}</span>
          <span className={css.headerCount}>· {groups.length}</span>
        </button>
        {expanded && !readOnly && (
          <button
            type="button"
            className={css.newBtn}
            onClick={() => { openEditor(null) }}
            disabled={busy}
          >
            {t('groupsNew')}
          </button>
        )}
      </div>

      {expanded && (
        <div className={css.body}>
          {status !== null && <p className={css.status} role="alert">{status}</p>}
          {groups.length === 0 && <div className={css.empty}>{t('groupsEmpty')}</div>}
          {groups.map(group => (
            <div className={css.groupRow} key={group.id}>
              <div className={css.groupInfo}>
                <div className={css.groupNameRow}>
                  <span className={css.groupLabel}>{group.label}</span>
                  <span className={css.groupId}>{group.id}</span>
                </div>
                <div className={css.groupMeta}>
                  <span>
                    {group.links.length === 1
                      ? t('groupsLinkCountOne')
                      : t('groupsLinkCount', { count: group.links.length })}
                  </span>
                  {group.links.length > 0 && (
                    <span className={css.groupPreview} title={group.links.map(linkLabel).join('\n')}>
                      · {linkProviderPreview(group)}
                    </span>
                  )}
                  {group.disabled && <span className={css.groupDisabled}>· {t('groupsDisabled')}</span>}
                </div>
                {group.links.length === 0 && <div className={css.groupWarning}>{t('groupsDangling')}</div>}
              </div>
              <div className={css.groupActions}>
                <button
                  type="button"
                  className={css.rowBtn}
                  disabled={busy || readOnly}
                  onClick={() => { void toggleEnabled(group) }}
                >
                  {group.disabled ? t('groupsEnable') : t('groupsDisable')}
                </button>
                <button
                  type="button"
                  className={css.rowBtn}
                  disabled={busy || readOnly}
                  onClick={() => { openEditor(group) }}
                >
                  {t('groupsEdit')}
                </button>
                {confirmRemove === group.id ? (
                  <>
                    <span className={css.confirmText}>{t('groupsDeleteConfirm')}</span>
                    <button
                      type="button"
                      className={css.confirmBtn}
                      disabled={busy}
                      onClick={() => { void removeGroup(group) }}
                    >
                      {t('groupsDelete')}
                    </button>
                    <button type="button" className={css.rowBtn} onClick={() => { setConfirmRemove(null) }}>
                      {t('groupsCancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={css.removeBtn}
                    aria-label={`${t('groupsDelete')} ${group.label}`}
                    disabled={busy || readOnly}
                    onClick={() => { setStatus(null); setConfirmRemove(group.id) }}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          ))}

          {editorId !== null && draft !== null && (
            <div className={css.editor}>
              <div className={css.editorGrid}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('groupsId')}</span>
                  <input
                    className={css.input}
                    value={draft.id}
                    disabled={editorId !== ''}
                    aria-label={t('groupsId')}
                    placeholder={t('groupsIdPlaceholder')}
                    onChange={(event) => { setDraft({ ...draft, id: event.target.value }) }}
                  />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('groupsLabel')}</span>
                  <input
                    className={css.input}
                    value={draft.label}
                    aria-label={t('groupsLabel')}
                    placeholder={t('groupsLabelPlaceholder')}
                    onChange={(event) => { setDraft({ ...draft, label: event.target.value }) }}
                  />
                </label>
              </div>

              <div className={css.fieldLabel}>{t('groupsLinks')}</div>
              {draft.links.map((link, index) => (
                <div
                  className={css.linkRow}
                  key={`${link.provider}/${link.model}/${index}`}
                  draggable
                  onDragStart={() => { setDragLink(index) }}
                  onDragOver={(event) => { event.preventDefault() }}
                  onDrop={(event) => { handleLinkDrop(event, index) }}
                >
                  <span className={css.linkDrag} title={t('groupsDragLink')}><GripGlyph /></span>
                  <span className={css.linkText}>{linkLabel(link)}</span>
                  <button
                    type="button"
                    className={css.removeBtn}
                    aria-label={`${t('groupsRemoveLink')} ${linkLabel(link)}`}
                    onClick={() => { removeLink(index) }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {draft.links.length === 0 && <div className={css.editorHint}>{t('groupsNoLinks')}</div>}

              <div className={css.addLinkRow}>
                {picker !== null ? (
                  <ModelSelect
                    locked={false}
                    available
                    directory={picker.directory}
                    load={picker.load}
                    select={() => Promise.resolve(true)}
                    compact
                    override={addLinkOverride}
                    t={modelT}
                  />
                ) : (
                  <span className={css.editorHint}>{t('groupsPickerUnavailable')}</span>
                )}
              </div>

              <button
                type="button"
                className={css.advancedToggle}
                aria-expanded={advanced}
                onClick={() => { setAdvanced(!advanced) }}
              >
                <span aria-hidden>{advanced ? '▾' : '▸'}</span> {t('groupsAdvanced')}
              </button>
              {advanced && (
                <div className={css.editorGrid}>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('groupsAttempts')}</span>
                    <input
                      className={css.input}
                      inputMode="numeric"
                      value={draft.attempts}
                      aria-label={t('groupsAttempts')}
                      onChange={(event) => { setDraft({ ...draft, attempts: event.target.value }) }}
                    />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('groupsOnCut')}</span>
                    <select
                      className={`${css.input} ${css.selectInput}`}
                      value={draft.onCut}
                      aria-label={t('groupsOnCut')}
                      onChange={(event) => {
                        setDraft({ ...draft, onCut: event.target.value === 'continue' ? 'continue' : 'failover' })
                      }}
                    >
                      <option value="failover">{t('groupsOnCutFailover')}</option>
                      <option value="continue">{t('groupsOnCutContinue')}</option>
                    </select>
                  </label>
                </div>
              )}

              <div className={css.editorActions}>
                <button
                  type="button"
                  className={css.saveBtn}
                  disabled={busy || readOnly}
                  onClick={() => { void saveDraft() }}
                >
                  {busy ? t('groupsSaving') : t('groupsSave')}
                </button>
                <button type="button" className={css.rowBtn} onClick={closeEditor}>
                  {t('groupsCancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
