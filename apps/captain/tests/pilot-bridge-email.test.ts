import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { PilotBridgeEmailSender } from "../services/email/pilot-bridge.js";

const NOW = new Date("2026-08-16T06:15:00.000Z");
const DELIVERY_ID = "captain-conversation-review/2026-08-15";
const PAYLOAD = {
  subject: "Captain conversation review · 15 Aug",
  text: "One conversation needs attention.",
  html: "<p>One conversation needs attention.</p>"
};

describe("Pilot review email bridge", () => {
  it("sends a signed, idempotent review request", async () => {
    const fetchImplementation = vi.fn(async (
      _url: string | URL | Request,
      init?: RequestInit
    ) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        delivered: true,
        deliveryId: body.deliveryId
      });
    });
    const sender = new PilotBridgeEmailSender({
      baseUrl: "https://pilot.example/",
      secret: "bridge-secret",
      fetch: fetchImplementation as typeof fetch,
      now: () => NOW
    });

    await expect(sender.send(PAYLOAD, {
      idempotencyKey: DELIVERY_ID
    })).resolves.toEqual({
      ok: true,
      messageId: DELIVERY_ID
    });

    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(
      "https://pilot.example/internal/v1/captain-conversation-review"
    );
    const body = String(init?.body);
    expect(JSON.parse(body)).toEqual({
      version: 1,
      source: "captain",
      deliveryId: DELIVERY_ID,
      ...PAYLOAD
    });
    const timestamp = "1786860900";
    expect(new Headers(init?.headers).get("x-pilot-timestamp")).toBe(timestamp);
    expect(new Headers(init?.headers).get("x-pilot-signature")).toBe(
      `sha256=${createHmac("sha256", "bridge-secret")
        .update(`${timestamp}.${body}`)
        .digest("hex")}`
    );
  });

  it("does not claim success when Pilot rejects delivery", async () => {
    const sender = new PilotBridgeEmailSender({
      baseUrl: "https://pilot.example",
      secret: "bridge-secret",
      fetch: vi.fn(async () => Response.json(
        { error: "delivery_failed" },
        { status: 503 }
      )) as typeof fetch
    });

    await expect(sender.send(PAYLOAD, {
      idempotencyKey: DELIVERY_ID
    })).resolves.toEqual({
      ok: false,
      error: "delivery_failed"
    });
  });
});
