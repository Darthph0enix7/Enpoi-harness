/**
 * Skills settings section — manual skill management over the UI: list every
 * skill (profile rows editable, registry rows read-only), create a directory
 * bundle, edit its description and Markdown body, and delete through the
 * host's trash-staging route. Writes go through the fenced `/sidebar/fsops`
 * `skills.*` routes; the host refuses traversal and the shipped tier skills,
 * and the skill-filesystem watcher refreshes the agent catalog without a
 * restart.
 */
import { useEffect, useState } from 'react'
import { Button, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillsSettingsKey } from './locales.ts'
import {
  createSkill,
  deleteSkill,
  isSkillName,
  listSkills,
  newestSessionId,
  readSkill,
  SkillsApiError,
  updateSkill,
  type SkillRow,
  type SkillSource,
  type SkillsListValue,
} from './skills-api.ts'
import css from './SkillsSettings.module.css'

/** Props assembled by the settings renderer. */
export type SkillsSettingsProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.skills'>

/** One open form (create or edit). */
interface FormState {
  mode: 'create' | 'edit'
  name: string
  description: string
  body: string
  /** Read/write/validation failure shown inside the dialog. */
  error: string | null
  /** Edit loads the body before the fields are usable. */
  loading: boolean
}

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; value: SkillsListValue }
  | { status: 'error'; message: string }

function errorMessage(error: unknown): string {
  if (error instanceof SkillsApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/** Locale key for one row's source badge. */
function sourceKey(source: SkillSource): SkillsSettingsKey {
  if (source === 'default') return 'sourceDefault'
  if (source === 'registry') return 'sourceInstalled'
  return 'sourceProfile'
}

/** Render the skills list and its create/edit/delete dialogs. */
export function SkillsSettings({ t }: SkillsSettingsProps) {
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [form, setForm] = useState<FormState | null>(null)
  const [deleting, setDeleting] = useState<SkillRow | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setList({ status: 'loading' })
    void (async () => {
      const sessionId = await newestSessionId()
      const value = await listSkills(sessionId)
      if (!cancelled) setList({ status: 'ready', value })
    })().catch((error: unknown) => {
      if (!cancelled) setList({ status: 'error', message: errorMessage(error) })
    })
    return () => { cancelled = true }
  }, [reloadToken])

  const reload = (): void => { setReloadToken(token => token + 1) }

  const patchForm = (patch: Partial<FormState>): void => {
    setForm(current => current === null ? current : { ...current, ...patch })
  }

  const openCreate = (): void => {
    setForm({ mode: 'create', name: '', description: '', body: '', error: null, loading: false })
  }

  const openEdit = (row: SkillRow): void => {
    setForm({ mode: 'edit', name: row.name, description: row.description, body: '', error: null, loading: true })
    void readSkill(row.name).then((detail) => {
      setForm(current => current === null || current.mode !== 'edit' || current.name !== row.name
        ? current
        : { ...current, description: detail.description, body: detail.body, loading: false })
    }).catch((error: unknown) => {
      setForm(current => current === null || current.mode !== 'edit' || current.name !== row.name
        ? current
        : { ...current, error: t('detailFailed', { reason: errorMessage(error) }), loading: false })
    })
  }

  const saveForm = async (): Promise<void> => {
    if (form === null || form.loading || busy) return
    const name = form.name.trim()
    const description = form.description.trim()
    if (!isSkillName(name)) { patchForm({ error: t('nameRequired') }); return }
    if (description === '') { patchForm({ error: t('descriptionRequired') }); return }
    setBusy(true)
    patchForm({ error: null })
    try {
      const input = { name, description, body: form.body }
      if (form.mode === 'create') await createSkill(input)
      else await updateSkill(input)
      setForm(null)
      reload()
    } catch (error: unknown) {
      patchForm({ error: t('saveFailed', { reason: errorMessage(error) }) })
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null || busy) return
    setBusy(true)
    setDeleteError(null)
    try {
      await deleteSkill(deleting.name)
      setDeleting(null)
      reload()
    } catch (error: unknown) {
      setDeleteError(t('deleteFailed', { reason: errorMessage(error) }))
    } finally {
      setBusy(false)
    }
  }

  const closeDelete = (): void => {
    setDeleting(null)
    setDeleteError(null)
  }

  const rows = list.status === 'ready' ? list.value.skills : []

  return (
    <section className={css.container} data-skills-section="" aria-label={t('nav')}>
      <header className={css.head}>
        <div className={css.headText}>
          <h2 className={css.title}>{t('nav')}</h2>
          <p className={css.intro}>{t('sectionIntro')}</p>
        </div>
        <Button variant="primary" size="sm" data-skills-new="" onClick={openCreate}>
          {t('newSkill')}
        </Button>
      </header>

      {list.status === 'error' && (
        <div className={css.errorRow} role="alert">
          <span className={css.errorLine} data-skills-error="">{t('loadFailed')}: {list.message}</span>
          <button type="button" className={css.retryBtn} onClick={reload}>{t('retry')}</button>
        </div>
      )}
      {list.status === 'ready' && list.value.registry.ok === false && (
        <p className={css.hintDim} data-skills-registry-warning="">
          {t('registryUnavailable', { reason: list.value.registry.error })}
        </p>
      )}
      {list.status === 'loading' && <p className={css.empty} data-skills-loading="">{t('loading')}</p>}
      {list.status === 'ready' && rows.length === 0 && (
        <p className={css.empty} data-skills-empty="">{t('empty')}</p>
      )}

      <ul className={css.rows}>
        {rows.map(row => (
          <li className={css.row} key={`${row.source}:${row.name}`} data-skill-row={row.name}>
            <div className={css.rowInfo}>
              <div className={css.rowName}>
                <span>{row.name}</span>
                <Tag tone={row.protected ? 'warning' : 'outline'}>{t(sourceKey(row.source))}</Tag>
                {row.protected && <Tag tone="neutral">{t('protectedBadge')}</Tag>}
                {!row.editable && <Tag tone="quiet">{t('readOnlyBadge')}</Tag>}
              </div>
              {row.description !== '' && <div className={css.rowDesc}>{row.description}</div>}
              {row.path !== undefined && <div className={css.rowPath} title={row.path}>{row.path}</div>}
            </div>
            {row.editable && (
              <div className={css.rowActions}>
                <button
                  type="button"
                  className={css.actionBtn}
                  data-skill-edit={row.name}
                  aria-label={`${t('edit')}: ${row.name}`}
                  onClick={() => { openEdit(row) }}
                >
                  {t('edit')}
                </button>
                <button
                  type="button"
                  className={css.actionBtnDanger}
                  data-skill-delete={row.name}
                  aria-label={`${t('delete')}: ${row.name}`}
                  onClick={() => { setDeleteError(null); setDeleting(row) }}
                >
                  {t('delete')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {list.status === 'ready' && list.value.root !== '' && <div className={css.foot}>{list.value.root}</div>}

      <Modal
        open={form !== null}
        onClose={() => { if (!busy) setForm(null) }}
        title={form?.mode === 'edit' ? t('editTitle') : t('newTitle')}
        closeLabel={t('cancel')}
        footer={<>
          <Button variant="outline" disabled={busy} onClick={() => { setForm(null) }}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || form?.loading === true} data-skill-save="" onClick={() => { void saveForm() }}>
            {form?.mode === 'edit' ? t('save') : t('create')}
          </Button>
        </>}
      >
        <div className={css.form} data-skills-form="">
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldName')}</span>
            <Input
              data-skill-name-input=""
              aria-label={t('fieldName')}
              value={form?.name ?? ''}
              disabled={form?.mode === 'edit'}
              placeholder={t('namePlaceholder')}
              onChange={(event) => { patchForm({ name: event.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldDescription')}</span>
            <Input
              data-skill-description-input=""
              aria-label={t('fieldDescription')}
              value={form?.description ?? ''}
              placeholder={t('descriptionPlaceholder')}
              onChange={(event) => { patchForm({ description: event.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('fieldBody')}</span>
            <textarea
              className={css.textarea}
              data-skill-body-input=""
              aria-label={t('fieldBody')}
              rows={12}
              spellCheck={false}
              placeholder={t('bodyPlaceholder')}
              value={form?.body ?? ''}
              disabled={form?.loading === true}
              onChange={(event) => { patchForm({ body: event.target.value }) }}
            />
          </label>
          {form?.error != null && <p className={css.actionError} role="alert" data-skills-form-error="">{form.error}</p>}
        </div>
      </Modal>

      <Modal
        open={deleting !== null}
        onClose={closeDelete}
        title={t('deleteTitle')}
        closeLabel={t('cancel')}
        footer={<>
          <Button variant="outline" disabled={busy} onClick={closeDelete}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy} data-skill-delete-confirm="" onClick={() => { void confirmDelete() }}>
            {t('delete')}
          </Button>
        </>}
      >
        <p className={css.confirmText}>{t('deleteConfirm', { name: deleting?.name ?? '' })}</p>
        {deleteError !== null && <p className={css.actionError} role="alert" data-skills-delete-error="">{deleteError}</p>}
      </Modal>
    </section>
  )
}
