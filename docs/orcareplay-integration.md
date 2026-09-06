# OrcaReplay integration

Kiokuko can read bounded trace data from an OrcaReplay store. This document
describes the trust boundary, the read-only input contract, the trace scan CLI
surface, and how stored trace context is delivered to task preparation.

## Trust boundary

`.orca/` is untrusted, read-only input. Kiokuko never writes into `.orca/`:

- the reader opens run directories, `manifest.json`, and `events.jsonl` for
  reading only;
- the scanner probes run directories and reads manifests and event files;
- trace ingestion writes only into the Kiokuko database (cursors, context
  rows, and orchestration jobs), never into the trace store.

The store is treated as hostile input at every boundary. Run IDs must match
`run_[0-9a-f]{6,32}`, run directories must be bounded absolute paths, and event
envelopes are validated field by field. Malformed lines are skipped with
bounded warnings instead of being executed or replayed.

Schema support is strict: only `0.x.y` manifest schemas are readable. A newer
schema is marked `unsupported` so a later Kiokuko release can take over without
silently misreading the store.

## Secret screening

Every trace-derived value passes `findSecretInValue` before it is persisted or
delivered:

- the bounded context projection is checked before its digest and row are
  written;
- memory candidate summaries are checked before a promotion job is enqueued;
- stored context is checked again at delivery time.

A secret-shaped value causes an explicit `SECURITY_REJECTION`; nothing is
persisted and nothing is delivered. This covers context, cursors, job payloads,
and memory candidates, not only event text.

## Trace reader and ingestion

`readOrcaTraceRun` returns a bounded projection: events, warnings, integrity
status, and the maximum sequence. Integrity is `verified`, `mismatch`, or
`unavailable`; a mismatch is reported and never repaired. Event files larger
than the configured byte limit are read as a bounded prefix with explicit
`events_too_large` and `unavailable` integrity.

`ingestTraceRun` turns one run into:

- a stored `orcareplay_trace_context` row (bounded, digest-bound, secret-checked);
- an `orcareplay_trace_cursors` row that advances deterministically;
- a `memory_promotion` orchestration job only when the run ended with
  secret-screened candidates;
- an optional skill search only when the run ended.

Repeated ingestion is idempotent: a cursor at the run's maximum sequence
returns `already_ingested` and writes nothing.

## Trace scan CLI surface

The bounded scanner is exposed through a registered CLI command:

```bash
kiokuko-ai trace scan --project-root /path/to/repo [--max-runs 8] [--json]
```

- `--project-root` is the repository root containing `.orca/runs`;
- `--max-runs` bounds how many runs are probed and enqueued (1-64);
- `--json` emits a JSON envelope.

`kiokuko-ai trace scan` probes the read-only store, records unsupported
schemas, detects lag from the actual maximum sequence (including non-zero and
gapped sequences), and enqueues one `trace_ingestion` job per lagging run
without duplicates. A missing store reports zero scanned and zero enqueued and
changes no behavior. Invalid run limits are rejected, never coerced.

The OpenCode plugin tick runs the same scan through a bounded subprocess:
signature gating, a minimum interval, an in-flight guard, and a timeout. A
timeout kills the subprocess and fails open; a missing store resets the
signature so a later store is picked up.

## Advisory-only delivery semantics

Stored trace context is delivered to task preparation as advisory data only:

```json
{
  "traceContext": {
    "source": "orcareplay",
    "referenceOnly": true,
    "autoInstall": false,
    "autoExecute": false,
    "traceRunId": "run_abcdef123456",
    "digest": "<sha256>",
    "context": { "source": "orcareplay", "summary": { "...": "..." } }
  }
}
```

- `referenceOnly`, `autoInstall`, and `autoExecute` are fixed and always true
  for `referenceOnly` and always false for the two execution flags.
- The newest stored context for the repository's canonical `.orca/runs`
  directory is selected deterministically.
- The digest is verified against the canonical content, the serialized size is
  bounded, and the context is secret-checked again before delivery.
- Malformed stored context fails closed with `INTEGRITY_ERROR`; it is never
  delivered.
- When no stored trace context exists, task preparation output and behavior
  are unchanged: no `traceContext` field and no new warning.
- The delivered context is included in the persisted task context revision so
  later context reads replay the same advisory payload.

## Verification

```bash
npm run typecheck
npm run test:unit
npm run verify:opencode-boundary
```
