# 004 — Make success and error notices interruptible

- **Status**: DONE
- **Commit**: 566fd7b
- **Severity**: MEDIUM
- **Category**: Interruptibility & timing; cohesion
- **Estimated scope**: 2 files, about 75 lines

## Problem

Tracking feedback enters with a keyframe and is then unmounted by four duplicated 2400ms timers. Keyframes restart from zero when feedback is triggered rapidly, and unmounting provides no exit. Error feedback has no entrance or exit, so the two notice types feel unrelated.

```tsx
// src/App.tsx:245-251 — representative current trigger
onRetain={(flight) => void performAction({ type: "retain_flight", flightKey: flight.id }, () => {
  setTrackingNotice(`${flight.marketingAirline} is now being tracked`);
  window.setTimeout(() => setTrackingNotice(null), 2_400);
})}

// src/App.tsx:205-206 — current presence
{error && <ErrorNotice message={error} onClose={() => setError(null)} />}
{trackingNotice && <TrackingNotice message={trackingNotice} />}
```

```css
/* src/styles.css:1205-1223 — current */
.tracking-notice {
  ...
  animation: notice-enter 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

/* src/styles.css:1231-1234 — current */
@keyframes notice-enter {
  from { opacity: 0; transform: translateY(10px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
```

## Target

Use one notice-state helper for tracking messages and one transition contract for both tracking and error notices. Entry is 180ms with `--ease-out`; exit is 120ms with `--ease-out`. Tracking notices remain visible for 2280ms, close for 120ms, and unmount at 2400ms. Re-triggering cancels old timers and retargets the existing transition.

```ts
// target state shape
type TrackingNoticeState = { readonly message: string; readonly open: boolean } | null;

// target timing
const TRACKING_NOTICE_VISIBLE_MS = 2_280;
const TRACKING_NOTICE_EXIT_MS = 120;
```

```css
/* target transition contract */
.app-notice {
  opacity: 0;
  visibility: hidden;
  transform: translateY(8px) scale(0.98);
  transition: opacity 120ms var(--ease-out),
              transform 120ms var(--ease-out),
              visibility 0s linear 120ms;
}
.app-notice[data-open="true"] {
  opacity: 1;
  visibility: visible;
  transform: translateY(0) scale(1);
  transition: opacity var(--duration-ui) var(--ease-out),
              transform var(--duration-ui) var(--ease-out),
              visibility 0s;
}
@starting-style {
  .app-notice[data-open="true"] {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
}
```

## Repo conventions to follow

- Keep all notice orchestration inside `src/App.tsx`; no global store is needed.
- Use plan 001's `--duration-ui` and `--ease-out` tokens.
- Existing error and tracking visual treatments remain separate; only their motion primitive is shared.

## Steps

1. Execute plan 001 first.
2. Import `useRef` from React. Replace `trackingNotice: string | null` with `TrackingNoticeState` and keep two timer refs: one for close and one for removal.
3. Add `showTrackingNotice(message)` that clears both existing timers, sets `{ message, open: true }`, schedules `{ ...current, open: false }` after 2280ms, and schedules `null` after 2400ms.
4. Add an unmount cleanup effect that clears both refs.
5. Replace all four duplicated `setTrackingNotice` + `setTimeout` blocks with `showTrackingNotice(message)`.
6. Pass `open={trackingNotice.open}` and `message={trackingNotice.message}` to `TrackingNotice`. Add `className="tracking-notice app-notice"`, `data-open`, and `aria-hidden`.
7. Give `ErrorNotice` internal `open` state initialized to true. Its dismiss button sets `open` false; an `onTransitionEnd` handler calls the parent `onClose` only when `propertyName === "opacity"` and `open` is false. Reset `open` to true when `message` changes.
8. Give `ErrorNotice` `className="error-notice app-notice"`, `data-open`, and `aria-hidden`.
9. Add the exact CSS transition contract from Target and delete `notice-enter` keyframes and the tracking notice's animation declaration.

## Boundaries

- Do NOT change message copy, success/error colors, notice position, total 2400ms tracking lifetime, API behavior, or notification ARIA roles.
- Do NOT add a queue UI, stacking layout, spring, or dependency.
- Do NOT animate top, bottom, left, right, width, or height.
- If plan 001 tokens are absent or current notice state has drifted, STOP instead of inventing alternatives.

## Verification

- **Mechanical**: run `pnpm typecheck`, `pnpm test`, and `pnpm build:web`; all must exit 0. Run `rg -n 'notice-enter|setTimeout\(\(\) => setTrackingNotice' src`; it must return no matches.
- **Feel check**: trigger track/untrack feedback repeatedly, including a second action while the first notice is entering and while it is exiting.
  - The notice must retarget from its current frame, never jump back to the start.
  - It must remain fully readable for 2280ms and close over 120ms.
  - Dismissing an error must animate before unmounting.
  - At 10% playback, entry and exit transforms must stay synchronized with opacity.
  - With reduced motion after plan 005, position movement must disappear but the opacity transition must remain.
- **Done when**: tracking and error notices share an interruptible presence contract and all legacy notice keyframes/timer duplication are gone.
