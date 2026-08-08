const token = requiredEnv("TELEGRAM_BOT_TOKEN");
const deleting = process.argv.includes("--delete");

async function telegramApi(method: string, body: Record<string, unknown>): Promise<void> {
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
}

if (deleting) {
  await telegramApi("deleteWebhook", { drop_pending_updates: false });
  await telegramApi("deleteMyCommands", {
    scope: { type: "all_private_chats" }
  });
  console.info(JSON.stringify({ event: "captain.telegram_webhook_deleted" }));
} else {
  await telegramApi("setWebhook", {
    url: `${requiredEnv("CAPTAIN_PUBLIC_URL").replace(/\/$/u, "")}/eve/v1/telegram`,
    secret_token: requiredEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  });
  await telegramApi("setMyCommands", {
    scope: { type: "all_private_chats" },
    commands: [
      { command: "trip", description: "Show your active trip" },
      { command: "profile", description: "Manage your Captain profile" },
      { command: "feedback", description: "Share feedback about Captain" },
      { command: "clear", description: "Clear all data" }
    ]
  });
  console.info(JSON.stringify({ event: "captain.telegram_webhook_configured" }));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
