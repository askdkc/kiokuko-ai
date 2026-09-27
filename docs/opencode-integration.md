# OpenCode setup

Kiokuko for OpenCode supports OpenCode only. There is no multi-client detection,
configuration, cleanup, or migration compatibility layer.
This release targets OpenCode `>=2.0.18 <2.1.0` only. To remain on OpenCode v1,
pin `kiokuko-ai@0.1.25` and retain a backup of the matching v1 configuration.

For a v1-to-v2 migration, save the existing configuration, install OpenCode v2,
run `kiokuko-ai setup --dry-run --json`, review any conflicts, then run setup.
Reload or restart OpenCode, run doctor against an explicitly selected server,
and verify an ordinary MCP call and a role dispatch. Rolling back to v1 also
requires restoring the saved v1 configuration.

```bash
npm install --global kiokuko-ai
kiokuko-ai setup
```

Setup uses the first available OpenCode config file:

- `opencode.jsonc` when it already exists;
- otherwise an existing `opencode.json`;
- otherwise create `opencode.jsonc`.

It preserves unrelated keys and comments, adds `kiokuko-ai` to the `plugins`
array with runtime options and fixed-model role templates (see [custom orchestration models](orchestration-models.md#custom-agents)), and manages `mcp.servers.kiokuko`:

```jsonc
{
  "plugins": [{ "package": "kiokuko-ai@0.2.0", "options": {} }],
  "mcp": {
    "servers": { "kiokuko": {
      "type": "local",
      "command": ["kiokuko-ai", "mcp"],
      "disabled": false,
      "environment": { "KIOKUKO_SKILL_DISCOVERY": "official" }
    } }
  }
}
```

The manual example uses the installed `kiokuko-ai` command. The recommended
`setup` flow records the exact package version and absolute Node/CLI paths so
the plugin hook and MCP server use the same installed release. Re-run `setup`
after upgrading the package.

The setup command has no `--clients` option. The current plugin identity is
added once; unrelated plugin entries remain untouched. A malformed or
conflicting `mcp.servers.kiokuko` entry fails closed in JSON, non-interactive, and
dry-run modes. Interactive setup asks before replacing it.

## Plugin hooks

The npm plugin uses OpenCode's event, tool-result, and compaction hooks. The
`session.status` event is evidence, not authority: the plugin re-reads tracked sessions
and the current context, excludes child sessions and other directories, and requires a
completed assistant terminal before running the bounded Enno-Oduno gate.

Reconciliation covers a missing event stream. Work is single-flighted per
repository/session while unrelated sessions remain parallel. Continuation prompts
use a deterministic message ID; an API success is not considered delivered until
the message appears in read-back. Pending send state is persisted in plugin storage;
an ambiguous send is quarantined rather than automatically retried. Disposal stops
new work, aborts supported subprocess operations, and drains callbacks.

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
kiokuko-ai doctor --opencode-url http://127.0.0.1:4096 --json
kiokuko-ai embeddings status --json
```

For a password-protected server, set `OPENCODE_PASSWORD` in the doctor's
environment to that server's password. The password is never included in output.

The Web UI is a local operator surface. It does not replace model-facing MCP
calls or the OpenCode plugin lifecycle.
