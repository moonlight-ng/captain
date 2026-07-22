import { updateTripSchema } from "@agents/flight-domain";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: "Update the title or complete normalized brief of one Trip. Send the version shown in current Trip context; a stale version is rejected. Changing flight criteria wakes that Trip's individual Watch.",
  inputSchema: z.object({ tripId: z.uuid(), update: updateTripSchema }).strict(),
  async execute({ tripId, update }, ctx) {
    const services = await getCaptainServices();
    return services.trips.update(requireCaptainUser(ctx), tripId, update);
  }
});
