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
