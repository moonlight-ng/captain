import { describe, expect, it } from "vitest";

import type { OfferSnapshot } from "@agents/flight-domain";
import type { RecommendationSnapshot } from "@agents/flight-store";

import {
  CAPTAIN_NEW_USER_GREETING,
  CAPTAIN_PREFERENCES_INTRO,
  explainNotification,
  explainRecommendation,
  parseAirlinePreferences,
  parseProfileCallback,
  parseTrackingCallback,
  repliedToTelegramMessageId
} from "../agent/channels/telegram.js";

describe("Telegram profile onboarding", () => {
  it("starts every new traveller with the fixed introduction", () => {
    expect(CAPTAIN_NEW_USER_GREETING).toBe(
      "Hi, I'm Captain! I can help you prepare for a flight by tracking suitable options and reporting price changes."
    );
    expect(CAPTAIN_PREFERENCES_INTRO).toBe("Let's start with your preferences");
  });

  it("parses currency, ranking, and preferred/avoided airlines deterministically", () => {
    expect(parseProfileCallback("captain-profile:currency:NGN")).toEqual({
      type: "currency",
      value: "NGN"
    });
    expect(parseProfileCallback("captain-profile:ranking:balanced")).toEqual({
      type: "ranking",
      value: "balanced"
    });
    expect(parseAirlinePreferences("Prefer BA, VS; avoid KL and AF")).toEqual({
      preferredAirlineCodes: ["BA", "VS"],
      excludedAirlineCodes: ["KL", "AF"]
    });
    expect(parseAirlinePreferences("/skip")).toEqual({
      preferredAirlineCodes: [],
      excludedAirlineCodes: []
    });
  });

  it("parses inactivity callbacks without accepting malformed Trip IDs", () => {
    expect(parseTrackingCallback(
      "captain-watch:keep:00000000-0000-4000-8000-000000000001"
    )).toEqual({
      action: "keep",
      tripId: "00000000-0000-4000-8000-000000000001"
    });
    expect(parseTrackingCallback(
      "captain-watch:pause:00000000-0000-4000-8000-000000000001"
    )).toEqual({
      action: "pause",
      tripId: "00000000-0000-4000-8000-000000000001"
    });
    expect(parseTrackingCallback("captain-watch:pause:not-a-trip")).toBeNull();
  });
});

describe("quoted recommendation explanations", () => {
  it("resolves the quoted Telegram message and explains its immutable comparison", () => {
    expect(repliedToTelegramMessageId({
      reply_to_message: { message_id: 42 }
    })).toBe(42);

    const snapshot: RecommendationSnapshot = {
      previous: offer("old", "1124.77", 172_800),
      current: offer("new", "949.00", 86_400),
      rankingMode: "cheapest",
      reasonCodes: ["lower_price"],
      createdAt: "2026-08-01T12:00:00.000Z"
    };
    const explanation = explainRecommendation(snapshot);

    expect(explanation).toContain("GBP 1124.77");
    expect(explanation).toContain("£175.77");
    expect(explanation).toContain("GBP 949.00");
    expect(explanation).toContain("https://ba.com/verified-fare");
  });

  it("explains the exact historical price-rise alert", () => {
    const current = offer("current", "125.00", 7_200);
    const explanation = explainNotification({
      id: "notification",
      userId: "user",
      tripId: "trip",
      telegramChatId: 1,
      kind: "price_rise",
      attempts: 0,
      telegramMessageId: 42,
      payload: {
        current,
        increase: 25,
        sevenDayLow: 100,
        percent: 25
      }
    });

    expect(explanation).toContain("up £25.00 (25%)");
    expect(explanation).toContain("seven-day low of £100.00");
    expect(explanation).toContain("https://ba.com/verified-fare");
  });
});

function offer(id: string, priceAmount: string, durationSeconds: number): OfferSnapshot {
  return {
    id,
    searchRunId: "run",
    searchSpecId: "spec",
    itineraryKey: id,
    provider: "flysoar_mcp",
    providerOfferId: id,
    providerSearchId: "search",
    price: Number(priceAmount),
    priceAmount,
    currency: "GBP",
    fareBasis: "one_adult_total",
    primaryAirlineCode: "BA",
    participatingAirlineCodes: ["BA"],
    evidence: [{
      url: "https://ba.com/verified-fare",
      title: "Verified fare",
      domain: "ba.com"
    }],
    discoveryResponseId: "discovery",
    verificationResponseId: "verification",
    promptVersion: "v1",
    model: "gpt-5.6-sol",
    verifiedAt: "2026-08-01T12:00:00.000Z",
    expiresAt: null,
    observedAt: "2026-08-01T12:00:00.000Z",
    snapshot: { durationSeconds, stops: 1 }
  };
}
