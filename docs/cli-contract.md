# Embedding CLI contract

## JSON envelope

Every CLI command that accepts `--json` emits exactly one JSON line on stdout
wrapped in the shared envelope. Success and error envelopes share the numeric
`version: 1` field; there is no separate string API version:

```json
{ "version": 1, "ok": true, "operation": "recall", "data": {}, "meta": {} }
{ "version": 1, "ok": false, "operation": "record", "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```

`meta` is optional and omitted when empty. Unexpected non-Kiokuko errors are
redacted to `INTEGRITY_ERROR` with no internal details. The envelope is a
human/operator-facing CLI contract; it is not a network API version.

The default global installation is intentionally lightweight:

```bash
npm install --global kiokuko-ai
kiokuko-ai setup
```

This keeps lexical retrieval and the normal setup flow available without the
optional local semantic runtime. To opt into local semantic retrieval, run the
following command. It installs the pinned optional dependencies when needed,
then applies the same client configuration flow as `kiokuko-ai setup`: managed
MCP blocks are updated and registered-project instructions are refreshed.
Unmanaged MCP identities require interactive confirmation before replacement;
non-interactive or `--dry-run --json` runs fail closed without changing them.

```bash
kiokuko-ai embeddings setup
```

`boolean@3.2.0` is an upstream transitive dependency of the Transformers.js
runtime. It is not a Kiokuko dependency and is not present in the lightweight
install. On Linux, the first automatic dependency installation uses sudo
through npm. On macOS it installs into Kiokuko's package-local `node_modules`
instead of the shared npm global prefix; other platforms invoke npm directly.
Do not persist npm script permissions or use `--dangerously-allow-all-scripts`.

`kiokuko-ai embeddings setup` installs the pinned `local-small` preset without a
separate confirmation flag. Automation uses:

```bash
kiokuko-ai embeddings setup --preset local-small --json
```

`--dry-run` performs no download, model load, database write, or filesystem
mutation. `--offline` uses only an existing verified installation. `--replace`
allows switching profiles. `status --json` reports bounded coverage and model
state; `repair` restores the same pinned artifact without destructive cleanup.

## Project instruction repair

`setup` and `embeddings setup` refresh every registered live project's configured
agent file. They release the global configuration lock before acquiring each
project's file lock, and verify the binding and managed block after actual writes.
A dry-run reports planned actions without claiming that files were repaired.
Human text outside a valid Kiokuko block is preserved. Missing files/blocks and
outdated instructions can be repaired; malformed boundaries, unsafe paths, or
conflicting identities require explicit correction.

Both commands return `data.ok: false` and exit **9** when project repair is
incomplete. The JSON envelope can still have `ok: true`: it means a result was
returned, not that every repair succeeded. `setup` includes `projectAgentHealth`;
`embeddings setup` includes `projectSetup.health`. Per-project results remain in
`projectAgentFiles` (under `projectSetup` for embeddings), including available
findings. Human output lists unresolved paths and reasons. Successful semantic
activation can coexist with incomplete project instruction repair.

`doctor` reports each affected path in `data.checks.agentFiles.findings`, with a
constant `reason` and a `repair` classification (`setup`, `manual`, or
`remove_missing_location`). It uses the same binding and marker validation as
project repair, including marker ordering and template versions. Missing roots
remain owned by the separate `bindings` check. To inspect repair plans and diagnostics:

```sh
kiokuko-ai setup --dry-run --json | jq '.data.projectAgentFiles'
kiokuko-ai doctor --json | jq '.data.checks.agentFiles'
```

## OrcaReplay trace commands

| Command | Responsibility |
| --- | --- |
| `trace scan --project-root <capture cwd> --max-runs 8 --json` | Bounded discovery and job scheduling; not ingestion completion. |
| `trace sync --capture-cwd <path> [--run <id>] [--rebuild] [--timeout-ms 120000] --json` | Drain this store's trace jobs and report complete/live/partial state. |
| `trace status --capture-cwd <path> --json` | Read location, progress, integrity and constant diagnostics. |
| `trace record [--sync-timeout-ms 120000] -- [OpenCode arguments]` | Run Orca with inherited terminal streams, then synchronize after it closes. |

Interactive setup offers `alias orca-opencode='kiokuko-ai trace record --'` at
an explicitly confirmed absolute rc path. See [OrcaReplay integration](orcareplay-integration.md)
for budgets, migration, isolation and recovery. `trace record` does not capture
or rewrite child stdout into a JSON envelope.
