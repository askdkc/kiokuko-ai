# Source investigation with ripwire

Optional ripwire 0.4.0 provides ranked definitions, callers/callees and test
candidates. It is navigation evidence, not proof that a change is safe. Automatic
Enno use remains disabled until the repository acceptance evaluation passes.

```bash
kiokuko-ai source setup
kiokuko-ai source status
kiokuko-ai source inspect --task "Inspect model selection failures" --query "readExecutionRouting" --json
kiokuko-ai source configure --mode off
kiokuko-ai source configure --mode auto --binary /absolute/path/to/ripwire
kiokuko-ai source configure --managed
```

Only `source setup` downloads anything: checksum-pinned macOS/Linux arm64/x64
assets, binary and license only. No upstream skills, agent settings, shell files,
repository binding, PATH discovery, automatic upgrade or source build is involved.
Installation is atomic and preserves an existing installation on failure. An
interrupted setup may leave `source-context/setup.lock`; confirm no setup is
running before removing that empty directory and retrying.

Configuration lives at `<Kiokuko data directory>/source-context/config.json`;
`KIOKUKO_DATA_DIR` overrides the data directory. Fields: `mode` (`auto`/`off`),
optional absolute `binaryPath`, `timeoutMs` (100–10000, default 10000), `maxTokens`
(256–8000, default 4000), `maxOutputBytes` (1024–32768, default 32768). Unknown
fields are rejected. `auto` neither installs nor bypasses acceptance. Doctor
reports source availability separately from database health. `inspect` exits 2
when unavailable; degraded usable results exit 0.

## Shared interface and execution

MCP `source_context({cwd, task, query?, maxTokens?})` calls the CLI's shared service
without opening the memory database. `cwd` must be absolute in a Git repository.
The original task is bound to the input digest; `query` can use code identifiers
to improve a Japanese or conceptual search. No translation model is launched.

Results contain relative locations, limited bodies, related symbols, test
candidates, omissions, digests, duration and received bytes. Raw stderr is not
returned. Test commands are untrusted suggestions and never executed. Unknown
output formats are rejected. Empty tests or absent edges never mean verified.
Calls without a target path are returned as `unresolvedCallees` names/signatures,
not resolved file locations.

After acceptance, the OpenCode parent enriches only ideal/Zenki dispatch. It
validates identity and models before investigation, rechecks them afterward,
then records the augmented prompt digest. Results are reused only in parent
memory with identical source content/input; compaction/deletion clears them.
Ordinary work stays explicit. Fixed advisor contexts/digests are unchanged: v1
does not forward source bundles to those rounds. No source text enters SQLite.

## Limits

- Git-selected regular source files, including uncommitted/untracked files and
  tests, are copied into a private temporary analysis directory. Links,
  submodules, special files, private tool directories, `.env*`, credential-shaped
  source, files over 2 MiB and unsupported extensions are excluded and disclosed.
- The parser never receives the live tree or its Git configuration. Copying uses
  no-follow file reads and parent resolution checks. This is not an OS sandbox
  against a malicious process racing parent-directory replacements.
- Copying and both source snapshots count toward the deadline. Changed source
  invalidates a result. Git history, ripwire notes and document converters are
  absent from the copy. v0.4.0 JSON lacks full parse health and edge confidence;
  usable results remain `degraded` with unknowns explicitly represented.
- Index blobs in `source-context/cache` can contain source text. Keep this
  directory private. Old blobs can be removed with no investigation running.
  Temporary source copies are removed when a call finishes.
- Raw stdout is capped at 256 KiB, stderr at 16 KiB and returned JSON at 32 KiB.
  Whole bodies/rows are removed with disclosure when needed. Caller cancellation
  terminates the process group and propagates; timeouts/missing binaries permit
  ordinary investigation. Path/permission failures reject the source operation.

## Reproduce validation

```bash
KIOKUKO_TEST_RIPWIRE=/absolute/path/to/ripwire npm run test:source
npm run build
KIOKUKO_TEST_RIPWIRE=/absolute/path/to/ripwire node scripts/evaluate-source-context.mjs /tmp/source-evaluation.json
```

Twelve English/Japanese prompts cover six subsystems. Gold is scoring-only.
Both strategies use the same literal search terms and first eight sorted files;
ripwire adds reads for files without relevant returned definitions. All search,
context and supplemental bytes/tokens count, using js-tiktoken 1.0.21/cl100k_base.
Timing includes copying and snapshots; tokenizer time is excluded from both.
This is deterministic localization, not agent task completion. Baseline runs
first, OS caches are not flushed, and the bilingual paired sample is small.

Automatic use requires maintained recall, 30% median token reduction, no increase
in median warm latency and no false verification claims. Only a reviewed passing
report can justify changing `SOURCE_AUTO_ACCEPTED`; configuration cannot enable it.

The [2026-09-08 macOS arm64 evaluation](source-context-evaluation.json) failed
acceptance. Supplemental recall was maintained and median total tokens fell
40.0%, but warm median time increased from 10.5ms to 408.6ms. Explicit calls
remain available; automatic dispatch stays disabled. Reduction uses the ratio of
the two token medians; the median of paired ratios is also recorded separately.
The report binds the source digest before adding the report itself and does not
establish performance on other machines.

The [follow-up protocol (Japanese)](source-context-followup.ja.md) and
[parent-reuse measurements](source-context-reuse-evaluation.json) separate local
retrieval latency from model-reported usage and plan quality. The LLM pilot is
explicit, uses a reviewed frozen source manifest and never changes the automatic-use gate.

Upstream: [release](https://github.com/redhat-et/ripwire/releases/tag/v0.4.0),
[fixed CLI contract](https://github.com/redhat-et/ripwire/blob/v0.4.0/docs/COMMANDS.md).
