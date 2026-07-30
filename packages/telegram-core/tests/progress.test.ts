import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GENERAL_PROGRESS_FALLBACK,
  progressTextForRequest,
  progressTextFromAttribute,
  statusTextForToolNames,
  TelegramProgressTracker,
  toolNamesFromActions,
  TRAVEL_PROGRESS_FALLBACK
} from "../src/index.js";

describe("Telegram progress copy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("describes common requests instead of using one blanket acknowledgement", () => {
    expect(progressTextForRequest("Find the latest OpenAI API changes")).toBe(
      "Looking that up…"
    );
    expect(progressTextForRequest("Fix the failing webhook test")).toBe(
      "Tracing the issue…"
    );
    expect(progressTextForRequest("Draft a short reply to this email")).toBe(
      "Drafting that…"
    );
    expect(progressTextForRequest("What is a durable workflow?")).toBe(
      "Thinking through the explanation…"
    );
    expect(progressTextForRequest("Take care of this")).toBe(
      GENERAL_PROGRESS_FALLBACK
    );
  });

  it("uses attachment and travel-specific context", () => {
    expect(progressTextForRequest("", { hasAttachments: true })).toBe(
      "Reading what you sent…"
    );
    expect(progressTextForRequest("Why did you recommend this flight?", {
      context: "travel"
    })).toBe("Reviewing that recommendation…");
    expect(progressTextForRequest("Pause this", { context: "travel" })).toBe(
      "Updating your Trip…"
    );
    expect(progressTextForRequest("Help me with this", { context: "travel" })).toBe(
      TRAVEL_PROGRESS_FALLBACK
    );
  });

  it("uses friendly tool statuses without leaking internal tool names", () => {
    expect(statusTextForToolNames(["web_search"])).toBe("Searching the web…");
    expect(statusTextForToolNames(
      ["prepare_trip"],
      { prepare_trip: "Working through the route and dates…" }
    )).toBe("Working through the route and dates…");
    expect(statusTextForToolNames(
      ["internal_database_v2"],
      {},
      "Checking your Trip…"
    )).toBe("Checking your Trip…");
  });

  it("extracts action names and validates stored progress copy", () => {
    expect(toolNamesFromActions([
      { toolName: "web_search" },
      { name: "ask_question" },
      {}
    ])).toEqual(["web_search", "ask_question"]);
    expect(progressTextFromAttribute("Comparing the options…", "fallback")).toBe(
      "Comparing the options…"
    );
    expect(progressTextFromAttribute("bad\nstatus", "fallback")).toBe("fallback");
    expect(progressTextFromAttribute(null, "fallback")).toBe("fallback");
  });

  it("does not show progress when a quick response clears it first", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const onShow = vi.fn(async () => "99");
    const onDiscard = vi.fn();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      statusText: "Looking that up…",
      onShow,
      onDiscard
    });

    await tracker.clear("session-1");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onShow).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("shows delayed progress with the latest status and later removes it", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const onShow = vi.fn(async () => "99");
    const onDiscard = vi.fn();
    const progress = tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      statusText: "Thinking that through…",
      onShow,
      onDiscard
    });
    progress.statusText = "Searching the web…";

    await vi.advanceTimersByTimeAsync(1_000);

    expect(onShow).toHaveBeenCalledWith("Searching the web…");
    expect(progress.messageId).toBe("99");

    await tracker.clear("session-1");
    expect(onDiscard).toHaveBeenCalledWith("99");
  });
});
