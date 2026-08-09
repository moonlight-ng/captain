import { describe, expect, it, vi } from "vitest";

import {
  cancelTelegramOwnerContext,
  telegramOwnerContinuationToken
} from "../services/agent/owner-context.js";

describe("Captain owner context", () => {
  it("cancels the active private Telegram session so the token starts clean", async () => {
    const getByToken = vi.fn().mockResolvedValue({ runId: "run-1" });
    const create = vi.fn().mockResolvedValue({});

    await expect(cancelTelegramOwnerContext({
      hooks: { getByToken } as never,
      events: { create } as never
    }, 234)).resolves.toBe(true);

    expect(getByToken).toHaveBeenCalledWith("telegram:234::", { resolveData: "none" });
    expect(create).toHaveBeenCalledWith("run-1", {
      eventType: "run_cancelled",
      eventData: { cancelReason: "Captain traveller cleared owner context" }
    });
  });

  it("treats a missing owner session as already clear", async () => {
    const missing = Object.assign(new Error("missing"), { name: "HookNotFoundError" });
    const create = vi.fn();

    await expect(cancelTelegramOwnerContext({
      hooks: { getByToken: vi.fn().mockRejectedValue(missing) } as never,
      events: { create } as never
    }, 234)).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("uses Eve's namespaced private-chat continuation token", () => {
    expect(telegramOwnerContinuationToken(234)).toBe("telegram:234::");
  });
});
