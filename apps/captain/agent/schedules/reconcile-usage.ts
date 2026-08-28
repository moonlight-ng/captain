import { defineSchedule } from "eve/schedules";

import { getCaptainServices } from "../../services/app/services.js";

export default defineSchedule({
  cron: "*/5 * * * *",
  async run() {
    const services = await getCaptainServices();
    if (services.env.archivedMode) return;
    await services.usage.reconcilePending(50);
  }
});
