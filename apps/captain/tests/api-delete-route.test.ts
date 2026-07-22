import { beforeEach, describe, expect, it, vi } from "vitest";

import { signBridgeRequest } from "../services/bridge/signature.js";
import { MemoryFlightAgentStore } from "../services/store/memory-store.js";

const mocks = vi.hoisted(() => ({ getFlightAgentServices: vi.fn() }));

vi.mock("../services/app/services.js", () => ({
  getFlightAgentServices: mocks.getFlightAgentServices
}));

import apiChannel from "../agent/channels/api.js";

const path = "/internal/v1/flight-agents/fa_smoke";
const handler = apiChannel.routes.find((route) =>
  route.method === "DELETE" &&
  route.path === "/internal/v1/flight-agents/:agentKey"
)!.handler as unknown as (
  request: Request,
  context: { params: Record<string, string> }
) => Promise<Response>;

describe("internal exact agent cleanup bridge", () => {
  const secret = "captain-to-flight-agent";
  let store: MemoryFlightAgentStore;
  let remove: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new MemoryFlightAgentStore();
    remove = vi.fn().mockResolvedValue(true);
    mocks.getFlightAgentServices.mockResolvedValue({
      env: { captainToFlightAgentSecret: secret },
      store,
      agents: { delete: remove }
    });
  });

  it("requires a valid signature and an idempotency key", async () => {
    const body = JSON.stringify({ createIdempotencyKey: "flight-plan:draft:3" });
    const unauthorized = await call({ body, secret: "wrong", timestampOffset: 101 });
    expect(unauthorized.status).toBe(401);
    const missingKey = await call({ body, timestampOffset: 102 });
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toEqual({ error: "idempotency_key_required" });
  });

  it("deletes once without leaving a cleanup idempotency record", async () => {
    const body = JSON.stringify({ createIdempotencyKey: "flight-plan:draft:3" });
    const first = await call({ body, idempotencyKey: "cleanup:draft", timestampOffset: 201 });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ deleted: true, agentKey: "fa_smoke" });

    remove.mockResolvedValue(false);
    const replay = await call({ body, idempotencyKey: "cleanup:draft", timestampOffset: 202 });
    expect(replay.status).toBe(404);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("fa_smoke", "flight-plan:draft:3");
    await expect(store.getIdempotency("internal:delete:fa_smoke", "cleanup:draft")).resolves.toBeNull();
  });

  it("returns not found without recording a successful deletion", async () => {
    remove.mockResolvedValue(false);
    const response = await call({
      body: JSON.stringify({ createIdempotencyKey: "flight-plan:missing:1" }),
      idempotencyKey: "cleanup:missing",
      timestampOffset: 301
    });
    expect(response.status).toBe(404);
  });

  async function call(options: {
    body: string;
    idempotencyKey?: string;
    timestampOffset: number;
    secret?: string;
  }): Promise<Response> {
    const timestamp = String(Date.now() + options.timestampOffset);
    const signed = signBridgeRequest({
      secret: options.secret ?? secret,
      method: "DELETE",
      path,
      body: options.body,
      timestamp
    });
    const request = new Request(`https://flight.example${path}`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-bridge-timestamp": signed.timestamp,
        "x-bridge-signature": signed.signature,
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {})
      },
      body: options.body
    });
    return handler(request, { params: { agentKey: "fa_smoke" } });
  }
});
