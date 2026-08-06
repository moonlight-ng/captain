export type RankingMode = "cheapest" | "balanced" | "fastest";
export type NotificationMode = "smart" | "daily" | "changes_only" | "off";

export type TravellerProfile = {
  userId: string;
  timeZone: string;
  defaultCurrency: string;
  rankingMode: RankingMode;
  preferredAirlineCodes: string[];
  excludedAirlineCodes: string[];
  alertsEnabled: boolean;
  notificationMode: NotificationMode;
  digestHourLocal: number;
  priceRiseAlertsEnabled: boolean;
  betterOptionAlertsEnabled: boolean;
  maxAlertsPerDay: 1 | 2;
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  onboardingCompletedAt: string | null;
  onboardingStep: "welcome" | "currency" | "ranking" | "airlines" | "complete";
  createdAt: string;
  updatedAt: string;
};

export type Trip = {
  id: string;
  title: string;
  status: "draft" | "tracking" | "recommended" | "paused";
  version: number;
  brief: {
    originAirports: string[];
    destinationAirports: string[];
    tripType: "one_way" | "round_trip" | "multi_city";
    departureWindow: { start: string; end: string };
    legs?: Array<{
      originAirports: string[];
      destinationAirports: string[];
      departureWindow: { start: string; end: string };
    }>;
    stayNights: {
      minimum: number;
      preferred: number;
      maximum: number;
    } | null;
    travellers: {
      adults: 1;
      childrenAges: never[];
      infants: 0;
    };
    cabin: string;
    maxStops: number;
    currency: string;
    maximumPrice: number | null;
    preferredAirlines: string[];
    excludedAirlines: string[];
    context: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type Watch = {
  status: "active" | "scheduled" | "paused" | "completed";
  runStartedAt: string;
  runEndsAt: string;
  completedAt: string | null;
  checksCompleted: number;
  nextCheckAt: string | null;
  lastCheckAt: string | null;
  lastManualRefreshAt: string | null;
  trackingStartsAt: string | null;
  baselineCompletedAt: string | null;
  activatedAt: string | null;
  lastUserActivityAt: string;
  priceRiseItineraryKey: string | null;
  priceRiseArmed: boolean;
  delayedAt: string | null;
  delayReason: string | null;
};

export type Segment = {
  airlineCode: string;
  airline: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
};

export type VerifiedOffer = {
  id: string;
  itineraryKey: string;
  provider: "flysoar_mcp" | `official_${string}`;
  price: number;
  priceAmount: string;
  currency: string;
  fareBasis: "one_adult_total";
  primaryAirlineCode: string;
  participatingAirlineCodes: string[];
  evidence: Array<{ url: string; title: string; domain: string }>;
  verifiedAt: string;
  observedAt: string;
  snapshot: {
    route?: string;
    flightNumbers?: string[];
    stops?: number;
    durationSeconds?: number;
    segments?: Segment[];
  };
};

export type Recommendation = {
  tripId: string;
  offerId: string | null;
  itineraryKey: string;
  score: number;
  rankingMode: RankingMode;
  summary: string;
  observedAt: string;
};

export type TripPayload = {
  trips: Trip[];
  trip: Trip | null;
  watch: Watch | null;
  offers: VerifiedOffer[];
  recommendation: Recommendation | null;
  selections: Array<{ itineraryKey: string; selectedBy: "agent" | "person" }>;
  activity: TripActivity[];
};

export type TripActivity = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type BrowseSort = "recommended" | "price" | "duration" | "departure";

export type BrowsePreferences = {
  sort: BrowseSort;
  stops: number[];
  airlines: string[];
  airports: string[];
  maximumPrice: number | null;
  departurePeriods: Array<"morning" | "afternoon" | "evening">;
};

export const EMPTY_BROWSE_PREFERENCES: BrowsePreferences = {
  sort: "recommended",
  stops: [],
  airlines: [],
  airports: [],
  maximumPrice: null,
  departurePeriods: []
};

export function departurePeriod(value: string): "morning" | "afternoon" | "evening" {
  const hour = new Date(value).getHours();
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

export function offerAirports(offer: VerifiedOffer): string[] {
  const segments = offer.snapshot.segments ?? [];
  if (segments.length > 0) {
    return [...new Set(segments.flatMap((segment) => [segment.origin, segment.destination]))];
  }
  return [...new Set((offer.snapshot.route ?? "").match(/[A-Z]{3}/gu) ?? [])];
}

export function offerDeparture(offer: VerifiedOffer): string | null {
  return offer.snapshot.segments?.[0]?.departure ?? null;
}

export function sortAndFilterOffers(
  offers: readonly VerifiedOffer[],
  preferences: BrowsePreferences
): VerifiedOffer[] {
  const filtered = offers.filter((offer) => {
    const stops = Number(offer.snapshot.stops) || 0;
    if (preferences.stops.length > 0 && !preferences.stops.includes(stops)) return false;
    if (preferences.airlines.length > 0 && !preferences.airlines.includes(offer.primaryAirlineCode)) {
      return false;
    }
    if (
      preferences.airports.length > 0
      && !preferences.airports.some((airport) => offerAirports(offer).includes(airport))
    ) {
      return false;
    }
    if (preferences.maximumPrice !== null && offer.price > preferences.maximumPrice) return false;
    if (preferences.departurePeriods.length > 0) {
      const departure = offerDeparture(offer);
      if (!departure || !preferences.departurePeriods.includes(departurePeriod(departure))) {
        return false;
      }
    }
    return true;
  });
  return [...filtered].sort((left, right) => {
    if (preferences.sort === "price") {
      return left.price - right.price || left.itineraryKey.localeCompare(right.itineraryKey);
    }
    if (preferences.sort === "duration") {
      return (Number(left.snapshot.durationSeconds) || 0) - (Number(right.snapshot.durationSeconds) || 0)
        || left.price - right.price
        || left.itineraryKey.localeCompare(right.itineraryKey);
    }
    if (preferences.sort === "departure") {
      const leftDeparture = Date.parse(offerDeparture(left) ?? "") || Number.POSITIVE_INFINITY;
      const rightDeparture = Date.parse(offerDeparture(right) ?? "") || Number.POSITIVE_INFINITY;
      return leftDeparture - rightDeparture
        || left.price - right.price
        || left.itineraryKey.localeCompare(right.itineraryKey);
    }
    return left.price - right.price
      || (Number(left.snapshot.durationSeconds) || 0) - (Number(right.snapshot.durationSeconds) || 0)
      || left.itineraryKey.localeCompare(right.itineraryKey);
  });
}
