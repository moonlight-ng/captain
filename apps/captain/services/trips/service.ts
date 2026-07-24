import {
  buildSearchSpecs,
  createTripSchema,
  tripActionSchema,
  updateTripSchema,
  type CreateTripInput,
  type TripAction,
  type UpdateTripInput
} from "@agents/flight-domain";
import type { CaptainPlatformStore } from "@agents/flight-store";

export class TripService {
  readonly #store: CaptainPlatformStore;
  readonly #liveMode: boolean;
  readonly #now: () => Date;

  constructor(options: { store: CaptainPlatformStore; liveMode: boolean; now?: () => Date }) {
    this.#store = options.store;
    this.#liveMode = options.liveMode;
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
    const specs = buildSearchSpecs(input.brief, this.#liveMode);
    const created = await this.#store.createTrip(userId, input, specs, this.#now());
    return { ...created, searchCombinations: specs.length };
  }

  async update(userId: string, tripId: string, value: UpdateTripInput) {
    const input = updateTripSchema.parse(value);
    const specs = input.brief ? buildSearchSpecs(input.brief, this.#liveMode) : null;
    return this.#store.updateTrip(userId, tripId, input, specs, this.#now());
  }

  action(userId: string, tripId: string, value: TripAction) {
    return this.#store.applyTripAction(userId, tripId, tripActionSchema.parse(value), this.#now());
  }

  offers(userId: string, tripId: string) {
    return this.#store.listTripOffers(userId, tripId, this.#now());
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
