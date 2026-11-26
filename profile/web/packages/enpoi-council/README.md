# Enpoi Council

English | [中文](README.zh.md)

This Web profile plugin provides `roundtable` for architecture debates, `chorus` for brainstorming, and additional councils defined in `enpoi-orchestration.councils`. The tools return an advisory synthesis or idea harvest.

## Seat lifecycle

The council waits for the subagent service to release a failed or timed-out seat before trying to replace it. The referee, evidence broker, and chair release their children after their respective passes. The council waits for its remaining children to stop and release their slots when the run succeeds, fails, or is cancelled. Release preserves session history. A release error is written to the council diagnostic log without replacing the run's result or error.

## Model Experience

### Deliberation and tool result

#### What the model sees

Seats get their own prompts and share findings through the referee's ledger. The calling model receives the final tool result, not the child turns.

#### Token effect

Seat turns, adjudication, evidence gathering, and synthesis use separate model calls. The final report enters the caller's context as a tool result.

#### KV Cache effect

Child sessions have separate request histories; they do not share the calling session's KV cache. A replacement seat starts with a fresh request history.

## Known Limitations and Deferred Work

- Councils share the parent agent's `maxActiveSubagents` limit with other children. A council can still fail to reach quorum if capacity is already occupied.
