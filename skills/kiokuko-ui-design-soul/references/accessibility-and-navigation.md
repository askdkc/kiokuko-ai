<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# `ui.accessibility.v1` — accessibility, focus, and navigation

Select this expert when a flow depends on keyboard order, focus, screen-reader semantics, dynamic status, contrast, motion, dialogs, menus, or navigation continuity.

## Keyboard and focus

Primary functionality must be keyboard-operable where the platform supports it. Verify logical order, visible focus, expected activation keys, Escape behavior, no traps, and sensible focus restoration after dialogs, menus, sheets, or popovers close.

Do not remove focus outlines without an equally visible replacement. Do not move focus merely because content changed; move it only when that helps the next task.

## Semantics and announcements

Prefer native HTML or platform controls. Every interactive element needs a programmatic role and accessible name. Expose values, checked or selected states, expanded state, validation errors, progress, busy state, and material status changes.

Use ARIA only when native semantics are insufficient. Avoid redundant or contradictory attributes. Dynamic announcements must be timely without repeating every incidental update.

## Perception

For Web UI, target WCAG 2.2 AA or the project's stricter standard. Normal text generally needs 4.5:1 contrast, large text 3:1, and meaningful component boundaries or state indicators 3:1 where the criterion applies.

Do not communicate meaning through color, sound, motion, or shape alone. Respect Reduced Motion while preserving equivalent state information. Test zoom, increased text, long values, translated strings, and multiline labels.

## Navigation continuity

Back, browser history, deep links, tabs, modal dismissal, and async completion must preserve a coherent mental model. Closing transient UI should return focus appropriately. Data refresh must not unexpectedly navigate or reset the current item.

## Focused verification

Complete the primary flow keyboard-only, inspect visible focus and focus restoration, check names/roles/status with a screen reader, verify contrast and non-color cues, test 200% text resizing where WCAG applies, and exercise Reduced Motion.
