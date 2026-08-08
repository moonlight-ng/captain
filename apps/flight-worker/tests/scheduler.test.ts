import { afterEach, describe, expect, it, vi } from "vitest";

import { InterruptibleWorkerScheduler } from "../src/scheduler.js";

describe("InterruptibleWorkerScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("interrupts a long idle backoff when work becomes due", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => false);
    const scheduler = new InterruptibleWorkerScheduler({
      run,
      onError: vi.fn(),
      tickMs: 60_000,
      maxIdleTickMs: 300_000
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("runs again immediately when a wake arrives during an active tick", async () => {
    vi.useFakeTimers();
    let finishFirst!: (hadDueWork: boolean) => void;
    const firstRun = new Promise<boolean>((resolve) => {
      finishFirst = resolve;
    });
    const run = vi.fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue(false);
    const scheduler = new InterruptibleWorkerScheduler({
      run,
      onError: vi.fn(),
      tickMs: 60_000,
      maxIdleTickMs: 300_000
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.wake();
    finishFirst(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("keeps the regular interval after a failed tick", async () => {
    vi.useFakeTimers();
    const error = new Error("database unavailable");
    const onError = vi.fn();
    const run = vi.fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(false);
    const scheduler = new InterruptibleWorkerScheduler({
      run,
      onError,
      tickMs: 60_000,
      maxIdleTickMs: 300_000
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(error);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
