import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { ChevronRightIcon, CloseIcon } from "../components/icons";
import type { Segment } from "../domain";
import {
  airlineName,
  calendarDayOffset,
  clockLabel,
  dateLabel,
  formatDurationSeconds,
  formatMoney,
  label,
  outboundSegments,
  relativeTime,
  timestampLabel
} from "../format";
import { DEFAULT_MOCK_TRAVELLER, type MockBooking, type MockBookingTraveller } from "../mock-booking";
import { TEST_PAYMENT_METHOD } from "../mock-payment";

type MockAction = "seats" | "bags" | "cancel" | null;
type BookingUpdate = Partial<Pick<MockBooking, "status" | "seat" | "checkedBags" | "traveller" | "reference">>;

const BOOKING_CODE_MAX = 24;

function normalizeBookingCode(value: string): string {
  return value.trim().toUpperCase().slice(0, BOOKING_CODE_MAX);
}

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
  const [bookingCodeDraft, setBookingCodeDraft] = useState(booking.reference);
  const [notice, setNotice] = useState("");
  const segments = outboundSegments(booking.offer.snapshot.segments ?? []);
  const first = segments[0] ?? null;
  const last = segments.at(-1) ?? null;
  const cancelled = booking.status === "cancelled";
  const depTerminal = mockTerminal(booking.offer.primaryAirlineCode, "dep");
  const arrTerminal = mockTerminal(booking.offer.primaryAirlineCode, "arr");
  const depGate = mockGate(booking.offer.itineraryKey, "dep");
  const arrGate = mockGate(booking.offer.itineraryKey, "arr");
  const traveller = booking.traveller ?? DEFAULT_MOCK_TRAVELLER;
  const travellerName = `${traveller.givenName} ${traveller.familyName}`.trim();
  const travellerInitials = initials(traveller);
  const routeTitle = first && last
    ? `${cityName(first.origin)} to ${cityName(last.destination)}`
    : "Booked itinerary";
  const flightIdentity = first
    ? first.flightNumber
    : airlineName(booking.offer.primaryAirlineCode, [booking.offer]);
  const status = liveStatus(first, last, cancelled);
  const durationLabel = flightDurationLabel(booking.offer.snapshot.durationSeconds, first, last);
  const distanceLabel = mockDistanceMiles(booking.offer.snapshot.durationSeconds, first, last);
  const overnight = isOvernight(first, last);
  const dayOffset = first && last ? calendarDayOffset(first.departure, last.arrival) : 0;
  const goodToKnow = buildGoodToKnow(booking, first, last);

  useEffect(() => {
    setBookingCodeDraft(booking.reference);
  }, [booking.reference]);

  function update(next: BookingUpdate, message: string) {
    onChange({ ...booking, ...next });
    setAction(null);
    setNotice(message);
  }

  function commitBookingCode() {
    const next = normalizeBookingCode(bookingCodeDraft);
    if (!next) {
      setBookingCodeDraft(booking.reference);
      return;
    }
    if (next === booking.reference) {
      setBookingCodeDraft(next);
      return;
    }
    update({ reference: next }, "Booking code updated for this demo.");
  }

  return (
    <section className="booked-flight">
      <header className="booking-hero">
        <div className="booking-identity-row">
          <div>
            <strong>{flightIdentity}</strong>
          </div>
          <span className={`booking-status ${cancelled ? "cancelled" : "confirmed"}`}>
            {cancelled ? "Cancelled" : "Demo"}
          </span>
        </div>
        <h1>{routeTitle}</h1>
        <p>
          {airlineName(booking.offer.primaryAirlineCode, [booking.offer])}
          {first ? ` · ${first.flightNumber}` : ""}
        </p>
      </header>

      {notice && <div className="notice notice-mock-success" role="status">{notice}</div>}

      <section className="flight-now-card">
        <div className="flight-status-block">
          <h2 className={cancelled ? "is-cancelled" : "is-on-time"}>{status.headline}</h2>
          {first && <p>{dateLabel(first.departure.slice(0, 10)).toUpperCase()}</p>}
        </div>

        {first && last && (
          <div className="flight-timeline" aria-label="Flight timeline">
            <div className="flight-timeline-end">
              <div className="flight-timeline-meta">
                <strong>{first.origin}</strong>
                <span>{airportName(first.origin)}</span>
              </div>
              <div className="flight-timeline-time">
                <strong className={cancelled ? undefined : "is-on-time"}>{clockLabel(first.departure)}</strong>
                <div className="flight-facility-chips">
                  <span>{cancelled ? "—" : depTerminal}</span>
                  <span>{cancelled ? "—" : `Gate ${depGate}`}</span>
                </div>
              </div>
            </div>

            <div className="flight-timeline-rail" aria-hidden="true">
              <span>{durationLabel}</span>
              <i />
              <span>{distanceLabel}</span>
              {overnight && <span className="flight-overnight">Overnight</span>}
            </div>

            <div className="flight-timeline-end">
              <div className="flight-timeline-meta">
                <strong>{last.destination}</strong>
                <span>{airportName(last.destination)}</span>
              </div>
              <div className="flight-timeline-time">
                <strong className={cancelled ? undefined : "is-on-time"}>
                  {clockLabel(last.arrival)}
                  {dayOffset > 0 && <sup>+{dayOffset}</sup>}
                </strong>
                <div className="flight-facility-chips">
                  <span>{cancelled ? "—" : arrTerminal}</span>
                  <span>{cancelled ? "—" : `Gate ${arrGate}`}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="flight-personal-tiles" aria-label="Personal flight details">
        <label className="flight-personal-tile">
          <span>Booking code</span>
          <input
            className="booking-code-input"
            disabled={cancelled}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={BOOKING_CODE_MAX}
            value={bookingCodeDraft}
            aria-label="Booking code"
            onChange={(event) => setBookingCodeDraft(event.target.value.toUpperCase())}
            onBlur={commitBookingCode}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                setBookingCodeDraft(booking.reference);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <button
          type="button"
          className="flight-personal-tile seat-tile"
          disabled={cancelled}
          onClick={() => setAction("seats")}
        >
          <span>Seat</span>
          <strong>{booking.seat ?? "—"}</strong>
          <small>{booking.seat ? "Tap to change" : "Tap to edit"}</small>
        </button>
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

      {goodToKnow.length > 0 && (
        <section className="booking-section">
          <div className="booking-section-heading">
            <div><p className="eyebrow">Good to know</p></div>
          </div>
          <ul className="good-to-know-list">
            {goodToKnow.map((item) => (
              <li key={item.title}>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="booking-section">
        <div className="booking-section-heading">
          <div><p className="eyebrow">Updates</p></div>
          <span>{relativeTime(booking.bookedAt)}</span>
        </div>
        <MockFlightActivity
          booking={booking}
          segments={segments}
          depTerminal={depTerminal}
          arrTerminal={arrTerminal}
          arrGate={arrGate}
        />
      </section>

      <section className="booking-section booking-receipt">
        <div className="booking-section-heading">
          <p className="eyebrow">Receipt</p>
        </div>
        <dl className="booking-receipt-lines">
          <div>
            <dt>Reference</dt>
            <dd>{booking.reference}</dd>
          </div>
          {booking.checkedBags > 0 && (
            <>
              <div>
                <dt>Fare</dt>
                <dd>{formatMoney(booking.offer.price, booking.offer.currency)}</dd>
              </div>
              <div>
                <dt>Checked bags × {booking.checkedBags}</dt>
                <dd>{formatMoney(booking.checkedBags * 45, booking.offer.currency)}</dd>
              </div>
            </>
          )}
          <div className="booking-receipt-total">
            <dt>Total</dt>
            <dd>
              {formatMoney(
                booking.offer.price + booking.checkedBags * 45,
                booking.offer.currency
              )}
            </dd>
          </div>
          <div className="booking-receipt-card">
            <dt>Card</dt>
            <dd>
              {label(TEST_PAYMENT_METHOD.brand)} ···· {TEST_PAYMENT_METHOD.last4}
            </dd>
          </div>
        </dl>
      </section>

      <p className="prototype-disclaimer" role="note">
        Prototype only — no airline reservation or charge has been made. Every action here is simulated.{" "}
        <button type="button" onClick={onReset}>Reset</button>
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
    <SheetShell open={open} label="Edit traveller" title="Traveller" onClose={onClose}>
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
    </SheetShell>
  );
}

function SheetShell({
  open,
  label,
  title,
  onClose,
  children
}: {
  open: boolean;
  label: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
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
        aria-label={label}
      >
        <header>
          <span>
            <strong>{title}</strong>
          </span>
          <button type="button" className="icon-button" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        {children}
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
  onUpdate: (next: BookingUpdate, message: string) => void;
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

function MockFlightActivity({
  booking,
  segments,
  depTerminal,
  arrTerminal,
  arrGate
}: {
  booking: MockBooking;
  segments: Segment[];
  depTerminal: string;
  arrTerminal: string;
  arrGate: string;
}) {
  const first = segments[0] ?? null;
  const last = segments.at(-1) ?? null;
  const checkInAt = first
    ? new Date(Date.parse(first.departure) - 24 * 60 * 60 * 1000).toISOString()
    : null;
  const gateAssignedAt = first
    ? new Date(Date.parse(first.departure) - 5 * 60 * 60 * 1000).toISOString()
    : null;
  const items = [
    { title: "Booking created", detail: timestampLabel(booking.bookedAt), complete: true },
    {
      title: `Arrival at ${arrTerminal} · Gate ${arrGate}`,
      detail: gateAssignedAt ? timestampLabel(gateAssignedAt) : "Gate assignment pending",
      complete: booking.status === "confirmed"
    },
    {
      title: "Online check-in opens",
      detail: checkInAt ? timestampLabel(checkInAt) : "24 hours before departure",
      complete: false
    },
    {
      title: "Departure",
      detail: first ? `${timestampLabel(first.departure)} · ${first.origin} ${depTerminal}` : "Awaiting schedule",
      complete: false
    },
    {
      title: "Arrival",
      detail: last ? `${timestampLabel(last.arrival)} · ${last.destination}` : "Awaiting schedule",
      complete: false
    }
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

function liveStatus(
  first: Segment | null,
  last: Segment | null,
  cancelled: boolean,
  now = Date.now()
): { headline: string; detail: string } {
  if (cancelled) {
    return {
      headline: "Booking cancelled in this demo",
      detail: "No real booking was changed."
    };
  }
  if (!first || !last) {
    return {
      headline: "Schedule pending",
      detail: "Captain will surface timing and terminal updates here."
    };
  }

  const departAt = Date.parse(first.departure);
  const arriveAt = Date.parse(last.arrival);
  const remainingToDep = departAt - now;
  const remainingToArr = arriveAt - now;

  if (remainingToArr <= 0) {
    return {
      headline: "Arrived",
      detail: `Touchdown at ${last.destination}. Demo tracking only.`
    };
  }

  if (remainingToDep <= 0) {
    return {
      headline: `Landing in ${formatCountdown(remainingToArr)}`,
      detail: `On track for ${clockLabel(last.arrival)} arrival at ${last.destination}.`
    };
  }

  const inboundCity = cityName(last.destination);
  return {
    headline: `Departs in ${formatCountdown(remainingToDep)}`,
    detail: `Inbound aircraft is in air from ${inboundCity}, with enough time for ${clockLabel(first.departure)} departure.`
  };
}

function buildGoodToKnow(
  booking: MockBooking,
  first: Segment | null,
  last: Segment | null
): Array<{ title: string; detail: string }> {
  if (!first || !last) return [];
  const items: Array<{ title: string; detail: string }> = [];
  const codes = booking.offer.participatingAirlineCodes;
  const operatingCode = codes.find((code) => code !== first.airlineCode) ?? first.airlineCode;
  const operatingName = airlineName(operatingCode, [booking.offer]);

  if (operatingCode !== first.airlineCode) {
    items.push({
      title: `Operated as ${operatingCode} ${first.flightNumber.replace(/^[A-Z]{2}/u, operatingCode)}`,
      detail: `By ${operatingName} — use their check-in counters.`
    });
  } else {
    items.push({
      title: `Operated by ${first.airline || operatingName}`,
      detail: `${first.flightNumber} is marketed and flown by the same carrier.`
    });
  }

  const originOffset = airportUtcOffset(first.origin);
  const destOffset = airportUtcOffset(last.destination);
  const shiftHours = destOffset - originOffset;
  if (shiftHours !== 0) {
    const localArrival = new Date(Date.parse(last.arrival) - shiftHours * 3_600_000);
    const sign = shiftHours > 0 ? "+" : "";
    items.push({
      title: `${sign}${shiftHours} Hour${Math.abs(shiftHours) === 1 ? "" : "s"} Timezone Change`,
      detail: `${clockLabel(last.arrival)} arrival is ${clockLabel(localArrival.toISOString())} ${cityName(first.origin)} time.`
    });
  }

  items.push({
    title: `${last.destination} Arrivals`,
    detail: "Normal operations · No irregular traffic in this demo."
  });

  items.push({
    title: "Arrival weather",
    detail: mockArrivalWeather(last.destination)
  });

  return items;
}

function formatCountdown(ms: number): string {
  const remainingMs = Math.max(0, ms);
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (remainingMs <= 0) return "now";
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 1)}m`;
}

function flightDurationLabel(
  durationSeconds: number | undefined,
  first: Segment | null,
  last: Segment | null
): string {
  if (durationSeconds && durationSeconds > 0) return formatDurationSeconds(durationSeconds);
  if (!first || !last) return "—";
  const seconds = Math.max(0, Math.round((Date.parse(last.arrival) - Date.parse(first.departure)) / 1000));
  return formatDurationSeconds(seconds);
}

function mockDistanceMiles(
  durationSeconds: number | undefined,
  first: Segment | null,
  last: Segment | null
): string {
  const seconds = durationSeconds && durationSeconds > 0
    ? durationSeconds
    : first && last
      ? Math.max(0, Math.round((Date.parse(last.arrival) - Date.parse(first.departure)) / 1000))
      : 0;
  const miles = Math.max(0, Math.round((seconds / 3600) * 480));
  return `${miles.toLocaleString("en")} mi`;
}

function isOvernight(first: Segment | null, last: Segment | null): boolean {
  if (!first || !last) return false;
  if (calendarDayOffset(first.departure, last.arrival) > 0) return true;
  const depHour = new Date(first.departure).getHours();
  return depHour >= 20;
}

function mockTerminal(airlineCode: string, side: "dep" | "arr"): string {
  const total = [...airlineCode, side].reduce((sum, value) => sum + value.charCodeAt(0), 0);
  return `Terminal ${total % 3 + 1}`;
}

function mockGate(itineraryKey: string, side: "dep" | "arr"): string {
  const total = [...itineraryKey, side].reduce((sum, value) => sum + value.charCodeAt(0), 0);
  return `${String.fromCharCode(65 + total % 4)}${total % 28 + 1}`;
}

function initials(traveller: MockBookingTraveller): string {
  const given = traveller.givenName.trim().charAt(0);
  const family = traveller.familyName.trim().charAt(0);
  return `${given}${family}`.toUpperCase() || "?";
}

function cityName(code: string): string {
  return CITY_NAMES[code] ?? code;
}

function airportName(code: string): string {
  return AIRPORT_NAMES[code] ?? `${code} Airport`;
}

function airportUtcOffset(code: string): number {
  return AIRPORT_UTC_OFFSET[code] ?? 0;
}

function mockArrivalWeather(code: string): string {
  const total = [...code].reduce((sum, value) => sum + value.charCodeAt(0), 0);
  const temp = 55 + (total % 30);
  const skies = ["clear skies", "scattered clouds", "partly cloudy", "light wind"][total % 4];
  return `${temp}°F and ${skies}.`;
}

const CITY_NAMES: Record<string, string> = {
  LHR: "London",
  LGW: "London",
  STN: "London",
  LOS: "Lagos",
  ABV: "Abuja",
  JFK: "New York",
  EWR: "New York",
  LGA: "New York",
  NRT: "Tokyo",
  HND: "Tokyo",
  ICN: "Seoul",
  CGK: "Jakarta",
  CDG: "Paris",
  AMS: "Amsterdam",
  FRA: "Frankfurt",
  DXB: "Dubai",
  DOH: "Doha",
  IST: "Istanbul",
  SFO: "San Francisco",
  LAX: "Los Angeles",
  ORD: "Chicago",
  ATL: "Atlanta",
  MIA: "Miami",
  YYZ: "Toronto",
  MAD: "Madrid",
  BCN: "Barcelona",
  FCO: "Rome",
  MUC: "Munich",
  ZRH: "Zurich",
  GVA: "Geneva",
  SIN: "Singapore",
  HKG: "Hong Kong",
  SYD: "Sydney",
  MEL: "Melbourne",
  AUH: "Abu Dhabi",
  DEL: "Delhi",
  BOM: "Mumbai",
  ACC: "Accra",
  NBO: "Nairobi",
  CPT: "Cape Town",
  JNB: "Johannesburg"
};

const AIRPORT_NAMES: Record<string, string> = {
  LHR: "Heathrow",
  LGW: "Gatwick",
  STN: "Stansted",
  LOS: "Murtala Muhammed Intl",
  ABV: "Nnamdi Azikiwe Intl",
  JFK: "John F. Kennedy Intl",
  EWR: "Newark Liberty Intl",
  LGA: "LaGuardia",
  NRT: "Narita Intl",
  HND: "Haneda",
  ICN: "Incheon Intl",
  CGK: "Soekarno-Hatta Intl",
  CDG: "Charles de Gaulle",
  AMS: "Schiphol",
  FRA: "Frankfurt Intl",
  DXB: "Dubai Intl",
  DOH: "Hamad Intl",
  IST: "Istanbul Airport",
  SFO: "San Francisco Intl",
  LAX: "Los Angeles Intl",
  ORD: "O'Hare Intl",
  ATL: "Hartsfield-Jackson",
  MIA: "Miami Intl",
  YYZ: "Pearson Intl",
  MAD: "Barajas",
  BCN: "El Prat",
  FCO: "Fiumicino",
  MUC: "Munich Airport",
  ZRH: "Zurich Airport",
  GVA: "Geneva Airport",
  SIN: "Changi",
  HKG: "Hong Kong Intl",
  SYD: "Kingsford Smith",
  MEL: "Tullamarine",
  AUH: "Zayed Intl",
  DEL: "Indira Gandhi Intl",
  BOM: "Chhatrapati Shivaji",
  ACC: "Kotoka Intl",
  NBO: "Jomo Kenyatta Intl",
  CPT: "Cape Town Intl",
  JNB: "O.R. Tambo Intl"
};

const AIRPORT_UTC_OFFSET: Record<string, number> = {
  LHR: 1,
  LGW: 1,
  STN: 1,
  LOS: 1,
  ABV: 1,
  JFK: -5,
  EWR: -5,
  LGA: -5,
  NRT: 9,
  HND: 9,
  ICN: 9,
  CGK: 7,
  CDG: 1,
  AMS: 1,
  FRA: 1,
  DXB: 4,
  DOH: 3,
  IST: 3,
  SFO: -8,
  LAX: -8,
  ORD: -6,
  ATL: -5,
  MIA: -5,
  YYZ: -5,
  MAD: 1,
  BCN: 1,
  FCO: 1,
  MUC: 1,
  ZRH: 1,
  GVA: 1,
  SIN: 8,
  HKG: 8,
  SYD: 11,
  MEL: 11,
  AUH: 4,
  DEL: 5.5,
  BOM: 5.5,
  ACC: 0,
  NBO: 3,
  CPT: 2,
  JNB: 2
};
