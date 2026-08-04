import { tripActionSchema } from "@agents/flight-domain";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: "Pause, resume, refresh, explicitly track stale prices again for three days, cancel, or complete a trip. Searches run asynchronously.",
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
