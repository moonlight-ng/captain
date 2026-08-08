import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  FeedbackDeliveryError,
  HttpTelegramFeedbackBridge
} from "../services/feedback/telegram-bridge.js";

const FEEDBACK_ID = "550e8400-e29b-41d4-a716-446655440000";
const NOW = new Date("2026-08-08T12:00:00.000Z");

describe("Telegram feedback bridge", () => {
  it("sends Pilot a bounded event with a fresh HMAC signature", async () => {
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      return Response.json({ received: true, feedbackId: payload.feedbackId });
    });
    const bridge = new HttpTelegramFeedbackBridge({
      baseUrl: "https://pilot.example/",
      secret: "feedback-secret",
      fetch: fetchImplementation as typeof fetch,
      now: () => NOW,
      feedbackId: () => FEEDBACK_ID
    });

    await expect(bridge.send("  More flexible date search, please.  ", {
      telegramUserId: 12345,
      displayName: "Ada"
    })).resolves.toEqual({
      feedbackId: FEEDBACK_ID,
      submittedAt: NOW.toISOString()
    });

    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe("https://pilot.example/internal/v1/product-feedback");
    const body = String(init?.body);
    expect(JSON.parse(body)).toEqual({
      version: 1,
      source: "captain",
      feedbackId: FEEDBACK_ID,
      submittedAt: NOW.toISOString(),
      text: "  More flexible date search, please.  ",
      reporter: {
        telegramUserId: 12345,
        displayName: "Ada"
      }
    });
    const timestamp = "1786190400";
    expect(new Headers(init?.headers).get("x-pilot-timestamp")).toBe(timestamp);
    expect(new Headers(init?.headers).get("x-pilot-signature")).toBe(
      `sha256=${createHmac("sha256", "feedback-secret")
        .update(`${timestamp}.${body}`)
        .digest("hex")}`
    );
  });

  it("reports a rejected delivery without claiming success", async () => {
    const bridge = new HttpTelegramFeedbackBridge({
      baseUrl: "https://pilot.example",
      secret: "feedback-secret",
      fetch: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch
    });

    await expect(bridge.send("A useful report", {
      telegramUserId: 12345,
      displayName: "Ada"
    })).rejects.toBeInstanceOf(FeedbackDeliveryError);
  });
});
