import { createTripSchema } from "@agents/flight-domain";
import { defineTool } from "eve/tools";

import { getFlightAgentServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: "Start one durable Trip and its flight-tracking Watch. Resolve city names to informed IATA or metro codes yourself. Reuse the active Trip unless the traveller explicitly asks for a distinct journey. Call this once only after the required route and dates are clear.",
  inputSchema: createTripSchema,
  async execute(input, ctx) {
    const userId = requireCaptainUser(ctx);
    const services = await getFlightAgentServices();
    const result = await services.trips.create(userId, input);
    return {
      ...result,
      message: `Trip started. Captain will search ${result.searchCombinations} combination${result.searchCombinations === 1 ? "" : "s"} and notify you when the first strong option is ready.`
    };
  }
});
