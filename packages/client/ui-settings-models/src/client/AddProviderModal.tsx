import { useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { PROVIDER_TEMPLATES, type ProviderTemplate } from './provider-templates.ts'
import { deriveKeyRef, messageOf, type ModelsWire } from './store.ts'
import { IconSearch, IconServer } from './capability-icons.tsx'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

export interface AddProviderModalProps {
  open: boolean
  taken: readonly string[]
  protocols: readonly string[]
  api: ModelsWire
  t: (key: keyof typeof en) => string
  readOnly: boolean
  onClose: (created?: boolean) => void
}

export function AddProviderModal(props: AddProviderModalProps): ReactNode {
  const { open, taken, protocols, api, t, readOnly, onClose } = props
  const [search, setSearch] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState<ProviderTemplate | 'custom' | null>(null)

  // Form fields
  const [providerId, setProviderId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [protocol, setProtocol] = useState<string>('openai-completions')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const filteredTemplates = PROVIDER_TEMPLATES.filter((tpl) => {
    const q = search.toLowerCase().trim()
    if (!q) return true
    return tpl.name.toLowerCase().includes(q) || tpl.description.toLowerCase().includes(q) || tpl.id.toLowerCase().includes(q)
  })

  const handleSelectTemplate = (tpl: ProviderTemplate) => {
    setSelectedTemplate(tpl)
    // Find unique ID
    let candidateId = tpl.id
    let counter = 1
    while (taken.includes(candidateId)) {
      candidateId = `${tpl.id}-${counter++}`
    }
    setProviderId(candidateId)
    setDisplayName(tpl.name)
    setProtocol(tpl.api)
    setBaseURL(tpl.defaultBaseURL ?? '')
    setApiKey('')
    setError(null)
  }

  const handleSelectCustom = () => {
    setSelectedTemplate('custom')
    let candidateId = 'custom'
    let counter = 1
    while (taken.includes(candidateId)) {
      candidateId = `custom-${counter++}`
    }
    setProviderId(candidateId)
    setDisplayName('Custom Provider')
    setProtocol(protocols.includes('openai-completions') ? 'openai-completions' : protocols[0] || 'openai-completions')
    setBaseURL('')
    setApiKey('')
    setError(null)
  }

  const handleBack = () => {
    setSelectedTemplate(null)
    setError(null)
  }

  const handleCreate = async () => {
    const id = providerId.trim().toLowerCase()
    if (!id || !/^[a-z][a-z0-9-_]*$/.test(id)) {
      setError(t('customRouteInvalid'))
      return
    }
    if (taken.includes(id)) {
      setError(t('customRouteTaken'))
      return
    }
    if (!baseURL.trim()) {
      setError(t('customNeedsBaseUrl'))
      return
    }

    setBusy(true)
    setError(null)

    try {
      const keyRef = deriveKeyRef(id)
      const cleanKey = apiKey.trim()

      const profileData: Record<string, unknown> = {
        displayName: displayName.trim() || id,
        api: protocol,
        baseURL: baseURL.trim(),
        ...cleanKey.length > 0 ? { apiKeyEnv: keyRef } : {},
      }

      // Save credential if entered
      if (cleanKey.length > 0) {
        const credRes = await api.credentials.set(keyRef, cleanKey)
        if (!credRes.ok) {
          setError(credRes.error.message)
          setBusy(false)
          return
        }
      }

      // Mutate llm-pi-ai settings namespace
      const settingsRes = await api.settings.mutate(
        'llm-pi-ai',
        [{ op: 'set', path: ['providers', id], value: profileData as JsonValue }],
        undefined,
      )

      if (!settingsRes.ok) {
        setError(settingsRes.error.message)
        setBusy(false)
        return
      }

      onClose(true)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => onClose(false)}
      title={selectedTemplate === null ? t('add') : `Add ${displayName || 'Provider'}`}
      closeLabel={t('close')}
      className={styles['addProviderDialog'] ?? ''}
      footer={
        selectedTemplate === null ? (
          <Button variant="outline" onClick={() => onClose(false)}>
            {t('cancel')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={handleBack}>
              Back
            </Button>
            <Button variant="primary" disabled={busy || readOnly} onClick={handleCreate}>
              {busy ? t('creating') : t('create')}
            </Button>
          </>
        )
      }
    >
      {selectedTemplate === null ? (
        <div className={styles['templatePickerContainer']}>
          <div className={styles['templateSearchRow']}>
            <div className={styles['searchWrap']}>
              <IconSearch size={14} />
              <input
                className={styles['searchInput']}
                type="text"
                placeholder="Search provider templates (OpenAI, Anthropic, Gemini, Ollama...)"
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
              />
            </div>
            <Button variant="outline" className={styles['customBtn']} onClick={handleSelectCustom}>
              Custom Provider
            </Button>
          </div>

          <div className={styles['templateGrid']}>
            {filteredTemplates.map(tpl => (
              <div
                key={tpl.id}
                className={styles['templateCard']}
                role="button"
                tabIndex={0}
                onClick={() => handleSelectTemplate(tpl)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleSelectTemplate(tpl)
                }}
              >
                <div className={styles['templateCardHead']}>
                  <div className={styles['templateIcon']}>
                    <IconServer size={18} />
                  </div>
                  <div className={styles['templateInfo']}>
                    <span className={styles['templateName']}>{tpl.name}</span>
                    <span className={styles['templateCategory']}>{tpl.category}</span>
                  </div>
                </div>
                <p className={styles['templateDesc']}>{tpl.description}</p>
                <div className={styles['templateFoot']}>
                  <span className={styles['templateProtocol']}>{tpl.api}</span>
                  <span className={styles['templateAddAction']}>Add +</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className={styles['addForm']}>
          {error && <div className={styles['formError']}>{error}</div>}

          <div className={styles['field']}>
            <label className={styles['fieldLabel']}>Display Name</label>
            <input
              className={styles['input']}
              type="text"
              value={displayName}
              placeholder="e.g. OpenAI Official"
              onChange={e => setDisplayName(e.target.value)}
              disabled={busy || readOnly}
            />
          </div>

          <div className={styles['fieldGrid']}>
            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>Provider ID (slug)</label>
              <input
                className={styles['input']}
                type="text"
                value={providerId}
                placeholder="e.g. openai"
                onChange={e => setProviderId(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ''))}
                disabled={busy || readOnly}
              />
            </div>

            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>API Protocol</label>
              <select
                className={`${styles['input']} ${styles['selectInput']}`}
                value={protocol}
                onChange={e => setProtocol(e.target.value)}
                disabled={busy || readOnly}
              >
                {protocols.map(p => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles['field']}>
            <label className={styles['fieldLabel']}>Base URL / Endpoint</label>
            <input
              className={styles['input']}
              type="text"
              value={baseURL}
              placeholder="https://api.openai.com/v1"
              onChange={e => setBaseURL(e.target.value)}
              disabled={busy || readOnly}
            />
          </div>

          <div className={styles['field']}>
            <label className={styles['fieldLabel']}>API Key</label>
            <input
              className={styles['input']}
              type="password"
              value={apiKey}
              placeholder="Enter API Key (optional for local/proxy endpoints)"
              onChange={e => setApiKey(e.target.value)}
              disabled={busy || readOnly}
            />
          </div>
        </div>
      )}
    </Modal>
  )
}
