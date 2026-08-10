import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Conversation summary migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/026_conversation_summary.sql"),
    "utf8"
  );

  it("adds resumable summary markers without turning them into an FK", () => {
    expect(migration).toContain("add column if not exists summary_updated_at timestamptz");
    expect(migration).toContain("add column if not exists summary_through_message_id uuid");
    expect(migration).toContain("Not an FK: outlives message retention");
    expect(migration).not.toMatch(/references\s+captain\.messages/iu);
  });
});
