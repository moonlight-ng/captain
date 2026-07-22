# Animation improvement plans

These plans were produced from the current plain-CSS/React motion system at commit `566fd7b`. They intentionally do not modify application source.

| Plan | Title | Severity | Status |
| --- | --- | --- | --- |
| [001](001-simplify-navigation-motion.md) | Simplify navigation motion and establish tokens | HIGH | DONE |
| [002](002-move-status-pulse-to-gpu.md) | Move status pulses to transform and opacity | HIGH | DONE |
| [003](003-make-sheets-reversible.md) | Make sheets physical and reversible | HIGH | DONE |
| [004](004-make-notices-interruptible.md) | Make success and error notices interruptible | MEDIUM | DONE |
| [005](005-fix-touch-and-reduced-motion.md) | Fix touch feedback and reduced-motion behavior | MEDIUM | DONE |
| [006](006-unify-status-sheet-slide.md) | Unify status sheets with the bottom drawer motion | MEDIUM | DONE |

## Recommended execution order

1. **001** first: it creates the shared easing and duration tokens and removes feel-breaking global navigation motion.
2. **002** next: it depends only on 001 and removes the largest continuous paint cost.
3. **003** after 001: it establishes the persistent `data-open` sheet contract.
4. **004** after 001: it establishes the shared `.app-notice` contract.
5. **005** last: it depends on the tokens and selectors created by 001-004 and provides the final pointer/reduced-motion layer.
6. **006** after 003 and 005: it replaces the status-sheet pill-origin morph with the established bottom-drawer transform while retaining the reduced-motion contract.

## Execution contract

- Execute one plan at a time and update its status to `DONE` only after all mechanical and feel checks pass.
- Preserve existing uncommitted work; stop on source drift rather than replacing concurrent edits.
- Do not add a motion library. The plans deliberately extend the existing plain-CSS architecture.
