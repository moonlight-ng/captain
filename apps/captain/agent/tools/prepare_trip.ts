import { defineTool } from "eve/tools";
import { z } from "zod";
import type { TripPlanResult } from "@agents/flight-domain";

import { getCaptainServices } from "../../services/app/services.js";
import { TripPlanningService } from "../../services/trip-planning/service.js";
import { requireCaptainUser } from "../lib/principal.js";

/**
 * One call to prepare, one to correct it. A third is never a better phrasing —
 * the service already said what it needed, and rewording the same request
 * against a deterministic parser only burns the turn. Captain used to loop
 * here until it gave up and offered to drop a city.
 */
const MAX_PREPARE_CALLS_PER_TURN = 2;
/** Bounds the map when a turn dies before `turn.completed` can clear it. */
const TRACKED_TURNS = 64;
const preparesByTurn = new Map<string, number>();

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

/** Counts this call and reports whether it is past the ceiling. */
function claimPrepareCall(sessionId: string, turnId: string): boolean {
  const key = turnKey(sessionId, turnId);
  const used = preparesByTurn.get(key) ?? 0;
  if (used >= MAX_PREPARE_CALLS_PER_TURN) return false;
  preparesByTurn.delete(key);
  preparesByTurn.set(key, used + 1);
  while (preparesByTurn.size > TRACKED_TURNS) {
    const oldest = preparesByTurn.keys().next();
    if (oldest.done) break;
    preparesByTurn.delete(oldest.value);
  }
  return true;
}

export function clearPrepareTripTurn(sessionId: string, turnId: string): void {
  preparesByTurn.delete(turnKey(sessionId, turnId));
}

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
    "nothing was created or altered, so answer their question from the returned trip instead of asking for a route.",
    "Never call this more than twice in one turn, and never re-send the same itinerary in different words:",
    "the planner reads it deterministically, so a rephrasing cannot change the outcome.",
    "If a result does not give you what you expected, tell the traveller which detail is unresolved and ask for it."
  ].join(" "),
  inputSchema: z.object({
    request: z.string().trim().min(1).max(2_000),
    draftId: z.uuid().optional()
  }).strict(),
  async execute({ request, draftId }, ctx) {
    const services = await getCaptainServices();
    const userId = requireCaptainUser(ctx);
    if (!claimPrepareCall(ctx.session.id, ctx.session.turn.id)) {
      return {
        status: "call_limit_reached" as const,
        guidance: "You have already prepared this turn twice. Do not call prepare_trip again."
          + " Tell the traveller which detail you could not resolve and ask them for it,"
          + " in one short message."
      };
    }
    // An open draft interprets the turn against what it has already collected
    // — a revision, a decision, a restart. The Telegram channel used to do this
    // before the agent ran; now that it only handles unambiguous decisions,
    // the tool owns the rest.
    if (draftId) {
      return agentFacingPrepareResult(
        await services.tripPlanning.prepare(userId, request, null, draftId)
      );
    }
    const decided = await services.tripPlanning.handleOpenDraftText(userId, request, null);
    if (decided) return agentFacingPrepareResult(decided);
    // A null here is the service declining the turn, not asking for a retry.
    // Re-feeding a bare "yes" as a fresh planning request produced a
    // clarification about a route the traveller never mentioned, which is the
    // non-answer Captain used to keep rewording itself against.
    if (!TripPlanningService.isTripPlanningRequest(request)) {
      return {
        status: "no_op" as const,
        guidance: "Nothing was pending for that reply and it carried no itinerary."
          + " Ask the traveller for the itinerary detail you still need, or answer"
          + " their question from the trip they already have."
      };
    }
    return agentFacingPrepareResult(
      await services.tripPlanning.prepare(userId, request, null)
    );
  }
});
