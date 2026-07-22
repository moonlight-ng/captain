import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryCaptainPlatformStore } from "@agents/flight-store";
import { issueCaptainSessionToken } from "../agent/lib/session-token.js";
import { TripService } from "../services/trips/service.js";
import { MemoryFlightAgentStore } from "../services/store/memory-store.js";
import { defaultTestBrief } from "./support.js";

const mocks = vi.hoisted(() => ({ getFlightAgentServices: vi.fn() }));
vi.mock("../services/app/services.js", () => ({ getFlightAgentServices: mocks.getFlightAgentServices }));

import apiChannel from "../agent/channels/api.js";

type Handler = (request: Request, context: { params: Record<string, string> }) => Promise<Response>;
const createHandler = apiChannel.routes.find((route) => route.method === "POST" && route.path === "/v1/trips")!.handler as unknown as Handler;
const getHandler = apiChannel.routes.find((route) => route.method === "GET" && route.path === "/v1/trips/:tripId")!.handler as unknown as Handler;

describe("tenant-scoped Trip API", () => {
  const secret = "captain-session-secret";
  let platform: MemoryCaptainPlatformStore;
  let ownerId: string;
  let otherId: string;

  beforeEach(async () => {
    const now = new Date("2026-08-01T12:00:00Z");
    platform = new MemoryCaptainPlatformStore();
    ownerId = (await platform.ensureTelegramUser({ telegramUserId: 1, telegramChatId: 1, username: null, firstName: "Ada", lastName: null }, true, now)).id;
    otherId = (await platform.ensureTelegramUser({ telegramUserId: 2, telegramChatId: 2, username: null, firstName: "Grace", lastName: null }, true, now)).id;
    mocks.getFlightAgentServices.mockResolvedValue({
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
});
