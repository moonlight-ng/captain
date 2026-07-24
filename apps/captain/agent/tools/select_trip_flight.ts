import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: "Save or remove one discovered flight itinerary from a Trip for the traveller. Use the exact itineraryKey returned by get_trip.",
  inputSchema: z.object({
    tripId: z.uuid(),
    itineraryKey: z.string().trim().min(1).max(500),
    selected: z.boolean().default(true)
  }).strict(),
  async execute({ tripId, itineraryKey, selected }, ctx) {
    const services = await getCaptainServices();
    const result = await services.trips.selectFlight(
      requireCaptainUser(ctx),
      tripId,
      itineraryKey,
      selected
    );
    if (!result) throw new Error("Trip not found");
    return result;
  }
});
