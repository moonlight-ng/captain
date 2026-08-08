import { createHash } from "node:crypto";

import {
  FlightSearchProviderError,
  MAX_MANUAL_SEARCH_DAYS,
  deriveOfferMetrics,
  type CanonicalFlight,
  type FlightOfferSnapshot,
  type FlightSearchProvider,
  type FlightSearchProviderErrorCode,
  type LegSearchAnalysis,
  type LegSearchPick,
  type LegSearchSnapshot,
  type LegSearchSnapshotRevision,
  type SearchSpecRequest,
  type Trip,
  type TripCity,
  type TripCityLeg,
  type VerifiedOfferCandidate
} from "@agents/flight-domain";
import type { CaptainPlatformStore } from "@agents/flight-store";

const SEARCH_CONCURRENCY = 3;
const MAX_STORED_FLIGHTS = 120;
const MAX_STORED_OFFERS = 240;
const INACTIVE_TRIP_STATUSES = new Set(["cancelled", "completed", "archived"]);

export type LegSearchInput = {
  tripId: string;
  legId: string;
  requestedWindow?: { start: string; end: string } | undefined;
};

export type LegSearchResult = {
  status:
    | LegSearchSnapshot["status"]
    | "not_found"
    | "trip_inactive"
    | "invalid_window"
    | "window_too_large"
    | "provider_unavailable"
    | "conflict";
  code: string | null;
  message: string;
  snapshot: LegSearchSnapshot | null;
  previousSnapshot: LegSearchSnapshot | null;
  coverage: {
    datesRequested: number;
    datesCompleted: number;
    label: string;
    complete: boolean;
  } | null;
  reusedDates: string[];
  searchedDates: string[];
  canClaimCheapestAcrossRange: boolean;
};

type SearchState = {
  datesRequested: string[];
  datesCompleted: Set<string>;
  failedDates: Map<string, string>;
  flights: Map<string, CanonicalFlight>;
  offers: Map<string, FlightOfferSnapshot>;
  preferredAirlineCodes: Set<string>;
  latestObservation: string | null;
};

type DateSearchOutcome = {
  date: string;
  success: boolean;
  errorCode: string | null;
  flights: CanonicalFlight[];
  offers: FlightOfferSnapshot[];
  observedAt: string;
};

type PreparedSearch = {
  trip: Trip;
  leg: TripCityLeg;
  origin: TripCity;
  destination: TripCity;
  previousSnapshot: LegSearchSnapshot | null;
  snapshot: LegSearchSnapshot;
  state: SearchState;
  reusedDates: string[];
  searchedDates: string[];
};

export class LegSearchService {
  readonly #store: CaptainPlatformStore;
  readonly #provider: FlightSearchProvider | null;
  readonly #now: () => Date;

  constructor(options: {
    store: CaptainPlatformStore;
    provider: FlightSearchProvider | null;
    now?: () => Date;
  }) {
    this.#store = options.store;
    this.#provider = options.provider;
    this.#now = options.now ?? (() => new Date());
  }

  getFlight(flightKey: string): Promise<{
    flight: CanonicalFlight;
    offers: FlightOfferSnapshot[];
  } | null> {
    return this.#store.getCanonicalFlight(flightKey.trim(), this.#now());
  }

  async get(
    userId: string,
    tripId: string,
    legId: string,
    searchId: string
  ): Promise<LegSearchSnapshot | null> {
    const snapshot = await this.#store.getLegSearchSnapshot(userId, searchId);
    return snapshot?.tripId === tripId && snapshot.legId === legId ? snapshot : null;
  }

  /**
   * Return a durable running snapshot immediately, then finish the exact-date
   * fan-out triggered by this request. This is not a scheduled/background
   * tracker: there is no recurring work after this one manual search.
   */
  async start(userId: string, input: LegSearchInput): Promise<LegSearchResult> {
    const prepared = await this.#prepare(userId, input);
    if (!("trip" in prepared)) return prepared;
    const running = await this.#begin(userId, prepared);
    if (!("trip" in running)) return running;
    void this.#finish(userId, running).catch((error) => {
      console.error(JSON.stringify({
        event: "captain.trip_leg_search_failed",
        search_id: running.snapshot.id,
        error: error instanceof Error ? error.name : "UnknownError"
      }));
    });
    return resultForSnapshot(
      running.snapshot,
      running.previousSnapshot,
      running.reusedDates,
      running.searchedDates
    );
  }

  async search(userId: string, input: LegSearchInput): Promise<LegSearchResult> {
    const prepared = await this.#prepare(userId, input);
    if (!("trip" in prepared)) return prepared;
    const running = await this.#begin(userId, prepared);
    if (!("trip" in running)) return running;
    return this.#finish(userId, running);
  }

  async #prepare(
    userId: string,
    input: LegSearchInput
  ): Promise<PreparedSearch | LegSearchResult> {
    const trip = await this.#store.getTrip(userId, input.tripId);
    if (!trip) {
      return resultWithoutSnapshot(
        "not_found",
        "trip_leg_not_found",
        "That flight leg could not be found.",
        null
      );
    }
    if (INACTIVE_TRIP_STATUSES.has(trip.status)) {
      return resultWithoutSnapshot(
        "trip_inactive",
        "trip_inactive",
        "Flights can only be searched for a current trip.",
        null
      );
    }

    const [leg, graph, previousSnapshot] = await Promise.all([
      this.#store.getTripLeg(userId, input.tripId, input.legId),
      this.#store.getTripGraph(userId, input.tripId),
      this.#store.getLatestLegSearchSnapshot(userId, input.tripId, input.legId)
    ]);

    if (!leg) {
      return resultWithoutSnapshot(
        "not_found",
        "trip_leg_not_found",
        "That flight leg could not be found.",
        previousSnapshot
      );
    }
    const origin = graph.cities.find((city) => city.id === leg.originCityId);
    const destination = graph.cities.find((city) => city.id === leg.destinationCityId);
    if (!origin || !destination) {
      return resultWithoutSnapshot(
        "not_found",
        "trip_route_incomplete",
        "The cities for that flight leg could not be found.",
        previousSnapshot
      );
    }

    const requestedWindow = input.requestedWindow ?? leg.departureWindow;
    const validation = validateWindow(requestedWindow, leg);
    if (!validation.ok) {
      return resultWithoutSnapshot(
        validation.status,
        validation.code,
        validation.message,
        previousSnapshot
      );
    }
    if (!this.#provider) {
      return resultWithoutSnapshot(
        "provider_unavailable",
        "provider_not_configured",
        "Live flight inventory is unavailable right now.",
        previousSnapshot
      );
    }

    const datesRequested = enumerateDates(requestedWindow.start, requestedWindow.end);
    const snapshot = await this.#store.createLegSearchSnapshot(
      userId,
      trip.id,
      leg.id,
      requestedWindow,
      datesRequested,
      this.#now()
    );
    const state = initialState(datesRequested, previousSnapshot, origin, destination, trip, this.#now());
    const reusedDates = orderedDates(state.datesCompleted, datesRequested);
    const searchedDates = datesRequested.filter((date) => !state.datesCompleted.has(date));

    return {
      trip,
      leg,
      origin,
      destination,
      previousSnapshot,
      snapshot,
      state,
      reusedDates,
      searchedDates
    };
  }

  async #begin(
    userId: string,
    prepared: PreparedSearch
  ): Promise<PreparedSearch | LegSearchResult> {
    const running = await this.#revise(
      userId,
      prepared.snapshot,
      prepared.state,
      "running",
      null
    );
    if (!running) {
      return conflictResult(prepared.previousSnapshot, prepared.snapshot);
    }
    return { ...prepared, snapshot: running };
  }

  async #finish(userId: string, prepared: PreparedSearch): Promise<LegSearchResult> {
    const {
      trip,
      leg,
      origin,
      destination,
      previousSnapshot,
      state,
      reusedDates,
      searchedDates
    } = prepared;
    let { snapshot } = prepared;

    if (searchedDates.length === 0) {
      const completed = await this.#revise(
        userId,
        snapshot,
        state,
        "completed",
        this.#now().toISOString()
      );
      if (!completed) return conflictResult(previousSnapshot, snapshot);
      return resultForSnapshot(completed, previousSnapshot, reusedDates, []);
    }

    let commitQueue = Promise.resolve();
    let conflicted = false;
    await runBounded(searchedDates, SEARCH_CONCURRENCY, async (date) => {
      const outcome = await this.#searchDate(trip, leg, origin, destination, date);
      commitQueue = commitQueue.then(async () => {
        if (conflicted) return;
        applyOutcome(state, outcome);
        const revised = await this.#revise(userId, snapshot, state, "running", null);
        if (!revised) {
          conflicted = true;
          return;
        }
        snapshot = revised;
      });
      await commitQueue;
    });
    await commitQueue;

    if (conflicted) return conflictResult(previousSnapshot, snapshot);

    const status = finalStatus(state);
    const completed = await this.#revise(
      userId,
      snapshot,
      state,
      status,
      this.#now().toISOString()
    );
    if (!completed) return conflictResult(previousSnapshot, snapshot);
    return resultForSnapshot(completed, previousSnapshot, reusedDates, searchedDates);
  }

  async #searchDate(
    trip: Trip,
    leg: TripCityLeg,
    origin: TripCity,
    destination: TripCity,
    date: string
  ): Promise<DateSearchOutcome> {
    const observedAt = this.#now().toISOString();
    try {
      const result = await this.#provider!.search(searchRequest(
        this.#provider!,
        trip,
        origin,
        destination,
        date
      ));
      const converted = canonicalizeOffers(
        result.offers,
        result.provider,
        origin,
        destination,
        trip,
        leg.arriveBy,
        date,
        this.#now().toISOString()
      );
      return {
        date,
        success: true,
        errorCode: null,
        flights: converted.flights,
        offers: converted.offers,
        observedAt: converted.observedAt
      };
    } catch (error) {
      return {
        date,
        success: false,
        errorCode: providerErrorCode(error),
        flights: [],
        offers: [],
        observedAt
      };
    }
  }

  async #revise(
    userId: string,
    snapshot: LegSearchSnapshot,
    state: SearchState,
    status: LegSearchSnapshot["status"],
    completedAt: string | null
  ): Promise<LegSearchSnapshot | null> {
    const revision = buildRevision(state, status, completedAt);
    return this.#store.reviseLegSearchSnapshot(
      userId,
      snapshot.id,
      snapshot.revision,
      revision,
      this.#now()
    );
  }
}

function searchRequest(
  provider: FlightSearchProvider,
  trip: Trip,
  origin: TripCity,
  destination: TripCity,
  date: string
): SearchSpecRequest {
  return {
    provider: provider.provider,
    apiVersion: "v1",
    tripType: "one_way",
    slices: [{
      originAirports: [...origin.airportCodes],
      destinationAirports: [...destination.airportCodes],
      departureStart: date,
      departureEnd: date
    }],
    stayNights: null,
    passenger: { adults: 1, childrenAges: [], infants: 0 },
    cabin: trip.brief.cabin,
    maxConnections: trip.brief.maxStops,
    currency: trip.brief.currency,
    maximumPrice: trip.brief.maximumPrice,
    fareContext: "public_beta"
  };
}

function canonicalizeOffers(
  candidates: VerifiedOfferCandidate[],
  provider: FlightOfferSnapshot["provider"],
  origin: TripCity,
  destination: TripCity,
  trip: Trip,
  arriveBy: string | null,
  date: string,
  observedAt: string
): { flights: CanonicalFlight[]; offers: FlightOfferSnapshot[]; observedAt: string } {
  const flights = new Map<string, CanonicalFlight>();
  const offers = new Map<string, FlightOfferSnapshot>();
  for (const candidate of candidates) {
    const slice = candidate.slices.length === 1 ? candidate.slices[0] : undefined;
    if (
      !slice
      || slice.departureDate !== date
      || !origin.airportCodes.includes(slice.origin)
      || !destination.airportCodes.includes(slice.destination)
      || (arriveBy !== null && slice.segments.at(-1)!.arrival.slice(0, 10) > arriveBy)
      || candidate.currency !== trip.brief.currency
      || candidate.cabin !== trip.brief.cabin
      || (candidate.expiresAt !== null
        && candidate.expiresAt !== undefined
        && Date.parse(candidate.expiresAt) <= Date.parse(observedAt))
      || (trip.brief.maximumPrice !== null
        && Number(candidate.priceAmount) > trip.brief.maximumPrice)
      || candidate.participatingAirlineCodes.some((code) =>
        trip.brief.excludedAirlines.includes(code)
      )
    ) continue;

    const metrics = deriveOfferMetrics([slice]);
    const flight: CanonicalFlight = {
      key: candidate.itineraryKey,
      origin: slice.origin,
      destination: slice.destination,
      departureDate: slice.departureDate,
      segments: slice.segments,
      primaryAirlineCode: candidate.primaryAirlineCode,
      participatingAirlineCodes: candidate.participatingAirlineCodes,
      stops: metrics.stops,
      durationMinutes: Math.max(1, Math.round(metrics.durationSeconds / 60))
    };
    flights.set(flight.key, flight);

    const offer: FlightOfferSnapshot = {
      offerId: candidate.providerOfferId ?? derivedOfferId(provider, candidate),
      flightKey: flight.key,
      provider,
      priceAmount: candidate.priceAmount,
      currency: candidate.currency,
      evidence: candidate.evidence,
      observedAt,
      expiresAt: candidate.expiresAt ?? null
    };
    const offerKey = `${offer.provider}\u0000${offer.offerId}\u0000${offer.flightKey}`;
    const current = offers.get(offerKey);
    if (!current || compareOffers(offer, current) < 0) offers.set(offerKey, offer);
  }
  return {
    flights: [...flights.values()].sort(compareFlights),
    offers: [...offers.values()].sort(compareOfferSnapshots),
    observedAt
  };
}

function derivedOfferId(
  provider: FlightOfferSnapshot["provider"],
  offer: VerifiedOfferCandidate
): string {
  return `derived_${createHash("sha256")
    .update(`${provider}\u0000${offer.itineraryKey}\u0000${offer.priceAmount}\u0000${offer.currency}`)
    .digest("hex")}`;
}

function initialState(
  datesRequested: string[],
  previous: LegSearchSnapshot | null,
  origin: TripCity,
  destination: TripCity,
  trip: Trip,
  now: Date
): SearchState {
  const state: SearchState = {
    datesRequested,
    datesCompleted: new Set(),
    failedDates: new Map(),
    flights: new Map(),
    offers: new Map(),
    preferredAirlineCodes: new Set(trip.brief.preferredAirlines),
    latestObservation: null
  };
  if (!previous) return state;

  for (const date of datesRequested) {
    if (!previous.analysis.datesCompleted.includes(date)) continue;
    const dateFlights = previous.flights.filter((flight) =>
      flight.departureDate === date
      && origin.airportCodes.includes(flight.origin)
      && destination.airportCodes.includes(flight.destination)
    );
    const flightKeys = new Set(dateFlights.map((flight) => flight.key));
    const currentOffers = previous.offers.filter((offer) =>
      flightKeys.has(offer.flightKey)
      && offer.currency === trip.brief.currency
      && isUnexpired(offer, now)
    );
    const offeredFlightKeys = new Set(currentOffers.map((offer) => offer.flightKey));
    const reusableFlights = dateFlights.filter((flight) => offeredFlightKeys.has(flight.key));
    if (reusableFlights.length === 0) continue;

    state.datesCompleted.add(date);
    for (const flight of reusableFlights) state.flights.set(flight.key, flight);
    for (const offer of currentOffers) {
      state.offers.set(`${offer.provider}\u0000${offer.offerId}\u0000${offer.flightKey}`, offer);
      state.latestObservation = latestIso(state.latestObservation, offer.observedAt);
    }
  }
  return state;
}

function applyOutcome(state: SearchState, outcome: DateSearchOutcome): void {
  if (outcome.success) {
    state.datesCompleted.add(outcome.date);
    state.failedDates.delete(outcome.date);
    for (const flight of outcome.flights) state.flights.set(flight.key, flight);
    for (const offer of outcome.offers) {
      state.offers.set(`${offer.provider}\u0000${offer.offerId}\u0000${offer.flightKey}`, offer);
    }
    state.latestObservation = latestIso(state.latestObservation, outcome.observedAt);
    return;
  }
  state.failedDates.set(outcome.date, outcome.errorCode ?? "unknown");
}

function buildRevision(
  state: SearchState,
  status: LegSearchSnapshot["status"],
  completedAt: string | null
): LegSearchSnapshotRevision {
  const allFlights = [...state.flights.values()];
  const allOffers = [...state.offers.values()];
  const analysis = analyze(state, allFlights, allOffers);
  const retained = retainSnapshotResults(allFlights, allOffers, analysis);
  return {
    status,
    analysis,
    flights: retained.flights,
    offers: retained.offers,
    completedAt
  };
}

export function analyzeLegSearch(
  datesRequested: string[],
  datesCompleted: string[],
  failedDates: Array<{ date: string; code: string }>,
  flights: CanonicalFlight[],
  offers: FlightOfferSnapshot[],
  observedAt: string | null,
  preferredAirlineCodes: string[] = []
): LegSearchAnalysis {
  return analyze({
    datesRequested,
    datesCompleted: new Set(datesCompleted),
    failedDates: new Map(failedDates.map((failure) => [failure.date, failure.code])),
    flights: new Map(flights.map((flight) => [flight.key, flight])),
    offers: new Map(offers.map((offer) => [
      `${offer.provider}\u0000${offer.offerId}\u0000${offer.flightKey}`,
      offer
    ])),
    preferredAirlineCodes: new Set(preferredAirlineCodes),
    latestObservation: observedAt
  }, flights, offers);
}

function analyze(
  state: SearchState,
  flights: CanonicalFlight[],
  offers: FlightOfferSnapshot[]
): LegSearchAnalysis {
  const flightByKey = new Map(flights.map((flight) => [flight.key, flight]));
  const bestOffers = bestOfferPerFlight(offers, flightByKey);
  const choices = [...bestOffers.values()].map(({ flight, offer }) => ({
    flight,
    offer,
    price: Number(offer.priceAmount)
  }));
  const cheapestChoice = [...choices].sort(compareCheapest)[0] ?? null;
  const fastestChoice = [...choices].sort(compareFastest)[0] ?? null;
  const balancedChoice = chooseBalanced(choices, state.preferredAirlineCodes);
  const cheapestByDate = state.datesRequested.flatMap((date) => {
    const choice = choices
      .filter((candidate) => candidate.flight.departureDate === date)
      .sort(compareCheapest)[0];
    return choice ? [toPick(choice.flight, choice.offer)] : [];
  });
  const datesCompleted = orderedDates(state.datesCompleted, state.datesRequested);
  const failedDates = state.datesRequested.flatMap((date) => {
    const code = state.failedDates.get(date);
    return code ? [{ date, code }] : [];
  });
  return {
    complete: datesCompleted.length === state.datesRequested.length && failedDates.length === 0,
    datesRequested: state.datesRequested,
    datesCompleted,
    failedDates,
    optionsChecked: flights.length,
    cheapest: cheapestChoice ? toPick(cheapestChoice.flight, cheapestChoice.offer) : null,
    fastest: fastestChoice ? toPick(fastestChoice.flight, fastestChoice.offer) : null,
    balanced: balancedChoice ? toPick(balancedChoice.flight, balancedChoice.offer) : null,
    cheapestByDate,
    observedAt: state.latestObservation
  };
}

type Choice = { flight: CanonicalFlight; offer: FlightOfferSnapshot; price: number };

function bestOfferPerFlight(
  offers: FlightOfferSnapshot[],
  flights: Map<string, CanonicalFlight>
): Map<string, { flight: CanonicalFlight; offer: FlightOfferSnapshot }> {
  const best = new Map<string, { flight: CanonicalFlight; offer: FlightOfferSnapshot }>();
  for (const offer of offers) {
    const flight = flights.get(offer.flightKey);
    if (!flight) continue;
    const current = best.get(flight.key);
    if (!current || compareOffers(offer, current.offer) < 0) best.set(flight.key, { flight, offer });
  }
  return best;
}

function chooseBalanced(choices: Choice[], preferredAirlineCodes: Set<string>): Choice | null {
  if (choices.length === 0) return null;
  const minimumPrice = Math.min(...choices.map((choice) => choice.price));
  const minimumDuration = Math.min(...choices.map((choice) => choice.flight.durationMinutes));
  const maximumStops = Math.max(1, ...choices.map((choice) => choice.flight.stops));
  return [...choices].sort((left, right) => {
    const score = (choice: Choice) => {
      const priceRegret = Math.min(1, Math.max(0, choice.price / Math.max(minimumPrice, 0.001) - 1));
      const durationRegret = Math.min(
        1,
        Math.max(0, choice.flight.durationMinutes / Math.max(minimumDuration, 1) - 1)
      );
      return priceRegret * 0.5
        + durationRegret * 0.35
        + choice.flight.stops / maximumStops * 0.15
        - (choice.flight.participatingAirlineCodes.some((code) => preferredAirlineCodes.has(code))
          ? 0.08
          : 0);
    };
    return score(left) - score(right) || compareCheapest(left, right);
  })[0] ?? null;
}

function retainSnapshotResults(
  flights: CanonicalFlight[],
  offers: FlightOfferSnapshot[],
  analysis: LegSearchAnalysis
): { flights: CanonicalFlight[]; offers: FlightOfferSnapshot[] } {
  const requiredKeys = new Set([
    analysis.cheapest?.flightKey,
    analysis.fastest?.flightKey,
    analysis.balanced?.flightKey,
    ...analysis.cheapestByDate.map((pick) => pick.flightKey)
  ].filter((key): key is string => Boolean(key)));
  const flightByKey = new Map(flights.map((flight) => [flight.key, flight]));
  const bestOffers = bestOfferPerFlight(offers, flightByKey);
  const byRelevance = [...flights].sort((left, right) => {
    const leftRequired = requiredKeys.has(left.key) ? 0 : 1;
    const rightRequired = requiredKeys.has(right.key) ? 0 : 1;
    if (leftRequired !== rightRequired) return leftRequired - rightRequired;
    const leftOffer = bestOffers.get(left.key)?.offer;
    const rightOffer = bestOffers.get(right.key)?.offer;
    if (leftOffer && rightOffer) {
      return Number(leftOffer.priceAmount) - Number(rightOffer.priceAmount) || compareFlights(left, right);
    }
    return leftOffer ? -1 : rightOffer ? 1 : compareFlights(left, right);
  }).slice(0, MAX_STORED_FLIGHTS).sort(compareFlights);
  const retainedKeys = new Set(byRelevance.map((flight) => flight.key));
  const eligibleOffers = offers.filter((offer) => retainedKeys.has(offer.flightKey));
  const requiredOffers = [...bestOffers.values()]
    .filter(({ flight }) => retainedKeys.has(flight.key))
    .map(({ offer }) => offer)
    .sort(compareOfferSnapshots);
  const requiredOfferKeys = new Set(requiredOffers.map(snapshotOfferKey));
  const remainingOffers = eligibleOffers
    .filter((offer) => !requiredOfferKeys.has(snapshotOfferKey(offer)))
    .sort(compareOfferSnapshots);
  return {
    flights: byRelevance,
    offers: [...requiredOffers, ...remainingOffers].slice(0, MAX_STORED_OFFERS)
  };
}

function toPick(flight: CanonicalFlight, offer: FlightOfferSnapshot): LegSearchPick {
  return {
    flightKey: flight.key,
    departureDate: flight.departureDate,
    priceAmount: offer.priceAmount,
    currency: offer.currency,
    durationMinutes: flight.durationMinutes,
    stops: flight.stops
  };
}

function compareCheapest(left: Choice, right: Choice): number {
  return left.price - right.price
    || left.flight.durationMinutes - right.flight.durationMinutes
    || left.flight.stops - right.flight.stops
    || left.flight.key.localeCompare(right.flight.key);
}

function compareFastest(left: Choice, right: Choice): number {
  return left.flight.durationMinutes - right.flight.durationMinutes
    || left.price - right.price
    || left.flight.stops - right.flight.stops
    || left.flight.key.localeCompare(right.flight.key);
}

function compareFlights(left: CanonicalFlight, right: CanonicalFlight): number {
  return left.departureDate.localeCompare(right.departureDate)
    || left.segments[0]!.departure.localeCompare(right.segments[0]!.departure)
    || left.key.localeCompare(right.key);
}

function compareOffers(left: FlightOfferSnapshot, right: FlightOfferSnapshot): number {
  return Number(left.priceAmount) - Number(right.priceAmount)
    || left.observedAt.localeCompare(right.observedAt)
    || left.offerId.localeCompare(right.offerId);
}

function compareOfferSnapshots(left: FlightOfferSnapshot, right: FlightOfferSnapshot): number {
  return left.flightKey.localeCompare(right.flightKey) || compareOffers(left, right);
}

function snapshotOfferKey(offer: FlightOfferSnapshot): string {
  return `${offer.provider}\u0000${offer.offerId}\u0000${offer.flightKey}`;
}

function finalStatus(state: SearchState): LegSearchSnapshot["status"] {
  if (state.failedDates.size === 0) return "completed";
  return state.datesCompleted.size > 0 ? "partial" : "failed";
}

function validateWindow(
  window: { start: string; end: string },
  leg: TripCityLeg
): { ok: true } | {
  ok: false;
  status: "invalid_window" | "window_too_large";
  code: string;
  message: string;
} {
  if (!isIsoDate(window.start) || !isIsoDate(window.end) || window.end < window.start) {
    return {
      ok: false,
      status: "invalid_window",
      code: "invalid_date_window",
      message: "Choose a valid departure date range."
    };
  }
  if (window.start < leg.departureWindow.start || window.end > leg.departureWindow.end) {
    return {
      ok: false,
      status: "invalid_window",
      code: "window_outside_leg",
      message: "The search range must stay inside this flight leg's departure window."
    };
  }
  if (dateSpanDays(window.start, window.end) > MAX_MANUAL_SEARCH_DAYS) {
    return {
      ok: false,
      status: "window_too_large",
      code: "window_exceeds_seven_days",
      message: `Choose a range of ${MAX_MANUAL_SEARCH_DAYS} days or fewer.`
    };
  }
  return { ok: true };
}

function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = parseIsoDate(start);
  const final = parseIsoDate(end).getTime();
  while (cursor.getTime() <= final) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = parseIsoDate(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateSpanDays(start: string, end: string): number {
  return Math.floor((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / 86_400_000) + 1;
}

async function runBounded<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const value = values[cursor];
      cursor += 1;
      if (value !== undefined) await task(value);
    }
  });
  await Promise.all(workers);
}

function orderedDates(dates: Set<string>, requested: string[]): string[] {
  return requested.filter((date) => dates.has(date));
}

function providerErrorCode(error: unknown): FlightSearchProviderErrorCode | "unknown" {
  return error instanceof FlightSearchProviderError ? error.code : "unknown";
}

function isUnexpired(offer: FlightOfferSnapshot, now: Date): boolean {
  return offer.expiresAt === null || Date.parse(offer.expiresAt) > now.getTime();
}

function latestIso(left: string | null, right: string): string {
  return left === null || right > left ? right : left;
}

function resultForSnapshot(
  snapshot: LegSearchSnapshot,
  previousSnapshot: LegSearchSnapshot | null,
  reusedDates: string[],
  searchedDates: string[]
): LegSearchResult {
  const requested = snapshot.analysis.datesRequested.length;
  const completed = snapshot.analysis.datesCompleted.length;
  const message = snapshot.status === "completed"
    ? `Checked all ${requested} departure date${requested === 1 ? "" : "s"}.`
    : snapshot.status === "partial"
      ? `Checked ${completed} of ${requested} departure dates; some dates could not be searched.`
      : "No departure dates could be searched right now.";
  return {
    status: snapshot.status,
    code: snapshot.status === "failed" ? "all_dates_failed" : null,
    message,
    snapshot,
    previousSnapshot,
    coverage: {
      datesRequested: requested,
      datesCompleted: completed,
      label: `${completed} of ${requested} dates checked`,
      complete: snapshot.analysis.complete
    },
    reusedDates,
    searchedDates,
    canClaimCheapestAcrossRange: snapshot.analysis.complete
  };
}

function resultWithoutSnapshot(
  status: Extract<LegSearchResult["status"],
    "not_found" | "trip_inactive" | "invalid_window" | "window_too_large" | "provider_unavailable">,
  code: string,
  message: string,
  previousSnapshot: LegSearchSnapshot | null
): LegSearchResult {
  return {
    status,
    code,
    message,
    snapshot: null,
    previousSnapshot,
    coverage: null,
    reusedDates: [],
    searchedDates: [],
    canClaimCheapestAcrossRange: false
  };
}

function conflictResult(
  previousSnapshot: LegSearchSnapshot | null,
  snapshot: LegSearchSnapshot
): LegSearchResult {
  return {
    status: "conflict",
    code: "snapshot_revision_conflict",
    message: "This search changed in another request. Load its latest result before trying again.",
    snapshot,
    previousSnapshot,
    coverage: {
      datesRequested: snapshot.analysis.datesRequested.length,
      datesCompleted: snapshot.analysis.datesCompleted.length,
      label: `${snapshot.analysis.datesCompleted.length} of ${snapshot.analysis.datesRequested.length} dates checked`,
      complete: false
    },
    reusedDates: [],
    searchedDates: [],
    canClaimCheapestAcrossRange: false
  };
}
