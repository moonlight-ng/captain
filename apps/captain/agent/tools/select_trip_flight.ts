import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: [
    "Save or remove one discovered flight from a trip for the traveller.",
    "For a normalized per-leg result, provide legId and use the exact flightKey from get_trip as itineraryKey.",
    "For a legacy whole-trip offer, omit legId and use its exact itineraryKey."
  ].join(" "),
  inputSchema: z.object({
    tripId: z.uuid().optional(),
    legId: z.uuid().optional(),
    itineraryKey: z.string().trim().min(1).max(500),
    selected: z.boolean().default(true)
  }).strict(),
  async execute({ tripId, legId, itineraryKey, selected }, ctx) {
    const services = await getCaptainServices();
    const userId = requireCaptainUser(ctx);
    const trip = tripId
      ? await services.platformStore.getTrip(userId, tripId)
      : await services.platformStore.getActiveTrip(userId);
    if (!trip) throw new Error("No active trip");
    if (legId) {
      const leg = await services.platformStore.setTripLegFlight(
        userId,
        trip.id,
        legId,
        selected ? itineraryKey.trim() : null,
        new Date()
      );
      return {
        tripId: trip.id,
        legId: leg.id,
        flightKey: leg.selectedFlightKey,
        selected: leg.selectedFlightKey !== null
      };
    }
    const result = await services.trips.selectFlight(
      userId,
      trip.id,
      itineraryKey,
      selected
    );
    if (!result) throw new Error("Trip not found");
    return result;
  }
});
