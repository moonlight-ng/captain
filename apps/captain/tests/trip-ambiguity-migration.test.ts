import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Trip ambiguity question migration", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "database/migrations/018_cap_trip_ambiguity_questions.sql"),
    "utf8"
  );

  it("backfills open drafts and updates the database default", () => {
    expect(migration).toContain("jsonb_set(draft_state, '{questionsAsked}', '0'::jsonb, true)");
    expect(migration).toContain("where not (draft_state ? 'questionsAsked')");
    expect(migration).toContain('"questionsAsked": 0');
  });
});
