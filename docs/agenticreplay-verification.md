# AgenticReplay pipeline verification

The active integration uses the `agenticreplay` package and executable, and reads
`.agenticreplay/runs`. The upstream contract is
[askdkc/AgenticReplay](https://github.com/askdkc/AgenticReplay).

## Deterministic checks

```sh
node scripts/run-tests.mjs tests/unit/agentic-replay-setup.test.ts tests/unit/agenticreplay-migration.test.ts tests/unit/agentic-trace.test.ts tests/unit/trace-ingest.test.ts tests/unit/trace-scan.test.ts tests/unit/trace-advisory-delivery.test.ts tests/integration/agenticreplay-pipeline.test.ts tests/integration/trace-pipeline-boundaries.test.ts
npm run typecheck
npm test
npm run build
npm run verify:opencode-boundary
npm run pack:check
```

The CLI pipeline fixtures check argument forwarding, standalone OpenCode invocation,
child-exit finalization, cumulative import, integrity, interruption and advisory
delivery. Alias migration fixtures preserve human content and reject conflicts.
Migration 010 creates independent active tables; migrations 003 and 004 and their
legacy rows remain unchanged. Pending legacy trace work is retired.

## Opt-in external CLI checks

```sh
KIOKUKO_TEST_AGENTICREPLAY=/absolute/path/to/agenticreplay node scripts/run-tests.mjs tests/integration/agenticreplay-real-cli.test.ts
KIOKUKO_TEST_AGENTICREPLAY=/absolute/path/to/agenticreplay OPENCODE_BIN=/absolute/path/to/opencode npm run test:e2e:opencode:agenticreplay
```

The real-recorder contract pins AgenticReplay 0.1.2 and uses a fake OpenCode child.
The host E2E requires OpenCode 2.0.18 and a real AgenticReplay executable, with a
local provider fixture. These checks require loopback access. They do not require
paid provider calls or modification of personal configuration.
The ordinary suite skips the real-recorder test unless its executable is supplied.
A fixture pass does not prove a live recorder or installed host pass. Earlier
OrcaReplay verification results are not AgenticReplay acceptance evidence.
