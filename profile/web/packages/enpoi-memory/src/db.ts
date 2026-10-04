/**
 * enpoi-memory — durable cross-session memory (CBDC) database layer.
 * SQLite via node:sqlite (built-in). WAL + busy_timeout for crash-safety and
 * cross-process serialization (plugin, keeper, dispatcher, CLI each open their
 * own connection to the same file; SQLite's locking handles multi-writer).
 *
 * A3.1: FTS5 sync via ENGINE TRIGGERS (claims_ai/au/ad) — never TS-managed.
 */
import { DatabaseSync } from 'node:sqlite'
import * as os from 'node:os'
import * as path from 'node:path'

export type State = 'tentative' | 'committed' | 'orphaned_cancelled' | 'rescinded'
export type Trust = 'operator' | 'verified_execution' | 'untrusted_external'
export type Origin = 'keeper' | 'worker' | 'orchestrator' | 'legacy' | string

export const CATEGORIES = ['RULES', 'ARCHITECTURE', 'CONSTRAINTS', 'CONFIG_VALUES', 'NAMING', 'PROJECT'] as const
export type Category = (typeof CATEGORIES)[number]

/** Keeper-produced claims may only take these categories (A3.4). */
export const KEEPER_ALLOWED: ReadonlySet<string> = new Set(['ARCHITECTURE', 'CONFIG_VALUES', 'PROJECT'])

export function memoryDbPath(): string {
  return process.env.DSH_MEMORY_DB ?? path.join(os.homedir(), '.dsh', 'memory.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  fact TEXT NOT NULL,
  category TEXT NOT NULL,
  tags TEXT DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('tentative','committed','orphaned_cancelled','rescinded')),
  source_trust TEXT NOT NULL CHECK (source_trust IN ('operator','verified_execution','untrusted_external')),
  origin TEXT NOT NULL,
  provenance TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  supersedes TEXT,
  tombstone_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_state ON claims(state);
CREATE INDEX IF NOT EXISTS idx_claims_category ON claims(category);

CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(
  fact, content='claims', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS claims_ai AFTER INSERT ON claims BEGIN
  INSERT INTO claims_fts(rowid, fact) VALUES (new.rowid, new.fact);
END;
CREATE TRIGGER IF NOT EXISTS claims_ad AFTER DELETE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, fact) VALUES ('delete', old.rowid, old.fact);
END;
CREATE TRIGGER IF NOT EXISTS claims_au AFTER UPDATE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, fact) VALUES ('delete', old.rowid, old.fact);
  INSERT INTO claims_fts(rowid, fact) VALUES (new.rowid, new.fact);
END;
`

export interface ClaimRow {
  id: string
  fact: string
  category: string
  tags: string
  state: State
  source_trust: Trust
  origin: string
  provenance: string
  created_at: number
  committed_at: number | null
  supersedes: string | null
  tombstone_reason: string | null
}

/** Open (or create) the memory database. Idempotent — safe to call per bundle. */
export function openMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(memoryDbPath())
  db.exec('PRAGMA journal_mode=WAL;')
  db.exec('PRAGMA busy_timeout=5000;')
  db.exec(SCHEMA)
  return db
}
