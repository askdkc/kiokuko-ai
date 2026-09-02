<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# `ui.interaction.v1` — controls and perceivable feedback

Select this expert when users activate buttons, links, menus, tabs, toolbars, gestures, list rows, or other controls.

## Interaction contract

Every activation must produce immediate perceivable acknowledgement before slow work completes. A network request or callback beginning in the background is not feedback.

Use the lightest truthful signal:

- pressed or active state for immediate actions;
- changed label, local spinner, status, or optimistic state for perceptible delay;
- visible navigation or content change when the result is self-evident;
- accessible status text when visual change alone is ambiguous.

Do not force a second click merely to discover whether the first worked. Clear busy and disabled states after success or failure. Avoid noisy success toasts when the result itself is obvious.

## Controls and targets

Prefer native or semantic controls. Labels should predict the action: “Save changes” or “Delete project” is stronger than “OK.”

Judge the effective hit target, not icon artwork. Use platform defaults first. On touch-oriented Web UI, aim around 44×44 CSS px when practical; WCAG 2.2's 24×24 criterion is a floor with exceptions, not the general design target. On Apple platforms prefer standard control sizes; do not shrink ordinary controls to the minimum.

For icon-only controls provide an accessible name, enough context, an expanded target, and pointer discoverability such as a tooltip when useful. Essential actions must not depend on hover or a precision gesture.

## Locality and context

Keep feedback near the initiating control or affected content. Block duplicates of the same operation without disabling unrelated areas. Preserve selection, focus, scroll, cursor, filters, and current item through local updates.

## Focused verification

Exercise pointer, keyboard, and touch when supported. Verify visible focus, immediate acknowledgement, target size and spacing, duplicate activation, success visibility, and the user's retained context after rerender.
