# dsh-enpoi-worker-credentials

English | [中文](README.zh.md)

This plugin provides host-side `mcpHeaderProvider` for a single configured Jarvis MCP server. `serverId` must exactly match the MCP client's `serverName` and the active job binding's `mcpEndpointId`. The provider resolves only the current session's `credentialRef`. It sends `Authorization`, `X-Jarvis-Job-ID`, and `X-Jarvis-Job-Fence` to that destination.

`secretDir` is absolute and defaults to `$DSH_HOME/worker-secrets`. The worker UID must own the directory (0700) and the bearer file (0600). A reference is a single case-sensitive name starting with an ASCII letter or digit, followed by up to 127 ASCII letters, digits, periods, underscores, or hyphens. Install a regular file with a single bearer value and an optional line ending; symlinks, multiply linked files, invalid values, and files exceeding 8 KiB are refused. Replace files atomically under a trusted worker-owned parent rather than editing them in place. A missing file or inactive binding produces no headers; an unsafe file produces a generic error. Neither path logs the secret or its filename.

## Model Experience

The plugin contributes no prompt, tool, token use, or KV-cache change. Headers are resolved at request time, not projected to the model or persisted in session history.

## Known Limitations and Deferred Work

- The provider supplies no discovery credential before a binding exists. The current MCP client makes a request without dynamic headers when the provider returns `undefined`; its endpoint must reject unauthenticated requests. Do not add a static Authorization fallback. See the [Jarvis worker profile](../../../../docs/creator/16-jarvis-worker-profile.md) for the discovery ordering blocker.
- File ownership and mode checks do not isolate other processes running as the worker UID. Use a dedicated worker account or stronger OS isolation. There is no runtime invariant companion: the provider owns no state independent of the binding and the file it reads.
