import {
  analyzePriceHistory,
  toDailyPoints,
  type PriceAnalysisRange
} from "@agents/flight-domain";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import {
  resolveAnalysisPeriod,
  resolvePreviousAnalysisPeriod,
  type AnalysisPeriodSpec
} from "../../services/trips/analysis-period.js";
import { requireCaptainUser } from "../lib/principal.js";

const presetSchema = z.enum([
  "last_7_days",
  "last_30_days",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "all_history"
]);

const periodSchema = z.union([
  z.object({ preset: presetSchema }).strict(),
  z.object({
    startDate: z.iso.date(),
    endDate: z.iso.date()
  }).strict()
]);

export default defineTool({
  description: [
    "Analyze the watched flight's daily price history over a bounded period.",
    "Always use this tool when the traveller asks to compare periods, quantify a trend or change over time, find a period's average/range, or asks things like ‘this week versus last week’.",
    "It performs the date filtering and arithmetic and returns a grounded insight; never calculate those claims from get_trip offers.",
    "Use search_flights instead for current airline, schedule, availability, or live-fare questions."
  ].join(" "),
  inputSchema: z.object({
    tripId: z.uuid().optional(),
    period: periodSchema,
    compareWith: z.union([
      z.literal("previous_period"),
      periodSchema
    ]).optional()
  }).strict(),
  async execute({ tripId, period, compareWith }, ctx) {
    const userId = requireCaptainUser(ctx);
    const services = await getCaptainServices();
    const trip = tripId
      ? await services.platformStore.getTrip(userId, tripId)
      : await services.platformStore.getActiveTrip(userId);
    if (!trip) {
      return {
        status: "no_trip",
        message: "There is no active trip with price history to analyze."
      };
    }

    const tracked = await services.platformStore.getTrackedFlightPrices(userId, trip.id);
    if (!tracked) {
      return {
        status: "no_watched_flight",
        tripId: trip.id,
        message: "This trip has no watched flight. Pick a flight to start building a price history."
      };
    }

    const now = new Date();
    let requestedPeriod: PriceAnalysisRange;
    let requestedComparison: PriceAnalysisRange | null = null;
    try {
      requestedPeriod = resolveAnalysisPeriod(period as AnalysisPeriodSpec, now);
      requestedComparison = compareWith === "previous_period"
        ? resolvePreviousAnalysisPeriod(period as AnalysisPeriodSpec, requestedPeriod, now)
        : compareWith
          ? resolveAnalysisPeriod(compareWith as AnalysisPeriodSpec, now)
          : null;
    } catch (error) {
      return {
        status: "invalid_period",
        message: error instanceof Error ? error.message : "The requested period is invalid."
      };
    }

    if (compareWith === "previous_period" && !requestedComparison) {
      return {
        status: "invalid_comparison",
        message: "All retained history has no earlier period to compare with. Choose two bounded periods instead."
      };
    }

    const analysis = analyzePriceHistory({
      observations: tracked.observations,
      currency: tracked.currency,
      period: requestedPeriod,
      comparisonPeriod: requestedComparison
    });
    const availablePoints = toDailyPoints(tracked.observations);
    const firstAvailable = availablePoints[0]?.day ?? null;
    const lastAvailable = availablePoints.at(-1)?.day ?? null;
    const status = !analysis.period
      ? "no_data_for_period"
      : requestedComparison && !analysis.comparisonPeriod
        ? "insufficient_comparison_data"
        : "ok";
    const message = status === "no_data_for_period"
      ? "No watched-fare data falls inside the requested period."
      : status === "insufficient_comparison_data"
        ? "The requested period has data, but the comparison period does not."
        : null;

    return {
      status,
      tripId: trip.id,
      itineraryKey: tracked.itineraryKey,
      availableHistory: {
        startDay: firstAvailable,
        endDay: lastAvailable,
        observedDays: availablePoints.length
      },
      requestedPeriod,
      requestedComparison,
      message,
      analysis
    };
  }
});
