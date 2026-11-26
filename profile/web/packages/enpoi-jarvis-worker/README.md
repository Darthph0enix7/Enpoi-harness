# Jarvis worker bundle

English | [中文](README.zh.md)

The release-owned composition grants one fresh Jarvis job access to two knowledge reads. [`selector.json`](selector.json) is copied to the attempt home; it does not include the human profile. The controller uses the loopback peer carrier: unary requests require a bearer, and the WebSocket accepts only one `peer/follow` stream per connection with bounded frames and ordered acknowledgements. No browser or general Session Controller RPC is exposed. See the [deployment reference](../../../../docs/creator/16-jarvis-worker-profile.md).

## Model Experience

[`knowledge-tools.json`](knowledge-tools.json) mirrors the two input schemas served by Jarvis `hub/workertools/handler.go`. `query` is mandatory; the hub also enforces its UTF-8 byte limit. The manifest digest hashes the name-sorted `{name,inputSchema}` entries with recursively sorted JSON keys. Update the version and the reviewed contents digest in `scripts/worker-profile.spec.ts` whenever the model-facing entries change. Only those entries reach the model; remote descriptions and instructions cannot change its prompt. This bundle does not add an auxiliary model request.

## Known Limitations and Deferred Work

The worker serves one configured broker route and does not attest price or privacy. Read-only tools are not OS confinement. Use the job supervisor and verify isolation separately. No invariant companion is needed: the worker registers no separate state projection of the route or tool manifest.
