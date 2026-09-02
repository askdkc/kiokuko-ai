# Semantic retrieval

Lexical retrieval works in the lightweight install. Semantic retrieval is an
optional local `local-small` embedding profile.

```bash
kiokuko-ai embeddings setup
kiokuko-ai embeddings status --json
kiokuko-ai embeddings repair
```

Setup installs only the pinned runtime and verifies every artifact before loading
it. `--offline` requires an already verified local installation; `--dry-run` does
not download, write, or change the active profile; `--replace` switches from a
different active profile. Model weights are not included in the npm package.

The command also runs the normal OpenCode setup flow: managed MCP blocks and
project instructions are refreshed.
An unmanaged or tampered identity requires interactive confirmation; JSON,
non-interactive, and dry-run automation fails closed with no configuration change.

If the local runtime, model, or vectors are unavailable, lexical retrieval remains
usable. `status` and `doctor --json` expose coverage and health.
Embedding configuration is stored in SQLite, not environment variables. Platform-
specific runtime installation details and allowlists are kept in the implementation
references and release checks.
