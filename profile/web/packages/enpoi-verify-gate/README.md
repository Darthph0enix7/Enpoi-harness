# dsh-enpoi-verify-gate

Turn-end verification gate. It closes a live-observed defect: an agent ends a
turn claiming success while **its own last verification failed** (a session ran
`pytest`, saw `assert [] == [7]`, then ended the turn as `completed` without
ever calling `edit`/`write` — the harness noticed nothing).

## The rule

The plugin observes the durable `session/event` stream (the house seam used by
`enpoi-diagnostics`; not deprecated readers) and, at `turn/end`, decides a turn
ended **unverified** when both hold:

1. the turn's **last verification-ish tool result** was a failure, and
2. the turn ended `completed`.

"Verification-ish" is:
- `bash`, `pwsh`, `str_replace_editor`, or
- any tool result carrying structured facts: a tool-owned `meta.exitCode`
  (bash/pwsh's `ShellOutcomeMeta`) or a structured `error` identity.

Control/dispatch-plane tools (`subagent`, `task`, goal tools, `send_message`,
`interrupt_agent`, `list_agents`) never count: a capacity rejection or an
unavailable approval is an orchestration fact, not a failed verification of the
work. Their results neither open nor clear the gate.

"Failed" is: `meta.exitCode` present and not `0` (`null` = signal-killed), or a
structured `error`, or the tool-role message's `isError === true` (native
session-format V4 — the retired V3 nested `tool-result` wrapper is not read), or
a recognised failure text (`[exit code: N]`, `FAILED`, `AssertionError`,
`Traceback …`, `… ERR!`, `command not found`). A later passing verification
clears an earlier failure in the same turn; non-verification results (e.g.
`read`) do not.

## The record

One ignorable fork event per unverified turn, written through
`Session.append(..., { ignorable: true })` — the same envelope as the LLM
seam's `llm/attempt-failed`, so no released union or schema changes:

```json
{
  "type": "verify/unmet",
  "seq": 35,
  "data": {
    "turn": 1,
    "tool": "bash",
    "callId": "call_00_…",
    "exitCode": 1,
    "reason": "exit-code",
    "messagePreview": "test_convert.py:8: AssertionError"
  },
  "ignorable": true
}
```

`messagePreview` is a whitespace-collapsed, ANSI-stripped failure line bounded
to 200 chars; `reason` is one of `exit-code | tool-error | is-error |
failure-text`. The event is recorded exactly once per turn (the per-turn
failure is consumed at the boundary).

## Behaviour switch (default = record-only)

`enpoi-orchestration.parameters.verifyGate`, read hot at every turn end from the
shared document — after the 0.1.7 settings→Config migration that document is the
`enpoi-orchestration` profile entry's `.volatile()` Config, read through the
settings service's `describe()` value (with the pre-0.1.7 `get()` fallback; see
`dsh-enpoi-contracts:readOrchestrationDocument`):

```yaml
parameters:
  verifyGate:
    mode: record        # record (default) | prompt
    promptOnce: false   # prompt mode: cap to one prompt for the session
```

- `record` never injects anything.
- `prompt` injects **one bounded follow-up** into the same session
  ("Your last verification failed — continue the work or explain why the turn is
  done.") via `agent.followup(...)`, and never loops: a second consecutive
  unverified ending is recorded, not re-prompted. A verified (or aborted/error)
  turn resets the streak; `promptOnce: true` caps prompts to one per session.

The plugin's own `cordis.patch.yml` config (`mode`/`promptOnce`, `.volatile()`)
is only the fallback for a deployment without settings; being volatile, the
fields are also editable live through the profile's config-editor document.

## Debug visibility

`session.digest` is host-side (`packages/api/session-controller` in the harness
repo, `F/packages/**`) and cannot be extended from this profile. Instead the
gate reports each unmet turn into the existing diagnostics service through its
`report` seam (`kind: 'verify-unmet'`), so `enpoi-debug`'s `session_debug`
tool already shows it in its `incidents` section (session rows first) — no
edit to `enpoi-debug` required. The `diagnostics/list` RPC is the read route.

Example (`diagnostics/list`):

```
error  client  client-report  D96FB6B  session-…  verify/unmet: bash exit-code exitCode=1 turn=1 test_convert.py:8: AssertionError
```

The migration-disposition inventory in
`F/packages/session/session-format-v0-to-v1/src/dispositions.ts` is harness-side
(out of profile scope) and was **not** edited. It does not need to be: the
persistence read path tolerates an unknown type exactly when the record carries
`ignorable: true` (`session-persistence/src/storage-contract.ts`), which is the
mechanical tolerance the existing fork vocabulary (`llm/attempt-failed`) uses.

## Guarantees

- Fail-open: a gate failure is logged and swallowed; it never blocks a turn,
  an append, or another plugin.
- Read-only towards other packages: no host code, no schema/union changes, no
  edits outside this package and its profile registration.
- Bounded: previews ≤200 chars, remembered call ids and tracked sessions are
  capped (oldest evicted first).

## Build

```sh
pnpm --dir ~/.dsh/profiles/web/packages/enpoi-verify-gate build
```

## Tests

```sh
cd ~/.dsh/profiles/web && pnpm vitest run packages/enpoi-verify-gate
```

Covers: live-shaped exit-1 result detection, clean/aborted/error turns record
nothing, exactly-one record per unverified turn, prompt mode injecting once and
never on a second consecutive unverified turn, `promptOnce`, settings
precedence, and the plugin wiring (deferred append, diagnostics report,
follow-up message).
