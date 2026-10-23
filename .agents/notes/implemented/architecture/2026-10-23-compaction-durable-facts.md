# Agent Note: Compaction facts ride inside the summary text

Status: implemented

English | [中文](2026-10-23-compaction-durable-facts.zh.md)

## Problem

Two independent gaps made a long session forget what mattered:

- Compaction selected its range starting at the first non-system surface node, so the operator's opening requirements were the first thing condensed into prose. Setting a new task brief on a child had the same fate.
- Nothing carried condensed knowledge past the session. The context keeper distilled claims on its own batch schedule, but a compaction — the moment where the most context is destroyed — published nothing searchable, so the next session re-derived everything.

The obvious fixes each break a standing rule. Injecting a project-memory block into the prompt violates the injection policy (memory is tool-driven). Adding a payload field to `compaction/summary` costs a persistence acknowledgement, a regenerated catalog, SDK expected-output churn, and a type paste, all to carry text the summary already carries. Running a second summarizer pass over the shadowed range doubles the model cost and duplicates the keeper's claims.

## Decision

- **Facts are ordinary checkpoint text.** The summarizer instruction gains a `## Durable Facts` section (`decision` / `constraint` / `requirement` / `fact` items). The grammar and parser live in `@deepseek-ai/dsh-compaction-basic/durable-facts`, a pure dependency-free subpath. Consumers import it; the compaction package never imports a consumer.
- **No session-format change.** The section is content inside the existing `summary` blocks, so the writer version, the persistence catalog, and the SDK expected outputs are untouched.
- **The consumer owns policy.** Enablement, cap, near-duplicate threshold and workspace scoping belong to the plugin that saves the facts, not to the summarizer. The instruction is therefore unconditional: it is not logged, so an instruction that varied with configuration would break "reconstructable from log plus code".
- **Write only on success.** Facts are held from `compaction/summary` and written after the matching `compaction/end` with no error; mechanical stubs and failures write nothing.
- **Leading user messages can be pinned.** `pinLeadingUserMessages` keeps the contiguous leading `user/message` run out of the range and replays it to the summarizer as leading context, so the auxiliary request stays a byte-identical prefix up to the pinned run. `pinScope: child` keeps the default for root sessions.

## Consequences

- A compaction now costs roughly 150–400 extra output tokens; in exchange a future session gets exact decisions, constraints and identifiers instead of prose that drifted.
- Facts are retrieved by `memory_search`, never injected, so the injection policy holds and no extra request step appears in a running turn.
- Compaction facts are tagged by origin and scoped to the workspace recorded in their provenance, because a single global memory database would otherwise mix projects.
- Pinning changes which seqs a compaction shadows. Retention pins already protect cited seqs, and the shadowed range remains readable through the session log.

## Alternatives rejected

- A `compaction/summary` payload field: carries nothing the text does not, at real schema cost.
- A second claims pass over the shadowed range: double model cost, duplicated claims.
- Passive memory injection: violates the injection policy and adds a step to every running turn.
- Pinning everything: pinned nodes never shrink, so the budget would never recover.
