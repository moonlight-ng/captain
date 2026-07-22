# 003 — Make sheets physical and reversible

- **Status**: DONE
- **Commit**: 566fd7b
- **Severity**: HIGH
- **Category**: Physicality & origin; interruptibility
- **Estimated scope**: 2 files, about 90 lines

## Problem

The filter sheet uses a generic 8px entrance and no backdrop animation. Workspace status sheets use 360ms entry keyframes. Both are conditionally unmounted on close, so their exits snap and their motion cannot reverse from its current state.

```tsx
// src/App.tsx:301-311 — current filter presence
{filterOpen && workspace && (
  <FilterSheet
    preferences={draftPreferences}
    flights={workspace.browseFlights}
    onPreferences={setDraftPreferences}
    onClose={() => setFilterOpen(false)}
    onApply={() => void performAction(
      { type: "set_browse_preferences", preferences: draftPreferences },
      () => setFilterOpen(false)
    )}
  />
)}

// src/App.tsx:526 — current info-sheet presence
{infoSheet && <WorkspaceInfoSheet kind={infoSheet} ... />}
```

```css
/* src/styles.css:564 — current */
.bottom-sheet { ... animation: fade-up 230ms ease both; }

/* src/styles.css:753,770-771 — current */
.workspace-info-backdrop { ... animation: info-backdrop-in 240ms ease both; }
.workspace-info-sheet.from-options { animation: info-expand-left 360ms cubic-bezier(0.22, 1, 0.36, 1) both; }
.workspace-info-sheet.from-runtime { animation: info-expand-right 360ms cubic-bezier(0.22, 1, 0.36, 1) both; }
```

## Target

Keep each sheet mounted while its owning screen exists and drive reversible CSS transitions with `data-open`. Opening uses 240ms `--ease-drawer`; closing uses 160ms `--ease-out`. Backdrops fade over 180ms open and 160ms close.

```css
/* target: filter sheet */
.sheet-backdrop {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity var(--duration-sheet-exit) var(--ease-out),
              visibility 0s linear var(--duration-sheet-exit);
}
.sheet-backdrop[data-open="true"] {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transition: opacity var(--duration-ui) var(--ease-out), visibility 0s;
}
.sheet-backdrop .bottom-sheet {
  transform: translateY(100%);
  transition: transform var(--duration-sheet-exit) var(--ease-out);
}
.sheet-backdrop[data-open="true"] .bottom-sheet {
  transform: translateY(0);
  transition-duration: var(--duration-sheet);
  transition-timing-function: var(--ease-drawer);
}
```

For workspace info sheets, keep the existing left/right pill-origin clip paths from `info-expand-left/right`, but move them into closed-state selectors. Transition `clip-path` and `opacity` over 240ms open and 160ms close; delete the three info keyframes.

```css
/* target shape; retain the exact existing inset values */
.workspace-info-backdrop { opacity: 0; visibility: hidden; pointer-events: none; }
.workspace-info-backdrop[data-open="true"] { opacity: 1; visibility: visible; pointer-events: auto; }
.workspace-info-sheet { opacity: 0.35; transition: clip-path var(--duration-sheet-exit) var(--ease-out), opacity var(--duration-sheet-exit) var(--ease-out); }
.workspace-info-sheet.from-options { clip-path: inset(calc(100% - 66px) calc(100% - 112px) 20px 18px round 99px); }
.workspace-info-sheet.from-runtime { clip-path: inset(calc(100% - 66px) 18px 20px calc(100% - 112px) round 99px); }
.workspace-info-backdrop[data-open="true"] .workspace-info-sheet {
  opacity: 1;
  clip-path: inset(0 round 26px 26px 0 0);
  transition-duration: var(--duration-sheet);
  transition-timing-function: var(--ease-drawer);
}
```

## Repo conventions to follow

- Keep UI state in `src/App.tsx`; keep deterministic motion in `src/styles.css`.
- Use the plan 001 tokens; do not duplicate cubic-beziers or milliseconds.
- Keep the existing status-sheet pill-origin geometry; it is the correct spatial explanation.

## Steps

1. Execute plan 001 first.
2. Change the filter render in `App` from `filterOpen && workspace` to `workspace &&`, pass `open={filterOpen}`, and add `readonly open: boolean` to `FilterSheet` props.
3. Add `data-open={props.open}` and `aria-hidden={!props.open}` to the filter backdrop. Set `aria-modal={props.open}` on the dialog. Rely on `visibility: hidden` while closed so descendants are not focusable; do not use the `hidden` attribute.
4. Replace `infoSheet` state with `null | { kind: "options" | "runtime"; open: boolean }`. Opening sets the selected kind with `open: true`; closing preserves the kind and sets `open: false`.
5. Pass `open` to `WorkspaceInfoSheet`; add `data-open`, `aria-hidden`, and conditional `aria-modal` exactly as for the filter sheet.
6. Replace the current filter and status-sheet keyframe animations with the transition rules in Target. Preserve the two origin-specific closed clip paths verbatim.
7. Delete `info-backdrop-in`, `info-expand-left`, and `info-expand-right` keyframes and remove `.bottom-sheet`'s `fade-up` animation.
8. Ensure opening a different status pill while a sheet is closing retargets to open without remounting.

## Boundaries

- Do NOT change sheet dimensions, content, backdrop colors, blur, z-index, sorting/filter behavior, or status values.
- Do NOT animate height, width, padding, margin, top, or left.
- Do NOT add timers or a motion dependency; CSS transitions and persistent mounting are sufficient.
- Do NOT replace the status-sheet clip-path morph with a generic bottom slide.
- If plan 001 tokens are absent, STOP and execute plan 001.

## Verification

- **Mechanical**: run `pnpm typecheck`, `pnpm test`, and `pnpm build:web`; all must exit 0. Run `rg -n 'info-expand|info-backdrop-in|bottom-sheet.*animation' src/styles.css`; it must return no legacy animation declarations.
- **Feel check**: at 390×844, open/close filters, Options, and Agent runtime repeatedly.
  - Filter sheet must travel from its own bottom edge over 240ms and close over 160ms.
  - Options/runtime sheets must still grow from their corresponding left/right pills.
  - Clicking close halfway through opening must reverse smoothly from the current frame.
  - At 10% playback, confirm the backdrop and sheet start together and no frame snaps at unmount.
  - Toggle `prefers-reduced-motion` after plan 005 and confirm position/clip movement is removed while opacity remains.
- **Done when**: all three sheets have interruptible entrances and exits, retain correct origins, and never disappear before their closing transition completes.
