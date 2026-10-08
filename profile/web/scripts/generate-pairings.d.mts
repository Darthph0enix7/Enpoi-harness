/**
 * Types for `generate-pairings.mjs`, the profile-shipped fleet pairing
 * generator. The script stays plain runtime JavaScript (it runs under the
 * installer's Node without a build step); this declaration gives its consumers
 * — the unit spec and any future tooling — a typed surface.
 */

/** First line of a file this generator owns and may replace. */
export const MANAGED_MARKER: string
/** First line of a file the operator owns; generation is skipped entirely. */
export const OPT_OUT_MARKER: string
/** The registry path shipped beside the script (`profile/web/fleet.yaml`). */
export const DEFAULT_REGISTRY_PATH: string

/** One fleet member as normalized by {@link validateRegistry}. */
export interface FleetMember {
  readonly name: string
  readonly alias: string
  readonly exposure: 'answer-only' | 'debug'
  readonly create: string
  readonly hostnames: readonly string[]
  readonly ip?: string
  readonly port?: number
}

/** A validated fleet registry document. */
export interface FleetRegistry {
  readonly version: 1
  readonly hub: string
  readonly members: readonly FleetMember[]
}

/** Tailnet names and IPv4s gathered from `tailscale status --json`. */
export interface TailnetFacts {
  /** Tailscale self names; an injected facts object may omit them. */
  readonly selfNames?: readonly string[]
  readonly ips: ReadonlyMap<string, string>
}

/** The outcome of one {@link generatePairings} run. */
export interface GeneratePairingsResult {
  readonly action: 'written' | 'unchanged' | 'skipped' | 'rejected'
  readonly path: string
  readonly reason?: string
  readonly entries?: number
  readonly backup?: string
}

/** Where the generator reports progress; the CLI writes to stderr. */
export interface PairingsLogger {
  log: (message: string) => void
  warn: (message: string) => void
}

/** One injected command result (the subset of `spawnSync` the script reads). */
export interface CommandResult {
  readonly status: number | null
  readonly stdout: string | null
}

/** One injected command runner. */
export type CommandRunner = (command: string, args: readonly string[]) => CommandResult

/** Every collaborator {@link generatePairings} accepts an override for. */
export interface GeneratePairingsOptions {
  readonly registryPath?: string
  readonly pairingsPath?: string
  readonly device?: string
  readonly port?: number
  readonly registry?: unknown
  readonly parseYaml?: (raw: string) => unknown
  readonly parsePairings?: (raw: string, path: string) => unknown
  readonly facts?: TailnetFacts
  readonly run?: CommandRunner
  readonly hostnames?: readonly string[]
  readonly logger?: PairingsLogger
}

/**
 * Validate one parsed registry document.
 * @throws when the document is not a valid version-1 registry.
 */
export function validateRegistry(parsed: unknown, path: string): FleetRegistry

/**
 * Identify this device's member from `DSH_PEER_DEVICE` or hostname candidates.
 * @throws when no member — or more than one — matches.
 */
export function identifyLocalMember(registry: FleetRegistry, options?: { device?: string; hostnames?: readonly string[] }): FleetMember

/** Read this tailnet's member names and IPv4s. */
export function collectTailnetFacts(options?: { run?: CommandRunner }): TailnetFacts

/** Resolve one remote member's endpoint IPv4 (live tailnet first, registry fallback). */
export function resolveMemberIp(
  member: Pick<FleetMember, 'name' | 'hostnames' | 'ip'>,
  facts: TailnetFacts,
  run: CommandRunner,
): string | undefined

/** The member whose record supplies an entry's alias, exposure, and preset. */
export function aliasOwnerFor(local: FleetMember, remote: FleetMember, hub: string): FleetMember

/** Render one device's complete pairing document. */
export function renderPairingsDocument(
  registry: FleetRegistry,
  options: { local: FleetMember; ips: ReadonlyMap<string, string>; port?: number },
): string

/** Load the harness peer package's validator and the `yaml` parser. */
export function loadHarnessParser(harnessRoot: string): Promise<{
  parseYaml: (raw: string) => unknown
  parsePairingsDocument: (raw: string, path: string) => unknown
} | undefined>

/** Generate the local pairing document (never throws for expected conditions). */
export function generatePairings(options?: GeneratePairingsOptions): Promise<GeneratePairingsResult>

/** The CLI entry; always answers 0 so an install or update is never failed. */
export function main(): Promise<number>
