<!-- KIOKUKO MANAGED STANDARD SKILL: one-shot-software-completion -->

# Discovery and scope

Use when the behavioral requirement, caller graph or patch boundary is unclear.
Keep decisions in the existing plan; a separate document is not required.

## Reconstruct the requirement

- Express the requested result as observable input, action and output. "Add
  pagination" needs an entry point, response shape, ordering, defaults and
  compatibility with existing callers, not just a pagination helper.
- Resolve unspecified choices from a working analog, project instructions and
  conventions, then the framework idiom already used locally. Prefer the least
  disruptive reversible choice and record material assumptions. Explicit user
  requirements outrank inferred conventions.
- Repository evidence cannot answer every ambiguity. Ask when competing
  interpretations materially change the requested result, data, public contract
  or permissions. Complete independent work while a necessary answer is pending.
  Do not treat naming or formatting choices with established defaults as blockers.

## Trace before editing

Follow entry point -> target -> callees/effects -> callers/consumers. Search
changed symbols and serialized field names; the compiler cannot find untyped
fixtures, external consumers or dynamic registrations. Inspect tests and the
actual check commands. Check imports, module state, exports and nearby helpers
in contiguous reads; read the whole file when its contract depends on them.
Avoid recursively reading every transitive dependency without a concrete risk.

Use the closest maintained analog for placement, registration, errors, config,
tests and docs. Recency alone does not make an example correct. Preserve existing
dependency direction and use local validation, HTTP, IDs, retry and test helpers
before adding another implementation or dependency.

## Find the required accompanying changes

From the actual workflow, identify relevant types, validation, serialization,
permissions, flags, UI strings, CLI help/API docs, fixtures, exports, registration,
migrations and generated artifacts. Logging and changelog entries are required
only when the task or repository requires them. For setup and delivery, follow
the artifact to its consumer and reload trigger with `veteran-programmer-skill`.

Example: a new notification provider may require its client/schema, registry
entry and configuration validation. A provider class tested only in isolation
does not prove users can select it.

## Bound and plan the patch

- Include every step required to make the behavior reachable and correct. A
  smaller diff is a tiebreaker between complete solutions.
- Follow changed contracts through types, stored/wire data, callers, fixtures
  and docs. Keep compatibility where consumers cannot change in this patch;
  intentional compatibility aliases are not stale references to remove.
- Fix an adjacent defect when the new behavior depends on it, or isolate the
  new path so it does not spread the defect. Record the choice. Stable pagination,
  for example, may need an ID tiebreaker in an existing shared sort.
- Leave unrelated cleanup alone. A same-file edit or cheap refactor is not by
  itself justification to expand scope. Preserve staged and unstaged user work.
- Record path -> responsibility -> concrete check. Include expected outputs for
  the main path and material failure cases. Order related edits so checks remain
  interpretable, commonly contracts -> implementation -> wiring -> tests/docs.
  Reassess scope if the plan grows; file count alone cannot decide correctness.

Establish focused baseline results when existing failures could obscure the
change. Inspect shared callers before choosing wider checks; preserve exact
commands and results so new failures can be attributed rather than guessed.
