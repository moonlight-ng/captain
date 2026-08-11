import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";
import { reportingFailures } from "../lib/tool-failure.js";

export default defineTool({
  description: [
    "Save a prepared trip draft that is somehow still awaiting confirmation.",
    "You will almost never need this: prepare_trip already saves a finished plan and returns its receipt,",
    "so reach for this only when a draft was left unsaved by an interrupted turn.",
    "A successful result contains a persisted trip receipt; return its message verbatim.",
    "Never claim creation without that receipt."
  ].join(" "),
  inputSchema: z.object({
    draftId: z.uuid(),
    expectedRevision: z.number().int().positive()
  }).strict(),
  async execute({ draftId, expectedRevision }, ctx) {
    return reportingFailures(async () => {
      const services = await getCaptainServices();
      return services.tripPlanning.confirm(
        requireCaptainUser(ctx),
        draftId,
        expectedRevision
      );
    });
  }
});
