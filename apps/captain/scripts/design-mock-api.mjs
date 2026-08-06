#!/usr/bin/env node
/**
 * Local design API: seeds one mock trip with offers so Vite can render /trip and /profile.
 * Run: node --env-file-if-exists=.env scripts/design-mock-api.mjs
 * Open: http://127.0.0.1:4178/trip#access=design
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.CAPTAIN_DESIGN_API_PORT || 8080);
const NOW = "2026-08-04T08:00:00.000Z";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TRIP_ID = "22222222-2222-4222-8222-222222222222";

/** Start empty so the Add traveller → fake details path is the happy path. */
let passengers = [];
let tripPassengerIds = [];

function withReadiness(passenger) {
  const readyForBooking = Boolean(
    passenger.givenName?.trim()
    && passenger.familyName?.trim()
    && passenger.title
    && passenger.gender
    && passenger.bornOn
    && passenger.email
    && passenger.phoneNumber
  );
  const readyForInternationalTravel = Boolean(
    passenger.nationality
    && passenger.countryOfResidence
    && passenger.passportLast4
    && passenger.passportIssuingCountry
    && passenger.passportExpiresOn
  );
  return { ...passenger, readyForBooking, readyForInternationalTravel };
}

function publicPassenger(passenger) {
  const { passportNumber: _omit, ...rest } = passenger;
  return withReadiness(rest);
}

function tripTravellers() {
  return tripPassengerIds
    .map((id) => passengers.find((passenger) => passenger.id === id))
    .filter(Boolean)
    .map(publicPassenger);
}

const trip = {
  id: TRIP_ID,
  title: "Lagos",
  status: "tracking",
  version: 1,
  brief: {
    originAirports: ["LHR"],
    destinationAirports: ["LOS"],
    tripType: "round_trip",
    departureWindow: { start: "2026-09-10", end: "2026-09-12" },
    stayNights: { minimum: 6, preferred: 7, maximum: 8 },
    travellers: { adults: 1, childrenAges: [], infants: 0 },
    cabin: "economy",
    maxStops: 1,
    currency: "GBP",
    maximumPrice: null,
    preferredAirlines: ["BA"],
    excludedAirlines: [],
    context: "Prefer morning departures"
  },
  createdAt: NOW,
  updatedAt: NOW
};

const watch = {
  status: "active",
  runStartedAt: NOW,
  runEndsAt: "2026-08-07T08:00:00.000Z",
  completedAt: null,
  checksCompleted: 3,
  nextCheckAt: "2026-08-04T14:00:00.000Z",
  lastCheckAt: NOW,
  lastManualRefreshAt: null,
  trackingStartsAt: NOW,
  baselineCompletedAt: NOW,
  activatedAt: NOW,
  lastUserActivityAt: NOW,
  priceRiseItineraryKey: null,
  priceRiseArmed: false,
  delayedAt: null,
  delayReason: null
};

function offer(id, airline, price, stops, durationSeconds, segments) {
  return {
    id,
    itineraryKey: id,
    provider: "official_duffel",
    price,
    priceAmount: price.toFixed(2),
    currency: "GBP",
    fareBasis: "one_adult_total",
    primaryAirlineCode: airline,
    participatingAirlineCodes: [...new Set(segments.map((s) => s.airlineCode))],
    evidence: [{ url: "https://example.com/fare", title: "Verified fare", domain: "example.com" }],
    verifiedAt: NOW,
    observedAt: NOW,
    snapshot: {
      route: `${segments[0].origin}-${segments.at(-1).destination}`,
      flightNumbers: segments.map((s) => s.flightNumber),
      stops,
      durationSeconds,
      segments
    }
  };
}

const offers = [
  offer("off_ba_direct", "BA", 486, 0, 23400, [{
    airlineCode: "BA",
    airline: "British Airways",
    flightNumber: "BA75",
    origin: "LHR",
    destination: "LOS",
    departure: "2026-09-10T10:05:00.000Z",
    arrival: "2026-09-10T16:35:00.000Z"
  }, {
    airlineCode: "BA",
    airline: "British Airways",
    flightNumber: "BA74",
    origin: "LOS",
    destination: "LHR",
    departure: "2026-09-17T22:40:00.000Z",
    arrival: "2026-09-18T05:15:00.000Z"
  }]),
  offer("off_vs_one", "VS", 512, 0, 24120, [{
    airlineCode: "VS",
    airline: "Virgin Atlantic",
    flightNumber: "VS411",
    origin: "LHR",
    destination: "LOS",
    departure: "2026-09-11T13:20:00.000Z",
    arrival: "2026-09-11T19:55:00.000Z"
  }, {
    airlineCode: "VS",
    airline: "Virgin Atlantic",
    flightNumber: "VS412",
    origin: "LOS",
    destination: "LHR",
    departure: "2026-09-18T21:10:00.000Z",
    arrival: "2026-09-19T04:00:00.000Z"
  }]),
  offer("off_kl_stop", "KL", 429, 1, 31200, [{
    airlineCode: "KL",
    airline: "KLM",
    flightNumber: "KL1009",
    origin: "LHR",
    destination: "AMS",
    departure: "2026-09-10T07:15:00.000Z",
    arrival: "2026-09-10T09:30:00.000Z"
  }, {
    airlineCode: "KL",
    airline: "KLM",
    flightNumber: "KL587",
    origin: "AMS",
    destination: "LOS",
    departure: "2026-09-10T11:05:00.000Z",
    arrival: "2026-09-10T16:40:00.000Z"
  }, {
    airlineCode: "KL",
    airline: "KLM",
    flightNumber: "KL588",
    origin: "LOS",
    destination: "AMS",
    departure: "2026-09-17T23:05:00.000Z",
    arrival: "2026-09-18T07:20:00.000Z"
  }, {
    airlineCode: "KL",
    airline: "KLM",
    flightNumber: "KL1010",
    origin: "AMS",
    destination: "LHR",
    departure: "2026-09-18T09:00:00.000Z",
    arrival: "2026-09-18T09:20:00.000Z"
  }])
];

const profile = {
  userId: USER_ID,
  timeZone: "Europe/London",
  defaultCurrency: "GBP",
  rankingMode: "balanced",
  preferredAirlineCodes: ["BA", "VS"],
  excludedAirlineCodes: [],
  alertsEnabled: true,
  notificationMode: "smart",
  digestHourLocal: 9,
  priceRiseAlertsEnabled: true,
  betterOptionAlertsEnabled: true,
  maxAlertsPerDay: 2,
  quietHoursEnabled: false,
  quietHoursStart: 22,
  quietHoursEnd: 7,
  onboardingCompletedAt: NOW,
  onboardingStep: "complete",
  createdAt: NOW,
  updatedAt: NOW
};

const tripPayload = {
  trips: [trip],
  trip,
  watch,
  offers,
  recommendation: {
    tripId: TRIP_ID,
    offerId: offers[0].id,
    itineraryKey: offers[0].itineraryKey,
    score: 0.92,
    rankingMode: "balanced",
    summary: "Best balance of price and journey time for this trip."
  },
  selections: [{ itineraryKey: offers[0].itineraryKey, selectedBy: "person" }],
  activity: [{
    id: "act_1",
    eventType: "trip_created",
    payload: {},
    createdAt: NOW
  }]
};

const noStore = { "cache-control": "no-store", "content-type": "application/json" };

function json(res, status, body) {
  res.writeHead(status, noStore);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = req.method || "GET";

  if (path === "/health") return json(res, 200, { status: "ok", mode: "design-mock" });

  const authed = Boolean(
    req.headers.authorization?.startsWith("Bearer ")
    || /captain_session=/u.test(req.headers.cookie || "")
  );
  // Design links use #access=design — accept any bearer or cookie; also allow unauthed
  // reads when the hash token is present so a blank open still works after proxy.
  if (!authed && path.startsWith("/api/") && path !== "/api/auth/session") {
    // Still serve — Vite always sends Bearer once hash is present
  }

  if (method === "GET" && path === "/api/auth/session") {
    return json(res, 200, {
      authenticated: true,
      displayName: "Ada Lovelace",
      paymentsEnabled: false,
      credential: "session"
    });
  }

  if (method === "GET" && path === "/api/me/profile") {
    return json(res, 200, { profile });
  }

  if (method === "PATCH" && path === "/api/me/profile") {
    await readBody(req);
    return json(res, 200, { profile });
  }

  if (method === "GET" && path === "/api/me/trip") {
    return json(res, 200, {
      ...tripPayload,
      travellers: tripTravellers()
    });
  }

  if (method === "PATCH" && path === "/api/me/trip") {
    await readBody(req);
    return json(res, 200, { trip });
  }

  if (method === "POST" && path === "/api/me/trip/actions") {
    await readBody(req);
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/me/trip/selections") {
    const body = JSON.parse((await readBody(req)) || "{}");
    return json(res, 200, {
      tripId: TRIP_ID,
      itineraryKey: body.itineraryKey,
      selected: Boolean(body.selected)
    });
  }

  if (method === "GET" && path === "/api/me/passengers") {
    return json(res, 200, { passengers: passengers.map(publicPassenger) });
  }

  if (method === "POST" && path === "/api/me/passengers") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const stamp = new Date().toISOString();
    const makeDefault = body.isDefault === true || passengers.length === 0;
    if (makeDefault) {
      passengers = passengers.map((passenger) => ({ ...passenger, isDefault: false, updatedAt: stamp }));
    }
    const passenger = {
      id: randomUUID(),
      userId: USER_ID,
      givenName: body.givenName ?? "Traveller",
      middleName: body.middleName ?? null,
      familyName: body.familyName ?? "Demo",
      title: body.title ?? null,
      gender: body.gender ?? null,
      bornOn: body.bornOn ?? null,
      email: body.email ?? null,
      phoneNumber: body.phoneNumber ?? null,
      nationality: body.nationality ?? null,
      countryOfResidence: body.countryOfResidence ?? null,
      passportNumber: body.passportNumber ?? null,
      passportLast4: body.passportNumber ? String(body.passportNumber).slice(-4) : null,
      passportIssuingCountry: body.passportIssuingCountry ?? null,
      passportExpiresOn: body.passportExpiresOn ?? null,
      isDefault: makeDefault,
      createdAt: stamp,
      updatedAt: stamp
    };
    passengers = [...passengers, passenger];
    return json(res, 200, { passenger: publicPassenger(passenger) });
  }

  const passengerMatch = /^\/api\/me\/passengers\/([^/]+)(?:\/(default))?$/u.exec(path);
  if (passengerMatch) {
    const passengerId = decodeURIComponent(passengerMatch[1]);
    const index = passengers.findIndex((passenger) => passenger.id === passengerId);
    if (index < 0) return json(res, 404, { error: "not_found" });

    if (method === "PATCH" && !passengerMatch[2]) {
      const body = JSON.parse((await readBody(req)) || "{}");
      const stamp = new Date().toISOString();
      const current = passengers[index];
      const next = {
        ...current,
        ...("givenName" in body ? { givenName: body.givenName } : {}),
        ...("middleName" in body ? { middleName: body.middleName } : {}),
        ...("familyName" in body ? { familyName: body.familyName } : {}),
        ...("title" in body ? { title: body.title } : {}),
        ...("gender" in body ? { gender: body.gender } : {}),
        ...("bornOn" in body ? { bornOn: body.bornOn } : {}),
        ...("email" in body ? { email: body.email } : {}),
        ...("phoneNumber" in body ? { phoneNumber: body.phoneNumber } : {}),
        ...("nationality" in body ? { nationality: body.nationality } : {}),
        ...("countryOfResidence" in body ? { countryOfResidence: body.countryOfResidence } : {}),
        ...("passportIssuingCountry" in body ? { passportIssuingCountry: body.passportIssuingCountry } : {}),
        ...("passportExpiresOn" in body ? { passportExpiresOn: body.passportExpiresOn } : {}),
        ...("passportNumber" in body
          ? {
            passportNumber: body.passportNumber,
            passportLast4: body.passportNumber ? String(body.passportNumber).slice(-4) : null
          }
          : {}),
        ...("isDefault" in body ? { isDefault: Boolean(body.isDefault) } : {}),
        updatedAt: stamp
      };
      if (next.isDefault) {
        passengers = passengers.map((passenger, i) => (
          i === index ? next : { ...passenger, isDefault: false, updatedAt: stamp }
        ));
      } else {
        passengers = passengers.map((passenger, i) => (i === index ? next : passenger));
      }
      const updated = passengers.find((passenger) => passenger.id === passengerId);
      return json(res, 200, { passenger: publicPassenger(updated) });
    }

    if (method === "DELETE" && !passengerMatch[2]) {
      await readBody(req);
      passengers = passengers.filter((passenger) => passenger.id !== passengerId);
      tripPassengerIds = tripPassengerIds.filter((id) => id !== passengerId);
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && passengerMatch[2] === "default") {
      await readBody(req);
      const stamp = new Date().toISOString();
      passengers = passengers.map((passenger) => ({
        ...passenger,
        isDefault: passenger.id === passengerId,
        updatedAt: stamp
      }));
      const updated = passengers.find((passenger) => passenger.id === passengerId);
      return json(res, 200, { passenger: publicPassenger(updated) });
    }
  }

  if (method === "PUT" && path === "/api/me/trip/travellers") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const ids = Array.isArray(body.passengerIds) ? body.passengerIds.map(String) : [];
    tripPassengerIds = ids.filter((id) => passengers.some((passenger) => passenger.id === id));
    return json(res, 200, { passengers: tripTravellers() });
  }

  if (method === "GET" && path === "/api/me/payments/cards") {
    return json(res, 200, { cards: [] });
  }

  if (method === "GET" && path === "/auth/link") {
    res.writeHead(302, {
      location: "/trip",
      "set-cookie": "captain_session=design; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"
    });
    return res.end();
  }

  json(res, 404, { error: "not_found", path });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`design-mock-api listening on http://127.0.0.1:${PORT}`);
  console.log(`open http://127.0.0.1:4178/trip#access=design`);
  console.log(`open http://127.0.0.1:4178/profile#access=design`);
});
