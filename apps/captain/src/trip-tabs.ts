export const TRIP_TABS = ["plan", "flights", "feed"] as const;

export type TripTab = (typeof TRIP_TABS)[number];

export const TRIP_TAB_LABELS: Record<TripTab, string> = {
  plan: "Plan",
  flights: "Flights",
  feed: "Feed"
};

type TripTabState = { status: "draft" | "tracking" | "recommended" | "paused" } | null;

export function defaultTripTab(trip: TripTabState): TripTab {
  return trip?.status === "draft" ? "plan" : "feed";
}

export function orderedTripTabs(trip: TripTabState): readonly TripTab[] {
  return defaultTripTab(trip) === "plan"
    ? TRIP_TABS
    : ["feed", "flights", "plan"];
}
