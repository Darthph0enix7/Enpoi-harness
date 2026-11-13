# dsh-enpoi-memory

English | [中文](README.zh.md)

Durable cross-session memory for the Enpoi Harness, exposed as four model tools. Memory is tool-driven: nothing is injected into a turn, and every write lands in one shared SQLite database that the keeper, dispatcher, and CLI open through their own connections.

## Tools

- `memory_save` saves one self-contained fact (at most 400 characters) with `origin: orchestrator` and the operator trust label. Duplicate or invalid facts answer `saved: false` with the reason.
- `memory_search` returns matching committed and tentative facts with id, category, origin, save date, state, and trust. Compaction-derived rows are scoped to the caller's workspace by default; other origins, including keeper claims, keep their existing visibility. Nothing is injected into the model context.
- `memory_rescind` tombstones one fact. A tombstone is absorbing: the same fact is never revived.
- `memory_confirm` commits a tentative claim with the operator trust label and a fresh commit time. It applies only to tentative rows; an already-committed id answers `Already <state>`.

A `memory_confirm` or `memory_save` call made by a model is tool delegation, not human fact verification. The operator label records which tool wrote the row, not that a person checked the claim.

## Claims and trust

A claim is `tentative`, `committed`, `orphaned_cancelled`, or `rescinded`; its trust is `operator`, `verified_execution`, or `untrusted_external`.

- Compaction Durable Facts land as tentative `untrusted_external` claims with `origin: compaction`. A committed checkpoint proves the summarization ran, not that model-extracted text is true.
- Keeper claims land as tentative `untrusted_external` claims with `origin: keeper`. An exact operator quote proves only that those words exist in a human message; it does not prove their interpretation, acceptance, or truth.
- An automated claim gains the operator label only through an operator-authority write: `memory_confirm` on a tentative row, or a re-observed `memory_save` of the same fact. Neither automated source may mint `RULES`, `CONSTRAINTS`, or `NAMING` categories.
- Near-duplicate suppression uses a token-set Jaccard threshold before intake; the secret guard rejects credential-shaped facts.

Boot and HMR reconciliation turns leftover tentative claims from an unfinished run into `orphaned_cancelled`, but preserves a claim whose stored source record carries a producer-settlement proof:

- `origin: compaction` with `source: compaction` and a non-empty `compactionId`;
- `origin: keeper` with `source: keeper`, a non-empty `sessionId`, a non-negative integer `batchBasedOnSeq`, and `settled: true`.

This is a structural source-record check, not authentication. Rescinded and already-orphaned rows are never modified.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `compactionFacts` | true | Capture the `## Durable Facts` section of model-written compaction summaries |
| `compactionFactsIncludeChildSessions` | false | Also capture facts from subagent child sessions |
| `compactionFactsMax` | 12 | Maximum facts captured from one compaction, clamped to 1–40 |
| `compactionFactsNearDuplicate` | 0.8 | Token-set Jaccard threshold for near-duplicate suppression, clamped to 0.5–1 |
| `scopeCompactionFactsToWorkspace` | true | Restrict `origin: compaction` rows in `memory_search` to the caller's workspace cwd |

The retrieval top-K and character budget come from `enpoi-orchestration.parameters.memory` (`retrieverTopK` default 10, `retrieverCharBudget` default 1200) and are resolved fresh per search.

## Known limitations

- A fact containing a line break is quoted in `memory_search` output so it cannot spoof a second result row.
- The database path follows `DSH_MEMORY_DB`, else `~/.dsh/memory.db`; the package exposes no service, so sibling processes coordinate through SQLite WAL and `BEGIN IMMEDIATE`.
- Memory is never injected. A consumer that skips `memory_search` sees no stored fact.

## Tests

```sh
cd profile/web
npx vitest run packages/enpoi-memory/tests
```
