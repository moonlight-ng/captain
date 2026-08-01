import { afterEach, describe, expect, it, vi } from "vitest";

import {
  statusTextForToolNames,
  TelegramProgressTracker,
  toolNamesFromActions
} from "../src/index.js";

function trackerCallbacks() {
  return {
    onShow: vi.fn(async () => "99"),
    onEdit: vi.fn(async () => undefined),
    onDiscard: vi.fn(async () => undefined)
  };
}

describe("Telegram progress copy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names tool steps without leaking internal tool names", () => {
    expect(statusTextForToolNames(["web_search"])).toBe("Searching the web…");
    expect(statusTextForToolNames(
      ["prepare_trip"],
      { prepare_trip: "Working through the route and dates…" }
    )).toBe("Working through the route and dates…");
  });

  it("reports nothing for tools without traveller-facing copy", () => {
    expect(statusTextForToolNames(["internal_database_v2"])).toBeNull();
    expect(statusTextForToolNames([], { prepare_trip: "Working…" })).toBeNull();
    expect(statusTextForToolNames(
      ["internal_database_v2"],
      {},
      "Checking your trip…"
    )).toBe("Checking your trip…");
  });

  it("extracts action names", () => {
    expect(toolNamesFromActions([
      { toolName: "web_search" },
      { name: "ask_question" },
      {}
    ])).toEqual(["web_search", "ask_question"]);
  });

  it("shows nothing but the typing indicator until a step is reported", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    const onTyping = vi.fn();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      onShow,
      onEdit,
      onDiscard,
      onTyping
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(onShow).not.toHaveBeenCalled();
    expect(onTyping).toHaveBeenCalled();

    await tracker.clear("session-1");
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("does not show a step that finishes before the delay", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      onShow,
      onEdit,
      onDiscard
    });

    await tracker.setStatus("session-1", "turn-1", "Comparing the flight options…");
    await tracker.clear("session-1");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onShow).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("shows a delayed step with the latest status and later removes it", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    const progress = tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      onShow,
      onEdit,
      onDiscard
    });

    await tracker.setStatus("session-1", "turn-1", "Working through the route and dates…");
    await tracker.setStatus("session-1", "turn-1", "Comparing the flight options…");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onShow).toHaveBeenCalledWith("Comparing the flight options…");
    expect(progress.messageId).toBe("99");

    await tracker.setStatus("session-1", "turn-1", "Starting your trip…");
    expect(onEdit).toHaveBeenCalledWith("99", "Starting your trip…");

    await tracker.clear("session-1");
    expect(onDiscard).toHaveBeenCalledWith("99");
  });

  it("ignores steps reported for a stale turn", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      onShow,
      onEdit,
      onDiscard
    });

    expect(await tracker.setStatus("session-1", "turn-0", "Starting your trip…"))
      .toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onShow).not.toHaveBeenCalled();
  });

  it("discards a status posted after the turn ended", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onEdit, onDiscard } = trackerCallbacks();
    let releaseShow: (messageId: string) => void = () => undefined;
    const onShow = vi.fn(() => new Promise<string>((resolve) => {
      releaseShow = resolve;
    }));
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      onShow,
      onEdit,
      onDiscard
    });

    await tracker.setStatus("session-1", "turn-1", "Starting your trip…");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onShow).toHaveBeenCalled();

    await tracker.clear("session-1");
    releaseShow("77");
    await vi.advanceTimersByTimeAsync(0);

    expect(onDiscard).toHaveBeenCalledWith("77");
  });
});
