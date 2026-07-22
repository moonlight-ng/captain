export type Cabin = "economy" | "premium_economy" | "business" | "first";

export type FlightSearchSlice = {
  origin: string;
  destination: string;
  departureDate: string;
};

export type FlightSearchRequest = {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  slices?: FlightSearchSlice[];
  adults: number;
  childrenAges: number[];
  infants: number;
  cabin: Cabin;
  maxStops: number;
  currency: string;
  limit: number;
  sort: "price" | "duration";
};

export type FlightSegment = {
  airline: string;
  airlineCode: string;
  flightNumber: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  durationSeconds: number;
  cabin?: string;
};

export type FlightRoute = {
  segments: FlightSegment[];
  durationSeconds: number;
  stops: number;
  route: string;
};

export type FlightOffer = {
  id: string;
  price: number;
  currency: string;
  airlines: string[];
  ownerAirline: string;
  ownerAirlineCode: string;
  route: string;
  durationSeconds: number;
  stops: number;
  routes: FlightRoute[];
  outbound: FlightRoute;
  inbound?: FlightRoute;
  conditions: Record<string, string>;
  rawOffer: unknown;
};

export type FlightSearchResult = {
  provider: "duffel";
  searchId: string;
  totalResults: number;
  offers: FlightOffer[];
  searchedAt: string;
};
