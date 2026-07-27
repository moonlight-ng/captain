import { addIsoDays, daysBetween, isoDate, parseIsoDate, weekdayName } from "./trip-planning.js";

const MONTHS: Readonly<Record<string, number>> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11
};

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

const MONTH_PATTERN = Object.keys(MONTHS).join("|");
const WEEKDAY_PATTERN = Object.keys(WEEKDAY_INDEX).join("|");
const RELATIVE_NUMBER: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12
};
const RELATIVE_NUMBER_PATTERN = String.raw`\d{1,3}|${Object.keys(RELATIVE_NUMBER).join("|")}`;

export type TripDateIntent = {
  departureDate: string | null;
  returnDate: string | null;
  issue: string | null;
};

type DateMention = {
  value: string;
  index: number;
  weekday: string | null;
};

export type TripDateSequence = {
  dates: string[];
  issue: string | null;
};

export function resolveTripDateSequence(
  request: string,
  now = new Date(),
  timeZone = "UTC"
): TripDateSequence {
  const mentions = dateMentions(request, now, timeZone);
  const issue = mentions.find((mention) => "issue" in mention);
  if (issue && "issue" in issue) return { dates: [], issue: issue.issue };
  const dates = mentions
    .filter((mention): mention is DateMention => !("issue" in mention))
    .map((mention) => mention.value);
  const today = isoDate(localToday(now, timeZone));
  if (dates[0] && daysBetween(today, dates[0]) < 0) {
    return {
      dates,
      issue: `${formatMention(dates[0])} is in the past. What future departure date should I use?`
    };
  }
  for (let index = 1; index < dates.length; index += 1) {
    if (daysBetween(dates[index - 1]!, dates[index]!) < 0) {
      return { dates, issue: "Trip leg dates must be in order. Which dates should I use?" };
    }
  }
  return { dates, issue: null };
}

export function resolveTripDateIntent(
  request: string,
  now = new Date(),
  timeZone = "UTC"
): TripDateIntent {
  const mentions = dateMentions(request, now, timeZone);
  const issue = mentions.find((mention) => "issue" in mention);
  if (issue && "issue" in issue) {
    return { departureDate: null, returnDate: null, issue: issue.issue };
  }
  const dates = mentions.filter((mention): mention is DateMention => !("issue" in mention));
  let departureDate: string | null = null;
  let returnDate: string | null = null;
  if (dates.length >= 2) {
    departureDate = dates[0]!.value;
    returnDate = dates[1]!.value;
  } else if (dates[0]) {
    if (returnCueBefore(request, dates[0].index)) returnDate = dates[0].value;
    else departureDate = dates[0].value;
  }

  if (departureDate && !returnDate) {
    const nights = /\b(?:for|after)\s+(\d{1,2})\s+nights?\b/iu.exec(request)
      ?? /\b(\d{1,2})\s+nights?\b/iu.exec(request);
    if (nights) returnDate = addIsoDays(departureDate, Number(nights[1]));
  }
  if (
    departureDate
    && !returnDate
    && /\b(?:back|return(?:ing)?)\b.{0,60}\b(?:(?:the\s+)?(?:next|following)\s+day|a\s+day\s+later)\b/iu.test(request)
  ) {
    returnDate = addIsoDays(departureDate, 1);
  }
  if (departureDate && !returnDate) {
    const following = new RegExp(
      String.raw`\b(?:back|return(?:ing)?)\b.{0,40}\b(${WEEKDAY_PATTERN})\b.{0,30}\b(?:following|next)\s+week\b`,
      "iu"
    ).exec(request)
      ?? new RegExp(
        String.raw`\b(${WEEKDAY_PATTERN})\b.{0,15}\b(?:the\s+)?following\s+week\b`,
        "iu"
      ).exec(request);
    if (following) {
      const departure = parseIsoDate(departureDate);
      const target = WEEKDAY_INDEX[following[1]!.toLowerCase()]!;
      const delta = (target - departure.getUTCDay() + 7) % 7 || 7;
      returnDate = addIsoDays(departureDate, delta);
    }
  }

  const today = isoDate(localToday(now, timeZone));
  if (departureDate && daysBetween(today, departureDate) < 0) {
    return {
      departureDate,
      returnDate,
      issue: `${formatMention(departureDate)} is in the past. What future departure date should I use?`
    };
  }
  if (departureDate && returnDate && daysBetween(departureDate, returnDate) <= 0) {
    return {
      departureDate,
      returnDate,
      issue: `The return date must be after the departure date. Which return date should I use?`
    };
  }
  return { departureDate, returnDate, issue: null };
}

function dateMentions(
  request: string,
  now: Date,
  timeZone: string
): Array<DateMention | { issue: string; index: number }> {
  const mentions: Array<DateMention | { issue: string; index: number }> = [];
  const claimed = new Set<number>();
  const compactMonthFirst = new RegExp(
    String.raw`\b(${MONTH_PATTERN})\s+(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|–|—|to)\s*(\d{1,2})(?:st|nd|rd|th)?(?:[\s,]+(20\d{2}))?\b`,
    "giu"
  );
  for (const match of request.matchAll(compactMonthFirst)) {
    const secondIndex = match.index + match[0].lastIndexOf(match[3]!);
    mentions.push(
      resolveMention({
        index: match.index,
        weekday: null,
        month: match[1]!,
        day: Number(match[2]),
        year: match[4] ? Number(match[4]) : null,
        now,
        timeZone
      }),
      resolveMention({
        index: secondIndex,
        weekday: null,
        month: match[1]!,
        day: Number(match[3]),
        year: match[4] ? Number(match[4]) : null,
        now,
        timeZone
      })
    );
    claimed.add(match.index);
  }
  const compactDayFirst = new RegExp(
    String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|–|—|to)\s*(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_PATTERN})(?:[\s,]+(20\d{2}))?\b`,
    "giu"
  );
  for (const match of request.matchAll(compactDayFirst)) {
    const secondIndex = match.index + match[0].indexOf(match[2]!, match[1]!.length);
    mentions.push(
      resolveMention({
        index: match.index,
        weekday: null,
        month: match[3]!,
        day: Number(match[1]),
        year: match[4] ? Number(match[4]) : null,
        now,
        timeZone
      }),
      resolveMention({
        index: secondIndex,
        weekday: null,
        month: match[3]!,
        day: Number(match[2]),
        year: match[4] ? Number(match[4]) : null,
        now,
        timeZone
      })
    );
    claimed.add(match.index);
    claimed.add(secondIndex);
  }
  const monthFirst = new RegExp(
    String.raw`\b(?:(${WEEKDAY_PATTERN})[\s,]+)?(${MONTH_PATTERN})\s+(\d{1,2})(?:st|nd|rd|th)?(?:[\s,]+(20\d{2}))?\b`,
    "giu"
  );
  for (const match of request.matchAll(monthFirst)) {
    if (claimed.has(match.index)) continue;
    mentions.push(resolveMention({
      index: match.index,
      weekday: match[1] ?? null,
      month: match[2]!,
      day: Number(match[3]),
      year: match[4] ? Number(match[4]) : null,
      now,
      timeZone
    }));
    claimed.add(match.index);
  }
  const dayFirst = new RegExp(
    String.raw`\b(?:(${WEEKDAY_PATTERN})[\s,]+)?(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_PATTERN})(?:[\s,]+(20\d{2}))?\b`,
    "giu"
  );
  for (const match of request.matchAll(dayFirst)) {
    if (claimed.has(match.index)) continue;
    mentions.push(resolveMention({
      index: match.index,
      weekday: match[1] ?? null,
      month: match[3]!,
      day: Number(match[2]),
      year: match[4] ? Number(match[4]) : null,
      now,
      timeZone
    }));
    claimed.add(match.index);
  }
  const isoPattern = /\b(20\d{2}-\d{2}-\d{2})\b/gu;
  for (const match of request.matchAll(isoPattern)) {
    if (claimed.has(match.index)) continue;
    try {
      parseIsoDate(match[1]!);
      mentions.push({ value: match[1]!, index: match.index, weekday: null });
    } catch {
      mentions.push({ issue: `${match[1]} is not a valid calendar date.`, index: match.index });
    }
  }
  const inheritedDayPattern = /\b(?:on\s+(?:the\s+)?|the\s+)(\d{1,2})(?:st|nd|rd|th)?\b/giu;
  for (const match of request.matchAll(inheritedDayPattern)) {
    if (claimed.has(match.index)) continue;
    const previous = mentions
      .filter((mention): mention is DateMention => !("issue" in mention) && mention.index < match.index)
      .sort((left, right) => right.index - left.index)[0];
    if (!previous) continue;
    const previousDate = parseIsoDate(previous.value);
    const month = Object.entries(MONTHS)
      .find(([, index]) => index === previousDate.getUTCMonth())?.[0];
    if (!month) continue;
    mentions.push(resolveMention({
      index: match.index,
      weekday: null,
      month,
      day: Number(match[1]),
      year: previousDate.getUTCFullYear(),
      now,
      timeZone
    }));
    claimed.add(match.index);
  }
  const relativePattern = new RegExp(
    String.raw`\b(day\s+after\s+tomorrow|tomorrow|today|tonight|in\s+(?:${RELATIVE_NUMBER_PATTERN})\s+(?:days?|weeks?)|(?:(?:this|next|coming)\s+)?(?:weekend|${WEEKDAY_PATTERN}))\b`,
    "giu"
  );
  for (const match of request.matchAll(relativePattern)) {
    if (claimed.has(match.index) || isPartOfExplicitCalendarDate(request, match.index, match[0])) {
      continue;
    }
    mentions.push({
      value: resolveRelativeDate(match[0], now, timeZone),
      index: match.index,
      weekday: null
    });
  }
  return mentions.sort((left, right) => left.index - right.index);
}

function resolveRelativeDate(mention: string, now: Date, timeZone: string): string {
  const normalized = mention.toLowerCase().replace(/\s+/gu, " ").trim();
  const today = localToday(now, timeZone);
  if (normalized === "today" || normalized === "tonight") return isoDate(today);
  if (normalized === "tomorrow") return addIsoDays(isoDate(today), 1);
  if (normalized === "day after tomorrow") return addIsoDays(isoDate(today), 2);
  const offset = new RegExp(
    String.raw`^in\s+(${RELATIVE_NUMBER_PATTERN})\s+(days?|weeks?)$`,
    "iu"
  ).exec(normalized);
  if (offset) {
    const count = Number(offset[1]) || RELATIVE_NUMBER[offset[1]!.toLowerCase()]!;
    return addIsoDays(isoDate(today), count * (offset[2]!.toLowerCase().startsWith("week") ? 7 : 1));
  }
  const parts = normalized.split(" ");
  const modifier = parts.length > 1 ? parts[0]! : "";
  const namedDay = parts.at(-1)!;
  const target = namedDay === "weekend" ? WEEKDAY_INDEX.saturday! : WEEKDAY_INDEX[namedDay]!;
  let delta = (target - today.getUTCDay() + 7) % 7;
  if (modifier === "next" && delta === 0) delta = 7;
  return addIsoDays(isoDate(today), delta);
}

function isPartOfExplicitCalendarDate(request: string, index: number, mention: string): boolean {
  if (/^(?:this|next|coming)\b/iu.test(mention)) return false;
  const before = request.slice(Math.max(0, index - 24), index);
  const after = request.slice(index + mention.length, index + mention.length + 24);
  if (/^[\s,]*(?:the\s+)?following\s+week\b/iu.test(after)) return true;
  const monthBefore = new RegExp(
    String.raw`(?:${MONTH_PATTERN})\s+\d{1,2}(?:st|nd|rd|th)?(?:[\s,]+20\d{2})?[\s,]*$`,
    "iu"
  );
  const dateAfter = new RegExp(
    String.raw`^[\s,]*(?:(?:${MONTH_PATTERN})\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTH_PATTERN}))`,
    "iu"
  );
  return monthBefore.test(before) || dateAfter.test(after);
}

function resolveMention(input: {
  index: number;
  weekday: string | null;
  month: string;
  day: number;
  year: number | null;
  now: Date;
  timeZone: string;
}): DateMention | { issue: string; index: number } {
  const month = MONTHS[input.month.toLowerCase()]!;
  const today = localToday(input.now, input.timeZone);
  let year = input.year ?? today.getUTCFullYear();
  let date = new Date(Date.UTC(year, month, input.day));
  if (!input.year && date < today) {
    year += 1;
    date = new Date(Date.UTC(year, month, input.day));
  }
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month
    || date.getUTCDate() !== input.day
  ) {
    return {
      issue: `${input.month} ${input.day}${input.year ? `, ${input.year}` : ""} is not a valid calendar date.`,
      index: input.index
    };
  }
  const value = isoDate(date);
  if (input.weekday && WEEKDAY_INDEX[input.weekday.toLowerCase()] !== date.getUTCDay()) {
    return {
      issue: `${input.month} ${input.day}, ${year} is ${weekdayName(value)}, not ${capitalize(input.weekday)}. Which date should I use?`,
      index: input.index
    };
  }
  return { value, index: input.index, weekday: input.weekday };
}

function returnCueBefore(request: string, index: number): boolean {
  return /\b(?:back|return(?:ing)?|inbound)\b/iu.test(request.slice(Math.max(0, index - 48), index));
}

function formatMention(value: string): string {
  const date = parseIsoDate(value);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

function localToday(now: Date, timeZone: string): Date {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(now);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day)));
  } catch {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}
