# Getting started

## Install and configure

Node.js 24.16.0 or newer is required. Install and configure in two commands:

```bash
npm install --global kiokuko-ai
kiokuko-ai setup
```

Setup configures OpenCode automatically; `--clients` is not supported.
`--dry-run --json` validates and reports planned changes without writing.
`--no-standard-skills`, `--skill-discovery off|official|community`, and
`--enno-oduno ask|on|off` control optional setup behavior.

Setup owns the `kiokuko` MCP entry in OpenCode's `opencode.json` or `opencode.jsonc`
and adds the npm plugin to the `plugin` array:

```jsonc
{
  "plugin": ["kiokuko-ai"],
  "mcp": {
    "kiokuko": {
      "type": "local",
      "command": ["kiokuko-ai", "mcp"],
      "enabled": true,
      "environment": { "KIOKUKO_SKILL_DISCOVERY": "official" }
    }
  }
}
```

This is the minimum manual configuration. `kiokuko-ai setup` is preferred: it
pins the plugin version and writes the same absolute Node/CLI runtime pair for
the plugin hook and MCP server.

Unrelated settings and comments are preserved. Changed values, duplicate plugin
identities, extra MCP fields, or another unmanaged `kiokuko` identity are conflicts
and are never silently overwritten. Interactive setup asks before replacing a
conflict; JSON, non-interactive, and dry-run calls return `CONFLICT` without mutation.

Setup refreshes only supported Kiokuko project instructions. Valid newer templates
and DSH-owned blocks are reported as preserved, without rewriting their files or
bindings. Malformed markers, unreadable paths, and identity mismatches remain errors.
Repeated setup keeps the configured discovery mode and recognizes an already
installed OrcaReplay integration with its managed alias.

Restart OpenCode after setup. Use `kiokuko-ai doctor --json` to inspect runtime,
database, and OpenCode MCP health; doctor is read-only.

## Local semantic search

`kiokuko-ai setup` configures OpenCode and installs, verifies, and activates the
local semantic search model. The first run may download runtime packages and model
weights; later runs reuse the verified installation. No second setup command is
needed. Use `--no-embeddings` to skip model preparation without disabling an existing
profile. `embeddings setup` remains a compatibility entry point for the same
installation flow, without optional integration prompts.

For an already installed runtime and verified local model:

```bash
kiokuko-ai setup --offline
kiokuko-ai embeddings status --json
```

`--replace` switches from another active embedding profile. `--dry-run` performs no
download or mutation; `--json` is suitable for automation and fails closed on an
unmanaged MCP identity. Non-dry-run embedding setup acquires its setup lock before
checking or installing optional runtime packages, so concurrent setup processes do
not run package installation or client/database mutations in parallel.

## Web UI and clients

Run `kiokuko-ai web` and open `http://127.0.0.1:4173`. The UI is local-only and is a
human/operator management surface, not a substitute for model task-entry MCP calls.
When Enno-Oduno is enabled, the OpenCode plugin handles bounded continuation through
`session.idle` hook.
