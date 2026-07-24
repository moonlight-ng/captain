import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: [
    "Prepare or revise one durable Trip draft from the traveller's exact words.",
    "Use this instead of constructing Trip fields yourself.",
    "Return the service prompt or confirmation verbatim; do not recalculate dates or rewrite defaults."
  ].join(" "),
  inputSchema: z.object({
    request: z.string().trim().min(1).max(2_000),
    draftId: z.uuid().optional()
  }).strict(),
  async execute({ request, draftId }, ctx) {
    const services = await getCaptainServices();
    return services.tripPlanning.prepare(
      requireCaptainUser(ctx),
      request,
      null,
      draftId
    );
  }
});
