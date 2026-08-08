import { toDailyPoints, type PricePoint } from "./price-history.js";

export type PriceAnalysisRange = {
  /** Inclusive UTC calendar day. Null means the beginning/end of retained history. */
  startDay: string | null;
  endDay: string | null;
};

export type PricePeriodAnalysis = {
  requestedRange: PriceAnalysisRange;
  observedRange: { startDay: string; endDay: string };
  /** Number of UTC calendar days with at least one usable price observation. */
  observedDays: number;
  openingPrice: number;
  closingPrice: number;
  lowPrice: number;
  highPrice: number;
  averagePrice: number;
  change: number;
  changePercent: number | null;
  direction: "up" | "down" | "flat";
};

export type PricePeriodComparison = {
  averagePriceDifference: number;
  averagePriceDifferencePercent: number | null;
  closingPriceDifference: number;
  closingPriceDifferencePercent: number | null;
  direction: "higher" | "lower" | "flat";
};

export type PriceHistoryAnalysis = {
  currency: string;
  period: PricePeriodAnalysis | null;
  comparisonPeriod: PricePeriodAnalysis | null;
  comparison: PricePeriodComparison | null;
  insight: string;
};

/**
 * Calculates bounded, repeatable facts about the watched flight's daily price
 * series. Agent tools should use this instead of asking a model to perform
 * arithmetic over the raw observations returned by get_trip.
 */
export function analyzePriceHistory(input: {
  observations: ReadonlyArray<{ price: number; observedAt: string }>;
  currency: string;
  period: PriceAnalysisRange;
  comparisonPeriod?: PriceAnalysisRange | null;
}): PriceHistoryAnalysis {
  const points = toDailyPoints(input.observations);
  const period = analyzePeriod(points, input.period);
  const comparisonPeriod = input.comparisonPeriod
    ? analyzePeriod(points, input.comparisonPeriod)
    : null;
  const comparison = period && comparisonPeriod
    ? comparePeriods(period, comparisonPeriod)
    : null;

  return {
    currency: input.currency,
    period,
    comparisonPeriod,
    comparison,
    insight: buildInsight({
      currency: input.currency,
      period,
      comparisonPeriod,
      comparison
    })
  };
}

function analyzePeriod(
  points: ReadonlyArray<PricePoint>,
  requestedRange: PriceAnalysisRange
): PricePeriodAnalysis | null {
  const selected = points.filter((point) =>
    (!requestedRange.startDay || point.day >= requestedRange.startDay)
    && (!requestedRange.endDay || point.day <= requestedRange.endDay)
  );
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last) return null;

  const prices = selected.map((point) => point.price);
  const average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const change = last.price - first.price;

  return {
    requestedRange,
    observedRange: { startDay: first.day, endDay: last.day },
    observedDays: selected.length,
    openingPrice: first.price,
    closingPrice: last.price,
    lowPrice: Math.min(...prices),
    highPrice: Math.max(...prices),
    averagePrice: roundMoney(average),
    change: roundMoney(change),
    changePercent: percentageChange(first.price, last.price),
    direction: change > 0 ? "up" : change < 0 ? "down" : "flat"
  };
}

function comparePeriods(
  period: PricePeriodAnalysis,
  comparisonPeriod: PricePeriodAnalysis
): PricePeriodComparison {
  const averagePriceDifference = period.averagePrice - comparisonPeriod.averagePrice;
  const closingPriceDifference = period.closingPrice - comparisonPeriod.closingPrice;
  return {
    averagePriceDifference: roundMoney(averagePriceDifference),
    averagePriceDifferencePercent: percentageDifference(
      comparisonPeriod.averagePrice,
      averagePriceDifference
    ),
    closingPriceDifference: roundMoney(closingPriceDifference),
    closingPriceDifferencePercent: percentageDifference(
      comparisonPeriod.closingPrice,
      closingPriceDifference
    ),
    direction: averagePriceDifference > 0
      ? "higher"
      : averagePriceDifference < 0
        ? "lower"
        : "flat"
  };
}

function buildInsight(input: {
  currency: string;
  period: PricePeriodAnalysis | null;
  comparisonPeriod: PricePeriodAnalysis | null;
  comparison: PricePeriodComparison | null;
}): string {
  if (!input.period) return "No daily price data falls inside the requested period.";
  const periodLabel = formatRange(input.period.requestedRange, input.period.observedRange);

  if (input.comparisonPeriod && input.comparison) {
    const comparisonLabel = formatRange(
      input.comparisonPeriod.requestedRange,
      input.comparisonPeriod.observedRange
    );
    const difference = Math.abs(input.comparison.averagePriceDifference);
    const amount = formatAmount(difference, input.currency);
    const percentage = input.comparison.averagePriceDifferencePercent === null
      ? ""
      : ` (${Math.abs(input.comparison.averagePriceDifferencePercent)}%)`;
    const relationship = input.comparison.direction === "flat"
      ? "the same as"
      : `${amount}${percentage} ${input.comparison.direction} than`;
    return `${periodLabel} averaged ${formatAmount(input.period.averagePrice, input.currency)} `
      + `across ${formatCoverage(input.period.observedDays)}, ${relationship} ${comparisonLabel}, `
      + `which had ${formatCoverage(input.comparisonPeriod.observedDays)}.`;
  }

  if (input.period.observedDays < 2) {
    return `Only one daily price point falls in ${periodLabel}, so a within-period change cannot be established.`;
  }

  const movement = Math.abs(input.period.change);
  const movementText = input.period.direction === "flat"
    ? "did not change"
    : `${input.period.direction === "down" ? "fell" : "rose"} by `
      + `${formatAmount(movement, input.currency)}`
      + (input.period.changePercent === null
        ? ""
        : ` (${Math.abs(input.period.changePercent)}%)`);
  return `${periodLabel} ${movementText}, from `
    + `${formatAmount(input.period.openingPrice, input.currency)} to `
    + `${formatAmount(input.period.closingPrice, input.currency)}, across `
    + `${formatCoverage(input.period.observedDays)}.`;
}

function formatRange(
  requested: PriceAnalysisRange,
  observed: { startDay: string; endDay: string }
): string {
  const start = requested.startDay ?? observed.startDay;
  const end = requested.endDay ?? observed.endDay;
  return start === end ? start : `${start} to ${end}`;
}

function formatCoverage(count: number): string {
  return `${count} ${count === 1 ? "day" : "days"} with data`;
}

function percentageChange(from: number, to: number): number | null {
  return from === 0 ? null : roundPercentage(((to - from) / from) * 100);
}

function percentageDifference(baseline: number, difference: number): number | null {
  return baseline === 0 ? null : roundPercentage((difference / baseline) * 100);
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundPercentage(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function formatAmount(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(value);
  } catch {
    return `${currency} ${roundMoney(value)}`;
  }
}
