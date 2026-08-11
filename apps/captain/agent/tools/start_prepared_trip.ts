import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: [
    "Create the exact confirmed trip draft once.",
    "Call only after the traveller confirms the latest awaiting_confirmation revision",
    "(Create button, or a clear yes/confirm reply).",
    "A successful result contains a persisted trip receipt; return its message verbatim.",
    "Never claim creation without that receipt, and never call this to skip Create/Cancel."
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
