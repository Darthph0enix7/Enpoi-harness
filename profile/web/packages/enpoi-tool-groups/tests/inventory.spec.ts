/**
 * Wire-inventory fixture status + catalog-derived default-surface coverage.
 *
 * The canonical `scripts/tool-inventory/expected-*.json` files are BLOCKED,
 * stale captures until the central build records fresh profile-bundle
 * fingerprints and the keyless capture in
 * `apps/web/tests/keyless-tool-inventory.e2e.ts` is explicitly dispatched in
 * an isolated subprocess. This spec therefore does NOT treat the committed
 * names as truth: it requires every fixture to declare `stale: true` with a
 * reason, and it only checks the shape plus the catalog-derived expectations
 * that do not depend on a live/home write.
 *
 * Nothing here reads `~/.dsh`, opens a database, or calls a model. When main
 * completes the central build and re-captures, this stale guard must be
 * replaced by the capture-provenance assertion in the same change.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildArtifactReceipt } from '../../../../../scripts/tool-inventory/artifact-receipt.mjs'
import { readClientBuildRecord } from '../../../../../scripts/client-build-environment.ts'
import { denyNames, preAttachFor, resolveToolGroups, SHIPPED_TOOL_GROUPS } from '../src/catalog.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const FIXTURE_DIR = new URL('../../../../../scripts/tool-inventory/', import.meta.url)
const DEV_BLOCKED = process.env.DSH_INVENTORY_DEV_BLOCKED === '1'
/** A profile-only checkout has no scripts tree; the canonical guard then skips. */
const CANONICAL_PRESENT = existsSync(new URL('expected-orchestrator.json', FIXTURE_DIR))
const PRESETS = ['orchestrator', 'sysadmin', 'creator'] as const
const SEATS = [...PRESETS, 'broker', 'default'] as const

interface InventoryFixture {
  preset?: unknown
  stale?: unknown
  staleReason?: unknown
  captureMethod?: unknown
  captureSource?: unknown
  captureReceipt?: unknown
  captureClientBuild?: unknown
  tools?: unknown
}

function readFixture(preset: string): InventoryFixture {
  return JSON.parse(readFileSync(new URL(`expected-${preset}.json`, FIXTURE_DIR), 'utf8')) as InventoryFixture
}

describe('tool-inventory fixtures', () => {
  it('requires fresh artifact/source receipts; stale fixtures fail the release gate', async () => {
    if (!CANONICAL_PRESENT) return
    for (const preset of PRESETS) {
      const fixture = readFixture(preset)
      expect(fixture.preset, `${preset} fixture names another preset`).toBe(preset)
      if (fixture.stale === true) {
        if (!DEV_BLOCKED) {
          expect.fail(
            `${preset}: fixture is stale and is not release proof. Complete the central build and re-capture with `
            + 'DSH_KEYLESS_INVENTORY_CAPTURE=1 DSH_TOOL_INVENTORY_WRITE=1; set DSH_INVENTORY_DEV_BLOCKED=1 only for the '
            + 'blocked-shape development guard.',
          )
        }
        // Explicit development-only blocked shape. This is never a release pass.
        expect(typeof fixture.staleReason, `${preset} fixture has no stale reason`).toBe('string')
        expect((fixture.staleReason as string).length, `${preset} stale reason is empty`).toBeGreaterThan(20)
        expect(fixture.captureMethod, `${preset} fixture claims a completed keyless capture`).toBeUndefined()
        continue
      }
      expect(fixture.captureMethod, `${preset}: fixture has no keyless capture provenance`).toBe('keyless-profile-composition')
      expect(fixture.captureSource, `${preset}: fixture has no capture source`).toBe('apps/web/tests/keyless-tool-inventory.e2e.ts')
      const recorded = fixture.captureReceipt as Awaited<ReturnType<typeof buildArtifactReceipt>> | undefined
      expect(recorded?.combinedDigest, `${preset}: artifact receipt digest`).toMatch(/^[0-9a-f]{64}$/u)
      expect(Object.keys(recorded?.profileFingerprints ?? {}).length, `${preset}: no source fingerprints`).toBeGreaterThan(0)
      // Recompute the exact same pure-file receipt the runner recorded. This
      // binds the fixture to compiled artifacts and source-input fingerprints,
      // not to a hand-picked tool count.
      const current = await buildArtifactReceipt(REPO_ROOT)
      expect(recorded?.combinedDigest, `${preset}: artifact/source receipt drifted`).toBe(current.combinedDigest)
      const client = readClientBuildRecord(REPO_ROOT)
      const recordedClient = fixture.captureClientBuild as { artifacts: unknown; environment: unknown } | undefined
      expect(recordedClient?.artifacts, `${preset}: client artifact receipt`).toEqual(client.artifacts)
      expect(recordedClient?.environment, `${preset}: client build environment receipt`).toEqual(client.environment)
      const names = fixture.tools as string[] | undefined
      expect(Array.isArray(names) && names.length > 0, `${preset} fixture has no tools`).toBe(true)
      expect(new Set(names).size, `${preset} fixture has duplicate names`).toBe(names!.length)
    }
  })

  it('pins the shipped pre-attach intent: creator trio on the creator seat alone, debug detached', () => {
    const catalog = resolveToolGroups(undefined)
    expect(preAttachFor(catalog, 'creator')).toEqual(['creator'])
    for (const seat of ['orchestrator', 'sysadmin', 'broker', 'skeptic', 'default']) {
      expect(preAttachFor(catalog, seat), `${seat} must not pre-attach a family`).toEqual([])
    }
    expect(catalog.byId.get('debug')?.preAttach).toEqual([])
    expect(catalog.byId.get('peer')?.preAttach).toEqual([])
  })

  it('pins the default presented surface keylessly: detached on-demand denied, ungrouped kept', () => {
    const catalog = resolveToolGroups(undefined)
    const staticMembers = SHIPPED_TOOL_GROUPS
      .filter(group => group.mode === 'static' && group.enabled)
      .flatMap(group => [...group.members])
    // Names the audit observed on the live default wire but that no group owns:
    // the deny-only filter must never hide them (fail open).
    const ungrouped = [
      'web_fetch', 'run_code', 'compressor_retrieve',
      'custom_research-fetch', 'custom_research-verify',
      'send_message', 'interrupt_agent', 'list_agents', 'mcp', 'tool_groups',
    ]

    for (const seat of SEATS) {
      const attached = new Set(preAttachFor(catalog, seat))
      const denied = new Set(denyNames(catalog, attached))
      for (const group of SHIPPED_TOOL_GROUPS.filter(candidate => candidate.mode === 'on-demand' && candidate.enabled)) {
        for (const name of group.members) {
          if (attached.has(group.id)) {
            expect(denied, `${name} is attached for ${seat} and must stay presented`).not.toContain(name)
          } else {
            expect(denied, `${name} must be denied at the default attach state for ${seat}`).toContain(name)
          }
        }
      }
      // The P1 regression: the peer discovery listing is on-demand now, so a
      // fresh non-creator session does not present it and a detach can hide it.
      if (!attached.has('peer')) expect(denied).toContain('peer_sessions')
      for (const name of staticMembers) {
        expect(denied, `${name} is static and must stay presented for ${seat}`).not.toContain(name)
      }
      for (const name of ungrouped) {
        expect(denied, `${name} is ungrouped and must stay presented for ${seat}`).not.toContain(name)
      }
    }
  })
})
