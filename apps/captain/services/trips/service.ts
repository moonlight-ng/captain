import {
  buildSearchSpecs,
  createTripSchema,
  tripActionSchema,
  updateTripBriefSchema,
  type CreateTripInput,
  type TripAction,
  type UpdateTripBrief
} from "@agents/flight-domain";
import type { CaptainPlatformStore } from "@agents/flight-store";

const MANUAL_REFRESH_INTERVAL_MS = 6 * 3_600_000;

export class ManualRefreshLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Manual refresh is available again in ${retryAfterSeconds} seconds`);
    this.name = "ManualRefreshLimitError";
  }
}

export class TripService {
  readonly #store: CaptainPlatformStore;
  readonly #now: () => Date;

  constructor(options: { store: CaptainPlatformStore; now?: () => Date }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  list(userId: string) {
    return this.#store.listTrips(userId);
  }

  get(userId: string, tripId: string) {
    return this.#store.getTrip(userId, tripId);
  }

  async create(userId: string, value: CreateTripInput) {
    const input = createTripSchema.parse(value);
    const specs = buildSearchSpecs(input.brief);
    const created = await this.#store.createTrip(userId, input, specs, this.#now());
    return { ...created, searchCombinations: specs.length };
  }

  async action(userId: string, tripId: string, value: TripAction) {
    const action = tripActionSchema.parse(value);
    const now = this.#now();
    if (action.type === "refresh") {
      const watch = await this.#store.getWatch(userId, tripId);
      const lastManualRefresh = watch?.lastManualRefreshAt
        ? Date.parse(watch.lastManualRefreshAt)
        : 0;
      const remaining = lastManualRefresh + MANUAL_REFRESH_INTERVAL_MS - now.getTime();
      if (remaining > 0) {
        throw new ManualRefreshLimitError(Math.ceil(remaining / 1_000));
      }
    }
    return this.#store.applyTripAction(userId, tripId, action, now);
  }

  async update(userId: string, tripId: string, value: UpdateTripBrief) {
    const input = updateTripBriefSchema.parse(value);
    const specs = buildSearchSpecs(input.brief);
    return this.#store.updateTripBrief(userId, tripId, input, specs, this.#now());
  }

  async offers(userId: string, tripId: string) {
    const now = this.#now();
    const [trip, offers, profile] = await Promise.all([
      this.#store.getTrip(userId, tripId),
      this.#store.listTripOffers(userId, tripId, now),
      this.#store.ensureProfile(userId, now)
    ]);
    const excluded = new Set([
      ...profile.excludedAirlineCodes,
      ...(trip?.brief.excludedAirlines ?? [])
    ]);
    return offers.filter((offer) =>
      !offer.participatingAirlineCodes.some((airline) => excluded.has(airline))
    );
  }

  selections(userId: string, tripId: string) {
    return this.#store.listTripFlightSelections(userId, tripId);
  }

  async selectFlight(userId: string, tripId: string, itineraryKey: string, selected = true) {
    const trip = await this.#store.getTrip(userId, tripId);
    if (!trip) return null;
    await this.#store.setTripFlightSelection(userId, tripId, itineraryKey.trim(), selected, this.#now());
    return {
      tripId,
      itineraryKey: itineraryKey.trim(),
      selected
    };
  }
}
