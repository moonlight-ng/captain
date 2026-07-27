import { describe, expect, it } from "vitest";

import type { OfferSnapshot } from "@agents/flight-domain";
import type { RecommendationSnapshot } from "@agents/flight-store";

import {
  explainRecommendation,
  parseAirlinePreferences,
  parseProfileCallback,
  repliedToTelegramMessageId
} from "../agent/channels/telegram.js";

describe("Telegram profile onboarding", () => {
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
});

function offer(id: string, priceAmount: string, durationSeconds: number): OfferSnapshot {
  return {
    id,
    searchRunId: "run",
    searchSpecId: "spec",
    itineraryKey: id,
    provider: "openai_web",
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
