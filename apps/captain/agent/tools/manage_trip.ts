import { tripActionSchema } from "@agents/flight-domain";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: "Pause, resume, refresh, cancel, or complete a trip. Refresh wakes its Watch; the orchestration worker performs the search asynchronously.",
  inputSchema: z.object({ tripId: z.uuid().optional(), action: tripActionSchema }).strict(),
  async execute({ tripId, action }, ctx) {
    const services = await getCaptainServices();
    const userId = requireCaptainUser(ctx);
    const trip = tripId
      ? await services.platformStore.getTrip(userId, tripId)
      : await services.platformStore.getActiveTrip(userId);
    if (!trip) throw new Error("No active trip");
    return services.trips.action(userId, trip.id, action);
  }
});
