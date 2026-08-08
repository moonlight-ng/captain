import type { Sql } from "postgres";

/**
 * Search mutations and the flight worker meet on this PostgreSQL channel.
 * NOTIFY is transactional, so a worker can only wake after the state that made
 * a search due has committed. The worker's normal polling remains the fallback
 * when it is disconnected while a notification is sent.
 */
export const FLIGHT_WORKER_WAKE_CHANNEL = "captain_flight_worker_wake";

export async function signalFlightWorker(sql: Sql): Promise<void> {
  await sql`
    select pg_notify(${FLIGHT_WORKER_WAKE_CHANNEL}, ${"search_due"})
  `;
}
