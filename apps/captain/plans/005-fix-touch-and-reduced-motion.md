# 005 — Fix touch feedback and reduced-motion behavior

- **Status**: DONE
- **Commit**: 566fd7b
- **Severity**: MEDIUM
- **Category**: Accessibility; physicality; performance
- **Estimated scope**: 1 file, about 90 lines

## Problem

Hover styles are not gated by pointer capability, decorative placeholder cards match the same hover selector as real cards, most phone controls have no press feedback, and flight-card hover transitions paint gradients, borders, and shadows. Reduced motion then disables every transition and animation globally, removing useful opacity/color feedback instead of only removing movement.

```css
/* src/styles.css:982-988 — current home card */
.agent-home-card.live-agent-card {
  ...
  transition: transform 180ms ease, border-color 180ms ease, background 180ms ease, box-shadow 180ms ease;
}
.agent-home-card.live-agent-card:hover {
  transform: translateY(-2px);
  border-color: rgba(255, 255, 255, 0.28);
  background: linear-gradient(130deg, rgba(14, 20, 31, 0.72), rgba(24, 23, 25, 0.48));
  box-shadow: 0 21px 55px rgba(4, 7, 12, 0.24);
}

/* src/styles.css:1075-1083 — current flight card */
.live-flight-card { transition: transform 180ms ease, border-color 180ms ease, background 180ms ease, box-shadow 180ms ease; }
.live-flight-card:hover { transform: translateY(-2px); ... }
.live-flight-card:active { transform: translateY(0) scale(0.992); }

/* src/styles.css:626-630 — current reduced motion */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
  .agent-orbit { transform: none; }
}
```

## Target

All hover movement lives inside the exact fine-pointer query below. Interactive cards/buttons use transform-only asymmetric press feedback: 160ms deliberate press to `scale(0.97)`, 100ms release. Painted hover properties change immediately rather than transitioning. Decorative placeholders never react to the pointer. Reduced motion preserves 200ms opacity/color feedback while removing position, scale, clip-path, orbit, pulse, and press movement.

```css
/* target shared press feedback */
:is(
  .primary-pill,
  .primary-action,
  .icon-button,
  .settings-button,
  .sort-filter-button,
  .workspace-status-pill,
  .card-icon-action,
  .settings-index-row,
  .check-now-action,
  .live-flight-card
) {
  transition: transform var(--duration-press-out) var(--ease-out);
}

:is(
  .primary-pill,
  .primary-action,
  .icon-button,
  .settings-button,
  .sort-filter-button,
  .workspace-status-pill,
  .card-icon-action,
  .settings-index-row,
  .check-now-action,
  .live-flight-card
):active:not(:disabled) {
  transform: scale(0.97);
  transition-duration: var(--duration-press-in);
}

.agent-home-placeholder { pointer-events: none; }

@media (hover: hover) and (pointer: fine) {
  .agent-home-card:not(.agent-home-placeholder):hover,
  .live-flight-card:hover { transform: translateY(-1px); }
  .workspace-status-pill:hover { transform: translateY(-1px); }
  .card-icon-action:hover { transform: scale(1.02); }
  /* Move every other existing :hover rule into this query unchanged. */
}
```

```css
/* target reduced-motion strategy */
@keyframes reduced-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .agent-orbit,
  .agent-orbit span,
  .status-dot::after,
  .pipeline-row.active > i::after,
  .live-status i::after { animation: none; }
  .fade-up,
  .starting-copy h2 { animation: reduced-fade 200ms var(--ease-out) both; }
  :is(.app-notice, .sheet-backdrop, .workspace-info-backdrop) {
    transition-property: opacity, visibility;
    transition-duration: 200ms, 0s;
    transform: none;
  }
  :is(.bottom-sheet, .workspace-info-sheet) {
    clip-path: none;
    transform: none;
    transition: opacity 200ms var(--ease-out);
  }
  :is(button, [role="button"]):active { transform: none; }
}
```

Closed sheet/notice selectors must still set `opacity: 0`; open selectors must set `opacity: 1`, so reduced-motion users retain state feedback without spatial movement.

## Repo conventions to follow

- All responsive/accessibility media queries live in `src/styles.css` near the base animation definitions.
- Use plan 001 duration/easing tokens, plan 002 pseudo-element selectors, plan 003 sheet selectors, and plan 004 `.app-notice`.
- The app's personality is a crisp professional dashboard; press feedback should be subtle and non-bouncy.

## Steps

1. Execute plans 001-004 first; this plan depends on all of their selectors and tokens.
2. Remove background, border-color, box-shadow, and color from every transition list on home cards, flight cards, status pills, settings buttons, and card icon actions. Those visual states may change immediately; only transform transitions.
3. Add the shared asymmetric press selectors from Target after the component rules so they apply consistently.
4. Change flight-card active scale from `0.992` to `0.97`; ensure the 160ms duration applies only while active and 100ms applies on release.
5. Add `pointer-events: none` to `.agent-home-placeholder`.
6. Move every existing `:hover` rule—icon button, sort/filter, status pills, real home cards, settings button, flight cards, card icon actions, and filter buttons—inside one `@media (hover: hover) and (pointer: fine)` block. Exclude placeholders and reduce card lift to 1px; reduce icon scale to 1.02.
7. Delete the blanket reduced-motion universal selector.
8. Add `reduced-fade` and the exact targeted reduced-motion rules from Target. Extend the sheet/notice selectors as necessary so closed opacity remains 0 and open opacity remains 1 without transform or clip-path movement.
9. Confirm focus-visible outlines remain unchanged and selected/pressed color states still update.

## Boundaries

- Do NOT change control dimensions, labels, focus outlines, selected-state colors, pointer hit areas, or disabled opacity.
- Do NOT add hover motion outside the fine-pointer query.
- Do NOT set all animation or transition durations to zero.
- Do NOT add bounce, springs, layout animation, or a dependency.
- If plans 001-004 are not complete, STOP; do not invent substitute selectors or duplicate tokens.

## Verification

- **Mechanical**: run `pnpm typecheck`, `pnpm test`, and `pnpm build:web`; all must exit 0. Run `rg -n ':hover' src/styles.css` and confirm every result is inside the fine-pointer media query. Run `rg -n '0\.01ms|transition:.*box-shadow|transition:.*background' src/styles.css`; it must return no motion declarations.
- **Feel check**: at 390×844, press every primary action, home card, workspace status pill, settings link, filter button, and flight card.
  - Press must reach `scale(0.97)` over 160ms and release over 100ms.
  - Touch taps must not leave a lifted or recolored hover state.
  - Decorative placeholder cards must never move.
  - With a mouse, card lift must be only 1px and icon scale 1.02.
  - Toggle `prefers-reduced-motion` in DevTools: sheets/notices should still fade over 200ms, while orbit, rings, translation, scale, and clip-path motion disappear.
  - At 10% playback, press and release must be visibly asymmetric without an abrupt final frame.
- **Done when**: hover is pointer-gated, phone controls share transform-only press feedback, placeholder cards are inert, and reduced motion preserves non-spatial feedback.
