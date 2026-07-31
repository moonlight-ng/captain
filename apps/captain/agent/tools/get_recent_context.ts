import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: [
    "Retrieve a bounded window of this traveller’s recent Captain messages.",
    "Use only when the current message is genuinely referential and cannot be resolved from the structured active trip or draft.",
    "Never use for greetings, new trip requests, confirmations, or as a substitute for trip state."
  ].join(" "),
  inputSchema: z.object({
    reason: z.enum(["ambiguous_reference", "prior_explanation"])
  }).strict(),
  async execute({ reason }, ctx) {
    const services = await getCaptainServices();
    const userId = requireCaptainUser(ctx);
    const conversation = await services.platformStore.getConversation(userId, 6);
    console.info(JSON.stringify({
      event: "captain.history_context_requested",
      user_id: userId,
      reason,
      message_count: conversation.recentMessages.length
    }));
    return {
      summary: conversation.summary,
      recentMessages: conversation.recentMessages
    };
  }
});
