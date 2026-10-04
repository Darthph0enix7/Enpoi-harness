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
  live tool registry.
- **V2 (not in scope)**: composite/workflow tools (a tool = a chain of steps).
