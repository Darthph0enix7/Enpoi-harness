/**
 * Models settings section: the fork's master-detail page. The left sidebar
 * lists every configured provider (status dot, name, model count, add and
 * delete) with a client-side filter; the right main panel is the selected
 * row's {@link ProviderDetailPanel} — API key and Test Connection, base URL
 * and protocol editing, the model catalog with capability badges, context
 * windows and hidden-eye toggles, and the Key Pool identities editor. The
 * section footer dispatches the extension seat that carries the Usage &
 * Quota card.
 *
 * The page renders from the shared settings mirror the store joins (settings
 * namespaces + credential state + the configurable-provider directory) and
 * reloads on every pushed invalidation; every mutation writes through the
 * injected Remote faces and the page re-renders from the next describe.
 */

import { useState, useMemo, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the model namespace merge for the shared picker's copy seat.
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
// Type-only: pulls this package's SlotMap merge (the two Models child slots).
import type {} from './slot-contract.ts'
import { ProviderDetailPanel } from './ProviderDetailPanel.tsx'
import { AddProviderModal } from './AddProviderModal.tsx'
import { ModelGroupsRow } from './ModelGroupsRow.tsx'
import { ORCHESTRATION_NS } from './model-groups.ts'
import type { ModelPickerFace } from './picker-face.ts'
import { IconSearch, IconServer } from './capability-icons.tsx'
import { protocolChoices, type ModelsSettingsStore, type ProviderRow, type ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected dependencies of {@link ModelsSection} (slot `inject`). */
export interface ModelsSectionInjected {
  /** The page store (loaded on mount, refreshed on pushed invalidations). */
  controller: ModelsSettingsStore
  hooks: {
    /** Page snapshot bound by the UI renderer as useSnapshot. */
    snapshot: ModelsSettingsStore['store']
  }
  /** The Remote faces the detail panel and the add modal read and write through. */
  api: ModelsWire
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Section copy. */
  t: (key: keyof typeof en, params?: Record<string, unknown>) => string
  /**
   * Catalog-backed picker face for the Model groups link editor, or null when
   * the shared model directory service is not mounted.
   */
  picker: ModelPickerFace | null
  /** The shared picker's own copy seat (`model` namespace). */
  modelT: TranslateNS<'model'>
}

/** The child slots this section declares and dispatches (see ./slot-contract.ts). */
type ModelsChildSlots = 'settings.models.provider-card' | 'settings.models.footer'

/** The child-slot dispatch function the renderer binds for the section. */
type ModelsRenderSlot = PropsRenderSlots<ModelsChildSlots>['renderSlot']

/** Props delivered by the slot outlet: the inject face spread flat plus the child-slot dispatch seat. */
export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>> & PropsRenderSlots<ModelsChildSlots>
type ModelsSectionFace = InjectFace<ModelsSectionInjected>

/**
 * Render the Models section, or nothing while the shell has not injected its
 * dependencies yet.
 * @param props - slot-delivered injected dependencies and child-slot seat.
 * @returns the master-detail page.
 */
export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, schema, t, renderSlot, picker, modelT } = props
  if (
    controller === undefined || useSnapshot === undefined || api === undefined
    || schema === undefined || t === undefined || modelT === undefined
  ) return null
  return <Loaded injected={{ controller, useSnapshot, api, schema, t, picker: picker ?? null, modelT }} renderSlot={renderSlot} />
}

function Loaded({ injected, renderSlot }: { injected: ModelsSectionFace; renderSlot: ModelsRenderSlot }): ReactNode {
  const { controller, api, schema, t, picker, modelT } = injected
  const state = injected.useSnapshot(snapshot => snapshot)

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [providerSearch, setProviderSearch] = useState('')
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProviderRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Ensure store is loaded
  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  // Configured rows
  const configuredRows = useMemo(() => {
    return state.rows.filter(row => row.configured)
  }, [state.rows])

  // Auto-select first provider if none selected
  useEffect(() => {
    const first = configuredRows[0]
    if (first && !selectedProviderId) {
      setSelectedProviderId(first.entry.provider)
    } else if (first && selectedProviderId) {
      const exists = configuredRows.some(r => r.entry.provider === selectedProviderId)
      if (!exists) {
        setSelectedProviderId(first.entry.provider)
      }
    }
  }, [configuredRows, selectedProviderId])

  // Filtered providers
  const filteredRows = useMemo(() => {
    const q = providerSearch.toLowerCase().trim()
    if (!q) return configuredRows
    return configuredRows.filter(
      r =>
        r.entry.displayName.toLowerCase().includes(q) ||
        r.entry.provider.toLowerCase().includes(q),
    )
  }, [configuredRows, providerSearch])

  // Selected row
  const selectedRow = useMemo(() => {
    return configuredRows.find(r => r.entry.provider === selectedProviderId) || null
  }, [configuredRows, selectedProviderId])

  const selectedNamespace = useMemo(() => {
    if (!selectedRow) return undefined
    return state.namespaces.get(selectedRow.entry.settingsNs)
  }, [selectedRow, state.namespaces])

  // 0ms pool: cache per-provider model counts so left list does not walk schema.getPath 20× per switch
  const modelCountByProvider = useMemo(() => {
    const m = new Map<string, number | undefined>()
    for (const row of configuredRows) {
      const ns = state.namespaces.get(row.entry.settingsNs)
      const profile = ns ? (schema.getPath(ns.value, row.entry.settingsPath) as Record<string, unknown> | undefined) : undefined
      m.set(row.entry.provider, Array.isArray(profile?.models) ? (profile.models as unknown[]).length : undefined)
    }
    return m
  }, [configuredRows, state.namespaces, schema])

  // Protocols for Custom Add
  const protocols = useMemo(() => {
    return protocolChoices(state.namespaces.get('llm-pi-ai'), schema)
  }, [schema, state.namespaces])

  const takenProviderIds = useMemo(() => {
    return state.rows.map(r => r.entry.provider)
  }, [state.rows])

  // Delete Provider
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    setDeleteError(null)

    try {
      // A shipped route addresses the whole section: its removal is the
      // namespace's own `disabled` flag, and its credential may be shared with
      // another route (the fork's llm-pi-ai deepseek profile names the same
      // DEEPSEEK_API_KEY), so a route removal never unsets the credential.
      const shipped = deleteTarget.entry.settingsPath.length === 0
      if (!shipped && deleteTarget.apiKeyEnv) {
        const credRes = await api.credentials.unset(deleteTarget.apiKeyEnv)
        if (!credRes.ok) {
          setDeleteError(credRes.error.message)
          setDeleting(false)
          return
        }
      }
      const res = await api.settings.mutate(
        deleteTarget.entry.settingsNs,
        shipped
          ? [{ op: 'set', path: ['disabled'], value: true }]
          : [{ op: 'unset', path: [...deleteTarget.entry.settingsPath] }],
        undefined,
      )
      if (!res.ok) {
        setDeleteError(res.error.message)
        setDeleting(false)
        return
      }
      setDeleteTarget(null)
      await controller.load()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  if (state.status === 'loading' && state.rows.length === 0) {
    return (
      <div className={styles['loadingState']}>
        <div className={styles['spinner']} />
        <span>{t('providersLoading')}</span>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}: ${state.error}`}</p>
        <Button variant="outline" onClick={() => void controller.load()}>
          {t('retry')}
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className={styles['masterDetailLayout']}>
        {/* LEFT SIDEBAR: Provider List */}
        <aside className={styles['providersSidebar']}>
          <div className={styles['sidebarHeader']}>
            <div className={styles['sidebarTitleRow']}>
              <span className={styles['sidebarTitle']}>{t('providersTitle')}</span>
              <span className={styles['providerCountBadge']}>{configuredRows.length}</span>
            </div>

            <div className={styles['sidebarSearchWrap']}>
              <IconSearch size={13} />
              <input
                className={styles['sidebarSearchInput']}
                type="text"
                placeholder={t('providersFilterPlaceholder')}
                value={providerSearch}
                onChange={e => setProviderSearch(e.target.value)}
              />
            </div>
          </div>

          <div className={styles['providerListScrollable']}>
            {filteredRows.length === 0 ? (
              <div className={styles['emptySidebar']}>{t('providersEmpty')}</div>
            ) : (
              filteredRows.map((row) => {
                const isSelected = row.entry.provider === selectedProviderId
                const isConfigured = row.credential?.configured === true || !row.apiKeyEnv
                const modelCount = modelCountByProvider.get(row.entry.provider)

                return (
                  <div
                    key={row.entry.provider}
                    className={`${styles['providerListItem']} ${isSelected ? styles['providerListItemActive'] : ''}`}
                    role="button"
                    tabIndex={0}
                    // 0ms optimistic: synchronous state switch, no await before DOM update
                    onClick={() => setSelectedProviderId(row.entry.provider)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setSelectedProviderId(row.entry.provider)
                    }}
                  >
                    <span
                      className={`${styles['providerStatusDot']} ${
                        isConfigured ? styles['statusDotGreen'] : styles['statusDotYellow']
                      }`}
                      title={isConfigured ? t('providerConnected') : t('providerMissingKey')}
                    />

                    <div className={styles['providerListInfo']}>
                      <div className={styles['providerListNameRow']}>
                        <span className={styles['providerListName']}>{row.entry.displayName}</span>
                        {row.entry.declared && <span className={styles['customTagSmall']}>{t('customTag')}</span>}
                      </div>
                      <span className={styles['providerListSlug']}>{row.entry.provider}</span>
                    </div>

                    {modelCount !== undefined && (
                      <span className={styles['providerModelCountPill']}>{modelCount}</span>
                    )}
                  </div>
                )
              })
            )}
          </div>

          <div className={styles['sidebarFooter']}>
            <Button
              variant="outline"
              className={styles['addProviderBtn']}
              onClick={() => setAddModalOpen(true)}
              disabled={!state.writable}
            >
              <IconPlusOutlineRegular size={14} />
              {t('addProviderAction')}
            </Button>
          </div>
        </aside>

        {/* RIGHT MAIN PANEL: Provider Detail */}
        <main className={styles['providerDetailMain']}>
          {selectedRow && selectedNamespace ? (
            <ProviderDetailPanel
              row={selectedRow}
              namespace={selectedNamespace}
              schema={schema}
              api={api}
              t={t}
              readOnly={!state.writable}
              onDelete={() => setDeleteTarget(selectedRow)}
              onSaved={() => void controller.load()}
            />
          ) : (
            <div className={styles['emptyDetail']}>
              <div className={styles['emptyDetailIcon']}>
                <IconServer size={32} />
              </div>
              <h3>{t('noProviderSelected')}</h3>
              <p>{t('noProviderSelectedHint')}</p>
            </div>
          )}
        </main>

        {/* ADD PROVIDER MODAL */}
        <AddProviderModal
          open={addModalOpen}
          taken={takenProviderIds}
          protocols={protocols}
          api={api}
          t={t}
          readOnly={!state.writable}
          onClose={(created) => {
            setAddModalOpen(false)
            if (created) void controller.load()
          }}
        />

        {/* DELETE CONFIRMATION MODAL */}
        <Modal
          open={deleteTarget !== null}
          // A delete in flight keeps the dialog up: dismissing it would hide a
          // failure and leave the operator believing the provider was removed.
          onClose={() => { if (!deleting) setDeleteTarget(null) }}
          title={deleteTarget ? providerCopy(t('deleteTitle'), deleteTarget.entry) : ''}
          closeLabel={t('close')}
          description={
            deleteTarget
              ? providerCopy(
                deleteTarget.apiKeyEnv && deleteTarget.entry.settingsPath.length > 0
                  ? t('deleteDescriptionWithCredential')
                  : t('deleteDescription'),
                deleteTarget.entry,
              )
              : ''
          }
          className={styles['deleteDialog'] ?? ''}
          footer={
            <>
              <Button variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="outline"
                className={styles['deleteConfirmBtn']}
                disabled={deleting}
                onClick={confirmDelete}
              >
                {deleting ? t('deletingAction') : t('confirmDeleteAction')}
              </Button>
            </>
          }
        >
          {deleteError && <p className={styles['error']}>{deleteError}</p>}
        </Modal>
      </div>
      {/* MODEL GROUPS: a full-width row below the master-detail page. It
          renders nothing while no group exists, and it is the only creation
          surface, so the picker and provider list carry no group chrome. */}
      <ModelGroupsRow
        namespace={state.namespaces.get(ORCHESTRATION_NS)}
        api={api}
        readOnly={!state.writable}
        picker={picker}
        t={t}
        modelT={modelT}
        onSaved={() => void controller.load()}
      />
      {/* Extensions (pool usage & quota, catalog helpers). Rendered FULL-WIDTH
          below the master-detail row: inside the flex row it became a third
          column that compressed the provider list and detail into unusable
          widths. */}
      {renderSlot('settings.models.footer', {})}
    </>
  )
}

/** Formats a provider's target label (e.g. "DeepSeek (deepseek-official)"). */
export function providerTargetLabel(target: { provider: string; displayName: string }): string {
  return target.displayName === target.provider ? target.displayName : `${target.displayName} (${target.provider})`
}

/** Injects a provider target label into a localized template string. */
export function providerCopy(template: string, target: { provider: string; displayName: string }): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

/** Returns whether a provider row requires setup. */
export function needsSetup(row: ProviderRow | undefined, readOnly: boolean): boolean {
  return !readOnly && !row?.configured
}

/** Helper to remove a provider route from settings. */
export async function removeProviderProfile(
  face: { api: Pick<ModelsWire, 'settings' | 'credentials'>; t?: (key: keyof typeof en) => string },
  _controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: string[]; credentialRef?: string },
): Promise<string | null> {
  // An empty settings path means the shipped route's address is its whole
  // namespace: removal is the namespace's own `disabled` flag, and a
  // credential the route names may be shared with another profile that has to
  // keep working, so it stays.
  const shipped = target.settingsPath.length === 0
  if (!shipped && target.credentialRef) {
    const credRes = await face.api.credentials.unset(target.credentialRef)
    if (!credRes.ok && credRes.error) {
      return credRes.error.message
    }
  }

  const settingsRes = await face.api.settings.mutate(
    target.settingsNs,
    shipped
      ? [{ op: 'set', path: ['disabled'], value: true }]
      : [{ op: 'unset', path: target.settingsPath }],
    undefined,
  )
  if (!settingsRes.ok) {
    return settingsRes.error.message
  }
  return null
}
