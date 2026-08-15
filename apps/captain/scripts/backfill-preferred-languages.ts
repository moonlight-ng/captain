import {
  PostgresCaptainPlatformStore
} from "@agents/flight-store";
import { TelegramLanguageService } from "@agents/telegram-core";
import postgres from "postgres";

const databaseUrl = required("DATABASE_URL");
const apply = process.argv.includes("--apply");
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10, idle_timeout: 2 });
const store = PostgresCaptainPlatformStore.connect(databaseUrl, 1);
const language = new TelegramLanguageService({
  apiKey: required("AI_GATEWAY_API_KEY"),
  model: process.env.CAPTAIN_LANGUAGE_MODEL?.trim()
    || process.env.TRIP_INTERPRETER_MODEL?.trim()
    || "openai/gpt-5.6-luna"
});

type Pair = { user_id: string; user_text: string; assistant_text: string };

try {
  const pairs = await sql<Pair[]>`
    select profile.user_id,
      first_user.content as user_text,
      first_assistant.content as assistant_text
    from captain.traveller_profiles profile
    join lateral (
      select message.id, message.content, message.created_at
      from captain.messages message
      where message.user_id = profile.user_id
        and message.role = 'user'
        and message.content !~ '^/'
      order by message.created_at asc, message.id asc
      limit 1
    ) first_user on true
    join lateral (
      select message.content
      from captain.messages message
      where message.user_id = profile.user_id
        and message.role = 'assistant'
        and (message.created_at, message.id) > (first_user.created_at, first_user.id)
      order by message.created_at asc, message.id asc
      limit 1
    ) first_assistant on true
    where profile.preferred_language_source = 'default'
    order by profile.user_id
  `;
  let matched = 0;
  let changed = 0;
  for (const pair of pairs) {
    const tag = await language.detectMatchingLanguage(pair.user_text, pair.assistant_text);
    if (!tag) continue;
    matched += 1;
    if (apply) {
      const result = await store.claimDetectedLanguage(pair.user_id, tag, new Date());
      if (result.claimed) changed += 1;
    }
  }
  process.stdout.write(`${JSON.stringify({ apply, candidates: pairs.length, matched, changed })}\n`);
} finally {
  await Promise.all([sql.end({ timeout: 2 }), store.close()]);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
