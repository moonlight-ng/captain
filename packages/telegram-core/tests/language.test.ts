import { describe, expect, it } from "vitest";

import { canonicalTag, languageDisplayName } from "../src/language.js";

describe("Telegram language helpers", () => {
  it("canonicalizes BCP-47 tags", () => {
    expect(canonicalTag("FR-fr")).toBe("fr-FR");
    expect(canonicalTag("pt-br")).toBe("pt-BR");
  });

  it("renders a human language name", () => {
    expect(languageDisplayName("fr", "en")).toBe("French");
  });
});
