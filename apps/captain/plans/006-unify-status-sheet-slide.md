# 006 — Unify status sheets with the bottom drawer motion

- **Status**: DONE
- **Commit**: 566fd7b
- **Severity**: MEDIUM
- **Category**: Physicality; cohesion
- **Estimated scope**: 1 file, about 30 lines

## Problem

The Sort & Filter drawer enters from the bottom edge with `translateY(100%)`, but the Options and Agent time sheets still expand from their status pills using `clip-path`. All three surfaces are bottom sheets, so the different physical origin makes the workspace feel inconsistent.

```css
/* src/styles.css:789-824 — current status-sheet motion */
.workspace-info-sheet {
  opacity: 0.35;
  transition: clip-path var(--duration-sheet-exit) var(--ease-out),
              opacity var(--duration-sheet-exit) var(--ease-out);
}
.workspace-info-sheet.from-options { clip-path: inset(calc(100% - 66px) calc(100% - 112px) 20px 18px round 99px); }
.workspace-info-sheet.from-runtime { clip-path: inset(calc(100% - 66px) 18px 20px calc(100% - 112px) round 99px); }
.workspace-info-backdrop[data-open="true"] .workspace-info-sheet {
  opacity: 1;
  clip-path: inset(0 round 26px 26px 0 0);
  transition-duration: var(--duration-sheet);
  transition-timing-function: var(--ease-drawer);
}
```

## Target

Make both workspace status sheets use the same transform-only drawer contract as `.sheet-backdrop .bottom-sheet`: closed at `translateY(100%)`, open at `translateY(0)`, 240ms `--ease-drawer` entry, and 160ms `--ease-out` exit. Keep the existing backdrop fade.

```css
.workspace-info-sheet {
  transform: translateY(100%);
  transition: transform var(--duration-sheet-exit) var(--ease-out);
}

.workspace-info-backdrop[data-open="true"] .workspace-info-sheet {
  transform: translateY(0);
  transition-duration: var(--duration-sheet);
  transition-timing-function: var(--ease-drawer);
}

@starting-style {
  .workspace-info-backdrop[data-open="true"] { opacity: 0; }
  .workspace-info-backdrop[data-open="true"] .workspace-info-sheet {
    transform: translateY(100%);
  }
}
```

## Steps

1. Edit only `src/styles.css`.
2. Keep `.workspace-info-backdrop` and its open-state opacity/visibility transitions unchanged.
3. In `.workspace-info-sheet`, delete the closed `opacity: 0.35` and the `clip-path`/opacity transition. Add `transform: translateY(100%)` and a transform-only 160ms exit using the existing tokens.
4. Delete the `.from-options` and `.from-runtime` clip-path rules.
5. In the open sheet rule, delete `opacity` and `clip-path`; set `transform: translateY(0)` while retaining the existing 240ms drawer duration/easing.
6. Replace the two origin-specific `@starting-style` sheet rules with one generic status-sheet rule that starts at `translateY(100%)`. Keep the backdrop starting opacity rule.
7. Do not change the existing reduced-motion block: it already removes transforms and preserves a 200ms opacity transition for both bottom-sheet families.

## Boundaries

- Do NOT change React state, sheet markup, content, dimensions, background, blur, shadow, z-index, or ARIA behavior.
- Do NOT change Sort & Filter CSS; use it as the motion reference.
- Do NOT add keyframes, JavaScript timers, a motion dependency, bounce, or spring behavior.
- Animate only `transform` on the sheet and `opacity` on the backdrop.
- Preserve interruptibility and persistent mounting.

## Verification

- Run `pnpm typecheck`, `pnpm test`, `pnpm build:web`, and `git diff --check`.
- Run `rg -n 'workspace-info-sheet\.from-|workspace-info-sheet.*clip-path|workspace-info-sheet.*opacity' src/styles.css`; no normal-motion origin-specific or clip-path/opacity sheet declarations should remain.
- At the phone viewport, open and close Options, Agent time, and Sort & Filter. All three sheets must travel vertically from the bottom edge with the same 240ms entry curve and 160ms exit curve.
- Close a status sheet during entry and reopen during exit; it must reverse from its current transform without snapping.
- Under reduced motion, all three sheets must fade for 200ms without translation.

## Done when

Options and Agent time behave like Sort & Filter: a crisp, interruptible bottom-edge drawer with matching timing and reduced-motion behavior.
