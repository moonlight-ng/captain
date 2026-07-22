import { beforeEach, describe, expect, it, vi } from "vitest";

import { signBridgeRequest } from "../services/bridge/signature.js";
import { MemoryFlightAgentStore } from "../services/store/memory-store.js";

const mocks = vi.hoisted(() => ({
  getFlightAgentServices: vi.fn()
}));

vi.mock("../services/app/services.js", () => ({
  getFlightAgentServices: mocks.getFlightAgentServices
}));

import apiChannel from "../agent/channels/api.js";

const path = "/internal/v1/flight-agents/fa_test/checks";
const handler = apiChannel.routes.find((route) =>
  route.method === "POST" &&
  route.path === "/internal/v1/flight-agents/:agentKey/checks"
)!.handler;
const callHandler = handler as unknown as (
  request: Request,
  context: { params: Record<string, string> }
) => Promise<Response>;

const actionRoute = apiChannel.routes.find((route) =>
  route.method === "POST" &&
  route.path === "/internal/v1/flight-agents/:agentKey/actions"
);

describe("internal check bridge", () => {
  it("exposes a signed internal action route for Captain edits", () => {
    expect(actionRoute).toBeDefined();
  });
  const secret = "captain-to-flight-agent";
  let store: MemoryFlightAgentStore;
  let requestCheck: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new MemoryFlightAgentStore();
    requestCheck = vi.fn().mockResolvedValue("00000000-0000-4000-8000-000000000123");
    mocks.getFlightAgentServices.mockResolvedValue({
      env: {
        captainToFlightAgentSecret: secret,
        publicUrl: "https://flight.example"
      },
      store,
      agents: { requestCheck }
    });
  });

  it("requires valid authentication and an idempotency key", async () => {
    const unauthorized = await call({ body: '{"mode":"fare"}', timestampOffset: 101, secret: "wrong" });
    expect(unauthorized.status).toBe(401);

    const missingKey = await call({ body: '{"mode":"fare"}', timestampOffset: 102 });
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toEqual({ error: "idempotency_key_required" });
  });

  it("returns 202, replays the stored response idempotently, and rejects key reuse", async () => {
    const first = await call({
      body: '{"mode":"fare"}',
      idempotencyKey: "refresh-1",
      timestampOffset: 201
    });
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({
      checkId: "00000000-0000-4000-8000-000000000123",
      status: "accepted",
      workspaceUrl: "https://flight.example/agents/fa_test"
    });

    const duplicate = await call({
      body: '{"mode":"fare"}',
      idempotencyKey: "refresh-1",
      timestampOffset: 202
    });
    expect(duplicate.status).toBe(202);
    expect(requestCheck).toHaveBeenCalledTimes(1);

    const conflict = await call({
      body: '{"mode":"fare_and_research"}',
      idempotencyKey: "refresh-1",
      timestampOffset: 203
    });
    expect(conflict.status).toBe(409);
  });

  it("rejects an authenticated signature replay", async () => {
    const timestamp = String(Date.now() + 301);
    const body = '{"mode":"fare_and_research"}';
    const first = await call({ body, idempotencyKey: "research-1", timestamp });
    expect(first.status).toBe(202);
    const replay = await call({ body, idempotencyKey: "research-1", timestamp });
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({ error: "replay_detected" });
  });

  async function call(options: {
    body: string;
    idempotencyKey?: string;
    timestamp?: string;
    timestampOffset?: number;
    secret?: string;
  }): Promise<Response> {
    const timestamp = options.timestamp ?? String(Date.now() + (options.timestampOffset ?? 0));
    const signed = signBridgeRequest({
      secret: options.secret ?? secret,
      method: "POST",
      path,
      body: options.body,
      timestamp
    });
    const request = new Request(`https://flight.example${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bridge-timestamp": signed.timestamp,
        "x-bridge-signature": signed.signature,
        ...(options.idempotencyKey
          ? { "idempotency-key": options.idempotencyKey }
          : {})
      },
      body: options.body
    });
    return callHandler(request, { params: { agentKey: "fa_test" } });
  }
});
