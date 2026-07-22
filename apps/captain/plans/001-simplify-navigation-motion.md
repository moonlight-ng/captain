# 001 — Simplify navigation motion and establish tokens

- **Status**: DONE
- **Commit**: 566fd7b
- **Severity**: HIGH
- **Category**: Purpose & frequency; cohesion & tokens
- **Estimated scope**: 2 files, about 35 lines

## Problem

Every screen receives the same 340ms entrance, including settings, back navigation, workspace opening, and flight details opened with Enter or Space. Frequently switched workspace and settings panels add a second 280ms child entrance. The result is repeated, non-directional motion and keyboard-triggered motion.

```css
/* src/styles.css:957 — current */
.screen { animation: screen-enter 340ms cubic-bezier(0.22, 1, 0.36, 1) both; }

/* src/styles.css:624 — current */
.fade-up { animation: fade-up 280ms ease both; }

/* src/styles.css:345 — current */
.starting-copy h2 { margin: 0; font-size: var(--type-body); font-weight: 570; letter-spacing: -0.025em; animation: fade-up 360ms ease both; }
```

```tsx
// src/App.tsx:503,511,580,585,589,598 — current class usage
<section className="saved-view fade-up">
<section className="browse-view fade-up">
return <div className="settings-index fade-up">…</div>;
return <div className="settings-section fade-up">…</div>;
<div className="flight-detail-hero fade-up">…</div>

// src/App.tsx:542 — current keyboard path
onKeyDown={(event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    props.onOpen();
  }
}}
```

## Target

Add shared motion tokens to `:root`, remove the global screen entrance, and remove repeated entrances from high-frequency workspace/settings/detail paths. Retain a single opt-in 180ms entrance for rare explanatory content and a 220ms startup-stage entrance.

```css
/* target additions in src/styles.css :root */
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
--duration-press-out: 100ms;
--duration-press-in: 160ms;
--duration-ui: 180ms;
--duration-sheet: 240ms;
--duration-sheet-exit: 160ms;

/* target */
.fade-up { animation: fade-up var(--duration-ui) var(--ease-out) both; }
.starting-copy h2 { animation: fade-up 220ms var(--ease-out) both; }
```

There must be no `.screen` animation and no `screen-enter` keyframes. Workspace tab content, settings panels, and flight-detail hero must not carry `fade-up`. Keyboard opening a flight detail must therefore be immediate.

## Repo conventions to follow

- Global visual tokens already live in `src/styles.css:1-24`; add motion tokens there rather than creating another stylesheet.
- Predetermined motion is implemented in CSS; React components only opt in through class names.
- Keep the purposeful first-run orbit in `src/styles.css:340-343` unchanged.

## Steps

1. In `src/styles.css`, add the exact easing and duration tokens shown above to `:root` after the existing visual tokens.
2. Delete `.screen { animation: screen-enter … }` at current `src/styles.css:957` and delete `@keyframes screen-enter` at current `src/styles.css:1227-1230`.
3. Change `.fade-up` to `animation: fade-up var(--duration-ui) var(--ease-out) both`.
4. Change `.starting-copy h2` to `animation: fade-up 220ms var(--ease-out) both`.
5. In `src/App.tsx`, remove `fade-up` from `saved-view`, `browse-view`, `settings-index`, both `settings-section` instances, and `flight-detail-hero`. Keep it on the brief/review explanatory headings.
6. Do not add input-modality state. Removing the global/detail animation is the keyboard-safe solution.

## Boundaries

- Do NOT change screen routing, browser history, API calls, startup stage timing, or component markup.
- Do NOT add a motion dependency.
- Do NOT alter the orbit or status-dot animations; plan 002 owns status motion.
- If cited class names no longer match, STOP and report drift instead of improvising.

## Verification

- **Mechanical**: run `pnpm typecheck`, `pnpm test`, and `pnpm build:web`; all must exit 0.
- **Feel check**: at a 390×844 viewport, switch Flights/Browse at least five times, open/close settings, and open a flight detail with both pointer and Enter.
  - Workspace and settings changes must respond immediately with no vertical replay.
  - Keyboard-opened detail must have no entrance animation.
  - Brief/review explanatory content should enter once over 180ms.
  - Startup-stage copy should enter over 220ms and the orbit should remain continuous.
  - In DevTools at 10% playback, confirm no screen and child are translating simultaneously.
- **Done when**: no global `.screen` animation exists, high-frequency paths do not carry `fade-up`, and all remaining entrances use shared tokens.
