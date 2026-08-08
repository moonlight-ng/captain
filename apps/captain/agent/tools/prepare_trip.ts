import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: [
    "Prepare or revise one durable trip draft from an exact dated itinerary.",
    "Ground the request in the traveller's words and the route and exact dates they accepted; never invent missing planning decisions.",
    "Use this immediately when a straightforward request already contains exact dates; use itinerary planning first only when the traveller is unsure.",
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
