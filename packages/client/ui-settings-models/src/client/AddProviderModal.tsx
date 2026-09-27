import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { PROVIDER_TEMPLATES, POPULAR_PROVIDERS, type ProviderTemplate } from './provider-templates.ts'
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

/** Unique route id: base, then base-1, base-2... until free. */
function uniqueId(base: string, taken: readonly string[]): string {
  let candidate = base
  let counter = 1
  while (taken.includes(candidate)) {
    candidate = `${base}-${counter++}`
  }
  return candidate
}

export function AddProviderModal(props: AddProviderModalProps): ReactNode {
  const { open, taken, protocols, api, t, readOnly, onClose } = props
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<ProviderTemplate | 'empty' | null>(null)

  // Form fields
  const [providerId, setProviderId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [protocol, setProtocol] = useState<string>('openai-completions')
  const [baseURL, setBaseURL] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return PROVIDER_TEMPLATES
    return PROVIDER_TEMPLATES.filter(
      p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    )
  }, [search])

  const popular = useMemo(() => {
    const byId = new Map(PROVIDER_TEMPLATES.map(p => [p.id, p]))
    return POPULAR_PROVIDERS.map(id => byId.get(id)).filter((p): p is ProviderTemplate => p !== undefined)
  }, [])

  if (!open) return null

  const keylessSelected = selected !== 'empty' && selected !== null && selected.keyless === true

  const handleSelect = (tpl: ProviderTemplate | 'empty') => {
    setSelected(tpl)
    setError(null)
    if (tpl === 'empty') {
      setProviderId(uniqueId('provider', taken))
      setDisplayName('New Provider')
      setProtocol(protocols.includes('openai-completions') ? 'openai-completions' : protocols[0] || 'openai-completions')
      setBaseURL('')
      setApiKey('')
      return
    }
    setProviderId(uniqueId(tpl.id, taken))
    setDisplayName(tpl.name)
    setProtocol(protocols.includes(tpl.protocol) ? tpl.protocol : protocols[0] || tpl.protocol)
    setBaseURL(tpl.baseURL)
    setApiKey('')
  }

  const handleBack = () => {
    setSelected(null)
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

      const needsPlaceholderModel = selected === 'empty'
      const profileData: Record<string, unknown> = {
        displayName: displayName.trim() || id,
        api: protocol,
        baseURL: baseURL.trim(),
        // A keyless preset stores its reference too, so a key supplied later
        // authenticates the paid/BYOK path; without one the route serves
        // anonymously.
        ...keylessSelected
          ? { keyless: true, apiKeyEnv: keyRef }
          : cleanKey.length > 0 ? { apiKeyEnv: keyRef } : {},
        ...needsPlaceholderModel ? { models: [{ id: 'auto' }] } : {},
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

      // Discovery is part of the add: the new route's models land without a
      // manual refresh. The profile is already stored, so a refused or empty
      // discovery still closes with the provider in place.
      setDiscovering(true)
      try {
        const discovery = await api.llm.discoverModels('llm-pi-ai', {
          provider: id,
          baseURL: baseURL.trim(),
          api: protocol,
          ...(cleanKey.length > 0 ? { apiKey: cleanKey } : {}),
        })
        if (discovery.ok && discovery.value.length > 0) {
          const models = discovery.value.map(model => ({
            id: model.id,
            ...(model.name !== undefined && model.name !== model.id ? { name: model.name } : {}),
            ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
            ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
          }))
          await api.settings.mutate(
            'llm-pi-ai',
            [{ op: 'set', path: ['providers', id, 'models'], value: models as unknown as JsonValue }],
            undefined,
          )
        }
      } catch {
        // The route stays created; the detail panel's refresh remains.
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
      title={selected === null ? t('add') : `Add ${displayName || 'Provider'}`}
      closeLabel={t('close')}
      className={styles['addProviderDialog'] ?? ''}
      footer={
        selected === null ? (
          <Button variant="outline" onClick={() => onClose(false)}>
            {t('cancel')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={busy} onClick={handleBack}>
              Back
            </Button>
            <Button variant="primary" disabled={busy || readOnly} onClick={handleCreate}>
              {discovering ? t('discovering') : busy ? t('creating') : t('create')}
            </Button>
          </>
        )
      }
    >
      {selected === null ? (
        <div className={styles['templatePickerContainer']}>
          <div className={styles['templateSearchRow']}>
            <div className={styles['searchWrap']}>
              <IconSearch size={14} />
              <input
                className={styles['searchInput']}
                type="text"
                placeholder="Search 212 providers (OpenAI, Anthropic, Gemini, Ollama...)"
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
              />
            </div>
            <Button variant="outline" className={styles['customBtn']} onClick={() => handleSelect('empty')}>
              Empty Provider
            </Button>
          </div>

          <div className={styles['templateGrid']}>
            {search.trim() === '' && (
              <>
                <div className={styles['templateGroupLabel']}>Popular</div>
                {popular.map(tpl => (
                  <TemplateCard key={tpl.id} tpl={tpl} onSelect={handleSelect} />
                ))}
                <div className={styles['templateGroupLabel']}>All Providers</div>
              </>
            )}
            {filtered.map(tpl => (
              <TemplateCard key={tpl.id} tpl={tpl} onSelect={handleSelect} />
            ))}
            {filtered.length === 0 && (
              <div className={styles['emptySidebar']}>No providers match "{search}".</div>
            )}
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
              placeholder={keylessSelected
                ? t('keylessApiKeyPlaceholder')
                : selected !== 'empty' && selected.env.length > 0 ? `Env ref: ${selected.env[0]}` : 'Enter API Key (optional for local/proxy endpoints)'}
              onChange={e => setApiKey(e.target.value)}
              disabled={busy || readOnly}
            />
          </div>

          {selected !== 'empty' && (
            <div className={styles['presetMeta']}>
              <span className={styles['presetMetaItem']}>
                Env: {selected.env.length > 0 ? selected.env.join(', ') : 'none'}
              </span>
              {keylessSelected && (
                <span className={styles['presetMetaItem']}>{t('keylessProviderHint')}</span>
              )}
              {selected.doc && (
                <a className={styles['presetMetaItem']} href={selected.doc} target="_blank" rel="noreferrer">
                  Docs ↗
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

function TemplateCard({ tpl, onSelect }: { tpl: ProviderTemplate; onSelect: (t: ProviderTemplate) => void }): ReactNode {
  return (
    <div
      className={styles['templateCard']}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(tpl)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect(tpl)
      }}
    >
      <div className={styles['templateCardHead']}>
        <div className={styles['templateIcon']}>
          <IconServer size={16} />
        </div>
        <div className={styles['templateInfo']}>
          <span className={styles['templateName']}>{tpl.name}</span>
          <span className={styles['templateCategory']}>{tpl.id}</span>
        </div>
      </div>
    </div>
  )
}