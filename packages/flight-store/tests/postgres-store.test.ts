import { describe, expect, it } from "vitest";

import { PostgresCaptainPlatformStore } from "../src/postgres-store.js";

type CapturedQuery = {
  strings: readonly string[];
  args: unknown[];
};

const userId = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-08-01T12:00:00.000Z");
const profileRow = {
  user_id: userId,
  default_currency: "USD",
  ranking_mode: "balanced",
  preferred_airline_codes: [],
  excluded_airline_codes: [],
  alerts_enabled: true,
  notification_mode: "smart",
  price_rise_alerts_enabled: true,
  better_option_alerts_enabled: true,
  last_digest_at: null,
  max_alerts_per_day: 2,
  quiet_hours_enabled: false,
  quiet_hours_start: 22,
  quiet_hours_end: 7,
  preferred_language: "en",
  preferred_language_source: "default",
  preferred_language_set_at: null,
  onboarding_completed_at: null,
  onboarding_step: "welcome",
  created_at: now,
  updated_at: now
};

describe("PostgresCaptainPlatformStore", () => {
  it("uses typed presence flags when onboarding omits notificationMode", async () => {
    let profileUpdate: CapturedQuery | undefined;
    const sql = Object.assign(
      (strings: TemplateStringsArray, ...args: unknown[]) => {
        const query = { strings: [...strings], args };
        if (strings.some((fragment) => fragment.includes("update captain.traveller_profiles set"))) {
          profileUpdate = query;
          return Promise.resolve([{
            ...profileRow,
            default_currency: "GBP",
            onboarding_step: "complete",
            updated_at: now
          }]);
        }
        if (strings.some((fragment) => fragment.includes("insert into captain.traveller_profiles"))) {
          return Promise.resolve([profileRow]);
        }
        return Promise.resolve([]);
      },
      { json: (value: unknown) => value }
    );
    const store = Reflect.construct(
      PostgresCaptainPlatformStore,
      [sql]
    ) as PostgresCaptainPlatformStore;

    await expect(store.updateProfile(
      userId,
      { defaultCurrency: "GBP", onboardingStep: "complete" },
      now
    )).resolves.toMatchObject({
      defaultCurrency: "GBP",
      onboardingStep: "complete"
    });

    expect(argumentAfter(profileUpdate!, "alerts_enabled = case")).toBe(false);
    expect(argumentAfter(profileUpdate!, "notification_mode = case")).toBe(false);
  });
});

function argumentAfter(query: CapturedQuery, marker: string): unknown {
  const index = query.strings.findIndex((fragment) => fragment.includes(marker));
  expect(index).toBeGreaterThanOrEqual(0);
  return query.args[index];
}
