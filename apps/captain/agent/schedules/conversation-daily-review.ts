import { defineSchedule } from "eve/schedules";
import { logEvent } from "@agents/observability";

import { getCaptainServices } from "../../services/app/services.js";

// Eve cron is UTC. Lagos remains UTC+1 year-round, so this is 07:15 local.
export default defineSchedule({
  cron: "15 6 * * *",
  async run() {
    const services = await getCaptainServices();
    if (!services.env.conversationReviewEnabled) return;
    if (!services.conversationReview) {
      logEvent("warn", "captain.conversation_review_skipped", {
        reason: "email_or_model_not_configured"
      });
      return;
    }
    const result = await services.conversationReview.reviewNow();
    logEvent("info", "captain.conversation_review_completed", result);
  }
});
