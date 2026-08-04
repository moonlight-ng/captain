import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const travelDocumentsMigration = readFileSync(
  new URL("../database/migrations/010_passenger_travel_documents.sql", import.meta.url),
  "utf8"
);
const multipleCardsMigration = readFileSync(
  new URL("../database/migrations/011_multiple_payment_methods.sql", import.meta.url),
  "utf8"
);

describe("profile security migrations", () => {
  it("stores passport numbers as encrypted bytes", () => {
    expect(travelDocumentsMigration).toContain("passport_number_encrypted bytea");
    expect(travelDocumentsMigration).toContain("pgcrypto");
  });

  it("allows multiple active cards while retaining the one-default constraint", () => {
    expect(multipleCardsMigration).toContain("drop index if exists captain.captain_payment_methods_one_active_idx");
    expect(multipleCardsMigration).not.toContain("drop index if exists captain.captain_payment_methods_one_default_idx");
  });
});
