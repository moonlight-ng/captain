export const TRIP_TABS = ["plan", "flights", "watchlist"] as const;

export type TripTab = (typeof TRIP_TABS)[number];

export const TRIP_TAB_LABELS: Record<TripTab, string> = {
  plan: "Plan",
  flights: "Flights",
  watchlist: "Watchlist"
};

type TripTabState = { status: "draft" | "tracking" | "recommended" | "paused" } | null;

export function defaultTripTab(trip: TripTabState): TripTab {
  return trip?.status === "draft" ? "plan" : "watchlist";
}

export function orderedTripTabs(trip: TripTabState): readonly TripTab[] {
  return defaultTripTab(trip) === "plan"
    ? TRIP_TABS
    : ["watchlist", "flights", "plan"];
}
