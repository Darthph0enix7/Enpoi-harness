# Quiet Subagent Orchestration, Durable Descriptor Persistence, and Report Tool Suppression

- **Area:** `subagent`, `tool-subagent-report`, `enpoi-council`, `enpoi-dispatcher`, `enpoi-oracle`
- **Scope:** Continuable subagent lifecycle, parent settlement notice suppression, child setup registry contribution threading, task-card return schema relaxation.
- **Date:** 2026-08-27

## Problem and Context

When executing multi-agent orchestrations (Council / Roundtable / Chorus), child fibers (debaters, critics, curators) generated internal rounds and settled. The runtime automatically injected `subagent-report` and `subagent-settled` synthetic messages (`Background subagent <id> finished...`) into the parent conversation log. Furthermore:
1. `ContinuableStartSpec.quiet` was not persisted in `subagent/descriptor` session events, causing cold-resumed children to lose their quiet status and resume emitting settlement notices.
2. `ContinuableSetupContribution` only received `childCtx: Context`, with no visibility into spawn-time composition facts (`quiet`, `toolFilter`). `tool-subagent-report` thus unconditionally registered both the `report` tool and its system prompt guidance into every child, prompting curator/critic models to invoke `report` with full summaries and then double-generate the same summary as direct chat text.
3. Bounded worker dispatches (`dispatch_task` for librarian, explorer, fixer, designer) enforced a strict schema requiring `changed: string[]`, `verified: boolean`, and `NOT_verified: string[]`. When a pure research worker (e.g. `librarian`) returned no file changes, the UI rendered `Worker done — changed: none`, hiding the entire research report. In background mode, summaries were truncated to 500 characters.

## Implemented Architecture

1. **Durable `quiet` in Subagent Descriptors:**
   - Extended `ContinuableSubagentDescriptorData` and `SubagentDescriptor` parser/snapshot to preserve `quiet: boolean`.
   - `coldResume()` restores `quiet: descriptor.quiet ?? false`.
   - Backward compatibility: legacy descriptors without `quiet` fold safely as `undefined` (`false`).

2. **Spawn Composition Threading in Setup Registry:**
   - Extended `ContinuableSetupInfo` (`{ quiet: boolean; toolFilter?: ToolRestriction }`).
   - `SubagentActivationSetupRegistry.apply(childCtx, info)` passes `info` to `ContinuableSetupContribution`.
   - `tool-subagent-report` early-exits when `info?.quiet === true` or when `report` is in `toolFilter.deny`, suppressing both tool registration and prompt guidance.

3. **Dispatcher & Oracle Schema Relaxation:**
   - Relaxed `SUBAGENT_RETURN_SCHEMA` in `enpoi-dispatcher`: required array is only `['summary']`. File mutation fields (`changed`, `verified`, `NOT_verified`, `remember_later`) are optional.
   - Updated `output.render` to display both `Files Changed` (if present) and the complete `summary`.
   - Conformed `enpoi-oracle` background and mutex rejection returns to output schema (`background: true`, `rejected: true`), suppressing false `Oracle verdict: CONCERNS` lines in dispatch acknowledgments.
   - Cleaned up redundant `oracle/verdict-committed` event emissions. Kept vocabulary entry in `known-event-types.ts` for backward compatibility with existing historical sessions.

## Fork-Delta Rebase Hazard

`packages/core/session/src/known-event-types.ts` contains manual additions for fork event types (`oracle/verdict-committed`, `brief/*`, `claim/*`, `council/*`). Running `pnpm run gen-persistence-catalog` during upstream rebases will regenerate this file from in-tree `SessionEventMap` declarations, which silently drops fork event entries unless they are declared via declaration merging in a core package. When rebasing onto upstream tags, preserve these entries manually.
