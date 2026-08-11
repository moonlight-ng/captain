import { defineTool } from "eve/tools";
import { z } from "zod";
import type { TripPlanResult } from "@agents/flight-domain";

import { getCaptainServices } from "../../services/app/services.js";
import { requireCaptainUser } from "../lib/principal.js";

/**
 * Shape a planning-service result for the agent. Awaiting confirmation must
 * stay awaiting — auto-confirming here skipped Create/Cancel and jumped to a
 * bare dashboard link.
 */
export function agentFacingPrepareResult(result: TripPlanResult): TripPlanResult | (Extract<
  TripPlanResult,
  { status: "awaiting_confirmation" }
> & { message: string }) {
  if (result.status === "needs_input" && result.promptParts) {
    const { promptParts, ...rest } = result;
    return rest;
  }
  if (result.status === "awaiting_confirmation") {
    return {
      ...result,
      message: result.confirmation
    };
  }
  return result;
}

export default defineTool({
  description: [
    "Prepare or revise one durable, GUI-editable trip draft from the traveller's itinerary.",
    "Ask at most the service-provided two ambiguity questions; after that Captain uses safe best-fit date windows and presents the plan for Create/Cancel review without starting fare tracking.",
    "Use this immediately for both straightforward requests and uncertain itineraries; the traveller reviews the Plan page and changes route or timing details in Trip Settings.",
    "Return the service prompt or confirmation verbatim; do not add questions, recalculate dates, or rewrite defaults.",
    "When status is awaiting_confirmation, stop and return that confirmation — do not call start_prepared_trip until the traveller confirms.",
    "A no_trip_change status means the request carried no route or date and the traveller already has a trip:",
    "nothing was created or altered, so answer their question from the returned trip instead of asking for a route."
  ].join(" "),
  inputSchema: z.object({
    request: z.string().trim().min(1).max(2_000),
    draftId: z.uuid().optional()
  }).strict(),
  async execute({ request, draftId }, ctx) {
    const services = await getCaptainServices();
    const userId = requireCaptainUser(ctx);
    // An open draft interprets the turn against what it has already collected
    // — a revision, a decision, a restart. The Telegram channel used to do this
    // before the agent ran; now that it only handles unambiguous decisions,
    // the tool owns the rest.
    const result = draftId
      ? await services.tripPlanning.prepare(userId, request, null, draftId)
      : await services.tripPlanning.handleOpenDraftText(userId, request, null)
        ?? await services.tripPlanning.prepare(userId, request, null);
    return agentFacingPrepareResult(result);
  }
});
