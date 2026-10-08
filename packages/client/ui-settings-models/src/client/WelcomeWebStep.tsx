/**
 * The web-search wizard step: one screen that enables live retrieval — the
 * shared DeepSeek key, a hosted provider key, a self-hosted SearXNG endpoint,
 * or nothing — plus the document-extraction fold. Every option is filtered
 * against the host's mounted providers, so the step never offers a dead
 * choice; the host `web-setup` writes are awaited, validated, and refused
 * inline, never fire-and-forget.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { apiKeyFailure } from './apiKey.ts'
import type { ModelsOperations } from './operations.ts'
import {
  DEEPSEEK_WEB_KEY_REF, availableSearchOffers, initialSearchChoice, offerKeyConfigured,
  providerMounted, webBaseURLFailure, webSetupWrites,
  type WebFetchProviderId, type WebSearchChoice, type WebSearchProviderOffer,
  type WebSetupApplyRequest, type WebSetupStatus, type WebSetupValidateRequest,
} from './web-setup.ts'
import { resolveWebSearchPlan, type WebSearchPlanOverrides } from './web-search-plans.ts'
import type { en } from './locales.ts'
import styles from './WelcomeWizard.module.css'

type T = (key: keyof typeof en, params?: Record<string, unknown>) => string

/** How the step renders one canary run. */
type ValidationView =
  | { readonly state: 'idle' }
  | { readonly state: 'validating' }
  | { readonly state: 'validated'; readonly latencyMs: number }
  | { readonly state: 'invalid'; readonly reason: string }

/** The status read as the step holds it. */
type LoadView =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly message: string }
  | { readonly phase: 'ready'; readonly status: WebSetupStatus }

/** The document-extraction selection. */
type FetchChoice = 'none' | WebFetchProviderId

/** Props of {@link WelcomeWebStep}. */
export interface WelcomeWebStepProps {
  /** Feature copy. */
  t: T
  /** Real settings and canary operations. */
  operations: ModelsOperations
  /** Operator overrides for the shipped plan rows, keyed by provider id. */
  planOverrides: WebSearchPlanOverrides
  /** Whether the shared Models join already reports a DeepSeek credential. */
  deepSeekConfigured: boolean
  /** The apply landed; a non-null `pendingRestart` is the host's restart diagnostic. */
  onApplied: (pendingRestart: { readonly ns: string; readonly message: string } | null) => void
  onSkip: () => void
  onBack: () => void
}

/** One small key glyph beside an action, matching the wizard's other steps. */
function WebKeyHint({ glyph, side }: { glyph: string; side: 'before' | 'after' }): ReactNode {
  return <kbd className={styles.keyHint} data-side={side} data-wiz-key={side} aria-hidden="true">{glyph}</kbd>
}

/** Locale key for one provider's display name, without promotional suffix. */
function providerNameKey(id: WebSearchChoice): keyof typeof en {
  switch (id) {
    case 'exa': return 'wizWebExaName'
    case 'brave': return 'wizWebBraveName'
    case 'tavily': return 'wizWebTavilyName'
    case 'searxng': return 'wizWebSearxngName'
    case 'deepseek-official': return 'wizWebDeepSeekName'
    default: return 'wizWebNone'
  }
}

/** Map raw credential vault source into human phrasing. */
function formatCredentialSource(source: string | undefined, t: T): string {
  if (source === 'user-env') return t('wizWebSourceEnv')
  if (source === 'file') return t('wizWebSourceVault')
  return source ?? t('wizWebSourceVault')
}

/**
 * Render the web-search step.
 * @param props - copy, operations, the shared credential fact, and navigation.
 * @returns the step panel.
 */
export function WelcomeWebStep(props: WelcomeWebStepProps): ReactNode {
  const { t, operations, planOverrides, deepSeekConfigured, onApplied, onSkip, onBack } = props
  const [load, setLoad] = useState<LoadView>({ phase: 'loading' })
  const [choice, setChoice] = useState<WebSearchChoice>('none')
  const [keyDraft, setKeyDraft] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [fetchChoice, setFetchChoice] = useState<FetchChoice>('http')
  const [validation, setValidation] = useState<ValidationView>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  // The shared DeepSeek credential can arrive while this step is on screen
  // (the Models join settles after the step mounted): a ref lets the one status
  // load read the newest fact without re-running and discarding the user's picks.
  const deepSeekRef = useRef(deepSeekConfigured)
  useEffect(() => { deepSeekRef.current = deepSeekConfigured }, [deepSeekConfigured])

  const loadStatus = useCallback(async (): Promise<void> => {
    setLoad({ phase: 'loading' })
    const outcome = await operations.webSetup.status()
    if (outcome.kind !== 'status') {
      setLoad({ phase: 'error', message: outcome.message })
      return
    }
    const status = outcome.status
    const sharedDeepSeek = deepSeekRef.current || status.credentials[DEEPSEEK_WEB_KEY_REF]?.configured === true
    setChoice(initialSearchChoice(status, sharedDeepSeek))
    setFetchChoice(status.fetchProvider === 'jina' ? 'jina' : status.fetchProvider === 'none' ? 'none' : 'http')
    setLoad({ phase: 'ready', status })
  }, [operations])

  useEffect(() => { void loadStatus() }, [loadStatus])

  // A selected offer the catalogue no longer renders must not linger: the
  // shared DeepSeek credential can disappear while its offer is selected (the
  // Models join settles in either direction), and Continue would otherwise hit
  // the dangling-selection guard and do nothing. The selection falls back to
  // the catalogue's initial choice for the current status.
  useEffect(() => {
    if (load.phase !== 'ready' || choice === 'none') return
    const sharedDeepSeek = deepSeekConfigured || load.status.credentials[DEEPSEEK_WEB_KEY_REF]?.configured === true
    if (availableSearchOffers(sharedDeepSeek).some(offer => offer.id === choice)) return
    setChoice(initialSearchChoice(load.status, sharedDeepSeek))
  }, [choice, deepSeekConfigured, load])

  /** The offers the step renders; DeepSeek native needs its shared credential. */
  const offers = load.phase === 'ready'
    ? availableSearchOffers(deepSeekConfigured || load.status.credentials[DEEPSEEK_WEB_KEY_REF]?.configured === true)
    : []
  const selectedOffer = choice === 'none'
    ? undefined
    : offers.find((offer): offer is WebSearchProviderOffer => offer.id === choice)

  const selectChoice = (next: WebSearchChoice): void => {
    setChoice(next)
    setKeyDraft('')
    setBaseURL('')
    setValidation({ state: 'idle' })
    setApplyError(null)
  }

  const toggleFetch = (provider: WebFetchProviderId): void => {
    setFetchChoice(current => current === provider ? 'none' : provider)
  }

  const verify = async (request: WebSetupValidateRequest): Promise<boolean> => {
    setValidation({ state: 'validating' })
    setApplyError(null)
    const outcome = await operations.webSetup.validateProvider(request)
    if (outcome.kind === 'validated') {
      setValidation({ state: 'validated', latencyMs: outcome.latencyMs })
      return true
    }
    if (outcome.kind === 'invalid') {
      setValidation({ state: 'invalid', reason: outcome.reason })
      return false
    }
    setValidation({ state: 'idle' })
    setApplyError(outcome.message.length > 0 ? outcome.message : t('wizWebServiceUnavailable'))
    return false
  }

  const applyNow = (request: WebSetupApplyRequest): void => {
    setBusy(true)
    setApplyError(null)
    void operations.webSetup.applySetup(request).then((outcome) => {
      setBusy(false)
      if (outcome.kind !== 'applied') {
        setApplyError(outcome.message.length > 0 ? outcome.message : t('wizWebApplyFailed'))
        return
      }
      onApplied(outcome.pendingRestart)
    })
  }

  const verifyNow = (): void => {
    if (choice === 'searxng') {
      const url = baseURL.trim()
      if (url.length === 0) { setApplyError(t('wizWebBaseUrlRequired')); return }
      const failure = webBaseURLFailure(url)
      if (failure !== undefined) { setApplyError(t(failure)); return }
      void verify({ kind: 'search', provider: 'searxng', baseURL: url })
      return
    }
    const offer = selectedOffer
    /* v8 ignore next -- the verify control renders only for a selected hosted offer */
    if (offer?.keyRef === undefined) return
    const typed = keyDraft.trim()
    if (typed.length === 0) { setApplyError(t('keyRequired')); return }
    const failure = apiKeyFailure(keyDraft)
    if (failure !== undefined) { setApplyError(t(failure)); return }
    void verify({ kind: 'search', provider: offer.id, apiKey: typed })
  }

  const continueStep = (): void => {
    setApplyError(null)
    /* v8 ignore next -- the Continue control renders only in the ready phase */
    if (load.phase !== 'ready') return
    const fetch = fetchChoice === 'none' ? null : fetchChoice
    const fetchEnabled = fetchChoice !== 'none'
    if (choice === 'none') {
      applyNow(webSetupWrites({ search: null, fetch, fetchEnabled, searchEnabled: false }))
      return
    }
    const offer = selectedOffer
    /* v8 ignore next -- the selection is drawn from this same filtered list */
    if (offer === undefined) return
    if (offer.needsBaseURL === true) {
      const url = baseURL.trim()
      const keepStored = url.length === 0 && load.status.searchProvider === offer.id
      if (url.length === 0 && !keepStored) { setApplyError(t('wizWebBaseUrlRequired')); return }
      const failure = webBaseURLFailure(url)
      if (failure !== undefined) { setApplyError(t(failure)); return }
      if (url.length > 0 && validation.state !== 'validated') {
        void verify({ kind: 'search', provider: offer.id, baseURL: url }).then((valid) => {
          if (valid) applyNow(webSetupWrites({ search: offer.id, baseURL: url, fetch, fetchEnabled, searchEnabled: true }))
        })
        return
      }
      applyNow(webSetupWrites({ search: offer.id, baseURL: url, fetch, fetchEnabled, searchEnabled: true }))
      return
    }
    const keyRef = offer.keyRef
    if (keyRef === undefined) {
      // DeepSeek native authenticates with the shared model key, already in use.
      applyNow(webSetupWrites({ search: offer.id, fetch, fetchEnabled, searchEnabled: true }))
      return
    }
    const typed = keyDraft.trim()
    const stored = offerKeyConfigured(offer, load.status)
    if (typed.length === 0 && !stored) {
      // Operator requirement 5: When the selected provider needs a key and none is available
      // (not typed, not from env/file), warn clearly ("No API key — web search stays off until you add one;
      // you can add it later in Settings") and still allow Continue.
      applyNow(webSetupWrites({
        search: offer.id,
        fetch,
        fetchEnabled,
        searchEnabled: false,
      }))
      return
    }
    const failure = apiKeyFailure(keyDraft)
    if (failure !== undefined) { setApplyError(t(failure)); return }
    const writes = webSetupWrites({
      search: offer.id,
      ...typed.length === 0 ? {} : { apiKey: typed },
      fetch,
      fetchEnabled,
      searchEnabled: true,
    })
    if (typed.length > 0 && validation.state !== 'validated') {
      void verify({ kind: 'search', provider: offer.id, apiKey: typed }).then((valid) => {
        if (valid) applyNow(writes)
      })
      return
    }
    applyNow(writes)
  }

  /** D3: store the candidate but leave the tool off until a later probe passes. */
  const saveAnyway = (): void => {
    /* v8 ignore next -- Save anyway renders only in the ready phase */
    if (load.phase !== 'ready') return
    const fetch = fetchChoice === 'none' ? null : fetchChoice
    const fetchEnabled = fetchChoice !== 'none'
    if (choice === 'searxng') {
      applyNow(webSetupWrites({ search: 'searxng', baseURL: baseURL.trim(), fetch, fetchEnabled, searchEnabled: false }))
      return
    }
    const offer = selectedOffer
    /* v8 ignore next -- Save anyway renders only for a selected hosted offer */
    if (offer?.keyRef === undefined) return
    const typed = keyDraft.trim()
    applyNow(webSetupWrites({
      search: offer.id,
      /* v8 ignore next -- Save anyway renders only after a typed candidate was probed */
      ...typed.length === 0 ? {} : { apiKey: typed },
      fetch,
      fetchEnabled,
      searchEnabled: false,
    }))
  }

  if (load.phase === 'loading') {
    return (
      <div className={styles.step}>
        <h2 className={styles.heading}>{t('wizWebHeading')}</h2>
        <p className={styles.fineprint} data-wiz-web-loading>{t('wizWebLoading')}</p>
        <div className={styles.actions}>
          <Button onClick={onSkip}>{t('wizWebSkip')}</Button>
        </div>
      </div>
    )
  }

  if (load.phase === 'error') {
    return (
      <div className={styles.step}>
        <h2 className={styles.heading}>{t('wizWebHeading')}</h2>
        <p className={styles.error} role="alert" data-wiz-web-error>
          {load.message.length > 0 ? load.message : t('wizWebStatusFailed')}
        </p>
        <div className={styles.actions}>
          <Button onClick={onBack}><WebKeyHint glyph="←" side="before" />{t('wizBack')}</Button>
          <Button variant="primary" onClick={() => { void loadStatus() }}>{t('retry')}</Button>
          <Button onClick={onSkip}>{t('wizWebSkip')}</Button>
        </div>
      </div>
    )
  }

  const status = load.status
  const configuredSearch = status.searchProvider !== null && status.searchProvider === choice
  const configuredFetch = status.fetchProvider !== null && status.fetchProvider === fetchChoice
  const keyFailure = selectedOffer === undefined ? undefined : apiKeyFailure(keyDraft)
  const keyConfigured = selectedOffer !== undefined && offerKeyConfigured(selectedOffer, status)
  const searchBadgeVisible = configuredSearch && (selectedOffer?.keyRef !== undefined ? keyConfigured : choice !== 'none')
  // The selected provider's plan facts come from the shipped data table (with
  // operator overrides), never from translated prose.
  const plan = selectedOffer === undefined
    ? undefined
    : resolveWebSearchPlan(selectedOffer.id, planOverrides)

  return (
    <div className={styles.step}>
      <h2 className={styles.heading}>{t('wizWebHeading')}</h2>
      <p className={styles.lead}>{t('wizWebLead')}</p>

      <div className={styles.webSelectGroup}>
        <label className={styles.fieldLabel} htmlFor="wiz-web-provider-select">
          {t('wizWebSelectLabel')}
        </label>
        <div className={styles.selectRow}>
          <select
            id="wiz-web-provider-select"
            className={`${styles.select} ${styles.selectInput}`}
            value={choice}
            data-wiz-web-select
            aria-label={t('wizWebSelectLabel')}
            disabled={busy}
            onChange={(event) => {
              selectChoice(event.target.value as WebSearchChoice)
            }}
          >
            {offers.map(offer => (
              <option
                key={offer.id}
                value={offer.id}
                data-wiz-web-offer={offer.id}
              >
                {t(offer.nameKey)}
              </option>
            ))}
          </select>
          {searchBadgeVisible ? (
            <span className={styles.chip} data-tone="off" data-wiz-web-configured>
              {t('wizWebConfiguredBadge')}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.keyBand} data-wiz-web-band={choice}>
        {choice === 'none' ? (
          <p className={styles.fineprint}>{t('wizWebNoneBody')}</p>
        ) : choice === 'searxng' ? (
          <>
            <label className={styles.fieldLabel} htmlFor="wiz-web-base-url">{t('wizWebBaseUrl')}</label>
            <div className={styles.keyRow}>
              <input
                id="wiz-web-base-url"
                className={styles.keyInput}
                type="text"
                value={baseURL}
                placeholder={t('wizWebBaseUrlPlaceholder')}
                aria-label={t('wizWebBaseUrl')}
                aria-invalid={webBaseURLFailure(baseURL) !== undefined}
                data-wiz-web-base-url
                disabled={busy}
                onChange={(event) => {
                  setBaseURL(event.target.value)
                  setValidation({ state: 'idle' })
                  setApplyError(null)
                }}
              />
            </div>
            <p className={styles.fineprint}>{t('wizWebBaseUrlHint')}</p>
            <p className={styles.fineprint}>{t('wizWebSearxngHint')}</p>
          </>
        ) : selectedOffer === undefined || selectedOffer.keyRef === undefined ? (
          <p className={styles.fineprint}>{t('wizWebDeepSeekBand')}</p>
        ) : (
          <>
            <label className={styles.fieldLabel} htmlFor="wiz-web-key">{t('keyInput')}</label>
            <div className={styles.keyRow}>
              <input
                id="wiz-web-key"
                className={styles.keyInput}
                type="password"
                autoComplete="new-password"
                value={keyDraft}
                placeholder={keyConfigured ? t('keyStored') : t('wizWebKeyPlaceholder', { provider: t(providerNameKey(selectedOffer.id)) })}
                aria-label={t('keyInput')}
                aria-invalid={keyFailure !== undefined}
                data-wiz-web-key
                disabled={busy}
                onChange={(event) => {
                  setKeyDraft(event.target.value)
                  setValidation({ state: 'idle' })
                  setApplyError(null)
                }}
              />
              <a
                className={styles.dashboardLink}
                href={selectedOffer.dashboardUrl}
                target="_blank"
                rel="noreferrer"
                data-wiz-web-dashboard
              >
                {t('wizWebDashboard', { provider: t(providerNameKey(selectedOffer.id)) })}
              </a>
            </div>
            {plan !== undefined ? (
              <p className={styles.fineprint} data-wiz-web-plan>
                {t('wizWebPlanLine', { plan: plan.plan, price: plan.price, limits: plan.limits })}
                {' · '}
                <a className={styles.dashboardLink} href={plan.link} target="_blank" rel="noreferrer">{t('wizWebPlanLink')}</a>
              </p>
            ) : null}
            {keyFailure !== undefined ? <p className={styles.error}>{t(keyFailure)}</p> : null}
            {!keyConfigured && keyDraft.trim().length === 0 ? (
              <p className={styles.warningNote} data-wiz-web-warning>
                {t('wizWebNoKeyWarning')}
              </p>
            ) : keyConfigured ? (
              <p className={styles.honestNote} data-wiz-web-key-env>
                {t('wizWebKeyEnvNote').replace('{source}', formatCredentialSource(status.credentials[selectedOffer.keyRef]?.source, t))}
              </p>
            ) : null}
          </>
        )}

        {selectedOffer !== undefined && (selectedOffer.needsBaseURL === true || selectedOffer.keyRef !== undefined) ? (
          <div className={styles.keyRow}>
            <Button
              variant="primary"
              disabled={busy || validation.state === 'validating'}
              onClick={verifyNow}
            >
              {validation.state === 'validating' ? t('wizWebVerifying') : t('wizWebVerify')}
            </Button>
            {validation.state === 'validating' ? <span className={styles.spinner} data-wiz-web-spinner aria-hidden="true" /> : null}
          </div>
        ) : null}

        {validation.state === 'validated' ? (
          <p className={styles.validNote} role="status" data-wiz-web-validation="validated">
            {t('wizWebValidated').replace('{latency}', String(validation.latencyMs))}
          </p>
        ) : null}
        {validation.state === 'invalid' ? (
          <p className={styles.error} role="alert" data-wiz-web-validation="invalid">
            {t('wizWebInvalid').replace('{reason}', validation.reason.length > 0 ? validation.reason : t('wizWebInvalidUnknown'))}
          </p>
        ) : null}
        {validation.state === 'invalid' ? (
          <div className={styles.keyRow}>
            <Button onClick={verifyNow}>{t('retry')}</Button>
            <Button onClick={saveAnyway}>{t('wizWebSaveAnyway')}</Button>
          </div>
        ) : null}
      </div>

      <div className={styles.fetchFold} data-wiz-web-fetch>
        <div className={styles.fetchHeader}>{t('wizWebFetchTitle')}</div>
        <div className={styles.fetchBody}>
          <div className={styles.fetchRow} data-on={fetchChoice === 'http' || undefined}>
            <div className={styles.fetchText}>
              <strong>{t('wizWebFetchHttp')}</strong>
              <span>{t('wizWebFetchHttpBody')}</span>
            </div>
            {configuredFetch && fetchChoice === 'http' ? <span className={styles.chip} data-tone="off">{t('wizWebConfiguredBadge')}</span> : null}
            <button
              type="button"
              role="switch"
              aria-checked={fetchChoice === 'http'}
              aria-label={t('wizWebFetchHttp')}
              className={styles.switch}
              data-wiz-web-fetch-http
              disabled={busy}
              onClick={() => { toggleFetch('http') }}
            >
              <span className={styles.knob} />
            </button>
          </div>
          {providerMounted(status, 'fetch', 'jina') ? (
            <div className={styles.fetchRow} data-on={fetchChoice === 'jina' || undefined}>
              <div className={styles.fetchText}>
                <strong>{t('wizWebFetchJina')}</strong>
                <span>{t('wizWebFetchJinaBody')}</span>
              </div>
              {configuredFetch && fetchChoice === 'jina' ? <span className={styles.chip} data-tone="off">{t('wizWebConfiguredBadge')}</span> : null}
              <button
                type="button"
                role="switch"
                aria-checked={fetchChoice === 'jina'}
                aria-label={t('wizWebFetchJina')}
                className={styles.switch}
                data-wiz-web-fetch-jina
                disabled={busy}
                onClick={() => { toggleFetch('jina') }}
              >
                <span className={styles.knob} />
              </button>
            </div>
          ) : (
            <div className={styles.fetchRow} data-coming-soon data-wiz-web-coming>
              <div className={styles.fetchText}>
                <strong>{t('wizWebFetchJina')}</strong>
                <span>{t('wizWebFetchJinaBody')}</span>
              </div>
              <span className={styles.chip}>{t('wizWebFetchComing')}</span>
            </div>
          )}
        </div>
      </div>

      {applyError === null ? null : <p className={styles.error} role="alert" data-wiz-web-error>{applyError}</p>}

      <div className={styles.actions}>
        <Button onClick={onBack}><WebKeyHint glyph="←" side="before" />{t('wizBack')}</Button>
        <Button
          variant="primary"
          disabled={busy || validation.state === 'validating'}
          onClick={continueStep}
        >
          {t('wizContinue')}<WebKeyHint glyph="→" side="after" />
        </Button>
        <Button onClick={onSkip}>{t('wizWebSkip')}</Button>
      </div>
    </div>
  )
}
