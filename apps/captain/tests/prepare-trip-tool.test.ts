import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
  prepare: null as unknown,
  handleOpenDraftText: null as unknown,
  prepareStructured: null as unknown,
  saveReviewableDraft: null as unknown
}));

vi.mock("../services/app/services.js", () => ({
  getCaptainServices: async () => ({
    tripPlanning: {
      prepare: state.prepare,
      handleOpenDraftText: state.handleOpenDraftText,
      prepareStructured: state.prepareStructured,
      saveReviewableDraft: state.saveReviewableDraft
    }
  })
}));

import prepareTripTool, {
  clearPrepareTripTurn,
  prepareTripInputSchema
} from "../agent/tools/prepare_trip.js";

type ToolResult = { status: string; guidance?: string };

function toolContext(turnId: string, sessionId = "session-1") {
  return {
    session: {
      id: sessionId,
      turn: { id: turnId, sequence: 1 },
      auth: {
        current: {
          attributes: {
            captain_principal: "traveller",
            captain_user_id: USER_ID
          }
        }
      }
    }
  };
}

async function call(request: string, turnId: string, sessionId?: string): Promise<ToolResult> {
  return await prepareTripTool.execute(
    { request },
    toolContext(turnId, sessionId) as never
  ) as ToolResult;
}

describe("prepare_trip turn ceiling", () => {
  beforeEach(() => {
    state.saveReviewableDraft = vi.fn(async () => ({
      status: "started",
      draft: { id: "draft-1", revision: 1 },
      receipt: { tripId: "trip-1", status: "draft" },
      message: "Itinerary ready to confirm."
    }));
    state.handleOpenDraftText = vi.fn(async () => null);
    state.prepare = vi.fn(async () => ({
      status: "needs_input",
      draft: { id: "draft-1", revision: 1 },
      prompt: "When can you fly London → Paris?",
      missingFields: ["departureDate"]
    }));
  });

  it("stops the third call in one turn without touching the planner", async () => {
    const request = "London to Paris in November";
    expect((await call(request, "turn-a")).status).toBe("needs_input");
    expect((await call(request, "turn-a")).status).toBe("needs_input");

    const third = await call(request, "turn-a");
    expect(third.status).toBe("call_limit_reached");
    expect(third.guidance).toContain("Do not call prepare_trip again");
    expect(state.prepare).toHaveBeenCalledTimes(2);
  });

  it("counts each turn separately", async () => {
    const request = "London to Paris in November";
    await call(request, "turn-b");
    await call(request, "turn-b");
    expect((await call(request, "turn-b")).status).toBe("call_limit_reached");
    expect((await call(request, "turn-c")).status).toBe("needs_input");
  });

  it("counts each session separately", async () => {
    const request = "London to Paris in November";
    await call(request, "turn-d", "session-x");
    await call(request, "turn-d", "session-x");
    expect((await call(request, "turn-d", "session-x")).status).toBe("call_limit_reached");
    expect((await call(request, "turn-d", "session-y")).status).toBe("needs_input");
  });

  it("releases the turn when the channel clears it", async () => {
    const request = "London to Paris in November";
    await call(request, "turn-e");
    await call(request, "turn-e");
    clearPrepareTripTurn("session-1", "turn-e");
    expect((await call(request, "turn-e")).status).toBe("needs_input");
  });
});

describe("prepare_trip declined turns", () => {
  beforeEach(() => {
    state.saveReviewableDraft = vi.fn(async () => ({
      status: "started",
      draft: { id: "draft-1", revision: 1 },
      receipt: { tripId: "trip-1", status: "draft" },
      message: "Itinerary ready to confirm."
    }));
    state.handleOpenDraftText = vi.fn(async () => null);
    state.prepare = vi.fn(async () => ({
      status: "needs_input",
      draft: { id: "draft-1", revision: 1 },
      prompt: "Where are you flying from?",
      missingFields: ["originAirports"]
    }));
  });

  // A bare "yes" the service declined used to be re-sent as a fresh planning
  // request, which answered with a clarification about a route nobody named.
  // That non-answer is what Captain kept rewording itself against.
  it("does not replan a soft yes the service declined", async () => {
    const result = await call("Yes", "turn-f");
    expect(result.status).toBe("no_op");
    expect(state.prepare).not.toHaveBeenCalled();
  });

  it("still plans a declined turn that carries an itinerary", async () => {
    const result = await call("Lagos to Nairobi on 12 September", "turn-g");
    expect(result.status).toBe("needs_input");
    expect(state.prepare).toHaveBeenCalledTimes(1);
  });

  it("hands stated legs straight to the structured path", async () => {
    const prepared = {
      status: "awaiting_confirmation",
      draft: { id: "draft-1", revision: 1 },
      confirmation: "Ready to create this trip:"
    };
    state.prepareStructured = vi.fn(async () => prepared);
    const result = await prepareTripTool.execute({
      request: "Four-city run, one adult, no return.",
      legs: [
        { origin: "London", destination: "Paris", departureDate: "2026-11-04" },
        { origin: "Paris", destination: "Marseille", departureDate: "2026-11-08" }
      ]
    }, toolContext("turn-i") as never) as ToolResult;

    // A finished plan is saved before the agent sees it: what comes back is the
    // receipt the traveller confirms, not a card asking them to create it.
    expect(result.status).toBe("started");
    expect(state.saveReviewableDraft).toHaveBeenCalledWith(USER_ID, prepared);
    expect(state.prepareStructured).toHaveBeenCalledTimes(1);
    // The prose parser never sees an itinerary that arrived already parsed.
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.handleOpenDraftText).not.toHaveBeenCalled();
  });

  // Shape is the framework's job, so these are asserted on the schema rather
  // than through execute, which only ever sees input that already passed.
  it("rejects a single structured leg, which prose already handles", () => {
    expect(prepareTripInputSchema.safeParse({
      request: "One flight",
      legs: [{ origin: "London", destination: "Paris", departureDate: "2026-11-04" }]
    }).success).toBe(false);
  });

  it("rejects a leg with neither a date nor a window", () => {
    expect(prepareTripInputSchema.safeParse({
      request: "Two flights",
      legs: [
        { origin: "London", destination: "Paris" },
        { origin: "Paris", destination: "Lagos" }
      ]
    }).success).toBe(false);
  });

  it("rejects a leg carrying both a date and a window", () => {
    expect(prepareTripInputSchema.safeParse({
      request: "Two flights",
      legs: [
        {
          origin: "London",
          destination: "Paris",
          departureDate: "2026-11-04",
          departureWindow: { start: "2026-11-04", end: "2026-11-06" }
        },
        { origin: "Paris", destination: "Lagos", departureDate: "2026-11-08" }
      ]
    }).success).toBe(false);
  });

  it("accepts a window in place of an exact date", () => {
    expect(prepareTripInputSchema.safeParse({
      request: "Two flights",
      legs: [
        {
          origin: "London",
          destination: "Paris",
          departureWindow: { start: "2026-11-04", end: "2026-11-06" }
        },
        { origin: "Paris", destination: "Lagos", departureDate: "2026-11-08" }
      ]
    }).success).toBe(true);
  });

  it("returns the decision when the service handled it", async () => {
    state.handleOpenDraftText = vi.fn(async () => ({
      status: "started",
      draft: { id: "draft-1", revision: 2 },
      receipt: { tripId: "trip-1" },
      message: "Tracking it."
    }));
    const result = await call("Yes", "turn-h");
    expect(result.status).toBe("started");
    expect(state.prepare).not.toHaveBeenCalled();
  });
});
