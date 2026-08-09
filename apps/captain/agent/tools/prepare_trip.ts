import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description: [
    "Prepare or revise one durable, GUI-editable trip draft from the traveller's itinerary.",
    "Ask at most the service-provided two ambiguity questions; after that Captain uses safe best-fit date windows and saves the draft without starting fare tracking.",
    "Use this immediately for both straightforward requests and uncertain itineraries; the traveller reviews the Plan page and changes route or timing details in Trip Settings.",
    "Return the service prompt, summary, or creation receipt verbatim; do not add questions, recalculate dates, or rewrite defaults."
  ].join(" "),
  inputSchema: z.object({
    request: z.string().trim().min(1).max(2_000),
    draftId: z.uuid().optional()
  }).strict(),
  async execute({ request, draftId }, ctx) {
    const services = await getCaptainServices();
    const result = await services.tripPlanning.prepare(
      requireCaptainUser(ctx),
      request,
      null,
      draftId
    );
    if (result.status === "awaiting_confirmation") {
      return services.tripPlanning.confirm(
        requireCaptainUser(ctx),
        result.draft.id,
        result.draft.revision
      );
    }
    // How a chat channel splits the prompt into messages is delivery, not
    // planning. Handing the agent both forms of the same words invites it to
    // return them twice, so it only ever sees `prompt`.
    if (result.status === "needs_input" && result.promptParts) {
      const { promptParts, ...rest } = result;
      return rest;
    }
    return result;
  }
});
