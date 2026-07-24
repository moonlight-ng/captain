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

export function resolveTripDateIntent(request: string, now = new Date()): TripDateIntent {
  const mentions = dateMentions(request, now);
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

  const today = isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
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
  now: Date
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
        now
      }),
      resolveMention({
        index: secondIndex,
        weekday: null,
        month: match[1]!,
        day: Number(match[3]),
        year: match[4] ? Number(match[4]) : null,
        now
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
        now
      }),
      resolveMention({
        index: secondIndex,
        weekday: null,
        month: match[3]!,
        day: Number(match[2]),
        year: match[4] ? Number(match[4]) : null,
        now
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
      now
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
      now
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
  return mentions.sort((left, right) => left.index - right.index);
}

function resolveMention(input: {
  index: number;
  weekday: string | null;
  month: string;
  day: number;
  year: number | null;
  now: Date;
}): DateMention | { issue: string; index: number } {
  const month = MONTHS[input.month.toLowerCase()]!;
  const today = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate()));
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
