import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateTripInput } from "@agents/flight-domain";
import { MemoryCaptainPlatformStore } from "@agents/flight-store";

import { TripService } from "../services/trips/service.js";

const state = vi.hoisted(() => ({ services: null as unknown }));

vi.mock("../services/app/services.js", () => ({
  getCaptainServices: async () => state.services
}));

import startFareDigestTool from "../agent/tools/start_fare_digest.js";

const USER_ID_PATTERN = /^[0-9a-f-]{36}$/u;

function toolContext(userId: string) {
  return {
    session: {
      id: "session-tomi",
      turn: { id: "turn-fix", sequence: 1 },
      auth: {
        current: {
          attributes: {
            captain_principal: "traveller",
            captain_user_id: userId
          }
        }
      }
    }
  };
}

describe("start_fare_digest", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-16T15:25:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces Tomi's HUH draft with a one-way LOS to SYD daily market job", async () => {
    const now = new Date();
    const store = new MemoryCaptainPlatformStore();
    const user = await store.ensureTelegramUser({
      telegramUserId: 1001,
      telegramChatId: 1001,
      username: null,
      firstName: "Tomi",
      lastName: "Abe"
    }, now);
    expect(user.id).toMatch(USER_ID_PATTERN);
    await store.updateUserTimezone(user.id, "Africa/Lagos", now);
    const trips = new TripService({ store, now: () => new Date() });
    const corrupt: CreateTripInput = {
      title: "Lagos to Sydney to Huahine",
      brief: {
        originAirports: ["LOS"],
        destinationAirports: ["HUH"],
        tripType: "multi_city",
        departureWindow: { start: "2026-08-16", end: "2026-08-16" },
        stayNights: null,
        legs: [
          {
            originAirports: ["LOS"],
            destinationAirports: ["SYD"],
            departureWindow: { start: "2026-08-16", end: "2026-08-16" }
          },
          {
            originAirports: ["SYD"],
            destinationAirports: ["HUH"],
            departureWindow: { start: "2026-09-13", end: "2026-09-13" }
          }
        ],
        travellers: { adults: 1, childrenAges: [], infants: 0 },
        cabin: "economy",
        maxStops: 2,
        currency: "USD",
        maximumPrice: null,
        preferredAirlines: [],
        excludedAirlines: [],
        context: ""
      }
    };
    const old = await trips.create(user.id, corrupt);
    state.services = {
      platformStore: store,
      trips,
      tripPlanning: {
        dashboardUrlForTrip: async (_userId: string, tripId: string) =>
          `https://captain.example/trip/${tripId}#access=test`
      }
    };

    const result = await startFareDigestTool.execute({
      origin: "Lagos",
      destination: "Sydney Australia",
      departureWindow: { start: "2026-08-16", end: "2026-09-13" },
      monitorThrough: "2026-09-13",
      dailyUpdateHourLocal: 9,
      timeZone: "Africa/Lagos",
      adults: 3,
      cabin: "economy",
      maxStops: 2,
      currency: "USD",
      connectionExamples: ["Doha"]
    }, toolContext(user.id) as never) as {
      status: string;
      tripId: string;
      route: string;
      nextUpdateAt: string;
      browseTrip: string;
    };

    expect(result).toMatchObject({
      status: "started",
      route: "LOS → SYD",
      nextUpdateAt: "2026-08-17T08:00:00.000Z"
    });
    expect(result.browseTrip).toContain(`/trip/${result.tripId}`);
    await expect(store.getTrip(user.id, old.trip.id)).resolves.toMatchObject({
      status: "archived",
      archiveReason: "replaced"
    });
    const trip = await store.getTrip(user.id, result.tripId);
    expect(trip?.brief).toMatchObject({
      originAirports: ["LOS"],
      destinationAirports: ["SYD"],
      tripType: "one_way",
      departureWindow: { start: "2026-08-16", end: "2026-09-13" },
      travellers: { adults: 3 }
    });
    expect(JSON.stringify(trip?.brief)).not.toContain("HUH");
    await expect(store.getWatch(user.id, result.tripId)).resolves.toMatchObject({
      purpose: "fare_digest",
      digestHourLocal: 9,
      digestTimeZone: "Africa/Lagos",
      digestIntro: expect.stringContaining("3-adult fares"),
      runEndsAt: "2026-09-13T23:00:00.000Z",
      nextCheckAt: "2026-08-17T08:00:00.000Z",
      checksCompleted: 0
    });
    const claimed = await store.claimSearchRuns("worker", now, 60_000, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      notBeforeDate: "2026-08-16",
      request: {
        tripType: "one_way",
        passenger: { adults: 3 },
        slices: [{
          originAirports: ["LOS"],
          destinationAirports: ["SYD"],
          departureStart: "2026-08-16",
          departureEnd: "2026-09-13"
        }]
      }
    });
  });
});
