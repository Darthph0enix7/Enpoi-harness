/**
 * Declarations for scripts/update-catalog.mjs: the per-channel update catalog
 * generator (docs/plan/ui-update-manifest.md P1).
 */

/** One release entry in the catalog. */
export interface CatalogEntry {
  /** Release tag without the leading `v` (e.g. `0.1.7-enpoi.2.81`). */
  version: string
  /** Short 7-character commit prefix the tag points at. */
  commit: string
  /** Tag date, ISO 8601 UTC. */
  releasedAt: string
  /** One commit subject per line in git order (newest first); merge and noise commits skipped. */
  notes: string[]
}

/** The catalog document (`schemaVersion` 1). */
export interface UpdateCatalog {
  schemaVersion: number
  channel: string
  generatedAt: string
  releases: CatalogEntry[]
}

/** Inputs for {@link buildCatalog}. */
export interface BuildCatalogOptions {
  /** Repository root; defaults to the current working directory. */
  repo?: string
  /** Catalog channel (`stable` or `beta`). */
  channel: string
  /** Release tag to upsert; omitted rebuilds every release tag. */
  tag?: string | null
  /** Parsed existing entries, or an existing catalog document. */
  existing?: unknown
  /** Clock returning the `generatedAt` timestamp. */
  now?: () => string
  /** Release cap override (default 40). */
  keep?: number
}

/** Emitted catalog schema version. */
export declare const CATALOG_SCHEMA_VERSION: number
/** Release tags kept in the catalog (newest first). */
export declare const CATALOG_KEEP: number

/**
 * One entry per commit subject in `range`, in git order (newest first).
 * @param repo - repository root.
 * @param range - git range (`prev..tag`) or a single tag.
 * @param limit - maximum subject count.
 */
export declare function collectNotes(repo: string, range: string, limit?: number | null): string[]

/**
 * Every release tag in `repo`, oldest first.
 * @param repo - repository root.
 */
export declare function listReleaseTags(repo: string): { tag: string; releasedAt: string }[]

/**
 * Parse an existing catalog document; null when it is not usable.
 * @param value - parsed JSON value or raw text.
 */
export declare function parseExistingCatalog(value: unknown): CatalogEntry[] | null

/**
 * Read and parse an existing catalog file; null when missing or malformed.
 * @param file - catalog path.
 */
export declare function loadExistingCatalog(file: string): CatalogEntry[] | null

/**
 * Build the catalog document for one channel.
 * @param options - build inputs.
 */
export declare function buildCatalog(options: BuildCatalogOptions): UpdateCatalog

/**
 * CLI entry point.
 * @param argv - arguments after the script path.
 * @returns the process exit code.
 */
export declare function main(argv: string[]): number
