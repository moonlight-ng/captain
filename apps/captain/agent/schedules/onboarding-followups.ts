import { defineSchedule } from "eve/schedules";
import { logEvent } from "@agents/observability";

import { getCaptainServices } from "../../services/app/services.js";
import { OnboardingFollowupDispatcher } from "../../services/onboarding/followups.js";

export default defineSchedule({
  cron: "*/5 * * * *",
  async run() {
    const services = await getCaptainServices();
    if (!services.env.telegramBotToken) {
      logEvent("warn", "captain.onboarding_followup_skipped", {
        reason: "telegram_not_configured"
      });
      return;
    }
    const dispatcher = new OnboardingFollowupDispatcher({
      store: services.platformStore,
      telegramBotToken: services.env.telegramBotToken
    });
    const result = await dispatcher.tick();
    if (result.claimed > 0) {
      logEvent("info", "captain.onboarding_followup_tick", result);
    }
  }
});
