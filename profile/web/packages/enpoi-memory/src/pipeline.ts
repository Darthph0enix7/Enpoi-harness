/**
 * enpoi-memory — CBDC pipeline: Claim intake → Trust gate → Conflict resolution → state machine.
 *
 * I10: monotonic state machine (tentative → committed → rescinded; tentative →
 * oraclephoned_cancelled absorbing). I11: parent-state gated intake (CAS inside
 * the mutex, per Oracle Q1). All writes use BEGIN IMMEDIATE transactions.
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { CATEGORIES, KEEPER_ALLOWED, type Category, type ClaimRow, type Origin, type State, type Trust } from './db'

export interface ClaimInput {
  fact: string
  category: string
  tags?: string
}

export interface IntakeOptions {
  /** Claim producer: 'keeper' | 'worker:<role>' | 'orchestrator' | 'legacy'. */
  origin: Origin
  trust: Trust
  /** Parent turn aborted → force orphaned_cancelled (I11). Must reflect the TRUE parent state. */
  parentAborted?: boolean
  /** Extra provenance JSON. */
  provenance?: string
}

const FACT_CAP = 400

export function claimHash(fact: string, category: string): string {
  return createHash('sha256').update(`${fact}::${category}`).digest('hex').slice(0, 12)
}

/** Async mutex: serializes all writes on this DB handle (Oracle Q1 — per-process). */
class Mutex {
  private chain: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

export function makePipeline(db: DatabaseSync) {
  const mutex = new Mutex()

  function txn(fn: () => void): void {
    db.exec('BEGIN IMMEDIATE')
    try {
      fn()
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw err
    }
  }

  function get(id: string): ClaimRow | undefined {
    return db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as ClaimRow | undefined
  }

  function stateOf(id: string): State | undefined {
    return get(id)?.state
  }

  /** Stage 1+2+3: intake claims from any source with the trust gate + living-owner rule. */
  async function intake(claims: ClaimInput[], opts: IntakeOptions): Promise<ClaimRow[]> {
    return mutex.run(() => {
      const inserted: ClaimRow[] = []
      txn(() => {
        for (const c of claims) {
          const fact = String(c.fact ?? '').trim()
          if (fact.length === 0 || fact.length > FACT_CAP) continue
          let category = String(c.category ?? 'PROJECT').toUpperCase()
          if (!(CATEGORIES as readonly string[]).includes(category)) category = 'PROJECT'

          // A3.4 category boundaries: keeper never writes RULES/CONSTRAINTS/NAMING.
          if (opts.origin === 'keeper' && !KEEPER_ALLOWED.has(category)) category = 'PROJECT'

          const hash = claimHash(fact, category)
          const existing = db.prepare('SELECT * FROM claims WHERE id = ?').get(`claim-${hash}`) as ClaimRow | undefined

          if (existing !== undefined) {
            if (existing.state === 'rescinded') {
              // A re-observed rescinded fact stays rescinded (tombstone is absorbing).
              continue
            }
            if (opts.trust === 'operator' && existing.state !== 'committed') {
              // Oracle fix 2: operator authority promotes tentative/orphaned claims.
              db.prepare(`UPDATE claims SET state = 'committed', source_trust = 'operator', origin = ?, committed_at = ? WHERE id = ?`)
                .run(opts.origin, Date.now(), existing.id)
              inserted.push(get(existing.id)!)
              continue
            }
            if (existing.state === 'orphaned_cancelled' && opts.trust === 'verified_execution' && opts.parentAborted !== true) {
              // Oracle fix 2: re-observed by a successful run → revive (orphaned is
              // NOT a tombstone; only rescinded is).
              db.prepare(`UPDATE claims SET state = 'committed', source_trust = ?, origin = ?, committed_at = ? WHERE id = ?`)
                .run(opts.trust, opts.origin, Date.now(), existing.id)
              inserted.push(get(existing.id)!)
              continue
            }
            continue
          }

          // A3.4 origin precedence: an operator fact owns its fact text in ANY
          // category — keeper/worker claims can never overwrite or duplicate it.
          const owner = db.prepare(
            `SELECT id FROM claims WHERE fact = ? AND state = 'committed' AND source_trust = 'operator' LIMIT 1`,
          ).get(fact) as { id: string } | undefined
          if (owner !== undefined && opts.trust !== 'operator') {
            continue
          }

          const state: State = opts.parentAborted
            ? 'orphaned_cancelled'
            : opts.trust === 'untrusted_external'
              ? 'tentative'
              : 'committed'
          const now = Date.now()
          db.prepare(
            `INSERT INTO claims (id, fact, category, tags, state, source_trust, origin, provenance, created_at, committed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            `claim-${hash}`, fact, category, c.tags ?? '', state,
            opts.trust === 'verified_execution' || opts.trust === 'operator' ? opts.trust : 'untrusted_external',
            opts.origin, opts.provenance ?? '', now,
            state === 'committed' ? now : null,
          )
          inserted.push(get(`claim-${hash}`)!)
        }
      })
      return inserted
    })
  }

  /** tentative → committed (unless already terminal). */
  async function graduate(id: string): Promise<ClaimRow | null> {
    return mutex.run(() => {
      let out: ClaimRow | null = null
      txn(() => {
        const row = get(id)
        if (row === undefined || row.state !== 'tentative') return
        db.prepare(`UPDATE claims SET state = 'committed', committed_at = ? WHERE id = ?`).run(Date.now(), id)
        out = get(id) ?? null
      })
      return out
    })
  }

  /** Explicit operator confirmation of a tentative/untrusted claim. */
  async function confirm(id: string): Promise<ClaimRow | null> {
    const row = get(id)
    if (row === undefined) return null
    return graduate(id)
  }

  /** Any → rescinded (tombstone, absorbing). Future injections blocked. */
  async function rescind(id: string, reason?: string): Promise<boolean> {
    return mutex.run(() => {
      let changed = false
      txn(() => {
        const row = get(id)
        if (row === undefined) return
        db.prepare(`UPDATE claims SET state = 'rescinded', tombstone_reason = ? WHERE id = ?`)
          .run(reason ?? '', id)
        changed = true
      })
      return changed
    })
  }

  /** Boot reconciliation (A4.1/doc 35): leftover tentative → orphaned_cancelled. */
  async function reconcileBoot(): Promise<number> {
    return mutex.run(() => {
      let n = 0
      txn(() => {
        const res = db.prepare(`UPDATE claims SET state = 'orphaned_cancelled' WHERE state = 'tentative'`).run()
        n = Number(res?.changes ?? 0)
      })
      return n
    })
  }

  function list(filter?: { category?: string; state?: State }): ClaimRow[] {
    if (filter?.category !== undefined && filter?.state !== undefined) {
      return db.prepare(`SELECT * FROM claims WHERE category = ? AND state = ? ORDER BY created_at DESC`).all(filter.category, filter.state) as ClaimRow[]
    }
    if (filter?.category !== undefined) {
      return db.prepare(`SELECT * FROM claims WHERE category = ? ORDER BY created_at DESC`).all(filter.category) as ClaimRow[]
    }
    if (filter?.state !== undefined) {
      return db.prepare(`SELECT * FROM claims WHERE state = ? ORDER BY created_at DESC`).all(filter.state) as ClaimRow[]
    }
    return db.prepare(`SELECT * FROM claims ORDER BY created_at DESC LIMIT 200`).all() as ClaimRow[]
  }

  return { intake, graduate, confirm, rescind, reconcileBoot, list, get, stateOf }
}

export type Pipeline = ReturnType<typeof makePipeline>
