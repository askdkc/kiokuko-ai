# OpenCode setup

Kiokuko for OpenCode supports one client: OpenCode. Setup does not detect,
configure, clean up, or migrate other clients.

```bash
npm install --global kiokuko-ai
kiokuko-ai setup
```

Setup uses the first available OpenCode config file:

- `opencode.jsonc` when it already exists;
- otherwise `opencode.json`.

It preserves unrelated keys and comments, adds `kiokuko-ai` to the `plugin`
array, and manages the `mcp.kiokuko` entry:

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

The manual example uses the installed `kiokuko-ai` command. The recommended
`setup` flow records the exact package version and absolute Node/CLI paths so
the plugin hook and MCP server use the same installed release. Re-run `setup`
after upgrading the package.

The setup command has no `--clients` option. The current plugin identity is
added once; unrelated plugin entries remain untouched. A malformed or
conflicting `mcp.kiokuko` entry fails closed in JSON, non-interactive, and
dry-run modes. Interactive setup asks before replacing it.

## Plugin hooks

The npm plugin registers one OpenCode hook:

- `session.idle` runs the bounded Enno-Oduno continuation gate;

The plugin uses OpenCode's injected client and repository directory. It does not
start a separate server, write configuration during a hook, or bypass MCP
validation. Restart OpenCode after setup so it reloads the plugin and MCP entry.

## Standard Skills and instructions

Setup places the bundled standard Skills under OpenCode's configuration directory
and updates the global `AGENTS.md` managed block. `kiokuko-ai use` updates a
repository's project-specific `AGENTS.md` block. Human-authored bytes outside
managed markers are preserved. Malformed, duplicated, or modified managed
identities fail closed.

## Verification

Use the read-only checks below after setup:

```bash
kiokuko-ai doctor --json
kiokuko-ai embeddings status --json
```

The Web UI is a local operator surface. It does not replace model-facing MCP
calls or the OpenCode plugin lifecycle.
