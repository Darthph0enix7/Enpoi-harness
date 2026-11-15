# dsh-enpoi-custom-tools

Operator-authored command tools for the Enpoi Harness profile.

- **Data**: `enpoi-orchestration.customTools` — an array of
  `{ id, name, description, params: [{ name, type: string|number|boolean, required, description }], command }`.
  Authored in Settings → Dynamic → Skills & tools → Tools → **+ Add tool**.
- **Runtime**: one real harness tool per record, registered as `custom_<id>`
  via `ctx.tools.register(defineTool(...))` and hot-applied on
  `settings/document-updated`. The model sees the record's description and
  parameter schema.
- **Execution**: the command template's `{{param}}` placeholders are replaced
  with POSIX single-quoted values (never raw interpolation) and the rendered
  command runs through `ctx.shell` under the session's standing sandbox policy.
  stdout, stderr, exit code, signal, and timeout are returned honestly.
- **Guard**: the plugin provides the `customToolCommands` seam; the
  enpoi-capabilities `tools/pre-execute` listener renders the command through
  it and feeds it to the same policy evaluator bash uses (`resolvePolicy` →
  `evaluateCommandPolicy`), so dangerous verbs, wrappers, and interpreters ask
  or deny per the operator's policy. The tool's own `custom_<id>` permission
  row defaults to **ask** (`defaults.unknownTools`), so first use is
  operator-granted; the Permissions page lists the row automatically from the
  live tool registry. The seam pins the rendered definition to the tool call
  id; execution consumes that snapshot, so a hot settings edit between approval
  and execution cannot turn the approved command into a different command.
  The snapshot key is the trusted session + call + tool identity. Duplicate or
  replayed renders for one identity reject it instead of overwriting the first
  approved command. Pending and rejection identities are each bounded LRUs
  (256); the rejection entry is a rolling dedupe window, not a permanent
  process-wide ban, so many denied calls cannot wedge unrelated sessions. A
  capacity-evicted or rejected identity refuses with a reason
  (`capacity`/`denied`/`duplicate`), and a leftover from a card denial or
  downstream-allow path is single-use and cannot execute after the
  tool/registry denies it.
- **V2 (not in scope)**: composite/workflow tools (a tool = a chain of steps).
