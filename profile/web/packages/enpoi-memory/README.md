# dsh-enpoi-memory

English | [中文](README.zh.md)

Durable cross-session memory for the Enpoi Harness, exposed as four model tools. Memory is tool-driven: nothing is injected into a turn, and every write lands in one shared SQLite database that the keeper, dispatcher, and CLI open through their own connections.

## Tools

- `memory_save` saves one self-contained fact (at most 400 characters). A verified root session—including a user-created fork (`parentSession` with `isSeeded: true`, no `origin`, and `delegationDepth` absent or 0, which matches the persisted JSONL fork header; this is safe because real subagent children always stamp `origin: 'subagent'` and `delegationDepth >= 1`, and a caller able to forge arbitrary session headers already controls a forged session)—writes `origin: orchestrator` with the operator trust label. A subagent child (`origin: 'subagent'` or positive `delegationDepth`), an ambiguous unseeded `parentSession` (without `isSeeded: true` and without `origin`), or a malformed header lineage classifies as delegated and writes `origin: worker:<role>` (or `worker` without a preset) as a tentative `untrusted_external` claim; a call with a missing session or header fails closed with `saved: false` and writes nothing. A fact that looks like a credential or secret is rejected with `saved: false` and is never stored; the same fact text and category are stored once. A save whose tokens closely match an existing active fact is still stored, and its result note names the closest existing fact id.
- `memory_search` returns matching committed and tentative facts with id, category, origin, save date, state, and trust. Hits rank by the number of content query terms they cover, then by an exact full-query phrase; origin/category weights, the caller-project cwd recorded in provenance, and bounded recency settle ties. An AND miss falls back to OR recall that keeps only rows matching at least two content terms when the query has three or more. The optional `limit` is an integer clamped to the configured top-K, and whole facts are included in rank order while their cumulative fact characters stay within the configured character budget. The top-ranked hit is always returned even when it alone exceeds the budget; no fact is truncated, and the render reports how many matches the budget omitted. Compaction-derived rows are scoped to the caller's workspace by default; other origins, including keeper claims, keep their existing visibility. Nothing is injected into the model context.
- `memory_rescind` tombstones one fact. A tombstone is absorbing: the same fact is never revived. Root sessions only; a delegated subagent is denied and must report the fact to its parent.
- `memory_confirm` commits a tentative claim with the operator trust label and a fresh commit time. It applies only to tentative rows; an already-committed id answers `Already <state>`. Root sessions only; a delegated subagent is denied. A child `memory_save` remains tentative until a root session confirms it.

A `memory_confirm` or `memory_save` call made by a model is tool delegation, not human fact verification. The operator label records which tool wrote the row, not that a person checked the claim.

## Claims and trust

A claim is `tentative`, `committed`, `orphaned_cancelled`, or `rescinded`; its trust is `operator`, `verified_execution`, or `untrusted_external`.

- Compaction Durable Facts land as tentative `untrusted_external` claims with `origin: compaction`. A committed checkpoint proves the summarization ran, not that model-extracted text is true.
- Keeper claims land as tentative `untrusted_external` claims with `origin: keeper`. An exact operator quote proves only that those words exist in a human message; it does not prove their interpretation, acceptance, or truth.
- A child `memory_save` lands as a tentative `untrusted_external` claim with `origin: worker` or `worker:<role>`. The completed tool call proves the save ran, not that the finding is true. Only a root session can confirm or rescind memory facts; delegated sessions receive a `delegated_session_denied` result without a database write.
- An automated claim gains the operator label only through an operator-authority write: `memory_confirm` on a tentative row, or a re-observed `memory_save` of the same fact. Compaction and keeper claims never mint `RULES`, `CONSTRAINTS`, or `NAMING` categories; a child `memory_save` may propose such a category only as a tentative claim, and only a root-session write (`memory_confirm` or a re-observed `memory_save`) can make any claim operator-trust.
- Near-duplicate suppression uses a token-set Jaccard threshold before intake for compaction facts, which are never fuzzy-merged into existing rows. `memory_save` does not suppress near-matches: it stores the fact and names the closest existing active fact in its result note when the same threshold is reached, so two facts that differ in one number both survive. The secret guard runs in the intake pipeline for every origin (compaction, keeper, and `memory_save`): a credential-shaped fact is skipped and never stored, and a producer never sees an exception.

Boot and HMR reconciliation turns leftover tentative claims from an unfinished run into `orphaned_cancelled`, but preserves a claim whose stored source record carries a producer-settlement proof:

- `origin: compaction` with `source: compaction` and a non-empty `compactionId`;
- `origin: keeper` with `source: keeper`, a non-empty `sessionId`, a non-negative integer `batchBasedOnSeq`, and `settled: true`;
- `origin: worker` or `worker:<role>` with `source: memory_save`, a non-empty `sessionId`, and `settled: true`; the recorded `parentSessionId` and `callId` are attribution, not proof.

This is a structural source-record check, not authentication. Rescinded and already-orphaned rows are never modified.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `compactionFacts` | true | Capture the `## Durable Facts` section of model-written compaction summaries |
| `compactionFactsIncludeChildSessions` | false | Also capture facts from subagent child sessions |
| `compactionFactsMax` | 12 | Maximum facts captured from one compaction, clamped to 1–40 |
| `compactionFactsNearDuplicate` | 0.8 | Token-set Jaccard threshold for compaction-fact suppression and the `memory_save` near-match note, clamped to 0.5–1 |
| `scopeCompactionFactsToWorkspace` | true | Restrict `origin: compaction` rows in `memory_search` to the caller's workspace cwd |

The retrieval top-K and character budget come from `enpoi-orchestration.parameters.memory` (`retrieverTopK` default 10, `retrieverCharBudget` default 1200, clamped to 200–4000) and are resolved fresh per search. The budget bounds the fact text returned by `memory_search`, not the ranking: ranking always sees the configured top-K, and the render reports budget-omitted matches.

## Known limitations

- A fact containing a line break is quoted in `memory_search` output so it cannot spoof a second result row.
- The character budget omits whole facts only. A single top-ranked fact longer than the budget is still returned, and the omission note counts only matches inside the configured top-K window, not every stored row.
- The caller-project preference reads the cwd in a row's provenance as a bounded ranking tie-break; it is not a visibility filter.
- Delegation permissions do not carry memory-confirmation authority: even a child with full execution access cannot grant operator trust or tombstone facts. The root session must accept the fact.
- For queries with three or more content terms, the OR fallback drops rows matching only one term. A query whose sole match is a generic word returns no hit instead of an unrelated fact.
- Fallback membership comes from the pair FTS query over the first 12 content terms and a 20-candidate window; JS scoring ranks those rows only. More than 20 qualifying rows can still outrank a target and keep it out of the window. This is bounded recall, not a global best-coverage guarantee.
- Scoring splits `_`/`-` and folds accents like SQLite unicode61 for the tested Latin cases; this is not a full unicode61-equivalence claim. The FTS sanitizer still requires two-character terms, so a query made only of one-character terms returns no hit.
- The database path follows `DSH_MEMORY_DB`, else `~/.dsh/memory.db`; the package exposes no service, so sibling processes coordinate through SQLite WAL and `BEGIN IMMEDIATE`.
- Memory is never injected. A consumer that skips `memory_search` sees no stored fact.

## Tests

```sh
cd profile/web
npx vitest run packages/enpoi-memory/tests
```
