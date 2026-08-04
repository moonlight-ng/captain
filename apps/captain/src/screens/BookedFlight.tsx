import { useState } from "react";

import type { Segment } from "../domain";
import {
  airlineName,
  clockLabel,
  dateLabel,
  formatMoney,
  outboundSegments,
  timestampLabel
} from "../format";
import type { MockBooking } from "../mock-booking";

type MockAction = "seats" | "bags" | "cancel" | null;

export function BookedFlight({
  booking,
  onChange,
  onReset
}: {
  booking: MockBooking;
  onChange: (booking: MockBooking) => void;
  onReset: () => void;
}) {
  const [action, setAction] = useState<MockAction>(null);
  const [notice, setNotice] = useState("");
  const segments = outboundSegments(booking.offer.snapshot.segments ?? []);
  const first = segments[0] ?? null;
  const last = segments.at(-1) ?? null;
  const cancelled = booking.status === "cancelled";
  const terminal = mockTerminal(booking.offer.primaryAirlineCode);
  const gate = mockGate(booking.offer.itineraryKey);

  function update(next: Partial<Pick<MockBooking, "status" | "seat" | "checkedBags">>, message: string) {
    onChange({ ...booking, ...next });
    setAction(null);
    setNotice(message);
  }

  return (
    <section className="booked-flight">
      <section className="mock-preview-banner mock-preview-banner-trip" role="note">
        <span>Mock booking</span>
        <div>
          <strong>No airline reservation or charge has been made.</strong>
          <p>This screen previews the post-booking Captain experience. Every action below is simulated.</p>
        </div>
      </section>

      <header className="booking-hero">
        <div className="booking-status-row">
          <span className={`booking-status ${cancelled ? "cancelled" : "confirmed"}`}>
            {cancelled ? "Mock cancelled" : "Mock confirmed"}
          </span>
          <span>{booking.reference}</span>
        </div>
        <p className="eyebrow">Your flight</p>
        <h1>{first && last ? `${first.origin} → ${last.destination}` : "Booked itinerary"}</h1>
        <p>
          {airlineName(booking.offer.primaryAirlineCode, [booking.offer])}
          {first ? ` · ${first.flightNumber}` : ""}
        </p>
        <strong>{formatMoney(booking.offer.price, booking.offer.currency)}</strong>
      </header>

      {notice && <div className="notice notice-mock-success" role="status">{notice}</div>}

      <section className="flight-now-card">
        <div>
          <p className="eyebrow">Next</p>
          <h2>{cancelled ? "Booking cancelled in this demo" : departureHeadline(first)}</h2>
          <p>{cancelled ? "No real booking was changed." : departureDetail(first)}</p>
        </div>
        {!cancelled && first && (
          <div className="flight-clock">
            <strong>{clockLabel(first.departure)}</strong>
            <span>{dateLabel(first.departure.slice(0, 10))}</span>
          </div>
        )}
      </section>

      <section className="flight-facts" aria-label="Flight details">
        <article><span>Terminal</span><strong>{cancelled ? "—" : terminal}</strong></article>
        <article><span>Gate</span><strong>{cancelled ? "—" : gate}</strong></article>
        <article><span>Seat</span><strong>{booking.seat ?? "Choose"}</strong></article>
        <article><span>Bags</span><strong>{booking.checkedBags}</strong></article>
      </section>

      <section className="booking-section">
        <div className="booking-section-heading">
          <div><p className="eyebrow">Flight activity</p><h2>What happens next</h2></div>
          <span>Live preview</span>
        </div>
        <MockFlightActivity booking={booking} segments={segments} />
      </section>

      <section className="booking-section">
        <div className="booking-section-heading">
          <div><p className="eyebrow">Manage</p><h2>Booking actions</h2></div>
          <span>Simulated</span>
        </div>
        <div className="booking-actions">
          <button type="button" disabled={cancelled} onClick={() => setAction("seats")}>Buy seats</button>
          <button type="button" disabled={cancelled} onClick={() => setAction("bags")}>Add baggage</button>
          {cancelled ? (
            <button
              type="button"
              onClick={() => update({ status: "confirmed" }, "Mock booking restored. No airline was contacted.")}
            >
              Restore booking
            </button>
          ) : (
            <button type="button" className="danger" onClick={() => setAction("cancel")}>Cancel flight</button>
          )}
        </div>
        {action && (
          <MockActionPanel
            action={action}
            booking={booking}
            onClose={() => setAction(null)}
            onUpdate={update}
          />
        )}
      </section>

      <button type="button" className="reset-demo" onClick={onReset}>
        Exit booked-flight demo
      </button>
    </section>
  );
}

function MockActionPanel({
  action,
  booking,
  onClose,
  onUpdate
}: {
  action: Exclude<MockAction, null>;
  booking: MockBooking;
  onClose: () => void;
  onUpdate: (next: Partial<Pick<MockBooking, "status" | "seat" | "checkedBags">>, message: string) => void;
}) {
  if (action === "seats") {
    return (
      <div className="mock-action-panel">
        <div className="mock-action-heading"><strong>Choose a mock seat</strong><button onClick={onClose}>Close</button></div>
        <p>No seat purchase or payment will occur.</p>
        <div className="seat-picker">
          {["12A", "12C", "14A", "14F"].map((seat) => (
            <button
              type="button"
              className={booking.seat === seat ? "selected" : ""}
              key={seat}
              onClick={() => onUpdate({ seat }, `Seat ${seat} selected for the demo. Nothing was purchased.`)}
            >
              {seat}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (action === "bags") {
    return (
      <div className="mock-action-panel">
        <div className="mock-action-heading"><strong>Mock checked baggage</strong><button onClick={onClose}>Close</button></div>
        <p>Add one demo bag. No airline or card will be contacted.</p>
        <button
          type="button"
          className="mock-confirm-action"
          onClick={() => onUpdate(
            { checkedBags: Math.min(booking.checkedBags + 1, 3) },
            "A mock checked bag was added. Nothing was purchased."
          )}
        >
          Add bag · mock £45
        </button>
      </div>
    );
  }
  return (
    <div className="mock-action-panel danger-panel">
      <div className="mock-action-heading"><strong>Cancel this mock booking?</strong><button onClick={onClose}>Close</button></div>
      <p>This changes only the demo state stored in this browser.</p>
      <button
        type="button"
        className="mock-confirm-action danger"
        onClick={() => onUpdate({ status: "cancelled" }, "Mock booking cancelled. No airline was contacted.")}
      >
        Confirm mock cancellation
      </button>
    </div>
  );
}

function MockFlightActivity({ booking, segments }: { booking: MockBooking; segments: Segment[] }) {
  const first = segments[0] ?? null;
  const last = segments.at(-1) ?? null;
  const checkInAt = first
    ? new Date(Date.parse(first.departure) - 24 * 60 * 60 * 1000).toISOString()
    : null;
  const items = [
    { title: "Mock booking created", detail: timestampLabel(booking.bookedAt), complete: true },
    { title: "Online check-in opens", detail: checkInAt ? timestampLabel(checkInAt) : "24 hours before departure", complete: false },
    { title: "Departure", detail: first ? `${timestampLabel(first.departure)} · ${first.origin}` : "Awaiting schedule", complete: false },
    { title: "Arrival", detail: last ? `${timestampLabel(last.arrival)} · ${last.destination}` : "Awaiting schedule", complete: false }
  ];
  return (
    <ol className="mock-activity-list">
      {items.map((item) => (
        <li className={item.complete ? "complete" : ""} key={item.title}>
          <i aria-hidden="true" />
          <span><strong>{item.title}</strong><small>{item.detail}</small></span>
        </li>
      ))}
    </ol>
  );
}

function departureHeadline(segment: Segment | null): string {
  if (!segment) return "Schedule pending";
  return `Depart from ${segment.origin}`;
}

function departureDetail(segment: Segment | null): string {
  if (!segment) return "Captain will surface timing and terminal updates here.";
  return `${segment.airline} ${segment.flightNumber} · Arrive at the airport 3 hours early.`;
}

function mockTerminal(airlineCode: string): string {
  const total = [...airlineCode].reduce((sum, value) => sum + value.charCodeAt(0), 0);
  return `T${total % 3 + 1}`;
}

function mockGate(itineraryKey: string): string {
  const total = [...itineraryKey].reduce((sum, value) => sum + value.charCodeAt(0), 0);
  return `${String.fromCharCode(65 + total % 4)}${total % 28 + 1}`;
}
