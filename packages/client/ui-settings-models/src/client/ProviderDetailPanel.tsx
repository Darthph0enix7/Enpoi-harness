import { useState, useMemo, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'
import type {
  CredentialView, IApiClient, PoolIdentityStatusView, SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  IconEye, IconEyeOff, IconTools, IconBrain, IconVision, IconAudio, IconVideo, IconFile,
  IconKey, IconBolt, IconTrash, IconCheck, IconSearch, IconServer,
  IconPlus, IconRefresh, IconArrowUp, IconArrowDown, IconLayers,
} from './capability-icons.tsx'
import {
  toggleModelHidden, hideAllModels, showAllModels, subscribeHiddenModels,
} from './hidden-models.ts'
import { deriveKeyRef, messageOf, protocolChoices, type ProviderRow } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

export interface ProviderDetailPanelProps {
  row: ProviderRow
  namespace: SettingsNamespaceView
  schema: SettingsSchemaOperations
  api: Pick<IApiClient, 'settings' | 'credentials' | 'llm'>
  t: (key: keyof typeof en) => string
  readOnly: boolean
  onDelete: () => void
  onSaved: () => void
}

interface ModelItem {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoningEfforts?: Record<string, unknown>
  reasoning?: boolean | object
  input?: string[]
  architecture?: { input_modalities?: string[] }
  supported_parameters?: string[]
  tools?: boolean
  vision?: boolean
  audio?: boolean
  video?: boolean
  files?: boolean
}

/** Detect capabilities based on model ID, name, modalities, or provider metadata. */
function detectCapabilities(model: ModelItem) {
  const id = (model.id || '').toLowerCase()
  const inputs: string[] = Array.isArray(model.input)
    ? model.input
    : Array.isArray(model.architecture?.input_modalities)
      ? model.architecture.input_modalities
      : []

  // 1. REASONING / THINKING
  const hasReasoning = Boolean(
    model.reasoningEfforts ||
    (typeof model.reasoning === 'boolean' && model.reasoning) ||
    (typeof model.reasoning === 'object' && model.reasoning !== null) ||
    model.supported_parameters?.includes('reasoning') ||
    model.supported_parameters?.includes('reasoning_effort') ||
    model.supported_parameters?.includes('include_reasoning') ||
    id.includes('think') ||
    id.includes('reason') ||
    id.includes('luna') ||
    id.includes('sol') ||
    id.includes('terra') ||
    id.includes('deepseek-v4') ||
    id.includes('deepseek-r') ||
    id.includes('r1') ||
    id.includes('o1') ||
    id.includes('o3') ||
    id.includes('o4') ||
    id.includes('flash-tiered') ||
    id.includes('pro-agent') ||
    id.includes('pro-high') ||
    id.includes('k3') ||
    id.includes('m3') ||
    id.includes('glm-5') ||
    id.includes('fable-5') ||
    id.includes('opus-5') ||
    id.includes('opus-4-8') ||
    id.includes('opus-4-7') ||
    id.includes('opus-4-6'),
  )

  // 2. VISION / IMAGE INPUT
  const hasVision = Boolean(
    model.vision ?? (
      inputs.includes('image') ||
      inputs.includes('vision') ||
      id.includes('vision') ||
      id.includes('vl') ||
      id.includes('minimax') ||
      id.includes('gemini') ||
      id.includes('claude') ||
      id.includes('gpt-4') ||
      id.includes('gpt-5') ||
      id.includes('luna') ||
      id.includes('k3') ||
      id.includes('qwen-vl') ||
      id.includes('qwen2.5-vl') ||
      id.includes('qwen3-vl') ||
      id.includes('qwen3.8-vl') ||
      id.includes('pixtral') ||
      id.includes('grok-2') ||
      id.includes('internvl') ||
      id.includes('llava') ||
      id.includes('glm-4v') ||
      id.includes('glm-5v') ||
      id.includes('mimo')
    ),
  )

  // 3. AUDIO INPUT
  const hasAudio = Boolean(
    model.audio ?? (
      inputs.includes('audio') ||
      inputs.includes('voice') ||
      id.includes('audio') ||
      id.includes('voice') ||
      id.includes('whisper') ||
      id.includes('gemini-3.7') ||
      id.includes('gemini-3.6') ||
      id.includes('gemini-2.5') ||
      id.includes('gemini-1.5') ||
      id.includes('minimax-m3') ||
      id.includes('minimax-m2.7') ||
      id.includes('minimax-m2.5') ||
      id.includes('gpt-4o-audio') ||
      id.includes('gpt-4o-realtime')
    ),
  )

  // 4. VIDEO INPUT
  const hasVideo = Boolean(
    model.video ?? (
      inputs.includes('video') ||
      id.includes('gemini-3.7') ||
      id.includes('gemini-3.6') ||
      id.includes('gemini-3.1') ||
      id.includes('gemini-2.5') ||
      id.includes('gemini-1.5') ||
      id.includes('minimax-m3') ||
      id.includes('minimax-m2.7') ||
      id.includes('qwen-vl') ||
      id.includes('qwen2.5-vl')
    ),
  )

  // 5. TOOL CALLING
  const hasTools = Boolean(
    model.tools ?? (
      model.supported_parameters?.includes('tools') ||
      (!id.includes('embed') && !id.includes('reward') && !id.includes('rerank') && !id.includes('flux') && !id.includes('dall-e') && !id.includes('text-01'))
    ),
  )

  // 6. DOCUMENTS & FILES (Genuine native document parsing, NOT just general text context)
  const hasFiles = Boolean(
    model.files ?? (
      inputs.includes('file') ||
      id.includes('claude') ||
      id.includes('gemini') ||
      id.includes('gpt-4') ||
      id.includes('gpt-5') ||
      id.includes('luna') ||
      id.includes('pdf') ||
      id.includes('document')
    ),
  )

  return { hasReasoning, hasVision, hasAudio, hasVideo, hasTools, hasFiles }
}

function formatTokens(count?: number): string {
  if (!count || count <= 0) return ''
  if (count >= 1_000_000) {
    const m = count / 1_000_000
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(2).replace(/\.?0+$/, '')}M`
  }
  if (count >= 1_000) {
    const k = count / 1_000
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1).replace(/\.?0+$/, '')}K`
  }
  return String(count)
}

export function ProviderDetailPanel(props: ProviderDetailPanelProps): ReactNode {
  const { row, namespace, schema, api, t: _t, readOnly, onDelete, onSaved } = props
  const providerId = row.entry.provider
  const isDeclared = row.entry.declared === true

  // Raw profile from settings
  const rawProfile = useMemo(() => {
    return (schema.getPath(namespace.user, row.entry.settingsPath) ??
      schema.getPath(namespace.value, row.entry.settingsPath) ??
      {}) as Record<string, unknown>
  }, [namespace, row.entry.settingsPath, schema])

  // State
  const [displayName, setDisplayName] = useState<string>(
    typeof rawProfile.displayName === 'string' ? rawProfile.displayName : row.entry.displayName,
  )
  const [baseURL, setBaseURL] = useState<string>(
    typeof rawProfile.baseURL === 'string' ? rawProfile.baseURL : '',
  )
  const [protocol, setProtocol] = useState<string>(
    typeof rawProfile.api === 'string' ? rawProfile.api : 'openai-completions',
  )
  const [keyInput, setKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyState, setKeyState] = useState<CredentialView | undefined>(row.credential)
  const [modelSearch, setModelSearch] = useState('')
  const [hiddenSet, setHiddenSet] = useState<Set<string>>(() => new Set())
  const [testStatus, setTestStatus] = useState<{
    state: 'idle' | 'testing' | 'success' | 'error'
    message?: string
    latencyMs?: number
    modelCount?: number
  }>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Pool State
  const poolConfig = useMemo(() => {
    const p = rawProfile.pool as {
      strategy?: string
      identities?: Array<{ id: string; credentialRef: string; priority?: number; enabled?: boolean }>
    } | undefined
    return p && Array.isArray(p.identities) ? p : undefined
  }, [rawProfile.pool])

  const [poolStatusList, setPoolStatusList] = useState<PoolIdentityStatusView[]>([])
  const [isPoolLoading, setIsPoolLoading] = useState(false)
  const [identityTestResults, setIdentityTestResults] = useState<Record<string, { state: 'testing' | 'success' | 'error'; message?: string; latencyMs?: number }>>({})
  const [showAddKeyModal, setShowAddKeyModal] = useState(false)
  const [newKeyId, setNewKeyId] = useState('')
  const [newKeyRef, setNewKeyRef] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [newKeyPriority, setNewKeyPriority] = useState<number>(1)
  const [newKeyShow, setNewKeyShow] = useState(false)

  // Fetch live pool status from host
  const fetchPoolStatus = useCallback(async () => {
    try {
      setIsPoolLoading(true)
      const res = await api.llm.poolStatus({
        settingsNs: namespace.ns,
        provider: providerId,
      })
      if (res.result.ok) {
        setPoolStatusList(res.result.value.identities || [])
      }
    } catch {
      // Ignored if host or route has no active pool engine
    } finally {
      setIsPoolLoading(false)
    }
  }, [api.llm, namespace.ns, providerId])

  useEffect(() => {
    fetchPoolStatus()
    const timer = setInterval(fetchPoolStatus, 15000)
    return () => clearInterval(timer)
  }, [fetchPoolStatus])

  // Protocols
  const protocols = useMemo(() => protocolChoices(namespace, schema), [namespace, schema])

  // Key ref
  const keyRef = useMemo(() => {
    return typeof rawProfile.apiKeyEnv === 'string' && rawProfile.apiKeyEnv.length > 0
      ? rawProfile.apiKeyEnv
      : deriveKeyRef(providerId)
  }, [providerId, rawProfile.apiKeyEnv])

  // Subscribe to hidden models
  useEffect(() => {
    const updateHidden = () => {
      // Query localStorage
      try {
        const raw = localStorage.getItem('dsh_hidden_models_v1')
        if (raw) {
          const map = JSON.parse(raw)
          setHiddenSet(new Set(map[providerId] || []))
        } else {
          setHiddenSet(new Set())
        }
      } catch {
        setHiddenSet(new Set())
      }
    }
    updateHidden()
    return subscribeHiddenModels((p) => {
      if (!p || p === providerId) updateHidden()
    })
  }, [providerId])

  // Sync profile when row changes
  useEffect(() => {
    setDisplayName(typeof rawProfile.displayName === 'string' ? rawProfile.displayName : row.entry.displayName)
    setBaseURL(typeof rawProfile.baseURL === 'string' ? rawProfile.baseURL : '')
    setProtocol(typeof rawProfile.api === 'string' ? rawProfile.api : 'openai-completions')
    setKeyInput('')
    setTestStatus({ state: 'idle' })
    setSaveSuccess(false)
  }, [providerId, rawProfile, row.entry.displayName])

  // Models list
  const modelsList = useMemo<ModelItem[]>(() => {
    const list = rawProfile.models
    if (Array.isArray(list) && list.length > 0) {
      return list as ModelItem[]
    }
    return []
  }, [rawProfile.models])

  // Filtered models
  const filteredModels = useMemo(() => {
    const q = modelSearch.toLowerCase().trim()
    if (!q) return modelsList
    return modelsList.filter((m) => {
      const name = (m.name || '').toLowerCase()
      const id = (m.id || '').toLowerCase()
      return name.includes(q) || id.includes(q)
    })
  }, [modelSearch, modelsList])

  // Toggle model hidden
  const handleToggleHide = (modelId: string) => {
    const nextHidden = toggleModelHidden(providerId, modelId)
    setHiddenSet((prev) => {
      const next = new Set(prev)
      if (nextHidden) next.add(modelId)
      else next.delete(modelId)
      return next
    })
  }

  // Bulk hide/show
  const handleHideAll = () => {
    const allIds = modelsList.map(m => m.id)
    hideAllModels(providerId, allIds)
    setHiddenSet(new Set(allIds))
  }

  const handleShowAll = () => {
    showAllModels(providerId)
    setHiddenSet(new Set())
  }

  // Test Connection
  const handleTestConnection = async () => {
    setTestStatus({ state: 'testing' })
    const startTime = performance.now()
    try {
      const res = await api.llm.discoverModels({
        settingsNs: namespace.ns,
        provider: providerId,
        ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
        api: protocol,
        ...(keyInput.trim() ? { apiKey: keyInput.trim() } : {}),
      })
      const latencyMs = Math.round(performance.now() - startTime)
      if (res.result.ok) {
        const count = res.result.value.models?.length ?? 0
        setTestStatus({
          state: 'success',
          message: `Connected successfully (${count} models discovered)`,
          latencyMs,
          modelCount: count,
        })
      } else {
        setTestStatus({
          state: 'error',
          message: res.result.error.message,
          latencyMs,
        })
      }
    } catch (err) {
      setTestStatus({
        state: 'error',
        message: messageOf(err),
      })
    }
  }

  // Refresh Models live from endpoint
  const [refreshState, setRefreshState] = useState<{ isRefreshing: boolean; message?: string; isError?: boolean }>({
    isRefreshing: false,
  })

  const handleRefreshModels = async () => {
    if (refreshState.isRefreshing || readOnly) return
    setRefreshState({ isRefreshing: true })
    try {
      const res = await api.llm.discoverModels({
        settingsNs: namespace.ns,
        provider: providerId,
        ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
        api: protocol,
        ...(keyInput.trim() ? { apiKey: keyInput.trim() } : {}),
      })
      if (res.result.ok) {
        const discovered = res.result.value.models || []
        const currentModels = Array.isArray(rawProfile.models) ? (rawProfile.models as ModelItem[]) : []
        const merged = discovered.map((d: { id: string; name?: string; contextWindow?: number; maxTokens?: number }) => {
          const existing = currentModels.find(m => m.id === d.id) as ModelItem | undefined
          return {
            ...(existing || {}),
            id: d.id,
            name: d.name && d.name !== d.id ? d.name : existing?.name || d.id,
            contextWindow: d.contextWindow || existing?.contextWindow || 131072,
            maxTokens: d.maxTokens || existing?.maxTokens || 8192,
          }
        })

        const settingsRes = await api.settings.mutate({
          ns: namespace.ns,
          ops: [{ op: 'set', path: [...row.entry.settingsPath, 'models'], value: merged }],
        })

        if (!settingsRes.result.ok) {
          throw new Error(settingsRes.result.error.message)
        }

        setRefreshState({
          isRefreshing: false,
          message: `Refreshed ${merged.length} models live!`,
          isError: false,
        })
        setTimeout(() => setRefreshState({ isRefreshing: false }), 4000)
        onSaved()
      } else {
        throw new Error(res.result.error.message)
      }
    } catch (err) {
      setRefreshState({
        isRefreshing: false,
        message: `Refresh failed: ${messageOf(err)}`,
        isError: true,
      })
      setTimeout(() => setRefreshState({ isRefreshing: false }), 5000)
    }
  }

  // Save Settings / API Key
  const handleSave = async () => {
    setBusy(true)
    setSaveSuccess(false)
    try {
      const cleanKey = keyInput.trim()
      if (cleanKey.length > 0) {
        const credRes = await api.credentials.set({ ref: keyRef, value: cleanKey })
        if (!credRes.result.ok) {
          throw new Error(credRes.result.error.message)
        }
        setKeyState({ configured: true, writable: true })
      }

      // Update settings
      const updatedProfile: Record<string, unknown> = {
        ...rawProfile,
        displayName: displayName.trim() || providerId,
        ...baseURL.trim() ? { baseURL: baseURL.trim() } : {},
        ...protocol ? { api: protocol } : {},
        ...cleanKey.length > 0 ? { apiKeyEnv: keyRef } : {},
      }

      const settingsRes = await api.settings.mutate({
        ns: namespace.ns,
        ops: [{ op: 'set', path: [...row.entry.settingsPath], value: updatedProfile }],
      })

      if (!settingsRes.result.ok) {
        throw new Error(settingsRes.result.error.message)
      }

      setKeyInput('')
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
      onSaved()
    } catch (err) {
      alert(`Save failed: ${messageOf(err)}`)
    } finally {
      setBusy(false)
    }
  }

  // Pool Handlers
  const handleTestIdentity = async (identityId: string, _credentialRef: string) => {
    setIdentityTestResults(prev => ({
      ...prev,
      [identityId]: { state: 'testing' },
    }))
    try {
      const res = await api.llm.poolTestIdentity({
        settingsNs: namespace.ns,
        provider: providerId,
        identityId,
      })
      const r = res.result
      if (r.ok) {
        if (r.value.ok) {
          const lat = r.value.latencyMs
          setIdentityTestResults(prev => ({
            ...prev,
            [identityId]: {
              state: 'success',
              ...lat !== undefined ? { latencyMs: lat } : {},
              message: lat !== undefined ? `OK (${lat}ms)` : 'OK',
            },
          }))
        } else {
          setIdentityTestResults(prev => ({
            ...prev,
            [identityId]: {
              state: 'error',
              message: r.value.error || 'Test failed',
            },
          }))
        }
      } else {
        setIdentityTestResults(prev => ({
          ...prev,
          [identityId]: {
            state: 'error',
            message: r.error.message,
          },
        }))
      }
    } catch (err) {
      setIdentityTestResults(prev => ({
        ...prev,
        [identityId]: {
          state: 'error',
          message: messageOf(err),
        },
      }))
    }
    fetchPoolStatus()
  }

  const handleResetCooldown = async (identityId?: string) => {
    try {
      await api.llm.poolResetCooldown({
        settingsNs: namespace.ns,
        provider: providerId,
        ...identityId ? { identityId } : {},
      })
      await fetchPoolStatus()
    } catch (err) {
      alert(`Reset cooldown failed: ${messageOf(err)}`)
    }
  }

  const handleToggleIdentityEnabled = async (identityId: string) => {
    if (!poolConfig?.identities || readOnly) return
    const nextIdentities = poolConfig.identities.map((i) => {
      if (i.id === identityId) {
        return { ...i, enabled: i.enabled === false }
      }
      return i
    })
    try {
      const updated = { ...rawProfile, pool: { ...poolConfig, identities: nextIdentities } }
      await api.settings.mutate({
        ns: namespace.ns,
        ops: [{ op: 'set', path: [...row.entry.settingsPath], value: updated }],
      })
      onSaved()
      fetchPoolStatus()
    } catch (err) {
      alert(`Update failed: ${messageOf(err)}`)
    }
  }

  const handleStrategyChange = async (strategy: string) => {
    if (!poolConfig || readOnly) return
    try {
      // Leaf-path write: replacing the whole profile here would revert any
      // concurrent edit under providers.<id> (e.g. a catalog sync refresh).
      await api.settings.mutate({
        ns: namespace.ns,
        ops: [{ op: 'set', path: [...row.entry.settingsPath, 'pool', 'strategy'], value: strategy }],
      })
      onSaved()
    } catch (err) {
      alert(`Strategy change failed: ${messageOf(err)}`)
    }
  }

  const handleMoveIdentity = async (index: number, direction: -1 | 1) => {    if (!poolConfig?.identities || readOnly) return
    const targetIdx = index + direction
    if (targetIdx < 0 || targetIdx >= poolConfig.identities.length) return
    const list = [...poolConfig.identities]
    const item = list[index]
    if (!item) return
    list.splice(index, 1)
    list.splice(targetIdx, 0, item)
    // Update priorities according to new order
    const updatedIdentities = list.map((idObj, idx) => ({ ...idObj, priority: idx + 1 }))
    try {
      const updated = { ...rawProfile, pool: { ...poolConfig, identities: updatedIdentities } }
      await api.settings.mutate({
        ns: namespace.ns,
        ops: [{ op: 'set', path: [...row.entry.settingsPath], value: updated }],
      })
      onSaved()
      fetchPoolStatus()
    } catch (err) {
      alert(`Reorder failed: ${messageOf(err)}`)
    }
  }

  const handleDeleteIdentity = async (identityId: string) => {
    if (!poolConfig?.identities || readOnly) return
    if (!confirm(`Remove identity "${identityId}" from pool?`)) return
    const remaining = poolConfig.identities.filter(i => i.id !== identityId)
    try {
      const updated: Record<string, unknown> = {
        ...rawProfile,
        ...remaining.length > 0
          ? { pool: { ...poolConfig, identities: remaining } }
          : { pool: undefined },
      }
      await api.settings.mutate({
        ns: namespace.ns,
        ops: [{ op: 'set', path: [...row.entry.settingsPath], value: updated }],
      })
      onSaved()
      fetchPoolStatus()
    } catch (err) {
      alert(`Delete failed: ${messageOf(err)}`)
    }
  }

  const handleAddIdentitySubmit = async () => {
    const id = newKeyId.trim()
    const ref = newKeyRef.trim() || `${providerId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_KEY_${Date.now().toString().slice(-4)}`
    const val = newKeyValue.trim()
    if (!id || !val) {
      alert('Identity Name and API Key are required.')
      return
    }
    setBusy(true)
    try {
      // 1. Store credential
      const credRes = await api.credentials.set({ ref, value: val })
      if (!credRes.result.ok) throw new Error(credRes.result.error.message)

      // 2. Append identity to pool
      const currentList = poolConfig?.identities ? [...poolConfig.identities] : []
      const newIdentity = {
        id,
        credentialRef: ref,
        priority: newKeyPriority || (currentList.length + 1),
        enabled: true,
      }
      currentList.push(newIdentity)

      const updated = {
        ...rawProfile,
        pool: {
          strategy: poolConfig?.strategy || 'priority-sticky',
          identities: currentList,
        },
      }

      const res = await api.settings.mutate({
        ns: namespace.ns,
        ops: [{ op: 'set', path: [...row.entry.settingsPath], value: updated }],
      })
      if (!res.result.ok) throw new Error(res.result.error.message)

      // Reset modal state
      setShowAddKeyModal(false)
      setNewKeyId('')
      setNewKeyRef('')
      setNewKeyValue('')
      setNewKeyPriority(1)
      onSaved()
      fetchPoolStatus()
    } catch (err) {
      alert(`Failed to add identity: ${messageOf(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleConvertToPool = async () => {
    if (!row.apiKeyEnv) {
      // No key configured yet, just open add key modal
      setShowAddKeyModal(true)
      return
    }
    const initialIdentity = {
      id: 'primary',
      credentialRef: row.apiKeyEnv,
      priority: 1,
      enabled: true,
    }
    try {
      const updated = {
        ...rawProfile,
        pool: {
          strategy: 'priority-sticky',
          identities: [initialIdentity],
        },
      }
      const res = await api.settings.mutate({
        ns: namespace.ns,
        ops: [{ op: 'set', path: [...row.entry.settingsPath], value: updated }],
      })
      if (!res.result.ok) throw new Error(res.result.error.message)
      onSaved()
      fetchPoolStatus()
    } catch (err) {
      alert(`Convert to pool failed: ${messageOf(err)}`)
    }
  }

  const isConfigured = keyState?.configured === true || !row.apiKeyEnv

  return (
    <div className={styles['detailPanel']}>
      {/* Detail Header */}
      <div className={styles['detailHeader']}>
        <div className={styles['detailIdentity']}>
          <div className={styles['detailAvatar']}>
            <IconServer size={18} />
          </div>
          <div>
            <div className={styles['detailTitleRow']}>
              <h2 className={styles['detailTitle']}>{displayName}</h2>
              <span className={styles['routeSlugBadge']}>{providerId}</span>
              {isDeclared && <span className={styles['customBadge']}>Custom</span>}
            </div>
            <p className={styles['detailSub']}>
              <span className={styles['protocolTag']}>{protocol}</span> • <span className={styles['countTag']}>{modelsList.length} models</span>
            </p>
          </div>
        </div>

        <div className={styles['detailActions']}>
          {row.removable && (
            <Button
              variant="outline"
              className={styles['deleteBtn']}
              onClick={onDelete}
              disabled={readOnly || busy}
            >
              <IconTrash size={12} />
              Delete
            </Button>
          )}
        </div>
      </div>

      {/* Key Pool & Identities Card */}
      {poolConfig && poolConfig.identities && poolConfig.identities.length > 0 ? (
        <div className={styles['settingsCard']}>
          <div className={styles['cardHead']}>
            <div className={styles['cardTitleRow']}>
              <IconLayers size={14} />
              <h3 className={styles['cardTitle']}>Keys</h3>
              <span className={styles['modelCountBadge']}>{poolConfig.identities.length}</span>
            </div>

            <div className={styles['poolHeaderActions']}>
              <select
                className={styles['strategySelect']}
                value={poolConfig.strategy ?? 'priority-sticky'}
                onChange={(e) => { void handleStrategyChange(e.target.value) }}
                disabled={readOnly || busy}
                title="How the pool picks among healthy keys"
              >
                <option value="priority-sticky">Priority</option>
                <option value="balanced">Balanced</option>
              </select>
              <button
                type="button"
                className={styles['iconMiniBtn']}
                onClick={() => fetchPoolStatus()}
                disabled={isPoolLoading}
                title="Refresh pool status"
              >
                <IconRefresh size={13} />
              </button>
              <Button
                variant="outline"
                className={styles['testBtn']}
                onClick={() => setShowAddKeyModal(true)}
                disabled={readOnly || busy}
              >
                <IconPlus size={12} />
                Add Key
              </Button>
            </div>
          </div>

          <div className={styles['cardBody']}>
            <div className={styles['identitiesList']}>
              {poolConfig.identities.map((identity, idx) => {
                const status = poolStatusList.find(s => s.id === identity.id)
                const now = Date.now()
                const isCooling = Boolean(status?.cooldownUntil && status.cooldownUntil > now)
                const isError = Boolean(status?.lastStatus && (status.lastStatus === 401 || status.lastStatus === 403))
                const isDisabled = identity.enabled === false
                const cooldownSeconds = isCooling && status?.cooldownUntil ? Math.ceil((status.cooldownUntil - now) / 1000) : 0
                const testResult = identityTestResults[identity.id]

                return (
                  <div
                    key={identity.id}
                    className={`${styles['identityRow']} ${isDisabled ? styles['identityRowDisabled'] : ''} ${isCooling ? styles['identityRowCooling'] : ''} ${isError ? styles['identityRowError'] : ''}`}
                  >
                    <div className={styles['identityLeft']}>
                      <span className={styles['priorityBadge']} title={`Priority ${idx + 1}`}>
                        P{idx + 1}
                      </span>

                      <div className={styles['identityInfo']}>
                        <div className={styles['identityNameRow']}>
                          <span className={styles['identityName']}>{identity.id}</span>
                          <span className={styles['identityRef']}>{identity.credentialRef}</span>
                        </div>

                        <div className={styles['identityStatusRow']}>
                          {isDisabled ? (
                            <span className={`${styles['identityStatusPill']} ${styles['statusDisabled']}`}>
                              <span className={`${styles['statusDot']} ${styles['dotIdle']}`} />
                              Off
                            </span>
                          ) : isCooling ? (
                            <span className={`${styles['identityStatusPill']} ${styles['statusCooling']}`} title="Cooling down">
                              <span className={`${styles['statusDot']} ${styles['dotCooling']}`} />
                              {cooldownSeconds > 60 ? `${Math.ceil(cooldownSeconds / 60)}m` : `${cooldownSeconds}s`}
                            </span>
                          ) : isError ? (
                            <span className={`${styles['identityStatusPill']} ${styles['statusError']}`} title="Authentication failed">
                              <span className={`${styles['statusDot']} ${styles['dotError']}`} />
                              Auth
                            </span>
                          ) : (
                            <span className={`${styles['identityStatusPill']} ${styles['statusReady']}`}>
                              <span className={`${styles['statusDot']} ${styles['dotReady']}`} />
                              Ready
                            </span>
                          )}

                          {status?.quota?.remainingFraction !== undefined && status.quota.remainingFraction !== null && (
                            <div className={styles['quotaMiniWrap']} title={`Quota remaining: ${Math.round(status.quota.remainingFraction * 100)}%`}>
                              <div className={styles['quotaMiniBar']}>
                                <div
                                  className={styles['quotaMiniBarFill']}
                                  style={{ width: `${Math.round(status.quota.remainingFraction * 100)}%` }}
                                />
                              </div>
                              <span>{Math.round(status.quota.remainingFraction * 100)}%</span>
                            </div>
                          )}

                          {testResult && (
                            <span style={{ fontSize: '10px', color: testResult.state === 'success' ? '#34d399' : testResult.state === 'error' ? '#f87171' : 'inherit' }}>
                              {testResult.state === 'testing' ? 'Testing...' : testResult.message}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className={styles['identityActions']}>
                      {/* Move Up */}
                      <button
                        type="button"
                        className={styles['iconMiniBtn']}
                        onClick={() => handleMoveIdentity(idx, -1)}
                        disabled={idx === 0 || readOnly || busy}
                        title="Move Up (Higher Priority)"
                      >
                        <IconArrowUp size={12} />
                      </button>

                      {/* Move Down */}
                      <button
                        type="button"
                        className={styles['iconMiniBtn']}
                        onClick={() => handleMoveIdentity(idx, 1)}
                        disabled={idx === (poolConfig?.identities?.length ?? 1) - 1 || readOnly || busy}
                        title="Move Down (Lower Priority)"
                      >
                        <IconArrowDown size={12} />
                      </button>

                      {/* Reset Cooldown */}
                      {isCooling && (
                        <button
                          type="button"
                          className={styles['iconMiniBtn']}
                          onClick={() => handleResetCooldown(identity.id)}
                          title="Reset Cooldown"
                        >
                          <IconRefresh size={12} />
                        </button>
                      )}

                      {/* Test Individual Key */}
                      <button
                        type="button"
                        className={styles['iconMiniBtn']}
                        onClick={() => handleTestIdentity(identity.id, identity.credentialRef)}
                        disabled={testResult?.state === 'testing' || readOnly}
                        title="Test this API key"
                      >
                        <IconBolt size={12} />
                      </button>

                      {/* Enable/Disable Toggle */}
                      <button
                        type="button"
                        className={styles['iconMiniBtn']}
                        onClick={() => handleToggleIdentityEnabled(identity.id)}
                        disabled={readOnly || busy}
                        title={isDisabled ? 'Enable key' : 'Disable key'}
                      >
                        {isDisabled ? <IconEyeOff size={12} /> : <IconEye size={12} />}
                      </button>

                      {/* Delete */}
                      <button
                        type="button"
                        className={`${styles['iconMiniBtn']} ${styles['deleteIdentityBtn']}`}
                        onClick={() => handleDeleteIdentity(identity.id)}
                        disabled={readOnly || busy}
                        title="Delete key"
                      >
                        <IconTrash size={12} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ) : (
        /* Single Key Authentication Card */
        <div className={styles['settingsCard']}>
          <div className={styles['cardHead']}>
            <div className={styles['cardTitleRow']}>
              <IconKey size={14} />
              <h3 className={styles['cardTitle']}>API Key</h3>
            </div>
            <div className={styles['poolHeaderActions']}>
              <span
                className={`${styles['statusPill']} ${
                  isConfigured ? styles['statusPillSuccess'] : styles['statusPillWarning']
                }`}
              >
                <span className={`${styles['statusDot']} ${isConfigured ? styles['dotReady'] : styles['dotCooling']}`} />
                {isConfigured ? 'Connected' : 'No Key'}
              </span>
              <Button
                variant="outline"
                className={styles['testBtn']}
                onClick={handleConvertToPool}
                disabled={readOnly || busy}
                title="Multiple keys with automatic failover"
              >
                <IconLayers size={12} />
                Pool
              </Button>
            </div>
          </div>

          <div className={styles['cardBody']}>
            <div className={styles['keyInputRow']}>
              <div className={styles['passwordInputWrap']}>
                <input
                  className={styles['input']}
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  placeholder={isConfigured ? '•••••••••••••••• (Configured)' : 'Enter API key'}
                  value={keyInput}
                  onChange={e => setKeyInput(e.target.value)}
                  disabled={readOnly || busy}
                />
                <button
                  type="button"
                  className={styles['eyeBtn']}
                  onClick={() => setShowKey(!showKey)}
                  title={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                </button>
              </div>

              <Button
                variant="primary"
                disabled={readOnly || busy || keyInput.trim().length === 0}
                onClick={handleSave}
              >
                <IconCheck size={12} />
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Key Modal */}
      {showAddKeyModal && (
        <div className={styles['addKeyModalOverlay']} onClick={() => setShowAddKeyModal(false)}>
          <div className={styles['addKeyModal']} onClick={e => e.stopPropagation()}>
            <div className={styles['addKeyModalTitle']}>
              <IconPlus size={14} />
              Add Key
            </div>

            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>Name</label>
              <input
                className={styles['input']}
                type="text"
                placeholder="e.g. backup_key, personal_account"
                value={newKeyId}
                onChange={e => setNewKeyId(e.target.value)}
                autoFocus
              />
            </div>

            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>Credential Ref</label>
              <input
                className={styles['input']}
                type="text"
                placeholder={`e.g. ${providerId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}_KEY_2`}
                value={newKeyRef}
                onChange={e => setNewKeyRef(e.target.value)}
              />
            </div>

            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>Secret</label>
              <div className={styles['passwordInputWrap']}>
                <input
                  className={styles['input']}
                  type={newKeyShow ? 'text' : 'password'}
                  placeholder="Paste API Key secret"
                  value={newKeyValue}
                  onChange={e => setNewKeyValue(e.target.value)}
                />
                <button
                  type="button"
                  className={styles['eyeBtn']}
                  onClick={() => setNewKeyShow(!newKeyShow)}
                >
                  {newKeyShow ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                </button>
              </div>
            </div>

            <div className={styles['addKeyModalActions']}>
              <Button
                variant="outline"
                onClick={() => setShowAddKeyModal(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleAddIdentitySubmit}
                disabled={busy || !newKeyId.trim() || !newKeyValue.trim()}
              >
                {busy ? '…' : 'Add'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Connection Details Card */}
      <div className={styles['settingsCard']}>
        <div className={styles['cardHead']}>
          <div className={styles['cardTitleRow']}>
            <IconBolt size={14} />
            <h3 className={styles['cardTitle']}>Endpoint</h3>
          </div>

          <Button
            variant="outline"
            className={styles['testBtn']}
            disabled={busy || testStatus.state === 'testing'}
            onClick={handleTestConnection}
          >
            {testStatus.state === 'testing' ? '…' : 'Test'}
          </Button>
        </div>

        <div className={styles['cardBody']}>
          <div className={styles['fieldGrid']}>
            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>Base URL</label>
              <input
                className={styles['input']}
                type="text"
                value={baseURL}
                placeholder="e.g. https://api.openai.com/v1"
                onChange={e => setBaseURL(e.target.value)}
                disabled={readOnly || busy}
              />
            </div>

            <div className={styles['field']}>
              <label className={styles['fieldLabel']}>Protocol</label>
              <select
                className={`${styles['input']} ${styles['selectInput']}`}
                value={protocol}
                onChange={e => setProtocol(e.target.value)}
                disabled={readOnly || busy}
              >
                {protocols.map(p => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Test Status Banner */}
          {testStatus.state !== 'idle' && (
            <div
              className={`${styles['testResultBanner']} ${
                testStatus.state === 'success'
                  ? styles['testResultSuccess']
                  : testStatus.state === 'error'
                    ? styles['testResultError']
                    : styles['testResultPending']
              }`}
            >
              {testStatus.state === 'testing' && 'Testing…'}
              {testStatus.state === 'success' && (
                <span>
                  <span className={`${styles['statusDot']} ${styles['dotReady']}`} /> <strong>{testStatus.latencyMs}ms</strong> — {testStatus.message}
                </span>
              )}
              {testStatus.state === 'error' && (
                <span>
                  <span className={`${styles['statusDot']} ${styles['dotError']}`} /> <strong>Failed</strong> — {testStatus.message}
                </span>
              )}
            </div>
          )}

          <div className={styles['saveRow']}>
            {saveSuccess && <span className={styles['savedToast']}>Saved</span>}
            <Button
              variant="outline"
              disabled={readOnly || busy}
              onClick={handleSave}
            >
              Save
            </Button>
          </div>
        </div>
      </div>

      {/* Available Models Section */}
      <div className={styles['settingsCard']}>
        <div className={styles['modelsHead']}>
          <div className={styles['modelsTitleRow']}>
            <h3 className={styles['cardTitle']}>Models</h3>
            <span className={styles['modelCountBadge']}>{modelsList.length}</span>
          </div>

          <div className={styles['modelsHeadActions']}>
            <button
              type="button"
              className={styles['iconMiniBtn']}
              onClick={handleRefreshModels}
              disabled={refreshState.isRefreshing || readOnly}
              title="Refresh catalog from provider"
            >
              <IconRefresh size={13} />
            </button>
            <span className={styles['dotSep']}>•</span>
            <button type="button" className={styles['textActionBtn']} onClick={handleShowAll}>
              Show All
            </button>
            <span className={styles['dotSep']}>•</span>
            <button type="button" className={styles['textActionBtn']} onClick={handleHideAll}>
              Hide All
            </button>
          </div>
        </div>

        {refreshState.message && (
          <div
            style={{
              padding: '6px 10px',
              fontSize: '11px',
              borderRadius: '6px',
              marginBottom: '8px',
              background: refreshState.isError ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
              color: refreshState.isError ? '#f87171' : '#34d399',
              border: refreshState.isError ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
            }}
          >
            {refreshState.message}
          </div>
        )}

        {/* Model Search */}
        <div className={styles['modelSearchWrap']}>
          <IconSearch size={12} />
          <input
            className={styles['searchInput']}
            type="text"
            placeholder={`Search ${modelsList.length} models...`}
            value={modelSearch}
            onChange={e => setModelSearch(e.target.value)}
          />
          {modelSearch && (
            <button
              type="button"
              className={styles['clearSearchBtn']}
              onClick={() => setModelSearch('')}
            >
              ×
            </button>
          )}
        </div>

        {/* Models List / Grid */}
        <div className={styles['modelsGrid']}>
          {filteredModels.length === 0 ? (
            <div className={styles['emptyModels']}>
              {modelSearch ? `No models matching "${modelSearch}"` : 'No models found.'}
            </div>
          ) : (
            filteredModels.map((m) => {
              const hidden = hiddenSet.has(m.id)
              const caps = detectCapabilities(m)
              const contextStr = formatTokens(m.contextWindow)
              const maxTokStr = formatTokens(m.maxTokens)

              return (
                <div
                  key={m.id}
                  className={`${styles['modelCard']} ${hidden ? styles['modelCardHidden'] : ''}`}
                >
                  <div className={styles['modelCardMain']}>
                    <div className={styles['modelTitleRow']}>
                      <span className={styles['modelName']}>{m.name || m.id}</span>
                      <span className={styles['modelIdTag']}>{m.id}</span>
                    </div>

                    <div className={styles['modelMetaRow']}>
                      {/* Capacities */}
                      {(contextStr || maxTokStr) && (
                        <span className={styles['capacityBadge']} title="Context Window (in) / Max Output Tokens (out)">
                          {contextStr ? `${contextStr} in` : ''}{contextStr && maxTokStr ? ' • ' : ''}{maxTokStr ? `${maxTokStr} out` : ''}
                        </span>
                      )}

                      {/* Capabilities Icons */}
                      <div className={styles['capIconsList']}>
                        {caps.hasTools && (
                          <span className={styles['capIcon']} title="Tool Calling">
                            <IconTools size={10} />
                          </span>
                        )}
                        {caps.hasReasoning && (
                          <span className={`${styles['capIcon']} ${styles['capIconReasoning']}`} title="Reasoning / Thinking">
                            <IconBrain size={10} />
                          </span>
                        )}
                        {caps.hasVision && (
                          <span className={styles['capIcon']} title="Vision / Image">
                            <IconVision size={10} />
                          </span>
                        )}
                        {caps.hasAudio && (
                          <span className={styles['capIcon']} title="Audio Processing">
                            <IconAudio size={10} />
                          </span>
                        )}
                        {caps.hasVideo && (
                          <span className={styles['capIcon']} title="Video Processing">
                            <IconVideo size={10} />
                          </span>
                        )}
                        {caps.hasFiles && (
                          <span className={styles['capIcon']} title="Documents & Files">
                            <IconFile size={10} />
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Eye Toggle */}
                  <button
                    type="button"
                    className={`${styles['modelEyeBtn']} ${hidden ? styles['modelEyeBtnHidden'] : ''}`}
                    onClick={() => handleToggleHide(m.id)}
                    title={hidden ? 'Hidden in picker (click to show)' : 'Visible in picker (click to hide)'}
                    aria-label={hidden ? `Show ${m.id}` : `Hide ${m.id}`}
                  >
                    {hidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
