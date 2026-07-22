# 002 — Move status pulses to transform and opacity

- **Status**: DONE
- **Commit**: 566fd7b
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 1 file, about 30 lines

## Problem

The shared pulse keyframes animate `box-shadow` forever. They are used by home, workspace, runtime, and pipeline statuses, so the browser continuously repaints while the app is otherwise idle.

```css
/* src/styles.css:615-618 — current */
@keyframes pulse {
  0%, 100% { opacity: 0.55; box-shadow: 0 0 0 0 rgba(167, 196, 154, 0); }
  50% { opacity: 1; box-shadow: 0 0 0 4px rgba(167, 196, 154, 0.08); }
}

/* representative consumers: src/styles.css:210,510,741-743,822-823 */
.status-dot.active { background: var(--green); animation: pulse 2.2s ease-in-out infinite; }
.pipeline-row.active > i { border-color: var(--ink); animation: pulse 1s ease-in-out infinite; }
.status-dot.running,
.status-dot.queued { background: var(--green); animation: pulse 1.2s ease-in-out infinite; }
.live-status.running i,
.live-status.queued i { animation: pulse 1.2s ease-in-out infinite; }
```

## Target

Keep the core dot static. Draw the expanding ring with a pseudo-element whose only animated properties are `transform` and `opacity`.

```css
/* target */
@keyframes status-ring {
  from { opacity: 0.45; transform: scale(0.7); }
  to { opacity: 0; transform: scale(1.8); }
}

.status-dot.active,
.status-dot.listening,
.status-dot.running,
.status-dot.queued,
.pipeline-row.active > i,
.live-status.running i,
.live-status.queued i {
  position: relative;
  animation: none;
}

.status-dot.active::after,
.status-dot.listening::after,
.status-dot.running::after,
.status-dot.queued::after,
.pipeline-row.active > i::after,
.live-status.running i::after,
.live-status.queued i::after {
  position: absolute;
  inset: -3px;
  border: 1px solid rgba(167, 196, 154, 0.45);
  border-radius: inherit;
  content: "";
  pointer-events: none;
  transform-origin: center;
  animation: status-ring 1.2s var(--ease-in-out) infinite;
}

.status-dot.active::after { animation-duration: 2.2s; }
.pipeline-row.active > i::after { animation-duration: 1s; }
.status-dot.listening::after { border-color: rgba(224, 112, 90, 0.55); }
```

## Repo conventions to follow

- Motion tokens come from plan 001 in `src/styles.css:1-31`; use `var(--ease-in-out)` exactly.
- Status colors remain defined on existing selectors; do not change state semantics.
- The codebase uses CSS pseudo-elements for decorative layers, as shown by `.agent-orbit::before` at `src/styles.css:341`.

## Steps

1. Execute plan 001 first so `--ease-in-out` exists.
2. Delete `@keyframes pulse` and remove every `animation: pulse …` declaration.
3. Add the exact `status-ring` keyframes and shared selector blocks shown in Target near the existing animation definitions.
4. Ensure each animated host has `position: relative` and the pseudo-element inherits a circular border radius.
5. Keep failed and paused statuses static; do not add a ring to them.

## Boundaries

- Do NOT change JSX, statuses, polling cadence, colors, sizes, or dot labels.
- Do NOT animate box-shadow, border width, width, or height.
- Do NOT change the startup orbit.
- If plan 001 tokens are absent, STOP and execute plan 001 rather than hard-coding another curve.

## Verification

- **Mechanical**: run `pnpm typecheck`, `pnpm test`, and `pnpm build:web`; all must exit 0. Run `rg -n 'animation: pulse|@keyframes pulse' src/styles.css`; it must return no matches.
- **Feel check**: view active, queued/running, failed, and paused agents.
  - Active/running rings should expand smoothly without changing the core dot opacity.
  - Failed and paused dots must remain static.
  - In DevTools Performance with paint flashing enabled, idle status pulses must not flash painted regions each frame.
  - At 10% playback, the ring must originate from the center without jumping at its visible start.
- **Done when**: all live status motion uses only transform and opacity and produces no continuous box-shadow painting.
