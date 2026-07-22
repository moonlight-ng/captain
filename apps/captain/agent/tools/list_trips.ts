import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: "List only the current traveller's Trips. Use this before acting when a Trip reference is unclear.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    const services = await getCaptainServices();
    return { trips: await services.trips.list(requireCaptainUser(ctx)) };
  }
});
