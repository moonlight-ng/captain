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

  // A holding line runs on a timer with no idea what is happening, so only a
  // step that really is waiting on someone else may say so. The generic set
  // used to claim slow providers over work that made no provider call.
  it("lets a step carry its own holding lines", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      holdingLines: ["Still on it…"],
      holdingIntervalMs: 1_000,
      onShow,
      onEdit,
      onDiscard
    });

    await tracker.setStatus(
      "session-1",
      "turn-1",
      "Checking verified fares…",
      ["The airlines are being slow to answer. Still checking…"]
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onShow).toHaveBeenCalledWith("Checking verified fares…");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onEdit).toHaveBeenCalledWith(
      "99",
      "The airlines are being slow to answer. Still checking…"
    );
  });

  it("keeps the turn's own holding lines when a step supplies none", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      holdingLines: ["Still on it…"],
      holdingIntervalMs: 1_000,
      onShow,
      onEdit,
      onDiscard
    });

    await tracker.setStatus("session-1", "turn-1", "Reading the route and dates…");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onEdit).toHaveBeenCalledWith("99", "Still on it…");
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

  it("opens with an acknowledgement before any step is named", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      opening: "On it — taking a look…",
      onShow,
      onEdit,
      onDiscard
    });

    await vi.advanceTimersByTimeAsync(400);
    expect(onShow).toHaveBeenCalledWith("On it — taking a look…");

    // The first named step replaces the acknowledgement in place rather than
    // posting a second message.
    await tracker.setStatus("session-1", "turn-1", "Checking verified fares…");
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith("99", "Checking verified fares…");

    await tracker.clear("session-1");
    expect(onDiscard).toHaveBeenCalledWith("99");
  });

  it("says nothing at all when the turn beats the opening delay", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      opening: "On it — taking a look…",
      onShow,
      onEdit,
      onDiscard
    });

    await tracker.clear("session-1");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onShow).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("moves through holding lines while one step keeps running", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      opening: "On it — taking a look…",
      holdingLines: ["Still on it…", "Almost there…"],
      holdingIntervalMs: 5_000,
      onShow,
      onEdit,
      onDiscard
    });

    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onEdit).toHaveBeenLastCalledWith("99", "Still on it…");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(onEdit).toHaveBeenLastCalledWith("99", "Almost there…");

    // The list is exhausted, so the last line stays rather than cycling.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onEdit).toHaveBeenCalledTimes(2);

    await tracker.clear("session-1");
    expect(onDiscard).toHaveBeenCalledWith("99");
  });

  it("returns to naming the work when a new step interrupts a holding line", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      opening: "On it — taking a look…",
      holdingLines: ["Still on it…"],
      holdingIntervalMs: 5_000,
      onShow,
      onEdit,
      onDiscard
    });

    await vi.advanceTimersByTimeAsync(5_400);
    expect(onEdit).toHaveBeenLastCalledWith("99", "Still on it…");

    await tracker.setStatus("session-1", "turn-1", "Checking verified fares…");
    expect(onEdit).toHaveBeenLastCalledWith("99", "Checking verified fares…");

    // The holding line is available again for the step that replaced it.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onEdit).toHaveBeenLastCalledWith("99", "Still on it…");

    await tracker.clear("session-1");
    expect(onDiscard).toHaveBeenCalledWith("99");
  });

  it("leaves the current line alone when the same step reports again", async () => {
    vi.useFakeTimers();
    const tracker = new TelegramProgressTracker();
    const { onShow, onEdit, onDiscard } = trackerCallbacks();
    tracker.start({
      sessionId: "session-1",
      chatId: "42",
      turnId: "turn-1",
      opening: "Checking verified fares…",
      holdingLines: ["Still on it…"],
      holdingIntervalMs: 5_000,
      onShow,
      onEdit,
      onDiscard
    });

    await vi.advanceTimersByTimeAsync(5_400);
    expect(onEdit).toHaveBeenLastCalledWith("99", "Still on it…");

    await tracker.setStatus("session-1", "turn-1", "Checking verified fares…");

    expect(onEdit).toHaveBeenCalledTimes(1);
    await tracker.clear("session-1");
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
