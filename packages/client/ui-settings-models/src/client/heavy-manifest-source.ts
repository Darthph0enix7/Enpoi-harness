/**
 * The live heavy-provider manifest table: the host is the single source.
 *
 * The running profile plugin executes the manifests it owns, so rendering a
 * page copy is how commandcode's stale "unsupported" row survived the host
 * flip. This module starts on {@link FALLBACK_HEAVY_PROVIDER_MANIFESTS} — the
 * small, labelled pre-connection copy — and replaces it wholesale with the
 * host's `enpoiHeavy.manifests` reply, so the client cannot drift once
 * connected. A failed or empty reply keeps the previous table; a host reply
 * is never merged field-by-field.
 *
 * @module ui-settings-models/heavy-manifest-source
 */

import { useSyncExternalStore } from 'react'
import { FALLBACK_HEAVY_PROVIDER_MANIFESTS, type HeavyProviderManifest } from './heavy-providers.ts'
import { heavyApi } from './heavy-rpc.ts'

/** The table the client currently renders from. */
export interface HeavyManifestState {
  /** The host's manifests once connected, the labelled fallback before. */
  manifests: readonly HeavyProviderManifest[]
  /** False until a host reply was accepted. */
  live: boolean
  /** The host platform installs execute on, when reported. */
  platform?: string
  /** Structural problems the host reported for its own table. */
  problems: readonly string[]
}

const listeners = new Set<() => void>()
let state: HeavyManifestState = { manifests: FALLBACK_HEAVY_PROVIDER_MANIFESTS, live: false, problems: [] }
let loading: Promise<HeavyManifestState> | undefined

function publish(next: HeavyManifestState): void {
  state = next
  for (const listener of listeners) listener()
}

/** The current table (host truth when connected, the fallback before). */
export function heavyManifestState(): HeavyManifestState {
  return state
}

/** Resolve one route id against the current table. */
export function resolveHeavyManifest(id: string): HeavyProviderManifest | undefined {
  return state.manifests.find(manifest => manifest.id === id)
}

/**
 * Accept one host reply. An empty `items` list keeps the previous table (a
 * host that reports nothing must not blank the listing) and still marks the
 * source connected, so the page stops waiting.
 * @param reply - the `enpoiHeavy.manifests` value.
 */
export function bindHostHeavyManifests(reply: {
  items: readonly HeavyProviderManifest[]
  platform?: string
  problems?: readonly string[]
}): void {
  publish({
    manifests: reply.items.length > 0 ? reply.items : state.manifests,
    live: true,
    ...reply.platform === undefined ? {} : { platform: reply.platform },
    problems: reply.problems ?? [],
  })
}

/**
 * Fetch the host table once. Concurrent callers share one request; a failed
 * request stores nothing so a later mount retries.
 * @returns the table state after the reply (or the unchanged fallback).
 */
export function loadHostHeavyManifests(): Promise<HeavyManifestState> {
  if (loading !== undefined) return loading
  loading = heavyApi.manifests().then((result) => {
    if (result.ok) bindHostHeavyManifests(result.value)
    else loading = undefined
    return state
  })
  return loading
}

/** Restore the pre-connection fallback (tests and an explicit disconnect). */
export function resetHeavyManifestSource(): void {
  loading = undefined
  publish({ manifests: FALLBACK_HEAVY_PROVIDER_MANIFESTS, live: false, problems: [] })
}

/**
 * Subscribe to table replacements.
 * @param listener - called after every accepted host reply or reset.
 * @returns the unsubscribe function.
 */
export function subscribeHeavyManifests(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The live table, bound for render code by the UI renderer. */
export function useHeavyManifestState(): HeavyManifestState {
  return useSyncExternalStore(subscribeHeavyManifests, heavyManifestState, heavyManifestState)
}
