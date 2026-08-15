import type { TravellerProfile } from "@agents/flight-domain";
import { describe, expect, it, vi } from "vitest";

import { learnLanguageFromDeliveredExchange } from "../services/agent/language-preference.js";

const timestamp = "2026-08-15T10:00:00.000Z";

function profile(source: TravellerProfile["preferredLanguageSource"] = "default"): TravellerProfile {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    defaultCurrency: "USD",
    rankingMode: "balanced",
    preferredAirlineCodes: [],
    excludedAirlineCodes: [],
    alertsEnabled: true,
    notificationMode: "changes_only",
    priceRiseAlertsEnabled: true,
    betterOptionAlertsEnabled: true,
    maxAlertsPerDay: 1,
    quietHoursEnabled: true,
    quietHoursStart: 22,
    quietHoursEnd: 7,
    preferredLanguage: source === "default" ? "en" : "fr",
    preferredLanguageSource: source,
    preferredLanguageSetAt: source === "default" ? null : timestamp,
    onboardingCompletedAt: timestamp,
    onboardingStep: "complete",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

describe("post-delivery language learning", () => {
  it("claims a matching language only after the delivered exchange is supplied", async () => {
    const claimDetectedLanguage = vi.fn(async () => ({ claimed: true, profile: profile("detected") }));
    const result = await learnLanguageFromDeliveredExchange({
      userId: profile().userId,
      userText: "Je cherche un vol pour Bangkok.",
      assistantText: "Je vérifie les meilleurs vols.",
      store: { ensureProfile: vi.fn(async () => profile()), claimDetectedLanguage },
      detectMatchingLanguage: vi.fn(async () => "fr"),
      now: () => new Date(timestamp)
    });
    expect(result).toEqual({ claimed: true, language: "fr" });
    expect(claimDetectedLanguage).toHaveBeenCalledWith(
      profile().userId,
      "fr",
      new Date(timestamp)
    );
  });

  it("keeps default English when the messages do not confidently match", async () => {
    const claimDetectedLanguage = vi.fn();
    const result = await learnLanguageFromDeliveredExchange({
      userId: profile().userId,
      userText: "Paris",
      assistantText: "Where are you flying from?",
      store: { ensureProfile: vi.fn(async () => profile()), claimDetectedLanguage },
      detectMatchingLanguage: vi.fn(async () => null)
    });
    expect(result).toEqual({ claimed: false, language: null });
    expect(claimDetectedLanguage).not.toHaveBeenCalled();
  });

  it("never overwrites a detected or user-selected preference", async () => {
    const detectMatchingLanguage = vi.fn();
    const result = await learnLanguageFromDeliveredExchange({
      userId: profile("user").userId,
      userText: "Hello",
      assistantText: "Hello",
      store: {
        ensureProfile: vi.fn(async () => profile("user")),
        claimDetectedLanguage: vi.fn()
      },
      detectMatchingLanguage
    });
    expect(result.claimed).toBe(false);
    expect(detectMatchingLanguage).not.toHaveBeenCalled();
  });
});
