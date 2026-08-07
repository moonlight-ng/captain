import { describe, expect, it } from "vitest";

import type { OfferSnapshot } from "@agents/flight-domain";
import type { RecommendationSnapshot } from "@agents/flight-store";

import {
  CAPTAIN_CLEAR_COMMAND,
  CAPTAIN_CLEAR_CONFIRMATION,
  CAPTAIN_DEFAULTS_INTRO,
  CAPTAIN_NEW_USER_GREETING,
  CAPTAIN_PROFILE_COMMAND,
  CAPTAIN_READY_PROMPT,
  CAPTAIN_RETURNING_TRAVELLER_WELCOME,
  CAPTAIN_TRIP_COMMAND,
  explainNotification,
  explainRecommendation,
  repliedToTelegramMessageId
} from "../agent/channels/telegram.js";

describe("Telegram profile onboarding", () => {
  it("starts every new traveller with the fixed three-message introduction", () => {
    expect(CAPTAIN_NEW_USER_GREETING).toBe(
      "Hi, I’m Captain. Tell me a flight you’re thinking about and I’ll follow its price every day until it departs, so you know when it’s a good moment to book.\n\n"
      + "I’m an early test version, so I keep things small: one trip at a time, and I never book or pay for anything myself."
    );
    expect(CAPTAIN_DEFAULTS_INTRO).toBe(
      "I’ve already set you up with sensible defaults — fares in USD, a balanced pick between price and travel time, and one update a day. You can see and change any of it here."
    );
    expect(CAPTAIN_READY_PROMPT).toBe(
      "That’s it. Whenever you’re ready, tell me where you’re going and roughly when — typed or as a voice note."
    );
  });

  it("sets expectations before asking for anything", () => {
    // The interview is gone: onboarding asks no questions, so the first
    // message has to carry the demo framing and the one-trip limit itself.
    expect(CAPTAIN_NEW_USER_GREETING).toContain("test version");
    expect(CAPTAIN_NEW_USER_GREETING).toContain("one trip at a time");
    expect(CAPTAIN_DEFAULTS_INTRO).toContain("defaults");
    expect(CAPTAIN_READY_PROMPT).toContain("voice note");
  });

  it("introduces Captain once and welcomes returning travellers differently", () => {
    expect(CAPTAIN_NEW_USER_GREETING).toMatch(/I['’]m Captain/u);
    expect(CAPTAIN_DEFAULTS_INTRO).not.toMatch(/I['’]m Captain/u);
    expect(CAPTAIN_READY_PROMPT).not.toMatch(/I['’]m Captain/u);
    expect(CAPTAIN_RETURNING_TRAVELLER_WELCOME).not.toMatch(/I['’]m Captain/u);
    expect(CAPTAIN_RETURNING_TRAVELLER_WELCOME).toBe(
      "Welcome back. Tell me where and roughly when you want to fly, and I’ll watch it for you. I track one trip at a time."
    );
  });

  it("uses trip as the single user-facing trip command", () => {
    expect(CAPTAIN_TRIP_COMMAND).toBe("/trip");
  });

  it("uses profile as the single user-facing account command", () => {
    expect(CAPTAIN_PROFILE_COMMAND).toBe("/profile");
  });

  it("uses the clear command to reset preferences", () => {
    expect(CAPTAIN_CLEAR_COMMAND).toBe("/clear");
    expect(CAPTAIN_CLEAR_CONFIRMATION).toBe("Your preferences have been reset.");
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
