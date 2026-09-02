<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# `ui.safety.v1` — destructive actions, permissions, and review severity

Select this expert when an interaction can lose data, change permissions, expose privacy-sensitive information, interrupt unsaved work, or block a primary flow.

## User-work preservation

Preserve form values, edits, generated content, selection, cursor, scroll, filters, and completed work through failure, refresh, navigation, and recovery. A technically successful action that loses the user's place is still defective.

Warn about unsaved work only when loss is real. Prefer persistence or recovery over repeated confirmation friction.

## Destructive actions

Prefer Undo for safely reversible operations. Use explicit confirmation when harm is material, recovery is unavailable, or scope may surprise users. Name the action, count or scope, consequence, and destructive button:

```text
Delete 14 documents?
This permanently removes them from this workspace.
[Cancel] [Delete 14 documents]
```

Do not use vague “Are you sure?” dialogs or place destructive actions where common actions are easy to hit accidentally. Do not add confirmation to harmless actions by habit.

## Permissions and privacy

Request permission in context and explain why it is needed. After denial, do not repeatedly trigger the system prompt; explain the unavailable capability and provide a safe Settings route or alternative when one exists. Never imply permission, persistence, encryption, background continuation, or cancellation that the system does not provide.

## Review severity

- **BLOCKER:** data loss, irreversible unintended action, inaccessible or impossible primary flow, privacy/security harm, or indefinite ambiguity about an important action.
- **MAJOR:** invisible async work, duplicate submission, missing recovery, lost input/context, tiny primary target, inaccessible primary operation, hidden mobile functionality, or unprotected destructive behavior.
- **MINOR:** non-critical copy, spacing, motion, or secondary discoverability that does not block or mislead.

Review actual interaction behavior, not screenshots alone. Trace discovery, activation, processing, duplicate/stale execution, success, failure, recovery, preserved work, focus, and supported layouts.

## Focused verification

Test destructive scope and cancellation, Undo or recovery, failed save after editing, navigation with unsaved work, permission denial and repeat entry, privacy-sensitive output, and the complete primary flow. Do not approve with a known blocker.
