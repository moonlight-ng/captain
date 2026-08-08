import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: [
    "Search verified live flights for one leg of the traveller's current multi-city trip.",
    "The leg is searched once for every date in its departure window, up to seven days.",
    "Use departureStart and departureEnd together to search a narrower range inside the leg's window.",
    "Describe only returned flights and fares.",
    "Only call a fare the cheapest across the range when canClaimCheapestAcrossRange is true; otherwise state exactly how many dates completed."
  ].join(" "),
  inputSchema: z.object({
    tripId: z.uuid().optional(),
    legId: z.uuid(),
    departureStart: z.iso.date().optional(),
    departureEnd: z.iso.date().optional()
  }).strict().superRefine((input, context) => {
    if ((input.departureStart === undefined) !== (input.departureEnd === undefined)) {
      context.addIssue({
        code: "custom",
        message: "departureStart and departureEnd must be provided together"
      });
    }
  }),
  async execute(input, ctx) {
    const services = await getCaptainServices();
    const userId = requireCaptainUser(ctx);
    const trip = input.tripId
      ? await services.platformStore.getTrip(userId, input.tripId)
      : await services.platformStore.getActiveTrip(userId);
    if (!trip) {
      return {
        status: "not_found",
        code: "active_trip_not_found",
        message: "There is no current trip to search.",
        canClaimCheapestAcrossRange: false
      };
    }
    const result = await services.legSearch.search(userId, {
      tripId: trip.id,
      legId: input.legId,
      ...(input.departureStart && input.departureEnd
        ? { requestedWindow: { start: input.departureStart, end: input.departureEnd } }
        : {})
    });
    return {
      status: result.status,
      code: result.code,
      message: result.message,
      snapshot: result.snapshot,
      coverage: result.coverage,
      reusedDates: result.reusedDates,
      searchedDates: result.searchedDates,
      canClaimCheapestAcrossRange: result.canClaimCheapestAcrossRange
    };
  }
});
