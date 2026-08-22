import { defineTool } from "eve/tools";
import {
  MAX_ADULT_TRAVELLERS,
  buildSearchSpecs,
  formatTripRoute,
  type Trip,
  type TripBrief
} from "@agents/flight-domain";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import {
  airportCodeAtStart,
  airportCodeForLocation
} from "../../services/trip-planning/airport-catalog.js";
import { requireCaptainUser } from "../lib/principal.js";
import { reportingFailures } from "../lib/tool-failure.js";

export const startFareDigestInputSchema = z.object({
  origin: z.string().trim().min(1).max(120),
  destination: z.string().trim().min(1).max(120),
  departureWindow: z.object({
    start: z.iso.date(),
    end: z.iso.date()
  }).strict(),
  monitorThrough: z.iso.date().optional(),
  dailyUpdateHourLocal: z.number().int().min(0).max(23).default(9),
  timeZone: z.string().trim().min(1).max(100).optional(),
  adults: z.number().int().min(1).max(MAX_ADULT_TRAVELLERS).default(1),
  cabin: z.enum(["economy", "premium_economy", "business", "first"]).default("economy"),
  maxStops: z.number().int().min(0).max(2).default(2),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u).optional(),
  connectionExamples: z.array(z.string().trim().min(1).max(80)).max(3).default([])
}).strict().superRefine((input, context) => {
  if (input.departureWindow.end < input.departureWindow.start) {
    context.addIssue({
      code: "custom",
      path: ["departureWindow", "end"],
      message: "Departure window end must not precede its start"
    });
  }
  if (input.monitorThrough && input.monitorThrough < input.departureWindow.start) {
    context.addIssue({
      code: "custom",
      path: ["monitorThrough"],
      message: "Monitoring must continue at least through the first departure date"
    });
  }
});

export default defineTool({
  description: [
    "Start or repair an opt-in daily fare digest for a broad route and departure-date window.",
    "Use this when the traveller wants a daily market update, cheapest-fare summary, or recurring route research without choosing a flight.",
    "This is not prepare_trip and not a selected-flight price watch: connections remain inside returned flight options and never become itinerary legs.",
    "Use one adult and one-way travel by default; pass the requested adult count when the traveller is searching for a group.",
    "Supply the dates already given, use 09:00 in the traveller’s timezone when they did not name a time, and do not ask a confirmation question.",
    "The tool replaces a conflicting active trip, queues the first verified search immediately, and then runs every local day through monitorThrough.",
    "After it succeeds, do not invent prices or send another setup explanation: the first verified Telegram digest says what was fixed, summarizes current prices, promises tomorrow’s update, and includes Browse trip."
  ].join(" "),
  inputSchema: startFareDigestInputSchema,
  async execute(rawInput, ctx) {
    return reportingFailures(async () => {
      const input = startFareDigestInputSchema.parse(rawInput);
      const services = await getCaptainServices();
      const userId = requireCaptainUser(ctx);
      const [user, profile, active] = await Promise.all([
        services.platformStore.getUser(userId),
        services.platformStore.ensureProfile(userId, new Date()),
        services.platformStore.getActiveTrip(userId)
      ]);
      if (!user) throw new Error("Traveller not found");
      const origin = resolveLocation(input.origin);
      const destination = resolveLocation(input.destination);
      if (!origin || !destination) {
        return {
          status: "invalid_location" as const,
          guidance: "Use plain city or airport names that Captain’s airport catalog can resolve. Never invent an airport code.",
          unresolved: [
            ...(!origin ? [input.origin] : []),
            ...(!destination ? [input.destination] : [])
          ]
        };
      }
      if (origin === destination) throw new RangeError("Origin and destination must differ");
      const timeZone = input.timeZone ?? user.timezone;
      assertTimeZone(timeZone);
      const monitorThrough = input.monitorThrough ?? input.departureWindow.end;
      const brief: TripBrief = {
        originAirports: [origin],
        destinationAirports: [destination],
        tripType: "one_way",
        departureWindow: input.departureWindow,
        stayNights: null,
        legs: [],
        travellers: { adults: input.adults, childrenAges: [], infants: 0 },
        cabin: input.cabin,
        maxStops: input.maxStops,
        currency: input.currency ?? profile.defaultCurrency,
        maximumPrice: null,
        preferredAirlines: [],
        excludedAirlines: [],
        context: digestContext(input.connectionExamples, monitorThrough)
      };
      const existingWatch = active
        ? await services.platformStore.getWatch(userId, active.id)
        : null;
      if (
        active
        && existingWatch?.purpose === "fare_digest"
        && ["active", "scheduled"].includes(existingWatch.status)
        && sameDigestBrief(active.brief, brief)
      ) {
        return {
          status: "already_started" as const,
          tripId: active.id,
          route: formatTripRoute(active.brief),
          nextUpdateAt: existingWatch.nextCheckAt,
          browseTrip: await services.tripPlanning.dashboardUrlForTrip(userId, active.id)
        };
      }

      const removedDestinations = active ? removedRouteStops(active, origin, destination) : [];
      if (active) await services.platformStore.archiveTripForReplacement(userId, active.id, new Date());
      const created = await services.trips.create(userId, {
        title: `${origin} to ${destination} daily fares`,
        brief
      });
      const started = await services.platformStore.startFareDigest(
        userId,
        created.trip.id,
        created.trip.version,
        buildSearchSpecs(brief),
        {
          hourLocal: input.dailyUpdateHourLocal,
          timeZone,
          monitorThrough,
          intro: digestIntro(
            origin,
            destination,
            input.adults,
            removedDestinations,
            input.connectionExamples
          )
        },
        new Date()
      );
      return {
        status: "started" as const,
        tripId: started.trip.id,
        route: formatTripRoute(started.trip.brief),
        departureWindow: started.trip.brief.departureWindow,
        monitorThrough,
        nextUpdateAt: started.watch.nextCheckAt,
        browseTrip: await services.tripPlanning.dashboardUrlForTrip(userId, started.trip.id),
        guidance: "The first verified fare digest is queued for Telegram. Do not invent prices or send a second setup message."
      };
    });
  }
});

function digestContext(connectionExamples: string[], monitorThrough: string): string {
  const connections = connectionExamples.length > 0
    ? ` Connections such as ${connectionExamples.join(" and ")} are flight details, not destinations.`
    : " Connections are flight details, not destinations.";
  return `Daily cheapest-fare digest through ${monitorThrough}.${connections}`;
}

function digestIntro(
  origin: string,
  destination: string,
  adults: number,
  removedDestinations: string[],
  connectionExamples: string[]
): string {
  const correction = removedDestinations.length > 0
    ? `I removed the extra ${removedDestinations.join(" and ")} destination${removedDestinations.length === 1 ? "" : "s"} and corrected this`
    : "I corrected this";
  const connection = connectionExamples.length > 0
    ? `${connectionExamples.join(" and ")} will only appear when ${connectionExamples.length === 1 ? "it’s a connection" : "they’re connections"} within a flight.`
    : "Connections will stay within each flight option; they won’t be added as destinations.";
  return `Fixed — ${correction} to ${adults}-adult fares from ${origin} to ${destination}. ${connection}`;
}

function removedRouteStops(trip: Trip, origin: string, destination: string): string[] {
  const routeCodes = trip.brief.tripType === "multi_city"
    ? (trip.brief.legs ?? []).flatMap((leg) => [
        ...leg.originAirports,
        ...leg.destinationAirports
      ])
    : [...trip.brief.originAirports, ...trip.brief.destinationAirports];
  return [...new Set(routeCodes)].filter((code) => code !== origin && code !== destination);
}

function sameDigestBrief(left: TripBrief, right: TripBrief): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    throw new RangeError(`Unknown timezone: ${timeZone}`);
  }
}

function resolveLocation(value: string): string | null {
  return airportCodeForLocation(value) ?? airportCodeAtStart(value);
}
