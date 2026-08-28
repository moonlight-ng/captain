export const CAPTAIN_ARCHIVED_MESSAGE =
  "Captain is now closed, so I’m no longer accepting trips or running flight searches. Thanks for travelling with me.";

export const CAPTAIN_CLOSING_POST_URL =
  "https://opemipo.com/2026/08/28/agents-09/";

export const CAPTAIN_ARCHIVED_TELEGRAM_MESSAGE =
  `${CAPTAIN_ARCHIVED_MESSAGE}\n\nRead why Captain closed: ${CAPTAIN_CLOSING_POST_URL}`;

export const CAPTAIN_ARCHIVED_ERROR = "captain_archived";

/**
 * The archive switch is deliberately independent of service initialization.
 * Telegram and the public closure page must still answer if PostgreSQL or an
 * external provider is unavailable during the shutdown period.
 */
export function isCaptainArchivedMode(
  source: NodeJS.ProcessEnv = process.env
): boolean {
  const value = source.CAPTAIN_ARCHIVED_MODE;
  if (value === undefined) return false;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}
