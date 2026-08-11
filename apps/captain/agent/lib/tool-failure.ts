import { TripLimitError } from "@agents/flight-domain";

/**
 * What a tool says to the model when something went wrong inside it.
 *
 * Eve hands a thrown error's `message` to the model verbatim, and the model
 * has no way to tell an internal string from something meant for a traveller.
 * "A direct trip-planning request was not handled" reached a chat window that
 * way. Every failure here becomes a named status with a next step, so the
 * model has something to do rather than something to quote.
 */
export type ToolFailure = {
  status: "trip_limit" | "draft_conflict" | "no_active_trip" | "tool_failed";
  guidance: string;
};

const DRAFT_CONFLICT = /draft (?:changed|is stale)|expectedRevision|revision mismatch/iu;
const NO_ACTIVE_TRIP = /no active trip|trip not found/iu;

export function toolFailure(error: unknown): ToolFailure {
  if (error instanceof TripLimitError) {
    return {
      status: "trip_limit",
      guidance: "The traveller already has an active trip. Tell them Captain follows one"
        + " trip at a time and ask whether to swap it for this one."
    };
  }
  const message = error instanceof Error ? error.message : "";
  if (DRAFT_CONFLICT.test(message)) {
    return {
      status: "draft_conflict",
      guidance: "The trip draft moved while this ran, usually because the traveller"
        + " edited it. Read the current state with get_trip before saying anything"
        + " about it, and do not repeat this call."
    };
  }
  if (NO_ACTIVE_TRIP.test(message)) {
    return {
      status: "no_active_trip",
      guidance: "There is no trip to act on. Ask the traveller where they want to go"
        + " rather than describing a trip they do not have."
    };
  }
  console.error(JSON.stringify({
    event: "captain.tool_failed",
    error: error instanceof Error ? error.name : "UnknownError",
    message: message.slice(0, 200)
  }));
  return {
    status: "tool_failed",
    guidance: "That step did not go through and nothing changed. Tell the traveller"
      + " plainly that it did not work and that their trip is untouched. Do not"
      + " retry it in this turn, and do not describe the failure in Captain's"
      + " internal terms."
  };
}

/** Runs a tool body, turning any throw into a result the model can act on. */
export async function reportingFailures<T>(
  run: () => Promise<T>
): Promise<T | ToolFailure> {
  try {
    return await run();
  } catch (error) {
    return toolFailure(error);
  }
}
