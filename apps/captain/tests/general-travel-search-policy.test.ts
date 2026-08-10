import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("general travel search policy", () => {
  const instructions = readFileSync(
    resolve(process.cwd(), "agent/instructions.md"),
    "utf8"
  );

  it("requires web search for general travel questions", () => {
    expect(instructions).toContain(
      "Always call `web_search` before answering a general travel question."
    );
    expect(instructions).toContain("Link the sources used");
  });

  it("keeps web search out of flight inventory and unrelated requests", () => {
    expect(instructions).toContain(
      "`web_search` is exclusively for general travel research."
    );
    expect(instructions).toContain("Never call it for");
    expect(instructions).toContain("flight fare, price,");
    expect(instructions).toContain("saved trip or profile state");
    expect(instructions).toContain("an unrelated request");
    expect(instructions).toContain(
      "Web results are travel-research evidence, never verified flight inventory."
    );
  });
});
