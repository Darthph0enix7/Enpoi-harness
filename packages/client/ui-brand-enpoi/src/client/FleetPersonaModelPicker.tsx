import { useState, useEffect, useRef, useMemo } from 'react'
import styles from './FleetPersonaModelPicker.module.css'

export interface ModelOption {
  provider: string
  model: string
  displayName: string
  contextWindow?: number
}

/** Wire shape of one provider group in the llm.models response value. */
interface ModelGroup {
  id?: string
  name?: string
  models?: Array<{ id: string; name?: string; contextWindow?: number }>
}

interface FleetPersonaModelPickerProps {
  persona: string
  currentModel: string
  onSelectModel: (provider: string, model: string) => void
}

const DEFAULT_POPULAR_MODELS: ModelOption[] = [
  { provider: 'deepseek', model: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', contextWindow: 1000000 },
  { provider: 'antigravity', model: 'gemini-3.7-flash-tiered', displayName: 'Gemini 3.7 Flash', contextWindow: 1048576 },
  { provider: 'antigravity', model: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', contextWindow: 1048576 },
  { provider: 'antigravity', model: 'claude-opus-4.6-thinking', displayName: 'Claude Opus 4.6', contextWindow: 1000000 },
  { provider: 'minimax', model: 'MiniMax-M3', displayName: 'MiniMax M3', contextWindow: 1000000 },
  { provider: 'openrouter', model: 'deepseek/deepseek-chat', displayName: 'OpenRouter DeepSeek Chat', contextWindow: 65536 },
]

export function FleetPersonaModelPicker({
  persona: _persona,
  currentModel,
  onSelectModel,
}: FleetPersonaModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [models, setModels] = useState<ModelOption[]>(DEFAULT_POPULAR_MODELS)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Fetch available models from host API (llm.models → { groups: [{ id, name, models }] })
  useEffect(() => {
    async function loadModels() {
      try {
        const res = await fetch('/api/llm.models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', method: 'llm.models', rpcId: 'fleet-models', payload: {} }),
        })
        if (res.ok) {
          const json: unknown = await res.json()
          const groups = (json as { result?: { value?: { groups?: ModelGroup[] } } })?.result?.value?.groups ?? []
          if (Array.isArray(groups) && groups.length > 0) {
            const mapped: ModelOption[] = []
            for (const group of groups) {
              const providerId = group.id ?? group.name ?? 'default'
              for (const m of group.models ?? []) {
                mapped.push({
                  provider: providerId,
                  model: String(m.id),
                  displayName: String(m.name ?? m.id),
                  ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
                })
              }
            }
            if (mapped.length > 0) setModels(mapped)
          }
        }
      } catch {
        // Fallback to default popular models
      }
    }
    void loadModels()
  }, [])

  // Close popover on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open])

  const filtered = models.filter(
    m =>
      m.displayName.toLowerCase().includes(search.toLowerCase()) ||
      m.model.toLowerCase().includes(search.toLowerCase()) ||
      m.provider.toLowerCase().includes(search.toLowerCase()),
  )

  const currentDisplayName =
    models.find(m => m.model === currentModel || `${m.provider}/${m.model}` === currentModel)?.displayName ??
    currentModel.split('/').pop() ??
    currentModel

  function formatContext(tokens?: number): string {
    if (!tokens) return ''
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
    return `${tokens}`
  }

  // Group filtered models by provider for grouped rendering (provider headers).
  const grouped = useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const m of filtered) {
      const list = map.get(m.provider)
      if (list) list.push(m)
      else map.set(m.provider, [m])
    }
    return Array.from(map.entries())
  }, [filtered])

  const currentProvider = models.find(m => m.model === currentModel || `${m.provider}/${m.model}` === currentModel)?.provider

  return (
    <div className={styles.modelPickerWrapper} ref={wrapperRef}>
      <button
        type="button"
        className={styles.modelPickerTrigger}
        onClick={() => setOpen(!open)}
        title={`Select model for ${_persona}`}
      >
        <span className={styles.modelName}>{currentDisplayName}</span>
        <span className={styles.chevron}>▾</span>
      </button>

      {open && (
        <div className={styles.popover}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search models or providers..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />

          <div className={styles.modelList}>
            {grouped.map(([provider, providerModels]) => (
              <div key={provider}>
                <div className={styles.groupHeader}>{provider}</div>
                {providerModels.slice(0, 40).map((m) => {
                  const isActive = m.model === currentModel
                    || `${m.provider}/${m.model}` === currentModel
                    || (m.provider === currentProvider && m.model === currentModel.split('/').pop())
                  return (
                    <div
                      key={`${m.provider}/${m.model}`}
                      className={`${styles.modelItem} ${isActive ? styles.modelItemActive : ''}`}
                      onClick={() => {
                        onSelectModel(m.provider, m.model)
                        setOpen(false)
                      }}
                    >
                      <span>{m.displayName}</span>
                      {m.contextWindow ? <span className={styles.contextTag}>{formatContext(m.contextWindow)}</span> : null}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
