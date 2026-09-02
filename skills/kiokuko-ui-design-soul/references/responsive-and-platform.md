<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# `ui.layout.v1` — responsive behavior and platform adaptation

Select this expert for breakpoints, multi-pane collapse, viewport overlays, safe areas, touch/pointer adaptation, content growth, or cross-platform behavior.

## Functional responsiveness

Responsive design must preserve capability, not merely eliminate horizontal overflow. At each supported size verify:

- the primary action remains visible or readily reachable;
- navigation remains understandable;
- important information is not silently removed;
- controls remain discoverable and comfortable;
- overlays fit the viewport;
- fixed bars do not cover content;
- safe areas are respected;
- current selection and navigation context survive layout changes.

If a desktop multi-pane layout collapses to one pane, preserve the current item and provide a clear route back. Do not simply remove desktop functionality on mobile without an intentional replacement.

## Content growth

Test increased text, browser zoom, long data, translations, dynamic content, and multiline labels. Avoid fixed heights that clip required content. Truncation must not hide information needed to complete the task.

## Platform conventions

Use the existing product design system and adapt interaction to the target platform:

- Apple platforms: native controls, standard navigation, accessibility behavior, keyboard/pointer conventions, and normal control sizes;
- Web: semantic HTML, browser behavior, WCAG 2.2, responsive URL-aware navigation, pointer, touch, and keyboard;
- cross-platform: preserve product identity without forcing identical behavior where platform expectations differ.

HIG principles are decision filters, not a request for iOS styling on the Web.

## Focused verification

Exercise the narrowest and widest supported layouts with real and long content, touch and pointer when applicable, zoom or dynamic type, overlays near viewport edges, orientation or pane changes, and context preservation across breakpoint transitions.
