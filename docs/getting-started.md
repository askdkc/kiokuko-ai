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
`--enno-oduno on|off` control optional setup behavior.

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

Restart OpenCode after setup. Use `kiokuko-ai doctor --json` to inspect runtime,
database, and OpenCode MCP health; doctor is read-only.

## Embeddings setup

`kiokuko-ai embeddings setup` installs the pinned local semantic runtime and runs the
same client configuration flow as `kiokuko-ai setup`, including conflict confirmation,
managed MCP replacement, and registered-project instruction refresh.

```bash
kiokuko-ai embeddings setup --preset local-small --offline
kiokuko-ai embeddings status --json
```

`--replace` switches from another active embedding profile. `--dry-run` performs no
download or mutation; `--json` is suitable for automation and fails closed on an
unmanaged MCP identity.

## Web UI and clients

Run `kiokuko-ai web` and open `http://127.0.0.1:4173`. The UI is local-only and is a
human/operator management surface, not a substitute for model task-entry MCP calls.
When Enno-Oduno is enabled, the OpenCode plugin handles bounded continuation through
`session.idle` hook.
