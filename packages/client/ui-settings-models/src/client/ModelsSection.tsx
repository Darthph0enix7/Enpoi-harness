import { useState, useMemo, useEffect } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconPlusOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { ProviderDetailPanel } from './ProviderDetailPanel.tsx'
import { AddProviderModal } from './AddProviderModal.tsx'
import { IconSearch, IconServer } from './capability-icons.tsx'
import { protocolChoices, type ModelsSettingsStore, type ProviderRow } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

export interface ModelsSectionInjected {
  controller: ModelsSettingsStore
  hooks: {
    snapshot: ModelsSettingsStore['store']
  }
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  schema: SettingsSchemaOperations
  t: (key: keyof typeof en) => string
}

export type ModelsSectionProps = Partial<InjectFace<ModelsSectionInjected>>
type ModelsSectionFace = InjectFace<ModelsSectionInjected>

export function ModelsSection(props: ModelsSectionProps): ReactNode {
  const { controller, useSnapshot, api, schema, t } = props
  if (!controller || !useSnapshot || !api || !schema || !t) return null
  return <Loaded injected={{ controller, useSnapshot, api, schema, t }} />
}

function Loaded({ injected }: { injected: ModelsSectionFace }): ReactNode {
  const { controller, api, schema, t } = injected
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
    if (configuredRows.length > 0 && !selectedProviderId) {
      setSelectedProviderId(configuredRows[0].entry.provider)
    } else if (configuredRows.length > 0 && selectedProviderId) {
      const exists = configuredRows.some(r => r.entry.provider === selectedProviderId)
      if (!exists) {
        setSelectedProviderId(configuredRows[0].entry.provider)
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
        await api.credentials.unset({ ref: deleteTarget.apiKeyEnv })
      }
      const res = await api.settings.mutate({
        ns: deleteTarget.entry.settingsNs,
        ops: [{ op: 'unset', path: [...deleteTarget.entry.settingsPath] }],
      })
      if (!res.result.ok) {
        setDeleteError(res.result.error.message)
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
              const ns = state.namespaces.get(row.entry.settingsNs)
              const profile = ns ? (schema.getPath(ns.value, row.entry.settingsPath) as Record<string, unknown> | undefined) : undefined
              const modelCount = Array.isArray(profile?.models) ? profile.models.length : undefined

              return (
                <div
                  key={row.entry.provider}
                  className={`${styles['providerListItem']} ${isSelected ? styles['providerListItemActive'] : ''}`}
                  role="button"
                  tabIndex={0}
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
          <Button
            variant="outline"
            className={styles['addProviderBtn']}
            onClick={() => setAddModalOpen(true)}
            disabled={!state.writable}
          >
            <IconPlusOutline16 size={14} />
            Add Provider
          </Button>
        </div>
      </aside>

      {/* RIGHT MAIN PANEL: Provider Detail */}
      <main className={styles['providerDetailMain']}>
        {selectedRow && selectedNamespace ? (
          <ProviderDetailPanel
            key={selectedRow.entry.provider}
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
        className={styles['deleteDialog']}
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
    </div>
  )
}
