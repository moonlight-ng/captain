import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: [
    "Create the exact confirmed Trip draft once.",
    "Call only after the traveller confirms the latest revision.",
    "A successful result contains a persisted Trip receipt; return its message verbatim.",
    "Never claim creation without that receipt."
  ].join(" "),
  inputSchema: z.object({
    draftId: z.uuid(),
    expectedRevision: z.number().int().positive()
  }).strict(),
  async execute({ draftId, expectedRevision }, ctx) {
    const services = await getCaptainServices();
    return services.tripPlanning.confirm(
      requireCaptainUser(ctx),
      draftId,
      expectedRevision
    );
  }
});
