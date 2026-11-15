/**
 * enpoi-whiteboard — orchestrator-authored pinned context (doc 66 §3c,
 * doc 67 §B).
 *
 * The board lives in the shared settings namespace `enpoi-orchestration` under
 * `whiteboard` (hot-swappable + cross-device via settings sync), is authored
 * only through the five tools (`whiteboard_read`, `whiteboard_write`,
 * `whiteboard_pin`, `whiteboard_unpin`, `whiteboard_forget`), and is injected
 * through the runtime-context seam (`systemPrompt.context()`, a trailing
 * replace-in-place snapshot) — never the system prompt itself, so the frozen
 * prefix keeps its cache.
 *
 * Boards are stored per scope and resolved per session: global → project
 * (matching the session cwd) → parent session (direct-child inheritance) →
 * session (matching the session id), later scopes overriding earlier ones by
 * entry id. The injected block and every read render the resolved view, so a
 * session-scoped entry never leaks into another session; a legacy single-board
 * document stays readable and migrates into the bucket its own scope names —
 * a legacy `global` board attributed with `meta.writtenBySessionId` migrates
 * into that session's bucket and leaves `global` empty, so every other session
 * resolves empty. The Watchtower card renders only the session half of the
 * resolved view; project/global entries stay behind a collapsed disclosure.
 *
 * Guarantees: a rendered resolved board over the hard budget REFUSES the write
 * (never silently trims); an exact single-path entry is validated and flagged
 * `stale` — never deleted — while prose/mixed legacy values are unverified, not
 * stale; `whiteboard_forget` returns the entry it removed. Mutations return a
 * short receipt; only `whiteboard_read` returns the full resolved view. Session
 * buckets are bounded by a one-sweep-per-activation GC that keeps the newest
 * {@link DEFAULT_MAX_SESSION_BOARDS} boards.
 *
 * @module dsh-enpoi-whiteboard
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type SettingsDocumentReader } from 'dsh-enpoi-contracts';
import { type BoardScopeFacts, type ResolvedBoard, type WhiteboardStore } from './board.js';
/** Cordis plugin name. */
export declare const name = "enpoi-whiteboard";
/** The board's storage namespace is a shared service; tools are the write path. */
export declare const inject: string[];
/** Live-editable whiteboard bounds. */
export interface Config {
    /** Hard rendered-token budget (doc 67 §B); writes over it are refused. */
    budgetTokens?: Volatile<number>;
    /** Bounded GC: how many session boards to keep across activations. */
    maxSessionBoards?: Volatile<number>;
}
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    budgetTokens: Schema<number, number, "defined">;
    maxSessionBoards: Schema<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    budgetTokens: Schema<number, number, "defined">;
    maxSessionBoards: Schema<number, number, "defined">;
}>>, "plain">;
/** Defaulted plain config handed to the tool/GC closures. */
export interface ResolvedWhiteboardConfig {
    budgetTokens: number;
    maxSessionBoards: number;
}
/**
 * Read the current multi-scope store from one plugin context.
 * @param ctx - owning plugin context.
 * @returns the normalized store.
 */
export declare function readWhiteboardStore(ctx: Context): WhiteboardStore;
/**
 * Resolve the shared whiteboard for one reader without a plugin context. This is
 * the shared-consumer read: it applies the same legacy migration and
 * global → project → parent-session → session resolution as the read tool,
 * budget check, and injected block, and it never writes or opens another
 * datastore. Consumers pass the `settings` service they already hold. This is
 * the fail-open read path (a missing/malformed document resolves empty);
 * mutations use the strict read and refuse instead of overwriting.
 * @param settings - the `settings` service, or undefined.
 * @param facts - the reader's session/project/parent scope facts.
 * @returns the resolved view; an absent or malformed document resolves empty.
 */
export declare function resolvedBoard(settings: SettingsDocumentReader | undefined, facts?: BoardScopeFacts): ResolvedBoard;
/**
 * Read the board resolved for one assembly's scope facts (global → project →
 * parent session → session).
 * @param ctx - owning plugin context.
 * @param facts - the reader's scope facts; omitted resolves global only.
 * @returns the resolved view.
 */
export declare function readWhiteboard(ctx: Context, facts?: BoardScopeFacts): ResolvedBoard;
export type { BoardScopeFacts, ResolvedBoard, WhiteboardEntry } from './board.js';
export declare function apply(ctx: Context, config?: Config): void;
