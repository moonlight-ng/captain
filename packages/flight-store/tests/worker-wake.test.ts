import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import {
  FLIGHT_WORKER_WAKE_CHANNEL,
  signalFlightWorker
} from "../src/worker-wake.js";

describe("flight worker wake signal", () => {
  it("publishes the search-due event on the shared PostgreSQL channel", async () => {
    let query: { strings: readonly string[]; args: readonly unknown[] } | undefined;
    const sql = ((strings: TemplateStringsArray, ...args: unknown[]) => {
      query = { strings: [...strings], args };
      return Promise.resolve([]);
    }) as unknown as Sql;

    await signalFlightWorker(sql);

    expect(query?.strings.join("?")).toContain("select pg_notify(?, ?)");
    expect(query?.args).toEqual([FLIGHT_WORKER_WAKE_CHANNEL, "search_due"]);
  });
});
