import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("public launch evaluation corpus", () => {
  it("covers Nigerian domestic, African regional, and long-haul routes", async () => {
    const corpus = JSON.parse(
      await readFile(resolve("evals/corpus.json"), "utf8")
    ) as Array<{ id: string; category: string }>;
    expect(corpus).toHaveLength(12);
    for (const category of ["nigerian_domestic", "african_regional", "long_haul"]) {
      expect(corpus.filter((item) => item.category === category)).toHaveLength(4);
    }
    expect(new Set(corpus.map((item) => item.id)).size).toBe(corpus.length);
  });
});
