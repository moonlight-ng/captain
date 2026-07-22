import { tripActionSchema } from "@agents/flight-domain";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: "Pause, resume, refresh, cancel, or complete a Trip. Refresh wakes its Watch; the orchestration worker performs the search asynchronously.",
  inputSchema: z.object({ tripId: z.uuid(), action: tripActionSchema }).strict(),
  async execute({ tripId, action }, ctx) {
    const services = await getCaptainServices();
    return services.trips.action(requireCaptainUser(ctx), tripId, action);
  }
});
