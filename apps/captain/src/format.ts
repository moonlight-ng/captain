import type {
  BrowsePreferences,
  Segment,
  TripPayload,
  VerifiedOffer
} from "./domain.js";

export function outboundSegments(segments: Segment[]): Segment[] {
  if (segments.length <= 1) return segments;
  const origin = segments[0]!.origin;
  if (segments.at(-1)!.destination !== origin) return segments;
  let splitAfter = 0;
  let bestGap = -1;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const gap = Date.parse(segments[index + 1]!.departure) - Date.parse(segments[index]!.arrival);
    if (Number.isFinite(gap) && gap > bestGap) {
      bestGap = gap;
      splitAfter = index;
    }
  }
  return segments.slice(0, splitAfter + 1);
}

export function clockLabel(value: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

export function calendarDayOffset(start: string, end: string): number {
  const startDay = Date.UTC(
    new Date(start).getFullYear(),
    new Date(start).getMonth(),
    new Date(start).getDate()
  );
  const endDay = Date.UTC(
    new Date(end).getFullYear(),
    new Date(end).getMonth(),
    new Date(end).getDate()
  );
  return Math.max(0, Math.round((endDay - startDay) / 86_400_000));
}

export function peerPriceComparison(offer: VerifiedOffer, offers: VerifiedOffer[]) {
  const prices = offers.map((item) => item.price).sort((left, right) => left - right);
  const min = prices[0] ?? offer.price;
  const max = prices.at(-1) ?? offer.price;
  const mid = Math.floor(prices.length / 2);
  const median = prices.length === 0
    ? offer.price
    : prices.length % 2 === 0
      ? ((prices[mid - 1] ?? offer.price) + (prices[mid] ?? offer.price)) / 2
      : prices[mid] ?? offer.price;
  return { min, max, median, value: offer.price };
}

export function formatDurationSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export function moneyRange(min: number, max: number, currency: string): string {
  const low = formatMoney(min, currency);
  if (min === max) return low;
  return `${low} – ${formatMoney(max, currency)}`;
}

export function durationRange(minSeconds: number, maxSeconds: number): string {
  if (minSeconds <= 0 && maxSeconds <= 0) return "Time unavailable";
  const low = formatDurationSeconds(minSeconds);
  if (minSeconds === maxSeconds) return low;
  return `${low} – ${formatDurationSeconds(maxSeconds)}`;
}

export function routeLabel(trip: NonNullable<TripPayload["trip"]>): string {
  const legs = trip.brief.legs ?? [];
  return trip.brief.tripType === "multi_city" && legs.length > 0
    ? [legs[0]!.originAirports.join("/"), ...legs.map((leg) => leg.destinationAirports.join("/"))].join(" → ")
    : `${trip.brief.originAirports.join("/")} → ${trip.brief.destinationAirports.join("/")}`;
}

export function durationSeconds(offer: VerifiedOffer): number {
  return Number(offer.snapshot.durationSeconds) || 0;
}
export function stopCount(offer: VerifiedOffer): number {
  const outbound = outboundSegments(offer.snapshot.segments ?? []);
  if (outbound.length > 0) return Math.max(0, outbound.length - 1);
  return Number(offer.snapshot.stops) || 0;
}
export function duration(offer: VerifiedOffer): string {
  const seconds = durationSeconds(offer);
  return seconds ? `${Math.floor(seconds / 3600)}h ${Math.round(seconds % 3600 / 60)}m` : "Time unavailable";
}
export function stops(offer: VerifiedOffer): string {
  const count = stopCount(offer);
  return count === 0 ? "Nonstop" : `${count} stop${count === 1 ? "" : "s"}`;
}
export function isMixed(offer: VerifiedOffer): boolean {
  return offer.participatingAirlineCodes.length > 1;
}
export function money(offer: VerifiedOffer): string {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: offer.currency }).format(offer.price);
  } catch {
    return `${offer.currency} ${offer.priceAmount}`;
  }
}
export function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : dateLabel(value.slice(0, 10));
}
export function scheduleTime(value: string): string {
  const difference = Date.parse(value) - Date.now();
  if (difference <= 60_000) return "Due now";
  const minutes = Math.round(difference / 60_000);
  if (minutes < 60) return `In ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `In ${hours}h` : dateLabel(value.slice(0, 10));
}
export function timestampLabel(value: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
export function activityLabel(eventType: string): string {
  const labels: Record<string, string> = {
    trip_created: "Trip created",
    trip_tracking_started: "Tracking started",
    trip_brief_updated: "Trip brief updated",
    trip_title_updated: "Trip title updated",
    trip_leg_flight_selected: "Flight selected for watching",
    flight_selected: "Flight added to watch",
    flight_unselected: "Flight removed from watch",
    trip_pause: "Tracking paused",
    trip_resume: "Tracking resumed",
    trip_refresh: "Manual check requested",
    trip_cancel: "Tracking stopped",
    trip_complete: "Trip completed",
    tracking_completed: "Tracking completed",
    trip_replaced: "Trip replaced",
    telegram_notification: "Telegram update sent",
    telegram_message: "Telegram message sent",
    captain_update: "Captain update sent"
  };
  return labels[eventType] ?? label(eventType);
}
export function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T12:00:00Z`));
}
export function dateRangeLabel(start: string, end: string): string {
  if (start === end) return dateLabel(start);
  return `${dateLabel(start)} – ${dateLabel(end)}`;
}
export function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function airlineName(code: string, offers: VerifiedOffer[]): string {
  for (const offer of offers) {
    for (const segment of offer.snapshot.segments ?? []) {
      if (segment.airlineCode === code && segment.airline.trim()) {
        return segment.airline.trim();
      }
    }
  }
  return code;
}

export function sortLabel(sort: BrowsePreferences["sort"]): string {
  return ({
    recommended: "Recommended",
    price: "Lowest price",
    duration: "Shortest",
    departure: "Earliest"
  })[sort];
}

export function countFilters(preferences: BrowsePreferences): number {
  return preferences.stops.length
    + preferences.airlines.length
    + preferences.airports.length
    + preferences.departurePeriods.length
    + (preferences.maximumPrice === null ? 0 : 1);
}

export function filterChips(preferences: BrowsePreferences): string[] {
  return [
    ...preferences.stops.map((stops) => stops === 0 ? "Direct" : `${stops} stop${stops === 1 ? "" : "s"}`),
    ...preferences.airlines,
    ...preferences.airports,
    ...preferences.departurePeriods.map((period) => period[0]!.toUpperCase() + period.slice(1)),
    ...(preferences.maximumPrice === null ? [] : [`Up to ${preferences.maximumPrice}`])
  ];
}
