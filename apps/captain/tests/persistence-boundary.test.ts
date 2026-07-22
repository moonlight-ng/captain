import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("append-only domain projections", () => {
  it("never deletes check, activity, research, or observation history", () => {
    const source = readFileSync(join(
      process.cwd(),
      "services/store/postgres-store.ts"
    ), "utf8");
    for (const table of [
      "checks",
      "activities",
      "research_runs",
      "price_observations"
    ]) {
      expect(source).not.toContain(`delete from flight_agent.${table}`);
    }
    expect(source).toContain("on conflict (id) do update set");
    expect(source.match(/on conflict \(id\) do nothing/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("retains the operational agent_states snapshot during rollout", () => {
    const source = readFileSync(join(
      process.cwd(),
      "services/store/postgres-store.ts"
    ), "utf8");
    expect(source).toContain("insert into flight_agent.agent_states");
    expect(source).toContain("on conflict (agent_key) do update");
  });

  it("keeps the Captain importer idempotent by source identity", () => {
    const source = readFileSync(join(
      process.cwd(),
      "scripts/import-captain-flights.ts"
    ), "utf8");
    expect(source).toContain("if (await wasImported(");
    expect(source).toContain("flight_agent.source_imports");
    expect(source).toContain("on conflict (source_table, source_id) do nothing");
  });
});
