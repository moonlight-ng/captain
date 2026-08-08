# Captain design catalog

Source of truth for **existing** web UI: `apps/captain/src/styles.css` and
mounted screens/components under `apps/captain/src/`.

This file is a **utility catalog**. Assemble new screens from live entries. Do not invent parallel cards or offer layouts.

The primary experience is the chronological City → Flight → City composition
in `screens/MultiCityTrip.tsx`, its per-leg date comparison, and the public
canonical flight page. The tracking dashboard, stage labels, price-history
cards, and tracking controls catalogued below are legacy fallback components;
do not use them for a trip that has `cities` and `legs`.

Captain plans and manually searches flights. It has no booking, payment,
automatic tracking, alert, or traveller-identity surface, and nothing here
should reintroduce one.

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

Focus-visible: `2px solid rgba(255,255,255,.82)` + `3px` offset. Primary actions ~44px min height. Status is always carried by text as well as color — the price verdict reads “Good time to buy”, never a bare green chip. The price chart labels its low and high and carries a full sentence in `aria-label`, so it is never the only way to get the numbers. Icons: stroke SVG in `components/icons.tsx` (~14–22px).

### Trip stage vocabulary (`trip-stage.ts`)

Stages: `stopped` | `paused` | `stale` | `searching` | `tracking`. `stageLabel()` feeds trip header meta and Trip Settings tracking summary. Not a visual component — compose with `.trip-meta`, disclosure `em`, or notices.

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
- **Job:** Trip results only — Top picks / Airlines / All flights. Profile is a single page with no tabs.
- **Inputs:** Selected tab id; optional badge counts.
- **Compose with:** `.shell`. Sits **below** the tracked flight card, never above it.

### Feedback

#### Notices
- **Classes:** `.notice`, `.notice-delay`, `.notice-mock-success`
- **Status:** `live`
- **Job:** Error/interrupt (coral); soft delay/info (sage).
- **Inputs:** Short message string; `role="status"` / `alert` as appropriate.
- **Compose with:** Trip shell, above the tracked flight card.

#### Form error
- **Classes:** `.form-error`
- **Status:** `live`
- **Job:** Inline save/API failure under forms.
- **Compose with:** AccountPreferences, TripSettings.

#### Set note
- **Classes:** `.set-note`
- **Status:** `live`
- **Job:** Quiet helper copy under panels — price-history read, evidence provenance, watchlist panels.
- **Compose with:** Almost any card or empty.

#### Results empty
- **Classes / components:** `.results-empty` (+ `.compact`, `.searching`), `ResultsEmpty` in `App.tsx`
- **Status:** `live`
- **Job:** No offers / searching / compact in-panel empties; searching pulses icon well.
- **Inputs:** Searching vs needs-manual-search vs completed; optional primary search button.
- **Compose with:** FlightsTab, AirlinesTab, BrowseTab, WatchlistDetail miss.

### Actions

#### Trip controls / save
- **Classes:** `.trip-controls` (+ `.primary`, `.danger`), `.save-button`
- **Status:** `live`
- **Job:** Pause / resume / refresh / stop; full-width form saves.
- **Inputs:** Busy/disabled; confirm on stop.
- **Compose with:** Tracking disclosure, AccountPreferences, trip brief.

#### Primary / secondary sheet CTAs
- **Classes:** `.primary-action`, `.secondary-action`
- **Status:** `live`
- **Job:** Pill CTAs in the filter sheet footer.
- **Compose with:** `.filter-sheet` footer, `.traveller-book-row`, `.traveller-sheet-form`.

#### Icon button
- **Classes:** `.icon-button`
- **Status:** `live`
- **Job:** 34×34 close control on sheets.
- **Inputs:** `aria-label`; SVG child (`CloseIcon`).
- **Compose with:** FilterSheet header.

### Status chips and badges

#### Pill / tag
- **Classes:** `.pill`, `.tag`
- **Status:** `.pill` → `live`; `.tag` → `orphaned` (alias unused in TSX)
- **Job:** “Your preference”, “Watching”, “Mixed” on cards.
- **Compose with:** `.card-top`, `.airline-card-title`.
- **Do not use when:** Prototype labelling — that was `.mock-pill` (orphaned).

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

### The watched flight

#### Tracked flight card
- **Classes / components:** `.tracked-card`, `.tracked-top`, `.tracked-headline`, `.tracked-change` (+ `.up` / `.down`), `.tracked-read`, `.tracked-foot`, `.tracked-more`, `TrackedFlightCard`
- **Status:** `live`
- **Job:** The one flight being watched, and whether now is the moment to buy. Sage-tinted so it reads as the answer, not another result.
- **Inputs:** `TrackedPriceHistory`; the matching `VerifiedOffer` when it is still in the verified set; `onOpen`.
- **Compose with:** `.eyebrow`, `.verdict-pill`, `PriceChart`, `.price`.
- **Placement:** Directly under `.trip-heading`, **above** `.tabs`. Exactly one per trip, and only once a flight is watched.
- **Do not use when:** Showing an option the traveller has not chosen — that is a recommendation card.

#### Verdict pill
- **Classes:** `.verdict-pill` (+ `.book_now` / `.wait`; `.good_price` and `.holding` are neutral)
- **Status:** `live`
- **Job:** Captain's read on the watched fare, in words.
- **Inputs:** `PriceVerdict` from `summarizePriceHistory` — never a locally computed judgement.
- **Compose with:** `.tracked-top`.
- **Do not use when:** Any status that is not a price verdict — use `.pill`.

#### Price chart
- **Classes / components:** `.tracked-chart`, `.tracked-chart-plot`, `.tracked-chart-line`, `.tracked-chart-fill`, `.tracked-chart-now`, `.tracked-chart-empty`, `PriceChart`
- **Status:** `live`
- **Job:** One fare over time. Area + line, low/high in the caption, a dot at today.
- **Inputs:** `TrackedPriceHistory`; optional `height` (64 on the card, 110 in detail).
- **Notes:** The SVG stretches with `preserveAspectRatio="none"`, so the “now” dot is a positioned element outside it — drawn inside it would be an ellipse and clipped at the edge. Under two points it renders `.tracked-chart-empty` instead of a misleading flat line.
- **Compose with:** `.tracked-card`, watchlist detail panel, `.tracked-stats`.

#### Tracked stats
- **Classes:** `.tracked-stats`
- **Status:** `live`
- **Job:** Now / Lowest / Highest / Average under the detail chart.
- **Compose with:** `.watchlist-panel`, `PriceChart`.

---

### Result cards and lists

#### Recommendation card (canonical offer card)
- **Classes / components:** `.recommendation-card` (+ `.selected`), `.recommendation-grid`, `RecommendationCard`, `OfferRow` (App)
- **Status:** `live`
- **Job:** Ranked suggestion or browsable/watched offer: mode/airline label, optional pill, price, metrics, schedule spine.
- **Inputs:** `VerifiedOffer`; ranking mode or airline name; selected/watching flag; `onOpen`.
- **Compose with:** `.card-top`, `.mode-label`, `.pill`, `.price`, `.metrics`, `ScheduleSpine`.
- **Do not use when:** Inventing a second offer-card layout — App `OfferRow` already mounts this class. Also never for the watched flight: that is the tracked flight card.

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
- **Do not use when:** Showing how a fare moved over time — that is the tracked flight chart.

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
- **Do not use when:** Anything but sort/filter — the filter sheet is the only sheet Captain mounts.

---

### Settings

#### Settings card / disclosure
- **Classes:** `.settings-card`, `.settings-disclosure`, `.settings-body`, `.settings-list`
- **Status:** `live`
- **Job:** Collapsible settings sections (Tracking, Brief, Activity, Notifications, Flight preferences) or a static card shell.
- **Inputs:** Summary title + `em` meta; body form or dl.
- **Compose with:** `.trip-controls`, `.form-grid`, `.ranking-options`, `.switch-setting`, `.read-only-field`, `.entity-row`, AirlineSearchSelect.

#### Read-only field
- **Classes:** `.read-only-field`
- **Status:** `live`
- **Job:** Bordered read-only value (multi-city route note).
- **Compose with:** Trip brief.

#### Entity row
- **Classes:** `.entity-row`
- **Status:** `live`
- **Job:** Horizontal action/meta row inside a settings body.
- **Compose with:** Settings body, `.read-only-field` / `.settings-list` (adjacent spacing via CSS).

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
- **Compose with:** Trip brief, AccountPreferences.

#### Airline search select
- **Classes / components:** `.airline-search`, `.airline-search-field`, `.airline-chip`, `.airline-search-results`, `AirlineSearchSelect`
- **Status:** `live`
- **Job:** Multi-select airline chips with typeahead.
- **Inputs:** Code list; onChange; placeholder.
- **Compose with:** Trip brief preferred/excluded; AccountPreferences.

### Stage chrome (copy helpers)

Not separate CSS atoms — wire stage into existing chrome:

| Stage | Typical live surface |
| --- | --- |
| `stopped` | Settings intro “Trip stopped”; empty trip hero |
| `paused` | `.eyebrow` “Tracking paused”; pause controls |
| `stale` | `stageLabel` “Prices stale”; Track + Stop controls |
| `searching` | `.results-empty.searching`; header meta “Searching” |
| `tracking` | Relative “Checked…” / “Next check…” via `stageLabel` |

---

### Known drift

**Fixed:** panel fills use `var(--panel)` / `var(--panel-soft)`; sheet-exit-aligned transitions use `--duration-sheet-exit`. Every booking, payment, and traveller class was deleted along with its component, and `styles.css` now contains no rule whose selector cannot match the mounted tree.

**Still open:**

- **Radius sprawl:** cards use `--radius-card` (19px); controls/forms use 7–15px; sheets 22px; pills often `99px`.
- **Peer-plot pin:** soft ring (`box-shadow: 0 0 0 4px …`) — local exception to “no glow” guidance.
- **Two price visualisations:** the tracked flight card charts one fare over time; the peer plot places one fare against its peers. They answer different questions and deliberately look different, but a reader can mistake one for the other.
