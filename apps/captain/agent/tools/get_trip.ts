import {
  formatTripGoal,
  summarizePriceHistory,
  tripGoalState,
  type CanonicalFlight,
  type FlightOfferSnapshot,
  type LegSearchPick,
  type LegSearchSnapshot,
  type TripGraph
} from "@agents/flight-domain";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { getCaptainServices } from "../../services/app/services.js";
import { explainRecommendation } from "../../services/trips/explain.js";
import { requireCaptainUser } from "../lib/principal.js";

export default defineTool({
  description:
    "List the traveller's active trips and get both normalized per-leg search results and legacy "
    + "whole-trip offers for the selected or requested trip, including selected flights and price history.",
  inputSchema: z.object({ tripId: z.uuid().optional() }).strict(),
  async execute({ tripId }, ctx) {
    const userId = requireCaptainUser(ctx);
    const services = await getCaptainServices();
    const trips = (await services.platformStore.listTrips(userId))
      .filter((trip) => !["cancelled", "completed", "archived"].includes(trip.status));
    const trip = tripId
      ? trips.find((candidate) => candidate.id === tripId) ?? null
      : await services.platformStore.getActiveTrip(userId);
    if (!trip) {
      return {
        trips,
        trip: null,
        goal: null,
        legSearches: [],
        offers: [],
        watchedFlight: null
      };
    }
    const checkedAt = new Date();
    const [offers, tracked, profile, legSearches, recommendation] = await Promise.all([
      services.trips.offers(userId, trip.id),
      services.platformStore.getTrackedFlightPrices(userId, trip.id),
      services.platformStore.ensureProfile(userId, checkedAt),
      services.env.simplifiedMultiCityEnabled
        ? getLegSearches(services.platformStore, userId, trip.id, checkedAt)
        : Promise.resolve([]),
      services.platformStore.getRecommendation(userId, trip.id)
    ]);
    return {
      trips,
      trip,
      // What this trip is for. Every answer is measured against it.
      goal: formatTripGoal({ brief: trip.brief, rankingMode: profile.rankingMode }),
      goalState: tripGoalState(trip.status),
      // The normalized web flow stores verified inventory and selections per
      // leg. This is authoritative even when the legacy whole-trip offers
      // below are empty.
      legSearches,
      offers,
      // Why the current pick won, worked out deterministically from the
      // recommendation snapshot. Quote it rather than reasoning about the
      // comparison again — the arithmetic is already settled here.
      recommendationExplanation: recommendation
        ? explainRecommendation(recommendation.snapshot)
        : null,
      // The whole point of the trip: what the watched fare has done, and
      // whether now is the moment. Null until the traveller picks a flight.
      watchedFlight: tracked
        ? {
            itineraryKey: tracked.itineraryKey,
            ...summarizePriceHistory({
              observations: tracked.observations,
              currency: tracked.currency,
              departureDate: trip.brief.departureWindow.start
            })
          }
        : null
    };
  }
});

type LegSearchStore = {
  getTripGraph(userId: string, tripId: string): Promise<TripGraph>;
  getLatestLegSearchSnapshot(
    userId: string,
    tripId: string,
    legId: string
  ): Promise<LegSearchSnapshot | null>;
  getCanonicalFlight(
    flightKey: string,
    now: Date
  ): Promise<{ flight: CanonicalFlight; offers: FlightOfferSnapshot[] } | null>;
};

async function getLegSearches(
  store: LegSearchStore,
  userId: string,
  tripId: string,
  checkedAt: Date
) {
  const graph = await store.getTripGraph(userId, tripId);
  const snapshots = await Promise.all(graph.legs.map((leg) =>
    store.getLatestLegSearchSnapshot(userId, tripId, leg.id)
  ));
  const selectedFlights = await Promise.all(graph.legs.map((leg) =>
    leg.selectedFlightKey
      ? store.getCanonicalFlight(leg.selectedFlightKey, checkedAt)
      : Promise.resolve(null)
  ));
  const cities = new Map(graph.cities.map((city) => [city.id, city]));

  return graph.legs.map((leg, index) => {
    const snapshot = snapshots[index] ?? null;
    const selected = selectedFlights[index] ?? null;
    const origin = cities.get(leg.originCityId);
    const destination = cities.get(leg.destinationCityId);
    return {
      legId: leg.id,
      position: leg.position,
      route: {
        origin: origin?.label ?? "Unknown origin",
        originAirports: origin?.airportCodes ?? [],
        destination: destination?.label ?? "Unknown destination",
        destinationAirports: destination?.airportCodes ?? []
      },
      departureWindow: leg.departureWindow,
      arriveBy: leg.arriveBy,
      selectedFlight: leg.selectedFlightKey
        ? flightOption(
            snapshot,
            leg.selectedFlightKey,
            null,
            checkedAt,
            selected?.flight ?? null,
            selected?.offers ?? []
          )
        : null,
      latestSearch: snapshot
        ? {
            searchId: snapshot.id,
            status: snapshot.status,
            requestedWindow: snapshot.requestedWindow,
            updatedAt: snapshot.updatedAt,
            complete: snapshot.analysis.complete,
            datesRequested: snapshot.analysis.datesRequested,
            datesCompleted: snapshot.analysis.datesCompleted,
            failedDates: snapshot.analysis.failedDates,
            optionsChecked: snapshot.analysis.optionsChecked,
            observedAt: snapshot.analysis.observedAt,
            picks: {
              cheapest: flightOption(snapshot, null, snapshot.analysis.cheapest, checkedAt),
              fastest: flightOption(snapshot, null, snapshot.analysis.fastest, checkedAt),
              balanced: flightOption(snapshot, null, snapshot.analysis.balanced, checkedAt)
            }
          }
        : null
    };
  });
}

function flightOption(
  snapshot: LegSearchSnapshot | null,
  flightKey: string | null,
  pick: LegSearchPick | null,
  checkedAt: Date,
  canonicalFlight: CanonicalFlight | null = null,
  canonicalOffers: FlightOfferSnapshot[] = []
) {
  const key = flightKey ?? pick?.flightKey;
  if (!key) return null;
  const flight = canonicalFlight
    ?? snapshot?.flights.find((candidate) => candidate.key === key)
    ?? null;
  const offers = canonicalOffers.length > 0
    ? canonicalOffers
    : snapshot?.offers.filter((candidate) => candidate.flightKey === key) ?? [];
  const offer = lowestOffer(offers);
  return {
    flightKey: key,
    departureDate: flight?.departureDate ?? pick?.departureDate ?? null,
    origin: flight?.origin ?? null,
    destination: flight?.destination ?? null,
    primaryAirlineCode: flight?.primaryAirlineCode ?? null,
    participatingAirlineCodes: flight?.participatingAirlineCodes ?? [],
    stops: flight?.stops ?? pick?.stops ?? null,
    durationMinutes: flight?.durationMinutes ?? pick?.durationMinutes ?? null,
    segments: flight?.segments ?? [],
    price: pick
      ? { amount: pick.priceAmount, currency: pick.currency }
      : offer
        ? { amount: offer.priceAmount, currency: offer.currency }
        : null,
    offer: offer
      ? {
          provider: offer.provider,
          observedAt: offer.observedAt,
          expiresAt: offer.expiresAt,
          expired: offer.expiresAt !== null && Date.parse(offer.expiresAt) <= checkedAt.getTime()
        }
      : null
  };
}

function lowestOffer(offers: FlightOfferSnapshot[]): FlightOfferSnapshot | null {
  return offers.slice().sort((left, right) => {
    const amount = Number(left.priceAmount) - Number(right.priceAmount);
    return amount || right.observedAt.localeCompare(left.observedAt);
  })[0] ?? null;
}
