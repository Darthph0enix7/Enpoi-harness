import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { liveProviderTemplates, POPULAR_PROVIDERS, type ProviderTemplate } from './provider-templates.ts'
import { useHeavyManifestState } from './heavy-manifest-source.ts'
import { resolveHeavyInstall, type HeavyProviderManifest } from './heavy-providers.ts'
import { deriveKeyRef, messageOf, type ModelsWire } from './store.ts'
import { heavyApi, pollHeavyJob, type HeavyJobView, type HeavyStatusView } from './heavy-rpc.ts'
import { HeavyPreflightNote } from './HeavyProviderStatus.tsx'
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
  /**
   * Close the modal; `created` marks a route that was stored. The returned
   * promise settles after the owner refreshed its provider list, so the modal
   * stays up until the new route is visible behind it.
   */
  onClose: (created?: boolean) => void | Promise<void>
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

/** Parse the manual model list: one id per line or comma, blanks dropped. */
function parseModelIds(text: string): string[] {
  return text.split(/[\n,]/).map(entry => entry.trim()).filter(entry => entry !== '')
}

/** One endpoint-interrogation answer at the modal's own boundary. */
type DiscoveryAnswer = { models: readonly { id: string }[] } | { message: string }

/** One model row the discovery endpoint reports for a route. */
type DiscoveredModel = { id: string; name?: string; contextWindow?: number; maxTokens?: number }

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
  // Manual model ids: the fallback whenever the endpoint's /models listing
  // cannot describe the route (a config-only route or an offline endpoint).
  const [manualModels, setManualModels] = useState('')
  // Set when the route is stored but resolves no models: the modal stays open
  // with discovery and manual-list paths instead of a dead end.
  const [recovery, setRecovery] = useState<{ message: string } | null>(null)
  // Heavy-provider flow: mode choice, optional unified key, detection, progress.
  const [heavyMode, setHeavyMode] = useState<'reuse' | 'local'>('reuse')
  // A ref, not state: the status fetch resolves after the selection handler,
  // and a stale closure would keep suppressing (or applying) the default.
  const heavyModeTouched = useRef(false)
  const [heavyKey, setHeavyKey] = useState('')
  const [heavyStatus, setHeavyStatus] = useState<HeavyStatusView | null>(null)
  const [heavyChecking, setHeavyChecking] = useState(false)
  const [heavyJob, setHeavyJob] = useState<HeavyJobView | null>(null)

  // The listing is rebuilt from the current manifest table: the host reply
  // replaces the labelled fallback heavy rows without a page copy.
  const manifestState = useHeavyManifestState()
  const templates = useMemo(() => liveProviderTemplates(), [manifestState])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return templates
    return templates.filter(
      p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    )
  }, [search, templates])

  const heavyTemplates = useMemo(
    () => templates.filter(p => p.heavy !== undefined),
    [templates],
  )

  const popular = useMemo(() => {
    const byId = new Map(templates.map(p => [p.id, p]))
    return POPULAR_PROVIDERS.map(id => byId.get(id)).filter((p): p is ProviderTemplate => p !== undefined)
  }, [templates])

  const keylessSelected = selected !== 'empty' && selected !== null && selected.keyless === true
  // The convention reference the selected preset names, when it names one:
  // the key field probes it so its label cannot read as a key already in
  // place while nothing resolves it.
  const presetEnvRef = selected !== null && selected !== 'empty' && !keylessSelected
    && selected.env.length > 0
    ? selected.env[0]
    : undefined
  const [envRefAnswer, setEnvRefAnswer] = useState<{ ref: string; configured: boolean } | undefined>(undefined)
  // An answer belongs to the reference it described: a selected preset reads
  // only its own answer, so a late reply for a previously selected route
  // cannot lend this field a claim.
  const envRefConfigured = presetEnvRef !== undefined && envRefAnswer?.ref === presetEnvRef
    ? envRefAnswer.configured
    : undefined
  useEffect(() => {
    if (!open || presetEnvRef === undefined) return
    void api.credentials.describe([presetEnvRef]).then((response) => {
      if (!response.ok) return
      const described = response.value[presetEnvRef]
      if (described !== undefined) setEnvRefAnswer({ ref: presetEnvRef, configured: described.configured === true })
    }).catch(() => {
      // A refused describe leaves the field with no configured claim.
    })
  }, [open, api.credentials, presetEnvRef])

  // Reopening starts from the template list: a form left over from the last
  // add would otherwise hide the created route behind its old slug and make
  // the same id read as taken instead of showing the fresh list.
  useEffect(() => {
    if (open) return
    setSearch('')
    setSelected(null)
    setProviderId('')
    setDisplayName('')
    setBaseURL('')
    setApiKey('')
    setBusy(false)
    setDiscovering(false)
    setError(null)
    setManualModels('')
    setRecovery(null)
    setHeavyMode('reuse')
    setHeavyKey('')
    setHeavyStatus(null)
    setHeavyChecking(false)
    setHeavyJob(null)
    heavyModeTouched.current = false
  }, [open])

  if (!open) return null

  // A preset that names an environment reference genuinely needs a key: say so
  // plainly while still allowing a save without one (the route stays
  // repairable from the Models page).
  const needsKeyHint = selected !== 'empty' && selected !== null && !keylessSelected
    && selected.env.length > 0 && apiKey.trim().length === 0
  const heavy: HeavyProviderManifest | undefined = selected !== 'empty' && selected !== null ? selected.heavy : undefined
  const heavyUnsupported = heavy?.unsupported

  const refreshHeavyStatus = (manifest: HeavyProviderManifest) => {
    setHeavyChecking(true)
    void heavyApi.status(manifest.id).then((result) => {
      if (result.ok) {
        setHeavyStatus(result.value)
        // Nothing answers → offer the install paths first; a manual mode
        // choice always wins over this default.
        if (result.value.detectedEndpoint === undefined && !heavyModeTouched.current) setHeavyMode('local')
      }
      setHeavyChecking(false)
    })
  }

  const handleSelect = (tpl: ProviderTemplate | 'empty') => {
    setSelected(tpl)
    setError(null)
    setManualModels('')
    setRecovery(null)
    setHeavyStatus(null)
    setHeavyJob(null)
    setHeavyKey('')
    setHeavyMode('reuse')
    heavyModeTouched.current = false
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
    if (tpl.heavy !== undefined && tpl.heavy.unsupported === undefined) refreshHeavyStatus(tpl.heavy)
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
      // The route namespace of a custom-protocol provider is mounted only
      // after the profile build + restart; report the ordering fact instead
      // of a route that was never written.
      if (result.value.pendingRestart !== undefined) {
        setError(result.value.pendingRestart.message)
        return
      }
      if (result.value.blocked !== undefined) {
        setError(`${result.value.blocked.reason} (${result.value.blocked.plannedWith})`)
        return
      }
      await onClose(true)
      return
    }
    const started = await heavyApi.install(manifest.id, heavyKey)
    if (!started.ok) {
      setError(started.message)
      return
    }
    // Same ordering fact reuse reports: the local install cannot write its
    // route until the profile build + restart mounts the namespace.
    if (started.value.pendingRestart !== undefined) {
      setError(started.value.pendingRestart.message)
      return
    }
    if (started.value.blocked !== undefined) {
      setError(`${started.value.blocked.reason} (${started.value.blocked.plannedWith})`)
      return
    }
    if (started.value.job !== undefined) setHeavyJob(started.value.job)
    const final = await pollHeavyJob(manifest.id, setHeavyJob)
    if (final?.state === 'succeeded') {
      await onClose(true)
      return
    }
    setError(final?.error ?? t('heavyFailed'))
  }

  /** Ask the endpoint what it serves, at the modal's own error boundary. */
  const runDiscovery = async (id: string, cleanKey: string): Promise<DiscoveryAnswer> => {
    try {
      const discovery = await api.llm.discoverModels('llm-pi-ai', {
        provider: id,
        baseURL: baseURL.trim(),
        api: protocol,
        ...(cleanKey.length > 0 ? { apiKey: cleanKey } : {}),
      })
      return discovery.ok ? { models: discovery.value } : { message: discovery.error.message }
    } catch (err) {
      return { message: messageOf(err) }
    }
  }

  /** Persist discovered models onto the stored route. */
  const storeDiscovered = async (id: string, models: readonly DiscoveredModel[]): Promise<boolean> => {
    const value = models.map(model => ({
      id: model.id,
      ...(model.name !== undefined && model.name !== model.id ? { name: model.name } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    }))
    const res = await api.settings.mutate(
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', id, 'models'], value: value as unknown as JsonValue }],
      undefined,
    )
    if (!res.ok) {
      setError(res.error.message)
      return false
    }
    return true
  }

  /** The route profile for the current form, carrying the given model ids. */
  const profileFor = (id: string, modelIds: readonly string[], discovered?: readonly DiscoveredModel[]): Record<string, unknown> => {
    const cleanKey = apiKey.trim()
    const needsPlaceholderModel = selected === 'empty' && modelIds.length === 0 && discovered === undefined
    return {
      displayName: displayName.trim() || id,
      api: protocol,
      baseURL: baseURL.trim(),
      // A keyless preset stores its reference too, so a key supplied later
      // authenticates the paid/BYOK path; without one the route serves
      // anonymously.
      ...keylessSelected
        ? { keyless: true, apiKeyEnv: deriveKeyRef(id) }
        : cleanKey.length > 0 ? { apiKeyEnv: deriveKeyRef(id) } : {},
      ...needsPlaceholderModel ? { models: [{ id: 'auto' }] } : {},
      ...modelIds.length > 0 ? { models: modelIds.map(modelId => ({ id: modelId })) } : {},
      ...discovered !== undefined ? { models: discovered.map(model => ({
        id: model.id,
        ...(model.name !== undefined && model.name !== model.id ? { name: model.name } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      })) } : {},
    }
  }

  /** Store the provider profile, saving a typed credential first. */
  const storeProfile = async (id: string, modelIds: readonly string[], discovered?: readonly DiscoveredModel[]): Promise<boolean> => {
    const cleanKey = apiKey.trim()
    if (cleanKey.length > 0) {
      const credRes = await api.credentials.set(deriveKeyRef(id), cleanKey)
      if (!credRes.ok) {
        setError(credRes.error.message)
        return false
      }
    }
    const res = await api.settings.mutate(
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', id], value: profileFor(id, modelIds, discovered) as JsonValue }],
      undefined,
    )
    if (!res.ok) {
      setError(res.error.message)
      return false
    }
    return true
  }

  /**
   * Whether this route still needs models listed: an adapter that knows the
   * route only because configuration declared it (llm-pi-ai's `declared`
   * flag) resolves nothing without a model list, and a stored route carrying a
   * catalog diagnostic resolves nothing either. An unanswerable directory
   * read keeps the safe assumption that models are required.
   */
  const routeNeedsModels = async (id: string): Promise<boolean> => {
    try {
      const directory = await api.llm.listConfigurableProviders()
      if (!directory.ok) return true
      const entry = directory.value.find(candidate => candidate.provider === id)
      return entry?.declared === true || entry?.error !== undefined
    } catch {
      return true
    }
  }

  /** The route was stored but no models arrived: keep the modal repairable. */
  const enterRecovery = (message: string): void => {
    setRecovery({ message })
    setDiscovering(false)
    setBusy(false)
  }

  /** Retry the endpoint's /models listing from the recovery panel. */
  const retryDiscovery = async (): Promise<void> => {
    const id = providerId.trim().toLowerCase()
    setBusy(true)
    setError(null)
    setDiscovering(true)
    try {
      const answer = await runDiscovery(id, apiKey.trim())
      if ('models' in answer && answer.models.length > 0) {
        // The full profile is rewritten: a rejected first write left no route,
        // so a models-only write would store a partial profile.
        if (await storeProfile(id, [], answer.models)) await onClose(true)
        return
      }
      enterRecovery('models' in answer ? t('addNoModelsFound') : answer.message)
    } catch (err) {
      // A rejected write must not leave the panel spinning: report it and keep
      // the manual list usable.
      enterRecovery(messageOf(err))
    } finally {
      setDiscovering(false)
      setBusy(false)
    }
  }

  /** Save the typed model ids onto the stored route and close. */
  const saveManualModels = async (): Promise<void> => {
    const id = providerId.trim().toLowerCase()
    const manual = parseModelIds(manualModels)
    if (manual.length === 0) return
    setBusy(true)
    setError(null)
    try {
      if (await storeProfile(id, manual)) await onClose(true)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
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
    setRecovery(null)

    try {
      if (heavy !== undefined) {
        setDiscovering(heavyMode === 'reuse')
        await handleHeavyCreate(heavy)
        return
      }
      const cleanKey = apiKey.trim()
      const manual = parseModelIds(manualModels)

      // The typed credential serves the add and the later paid path alike.
      if (cleanKey.length > 0) {
        const credRes = await api.credentials.set(deriveKeyRef(id), cleanKey)
        if (!credRes.ok) {
          setError(credRes.error.message)
          setBusy(false)
          return
        }
      }

      // Mutate llm-pi-ai settings namespace
      const settingsRes = await api.settings.mutate(
        'llm-pi-ai',
        [{ op: 'set', path: ['providers', id], value: profileFor(id, manual) as JsonValue }],
        undefined,
      )

      if (!settingsRes.ok) {
        // A stored route whose adapter cannot resolve it is repairable on the
        // spot: the recovery panel offers discovery and the manual list.
        if (/resolves no models/.test(settingsRes.error.message)) {
          enterRecovery(settingsRes.error.message)
          return
        }
        setError(settingsRes.error.message)
        setBusy(false)
        return
      }

      if (manual.length > 0) {
        await onClose(true)
        return
      }

      // Discovery is part of the add: the new route's models land without a
      // manual refresh. A refusal or an empty listing keeps the modal open
      // with the recovery paths instead of closing on a dead route.
      setDiscovering(true)
      const answer = await runDiscovery(id, cleanKey)
      if ('models' in answer && answer.models.length > 0) {
        // A refused model-list write keeps the panel open with its message:
        // closing here would hide the route's missing models behind a
        // refresh that cannot resolve them.
        if (!await storeDiscovered(id, answer.models)) return
        await onClose(true)
        return
      }
      const needsModels = selected === 'empty' ? false : await routeNeedsModels(id)
      setDiscovering(false)
      if (!needsModels) {
        // The installed catalog describes this route (or the empty provider
        // keeps its placeholder model); the models are optional.
        await onClose(true)
        return
      }
      enterRecovery('models' in answer ? t('addNoModelsFound') : answer.message)
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
      onClose={() => { void onClose(false) }}
      title={selected === null ? t('add') : `Add ${displayName || 'Provider'}`}
      closeLabel={t('close')}
      className={styles['addProviderDialog'] ?? ''}
      footer={
        selected === null ? (
          <Button variant="outline" onClick={() => { void onClose(false) }}>
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
                <div className={styles['templateGroupLabel']}>Popular</div>
                {popular.map(tpl => (
                  <TemplateCard key={tpl.id} tpl={tpl} onSelect={handleSelect} configured={taken.includes(tpl.id)} t={t} />
                ))}
                <div className={styles['templateGroupLabel']}>All Providers</div>
                {filtered.filter(tpl => tpl.heavy === undefined).map(tpl => (
                  <TemplateCard key={tpl.id} tpl={tpl} onSelect={handleSelect} configured={taken.includes(tpl.id)} t={t} />
                ))}
                {/* Self-hosted/heavy providers render in their own labelled
                    group AFTER the mainstream catalog; search still finds
                    them through the flat filtered list above. */}
                <div className={styles['templateGroupLabel']}>{t('heavyGroup')}</div>
                {heavyTemplates.map(tpl => (
                  <TemplateCard key={tpl.id} tpl={tpl} onSelect={handleSelect} configured={taken.includes(tpl.id)} t={t} />
                ))}
              </>
            ) : (
              filtered.map(tpl => (
                <TemplateCard key={tpl.id} tpl={tpl} onSelect={handleSelect} configured={taken.includes(tpl.id)} t={t} />
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

          {recovery !== null && (
            <div className={styles['recoveryPanel']} data-add-recovery role="alert">
              <strong>{t('addRecoveryTitle')}</strong>
              <p>{t('addRecoveryBody')}</p>
              <p className={styles['recoveryDetail']}>{recovery.message}</p>
              <div className={styles['recoveryActions']}>
                <Button variant="outline" disabled={busy} onClick={() => { void retryDiscovery() }}>
                  {t('addDiscoverRetry')}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || parseModelIds(manualModels).length === 0}
                  onClick={() => { void saveManualModels() }}
                >
                  {t('addSaveModels')}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => { void onClose(true) }}>
                  {t('addRecoveryClose')}
                </Button>
              </div>
            </div>
          )}

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
                    : presetEnvRef === undefined
                      ? 'Enter API Key (optional for local/proxy endpoints)'
                      : envRefConfigured === undefined
                        ? `Env ref: ${presetEnvRef}`
                        : envRefConfigured
                          ? t('addEnvRefConfigured').replace('{ref}', presetEnvRef)
                          : t('addEnvRefMissing').replace('{ref}', presetEnvRef)}
                  onChange={e => setApiKey(e.target.value)}
                  disabled={busy || readOnly}
                />
                {needsKeyHint && (
                  <p className={styles['presetMetaItem']} data-add-needs-key>{t('addNeedsKeyHint')}</p>
                )}
              </div>

              <div className={styles['field']}>
                <label className={styles['fieldLabel']}>{t('addModelsLabel')}</label>
                <textarea
                  className={`${styles['input']} ${styles['modelsInput']}`}
                  rows={3}
                  value={manualModels}
                  placeholder={t('addModelsHint')}
                  onChange={e => setManualModels(e.target.value)}
                  disabled={busy || readOnly}
                />
              </div>
            </>
          ) : (
            <HeavyProviderForm
              manifest={heavy}
              mode={heavyMode}
              onMode={(mode) => { heavyModeTouched.current = true; setHeavyMode(mode) }}
              keyValue={heavyKey}
              onKey={setHeavyKey}
              status={heavyStatus}
              checking={heavyChecking}
              job={heavyJob}
              readOnly={readOnly}
              busy={busy}
              t={t}
              onCheck={() => refreshHeavyStatus(heavy)}
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
  status: HeavyStatusView | null
  checking: boolean
  job: HeavyJobView | null
  readOnly: boolean
  busy: boolean
  t: (key: keyof typeof en) => string
  onCheck: () => void
}): ReactNode {
  const { manifest, mode, onMode, keyValue, onKey, status, checking, job, readOnly, busy, t, onCheck } = props
  const disabled = busy || readOnly
  const platform = status?.platform
  const health = status?.health ?? null
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
          {checking ? t('heavyChecking') : t('heavyCheckNow')}
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
          {/* Detection first, then the runtime preflight for the local path. */}
          <HeavyPreflightNote status={status} t={t} />
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
                {status?.detectedEndpoint !== undefined && <em> · {t('heavyRecommended')}</em>}
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

          {/* Ordering: the route namespace is mounted only after the profile
              build + restart, so say so before the click instead of letting
              the write fail as a raw settings.mutate error. */}
          {status?.settingsReady === false && (
            <p className={styles['heavyModeNote']} data-state="pending-restart">
              {t('heavyPendingRestart').replace('{ns}', status.settingsNs ?? '')}
            </p>
          )}

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
  configured,
  t,
}: {
  tpl: ProviderTemplate
  onSelect: (tpl: ProviderTemplate) => void
  /** The provider already owns a route: its heavy row reads as configured. */
  configured: boolean
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
              {configured ? t('heavyBadgeShort') : t('heavyListedBadge')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
