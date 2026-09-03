# 役小角(enno-oduno)

![役小角(enno-oduno)](../skills/kiokuko-enno-oduno/enno-oduno.png)

For build, debug, review, and devops work, Enno-Oduno keeps a run-bound loop:

```text
intake → ideal → plan → confirmation → WorkUnit execution → final verification → meditation
```

The loop identifies the current client, resolves Akinator intake, derives and
persists an ideal outcome, and hands a revision-bound plan to Zenki. Zenki divides
changes into cohesive WorkUnits; Goki may execute only approved units. A WorkUnit
has one responsibility, one reason to change, focused checks, and local code/ui/test/
docs/operations routes.

Confirmation displays scope, exclusions, completion criteria, skills, expertise,
commands, and timeouts in user language. It never exposes internal IDs or raw JSON.

If the plan environment is missing or changed, recovery pauses before discovery,
plan persistence, or implementation. The user chooses continue, review, restart, or
cancel. Continuation uses a short-lived route-epoch-bound resume token and one-owner
execution lease; expired leases can be reclaimed safely. Ambiguous active runs are
not rerouted. Before OpenCode compacts an active session, the plugin adds the latest
successful exact run identity, revision, route epoch, and execution lease to the
compaction context so automatic continuation does not have to reconstruct them.
The plugin revalidates root-session, directory, and completed-terminal evidence,
single-flights each session, and confirms deterministic continuation prompts by
messages read-back. API acceptance alone is not reported as delivery, and the
read-back also prevents duplicate delivery after plugin reload.

Final Review first runs approved verifiers with shell disabled and repository-relative
paths. Evidence is bound to the contract revision, mutation revision, verifier
specification, and repository state. `enno_finish` accepts only complete passing
evidence. A failed review returns to Zenki for a new revision; it never resumes Goki
directly. An accepted review enters read-only Oduno meditation, which records
evidence-backed obsolete test/function candidates without deleting them.

At ideal, planning, and final-review phases, the parent host may use three isolated
read-only Advisory Round slots. Kiokuko does not launch advisors; unverifiable slots
are reported unavailable and only the parent submits bounded, identity-free results.
