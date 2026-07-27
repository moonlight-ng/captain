import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: "List the traveller's active Trips and get verified offers for the selected or requested Trip.",
  inputSchema: z.object({ tripId: z.uuid().optional() }).strict(),
  async execute({ tripId }, ctx) {
    const userId = requireCaptainUser(ctx);
    const services = await getCaptainServices();
    const trips = (await services.platformStore.listTrips(userId))
      .filter((trip) => !["cancelled", "completed", "archived"].includes(trip.status));
    const trip = tripId
      ? trips.find((candidate) => candidate.id === tripId) ?? null
      : await services.platformStore.getActiveTrip(userId);
    if (!trip) return { trips, trip: null, offers: [] };
    return { trips, trip, offers: await services.trips.offers(userId, trip.id) };
  }
});
