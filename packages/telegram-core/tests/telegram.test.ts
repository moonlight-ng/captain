import { describe, expect, it } from "vitest";
import { telegramDisplayName, telegramUpdateKey } from "../src/index.js";

describe("Telegram core", () => {
  it("creates a bot-scoped idempotency key", () => {
    expect(telegramUpdateKey("captain", 42)).toBe("captain:42");
  });

  it("uses a safe display-name fallback", () => {
    expect(telegramDisplayName({ firstName: null, username: "ada", telegramUserId: 7 })).toBe("@ada");
  });
});
