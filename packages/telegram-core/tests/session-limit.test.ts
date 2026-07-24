import { describe, expect, it } from "vitest";

import {
  continueCallbackDataFromMarkup,
  isSessionLimitContinuationRequest,
  looksLikeSessionBudgetPrompt,
  partitionSessionLimitRequests,
  storePendingSessionRotation,
  takePendingSessionRotation
} from "../src/session-limit.js";

describe("shared Telegram session-limit handling", () => {
  it("recognizes and partitions Eve budget prompts", () => {
    const request = {
      requestId: "limit",
      prompt: "The session used 106,581 of its 100,000 input-token budget. Continue with a fresh budget?",
      action: { toolName: "session_limit_continuation" },
      options: [
        { id: "continue", label: "Continue" },
        { id: "stop", label: "Stop" }
      ]
    };
    expect(looksLikeSessionBudgetPrompt(request.prompt)).toBe(true);
    expect(isSessionLimitContinuationRequest(request)).toBe(true);
    expect(partitionSessionLimitRequests([
      request,
      { requestId: "question", prompt: "Where are you flying from?" }
    ])).toMatchObject({
      limitRequests: [request],
      otherRequests: [{ requestId: "question" }]
    });
  });

  it("stores the invisible continuation callback across session waiting", () => {
    const markup = {
      inline_keyboard: [[
        { text: "Continue", callback_data: "eve:continue" },
        { text: "Stop", callback_data: "eve:stop" }
      ]]
    };
    expect(continueCallbackDataFromMarkup(markup)).toBe("eve:continue");
    const state: Record<string, unknown> = {};
    const pending = {
      chatId: "42",
      requestId: "limit",
      continueCallbackData: "eve:continue"
    };
    storePendingSessionRotation(state, pending);
    expect(takePendingSessionRotation(state)).toEqual(pending);
    expect(takePendingSessionRotation(state)).toBeNull();
  });
});
