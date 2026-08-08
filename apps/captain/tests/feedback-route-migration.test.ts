import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Feedback route migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/016_feedback_login_route.sql"),
    "utf8"
  );

  it("allows a single-use login token to open the feedback form", () => {
    expect(migration).toContain("drop constraint if exists login_tokens_redirect_path_check");
    expect(migration).toContain("'/feedback'");
  });
});
