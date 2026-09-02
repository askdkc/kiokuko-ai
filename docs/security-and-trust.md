# Security and trust

## Memory and secrets

Kiokuko refuses content that resembles passwords, API keys, tokens, private keys,
or similar secrets. It does not store full conversations. Memory is advisory and
must not override current code, configuration, or execution evidence.

## External Skills

External Skill discovery is reference-only. Kiokuko verifies a source commit, stores
bounded content as an untrusted candidate, and never installs, runs, or registers
fetched Skill content automatically. `official` is the default discovery mode;
`community` is explicit opt-in and `off` disables discovery.

Inspect or manage mappings with:

```bash
kiokuko-ai skills find svelte --official-only --json
kiokuko-ai skills list
kiokuko-ai skills disable <skill-id>
kiokuko-ai skills refresh <skill-id>
```

The Web UI can inspect and disable mappings, but has no install, script, or MCP
registration action.

## OpenCode boundary and public errors

OpenCode receives only the `session.idle` continuation hook. The hook invokes
the package-owned Kiokuko CLI through a bounded subprocess and accepts output
only after trusted-path validation, a successful exit, exact response-shape
validation, and secret screening. Workspace-local binaries and ambient PATH
fallbacks are not eligible execution sources.

Normal public tool failures use `isError: true` with an allowlisted message plus
`structuredContent.code` and `structuredContent.retryable`; only `BACKPRESSURE` may
include bounded `retryAfterSeconds`. Raw stacks, SQL, paths, payloads, and secrets
are not copied into generic errors. Specialized validation and recovery errors retain
only their bounded purpose-specific fields.
