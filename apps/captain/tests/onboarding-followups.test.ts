import { describe, expect, it, vi } from "vitest";

import {
  MemoryCaptainPlatformStore,
  ONBOARDING_FOLLOWUP_STAGES
} from "@agents/flight-store";

import {
  CAPTAIN_ONBOARDING_CAPABILITIES,
  OnboardingFollowupDispatcher
} from "../services/onboarding/followups.js";

describe("staggered Telegram onboarding", () => {
  it("keeps the orientation cadence at 6, 24, and 72 hours", () => {
    expect(ONBOARDING_FOLLOWUP_STAGES).toEqual([
      { stage: "capabilities", delayMs: 6 * 60 * 60_000 },
      { stage: "workspace", delayMs: 24 * 60 * 60_000 },
      { stage: "commands", delayMs: 72 * 60 * 60_000 }
    ]);
  });

  it("sends the first due orientation once and remembers the exact Telegram copy", async () => {
    const store = new MemoryCaptainPlatformStore();
    const startedAt = new Date("2026-08-01T10:00:00Z");
    const user = await store.ensureTelegramUser({
      telegramUserId: 7,
      telegramChatId: 70,
      username: null,
      firstName: "Ada",
      lastName: null
    }, startedAt);
    await store.updateProfile(user.id, { quietHoursEnabled: false }, startedAt);
    await store.appendMessage(user.id, "user", "/start", new Date("2026-08-01T09:59:59Z"));
    await store.claimOnboardingWelcome(user.id, startedAt);

    const requests: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 501 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const dispatcher = new OnboardingFollowupDispatcher({
      store,
      telegramBotToken: "test-token",
      fetch: fetcher
    });

    await expect(dispatcher.tick(new Date("2026-08-01T15:59:59Z"))).resolves.toEqual({
      claimed: 0,
      sent: 0,
      failed: 0
    });
    await expect(dispatcher.tick(new Date("2026-08-01T16:00:00Z"))).resolves.toEqual({
      claimed: 1,
      sent: 1,
      failed: 0
    });
    expect(requests).toEqual([{
      chat_id: 70,
      text: CAPTAIN_ONBOARDING_CAPABILITIES,
      disable_web_page_preview: true
    }]);
    await expect(dispatcher.tick(new Date("2026-08-01T16:01:00Z"))).resolves.toEqual({
      claimed: 0,
      sent: 0,
      failed: 0
    });
    await expect(store.getConversation(user.id)).resolves.toMatchObject({
      recentMessages: expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: CAPTAIN_ONBOARDING_CAPABILITIES })
      ])
    });
  });

  it("does not send a claimed stage after workspace activity disables the sequence", async () => {
    const store = new MemoryCaptainPlatformStore();
    const startedAt = new Date("2026-08-01T10:00:00Z");
    const user = await store.ensureTelegramUser({
      telegramUserId: 8,
      telegramChatId: 80,
      username: null,
      firstName: "Grace",
      lastName: null
    }, startedAt);
    await store.updateProfile(user.id, { quietHoursEnabled: false }, startedAt);
    await store.claimOnboardingWelcome(user.id, startedAt);
    const [claimed] = await store.claimDueOnboardingFollowups(
      new Date("2026-08-01T16:00:00Z"),
      300_000,
      10
    );
    expect(claimed?.stage).toBe("capabilities");
    await store.disableOnboardingFollowups(
      user.id,
      "workspace_opened",
      new Date("2026-08-01T16:00:01Z")
    );

    const fetcher = vi.fn() as unknown as typeof fetch;
    const dispatcher = new OnboardingFollowupDispatcher({
      store,
      telegramBotToken: "test-token",
      fetch: fetcher
    });
    await expect(dispatcher.tick(new Date("2026-08-04T10:00:00Z"))).resolves.toEqual({
      claimed: 0,
      sent: 0,
      failed: 0
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(store.revalidateOnboardingFollowup(
      user.id,
      "capabilities",
      new Date("2026-08-01T16:00:02Z")
    )).resolves.toBe(false);
  });
});
