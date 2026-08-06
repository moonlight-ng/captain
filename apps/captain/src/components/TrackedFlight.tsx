import type { PriceVerdict, TrackedPriceHistory, VerifiedOffer } from "../domain";
import { airlineName, duration, formatMoney, stops } from "../format";

const verdictLabels: Record<PriceVerdict, string> = {
  book_now: "Good time to buy",
  good_price: "Below average",
  holding: "Holding steady",
  wait: "Worth waiting"
};

/**
 * The watched flight, above everything else on the trip screen. One flight is
 * watched at a time, so this card is the answer to the only question Captain
 * is really being asked: is now the moment?
 */
export function TrackedFlightCard({
  history,
  offer,
  onOpen
}: {
  history: TrackedPriceHistory;
  /** Absent when the fare has dropped out of the latest verified set. */
  offer: VerifiedOffer | null;
  onOpen: () => void;
}) {
  const change = history.changeSinceStart;
  return (
    <button type="button" className="tracked-card" onClick={onOpen}>
      <div className="tracked-top">
        <span className="eyebrow">Watching</span>
        <span className={`verdict-pill ${history.verdict}`}>{verdictLabels[history.verdict]}</span>
      </div>

      <div className="tracked-headline">
        <strong className="price">{formatMoney(history.current, history.currency)}</strong>
        {history.daysTracked > 1 && (
          <span className={`tracked-change ${change < 0 ? "down" : change > 0 ? "up" : ""}`}>
            {change === 0
              ? "No change"
              : `${change < 0 ? "↓" : "↑"} ${formatMoney(Math.abs(change), history.currency)}`}
            <small>
              {" over "}
              {history.daysTracked} day{history.daysTracked === 1 ? "" : "s"}
            </small>
          </span>
        )}
      </div>

      <PriceChart history={history} />

      <p className="tracked-read">{history.headline}</p>

      <div className="tracked-foot">
        <span>
          {offer
            ? `${airlineName(offer.primaryAirlineCode, [offer])} · ${duration(offer)} · ${stops(offer)}`
            : "This fare is not in the latest results"}
        </span>
        <span className="tracked-more">Details →</span>
      </div>
    </button>
  );
}

/**
 * The price series as a plain area chart. Low and high are marked rather than
 * axis-labelled: they are the two numbers a decision actually turns on.
 */
export function PriceChart({
  history,
  height = 64
}: {
  history: TrackedPriceHistory;
  height?: number;
}) {
  const { points, low, high, currency } = history;
  if (points.length < 2) {
    return (
      <p className="tracked-chart-empty">
        Captain has one price so far. The chart fills in from the next daily check.
      </p>
    );
  }

  const width = 300;
  const span = high - low || 1;
  const step = width / (points.length - 1);
  // Inset vertically so the flattest series still reads as a line, not an edge.
  const y = (price: number) => 6 + (1 - (price - low) / span) * (height - 12);
  const coordinates = points.map((point, index) => [index * step, y(point.price)] as const);
  const line = coordinates.map(([x, top]) => `${x.toFixed(1)},${top.toFixed(1)}`).join(" ");
  const area = `${line} ${width},${height} 0,${height}`;
  const last = coordinates.at(-1)!;

  return (
    <figure className="tracked-chart">
      <div className="tracked-chart-plot" style={{ height }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={
            `Price over ${points.length} days, from `
            + `${formatMoney(points[0]!.price, currency)} to `
            + `${formatMoney(points.at(-1)!.price, currency)}. `
            + `Lowest ${formatMoney(low, currency)}, highest ${formatMoney(high, currency)}.`
          }
        >
          <polygon className="tracked-chart-fill" points={area} />
          <polyline className="tracked-chart-line" points={line} />
        </svg>
        {/*
          The plot stretches to its container, which would squash a marker
          drawn inside the SVG into an ellipse and clip it at the right edge.
          Positioning it over the plot keeps it round at any width.
        */}
        <span
          className="tracked-chart-now"
          style={{ top: `${(last[1] / height) * 100}%` }}
          aria-hidden="true"
        />
      </div>
      <figcaption>
        <span>Low {formatMoney(low, currency)}</span>
        <span>High {formatMoney(high, currency)}</span>
      </figcaption>
    </figure>
  );
}
