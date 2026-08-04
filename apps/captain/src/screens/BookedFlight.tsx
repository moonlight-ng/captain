import { useEffect, useState, type FormEvent } from "react";

import { ChevronRightIcon, CloseIcon } from "../components/icons";
import type { Segment } from "../domain";
import {
  airlineName,
  clockLabel,
  dateLabel,
  formatMoney,
  outboundSegments,
  timestampLabel
} from "../format";
import { DEFAULT_MOCK_TRAVELLER, type MockBooking, type MockBookingTraveller } from "../mock-booking";

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
  const [travellerOpen, setTravellerOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const segments = outboundSegments(booking.offer.snapshot.segments ?? []);
  const first = segments[0] ?? null;
  const last = segments.at(-1) ?? null;
  const cancelled = booking.status === "cancelled";
  const terminal = mockTerminal(booking.offer.primaryAirlineCode);
  const gate = mockGate(booking.offer.itineraryKey);
  const traveller = booking.traveller ?? DEFAULT_MOCK_TRAVELLER;
  const travellerName = `${traveller.givenName} ${traveller.familyName}`.trim();
  const travellerInitials = initials(traveller);

  function update(next: Partial<Pick<MockBooking, "status" | "seat" | "checkedBags" | "traveller">>, message: string) {
    onChange({ ...booking, ...next });
    setAction(null);
    setNotice(message);
  }

  return (
    <section className="booked-flight">
      <header className="booking-hero">
        <div className="booking-status-row">
          <span className={`booking-status ${cancelled ? "cancelled" : "confirmed"}`}>
            {cancelled ? "Mock cancelled" : "Mock Booking"}
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
        <div className="flight-now-top">
          <div className="flight-now-copy">
            <h2>{cancelled ? "Booking cancelled in this demo" : departureHeadline(first)}</h2>
            <p>{cancelled ? "No real booking was changed." : departureDetail(first)}</p>
          </div>
          {!cancelled && first && (
            <div className="flight-clock">
              <strong>{clockLabel(first.departure)}</strong>
              <span>{dateLabel(first.departure.slice(0, 10))}</span>
            </div>
          )}
        </div>
        {!cancelled && first && (
          <DepartureCountdown departure={first.departure} bookedAt={booking.bookedAt} />
        )}
        <div className="flight-facts" aria-label="Flight details">
          <article><span>Terminal</span><strong>{cancelled ? "—" : terminal}</strong></article>
          <article><span>Gate</span><strong>{cancelled ? "—" : gate}</strong></article>
          <article><span>Seat</span><strong>{booking.seat ?? "Choose"}</strong></article>
          <article><span>Bags</span><strong>{booking.checkedBags}</strong></article>
        </div>
      </section>

      <section className="booking-section">
        <button
          type="button"
          className="booking-traveller-row"
          onClick={() => setTravellerOpen(true)}
        >
          <span className="traveller-avatar" aria-hidden="true">{travellerInitials}</span>
          <span className="traveller-card-main">
            <span>
              <strong>{travellerName || "Add traveller"}</strong>
            </span>
            <small>
              {traveller.email
                || traveller.phoneNumber
                || "Tap to edit traveller details"}
            </small>
          </span>
          <ChevronRightIcon />
        </button>
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

      <section className="booking-section">
        <div className="booking-section-heading">
          <div><p className="eyebrow">Flight activity</p></div>
          <span>Live preview</span>
        </div>
        <MockFlightActivity booking={booking} segments={segments} />
      </section>

      <p className="prototype-disclaimer" role="note">
        Prototype only — no airline reservation or charge has been made. Every action here is simulated.{" "}
        <button type="button" onClick={onReset}>Exit demo</button>
      </p>

      <TravellerSheet
        open={travellerOpen}
        traveller={traveller}
        onClose={() => setTravellerOpen(false)}
        onSave={(nextTraveller) => {
          update({ traveller: nextTraveller }, "Traveller details updated for this demo.");
          setTravellerOpen(false);
        }}
      />
    </section>
  );
}

function TravellerSheet({
  open,
  traveller,
  onClose,
  onSave
}: {
  open: boolean;
  traveller: MockBookingTraveller;
  onClose: () => void;
  onSave: (traveller: MockBookingTraveller) => void;
}) {
  const [draft, setDraft] = useState(traveller);

  useEffect(() => {
    if (open) setDraft(traveller);
  }, [open, traveller]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSave({
      givenName: draft.givenName.trim(),
      familyName: draft.familyName.trim(),
      email: draft.email.trim(),
      phoneNumber: draft.phoneNumber.trim()
    });
  }

  return (
    <div
      className="sheet-backdrop traveller-sheet-backdrop"
      data-open={open}
      aria-hidden={!open}
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="bottom-sheet traveller-sheet"
        role="dialog"
        aria-modal={open}
        aria-label="Edit traveller"
      >
        <header>
          <span>
            <strong>Traveller</strong>
          </span>
          <button type="button" className="icon-button" aria-label="Close traveller" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <form className="traveller-sheet-form" onSubmit={handleSubmit}>
          <div className="traveller-sheet-row">
            <label>
              Given name
              <input
                required
                autoComplete="given-name"
                maxLength={40}
                value={draft.givenName}
                onChange={(event) => setDraft({ ...draft, givenName: event.target.value })}
              />
            </label>
            <label>
              Family name
              <input
                required
                autoComplete="family-name"
                maxLength={40}
                value={draft.familyName}
                onChange={(event) => setDraft({ ...draft, familyName: event.target.value })}
              />
            </label>
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                maxLength={80}
                value={draft.email}
                onChange={(event) => setDraft({ ...draft, email: event.target.value })}
              />
            </label>
            <label>
              Phone
              <input
                type="tel"
                autoComplete="tel"
                maxLength={24}
                value={draft.phoneNumber}
                onChange={(event) => setDraft({ ...draft, phoneNumber: event.target.value })}
              />
            </label>
          </div>
          <footer>
            <button type="button" className="secondary-action" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-action">Save traveller</button>
          </footer>
        </form>
      </section>
    </div>
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
  onUpdate: (next: Partial<Pick<MockBooking, "status" | "seat" | "checkedBags" | "traveller">>, message: string) => void;
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
    { kind: "step" as const, title: "Booking created", detail: timestampLabel(booking.bookedAt), complete: true },
    {
      kind: "step" as const,
      title: "Online check-in opens",
      detail: checkInAt ? timestampLabel(checkInAt) : "24 hours before departure",
      complete: false
    },
    { kind: "more" as const },
    {
      kind: "step" as const,
      title: "Departure",
      detail: first ? `${timestampLabel(first.departure)} · ${first.origin}` : "Awaiting schedule",
      complete: false
    },
    {
      kind: "step" as const,
      title: "Arrival",
      detail: last ? `${timestampLabel(last.arrival)} · ${last.destination}` : "Awaiting schedule",
      complete: false
    }
  ];
  return (
    <ol className="mock-activity-list">
      {items.map((item) => (
        item.kind === "more" ? (
          <li className="mock-activity-more" aria-hidden="true" key="more">
            <i /><i /><i />
          </li>
        ) : (
          <li className={item.complete ? "complete" : ""} key={item.title}>
            <i aria-hidden="true" />
            <span><strong>{item.title}</strong><small>{item.detail}</small></span>
          </li>
        )
      ))}
    </ol>
  );
}

function DepartureCountdown({
  departure,
  bookedAt
}: {
  departure: string;
  bookedAt: string;
}) {
  const countdown = departureCountdown(departure, bookedAt);
  const percent = Math.round(countdown.remainingFraction * 100);

  return (
    <div
      className="departure-countdown"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={`${countdown.value} ${countdown.unit} until departure`}
    >
      <div className="departure-countdown-track">
        <div className="departure-countdown-fill" style={{ width: `${percent}%` }} />
      </div>
      <span>{countdown.value} {countdown.unit} left</span>
    </div>
  );
}

function departureCountdown(departure: string, bookedAt: string, now = Date.now()) {
  const departAt = Date.parse(departure);
  const startAt = Date.parse(bookedAt);
  const remainingMs = Math.max(0, departAt - now);
  const windowMs = Math.max(departAt - startAt, remainingMs, 1);
  const remainingFraction = Math.min(1, remainingMs / windowMs);
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const totalHours = Math.floor(remainingMs / 3_600_000);
  const totalDays = Math.floor(remainingMs / 86_400_000);

  if (remainingMs <= 0) {
    return { value: "0", unit: "now", remainingFraction: 0 };
  }
  if (totalDays >= 1) {
    return { value: String(totalDays), unit: totalDays === 1 ? "day" : "days", remainingFraction };
  }
  if (totalHours >= 1) {
    return { value: String(totalHours), unit: totalHours === 1 ? "hr" : "hrs", remainingFraction };
  }
  return {
    value: String(Math.max(totalMinutes, 1)),
    unit: totalMinutes === 1 ? "min" : "mins",
    remainingFraction
  };
}

function departureHeadline(segment: Segment | null): string {
  if (!segment) return "Schedule pending";
  return `Depart from ${segment.origin}`;
}

function departureDetail(segment: Segment | null): string {
  if (!segment) return "Captain will surface timing and terminal updates here.";
  return `${segment.airline} ${segment.flightNumber}`;
}

function mockTerminal(airlineCode: string): string {
  const total = [...airlineCode].reduce((sum, value) => sum + value.charCodeAt(0), 0);
  return `T${total % 3 + 1}`;
}

function mockGate(itineraryKey: string): string {
  const total = [...itineraryKey].reduce((sum, value) => sum + value.charCodeAt(0), 0);
  return `${String.fromCharCode(65 + total % 4)}${total % 28 + 1}`;
}

function initials(traveller: MockBookingTraveller): string {
  const given = traveller.givenName.trim().charAt(0);
  const family = traveller.familyName.trim().charAt(0);
  return `${given}${family}`.toUpperCase() || "?";
}
