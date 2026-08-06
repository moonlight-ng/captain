import { MemoryCaptainPlatformStore } from "../src/index.js";
import { describeCaptainPlatformStore } from "./conformance.js";

// The Postgres implementation runs the same suite in apps/captain, which owns
// the schema and its migrations.
describeCaptainPlatformStore(
  "MemoryCaptainPlatformStore",
  async () => new MemoryCaptainPlatformStore()
);
