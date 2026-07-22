const token = requiredEnv("TELEGRAM_BOT_TOKEN");
const deleting = process.argv.includes("--delete");
const method = deleting ? "deleteWebhook" : "setWebhook";
const body = deleting
  ? { drop_pending_updates: false }
  : {
      url: `${requiredEnv("CAPTAIN_PUBLIC_URL").replace(/\/$/u, "")}/eve/v1/telegram`,
      secret_token: requiredEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false
    };

let response: Response;
try {
  response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
} catch {
  throw new Error(`Telegram ${method} request failed`);
}

const result = (await response.json()) as { ok?: boolean; description?: string };
if (!response.ok || result.ok !== true) {
  throw new Error(`Telegram ${method} failed (${response.status}): ${result.description ?? "unknown error"}`);
}

console.info(JSON.stringify({
  event: deleting ? "captain.telegram_webhook_deleted" : "captain.telegram_webhook_configured"
}));

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
