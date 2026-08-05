# Captain design catalog

Source of truth for **existing** web UI: `apps/captain/src/styles.css`, mounted screens/components under `apps/captain/src/`, and stage labels from `trip-stage.ts`.

This file is a **utility catalog**. Assemble new screens from live entries. Do not invent parallel cards, payment chrome, or offer layouts.

**Status tags**

| Tag | Meaning |
| --- | --- |
| `live` | Mounted in the current React tree — prefer these |
| `prefer X` | Present, but generators should copy **X** instead |
| `orphaned` | CSS and/or component exists but is not mounted — do not copy |

---

## 1. Foundation

### Character

Dark-only (`#000000` canvas, `color-scheme: dark`). Quiet density: body type is 13px; hierarchy from weight, letter-spacing, and opacity. Sage accent (`#a7c49a` / `#bed4b3`) for selection and affirmative status — not neon fills. Cards hold interactive blocks; hairline rows hold secondary data. Mobile full-bleed; ≥720px shells become a centered 560px framed device.

### Tokens (`:root` in `styles.css`)

| Token | Value | Role |
| --- | --- | --- |
| `--ink` | `#ffffff` | Primary text |
| `--muted` | `rgba(255,255,255,.55)` | Secondary copy |
| `--quiet` | `rgba(255,255,255,.38)` | Tertiary / labels |
| `--line` / `--line-strong` | `.12` / `.22` white | Borders |
| `--green` / `--accent` | `#a7c49a` / `#bed4b3` | Status / selection |
| `--panel` / `--panel-soft` | `#0a0a0a` / `#050505` | Surfaces |
| `--radius-card` | `19px` | Primary card radius |
| `--type-title` / `--type-body` / `--type-caption` | `22` / `13` / `10` px | Type scale |
| `--weight-regular` / `--weight-medium` / `--weight-bold` | `400` / `600` / `700` | Epilogue |
| `--ease-out` / `--ease-drawer` | press / sheet open | Motion |
| `--duration-press-out` / `--duration-ui` / `--duration-sheet` / `--duration-sheet-exit` | `100` / `180` / `240` / `160` ms | Motion |

Hardcoded companions (not tokenized): canvas `#000000`; soft white washes; coral danger `rgba(242,176,163,…)`; amber caution `rgba(233,188,116,…)` / `rgba(247,211,153,…)`.

### Typography

Epilogue 400/600/700. Titles and `.price` use `--type-title` + medium weight + tight tracking. Body everywhere else. Eyebrows: bold, uppercase, `.17em` tracking, ~42% white. Captions for badges/chips. Tabular nums on times, prices, peer-plot labels. Avoid a fourth type size.

### Color semantics

Default `--ink`; supporting `--muted`; de-emphasized `--quiet`. Selected / watching / ready → sage border + wash. Affirmative → `--green` or sage badge. Incomplete / mock / caution → amber. Error / cancel → coral. Success mock → `.notice-mock-success`. No purple, bright green, or glow as a design language.

### Layout

`.shell` (trip) and `.settings-shell` (profile / trip settings): `100dvh`, overflow-x hidden. Horizontal padding ~20–22px; card padding ~16–20px. Desktop ≥720px: 560px centered frame, 24px radius, hairline, deep shadow. ≤520px: headings stack, form grids collapse, traveller cards reflow. Scrollbars hidden globally.

### Motion

Tokens only for shared easing/duration. No global screen entrances. Press via `transform: scale(.99)`, not color fades. Sheets: opacity + `translateY`; open uses `--ease-drawer`, close is shorter. `prefers-reduced-motion: reduce` kills transitions. Prefer existing classes over new keyframes.

### Accessibility

Focus-visible: `2px solid rgba(255,255,255,.82)` + `3px` offset. Primary actions ~44px min height. Ready vs incomplete always includes badge text, not color alone. Icons: stroke SVG in `components/icons.tsx` (~14–22px).

### Trip stage vocabulary (`trip-stage.ts`)

Stages: `stopped` | `booked` | `paused` | `stale` | `searching` | `tracking`. `stageLabel()` feeds trip header meta and Trip Settings tracking summary. Not a visual component — compose with `.trip-meta`, disclosure `em`, or notices.

---

## 2. Component catalog

### Shell and chrome

#### Shell
- **Classes / components:** `.shell`, `.settings-shell` (+ `.is-traveller-editor`)
- **Status:** `live`
- **Job:** Page frame for trip dashboard vs profile/settings.
- **Inputs:** Full-page children; traveller editor toggles `is-traveller-editor` to drop bottom padding.
- **Compose with:** `.topbar`, `.workspace`, `.settings-intro`, settings cards.

#### Top bar
- **Classes:** `.topbar`, `.brand`, `.brand-mark`, `.top-actions`, `.name`
- **Status:** `live`
- **Job:** Brand or back affordance + quiet context (profile name, “Trip settings”).
- **Inputs:** Home link / back handler; optional display name.
- **Compose with:** `.quiet-link` / `.back-link`.

#### Quiet / back links
- **Classes:** `.quiet-link`, `.back-link` (+ `.inactive`)
- **Status:** `live`
- **Job:** Frosted pill navigation (Settings, Profile, Back).
- **Inputs:** `href` or `onClick`; inactive for non-interactive back chrome.
- **Compose with:** `.topbar`, watchlist detail header, entity-row actions.

#### Trip heading
- **Classes:** `.trip-heading`, `.eyebrow`, `.trip-meta`
- **Status:** `live`
- **Job:** Route title + date/cabin meta; optional “Tracking paused” eyebrow.
- **Inputs:** Trip brief labels; `stageLabel` / pause state.
- **Compose with:** `.notice-delay`, `.tabs`.

#### Workspace
- **Classes:** `.workspace`
- **Status:** `live`
- **Job:** Scroll region under trip tabs.
- **Compose with:** Flights / Airlines / Browse tab bodies.

#### Settings intro
- **Classes:** `.settings-intro`
- **Status:** `live`
- **Job:** Trip settings title block (route + date range) or stopped-trip copy.
- **Compose with:** `.settings-shell`, disclosure cards.

#### Centered / full-page empty
- **Classes / components:** `.centered` (`CenteredState` in `App.tsx`), `.empty-hero`
- **Status:** `live`
- **Job:** Auth/loading errors (`.centered` + brand mark); no-trip heroes on Home / App.
- **Inputs:** Title + detail string; or eyebrow + `h1` + muted `p`.
- **Do not use when:** In-tab empty results — use `.results-empty` instead.

---

### Navigation

#### Segmented tabs
- **Classes:** `.tabs` (+ `button.active`, optional count `span`)
- **Status:** `live`
- **Job:** Trip results (Flights / Airlines / Browse) and Profile (Preferences / Travellers / Card).
- **Inputs:** Selected tab id; optional badge counts.
- **Compose with:** `.shell` / `.settings-shell` (settings tabs get 3-column margin via `.settings-shell .tabs`).

#### Profile header / profile tabs (legacy)
- **Classes:** `.profile-header`, `.profile-tabs`, `.profile-tab-panel`, `.profile-inline-notice`
- **Status:** `orphaned`
- **Job:** Older profile chrome.
- **Do not use when:** Building profile UI — use `.topbar` + `.tabs` as in `Profile.tsx`.

---

### Feedback

#### Notices
- **Classes:** `.notice`, `.notice-delay`, `.notice-mock-success`
- **Status:** `live`
- **Job:** Error/interrupt (coral); soft delay/info (sage); mock booking success.
- **Inputs:** Short message string; `role="status"` / `alert` as appropriate.
- **Compose with:** Trip shell, booked flight hero.

#### Form error
- **Classes:** `.form-error`
- **Status:** `live`
- **Job:** Inline save/API failure under forms.
- **Compose with:** PassengerForm, AccountPreferences, TripSettings, Duffel orphan form.

#### Set note
- **Classes:** `.set-note`
- **Status:** `live`
- **Job:** Quiet helper copy under panels, payments, watchlist panels.
- **Compose with:** Almost any card or empty.

#### Results empty
- **Classes / components:** `.results-empty` (+ `.compact`, `.searching`), `ResultsEmpty` in `App.tsx`
- **Status:** `live`
- **Job:** No offers / searching / compact in-panel empties; searching pulses icon well.
- **Inputs:** Searching vs needs-manual-search vs completed; optional primary search button.
- **Compose with:** FlightsTab, AirlinesTab, BrowseTab, WatchlistDetail miss.

#### Profile / traveller empty
- **Classes:** `.profile-empty-state` (+ `.form-error`), `.traveller-empty-state`
- **Status:** `live`
- **Job:** Loading / error / zero travellers in profile flows.
- **Compose with:** `.profile-add-button`.

---

### Actions

#### Trip controls / save
- **Classes:** `.trip-controls` (+ `.primary`, `.danger`), `.save-button`
- **Status:** `live`
- **Job:** Pause / resume / refresh / stop; full-width form saves.
- **Inputs:** Busy/disabled; confirm on stop.
- **Compose with:** Tracking disclosure, PassengerForm, AccountPreferences, trip brief.

#### Primary / secondary sheet CTAs
- **Classes:** `.primary-action`, `.secondary-action`
- **Status:** `live`
- **Job:** Pill CTAs in filter sheet footer, traveller book row, traveller sheet footer.
- **Compose with:** `.filter-sheet` footer, `.traveller-book-row`, `.traveller-sheet-form`.

#### Profile add button
- **Classes:** `.profile-add-button`
- **Status:** `live`
- **Job:** Add traveller / retry CTA in list empties.
- **Compose with:** Travellers list heading / empty state.

#### Icon button
- **Classes:** `.icon-button`
- **Status:** `live`
- **Job:** 34×34 close control on sheets.
- **Inputs:** `aria-label`; SVG child (`CloseIcon`).
- **Compose with:** FilterSheet / traveller sheet headers.

#### Danger link
- **Classes:** `.danger-link`
- **Status:** `live`
- **Job:** Text-style destructive action (delete traveller).
- **Compose with:** `.traveller-detail-actions`.

#### Booking action grid
- **Classes:** `.booking-actions` (+ `button.danger`)
- **Status:** `live`
- **Job:** Mock booking secondary actions (baggage / cancel / etc.).
- **Compose with:** `.booking-section`, mock action panels.

---

### Status chips and badges

#### Pill / tag
- **Classes:** `.pill`, `.tag`
- **Status:** `.pill` → `live`; `.tag` → `orphaned` (alias unused in TSX)
- **Job:** “Your preference”, “Watching”, “Mixed” on cards.
- **Compose with:** `.card-top`, `.airline-card-title`.
- **Do not use when:** Prototype labelling — that was `.mock-pill` (orphaned).

#### Mock pill
- **Classes:** `.mock-pill`
- **Status:** `orphaned`
- **Job:** Amber prototype label (CSS only).
- **Do not use when:** Shipping UI — prefer live `.pill` or booking status chips.

#### Readiness badge
- **Classes:** `.readiness-badge.ready` / `.incomplete`
- **Status:** `live`
- **Job:** Traveller booking-ready vs incomplete.
- **Inputs:** `readyForBooking` boolean + short label.
- **Compose with:** Traveller summary cards, picker rows, editor heading.

#### Booking status
- **Classes:** `.booking-status.confirmed` / `.cancelled`
- **Status:** `live`
- **Job:** Uppercase status chip on booked-flight hero.
- **Compose with:** `.booking-identity-row`.

#### Watchlist toggle
- **Classes:** `.watchlist-toggle` (+ `.watching`)
- **Status:** `live`
- **Job:** Watch / unwatch control on offer detail.
- **Inputs:** Watching boolean; disabled while busy.
- **Compose with:** `.watchlist-detail-header`.

#### Summary refresh
- **Classes:** `.summary-refresh`
- **Status:** `live`
- **Job:** Manual refresh beside watchlist price.
- **Compose with:** `.watchlist-summary-top`.

#### Traveller state (disclosure)
- **Classes:** `em.traveller-state.ready` / `.warn` / `.quiet`
- **Status:** `live`
- **Job:** Right-side status on Trip Settings traveller disclosure.
- **Compose with:** `.settings-disclosure` summary.

---

### Result cards and lists

#### Recommendation card (canonical offer card)
- **Classes / components:** `.recommendation-card` (+ `.selected`), `.recommendation-grid`, `RecommendationCard`, `OfferRow` (App)
- **Status:** `live`
- **Job:** Ranked suggestion or browsable/watched offer: mode/airline label, optional pill, price, metrics, schedule spine.
- **Inputs:** `VerifiedOffer`; ranking mode or airline name; selected/watching flag; `onOpen`.
- **Compose with:** `.card-top`, `.mode-label`, `.pill`, `.price`, `.metrics`, `ScheduleSpine`, `.watchlist-divider`.
- **Do not use when:** Inventing a second offer-card layout — App `OfferRow` already mounts this class.

#### Airline card
- **Classes / components:** `.airline-card`, `.airline-grid`, `.airline-monogram`, `.airline-card-title`, `.carrier-list`, `.airline-stats`, `AirlinesTab`
- **Status:** `live`
- **Job:** Carrier group with monogram, optional Mixed pill, quiet carrier list, hairline stats.
- **Inputs:** Grouped airline + offers; click jumps to Browse with airline filter.
- **Compose with:** `.pill`, ResultsEmpty.

#### Trip list
- **Classes / components:** `.trip-list`, `.trip-list-item`, `Home`
- **Status:** `live`
- **Job:** Home trip picker: large route, muted meta, quiet stage on the right.
- **Inputs:** Trip id, route/date labels, stage string from `stageLabel` / local copy.
- **Compose with:** `.shell`, `.topbar`, `.empty-hero`.

#### Offer list container
- **Classes:** `.offer-list`
- **Status:** `live`
- **Job:** Vertical stack for browse results (children are recommendation cards).
- **Compose with:** BrowseTab, `.browse-toolbar`.

#### Watchlist divider
- **Classes:** `.watchlist-divider`
- **Status:** `live`
- **Job:** “Recommendations” hairline separator between watched and suggested cards.
- **Compose with:** `.recommendation-grid`.

---

### Explanation (watchlist detail)

#### Watchlist detail shell
- **Classes / components:** `.watchlist-detail`, `.watchlist-detail-header`, `.watchlist-detail-summary`, `.watchlist-summary-top`, `.watchlist-airline`, `.watchlist-panel`, `WatchlistDetail`
- **Status:** `live`
- **Job:** Focused offer: back + watch toggle, price summary, panels for itinerary / peer plot / sources / checks.
- **Inputs:** Offer, watching, peer prices, evidence links, watch checks, activity.
- **Compose with:** FlightTimeline, PeerPricePlot, TripTravellerPicker, `.sources-table`, `.watch-checks`, `.activity-disclosure`.

#### Schedule spine
- **Classes / components:** `.schedule-line`, `.schedule-point` (+ `-end` / `-stop`), `.schedule-connector`, `ScheduleSpine`
- **Status:** `live`
- **Job:** Compact origin → stops → destination under a card price.
- **Inputs:** Spine points from offer segments.
- **Compose with:** RecommendationCard / OfferRow.

#### Flight timeline (segment list)
- **Classes / components:** `.flight-timeline` (ordered list), `.timeline-leg`, `.timeline-node`, `.timeline-dot`, `.timeline-node-body`, `.timeline-rail`, `.timeline-rail-line`, `.timeline-travel`, `.timeline-layover`, `FlightTimeline`
- **Status:** `live`
- **Job:** Dotted-rail segment itinerary on watchlist detail.
- **Inputs:** `Segment[]`.
- **Do not use when:** Booked-flight “now” card — that uses the booked `.flight-timeline-*` end/rail recipe below.

#### Peer price plot
- **Classes / components:** `.peer-plot`, `.peer-plot-track`, `.peer-plot-fill`, `.peer-plot-median`, `.peer-plot-pin`, `.peer-plot-labels`, `PeerPricePlot`
- **Status:** `live`
- **Job:** Your fare vs verified peers on a sage→neutral→coral track.
- **Inputs:** Offer amount + peer amounts → pin/median positions.
- **Compose with:** `.watchlist-panel`, `.set-note`.

#### Sources table
- **Classes:** `.sources-table`, `.sources-title`
- **Status:** `live`
- **Job:** Provider evidence links for a fare.
- **Compose with:** `.watchlist-panel`.

#### Watch checks
- **Classes:** `.watch-checks`
- **Status:** `live`
- **Job:** Hairline dl of last/next check style facts.
- **Compose with:** `.watchlist-panel`, `.activity-disclosure`.

#### Activity disclosure / list
- **Classes:** `.activity-disclosure`, `.activity-list`
- **Status:** `live`
- **Job:** Collapsible activity under watchlist; also reused inside Trip Settings activity card.
- **Inputs:** Activity events with label + timestamp.
- **Compose with:** WatchlistDetail, TripSettings Activity disclosure.

#### Flight details heading
- **Classes:** `.flight-details-heading`, `.stop-count`
- **Status:** `live`
- **Job:** Panel title + stop count for outbound/return timelines.
- **Compose with:** FlightTimeline.

---

### Browse and filter

#### Browse toolbar
- **Classes / components:** `.browse-toolbar`, `.sort-filter-button` (+ `.active`), `.sort-filter-title`, `.sort-filter-summary`, `BrowseTab`
- **Status:** `live`
- **Job:** Opens FilterSheet; shows sort/filter summary + count badge.
- **Inputs:** Active filter count; summary strings; icons from `icons.tsx`.
- **Compose with:** `.active-filter-row`, FilterSheet.

#### Active filter chips
- **Classes:** `.active-filter-row`
- **Status:** `live`
- **Job:** Horizontal sage chips + clear control.
- **Inputs:** Chip labels; clear handler.
- **Compose with:** Browse toolbar.

#### Filter sheet
- **Classes / components:** `.sheet-backdrop`, `.bottom-sheet`, `.filter-sheet`, `.sheet-scroll`, `.filter-group`, `.filter-choice-row` (+ `.wrap`), `.sheet-input`, `FilterSheet`
- **Status:** `live`
- **Job:** Sort + stops/airlines/airports/departure filters with sticky header/footer.
- **Inputs:** `BrowsePreferences`, offer universe, open flag, apply/close.
- **Compose with:** `.icon-button`, `.primary-action` / `.secondary-action` footer.
- **Do not use when:** Non-filter sheets — reuse backdrop/bottom-sheet but booked traveller sheet has its own `.traveller-sheet*` variants.

---

### Settings

#### Settings card / disclosure
- **Classes:** `.settings-card`, `.settings-disclosure`, `.settings-body`, `.settings-list`
- **Status:** `live`
- **Job:** Collapsible settings sections (Tracking, Brief, Traveller, Activity, Notifications, Flight preferences) or static card shell (payment, secure setup).
- **Inputs:** Summary title + `em` meta; body form or dl.
- **Compose with:** `.trip-controls`, `.form-grid`, `.ranking-options`, `.switch-setting`, `.read-only-field`, `.entity-row`, AirlineSearchSelect.

#### Read-only field
- **Classes:** `.read-only-field`
- **Status:** `live`
- **Job:** Bordered read-only value (multi-city route note, assigned traveller link, payment fixture line).
- **Compose with:** Trip brief, TravellerCard, Payment.

#### Entity row
- **Classes:** `.entity-row`
- **Status:** `live`
- **Job:** Horizontal action/meta row (Change/Add traveller; payment fixture line).
- **Compose with:** Settings body, live Payment, `.read-only-field` / `.settings-list` (adjacent spacing via CSS).

#### Ranking options
- **Classes:** `.ranking-options` (+ `label.checked`)
- **Status:** `live`
- **Job:** Selectable ranking mode rows in AccountPreferences.
- **Inputs:** `RankingMode`; checked state.
- **Compose with:** `.settings-card` form.

#### Switch setting
- **Classes:** `.switch-setting`
- **Status:** `live`
- **Job:** Label + native-looking switch for notification toggles.
- **Compose with:** NotificationsCard.

#### Form grid
- **Classes:** `.form-grid` (+ `.two`, `.three`)
- **Status:** `live`
- **Job:** Responsive field grids (collapse ≤520px).
- **Compose with:** Trip brief, PassengerForm, AccountPreferences.

#### Airline search select
- **Classes / components:** `.airline-search`, `.airline-search-field`, `.airline-chip`, `.airline-search-results`, `AirlineSearchSelect`
- **Status:** `live`
- **Job:** Multi-select airline chips with typeahead.
- **Inputs:** Code list; onChange; placeholder.
- **Compose with:** Trip brief preferred/excluded; AccountPreferences.

#### Payment (live fixture)
- **Classes / components:** `.payment-settings`, `.payment-card-list`, `.entity-row`, `Payment`
- **Status:** `live`
- **Job:** Prototype test-card display — never collects a real card.
- **Inputs:** `TEST_PAYMENT_METHOD` fixture.
- **Compose with:** `.settings-card`, `.read-only-field`, `.set-note`, `.entity-row`.
- **Do not use when:** Reintroducing wallet-card chrome or Duffel iframe capture — product boundary is display-only fixture.

---

### Traveller and book

#### Traveller list / summary card
- **Classes / components:** `.traveller-list-view`, `.traveller-card-list`, `.traveller-summary-card`, `.traveller-avatar`, `.traveller-card-main`, `.card-chevron`, `Travellers`
- **Status:** `live`
- **Job:** Profile traveller roster with initials avatar, readiness badge, chevron.
- **Inputs:** `Passenger[]`; navigate to editor.
- **Compose with:** `.profile-section-heading`, `.profile-add-button`, readiness badge.

#### Traveller editor
- **Classes:** `.traveller-editor`, `.traveller-editor-body`, `.profile-section-heading`, `.traveller-detail-heading`, `.traveller-detail-actions`
- **Status:** `live`
- **Job:** Full-screen add/edit traveller with sticky topbar.
- **Compose with:** PassengerForm, readiness badge, danger-link.

#### Passenger form
- **Classes / components:** `.traveller-form`, `.form-section`, `.form-section-heading`, `.required-note`, `.secure-label`, `.input-with-action`, `.passport-number-field`, `PassengerForm`
- **Status:** `live`
- **Job:** Government name, contact, encrypted travel document sections.
- **Inputs:** Form values; busy/error; submit handler.
- **Compose with:** `.form-grid`, `.save-button`, `.set-note`.

#### Secure summary
- **Classes:** `.secure-summary`
- **Status:** `orphaned`
- **Job:** Sage summary grid for secured fields (CSS only).
- **Do not use when:** Live traveller detail — form sections + secure-label cover the job.

#### Trip traveller picker
- **Classes / components:** `.trip-traveller-picker`, `.trip-traveller-heading`, `.traveller-picker-list`, `.traveller-picker-radio`, `.traveller-picker-person`, `.traveller-picker-empty`, `.traveller-book-row`, `TripTravellerPicker`
- **Status:** `live`
- **Job:** Choose saved traveller + Book CTA on watchlist detail.
- **Inputs:** Trip id, passengers, selection, canBook, onBook.
- **Compose with:** `.eyebrow`, `.quiet-link`, readiness badge, `.primary-action`.

---

### Sheets (non-filter)

#### Traveller sheet (booked mock)
- **Classes:** `.traveller-sheet-backdrop`, `.traveller-sheet`, `.traveller-sheet-form`, `.traveller-sheet-row`, BookedFlight sheet helpers
- **Status:** `live`
- **Job:** Edit mock booking traveller fields in a bottom sheet.
- **Compose with:** `.sheet-backdrop` / `.bottom-sheet` base, `.icon-button`, primary/secondary actions.

---

### Booking mock

#### Booked flight screen
- **Classes / components:** `.booked-flight`, `.booking-hero`, `.booking-identity-row`, `BookedFlight`
- **Status:** `live`
- **Job:** Prototype post-book surface when trip stage is booked.
- **Inputs:** `MockBooking`; cancel/seat/baggage/traveller mutations.
- **Compose with:** Status chip, flight-now card, personal tiles, booking sections, prototype disclaimer.

#### Flight now card
- **Classes:** `.flight-now-card`, `.flight-status-block` (+ `.is-on-time` / `.is-cancelled`), `.flight-timeline-end`, `.flight-timeline-meta`, `.flight-timeline-time`, `.flight-timeline-rail`, `.flight-overnight`, `.flight-facility-chips`
- **Status:** `live`
- **Job:** Status headline + airport/time ends with rail duration (distinct from watchlist `FlightTimeline`).
- **Compose with:** `.booking-hero` / section stack.

#### Personal tiles
- **Classes:** `.flight-personal-tiles`, `.flight-personal-tile`, `.seat-tile`, `.booking-code-input`
- **Status:** `live` (`.flight-personal-tile-top` / `.flight-personal-tile-body` → `orphaned` substructure unused by current JSX)
- **Job:** Confirmation code input + seat tile.
- **Compose with:** BookedFlight.

#### Notes / route history
- **Classes:** `.notes-tile` (+ `.placeholder`), `.route-history-stats`, `.route-history-empty`, `.flight-facts`
- **Status:** `orphaned`
- **Do not use when:** Booked flight — current screen uses good-to-know list + mock activity instead.

#### Booking sections
- **Classes:** `.booking-section`, `.booking-section-heading`, `.booking-traveller-row`, `.good-to-know-list`, `.booking-receipt`, `.booking-receipt-lines`, `.booking-receipt-total`, `.booking-receipt-card`, `.prototype-disclaimer`
- **Status:** `live`
- **Job:** Traveller row, tips, updates, receipt, prototype note.
- **Compose with:** traveller avatar/main, mock activity list.

#### Mock activity / seat / cancel panels
- **Classes:** `.mock-activity-list`, `.mock-action-panel` (+ `.danger-panel`), `.mock-action-heading`, `.seat-picker`, `.mock-confirm-action`
- **Status:** `live`
- **Job:** Prototype updates timeline and amber/coral action confirmations.
- **Compose with:** BookedFlight sheets/panels.

---

### Stage chrome (copy helpers)

Not separate CSS atoms — wire stage into existing chrome:

| Stage | Typical live surface |
| --- | --- |
| `stopped` | Settings intro “Trip stopped”; empty trip hero |
| `booked` | `BookedFlight` instead of Flights tabs; BookingCard in settings |
| `paused` | `.eyebrow` “Tracking paused”; pause controls |
| `stale` | `stageLabel` “Prices stale”; Track + Stop controls |
| `searching` | `.results-empty.searching`; header meta “Searching” |
| `tracking` | Relative “Checked…” / “Next check…” via `stageLabel` |

---

### Misc / unused heading atoms

#### Section heading / section label
- **Classes:** `.section-heading`, `.section-label`
- **Status:** `orphaned` (responsive rules still mention `.section-heading`)
- **Do not use when:** Prefer `.eyebrow` + local headings (`.profile-section-heading`, `.flight-details-heading`, `.booking-section-heading`).

#### Icons
- **Components:** `FilterIcon`, `ChevronRightIcon`, `CloseIcon`, `FlightIcon`, `SearchRadarIcon` in `icons.tsx`
- **Status:** `live`
- **Job:** Stroke icons for filter chrome and empty searching state.
- **Compose with:** Browse toolbar, ResultsEmpty, sheets.

---

## 3. Reuse-first rules

1. **Search this catalog** before adding a class or component.
2. **Ignore `orphaned` entries** when generating new UI — they are leftover CSS only.
3. **Compose live atoms** for new jobs (e.g. a day filter → FilterSheet choice rows or tabs + `.recommendation-card` list — do not invent a third offer card).
4. **Add a new component only** when no live entry covers the job; then document it here with status `live`.
5. **Canonical prefers**
   - Offer presentation → `.recommendation-card` (App `OfferRow` uses this)
   - Payment → live `Payment.tsx` fixture + `.entity-row` / `.read-only-field`
   - Profile chrome → `.topbar` + `.tabs` (not `.profile-header` / `.profile-tabs`)
   - Itinerary on watchlist → `FlightTimeline`; on booked mock → `.flight-timeline-end` / rail recipe

### Known drift

**Fixed (conformance pass):** panel fills use `var(--panel)` / `var(--panel-soft)`; sheet-exit-aligned transitions use `--duration-sheet-exit`; orphaned `.offer-row` / payment-card / invoice CSS and unused `Invoices` / `DuffelCardMount` modules removed; Payment/TripSettings spacing via CSS adjacency rules.

**Still open:**

- **Radius sprawl:** cards use `--radius-card` (19px); controls/forms use 7–15px; sheets 22px; pills often `99px`.
- **Peer-plot pin:** soft ring (`box-shadow: 0 0 0 4px …`) — local exception to “no glow” guidance.
- **Leftover CSS:** `.mock-pill`, `.tag`, `.profile-header` / `.profile-tabs`, `.secure-summary`, `.section-heading`, `.card-form*` remain unmounted — treat as `orphaned`, do not revive without documenting.
