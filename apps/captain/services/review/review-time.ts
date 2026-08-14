export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function previousDayRange(
  now: Date,
  timeZone: string
): { since: Date; until: Date; date: string } {
  const current = getZonedParts(now, timeZone);
  const yesterday = addDays(current, -1);
  return {
    date: localDate(yesterday),
    since: zonedLocalTimeToUtc({ ...yesterday, hour: 0, minute: 0 }, timeZone),
    until: zonedLocalTimeToUtc({
      year: current.year,
      month: current.month,
      day: current.day,
      hour: 0,
      minute: 0
    }, timeZone)
  };
}

export function localDateRange(
  date: string,
  timeZone: string
): { since: Date; until: Date; date: string } {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) throw new Error(`Invalid review date: ${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() + 1 !== month
    || normalized.getUTCDate() !== day
  ) throw new Error(`Invalid review date: ${date}`);
  const next = addDays({ year, month, day }, 1);
  return {
    date,
    since: zonedLocalTimeToUtc({ year, month, day, hour: 0, minute: 0 }, timeZone),
    until: zonedLocalTimeToUtc({ ...next, hour: 0, minute: 0 }, timeZone)
  };
}

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function addDays(
  date: Pick<ZonedParts, "year" | "month" | "day">,
  days: number
): Pick<ZonedParts, "year" | "month" | "day"> {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function localDate(parts: Pick<ZonedParts, "year" | "month" | "day">): string {
  return [
    parts.year,
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");
}

function zonedLocalTimeToUtc(local: ZonedParts, timeZone: string): Date {
  const target = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute
  );
  for (let offsetHours = -14; offsetHours <= 14; offsetHours += 1) {
    const candidate = new Date(target - offsetHours * 60 * 60 * 1_000);
    const parts = getZonedParts(candidate, timeZone);
    if (
      parts.year === local.year
      && parts.month === local.month
      && parts.day === local.day
      && parts.hour === local.hour
      && parts.minute === local.minute
    ) return candidate;
  }
  throw new Error(`Could not resolve local time in ${timeZone}`);
}
