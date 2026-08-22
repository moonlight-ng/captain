import { randomUUID } from "node:crypto";

import {
  FlightSearchProviderError,
  type CanonicalFlight,
  type FlightOfferSnapshot,
  type FlightSearchProvider,
  type FlightSearchResult,
  type LegSearchSnapshot,
  type LegSearchSnapshotRevision,
  type SearchSpecRequest,
  type Trip,
  type TripCity,
  type TripCityLeg,
  type VerifiedOfferCandidate
} from "@agents/flight-domain";
import type { CaptainPlatformStore } from "@agents/flight-store";
import { describe, expect, it } from "vitest";

import { analyzeLegSearch, LegSearchService } from "../services/flights/leg-search.js";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const USER_ID = "user-1";
const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN_ID = "22222222-2222-4222-8222-222222222222";
const DESTINATION_ID = "33333333-3333-4333-8333-333333333333";
const LEG_ID = "44444444-4444-4444-8444-444444444444";

describe("manual multi-day leg search", () => {
  it("returns a running search id before exact-date work finishes", async () => {
    const store = new FakeLegSearchStore("2026-11-15", "2026-11-18");
    const provider = fakeProvider(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const date = request.slices[0]!.departureStart;
      return providerResult(request, [offer(date, 200, 360)]);
    });
    const service = createService(store, provider);

    const started = await service.start(USER_ID, { tripId: TRIP_ID, legId: LEG_ID });

    expect(started.status).toBe("running");
    expect(started.snapshot).toMatchObject({
      status: "running",
      analysis: { datesCompleted: [] }
    });
    await expect.poll(async () => (
      await service.get(USER_ID, TRIP_ID, LEG_ID, started.snapshot!.id)
    )?.status).toBe("completed");
  });

  it("fans a four-day window into exact-date searches with concurrency capped at three", async () => {
    const store = new FakeLegSearchStore("2026-11-15", "2026-11-18");
    const provider = fakeProvider(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const date = request.slices[0]!.departureStart;
      return providerResult(request, [offer(date, 200 + Number(date.slice(-2)), 360)]);
    });
    const service = createService(store, provider);

    const result = await service.search(USER_ID, { tripId: TRIP_ID, legId: LEG_ID });

    expect(result.status).toBe("completed");
    expect(result.coverage).toEqual({
      datesRequested: 4,
      datesCompleted: 4,
      label: "4 of 4 dates checked",
      complete: true
    });
    expect(result.canClaimCheapestAcrossRange).toBe(true);
    expect(provider.requests.map((request) => request.slices[0])).toEqual([
      exactSlice("2026-11-15"),
      exactSlice("2026-11-16"),
      exactSlice("2026-11-17"),
      exactSlice("2026-11-18")
    ]);
    expect(provider.maximumConcurrency).toBe(3);
    expect(store.revisions.filter((revision) => revision.status === "running")
      .map((revision) => revision.analysis.datesCompleted.length)).toEqual([0, 1, 2, 3, 4]);
  });

  it("searches every multi-city leg for the trip's full adult party", async () => {
    const store = new FakeLegSearchStore("2026-11-15", "2026-11-15", 4);
    const provider = fakeProvider(async (request) =>
      providerResult(request, [offer("2026-11-15", 800, 360)])
    );
    const service = createService(store, provider);

    await service.search(USER_ID, { tripId: TRIP_ID, legId: LEG_ID });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.passenger).toEqual({
      adults: 4,
      childrenAges: [],
      infants: 0
    });
  });

  it("preserves successful dates when one exact-date provider search fails", async () => {
    const store = new FakeLegSearchStore("2026-11-15", "2026-11-18");
    const provider = fakeProvider(async (request) => {
      const date = request.slices[0]!.departureStart;
      if (date === "2026-11-16") {
        throw new FlightSearchProviderError("official_duffel", "timeout", "Supplier timed out");
      }
      return providerResult(request, [offer(date, 200 + Number(date.slice(-2)), 360)]);
    });
    const service = createService(store, provider);

    const result = await service.search(USER_ID, { tripId: TRIP_ID, legId: LEG_ID });

    expect(result.status).toBe("partial");
    expect(result.snapshot?.analysis).toMatchObject({
      complete: false,
      datesCompleted: ["2026-11-15", "2026-11-17", "2026-11-18"],
      failedDates: [{ date: "2026-11-16", code: "timeout" }],
      optionsChecked: 3
    });
    expect(result.coverage?.label).toBe("3 of 4 dates checked");
    expect(result.canClaimCheapestAcrossRange).toBe(false);
    expect(result.snapshot?.analysis.cheapest?.departureDate).toBe("2026-11-15");
  });

  it("reuses unexpired results from the previous snapshot for the same leg", async () => {
    const store = new FakeLegSearchStore("2026-11-15", "2026-11-18");
    const provider = fakeProvider(async (request) => {
      const date = request.slices[0]!.departureStart;
      return providerResult(request, [offer(date, 200 + Number(date.slice(-2)), 360)]);
    });
    const service = createService(store, provider);
    const first = await service.search(USER_ID, { tripId: TRIP_ID, legId: LEG_ID });

    const refreshed = await service.search(USER_ID, { tripId: TRIP_ID, legId: LEG_ID });

    expect(first.status).toBe("completed");
    expect(refreshed.status).toBe("completed");
    expect(refreshed.reusedDates).toEqual([
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
      "2026-11-18"
    ]);
    expect(refreshed.searchedDates).toEqual([]);
    expect(refreshed.previousSnapshot?.id).toBe(first.snapshot?.id);
    expect(refreshed.snapshot?.id).not.toBe(first.snapshot?.id);
    expect(provider.requests).toHaveLength(4);
  });

  it("rejects a window longer than seven days before creating or calling a search", async () => {
    const store = new FakeLegSearchStore("2026-11-01", "2026-11-08");
    const provider = fakeProvider(async (request) => providerResult(request, []));
    const service = createService(store, provider);

    const result = await service.search(USER_ID, { tripId: TRIP_ID, legId: LEG_ID });

    expect(result).toMatchObject({
      status: "window_too_large",
      code: "window_exceeds_seven_days",
      snapshot: null,
      canClaimCheapestAcrossRange: false
    });
    expect(store.createCalls).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("deterministically calculates cheapest, fastest, balanced, and cheapest per date", () => {
    const flights = [
      canonicalFlight("flight-cheap", "2026-11-15", 600, 2),
      canonicalFlight("flight-balanced", "2026-11-16", 300, 0),
      canonicalFlight("flight-fast", "2026-11-16", 200, 0)
    ];
    const offers = [
      snapshotOffer("offer-cheap", "flight-cheap", "100.00"),
      snapshotOffer("offer-balanced", "flight-balanced", "110.00"),
      snapshotOffer("offer-fast", "flight-fast", "170.00")
    ];

    const analysis = analyzeLegSearch(
      ["2026-11-15", "2026-11-16"],
      ["2026-11-15", "2026-11-16"],
      [],
      flights,
      offers,
      NOW.toISOString()
    );

    expect(analysis).toMatchObject({
      complete: true,
      optionsChecked: 3,
      cheapest: { flightKey: "flight-cheap" },
      fastest: { flightKey: "flight-fast" },
      balanced: { flightKey: "flight-balanced" }
    });
    expect(analysis.cheapestByDate.map((pick) => pick.flightKey)).toEqual([
      "flight-cheap",
      "flight-balanced"
    ]);
  });

  it("uses a stated airline preference only in Captain's balanced pick", () => {
    const flights = [
      canonicalFlight("flight-low", "2026-11-15", 300, 0, "KQ"),
      canonicalFlight("flight-preferred", "2026-11-15", 300, 0, "BA")
    ];
    const offers = [
      snapshotOffer("offer-low", "flight-low", "100.00"),
      snapshotOffer("offer-preferred", "flight-preferred", "108.00")
    ];

    const analysis = analyzeLegSearch(
      ["2026-11-15"],
      ["2026-11-15"],
      [],
      flights,
      offers,
      NOW.toISOString(),
      ["BA"]
    );

    expect(analysis.cheapest?.flightKey).toBe("flight-low");
    expect(analysis.balanced?.flightKey).toBe("flight-preferred");
  });
});

function createService(store: FakeLegSearchStore, provider: FlightSearchProvider) {
  return new LegSearchService({
    store: store as unknown as CaptainPlatformStore,
    provider,
    now: () => NOW
  });
}

class FakeLegSearchStore {
  readonly trip: Trip;
  readonly cities: TripCity[];
  readonly leg: TripCityLeg;
  readonly revisions: LegSearchSnapshotRevision[] = [];
  createCalls = 0;
  latest: LegSearchSnapshot | null = null;

  constructor(start: string, end: string, adults = 1) {
    this.trip = {
      id: TRIP_ID,
      userId: USER_ID,
      title: "Nairobi to Entebbe",
      status: "tracking",
      version: 1,
      brief: {
        originAirports: ["NBO"],
        destinationAirports: ["EBB"],
        tripType: "one_way",
        departureWindow: { start, end },
        stayNights: null,
        travellers: { adults, childrenAges: [], infants: 0 },
        cabin: "economy",
        maxStops: 2,
        currency: "GBP",
        maximumPrice: null,
        preferredAirlines: [],
        excludedAirlines: [],
        context: ""
      },
      archivedAt: null,
      archiveReason: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString()
    };
    this.cities = [
      city(ORIGIN_ID, 0, "Nairobi", ["NBO"]),
      city(DESTINATION_ID, 1, "Entebbe", ["EBB"])
    ];
    this.leg = {
      id: LEG_ID,
      tripId: TRIP_ID,
      position: 0,
      originCityId: ORIGIN_ID,
      destinationCityId: DESTINATION_ID,
      departureWindow: { start, end },
      arriveBy: null,
      selectedFlightKey: null,
      latestSearchId: null
    };
  }

  async getTrip(userId: string, tripId: string) {
    return userId === USER_ID && tripId === TRIP_ID ? this.trip : null;
  }

  async getTripLeg(userId: string, tripId: string, legId: string) {
    return userId === USER_ID && tripId === TRIP_ID && legId === LEG_ID ? this.leg : null;
  }

  async getTripGraph(userId: string, tripId: string) {
    return userId === USER_ID && tripId === TRIP_ID
      ? { cities: this.cities, legs: [this.leg] }
      : { cities: [], legs: [] };
  }

  async getLatestLegSearchSnapshot(userId: string, tripId: string, legId: string) {
    return userId === USER_ID && tripId === TRIP_ID && legId === LEG_ID ? this.latest : null;
  }

  async getLegSearchSnapshot(userId: string, searchId: string) {
    return userId === USER_ID && this.latest?.id === searchId ? this.latest : null;
  }

  async createLegSearchSnapshot(
    userId: string,
    tripId: string,
    legId: string,
    requestedWindow: { start: string; end: string },
    datesRequested: string[]
  ) {
    if (userId !== USER_ID || tripId !== TRIP_ID || legId !== LEG_ID) throw new Error("not found");
    this.createCalls += 1;
    this.latest = {
      id: randomUUID(),
      tripId,
      legId,
      revision: 1,
      status: "queued",
      requestedWindow,
      analysis: {
        complete: false,
        datesRequested,
        datesCompleted: [],
        failedDates: [],
        optionsChecked: 0,
        cheapest: null,
        fastest: null,
        balanced: null,
        cheapestByDate: [],
        observedAt: null
      },
      flights: [],
      offers: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      completedAt: null
    };
    return this.latest;
  }

  async reviseLegSearchSnapshot(
    userId: string,
    searchId: string,
    expectedRevision: number,
    revision: LegSearchSnapshotRevision
  ) {
    if (
      userId !== USER_ID
      || this.latest?.id !== searchId
      || this.latest.revision !== expectedRevision
    ) return null;
    this.revisions.push(structuredClone(revision));
    this.latest = {
      ...this.latest,
      ...revision,
      revision: expectedRevision + 1,
      updatedAt: NOW.toISOString()
    };
    return this.latest;
  }
}

function fakeProvider(
  response: (request: SearchSpecRequest) => Promise<FlightSearchResult>
): FlightSearchProvider & {
  requests: SearchSpecRequest[];
  maximumConcurrency: number;
} {
  const provider = {
    provider: "official_duffel" as const,
    requests: [] as SearchSpecRequest[],
    active: 0,
    maximumConcurrency: 0,
    async search(request: SearchSpecRequest) {
      provider.requests.push(request);
      provider.active += 1;
      provider.maximumConcurrency = Math.max(provider.maximumConcurrency, provider.active);
      try {
        return await response(request);
      } finally {
        provider.active -= 1;
      }
    }
  };
  return provider;
}

function providerResult(
  request: SearchSpecRequest,
  offers: VerifiedOfferCandidate[]
): FlightSearchResult {
  const date = request.slices[0]!.departureStart;
  return {
    provider: "official_duffel",
    requestId: `request-${date}`,
    discoveryResponseId: `discovery-${date}`,
    verificationResponseId: `verification-${date}`,
    model: "duffel",
    promptVersion: "test",
    offers,
    rejectionCounts: {}
  };
}

function offer(date: string, price: number, durationMinutes: number): VerifiedOfferCandidate {
  return {
    itineraryKey: `flight-${date}`,
    providerOfferId: `offer-${date}`,
    expiresAt: "2026-12-01T00:00:00.000Z",
    priceAmount: price.toFixed(2),
    currency: "GBP",
    fareBasis: "one_adult_total",
    cabin: "economy",
    slices: [{
      origin: "NBO",
      destination: "EBB",
      departureDate: date,
      segments: [{
        origin: "NBO",
        destination: "EBB",
        departure: `${date}T09:00:00.000Z`,
        arrival: new Date(
          new Date(`${date}T09:00:00.000Z`).getTime() + durationMinutes * 60_000
        ).toISOString(),
        marketingAirlineCode: "KQ",
        marketingAirline: "Kenya Airways",
        flightNumber: "KQ418"
      }]
    }],
    primaryAirlineCode: "KQ",
    participatingAirlineCodes: ["KQ"],
    evidence: [{
      url: `https://duffel.com/air/offers/offer-${date}`,
      title: `Verified offer for ${date}`,
      domain: "duffel.com"
    }]
  };
}

function city(id: string, position: number, label: string, airportCodes: string[]): TripCity {
  return {
    id,
    tripId: TRIP_ID,
    position,
    label,
    airportCodes,
    arrivalWindow: null,
    departureWindow: null
  };
}

function exactSlice(date: string) {
  return {
    originAirports: ["NBO"],
    destinationAirports: ["EBB"],
    departureStart: date,
    departureEnd: date
  };
}

function canonicalFlight(
  key: string,
  departureDate: string,
  durationMinutes: number,
  stops: number,
  airlineCode = "KQ"
): CanonicalFlight {
  return {
    key,
    origin: "NBO",
    destination: "EBB",
    departureDate,
    segments: [{
      origin: "NBO",
      destination: "EBB",
      departure: `${departureDate}T09:00:00.000Z`,
      arrival: `${departureDate}T12:00:00.000Z`,
      marketingAirlineCode: airlineCode,
      marketingAirline: airlineCode === "KQ" ? "Kenya Airways" : airlineCode,
      flightNumber: `${airlineCode}418`
    }],
    primaryAirlineCode: airlineCode,
    participatingAirlineCodes: [airlineCode],
    durationMinutes,
    stops
  };
}

function snapshotOffer(
  offerId: string,
  flightKey: string,
  priceAmount: string
): FlightOfferSnapshot {
  return {
    offerId,
    flightKey,
    provider: "official_duffel",
    priceAmount,
    currency: "GBP",
    evidence: [{
      url: `https://duffel.com/air/offers/${offerId}`,
      title: "Verified offer",
      domain: "duffel.com"
    }],
    observedAt: NOW.toISOString(),
    expiresAt: "2026-12-01T00:00:00.000Z"
  };
}
