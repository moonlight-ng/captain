import { logEvent } from "@agents/observability";
import type {
  CaptainPlatformStore,
  OnboardingFollowupStage
} from "@agents/flight-store";

export const CAPTAIN_ONBOARDING_CAPABILITIES =
  "I can help you figure out where to go, plan a multi-city trip, compare flight options across different dates, or watch for fare changes once your trip is set.";
export const CAPTAIN_ONBOARDING_WORKSPACE =
  "You can send requests via voice note or text and I’ll take it from there. Once we start a trip, you’ll also get a shared workspace to follow it.";
export const CAPTAIN_ONBOARDING_COMMANDS =
  "If you need any help, use the menu beside the message box to browse available commands.";

const MESSAGE_BY_STAGE: Readonly<Record<OnboardingFollowupStage, string>> = {
  capabilities: CAPTAIN_ONBOARDING_CAPABILITIES,
  workspace: CAPTAIN_ONBOARDING_WORKSPACE,
  commands: CAPTAIN_ONBOARDING_COMMANDS
};

export class OnboardingFollowupDispatcher {
  readonly #store: CaptainPlatformStore;
  readonly #telegramBotToken: string;
  readonly #fetch: typeof fetch;
  readonly #leaseMs: number;
  readonly #limit: number;

  constructor(options: {
    store: CaptainPlatformStore;
    telegramBotToken: string;
    fetch?: typeof fetch;
    leaseMs?: number;
    limit?: number;
  }) {
    this.#store = options.store;
    this.#telegramBotToken = options.telegramBotToken;
    this.#fetch = options.fetch ?? fetch;
    this.#leaseMs = options.leaseMs ?? 5 * 60_000;
    this.#limit = options.limit ?? 25;
  }

  async tick(now = new Date()): Promise<{ claimed: number; sent: number; failed: number }> {
    const followups = await this.#store.claimDueOnboardingFollowups(
      now,
      this.#leaseMs,
      this.#limit
    );
    let sent = 0;
    let failed = 0;
    for (const followup of followups) {
      if (!await this.#store.revalidateOnboardingFollowup(
        followup.userId,
        followup.stage,
        now
      )) continue;
      const message = MESSAGE_BY_STAGE[followup.stage];
      try {
        const telegramMessageId = await this.#post(followup.telegramChatId, message);
        await this.#store.markOnboardingFollowupSent(
          followup.userId,
          followup.stage,
          telegramMessageId,
          message,
          now
        );
        sent += 1;
        logEvent("info", "captain.onboarding_followup_sent", {
          stage: followup.stage,
          attempt: followup.attempts
        });
      } catch (error) {
        failed += 1;
        await this.#store.markOnboardingFollowupFailed(
          followup.userId,
          followup.stage,
          error instanceof Error ? error.message : "Telegram delivery failed",
          now
        );
        logEvent("warn", "captain.onboarding_followup_failed", {
          stage: followup.stage,
          attempt: followup.attempts,
          error: error instanceof Error ? error.name : "UnknownError"
        });
      }
    }
    return { claimed: followups.length, sent, failed };
  }

  async #post(chatId: number, text: string): Promise<number> {
    const response = await this.#fetch(
      `https://api.telegram.org/bot${this.#telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true
        }),
        signal: AbortSignal.timeout(15_000)
      }
    );
    if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
    const result = await response.json() as { ok?: boolean; result?: { message_id?: number } };
    const messageId = result.result?.message_id;
    if (result.ok !== true || !Number.isSafeInteger(messageId)) {
      throw new Error("Telegram did not return a message ID");
    }
    return messageId!;
  }
}
