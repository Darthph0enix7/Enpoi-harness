import { useState, useMemo, useEffect, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import { ProviderDetailPanel } from './ProviderDetailPanel.tsx'
import { AddProviderModal } from './AddProviderModal.tsx'
import { IconSearch, IconServer } from './capability-icons.tsx'
import { protocolChoices, type ModelsSettingsStore, type ProviderRow, type ModelsWire } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

export interface ModelsSectionInjected {
  controller: ModelsSettingsStore
  hooks: {
    snapshot: ModelsSettingsStore['store']
  }
  api: ModelsWire
  schema: SettingsSchemaOperations
  t: (key: keyof typeof en) => string
}

type ModelsChildSlots = 'settings.models.provider-card' | 'settings.models.footer'
type ModelsRenderSlot = PropsRenderSlots<ModelsChildSlots>['renderSlot']

export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>> & PropsRenderSlots<ModelsChildSlots>
type ModelsSectionFace = InjectFace<ModelsSectionInjected>

export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const propsAny = props as unknown as ModelsSectionProps & { hooks?: ModelsSectionInjected['hooks']; renderSlot?: ModelsRenderSlot; useSnapshot?: (sel:(s:any)=>any)=>any }
  const { controller, api, schema, t } = propsAny
  const renderSlot = propsAny.renderSlot
  const hooks = propsAny.hooks
  // Renderer binds hooks.snapshot as useSnapshot prop in some engines; support both
  const useSnapshot = propsAny.useSnapshot
  if (!controller || !api || !schema || !t) return null
  // If renderer provided useSnapshot hook, use it; else fall back to store subscription
  return <Loaded injected={{ controller, hooks: { snapshot: (hooks?.snapshot ?? (controller as ModelsSettingsStore).store) } as unknown as ModelsSectionInjected['hooks'], api, schema, t } as unknown as ModelsSectionFace} renderSlot={renderSlot as ModelsRenderSlot} useSnapshot={useSnapshot} />
}

function Loaded({ injected, renderSlot, useSnapshot }: { injected: ModelsSectionFace; renderSlot?: ModelsRenderSlot | undefined; useSnapshot?: ((sel:(s:any)=>any)=>any) | undefined }): ReactNode {
  const { controller, api, schema, t } = injected as unknown as { controller: ModelsSettingsStore; api: ModelsWire; schema: SettingsSchemaOperations; t: (k:keyof typeof en)=>string }
  const store = (injected as unknown as { hooks: { snapshot: ModelsSettingsStore['store'] } }).hooks.snapshot
  const state = useSnapshot
    ? useSnapshot((s: import('./store.ts').ModelsSettingsState) => s) as import('./store.ts').ModelsSettingsState
    : useSyncExternalStore(store.subscribe.bind(store), store.getSnapshot.bind(store), store.getSnapshot.bind(store))

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [providerSearch, setProviderSearch] = useState('')
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProviderRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

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
      if (deleteTarget.apiKeyEnv) {
        const credRes = await api.credentials.unset(deleteTarget.apiKeyEnv)
        if (!credRes.ok) {
          setDeleteError(credRes.error.message)
          setDeleting(false)
          return
        }
      }
      const res = await api.settings.mutate(
        deleteTarget.entry.settingsNs,
        [{ op: 'unset', path: [...deleteTarget.entry.settingsPath] }],
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

  // Add an EMPTY provider entry directly (classic flow): the user fills
  // displayName/baseURL/key in the detail panel. baseURL needs a non-empty
  // placeholder because llm-pi-ai's schema refuses empty strings.
  const handleAddEmpty = async () => {
    if (addBusy || !state.writable) return
    setAddBusy(true)
    setAddError(null)
    try {
      let id = 'provider'
      let counter = 1
      while (takenProviderIds.includes(id)) {
        id = `provider-${counter++}`
      }
      const profileData: Record<string, unknown> = {
        displayName: 'New Provider',
        api: protocols.includes('openai-completions') ? 'openai-completions' : protocols[0] || 'openai-completions',
        baseURL: 'http://localhost:8080/v1',
        // Placeholder model: llm-pi-ai refuses a route the catalog does not
        // describe without a models list. The user replaces it via
        // "Refresh Models" in the detail panel (live discovery).
        models: [{ id: 'auto' }],
      }
      const res = await api.settings.mutate(
        'llm-pi-ai',
        [{ op: 'set', path: ['providers', id], value: profileData as import('@deepseek-ai/dsh-api-remotes/client').JsonValue }],
        undefined,
      )
      if (!res.ok) {
        setAddError(res.error.message)
        return
      }
      await controller.load()
      setSelectedProviderId(id)
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err))
    } finally {
      setAddBusy(false)
    }
  }

  if (state.status === 'loading' && state.rows.length === 0) {
    return (
      <div className={styles['loadingState']}>
        <div className={styles['spinner']} />
        <span>Loading model providers...</span>
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
    <div className={styles['masterDetailLayout']}>
      {/* LEFT SIDEBAR: Provider List */}
      <aside className={styles['providersSidebar']}>
        <div className={styles['sidebarHeader']}>
          <div className={styles['sidebarTitleRow']}>
            <span className={styles['sidebarTitle']}>Providers</span>
            <span className={styles['providerCountBadge']}>{configuredRows.length}</span>
          </div>

          <div className={styles['sidebarSearchWrap']}>
            <IconSearch size={13} />
            <input
              className={styles['sidebarSearchInput']}
              type="text"
              placeholder="Filter providers..."
              value={providerSearch}
              onChange={e => setProviderSearch(e.target.value)}
            />
          </div>
        </div>

        <div className={styles['providerListScrollable']}>
          {filteredRows.length === 0 ? (
            <div className={styles['emptySidebar']}>No providers found.</div>
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
                    title={isConfigured ? 'Connected' : 'Missing API Key'}
                  />

                  <div className={styles['providerListInfo']}>
                    <div className={styles['providerListNameRow']}>
                      <span className={styles['providerListName']}>{row.entry.displayName}</span>
                      {row.entry.declared && <span className={styles['customTagSmall']}>Custom</span>}
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
          {addError && <span className={styles['addError']}>{addError}</span>}
          <div className={styles['sidebarFooterRow']}>
            <Button
              variant="outline"
              className={styles['addProviderBtn']}
              onClick={() => void handleAddEmpty()}
              disabled={!state.writable || addBusy}
              title="Add an empty provider entry"
            >
              <IconPlusOutline16 size={14} />
              {addBusy ? 'Adding...' : 'Add Provider'}
            </Button>
            <Button
              variant="ghost"
              className={styles['browseCatalogBtn']}
              onClick={() => setAddModalOpen(true)}
              disabled={!state.writable}
              title="Browse the 212-provider catalog"
            >
              <IconServer size={14} />
              Catalog
            </Button>
          </div>
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
            <h3>No Provider Selected</h3>
            <p>Select a provider from the list or add a new one to manage models and API keys.</p>
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
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete ${deleteTarget.entry.displayName}?` : ''}
        closeLabel={t('close')}
        description={
          deleteTarget
            ? `Deleting "${deleteTarget.entry.displayName}" (${deleteTarget.entry.provider}) will remove its configuration and any stored API key reference.`
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
              {deleting ? 'Deleting...' : 'Confirm Delete'}
            </Button>
          </>
        }
      >
        {deleteError && <p className={styles['error']}>{deleteError}</p>}
      </Modal>
      {renderSlot ? renderSlot('settings.models.footer', {}) : null}
    </div>
  )
}

/** Formats a provider's target label (e.g. "DeepSeek (deepseek-official)"). */
export function providerTargetLabel(target: { provider: string; displayName: string }): string {
  return target.displayName === target.provider ? target.displayName : `${target.displayName} (${target.provider})`
}

/** Injects a provider target label into a localized template string. */
export function providerCopy(template: string, target: { provider: string; displayName: string }): string {
  return template.replace('{provider}', providerTargetLabel(target))
}

/** Returns whether a provider row requires setup. */
export function needsSetup(row: ProviderRow | undefined, readOnly: boolean): boolean {
  return !readOnly && !row?.configured
}

/** Helper to remove a provider profile from settings. */
export async function removeProviderProfile(
  face: { api: Pick<ModelsWire, 'settings' | 'credentials'>; t?: (key: keyof typeof en) => string },
  _controller: ModelsSettingsStore,
  target: { settingsNs: string; settingsPath: string[]; credentialRef?: string },
): Promise<string | null> {
  if (target.credentialRef) {
    const credRes = await face.api.credentials.unset(target.credentialRef)
    if (!credRes.ok && credRes.error) {
      return credRes.error.message
    }
  }

  const settingsRes = await face.api.settings.mutate(
    target.settingsNs,
    [{ op: 'unset', path: target.settingsPath }],
    undefined,
  )
  if (!settingsRes.ok) {
    return settingsRes.error.message
  }
  return null
}
