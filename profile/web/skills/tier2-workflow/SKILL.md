---
name: tier2-workflow
description: Sophisticated ideation and planning. Mandatory roundtable tool usage for vision expansion before technical implementation.
---

# Tier 2 Workflow: Ideation & Planning

Tier 2 is a high-value, high-performance workflow designed for vision expansion, feature ideation, and resolving highly ambiguous technical directions BEFORE implementation begins.

**Scope:** This workflow governs the current request only. A new request starts from the default behavior unless the operator invokes a tier again; invoking another tier for the same task replaces this workflow.

## Core Contract
- **State Management:** Author the tier state on the whiteboard with `whiteboard_write` (kinds: path, rule, fact, task; stable ids so `replace` can update them) and pin the brief with `whiteboard_pin` or `pinned: true` — pinned context is injected for the session and visible to the fleet. Keep the `todo_write` list synced with the current phase.
- **MANDATORY Roundtable Ideation:** The user has provided a vision or basic idea. You MUST FIRST invoke the `roundtable` tool (`roundtable({ query: "...", maxRounds: 5 })`) to ideate, get creative feature suggestions, and refine the perfected version of the user's vision.
- **Technical Translation:** Once the roundtable outputs its Council Report, translate its findings into a concrete technical implementation plan on the whiteboard.
- **Mandatory Plan Review:** Consult the Oracle through `oracle_review` to review your technical translation of the roundtable's plan — provide a reading list (file paths, line numbers), never pasted code.
- **Implementation & Final Review:** Proceed with implementation, dispatching bounded parallel work to `fixer`-role workers with the `subagent` tool (every dispatch is a fresh session; include the whiteboard brief). Consult the Oracle with `oracle_review` for a final code review at the end and fix actionable issues before concluding.

## Delegation & Offload
- **Keep this session lean.** The roundtable, the technical translation, the Oracle dialogue, and the final synthesis stay here; bounded work goes to the fleet. A worker is cheaper than your context.
- **Role map:** `fixer` — bounded, clearly implementable work (scoped edits, builds, tests); `explorer` — codebase mapping and recon, reporting `file:line`; `librarian` — anything needing the live web, dispatched with a research dial (see below); `designer` — all UI work.
- **Research:** for news, pricing, docs, comparisons, releases, or any "what is the latest…" question, dispatch ONE `librarian` with the question and a dial — `lookup` | `quick` | `standard` (default) | `deep` | `exhaustive`. It runs the `research` skill end-to-end (archived sources, anchored claims, mechanical verification) and returns the cited answer. If web search is unavailable, the librarian will say so — do not fake it, and fall back to fetch-only reading of URLs the user supplies. Never fetch, save, or extract web material in this session.
- **Full-context dispatch law:** every dispatch is a fresh, self-contained session. Describe everything it needs — objective, scope, constraints, expected output, budget, and all relevant context (paths, findings so far, what "done" looks like). Never assume it knows what you know; include the whiteboard brief.
- **Dispatch readily:** if you notice you are ten calls deep in recon or implementation a worker could own, stop and dispatch now.

## Whiteboard Layout
The pinned board entries for the task MUST follow this standard structure:

### 1. Initial Vision
The raw goal or idea provided by the user (id `vision`).

### 2. Roundtable Council Report
Record the synthesized results from the `roundtable` debate (Decision, Dissent, Open Questions) (id `council`).

### 3. Technical Translation & Oracle Review
- The concrete technical plan derived from the roundtable report (id `plan`).
- **Oracle Review Notes:** the `oracle_review` critique of the technical plan.

### 4. Execution Log
Phases and parallel workers used (each a fresh `subagent` dispatch).

### 5. Final Oracle Review & Validation
Record the final verdict from `oracle_review` and validation results.
