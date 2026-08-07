import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: [
    "Check verified flight inventory for questions about an airline, fare, price, schedule, or available flight.",
    "Always use this for requests such as ‘What’s British Airways looking like?’",
    "It checks stored offers for the active trip first; when none match, it runs a read-only live search for the active trip or latest confirmed draft.",
    "It never creates, confirms, or changes a trip. Describe only the offers returned."
  ].join(" "),
  inputSchema: z.object({
    airlineCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,3}$/u).optional(),
    tripId: z.uuid().optional(),
    draftId: z.uuid().optional()
  }).strict(),
  async execute(input, ctx) {
    const services = await getCaptainServices();
    return services.flightLookup.search(requireCaptainUser(ctx), input);
  }
});
