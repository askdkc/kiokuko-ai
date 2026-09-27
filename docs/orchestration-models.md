# Orchestration models

[日本語](orchestration-models.ja.md) · [README](../README.md#add-an-orchestration-model)

`task_prepare` retrieves memory once. New runs store a pending execution choice without
creating an Enno draft. `task_execution_select` commits ordinary work, cancellation,
or a complete five-role configuration. The selected configuration belongs to the run,
not to a global current model. Follow-ups, compaction and restart keep that selection.
Existing active runs without a selection record continue under the legacy protocol.

## Setup and presets

Both setup commands use the same configuration renderer. Use `--enno-oduno ask`
(default), `on`, or `off`. `on` still asks for a configuration per request; `off` starts
ordinary work directly. `--dry-run --json` previews planned writes. Existing effective
JSON/JSONC files, `OPENCODE_CONFIG` (an absolute JSON/JSONC file), and
`OPENCODE_CONFIG_DIR` (an absolute directory) take precedence over the new-install
`~/.config/opencode/opencode.jsonc` path. Comments outside changed managed values,
authentication, other plugins, provider definitions, and custom agents are retained.
Managed agents edited by the user are preserved too. Concurrent edits produce a
conflict rather than overwriting the newer file.

| Preset ID | Provider | ideal / zenki / check | gokiHead | gokiWorker |
|---|---|---|---|---|
| `openai` | `openai` (OpenAI / ChatGPT connection) | `gpt-6-astra` | `gpt-5.6-sol` | `gpt-5.6-luna` |
| `zen-openai` | `opencode` | `gpt-6-astra` | `gpt-5.6-sol` | `gpt-5.6-luna` |
| `zen-glm` | `opencode` | `glm-5.3` | `glm-5.3` | `glm-5.3-flash` |
| `go-glm` | `opencode-go` | `glm-5.3` | `glm-5.3` | `glm-5.3-flash` |
| `go-qwen` | `opencode-go` | `qwen3.8-max` | `qwen3.8-max` | `qwen3.8-flash` |
| `openrouter-glm` | `openrouter` | `z-ai/glm-5.3` | `z-ai/glm-5.3` | `z-ai/glm-5.3-flash` |
| `openrouter-qwen` | `openrouter` | `qwen/qwen3.8-max-0902` | `qwen/qwen3.8-max-0902` | `qwen/qwen3.8-flash` |

DeepSeek V4 Flash is also a worker candidate for Zen, Go and OpenRouter (the latter
uses `openrouter/deepseek/deepseek-v4-flash`). These are template definitions, not a
promise of subscription access. OpenCode's live provider catalog must confirm the
exact model ID, connection and tool-call support before selection. Unknown or
unavailable models remain unavailable; Kiokuko never guesses a replacement ID.
No paid provider request is made by setup. Actual account authorization, quota and
provider errors are only known at invocation and require explicit reselection,
ordinary work, or cancellation. The fixture tests do not certify paid subscriptions.

Agents are shared across presets when role, provider and model match. They are named
`kiokuko-<role>-<provider>-<model>` with `/` replaced by `-` in the agent name. Model IDs
retain their `/` separators. Setup adds `experimental.subagent_depth: 2` only when absent; an explicit
smaller value is preserved and makes the Goki head unavailable with an explanation.

<a id="custom-agents"></a>
## Custom agents

The [README worker example](../README.md#add-an-orchestration-model) includes both the
agent definition and registration. Copy a generated agent for the desired role under
a unique name, change `model` to an ID confirmed by `opencode models`, and preserve
its prompt and permission envelope. Register names explicitly in the options object
of the existing Kiokuko `plugins` entry:

```jsonc
{
  "orchestration": {
    "mode": "ask",
    "customAgents": {
      "ideal": ["my-ideal"],
      "zenki": ["my-planner"],
      "gokiHead": ["my-coordinator"],
      "gokiWorker": ["my-worker", "my-second-worker"],
      "check": ["my-reviewer"]
    }
  }
}
```

Define every listed name under OpenCode's `agents` object. Different roles can use
different connected providers, including a custom worker with an otherwise standard
preset. Restart OpenCode after editing. Start a new request, choose Enno and a preset,
then replace individual roles with registered candidates. Names are case-sensitive.
Unrelated agents are never discovered by name guessing. Custom names and definitions
are user-owned and are not removed or overwritten by setup.

## Delegation and permissions

The parent calls native `subagent` with the selected `agent` and `model`. It checks the run,
selection revision, phase, agent definition digest and current model availability
before dispatch. The parent retains the run identity, revisions and WorkUnit lease,
awaits each role result, and submits existing Enno MCP reports. Goki head receives
the selected worker descriptor and delegates one level deeper. Fresh child sessions
are required; reusing `sessionID` or background role dispatch is rejected. Recorded
invocations prevent exact prompt replay after an uncertain or completed call.

All role templates use `mode: "subagent"` and default-deny permissions. Common allowed
tools are `read`, `glob`, `grep`, `list`, and `skill`. `ideal`, `zenki`, and `check`
allow neither mutation, shell execution nor delegation. Goki head permits `subagent`
and no mutation; the plugin restricts it to the selected worker for the current run.
Worker additionally permits `edit` and `shell`, and denies `subagent`. All deny `kiokuko_*`;
only the parent writes Enno reports. `external_directory` remains `ask`. This is an
OpenCode tool permission envelope, not an operating-system sandbox for worker shell
commands. Keep the approved WorkUnit scope and existing path/lease checks.

For predictable validation, a custom role must retain the exact final ordered
permission block. OpenCode may prepend host defaults; additional rules after the
Kiokuko block or changes to that block make the candidate unavailable. Do not weaken
a read-only template to perform worker duties. Final
verifiers run through the parent's `enno_verify_prepare` before dispatching `check`;
the check agent reviews the resulting evidence.

## If a candidate is missing or unavailable

- Confirm the exact agent name exists, `mode` is `subagent`, `disable` is not true,
  and the same name is listed under the desired `customAgents` role.
- Confirm a full `provider/model` and a connected provider in `/connect` and `/models`.
  `provider_disconnected`, `model_missing`, `tools_unsupported`, and `catalog_unavailable`
  identify which check failed. A catalog listing is not proof of quota or billing access.
- For `permissions_invalid`, copy the current role template's permissions again.
  For `depth_insufficient`, deliberately raise `subagent_depth` to at least 2.
- Restart OpenCode after changes. A changed model, prompt or permission invalidates
  an existing selection; explicitly select again before dispatch.
- After an interrupted call, inspect its child result before retrying. A started
  dispatch receipt is retained across restarts. Stop or report any active WorkUnit
  before changing configuration; active leases prevent switching underneath a worker.
- Model errors do not silently fall back. The parent offers a registered alternative,
  ordinary work, or cancellation. Leaving an already started orchestration cancels
  that orchestration; return to Enno with a new logical request.

Native questions and MCP call order are model-driven. Kiokuko supplies the selection
instructions and enforces registered role dispatch; it cannot guarantee a model will
ask the question or obey every workflow instruction. Normal work remains available
when Kiokuko itself is unavailable.

## Verification coverage

The packaged host test runs against OpenCode **2.0.18** with an isolated
OpenAI-compatible fixture provider. It verifies package plugin activation, MCP
connection, one durable continuation receipt, and an `ideal` subagent dispatch
whose child session and actual model are checked before completion is recorded.
Other role, permission, provider-error, and restart cases are exercised by
unit/integration fixtures; they are not certified as live-host behavior here.

Unit/integration coverage includes ordinary execution without a draft, idempotent
selection, independent concurrent configurations, compaction choice retention,
legacy-run migration, both setup paths, JSONC comments, dry-run and conflict checks.
CI is configured to run the pinned 2.0.18 host test on Linux and macOS.

**Live OpenAI/ChatGPT, OpenCode Zen, OpenCode Go and OpenRouter accounts have not been
tested.** In particular, the presets do not certify account entitlement, subscription
model availability, provider billing, or production model behavior.

```bash
npm run typecheck
npm test
npm run verify:opencode-boundary
OPENCODE_BIN=/absolute/path/to/opencode npm run test:e2e:opencode:execution
OPENCODE_BIN=/absolute/path/to/opencode npm run test:e2e:opencode:host
```
