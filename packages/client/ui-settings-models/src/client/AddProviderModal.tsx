import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { PROVIDER_TEMPLATES, POPULAR_PROVIDERS, type ProviderTemplate } from './provider-templates.ts'
import { resolveHeavyInstall, type HeavyProviderManifest } from './heavy-providers.ts'
import { deriveKeyRef, messageOf, type ModelsWire } from './store.ts'
import { heavyApi, pollHeavyJob, type HeavyHealthView, type HeavyJobView } from './heavy-rpc.ts'
import { HeavyProviderDocs } from './HeavyProviderDocs.tsx'
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
  // Heavy-provider flow: mode choice, optional unified key, health, progress.
  const [heavyMode, setHeavyMode] = useState<'reuse' | 'local'>('reuse')
  const [heavyKey, setHeavyKey] = useState('')
  const [heavyHealth, setHeavyHealth] = useState<HeavyHealthView | null>(null)
  const [heavyChecking, setHeavyChecking] = useState(false)
  const [heavyJob, setHeavyJob] = useState<HeavyJobView | null>(null)
  const [heavyPlatform, setHeavyPlatform] = useState<string | undefined>(undefined)

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return PROVIDER_TEMPLATES
    return PROVIDER_TEMPLATES.filter(
      p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    )
  }, [search])

  const heavyTemplates = useMemo(
    () => PROVIDER_TEMPLATES.filter(p => p.heavy !== undefined),
    [],
  )

  const popular = useMemo(() => {
    const byId = new Map(PROVIDER_TEMPLATES.map(p => [p.id, p]))
    return POPULAR_PROVIDERS.map(id => byId.get(id)).filter((p): p is ProviderTemplate => p !== undefined)
  }, [])

  if (!open) return null

  const keylessSelected = selected !== 'empty' && selected !== null && selected.keyless === true
  const heavy: HeavyProviderManifest | undefined = selected !== 'empty' && selected !== null ? selected.heavy : undefined
  const heavyUnsupported = heavy?.unsupported

  const refreshHeavyHealth = (manifest: HeavyProviderManifest) => {
    setHeavyChecking(true)
    void heavyApi.status(manifest.id).then((result) => {
      if (result.ok) {
        setHeavyHealth(result.value.health)
        setHeavyPlatform(result.value.platform)
      }
      setHeavyChecking(false)
    })
  }

  const handleSelect = (tpl: ProviderTemplate | 'empty') => {
    setSelected(tpl)
    setError(null)
    setHeavyHealth(null)
    setHeavyJob(null)
    setHeavyKey('')
    setHeavyMode('reuse')
    setHeavyPlatform(undefined)
    if (tpl === 'empty') {
      setProviderId(uniqueId('provider', taken))
      setDisplayName('New Provider')
      setProtocol(protocols.includes('openai-completions') ? 'openai-completions' : protocols[0] || 'openai-completions')
      setBaseURL('')
      setApiKey('')
      return
    }
    setProviderId(tpl.heavy !== undefined ? tpl.id : uniqueId(tpl.id, taken))
    setDisplayName(tpl.name)
    setProtocol(protocols.includes(tpl.protocol) ? tpl.protocol : protocols[0] || tpl.protocol)
    setBaseURL(tpl.baseURL)
    setApiKey('')
    if (tpl.heavy !== undefined && tpl.heavy.unsupported === undefined) refreshHeavyHealth(tpl.heavy)
  }

  const handleBack = () => {
    setSelected(null)
    setError(null)
  }

  /** The heavy add: reuse writes the route after a probe; local runs the polled job. */
  const handleHeavyCreate = async (manifest: HeavyProviderManifest) => {
    setHeavyJob(null)
    if (manifest.unsupported !== undefined) {
      setError(`${manifest.unsupported.reason} (${manifest.unsupported.plannedWith})`)
      return
    }
    if (heavyMode === 'reuse') {
      const result = await heavyApi.reuse(manifest.id, heavyKey)
      if (!result.ok) {
        setError(result.message)
        return
      }
      if (result.value.blocked !== undefined) {
        setError(`${result.value.blocked.reason} (${result.value.blocked.plannedWith})`)
        return
      }
      if (result.value.health !== undefined) setHeavyHealth(result.value.health)
      onClose(true)
      return
    }
    const started = await heavyApi.install(manifest.id, heavyKey)
    if (!started.ok) {
      setError(started.message)
      return
    }
    if (started.value.blocked !== undefined) {
      setError(`${started.value.blocked.reason} (${started.value.blocked.plannedWith})`)
      return
    }
    if (started.value.job !== undefined) setHeavyJob(started.value.job)
    const final = await pollHeavyJob(manifest.id, setHeavyJob)
    if (final?.state === 'succeeded') {
      onClose(true)
      return
    }
    setError(final?.error ?? t('heavyFailed'))
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
    if (!heavy && !baseURL.trim()) {
      setError(t('customNeedsBaseUrl'))
      return
    }

    setBusy(true)
    setError(null)

    try {
      if (heavy !== undefined) {
        setDiscovering(heavyMode === 'reuse')
        await handleHeavyCreate(heavy)
        return
      }
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
      setDiscovering(false)
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
            <Button
              variant="primary"
              disabled={busy || readOnly || heavyUnsupported !== undefined}
              onClick={handleCreate}
            >
              {heavy !== undefined && busy && heavyJob?.state === 'running'
                ? t('heavyInstalling')
                : discovering ? t('discovering') : busy ? t('creating') : t('create')}
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
            {search.trim() === '' ? (
              <>
                <div className={styles['templateGroupLabel']}>{t('heavyGroup')}</div>
                {heavyTemplates.map(tpl => (
                  <TemplateCard key={tpl.id} tpl={tpl} onSelect={handleSelect} t={t} />
                ))}
                <div className={styles['templateGroupLabel']}>Popular</div>
                {popular.map(tpl => (
                  <TemplateCard key={tpl.id} tpl={tpl} onSelect={handleSelect} t={t} />
                ))}
                <div className={styles['templateGroupLabel']}>All Providers</div>
                {filtered.filter(tpl => tpl.heavy === undefined).map(tpl => (
                  <TemplateCard key={tpl.id} tpl={tpl} onSelect={handleSelect} t={t} />
                ))}
              </>
            ) : (
              filtered.map(tpl => (
                <TemplateCard key={tpl.id} tpl={tpl} onSelect={handleSelect} t={t} />
              ))
            )}
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
              disabled={busy || readOnly || heavy !== undefined}
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
                disabled={busy || readOnly || heavy !== undefined}
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

          {heavy === undefined ? (
            <>
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
            </>
          ) : (
            <HeavyProviderForm
              manifest={heavy}
              mode={heavyMode}
              onMode={setHeavyMode}
              keyValue={heavyKey}
              onKey={setHeavyKey}
              health={heavyHealth}
              checking={heavyChecking}
              job={heavyJob}
              platform={heavyPlatform}
              readOnly={readOnly}
              busy={busy}
              t={t}
              onCheck={() => refreshHeavyHealth(heavy)}
            />
          )}

          {selected !== 'empty' && heavy === undefined && (
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

/** The heavy-provider form: summary, quirks, browser badges, mode choice, progress. */
function HeavyProviderForm(props: {
  manifest: HeavyProviderManifest
  mode: 'reuse' | 'local'
  onMode: (mode: 'reuse' | 'local') => void
  keyValue: string
  onKey: (value: string) => void
  health: HeavyHealthView | null
  checking: boolean
  job: HeavyJobView | null
  platform?: string | undefined
  readOnly: boolean
  busy: boolean
  t: (key: keyof typeof en) => string
  onCheck: () => void
}): ReactNode {
  const { manifest, mode, onMode, keyValue, onKey, health, checking, job, platform, readOnly, busy, t, onCheck } = props
  const disabled = busy || readOnly
  const dashboardUrl = mode === 'local' ? manifest.local.dashboardUrl ?? manifest.dashboardUrl : manifest.dashboardUrl
  const [docsOpen, setDocsOpen] = useState(false)
  const install = resolveHeavyInstall(manifest.local, platform ?? '')
  return (
    <div className={styles['heavyPanel']}>
      <p className={styles['heavySummary']}>{manifest.summary}</p>

      <div className={styles['heavyMetaRow']}>
        {dashboardUrl !== undefined && (
          <a className={styles['presetMetaItem']} href={dashboardUrl} target="_blank" rel="noreferrer">
            {t('heavyDashboard')} ↗
          </a>
        )}
        {manifest.docsUrl !== undefined && (
          <a className={styles['presetMetaItem']} href={manifest.docsUrl} target="_blank" rel="noreferrer">
            {t('heavyDocs')} ↗
          </a>
        )}
        <span className={styles['heavyHealthBadge']} data-ok={health?.ok === true ? 'true' : 'false'}>
          {health === null ? t('heavyHealthUnknown') : health.ok ? t('heavyHealthOk') : t('heavyHealthDown')}
          {health?.status !== undefined ? ` · ${String(health.status)}` : ''}
        </span>
        <button type="button" className={styles['heavyLinkBtn']} onClick={onCheck} disabled={checking}>
          {checking ? t('heavyChecking') : t('heavyCheck')}
        </button>
      </div>

      {manifest.requiresBrowser.length > 0 && (
        <div className={styles['heavyBadges']}>
          {manifest.requiresBrowser.map(line => (
            <span key={line} className={styles['heavyBrowserBadge']} title={line}>
              {t('heavyBrowserBadge')}
            </span>
          ))}
        </div>
      )}

      <div className={styles['heavySectionLabel']}>{t('heavyQuirks')}</div>
      <ul className={styles['heavyList']}>
        {manifest.quirks.map(quirk => <li key={quirk}>{quirk}</li>)}
      </ul>

      {manifest.unsupported !== undefined ? (
        <div className={styles['heavyBlocked']}>
          <strong>{t('heavyBlockedTitle')}</strong>
          <p>{manifest.unsupported.reason}</p>
          <p className={styles['heavyBlockedHint']}>
            {t('heavyBlockedHint').replace('{planned}', manifest.unsupported.plannedWith)}
            {' · '}
            <a href={manifest.unsupported.reuseUrl} target="_blank" rel="noreferrer">{t('heavyReuseUrl')} ↗</a>
          </p>
        </div>
      ) : (
        <>
          <div className={styles['heavySectionLabel']}>{t('heavySummary')}</div>
          <div className={styles['heavyModes']}>
            <label className={styles['heavyMode']}>
              <input
                type="radio"
                name="heavy-mode"
                checked={mode === 'reuse'}
                disabled={disabled}
                onChange={() => onMode('reuse')}
              />
              <span>
                <strong>{t('heavyReuse')}</strong>
                <em> · {t('heavyRecommended')}</em>
                <span className={styles['heavyModeNote']}>{manifest.reuse.note}</span>
                <span className={styles['heavyModeNote']}>{manifest.reuse.baseURL}</span>
              </span>
            </label>
            <label className={styles['heavyMode']}>
              <input
                type="radio"
                name="heavy-mode"
                checked={mode === 'local'}
                disabled={disabled}
                onChange={() => onMode('local')}
              />
              <span>
                <strong>{t('heavyLocal')}</strong>
                <span className={styles['heavyModeNote']}>
                  {t('heavyDeps')}: {manifest.local.deps.join(', ')} · {t('heavyDisk')}: {manifest.local.diskHint}
                </span>
                <span className={styles['heavyModeNote']}>{manifest.local.baseURL}</span>
              </span>
            </label>
          </div>

          {mode === 'local' && install.steps.length > 0 && (
            <>
              <div className={styles['heavySectionLabel']}>{t('heavyInstallSteps')}</div>
              <p className={styles['heavyModeNote']}>
                {install.label}
                {platform !== undefined && platform !== ''
                  ? ` · ${t('heavyPlatformHost').replace('{platform}', platform)}`
                  : ''}
              </p>
              <ol className={styles['heavyList']}>
                {install.steps.map(step => <li key={step.label}>{step.label}</li>)}
              </ol>
            </>
          )}

          <div className={styles['heavyMetaRow']}>
            <button
              type="button"
              className={styles['heavyLinkBtn']}
              aria-pressed={docsOpen}
              onClick={() => setDocsOpen(open => !open)}
            >
              {docsOpen ? t('heavyHideDocumentation') : t('heavyDocumentation')}
            </button>
          </div>
          {docsOpen && <HeavyProviderDocs manifest={manifest} platform={platform} t={t} />}

          {manifest.auth.kind === 'unified' ? (
            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>{t('heavyKeyLabel')}</label>
              <input
                className={styles['input']}
                type="password"
                value={keyValue}
                placeholder={t('heavyKeyPlaceholder')}
                onChange={e => onKey(e.target.value)}
                disabled={disabled}
              />
            </div>
          ) : (
            <p className={styles['heavyModeNote']}>
              {t('heavyPlaceholderAuth').replace('{ref}', manifest.auth.apiKeyEnv ?? '')}
            </p>
          )}

          {job !== null && (
            <div className={styles['heavyProgress']}>
              <div className={styles['heavyProgressHead']}>
                <span>{t('heavyProgress').replace('{step}', String(job.stageIndex + 1)).replace('{total}', String(job.stageCount))}</span>
                <span>{job.pct}%</span>
              </div>
              <div className={styles['heavyProgressTrack']}>
                <div className={styles['heavyProgressFill']} style={{ width: `${job.pct}%` }} data-state={job.state} />
              </div>
              <div className={styles['heavyStage']}>{job.stage}</div>
              {job.state === 'running' && <p className={styles['heavyModeNote']}>{t('heavyJobBackground')}</p>}
              {job.logTail !== '' && <pre className={styles['heavyLog']}>{job.logTail}</pre>}
              {job.state === 'failed' && (
                <p className={styles['heavyProgressError']}>{t('heavyFailed')}: {job.error}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function TemplateCard({
  tpl,
  onSelect,
  t,
}: {
  tpl: ProviderTemplate
  onSelect: (tpl: ProviderTemplate) => void
  t: (key: keyof typeof en) => string
}): ReactNode {
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
          {tpl.heavy !== undefined && (
            <span className={styles['heavyCardBadge']}>
              {tpl.heavy.unsupported === undefined ? t('heavyBadgeShort') : t('heavyPlannedBadge')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
