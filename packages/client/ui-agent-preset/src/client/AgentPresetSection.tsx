/**
 * Preset selection settings: the roster, its default, mode help, a read-only view of each
 * composition, the Creator-mode entry, and manual preset authoring.
 */
import type { ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Button, IconBrowseOutlineRegular, IconPlusOutlineRegular, Input, Modal, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentPresetSectionState } from './section-store.ts'
import type { AuthoringCreateInput, AuthoringPresetDetail, AuthoringUpdateInput } from './manual-authoring.ts'
import { isBuiltInPreset, presetDisplayText } from './locales.ts'
import { PresetGuideDialog, presetGuide, trapPresetReaderTab, type PresetGuidePage } from './PresetGuideDialog.tsx'
import css from './AgentPresetSection.module.css'

/** Settings actions and their shared controller state. */
export interface AgentPresetSectionInjected {
  hooks: {
    agentPresetSection: SnapshotStore<AgentPresetSectionState>
    /** Shared Developer tools preference; off hides every selection action. */
    developerTools: ObservableSnapshot<boolean>
  }
  /** Stage the `cordis` preset and start a Creator-mode task; absent without a conversation flow. */
  startCreatorDraft?: () => void
  load: () => Promise<void>
  /** Open one preset's declared composition in the read-only viewer. */
  view: (id: string) => Promise<void>
  /** Close the read-only viewer. */
  closeView: () => void
  makeDefault: (id: string) => Promise<void>
  /** Read one preset's editable fields for the manual edit dialog. */
  presetDetail: (id: string) => Promise<{ detail?: AuthoringPresetDetail; error?: string }>
  /** Clone a base preset into a new user preset; resolves to the failure message or undefined. */
  createPreset: (input: AuthoringCreateInput) => Promise<string | undefined>
  /** Edit a user preset's name, description, and persona suffix. */
  updatePreset: (input: AuthoringUpdateInput) => Promise<string | undefined>
  /** Delete a user preset row. */
  deletePreset: (id: string) => Promise<string | undefined>
}
/** Props assembled by the settings renderer. */
export type AgentPresetSectionProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetSectionInjected>

/** One open manual-authoring dialog. */
interface ManualForm {
  mode: 'create' | 'edit'
  base: string
  id: string
  name: string
  description: string
  suffix: string
  error: string | null
  /** Edit loads the suffix before the fields are usable. */
  loading: boolean
}

/** Preset id grammar, mirroring the host's `isPresetId`. */
const PRESET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function CardDescription({ text }: { text: string }): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    /* v8 ignore next -- the ref is attached before layout effects run. */
    if (el === null) return
    const measure = () => { setTruncated(el.scrollHeight > el.clientHeight) }
    measure()
    // Card width follows the settings pane, which resizes with the window.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [text])
  return (
    // Capped near the card's own width: the default half-viewport bubble would
    // spill a description out of the settings dialog and across the app behind it.
    <Tooltip label={text} side="bottom" delayMs={400} disabled={!truncated} maxWidth={360}>
      {/* The empty title stops the card body's native tooltip from climbing to
        this span: a cut-off description answers with one bubble, not two. */}
      <span ref={ref} className={css.cardDesc} title="">{text}</span>
    </Tooltip>
  )
}

/** Render the roster with its default, mode help, composition viewer, Creator guidance, and manual authoring.
 * @param props Settings actions, snapshot hooks and localized text.
 * @returns The preset settings section.
 */
export function AgentPresetSection({
  useAgentPresetSection, load, view, closeView, makeDefault, startCreatorDraft, presetDetail, createPreset, updatePreset, deletePreset,
  close: closeSettings, useDeveloperTools, t,
}: AgentPresetSectionProps) {
  const state = useAgentPresetSection(value => value)
  const developerTools = useDeveloperTools(enabled => enabled)
  const [guide, setGuide] = useState<{
    content: NonNullable<ReturnType<typeof presetGuide>>
    page: PresetGuidePage
  } | null>(null)
  const [manual, setManual] = useState<ManualForm | null>(null)
  const [deletingPreset, setDeletingPreset] = useState<{ id: string; name: string } | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [manualBusy, setManualBusy] = useState(false)
  const viewTrigger = useRef<HTMLButtonElement | null>(null)
  const closeViewOnUnmount = useRef(closeView)
  useEffect(() => { void load() }, [load])
  useLayoutEffect(() => { closeViewOnUnmount.current = closeView }, [closeView])
  useEffect(() => () => { closeViewOnUnmount.current() }, [])
  const closeViewer = () => { closeView(); viewTrigger.current?.focus() }
  const viewed = state.view
  const viewedRow = viewed === null ? undefined : state.rows.find(row => row.id === viewed.id)
  const viewedTitle = viewed === null ? '' : viewedRow === undefined ? viewed.title : presetDisplayText(viewedRow, t).name
  // Creator mode authors presets in conversation; it needs the flow to land a
  // session in and the self-referential preset on the roster.
  const creator = startCreatorDraft !== undefined && state.rows.some(row => row.id === 'cordis') ? startCreatorDraft : undefined
  const authoringById = new Map(state.authoring.rows.map(row => [row.id, row]))
  const manualReady = state.authoring.status === 'ready'
  const authoringDisabled = !developerTools || state.saving || manualBusy
  const patchManual = (patch: Partial<ManualForm>): void => {
    setManual(current => current === null ? current : { ...current, ...patch })
  }
  const openCreate = (): void => {
    const base = state.rows.find(row => row.broken === undefined && authoringById.get(row.id)?.hasPersona === true)
    setManual({
      mode: 'create', base: base?.id ?? '', id: '', name: '', description: '', suffix: '',
      error: base === undefined ? t('manualErrorBase') : null, loading: false,
    })
  }
  const openEdit = (id: string, name: string, description: string | undefined): void => {
    setManual({
      mode: 'edit', base: id, id, name, description: description ?? '', suffix: '',
      error: null, loading: true,
    })
    void presetDetail(id).then(({ detail, error }) => {
      setManual(current => current === null || current.mode !== 'edit' || current.id !== id
        ? current
        : error !== undefined || detail === undefined
          ? { ...current, error: t('manualDetailFailed', { reason: error ?? 'missing' }), loading: false }
          : { ...current, name: detail.name, description: detail.description, suffix: detail.suffix, loading: false })
    })
  }
  const submitManual = async (): Promise<void> => {
    if (manual === null || manual.loading || manualBusy) return
    const id = manual.id.trim()
    const name = manual.name.trim()
    const suffix = manual.suffix
    if (manual.mode === 'create' && !PRESET_ID.test(id)) { patchManual({ error: t('manualErrorId') }); return }
    if (name === '') { patchManual({ error: t('manualErrorName') }); return }
    if (suffix.trim() === '') { patchManual({ error: t('manualErrorPersona') }); return }
    if (manual.mode === 'create' && manual.base === '') { patchManual({ error: t('manualErrorBase') }); return }
    setManualBusy(true)
    patchManual({ error: null })
    const failure = manual.mode === 'create'
      ? await createPreset({ base: manual.base, id, name, description: manual.description.trim(), suffix })
      : await updatePreset({ id: manual.id, name, description: manual.description.trim(), suffix })
    setManualBusy(false)
    if (failure !== undefined) {
      patchManual({ error: t(manual.mode === 'create' ? 'manualCreateFailed' : 'manualUpdateFailed', { reason: failure }) })
      return
    }
    setManual(null)
  }
  const confirmDeletePreset = async (): Promise<void> => {
    if (deletingPreset === null || manualBusy) return
    setManualBusy(true)
    setDeleteError(null)
    const failure = await deletePreset(deletingPreset.id)
    setManualBusy(false)
    if (failure !== undefined) {
      setDeleteError(t('manualDeleteFailed', { reason: failure }))
      return
    }
    setDeletingPreset(null)
  }
  const manualButton = !manualReady
    ? null
    : (
      <button
        type="button"
        className={css.creatorButton}
        data-preset-new=""
        disabled={authoringDisabled}
        title={developerTools ? undefined : t('enableDevToolsToCreate')}
        onClick={openCreate}
      >
        <IconPlusOutlineRegular size={14} />
        {t('manualNew')}
      </button>
    )
  /* The custom group is where a preset of one's own appears, so its entries
     stay on screen even while the group is empty. */
  const creatorButton = creator === undefined
    ? null
    : (
      <button
        type="button"
        className={css.creatorButton}
        disabled={!developerTools || state.saving}
        title={developerTools ? undefined : t('enableDevToolsToCreate')}
        onClick={() => { creator(); closeSettings() }}
      >
        <IconPlusOutlineRegular size={14} />
        {t('creatorDraft')}
      </button>
    )
  const groupEntry = (builtIn: boolean): ReactNode => {
    const buttons = [
      ...!builtIn && manualButton !== null ? [manualButton] : [],
      ...!builtIn && creatorButton !== null ? [creatorButton] : [],
    ]
    return buttons.length === 0 ? null : <div className={css.groupActions}>{buttons}</div>
  }
  return <section className={css.section}>
    <h2 className={css.title}>{t('nav')}</h2>
    <p className={css.intro}>{t('sectionIntro')}</p>
    {state.error === null ? null : <p className={css.error} role="alert">{state.error}</p>}
    {manualReady ? null : <p className={css.intro} role="status">{t('manualUnavailable')}</p>}
    {([true, false] as const).map((builtIn) => {
      const rows = state.rows.filter(row => isBuiltInPreset(row) === builtIn)
      const entry = groupEntry(builtIn)
      if (rows.length === 0 && entry === null) return null
      return <section key={String(builtIn)} className={css.group}>
        <h3 className={css.groupHead}>{t(builtIn ? 'builtInGroup' : 'customGroup')}</h3>
        {rows.length === 0 ? null : <ul className={css.cards}>
          {rows.map((row) => {
            const display = presetDisplayText(row, t)
            const help = presetGuide(row.id, builtIn ? 'system' : 'user')
            const selectionAction = row.broken !== undefined ? t('brokenBadge')
              : row.isDefault ? t('inUse')
                : t(developerTools ? 'setDefault' : 'enableDevToolsToSetDefault')
            const authoring = authoringById.get(row.id)
            const manualRow = manualReady && authoring !== undefined && !authoring.builtIn
            return <li key={row.id} data-agent-preset-id={row.id} className={[
              css.card, row.broken === undefined ? undefined : css.cardBroken,
              row.isDefault ? css.cardActive : undefined,
              !developerTools && row.broken === undefined && !row.isDefault ? css.cardSelectionDisabled : undefined,
            ].filter(Boolean).join(' ')}>
              <button type="button" className={css.cardMain} aria-pressed={row.isDefault}
                disabled={row.isDefault || (row.broken === undefined && (!developerTools || state.saving))}
                aria-disabled={row.broken !== undefined} aria-label={`${selectionAction}: ${display.name}`} title={selectionAction}
                onClick={() => { if (row.broken === undefined) void makeDefault(row.id) }}>
                <span className={css.cardHead}>
                  <span className={css.cardIdentity}>
                    <span className={css.cardName} title={display.name}>{display.name}</span>
                    {row.broken === undefined ? null : <span className={css.brokenBadge}>
                      {t('brokenBadge')}<span className={css.brokenTip} aria-hidden="true">{row.broken}</span>
                    </span>}
                    <Tag tone={row.isDefault ? 'solid' : 'outline'}>
                      {row.isDefault ? t('inUse') : t(builtIn ? 'builtInGroup' : 'customGroup')}
                    </Tag>
                  </span>
                  <code className={css.cardId} title={row.id}>{row.id}</code>
                </span>
                <CardDescription text={display.description ?? t('noDescription')} />
                {row.broken === undefined ? null : <span className={css.cardBrokenReason} role="alert">{row.broken}</span>}
              </button>
              <div className={css.cardFoot}>
                {help === undefined ? null : <div className={css.cardHelp}>
                  <Button variant="ghost" className={css.helpButton} aria-label={`${t('modeExplanation')}: ${display.name}`}
                    onClick={() => { setGuide({ content: help, page: 'explanation' }) }}>{t('modeExplanation')}</Button>
                  <Button variant="ghost" className={css.helpButton} aria-label={`${t('howToUse')}: ${display.name}`}
                    onClick={() => { setGuide({ content: help, page: 'usage' }) }}>{t('howToUse')}</Button>
                </div>}
                {/* Reading the declaration is the one thing this page offers
                  beyond choosing: a broken preset's YAML is also where its
                  diagnostic points, so the viewer stays available for it. */}
                <button type="button" className={css.iconButton} data-tip={t('view')} aria-label={`${t('view')}: ${display.name}`}
                  onClick={(event) => { viewTrigger.current = event.currentTarget; void view(row.id) }}>
                  <IconBrowseOutlineRegular />
                </button>
                {manualRow && row.broken === undefined ? <>
                  <button type="button" className={css.manualAction} data-preset-edit={row.id}
                    disabled={authoringDisabled}
                    title={developerTools ? undefined : t('enableDevToolsToCreate')}
                    aria-label={`${t('manualEdit')}: ${display.name}`}
                    onClick={() => { openEdit(row.id, display.name, display.description) }}>
                    {t('manualEdit')}
                  </button>
                  <button type="button" className={css.manualActionDanger} data-preset-delete={row.id}
                    disabled={authoringDisabled}
                    title={developerTools ? undefined : t('enableDevToolsToCreate')}
                    aria-label={`${t('manualDelete')}: ${display.name}`}
                    onClick={() => { setDeleteError(null); setDeletingPreset({ id: row.id, name: display.name }) }}>
                    {t('manualDelete')}
                  </button>
                </> : null}
              </div>
            </li>
          })}
        </ul>}
        {entry}
      </section>
    })}
    {guide === null ? null : <PresetGuideDialog guide={guide.content} initialPage={guide.page} t={t} onClose={() => { setGuide(null) }} />}
    <Modal open={viewed !== null} onClose={closeViewer} closeLabel={t('close')}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeViewer()
        } else trapPresetReaderTab(event)
      }}
      title={viewed === null ? '' : `${t('view')} · ${viewedTitle}`} className={css.dialog as string}
      footer={<Button variant="outline" autoFocus onClick={closeViewer}>{t('close')}</Button>}>
      {viewed === null ? null : <pre className={css.viewerCode}>{viewed.content}</pre>}
    </Modal>
    <Modal open={manual !== null} onClose={() => { if (!manualBusy) setManual(null) }}
      title={manual?.mode === 'edit' ? t('manualEditTitle') : t('manualNewTitle')} closeLabel={t('manualCancel')}
      className={css.formDialog as string}
      footer={<>
        <Button variant="outline" disabled={manualBusy} onClick={() => { setManual(null) }}>{t('manualCancel')}</Button>
        <Button variant="primary" disabled={manualBusy || manual?.loading === true} data-preset-save=""
          onClick={() => { void submitManual() }}>
          {manual?.mode === 'edit' ? t('manualSave') : t('manualCreate')}
        </Button>
      </>}>
      {manual === null ? null : <div className={css.form} data-preset-form="">
        {manual.mode === 'create' && <label className={css.field}>
          <span className={css.fieldLabel}>{t('manualBase')}</span>
          <select className={css.select} data-preset-base="" aria-label={t('manualBase')}
            value={manual.base}
            onChange={(event) => { patchManual({ base: event.target.value }) }}>
            <option value="">—</option>
            {state.rows.filter(row => row.broken === undefined && authoringById.get(row.id)?.hasPersona === true).map(row => (
              <option key={row.id} value={row.id}>{presetDisplayText(row, t).name}</option>
            ))}
          </select>
        </label>}
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('manualId')}</span>
          <Input data-preset-id-input="" aria-label={t('manualId')} value={manual.id}
            disabled={manual.mode === 'edit'} placeholder="my-agent"
            onChange={(event) => { patchManual({ id: event.target.value }) }} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('manualName')}</span>
          <Input data-preset-name-input="" aria-label={t('manualName')} value={manual.name}
            placeholder={t('manualName')}
            onChange={(event) => { patchManual({ name: event.target.value }) }} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('manualDescription')}</span>
          <Input data-preset-description-input="" aria-label={t('manualDescription')} value={manual.description}
            placeholder={t('manualDescription')}
            onChange={(event) => { patchManual({ description: event.target.value }) }} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('manualPersona')}</span>
          <textarea className={css.textarea} data-preset-persona-input="" aria-label={t('manualPersona')} rows={8}
            spellCheck={false} value={manual.suffix} disabled={manual.loading}
            onChange={(event) => { patchManual({ suffix: event.target.value }) }} />
          <span className={css.fieldHint}>{t('manualPersonaHint')}</span>
        </label>
        {manual.error != null && <p className={css.error} role="alert" data-preset-form-error="">{manual.error}</p>}
      </div>}
    </Modal>
    <Modal open={deletingPreset !== null} onClose={() => { setDeletingPreset(null); setDeleteError(null) }}
      title={t('manualDeleteTitle')} closeLabel={t('manualCancel')} className={css.formDialog as string}
      footer={<>
        <Button variant="outline" disabled={manualBusy} onClick={() => { setDeletingPreset(null); setDeleteError(null) }}>{t('manualCancel')}</Button>
        <Button variant="primary" disabled={manualBusy} data-preset-delete-confirm=""
          onClick={() => { void confirmDeletePreset() }}>{t('manualDelete')}</Button>
      </>}>
      <p className={css.confirmText}>{t('manualDeleteConfirm', { name: deletingPreset?.name ?? '' })}</p>
      {deleteError !== null && <p className={css.error} role="alert" data-preset-delete-error="">{deleteError}</p>}
    </Modal>
  </section>
}
