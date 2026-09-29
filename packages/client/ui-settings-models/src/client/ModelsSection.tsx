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
import { protocolChoices, providerKeyConfigured, type ModelsSettingsStore, type ProviderRow, type ModelsWire } from './store.ts'
import { loadHostHeavyManifests, resolveHeavyManifest, useHeavyManifestState } from './heavy-manifest-source.ts'
import { heavyApi } from './heavy-rpc.ts'
import { HeavyDashboardLinks, HeavyStatusDot } from './HeavyProviderStatus.tsx'
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

  // The host's `enpoiHeavy.manifests` reply is the single manifest source:
  // one accepted reply replaces the labelled fallback table and re-renders
  // every heavy surface from host truth.
  const manifestState = useHeavyManifestState()
  useEffect(() => { void loadHostHeavyManifests() }, [])

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [providerSearch, setProviderSearch] = useState('')
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProviderRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [heavyUninstall, setHeavyUninstall] = useState(false)

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

  // Heavy/self-hosted rows render in their own clearly-labelled group AFTER
  // the mainstream providers; the filter above searches both.
  const mainstreamRows = useMemo(
    () => filteredRows.filter(row => resolveHeavyManifest(row.entry.provider) === undefined),
    [filteredRows, manifestState.manifests],
  )
  const heavyRows = useMemo(
    () => filteredRows.filter(row => resolveHeavyManifest(row.entry.provider) !== undefined),
    [filteredRows, manifestState.manifests],
  )

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
    // Only a route that already owns a profile (or serves live) is taken. The
    // joined directory lists every installed catalog provider, so treating that
    // listing as taken forced every catalog add onto a suffixed duplicate the
    // installed catalog cannot describe.
    return state.rows
      .filter(row => row.configured || row.entry.active)
      .map(row => row.entry.provider)
  }, [state.rows])

  // Delete Provider
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    setDeleteError(null)

    try {
      // A HEAVY provider's removal belongs to its manifest: the host plugin
      // runs the teardown and clears route, credential, pool state, cache,
      // and chain links in one confirmed operation. Per-provider confirmation
      // text (and the antigravity OpenCode/dotfiles caveat) is shown above.
      if (resolveHeavyManifest(deleteTarget.entry.provider) !== undefined) {
        const removal = await heavyApi.remove(deleteTarget.entry.provider, heavyUninstall)
        if (!removal.ok) {
          setDeleteError(removal.message)
          setDeleting(false)
          return
        }
        const errors = removal.value.summary?.errors ?? []
        const teardown = removal.value.summary?.teardown
        if (errors.length > 0 || teardown?.ok === false) {
          // Keep the dialog up: the operator must see which named step failed
          // instead of believing the provider was fully removed.
          setDeleteError(`${t('heavyRemoveFailed')}: ${[...errors, teardown?.failedStep ?? ''].filter(Boolean).join('; ')}`)
          setDeleting(false)
          await controller.load()
          return
        }
        setDeleteTarget(null)
        await controller.load()
        return
      }
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

  const heavyDeleteManifest = deleteTarget ? resolveHeavyManifest(deleteTarget.entry.provider) : undefined

  /** One sidebar row; shared by the mainstream list and the heavy group. */
  const renderProviderRow = (row: ProviderRow): ReactNode => {
    const isSelected = row.entry.provider === selectedProviderId
    const isConfigured = providerKeyConfigured(row)
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
          {/* Heavy routes always show their dashboard URL(s) and the cached
                endpoint state, in either mode. */}
          {resolveHeavyManifest(row.entry.provider) !== undefined && (
            <span className={styles['heavyRowMeta']}>
              <HeavyStatusDot providerId={row.entry.provider} t={t} />
              <HeavyDashboardLinks providerId={row.entry.provider} compact t={t} />
            </span>
          )}
        </div>

        {modelCount !== undefined && (
          <span className={styles['providerModelCountPill']}>{modelCount}</span>
        )}
      </div>
    )
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
              <>
                {mainstreamRows.map(renderProviderRow)}
                {/* Self-hosted/heavy providers get their own labelled group
                    AFTER the mainstream list — not first, not buried last. */}
                {heavyRows.length > 0 && (
                  <div className={styles['sidebarGroupLabel']}>{t('heavyGroup')}</div>
                )}
                {heavyRows.map(renderProviderRow)}
              </>
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
              onDelete={() => { setHeavyUninstall(false); setDeleteTarget(selectedRow) }}
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
          onClose={async (created) => {
            // The modal stays up until the join that renders the new row has
            // answered, so the provider is on screen when the form goes away.
            try {
              if (created) await controller.load()
            } finally {
              setAddModalOpen(false)
            }
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
                {deleting ? (heavyDeleteManifest !== undefined && heavyUninstall ? t('heavyRemoving') : t('deletingAction')) : t('confirmDeleteAction')}
              </Button>
            </>
          }
        >
          {deleteError && <p className={styles['error']}>{deleteError}</p>}
          {heavyDeleteManifest !== undefined && (
            <div className={styles['heavyPanel']}>
              <div className={styles['heavySectionLabel']}>{t('heavyRemoveWarnings')}</div>
              <ul className={styles['heavyList']}>
                {heavyDeleteManifest.removal.warnings.map(warning => <li key={warning}>{warning}</li>)}
              </ul>
              {heavyDeleteManifest.removal.steps.length > 0 && (
                <label className={styles['heavyMode']}>
                  <input
                    type="checkbox"
                    checked={heavyUninstall}
                    disabled={deleting}
                    onChange={event => setHeavyUninstall(event.target.checked)}
                  />
                  <span>{t('heavyAlsoUninstall')}</span>
                </label>
              )}
            </div>
          )}
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
