<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# UI design and review checklist

Last reviewed against the official sources: 2026-08-22.

This checklist paraphrases decision principles. It does not reproduce Apple text or require Apple-styled visuals.

## Eight-principle map

| Principle | Practical question |
| --- | --- |
| Purpose | Does every important element help the user complete the primary task? |
| Agency | Can the user understand, initiate, interrupt where safe, and recover from actions? |
| Responsibility | Does the interface protect privacy, attention, safety, and user-created work? |
| Familiarity | Do labels, controls, navigation, and feedback follow the target platform's conventions? |
| Flexibility | Does the flow adapt to ability, input method, device, content size, and context? |
| Simplicity | Is the next meaningful action clear without hiding necessary information or control? |
| Craft | Are states, spacing, copy, timing, focus, and edge cases implemented consistently? |
| Delight | Does successful, calm, recoverable use feel better because the details work together? |

## State coverage

For each primary action, verify the applicable states:

- **Actionable:** the label predicts the result; enabled and disabled states are distinguishable without color alone.
- **Pressed and focused:** feedback is immediate; keyboard focus is visible; focus order follows the task.
- **Processing:** status remains near the initiating control; duplicate submission is prevented without trapping the user.
- **Progress:** measurable work uses a determinate value; unmeasurable work uses an indeterminate indicator and an accessible status message.
- **Long or stalled work:** expectations are updated; a reason and next step are shown; cancellation is available only when it is safe and real.
- **Success:** completion is perceivable visually and programmatically; the interface moves focus only when that helps the next task.
- **Empty:** the state explains what is absent and offers a relevant next action rather than presenting a dead end.
- **Failure:** input and completed work are retained; the message says what happened in actionable language; retry, undo, or back is available where meaningful.
- **Offline:** unavailable behavior is explicit; queued or local work is not implied unless it is actually preserved.
- **Permission denied:** explain the missing capability and provide a safe route to settings, an alternative, or back.
- **Destructive:** communicate scope and consequence; prefer undo for reversible actions and use explicit confirmation for material irreversible harm.
- **Recovered:** clear stale errors and busy states; restore a coherent focus position; avoid re-running the action unexpectedly.

## Accessibility and adaptation

- Use semantic HTML or native controls before recreating their behavior.
- Verify the full primary flow with keyboard only, including visible focus and escape from overlays.
- Verify names, roles, values, errors, progress, and status announcements with a screen reader.
- Test touch, pointer, keyboard, and relevant alternate input; do not require hover, precise pointing, or a single gesture.
- Test narrow and wide layouts, zoom or text resizing, longer translated copy, and dynamic content.
- Do not encode meaning with color, motion, shape, or sound alone.
- Respect Reduced Motion and provide equivalent state information without animation.
- Keep time limits adjustable or avoid them unless the task itself requires one.
- On the web, apply the existing design system and WCAG 2.2; do not imitate iOS merely because these principles originated in Apple HIG.

## Async-action spot check

For a save, upload, generation, import, or other asynchronous action, confirm:

1. Press or focus feedback is immediate.
2. The busy state names the ongoing action and blocks accidental duplicates.
3. Progress type matches what the system can measure.
4. Cancellation has defined semantics and leaves data consistent.
5. Success and failure are announced in the same task context.
6. A failure keeps user input and provides a tested recovery path.

## Official sources

- Apple Human Interface Guidelines — Design principles: https://developer.apple.com/design/human-interface-guidelines/design-principles
- Apple Human Interface Guidelines — Buttons: https://developer.apple.com/design/human-interface-guidelines/buttons
- Apple Human Interface Guidelines — Loading: https://developer.apple.com/design/human-interface-guidelines/loading
- Apple Human Interface Guidelines — Progress indicators: https://developer.apple.com/design/human-interface-guidelines/progress-indicators
- Apple Human Interface Guidelines — Feedback: https://developer.apple.com/design/human-interface-guidelines/feedback
- Apple Human Interface Guidelines — Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- Apple Human Interface Guidelines — Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility
- W3C Web Content Accessibility Guidelines 2.2: https://www.w3.org/TR/WCAG22/
