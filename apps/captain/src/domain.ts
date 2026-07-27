export type RankingMode = "cheapest" | "balanced" | "fastest";

export type TravellerProfile = {
  userId: string;
  timeZone: string;
  defaultCurrency: string;
  rankingMode: RankingMode;
  preferredAirlineCodes: string[];
  excludedAirlineCodes: string[];
  alertsEnabled: boolean;
  maxAlertsPerDay: 1 | 2;
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  onboardingCompletedAt: string | null;
  onboardingStep: "currency" | "ranking" | "airlines" | "complete";
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
  status: "active" | "paused" | "completed";
  nextCheckAt: string | null;
  lastCheckAt: string | null;
  lastManualRefreshAt: string | null;
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
  provider: "openai_web" | `official_${string}`;
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
