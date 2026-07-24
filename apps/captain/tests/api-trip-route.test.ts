import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import { issueCaptainSessionToken } from "../agent/lib/session-token.js";
import {
  issueCompactTripDashboardToken,
  issueTripDashboardToken
} from "../services/auth/trip-dashboard-token.js";
import { TripService } from "../services/trips/service.js";
import { MemoryFlightAgentStore } from "../services/store/memory-store.js";
import { defaultTestBrief } from "./support.js";

const mocks = vi.hoisted(() => ({ getCaptainServices: vi.fn() }));
vi.mock("../services/app/services.js", () => ({ getCaptainServices: mocks.getCaptainServices }));

import apiChannel from "../agent/channels/api.js";

type Handler = (request: Request, context: { params: Record<string, string> }) => Promise<Response>;
const createHandler = apiChannel.routes.find((route) => route.method === "POST" && route.path === "/v1/trips")!.handler as unknown as Handler;
const getHandler = apiChannel.routes.find((route) => route.method === "GET" && route.path === "/v1/trips/:tripId")!.handler as unknown as Handler;
const dashboardHandler = apiChannel.routes.find((route) => route.method === "GET" && route.path === "/v1/dashboard/trips/:tripId")!.handler as unknown as Handler;
const compactDashboardHandler = apiChannel.routes.find((route) => route.method === "GET" && route.path === "/v1/dashboard")!.handler as unknown as Handler;

describe("tenant-scoped Trip API", () => {
  const secret = "captain-session-secret";
  let platform: MemoryCaptainPlatformStore;
  let ownerId: string;
  let otherId: string;

  beforeEach(async () => {
    const now = new Date("2026-08-01T12:00:00Z");
    platform = new MemoryCaptainPlatformStore();
    ownerId = (await platform.ensureTelegramUser({ telegramUserId: 1, telegramChatId: 1, username: null, firstName: "Ada", lastName: null }, now)).id;
    otherId = (await platform.ensureTelegramUser({ telegramUserId: 2, telegramChatId: 2, username: null, firstName: "Grace", lastName: null }, now)).id;
    mocks.getCaptainServices.mockResolvedValue({
      env: { captainSessionSecret: secret },
      store: new MemoryFlightAgentStore(),
      platformStore: platform,
      trips: new TripService({ store: platform, liveMode: false, now: () => now })
    });
  });

  it("derives ownership from a signed session and hides another user's Trip", async () => {
    const token = issueCaptainSessionToken({ secret, userId: ownerId, nonce: "0123456789abcdef" });
    const created = await createHandler(new Request("https://captain.example/v1/trips", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "trip-create-1" },
      body: JSON.stringify({ title: "New York", brief: defaultTestBrief(), cadenceHours: 6 })
    }), { params: {} });
    expect(created.status).toBe(202);
    const body = await created.json() as { trip: { id: string } };

    const otherToken = issueCaptainSessionToken({ secret, userId: otherId, nonce: "fedcba9876543210" });
    const hidden = await getHandler(new Request(`https://captain.example/v1/trips/${body.trip.id}`, {
      headers: { authorization: `Bearer ${otherToken}` }
    }), { params: { tripId: body.trip.id } });
    expect(hidden.status).toBe(404);
    expect(await platform.listTrips(otherId)).toEqual([]);
  });

  it("rejects an unsigned client-supplied identity", async () => {
    const response = await getHandler(new Request("https://captain.example/v1/trips/11111111-1111-4111-8111-111111111111", {
      headers: { "x-user-id": ownerId }
    }), { params: { tripId: "11111111-1111-4111-8111-111111111111" } });
    expect(response.status).toBe(401);
  });

  it("opens only the Trip bound into a signed dashboard link", async () => {
    const trips = new TripService({ store: platform, liveMode: false });
    const first = await trips.create(ownerId, {
      title: "New York",
      brief: defaultTestBrief(),
      cadenceHours: 6
    });
    const second = await trips.create(ownerId, {
      title: "London",
      brief: defaultTestBrief({ originAirports: ["LOS"], destinationAirports: ["LHR"] }),
      cadenceHours: 6
    });
    const token = issueTripDashboardToken({
      secret,
      userId: ownerId,
      tripId: first.trip.id,
      nonce: "0123456789abcdef"
    });
    const opened = await dashboardHandler(new Request(
      `https://captain.example/v1/dashboard/trips/${first.trip.id}`,
      { headers: { authorization: `Bearer ${token}` } }
    ), { params: { tripId: first.trip.id } });
    expect(opened.status).toBe(200);
    await expect(opened.json()).resolves.toMatchObject({
      trip: { id: first.trip.id },
      watch: { tripId: first.trip.id },
      offers: [],
      selections: []
    });

    const wrongTrip = await dashboardHandler(new Request(
      `https://captain.example/v1/dashboard/trips/${second.trip.id}`,
      { headers: { authorization: `Bearer ${token}` } }
    ), { params: { tripId: second.trip.id } });
    expect(wrongTrip.status).toBe(401);

    const compactToken = issueCompactTripDashboardToken({
      secret,
      tripId: first.trip.id
    });
    const compact = await compactDashboardHandler(new Request(
      "https://captain.example/v1/dashboard",
      { headers: { authorization: `Bearer ${compactToken}` } }
    ), { params: {} });
    expect(compact.status).toBe(200);
    await expect(compact.json()).resolves.toMatchObject({
      trip: { id: first.trip.id },
      offers: [],
      selections: []
    });
  });
});
