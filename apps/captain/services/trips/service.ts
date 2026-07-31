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
    return this.#store.applyTripAction(userId, tripId, action, this.#now());
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
