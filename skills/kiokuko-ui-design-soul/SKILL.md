---
name: kiokuko-ui-design-soul
description: Prevent common UI and UX failures when designing, implementing, or reviewing interactive interfaces. Apply a compact universal interaction contract, then route each UI WorkUnit to one to three versioned expert fragments.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# UI design soul router

## Outcome

Make every interactive action discoverable, operable, perceivable, recoverable, accessible, and coherent across supported sizes and input methods.

Use this Skill for Web, desktop, mobile, touch, keyboard, screen-reader, form, navigation, async, destructive, permission, or other user-facing interaction work. Do not use it for backend-only work.

This file is the mandatory compact UI index. Read it completely, then read only the expert fragments selected for the current component, flow, design decision, or WorkUnit.

## Universal core

A UI action is complete only when the user can:

1. discover and understand it;
2. activate it comfortably;
3. perceive immediate acknowledgement;
4. understand processing, success, and failure;
5. recover without losing work or context;
6. continue through keyboard, touch, pointer, and assistive technology as applicable.

Invisible work is a UI failure. Every reachable state needs defined behavior:

```text
idle -> pressed -> processing -> success | failure | cancelled
```

Add offline, permission-denied, empty, stale, and recovered states when reachable. Preserve input, selection, focus, scroll, navigation, and completed work through failure and rerender. Prevent duplicate and stale actions. Prefer native or semantic controls and the existing product design system. Respect Reduced Motion. Do not imitate Apple visuals; apply platform conventions, Apple HIG decision principles, and WCAG 2.2 accessibility requirements where relevant.

When requirements compete, prioritize safety and data preservation, accessibility, interaction correctness, user context, platform familiarity, performance, visual refinement, then decoration.

## MoE selection contract

Select one dominant expert for each UI component or cohesive user flow. Add at most two more only when the same WorkUnit genuinely crosses those risks. Record a concrete reason for each selection.

In Enno-Oduno plans, declare the `ui` route locally on each interactive
WorkUnit. That route requires at least one `ui.*` expert and one `code.*` expert
because UI behavior is also code behavior; it must not infect sibling test,
docs, or operations units with UI/code requirements. Goki reads the indexes and
only the approved fragment files by default.

Do not read every UI reference “for completeness.” If implementation exposes a new risk, return the WorkUnit for an explicit selection or update the non-Enno working plan before reading the additional fragment.

## Expert index

| Expert ID | Select for | Read |
| --- | --- | --- |
| `ui.interaction.v1` | controls, feedback, targets, success, perceived responsiveness | [interaction-feedback.md](references/interaction-feedback.md) |
| `ui.async.v1` | loading, progress, retry, cancellation, concurrency, offline | [async-recovery.md](references/async-recovery.md) |
| `ui.forms.v1` | forms, validation, uploads, labels, disabled or empty states | [forms-and-controls.md](references/forms-and-controls.md) |
| `ui.accessibility.v1` | keyboard, focus, semantics, screen readers, contrast, motion | [accessibility-and-navigation.md](references/accessibility-and-navigation.md) |
| `ui.layout.v1` | responsive layout, zoom, content growth, platform adaptation | [responsive-and-platform.md](references/responsive-and-platform.md) |
| `ui.safety.v1` | destructive actions, permissions, user-work preservation, severity review | [safety-and-review.md](references/safety-and-review.md) |

Typical selections:

- async Save button: `ui.interaction.v1` + `ui.async.v1`;
- validated settings form: `ui.forms.v1` + `ui.accessibility.v1`;
- responsive navigation: `ui.layout.v1` + `ui.accessibility.v1`;
- delete flow: `ui.safety.v1` + `ui.interaction.v1`.

## Verification

Do not review screenshots alone. Trace actual activation, processing, success, failure, recovery, focus, and responsive behavior. Read [ui-checklist.md](references/ui-checklist.md) only for detailed implementation review or final verification.

Report what was exercised in a running interface, what was inferred from source, and what remains unverified. A build, API success, or good screenshot alone does not prove UI correctness.
