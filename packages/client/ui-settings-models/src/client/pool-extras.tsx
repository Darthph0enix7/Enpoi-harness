/**
 * Models-page Key Pool extensions. `PoolProviderCardExtras` occupies the keyed
 * `settings.models.provider-card` seat for the `llm-pi-ai` family, so every
 * pi-ai provider card carries its own collapsible pool editor;
 * `ModelsFooterExtras` occupies `settings.models.footer` with live identity
 * quota and the provider-catalog entry point. Both receive their Remote faces
 * and copy through the registration inject face and never read a context.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { LlmPoolIdentityStatus } from '@deepseek-ai/dsh-llm/types'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { AddProviderModal } from './AddProviderModal.tsx'
import { messageOf, type ModelsWire } from './store.ts'
import type { ModelsKey } from './locales.ts'
import {
  IconArrowDown, IconArrowUp, IconBolt, IconEye, IconEyeOff, IconLayers, IconPlus, IconRefresh, IconTrash,
} from './capability-icons.tsx'
import modelsStyles from './ModelsSection.module.css'
import styles from './pool-extras.module.css'

/** Remote faces and copy the Key Pool extensions receive at registration. */
export interface PoolExtrasInjected {
  /** Settings namespace reads (`describe`) and path writes (`mutate`). */
  settings: ModelsWire['settings']
  /** Credential writes for newly added pool identities. */
  credentials: ModelsWire['credentials']
  /** Live pool status, test, and cooldown-reset operations. */
  llm: ModelsWire['llm']
  /** Models-page copy. */
  t: (key: ModelsKey) => string
}

/** Owner props plus injected dependencies of the per-card pool editor. */
export type PoolProviderCardExtrasProps =
  PropsRuntime<'settings.models.provider-card'> & InjectFace<PoolExtrasInjected>

/** Owner props plus injected dependencies of the footer quota/catalog card. */
export type ModelsFooterExtrasProps =
  PropsRuntime<'settings.models.footer'> & InjectFace<PoolExtrasInjected>

/** One pool identity as stored in settings. */
interface PoolIdentityConfig {
  id: string
  credentialRef: string
  priority?: number
  enabled?: boolean
}

/** One provider's stored pool configuration. */
interface PoolConfig {
  strategy?: string
  identities: PoolIdentityConfig[]
}

/** One provider's namespace view plus the deployment's write posture. */
interface PoolView {
  writable: boolean
  namespace: SettingsNamespaceView
}

/** One identity's latest test outcome. */
interface IdentityTestResult {
  state: 'testing' | 'success' | 'error'
  message?: string
}

/** One provider with a configured pool, as the footer card groups it. */
interface PoolGroup {
  ns: string
  provider: string
  displayName: string
  identities: PoolIdentityConfig[]
}

/** The wire protocols a hand-declared pi-ai route may name (see the adapter's own table). */
const PI_AI_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** Pool collapse preferences are per provider route. */
const POOL_OPEN_PREFIX = 'dsh_pool_open_v1:'

/** Identity statuses refresh on this cadence while a surface is mounted. */
const POOL_STATUS_INTERVAL_MS = 15_000

/**
 * Read one nested value out of a JSON document without asserting a schema.
 * @param root - the document root.
 * @param path - property names to walk.
 * @returns the value at the path, or undefined when a step is not an object.
 */
function readPath(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root
  for (const key of path) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Narrow one JSON value to a string-keyed record. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Parse one stored `pool` node. Rows without an id and reference are dropped
 * rather than rendered as broken controls.
 * @param raw - the stored pool value.
 * @returns the parsed pool, or undefined when the node is not a pool.
 */
function parsePool(raw: unknown): PoolConfig | undefined {
  const record = asRecord(raw)
  if (record === undefined || !Array.isArray(record.identities)) return undefined
  const identities: PoolIdentityConfig[] = []
  for (const entry of record.identities) {
    const identity = asRecord(entry)
    if (identity === undefined || typeof identity.id !== 'string' || typeof identity.credentialRef !== 'string') continue
    identities.push({
      id: identity.id,
      credentialRef: identity.credentialRef,
      ...typeof identity.priority === 'number' ? { priority: identity.priority } : {},
      ...typeof identity.enabled === 'boolean' ? { enabled: identity.enabled } : {},
    })
  }
  return {
    ...typeof record.strategy === 'string' ? { strategy: record.strategy } : {},
    identities,
  }
}

/**
 * Load one namespace view through the settings Remote. The shared describe
 * carries every namespace, so one call answers the whole page; a missing
 * namespace means the adapter family is not mounted.
 * @param settings - the settings Remote face.
 * @param ns - namespace key to find.
 * @returns the namespace view and the deployment's write posture.
 */
async function loadPoolView(settings: ModelsWire['settings'], ns: string): Promise<PoolView> {
  const response = await settings.describe()
  if (!response.ok) throw new Error(response.error.message)
  const namespace = response.value.namespaces.find(view => view.ns === ns)
  if (namespace === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
  return { writable: response.value.writable, namespace }
}

/**
 * Format a quota reset instant or duration for display.
 * @param resetTime - the header value the provider reported.
 * @returns display text, or undefined when no reset fact exists.
 */
function formatReset(resetTime: string | number | null | undefined): string | undefined {
  if (resetTime === undefined || resetTime === null) return undefined
  if (typeof resetTime === 'number') {
    const millis = resetTime < 1e12 ? resetTime * 1000 : resetTime
    const seconds = Math.max(0, Math.round((millis - Date.now()) / 1000))
    return seconds >= 60 ? `${Math.ceil(seconds / 60)}m` : `${seconds}s`
  }
  return resetTime
}

/** Read one card's persisted collapse preference. */
function readOpenPref(provider: string): boolean {
  try {
    const stored = localStorage.getItem(`${POOL_OPEN_PREFIX}${provider}`)
    return stored === null ? true : stored === '1'
  } catch {
    // A storage-less browser keeps the in-memory default.
    return true
  }
}

/** Persist one card's collapse preference. */
function writeOpenPref(provider: string, open: boolean): void {
  try {
    localStorage.setItem(`${POOL_OPEN_PREFIX}${provider}`, open ? '1' : '0')
  } catch {
    // A storage-less browser keeps the preference for this mount only.
  }
}

/**
 * Compact collapsible Key Pool editor under one pi-ai provider card: strategy,
 * ordered identities with live status, test/reset/enable/delete/reorder, and
 * an add-key dialog that also creates the pool on first use.
 * @param props - owner provider row plus the injected Remote faces and copy.
 * @returns the pool section.
 */
export function PoolProviderCardExtras(props: PoolProviderCardExtrasProps): ReactNode {
  const { provider, settings, credentials, llm, t } = props
  const providerId = provider.provider
  const ns = provider.settingsNs
  const poolPath = useMemo(() => [...provider.settingsPath, 'pool'], [provider.settingsPath])

  const [view, setView] = useState<PoolView | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(() => readOpenPref(providerId))
  const [statuses, setStatuses] = useState<readonly LlmPoolIdentityStatus[]>([])
  const [testResults, setTestResults] = useState<Record<string, IdentityTestResult>>({})
  const [addOpen, setAddOpen] = useState(false)

  const reloadView = useCallback(async () => {
    try {
      const next = await loadPoolView(settings, ns)
      setView(next)
      setLoadError(undefined)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [settings, ns])

  useEffect(() => { void reloadView() }, [reloadView])

  const refreshStatus = useCallback(async () => {
    const response = await llm.poolStatus(ns, providerId)
    if (response.ok) setStatuses(response.value)
  }, [llm, ns, providerId])

  useEffect(() => {
    void refreshStatus()
    const timer = setInterval(() => { void refreshStatus() }, POOL_STATUS_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [refreshStatus])

  const pool = useMemo(
    () => view === undefined ? undefined : parsePool(readPath(view.namespace.value, [...poolPath])),
    [view, poolPath],
  )
  const writable = view?.writable === true

  const writePool = useCallback(async (ops: SettingsPathOpView[]): Promise<string | undefined> => {
    setBusy(true)
    try {
      const response = await settings.mutate(ns, ops, undefined)
      if (!response.ok) return response.error.message
      await reloadView()
      void refreshStatus()
      return undefined
    } catch (error) {
      return messageOf(error)
    } finally {
      setBusy(false)
    }
  }, [settings, ns, reloadView, refreshStatus])

  const runWrite = (ops: SettingsPathOpView[]): void => {
    void writePool(ops).then((failure) => { setActionError(failure) })
  }

  const toggleOpen = (): void => {
    const next = !open
    setOpen(next)
    writeOpenPref(providerId, next)
  }

  const changeStrategy = (strategy: string): void => {
    runWrite([{ op: 'set', path: [...poolPath, 'strategy'], value: strategy }])
  }

  const toggleEnabled = (identity: PoolIdentityConfig): void => {
    if (pool === undefined) return
    const identities = pool.identities.map(entry =>
      entry.id === identity.id ? { ...entry, enabled: entry.enabled === false } : entry)
    runWrite([{ op: 'set', path: [...poolPath, 'identities'], value: identities as unknown as JsonValue }])
  }

  const moveIdentity = (index: number, direction: -1 | 1): void => {
    if (pool === undefined) return
    const target = index + direction
    const entry = pool.identities[index]
    if (entry === undefined || target < 0 || target >= pool.identities.length) return
    const list = [...pool.identities]
    list.splice(index, 1)
    list.splice(target, 0, entry)
    const renumbered = list.map((item, position) => ({ ...item, priority: position + 1 }))
    runWrite([{ op: 'set', path: [...poolPath, 'identities'], value: renumbered as unknown as JsonValue }])
  }

  const deleteIdentity = (identityId: string): void => {
    if (pool === undefined) return
    if (!window.confirm(t('poolDeleteConfirm').replace('{id}', identityId))) return
    const remaining = pool.identities.filter(entry => entry.id !== identityId)
    if (remaining.length > 0) {
      runWrite([{ op: 'set', path: [...poolPath, 'identities'], value: remaining as unknown as JsonValue }])
      return
    }
    runWrite([{ op: 'unset', path: [...poolPath] }])
  }

  const testIdentity = async (identityId: string): Promise<void> => {
    setTestResults(previous => ({ ...previous, [identityId]: { state: 'testing' } }))
    const response = await llm.poolTestIdentity(ns, providerId, identityId)
    if (response.ok) {
      const result = response.value
      setTestResults(previous => ({
        ...previous,
        [identityId]: result.ok
          ? {
            state: 'success',
            message: result.latencyMs === undefined ? t('poolTestOk') : `${t('poolTestOk')} (${result.latencyMs}ms)`,
          }
          : { state: 'error', message: result.error ?? t('poolTestFailed') },
      }))
    } else {
      setTestResults(previous => ({ ...previous, [identityId]: { state: 'error', message: response.error.message } }))
    }
    void refreshStatus()
  }

  const resetCooldown = (identityId: string): void => {
    setStatuses(previous => previous.map(status =>
      status.id === identityId ? { ...status, cooldownUntil: 0 } : status))
    void llm.poolResetCooldown(ns, providerId, identityId).then((response) => {
      if (!response.ok) setActionError(response.error.message)
      return refreshStatus()
    })
  }

  const addIdentity = async (draft: { id: string; credentialRef: string; secret: string }): Promise<string | undefined> => {
    setBusy(true)
    try {
      const credential = await credentials.set(draft.credentialRef, draft.secret)
      if (!credential.ok) return credential.error.message
      const identity: PoolIdentityConfig = {
        id: draft.id,
        credentialRef: draft.credentialRef,
        priority: (pool?.identities.length ?? 0) + 1,
        enabled: true,
      }
      const identities = [...(pool?.identities ?? []), identity]
      const response = pool === undefined
        ? await settings.mutate(ns, [{
          op: 'set',
          path: [...poolPath],
          value: { strategy: 'priority-sticky', identities } as unknown as JsonValue,
        }], undefined)
        : await settings.mutate(ns, [{
          op: 'set',
          path: [...poolPath, 'identities'],
          value: identities as unknown as JsonValue,
        }], undefined)
      if (!response.ok) return response.error.message
      await reloadView()
      void refreshStatus()
      return undefined
    } catch (error) {
      return messageOf(error)
    } finally {
      setBusy(false)
    }
  }

  const now = Date.now()

  return (
    <section className={styles['poolCard']} aria-label={t('poolTitle')}>
      <div className={styles['poolHead']}>
        <button
          type="button"
          className={styles['poolToggle']}
          aria-expanded={open}
          aria-label={t('poolTitle')}
          onClick={toggleOpen}
        >
          <IconLayers size={13} />
          <span className={styles['poolTitle']}>{t('poolTitle')}</span>
          {pool !== undefined && pool.identities.length > 0
            ? <span className={styles['poolCount']}>{pool.identities.length}</span>
            : null}
          {open ? <IconArrowUp size={12} /> : <IconArrowDown size={12} />}
        </button>
        <div className={styles['poolHeadActions']}>
          {pool !== undefined
            ? (
              <select
                className={`${styles['poolStrategy']} ${modelsStyles['selectInput']}`}
                value={pool.strategy ?? 'priority-sticky'}
                aria-label={t('poolStrategy')}
                title={t('poolStrategy')}
                disabled={busy || !writable}
                onChange={(event) => { changeStrategy(event.target.value) }}
              >
                <option value="priority-sticky">{t('poolStrategyPriority')}</option>
                <option value="balanced">{t('poolStrategyBalanced')}</option>
              </select>
            )
            : null}
          <button
            type="button"
            className={styles['poolIconButton']}
            title={t('poolRefresh')}
            aria-label={t('poolRefresh')}
            onClick={() => { void reloadView(); void refreshStatus() }}
          >
            <IconRefresh size={13} />
          </button>
          <button
            type="button"
            className={styles['poolAddButton']}
            disabled={busy || !writable}
            onClick={() => { setAddOpen(true) }}
          >
            <IconPlus size={12} />
            {t('poolAdd')}
          </button>
        </div>
      </div>

      {open
        ? (
          <div className={styles['poolBody']}>
            {loadError !== undefined ? <p className={styles['poolError']} role="alert">{loadError}</p> : null}
            {actionError !== undefined ? <p className={styles['poolError']} role="alert">{actionError}</p> : null}
            {view === undefined && loadError === undefined
              ? <p className={styles['poolHint']}>{t('poolLoading')}</p>
              : null}
            {view !== undefined && (pool === undefined || pool.identities.length === 0)
              ? <p className={styles['poolHint']}>{t('poolNoPool')}</p>
              : null}
            {pool !== undefined && pool.identities.length > 0
              ? (
                <ul className={styles['poolList']}>
                  {pool.identities.map((identity, index) => {
                    const status = statuses.find(candidate => candidate.id === identity.id)
                    const cooling = status !== undefined && status.cooldownUntil > now
                    const authFailed = status?.lastStatus === 401 || status?.lastStatus === 403
                    const disabled = identity.enabled === false
                    const cooldownSeconds = cooling && status !== undefined
                      ? Math.ceil((status.cooldownUntil - now) / 1000)
                      : 0
                    const testResult = testResults[identity.id]
                    const remaining = status?.quota?.remainingFraction
                    const rowClass = disabled
                      ? `${styles['poolRow']} ${styles['poolRowOff']}`
                      : cooling
                        ? `${styles['poolRow']} ${styles['poolRowCooling']}`
                        : authFailed
                          ? `${styles['poolRow']} ${styles['poolRowError']}`
                          : styles['poolRow']
                    return (
                      <li key={identity.id} className={rowClass}>
                        <span className={styles['poolPriority']} title={`P${index + 1}`}>P{index + 1}</span>
                        <span className={styles['poolIdentity']}>
                          <span className={styles['poolNameRow']}>
                            <span className={styles['poolName']}>{identity.id}</span>
                            <span className={styles['poolRef']}>{identity.credentialRef}</span>
                          </span>
                          <span className={styles['poolStatusRow']}>
                            {disabled
                              ? (
                                <span className={`${styles['poolPill']} ${styles['poolPillOff']}`}>
                                  <span className={`${styles['poolDot']} ${styles['poolDotOff']}`} />
                                  {t('poolOff')}
                                </span>
                              )
                              : cooling
                                ? (
                                  <span className={`${styles['poolPill']} ${styles['poolPillCooling']}`}>
                                    <span className={`${styles['poolDot']} ${styles['poolDotCooling']}`} />
                                    {cooldownSeconds > 60 ? `${Math.ceil(cooldownSeconds / 60)}m` : `${cooldownSeconds}s`}
                                  </span>
                                )
                                : authFailed
                                  ? (
                                    <span className={`${styles['poolPill']} ${styles['poolPillError']}`}>
                                      <span className={`${styles['poolDot']} ${styles['poolDotError']}`} />
                                      {t('poolAuth')}
                                    </span>
                                  )
                                  : (
                                    <span className={`${styles['poolPill']} ${styles['poolPillReady']}`}>
                                      <span className={`${styles['poolDot']} ${styles['poolDotReady']}`} />
                                      {t('poolReady')}
                                    </span>
                                  )}
                            {remaining !== undefined && remaining !== null
                              ? (
                                <span className={styles['poolQuota']} title={`${Math.round(remaining * 100)}%`}>
                                  <span className={styles['poolQuotaBar']}>
                                    <span className={styles['poolQuotaFill']} style={{ width: `${Math.round(remaining * 100)}%` }} />
                                  </span>
                                  <span>{Math.round(remaining * 100)}%</span>
                                </span>
                              )
                              : null}
                            {testResult !== undefined
                              ? (
                                <span className={testResult.state === 'success'
                                  ? styles['poolTestOk']
                                  : testResult.state === 'error'
                                    ? styles['poolTestError']
                                    : styles['poolTestMuted']}
                                >
                                  {testResult.state === 'testing' ? t('poolTesting') : testResult.message}
                                </span>
                              )
                              : null}
                          </span>
                        </span>
                        <span className={styles['poolActions']}>
                          <button
                            type="button"
                            className={styles['poolIconButton']}
                            title={t('poolMoveUp')}
                            aria-label={t('poolMoveUp')}
                            disabled={index === 0 || busy || !writable}
                            onClick={() => { moveIdentity(index, -1) }}
                          >
                            <IconArrowUp size={12} />
                          </button>
                          <button
                            type="button"
                            className={styles['poolIconButton']}
                            title={t('poolMoveDown')}
                            aria-label={t('poolMoveDown')}
                            disabled={index === pool.identities.length - 1 || busy || !writable}
                            onClick={() => { moveIdentity(index, 1) }}
                          >
                            <IconArrowDown size={12} />
                          </button>
                          {cooling
                            ? (
                              <button
                                type="button"
                                className={styles['poolIconButton']}
                                title={t('poolReset')}
                                aria-label={t('poolReset')}
                                disabled={busy || !writable}
                                onClick={() => { resetCooldown(identity.id) }}
                              >
                                <IconRefresh size={12} />
                              </button>
                            )
                            : null}
                          <button
                            type="button"
                            className={styles['poolIconButton']}
                            title={t('poolTest')}
                            aria-label={t('poolTest')}
                            disabled={testResult?.state === 'testing' || busy || !writable}
                            onClick={() => { void testIdentity(identity.id) }}
                          >
                            <IconBolt size={12} />
                          </button>
                          <button
                            type="button"
                            className={styles['poolIconButton']}
                            title={disabled ? t('poolEnable') : t('poolDisable')}
                            aria-label={disabled ? t('poolEnable') : t('poolDisable')}
                            disabled={busy || !writable}
                            onClick={() => { toggleEnabled(identity) }}
                          >
                            {disabled ? <IconEyeOff size={12} /> : <IconEye size={12} />}
                          </button>
                          <button
                            type="button"
                            className={`${styles['poolIconButton']} ${styles['poolIconDanger']}`}
                            title={t('poolDelete')}
                            aria-label={t('poolDelete')}
                            disabled={busy || !writable}
                            onClick={() => { deleteIdentity(identity.id) }}
                          >
                            <IconTrash size={12} />
                          </button>
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )
              : null}
          </div>
        )
        : null}

      <AddIdentityDialog
        open={addOpen}
        providerId={providerId}
        defaultPriority={(pool?.identities.length ?? 0) + 1}
        t={t}
        onClose={() => { setAddOpen(false) }}
        onSubmit={addIdentity}
      />
    </section>
  )
}

/** Props of the add-key dialog. */
interface AddIdentityDialogProps {
  open: boolean
  providerId: string
  defaultPriority: number
  t: (key: ModelsKey) => string
  onClose: () => void
  onSubmit: (draft: { id: string; credentialRef: string; secret: string }) => Promise<string | undefined>
}

/** Add one identity: name, credential reference, and the secret itself. */
function AddIdentityDialog(props: AddIdentityDialogProps): ReactNode {
  const { open, providerId, defaultPriority, t, onClose, onSubmit } = props
  const idPrefix = useId()
  const [name, setName] = useState('')
  const [ref, setRef] = useState('')
  const [secret, setSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const defaultRef = `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_KEY_${defaultPriority}`

  const submit = async (): Promise<void> => {
    const identityName = name.trim()
    const credentialRef = ref.trim() || defaultRef
    const value = secret.trim()
    if (identityName.length === 0 || value.length === 0) {
      setError(t('poolMissingFields'))
      return
    }
    setBusy(true)
    setError(undefined)
    const failure = await onSubmit({ id: identityName, credentialRef, secret: value })
    setBusy(false)
    if (failure !== undefined) {
      setError(failure)
      return
    }
    setName('')
    setRef('')
    setSecret('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('poolAddTitle')}
      closeLabel={t('close')}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>
            {busy ? t('poolSaving') : t('poolSave')}
          </Button>
        </>
      )}
    >
      {error !== undefined ? <p className={styles['poolError']} role="alert">{error}</p> : null}
      <div className={styles['poolField']}>
        <label className={styles['poolFieldLabel']} htmlFor={`${idPrefix}-name`}>{t('poolName')}</label>
        <input
          id={`${idPrefix}-name`}
          className={styles['poolInput']}
          type="text"
          value={name}
          placeholder={t('poolNamePlaceholder')}
          disabled={busy}
          onChange={(event) => { setName(event.target.value) }}
        />
      </div>
      <div className={styles['poolField']}>
        <label className={styles['poolFieldLabel']} htmlFor={`${idPrefix}-ref`}>{t('poolRef')}</label>
        <input
          id={`${idPrefix}-ref`}
          className={styles['poolInput']}
          type="text"
          value={ref}
          placeholder={`${t('poolRefPlaceholder')} — ${defaultRef}`}
          disabled={busy}
          onChange={(event) => { setRef(event.target.value) }}
        />
      </div>
      <div className={styles['poolField']}>
        <label className={styles['poolFieldLabel']} htmlFor={`${idPrefix}-secret`}>{t('poolSecret')}</label>
        <div className={styles['poolSecretWrap']}>
          <input
            id={`${idPrefix}-secret`}
            className={styles['poolInput']}
            type={showSecret ? 'text' : 'password'}
            autoComplete="off"
            value={secret}
            placeholder={t('poolSecretPlaceholder')}
            disabled={busy}
            onChange={(event) => { setSecret(event.target.value) }}
          />
          <button
            type="button"
            className={styles['poolIconButton']}
            title={showSecret ? t('poolDisable') : t('poolEnable')}
            aria-label={showSecret ? t('poolDisable') : t('poolEnable')}
            onClick={() => { setShowSecret(!showSecret) }}
          >
            {showSecret ? <IconEyeOff size={13} /> : <IconEye size={13} />}
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Footer card: live identity quota for every provider that has a pool, and the
 * provider-catalog entry point that creates a pi-ai profile from a preset.
 * @param props - injected Remote faces and copy.
 * @returns the usage/quota card.
 */
export function ModelsFooterExtras(props: ModelsFooterExtrasProps): ReactNode {
  const { settings, credentials, llm, t } = props
  const [namespaces, setNamespaces] = useState<readonly SettingsNamespaceView[] | undefined>(undefined)
  const [writable, setWritable] = useState(true)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [statuses, setStatuses] = useState<Record<string, readonly LlmPoolIdentityStatus[]>>({})
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [taken, setTaken] = useState<readonly string[]>([])

  const reload = useCallback(async () => {
    try {
      const response = await settings.describe()
      if (!response.ok) {
        setLoadError(response.error.message)
        return
      }
      setNamespaces(response.value.namespaces)
      setWritable(response.value.writable)
      setLoadError(undefined)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [settings])

  useEffect(() => { void reload() }, [reload])

  const groups = useMemo<PoolGroup[]>(() => {
    const found: PoolGroup[] = []
    for (const view of namespaces ?? []) {
      const providers = asRecord(readPath(view.value, ['providers']))
      if (providers === undefined) continue
      for (const [provider, rawProfile] of Object.entries(providers)) {
        const profile = asRecord(rawProfile)
        const pool = parsePool(readPath(profile, ['pool']))
        if (pool === undefined || pool.identities.length === 0) continue
        const displayName = typeof profile?.displayName === 'string' ? profile.displayName : provider
        found.push({ ns: view.ns, provider, displayName, identities: pool.identities })
      }
    }
    return found
  }, [namespaces])

  const groupKeys = useMemo(
    () => groups.map(group => `${group.ns}\u0000${group.provider}`),
    [groups],
  )

  const refreshStatuses = useCallback(async () => {
    const entries = await Promise.all(groups.map(async (group) => {
      const response = await llm.poolStatus(group.ns, group.provider)
      return [`${group.ns}\u0000${group.provider}`, response.ok ? response.value : []] as const
    }))
    setStatuses(Object.fromEntries(entries))
  }, [llm, groups])

  useEffect(() => {
    if (groupKeys.length === 0) return
    void refreshStatuses()
    const timer = setInterval(() => { void refreshStatuses() }, POOL_STATUS_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [groupKeys.length, refreshStatuses])

  const openCatalog = async (): Promise<void> => {
    const response = await llm.listConfigurableProviders()
    setTaken(response.ok ? response.value.map(entry => entry.provider) : [])
    setCatalogOpen(true)
  }

  const now = Date.now()

  return (
    <section className={styles['quotaCard']} aria-label={t('quotaTitle')}>
      <div className={styles['quotaHead']}>
        <span className={styles['quotaTitle']}>
          <IconLayers size={13} />
          {t('quotaTitle')}
        </span>
        <div className={styles['quotaHeadActions']}>
          <button
            type="button"
            className={styles['poolIconButton']}
            title={t('poolRefresh')}
            aria-label={t('poolRefresh')}
            onClick={() => { void reload(); void refreshStatuses() }}
          >
            <IconRefresh size={13} />
          </button>
          <button
            type="button"
            className={styles['poolAddButton']}
            disabled={!writable}
            onClick={() => { void openCatalog() }}
          >
            <IconPlus size={12} />
            {t('catalogOpen')}
          </button>
        </div>
      </div>

      <div className={styles['quotaBody']}>
        {loadError !== undefined ? <p className={styles['poolError']} role="alert">{loadError}</p> : null}
        {namespaces !== undefined && groups.length === 0
          ? <p className={styles['poolHint']}>{t('quotaEmpty')}</p>
          : null}
        {groups.map((group) => {
          const key = `${group.ns}\u0000${group.provider}`
          return (
            <div key={key} className={styles['quotaGroup']}>
              <div className={styles['quotaProvider']}>
                <span className={styles['quotaProviderName']}>{group.displayName}</span>
                <span className={styles['quotaProviderId']}>{group.provider}</span>
              </div>
              <ul className={styles['quotaList']}>
                {group.identities.map((identity) => {
                  const status = statuses[key]?.find(candidate => candidate.id === identity.id)
                  const cooling = status !== undefined && status.cooldownUntil > now
                  const remaining = status?.quota?.remainingFraction
                  const reset = formatReset(status?.quota?.resetTime)
                  const cooldownSeconds = cooling && status !== undefined
                    ? Math.ceil((status.cooldownUntil - now) / 1000)
                    : 0
                  return (
                    <li key={identity.id} className={styles['quotaRow']}>
                      <span className={styles['quotaIdentity']}>{identity.id}</span>
                      {remaining !== undefined && remaining !== null
                        ? (
                          <span className={styles['poolQuota']}>
                            <span className={styles['poolQuotaBar']}>
                              <span
                                className={styles['poolQuotaFill']}
                                style={{ width: `${Math.round(remaining * 100)}%` }}
                              />
                            </span>
                            <span>{Math.round(remaining * 100)}%</span>
                          </span>
                        )
                        : <span className={styles['poolTestMuted']}>{t('quotaNoQuota')}</span>}
                      {cooling
                        ? (
                          <span className={`${styles['poolPill']} ${styles['poolPillCooling']}`}>
                            <span className={`${styles['poolDot']} ${styles['poolDotCooling']}`} />
                            {cooldownSeconds > 60 ? `${Math.ceil(cooldownSeconds / 60)}m` : `${cooldownSeconds}s`}
                          </span>
                        )
                        : null}
                      {reset !== undefined
                        ? <span className={styles['quotaReset']}>{t('quotaResets')} {reset}</span>
                        : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>

      <AddProviderModal
        open={catalogOpen}
        taken={taken}
        protocols={PI_AI_PROTOCOLS}
        api={{ settings, credentials, llm }}
        t={t}
        readOnly={!writable}
        onClose={(created) => {
          setCatalogOpen(false)
          if (created === true) void reload()
        }}
      />
    </section>
  )
}
