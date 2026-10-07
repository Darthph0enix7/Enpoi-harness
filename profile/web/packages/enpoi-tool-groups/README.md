# dsh-enpoi-tool-groups

Base tool surface + attachable on-demand families (design: `~/dsh-migration/80-tool-groups-design.md`).

The plugin owns **presentation only**. The tool registry stays host-plane; each session's catalog
is shaped by one `tools.restrict({ deny })` installed through a plugin-owned scope tagged with
that agent, so the filter covers one session. The base surface keeps every static family; the
on-demand families (`peer`, `debug`, `creator`) are listed in the prompt as a menu (id + purpose +
attach state) and attach through the `tool_groups` meta-tool. No family pre-attaches: a fresh
session starts with all three detached, and only an operator `seats.<seat>.preAttach` override
starts a seat attached. The `creator` group belongs to the creator seat alone, so orchestrator and
sysadmin never see its three harness-authoring tools; their menu names the family in a one-line
seat-only notice with no attach affordance (policy.ts keeps `SHIPPED_SEAT_TOOL_DENY` as the
pre-execute backstop).

- **Model effect**: the on-demand schemas leave the tool block until attached; the menu adds one
  line per on-demand group. Attach/detach is durable (`tool-groups/change`) and applied at the
  next turn boundary, so a request's tool block never changes mid-flight.
- **Token effect**: the base block drops the 5 peer + 7 debug + 3 creator schemas; the menu costs
  ~120 tokens.
- **KV-cache effect**: attach/detach costs exactly one prefix rebuild at the next turn; nothing
  else in the prefix changes. The creator seat's menu shows the creator family's attach state
  where other seats show the seat-only notice, so a switch from the creator to another main agent
  also rebuilds the prefix once; turns within one seat stay cached.

Operator document: `enpoi-orchestration.toolGroups` (`groups.<id>.enabled`,
`seats.<seat>.preAttach`). Missing or malformed document, missing projection registry, or a
restriction that cannot install all fail **open**: nothing is hidden.

## Known Limitations and Deferred Work

- Only `peer`, `debug`, and `creator` ship as on-demand; the other families stay static until the
  pilot's measurement clears them (doc 80 §7).
- The menu section uses a literal order (`2950`); a named `SECTION_ORDERS` entry in
  `dsh-system-prompt` is the follow-up.
- Subagent children start on the base surface; group inheritance from a parent session is not
  implemented (their own `toolFilter` still intersects on top).
