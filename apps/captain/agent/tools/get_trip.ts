import { summarizePriceHistory } from "@agents/flight-domain";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description:
    "List the traveller's active trips and get verified offers for the selected or requested trip, "
    + "with the price history of the flight they are watching.",
  inputSchema: z.object({ tripId: z.uuid().optional() }).strict(),
  async execute({ tripId }, ctx) {
    const userId = requireCaptainUser(ctx);
    const services = await getCaptainServices();
    const trips = (await services.platformStore.listTrips(userId))
      .filter((trip) => !["cancelled", "completed", "archived"].includes(trip.status));
    const trip = tripId
      ? trips.find((candidate) => candidate.id === tripId) ?? null
      : await services.platformStore.getActiveTrip(userId);
    if (!trip) return { trips, trip: null, offers: [], watchedFlight: null };
    const [offers, tracked] = await Promise.all([
      services.trips.offers(userId, trip.id),
      services.platformStore.getTrackedFlightPrices(userId, trip.id)
    ]);
    return {
      trips,
      trip,
      offers,
      // The whole point of the trip: what the watched fare has done, and
      // whether now is the moment. Null until the traveller picks a flight.
      watchedFlight: tracked
        ? {
            itineraryKey: tracked.itineraryKey,
            ...summarizePriceHistory({
              observations: tracked.observations,
              currency: tracked.currency,
              departureDate: trip.brief.departureWindow.start
            })
          }
        : null
    };
  }
});
