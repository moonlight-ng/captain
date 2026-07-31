import { describe, expect, it } from "vitest";

import { validateCaptainProjectMeta } from "../services/app/project-guard.js";

describe("Captain project guard", () => {
  it("accepts only the Captain v1 sentinel", () => {
    expect(() => validateCaptainProjectMeta([
      { project_kind: "captain", schema_version: 1 }
    ])).not.toThrow();
  });

  it.each([
    { rows: [] },
    { rows: [{ project_kind: "pilot", schema_version: 1 }] },
    { rows: [{ project_kind: "captain", schema_version: 2 }] }
  ])("rejects wrong project metadata: $rows", ({ rows }) => {
    expect(() => validateCaptainProjectMeta(rows)).toThrow(
      "DATABASE_URL does not point to the Captain v1 project"
    );
  });
});
