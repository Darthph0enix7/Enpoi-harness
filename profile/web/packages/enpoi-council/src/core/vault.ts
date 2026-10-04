/**
 * Evidence Vault — shared, deduplicated fact store (doc 54 §6).
 *
 * Fact Sheets land here from the broker; every seat cites the same facts.
 * Entries are immutable (append-only); challenges trigger re-retrieval which
 * appends a superseding sheet. `invariant` rulings must reference a vault id.
 */
import { createHash } from 'node:crypto'

export interface VaultEntry {
  id: string                    // 'F-1', 'F-2' …
  citation: string              // 'file:line' or URL — travels with the claim
  question: string              // the broker query that produced it
  factSheet: string             // ≤ ~200 tokens distilled answer
  addedEpoch: number
  retrievedBy: 'explorer' | 'librarian'
  supersededBy: string | null   // set when challenged and re-retrieved
}

export class EvidenceVault {
  private readonly entries = new Map<string, VaultEntry>()
  private seq = 0

  add(sheet: Omit<VaultEntry, 'id' | 'supersededBy'>): VaultEntry {
    this.seq += 1
    const entry: VaultEntry = { ...sheet, id: `F-${this.seq}`, supersededBy: null }
    this.entries.set(entry.id, entry)
    return { ...entry }
  }

  get(id: string): VaultEntry | undefined {
    const e = this.entries.get(id)
    return e ? { ...e } : undefined
  }

  /** Has a live (non-superseded) sheet for this citation? */
  hasLiveFor(citation: string): boolean {
    for (const e of this.entries.values()) {
      if (e.citation === citation && e.supersededBy === null) return true
    }
    return false
  }

  /** Sheets added at or after the given epoch (standby catch-up, epoch delivery). */
  since(epoch: number): VaultEntry[] {
    return [...this.entries.values()].filter(e => e.addedEpoch >= epoch && e.supersededBy === null).map(e => ({ ...e }))
  }

  all(): VaultEntry[] {
    return [...this.entries.values()].map(e => ({ ...e }))
  }

  /** Content hash for dedupe (same question + citation → reuse). */
  static fingerprint(question: string, target: string): string {
    return createHash('sha256').update(`${target}::${question}`.toLowerCase()).digest('hex').slice(0, 16)
  }

  /** Render the vault (or a delta) as compact prompt text. */
  render(entries?: VaultEntry[]): string {
    const list = entries ?? this.all()
    if (list.length === 0) return '(no evidence collected yet)'
    return list
      .map(e => `[${e.id}] (${e.retrievedBy}, ${e.citation}) Q: ${e.question}\n${e.factSheet}`)
      .join('\n\n')
  }
}
