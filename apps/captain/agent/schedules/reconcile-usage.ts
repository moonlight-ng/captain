import { defineSchedule } from "eve/schedules";

import { getCaptainServices } from "../../services/app/services.js";

export default defineSchedule({
  cron: "*/5 * * * *",
  async run() {
    const services = await getCaptainServices();
    await services.usage.reconcilePending(50);
  }
});
