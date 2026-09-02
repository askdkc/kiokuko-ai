<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# `ui.forms.v1` — forms, validation, and control states

Select this expert for data entry, validation, uploads, searchable controls, disabled behavior, and empty states.

## Form state

Define:

```text
pristine -> editing -> invalid | submitting -> submitted | failed
```

Use visible labels rather than placeholder-only labels. Make required state understandable without color alone. Validation must identify the affected field and tell users how to fix it without reporting errors prematurely.

Preserve entered values after validation or server failure. After failed submission, guide focus without stealing it unexpectedly. Keyboard submit behavior must be predictable; multiline input must not submit when a newline is expected.

## Submission and uploads

Submitting needs immediate acknowledgement and duplicate prevention. Success must be observable. Failure must retain the form and provide a recovery path.

For uploads show the chosen file, current state, measurable progress, failure and retry, and accurate cancellation semantics. Keep successful uploads when another file fails unless the product contract explicitly makes the batch atomic.

## Disabled and unavailable

A disabled control must look unavailable. If the reason is not obvious, make it discoverable. Do not use low opacity when it makes text illegible, and do not make silent refusal the only explanation. Hiding an action without context is often worse than exposing the requirement near it.

## Empty and loading states

An empty state should say what is absent, why when useful, and the next real action. Loading must not look like empty or broken content. Prefer local placeholders and layout stability over blocking the whole screen for one region.

## Focused verification

Test pristine, partially entered, invalid, keyboard submission, slow submission, server failure, preserved values, focus after error, success, disabled explanation, empty state, and upload retry/cancellation where applicable.
