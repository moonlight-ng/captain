import { defineTool } from "eve/tools";
import { z } from "zod";

import { getFlightAgentServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: "Get one of the current traveller's Trips and its currently valid discovered offers. Never use an ID belonging to another traveller.",
  inputSchema: z.object({ tripId: z.uuid() }).strict(),
  async execute({ tripId }, ctx) {
    const userId = requireCaptainUser(ctx);
    const services = await getFlightAgentServices();
    const trip = await services.trips.get(userId, tripId);
    if (!trip) throw new Error("Trip not found");
    return { trip, offers: await services.trips.offers(userId, tripId) };
  }
});
