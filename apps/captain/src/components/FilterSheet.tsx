import type { Dispatch, ReactNode, SetStateAction } from "react";

import {
  EMPTY_BROWSE_PREFERENCES,
  offerAirports,
  offerDeparture,
  sortAndFilterOffers,
  type BrowsePreferences,
  type VerifiedOffer
} from "../domain";
import { airlineName } from "../format";
import { CloseIcon } from "./icons";

export function FilterSheet({
  open,
  preferences,
  offers,
  onPreferences,
  onClose,
  onApply
}: {
  open: boolean;
  preferences: BrowsePreferences;
  offers: VerifiedOffer[];
  onPreferences: Dispatch<SetStateAction<BrowsePreferences>>;
  onClose: () => void;
  onApply: () => void;
}) {
  const airlines = [...new Set(offers.map((offer) => offer.primaryAirlineCode))].sort();
  const airports = [...new Set(offers.flatMap(offerAirports))].sort();
  const hasDepartures = offers.some((offer) => offerDeparture(offer));
  const matches = sortAndFilterOffers(offers, preferences).length;
  function update<Key extends keyof BrowsePreferences>(key: Key, value: BrowsePreferences[Key]) {
    onPreferences((current) => ({ ...current, [key]: value }));
  }
  return (
    <div
      className="sheet-backdrop"
      data-open={open}
      aria-hidden={!open}
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="bottom-sheet filter-sheet"
        role="dialog"
        aria-modal={open}
        aria-label="Sort and filter flights"
      >
        <header>
          <span>
            <strong>Sort &amp; filter</strong>
            <small>{matches} matching flight{matches === 1 ? "" : "s"}</small>
          </span>
          <button className="icon-button" aria-label="Close filters" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="sheet-scroll">
          <FilterGroup label="Sort">
            <select
              value={preferences.sort}
              onChange={(event) => update("sort", event.target.value as BrowsePreferences["sort"])}
            >
              <option value="recommended">Recommended</option>
              <option value="price">Lowest price</option>
              <option value="duration">Shortest duration</option>
              <option value="departure">Earliest departure</option>
            </select>
          </FilterGroup>
          <FilterGroup label="Stops">
            <div className="filter-choice-row">
              {[0, 1, 2].map((stops) => (
                <button
                  className={preferences.stops.includes(stops) ? "selected" : ""}
                  key={stops}
                  onClick={() => update("stops", toggle(preferences.stops, stops))}
                >
                  {stops === 0 ? "Direct" : `${stops} stop${stops === 1 ? "" : "s"}`}
                </button>
              ))}
            </div>
          </FilterGroup>
          {airlines.length > 0 && (
            <FilterGroup label="Airlines">
              <div className="filter-choice-row wrap">
                {airlines.map((airline) => (
                  <button
                    className={preferences.airlines.includes(airline) ? "selected" : ""}
                    key={airline}
                    onClick={() => update("airlines", toggle(preferences.airlines, airline))}
                  >
                    {airlineName(airline, offers)}
                  </button>
                ))}
              </div>
            </FilterGroup>
          )}
          {airports.length > 0 && (
            <FilterGroup label="Airports">
              <div className="filter-choice-row wrap">
                {airports.map((airport) => (
                  <button
                    className={preferences.airports.includes(airport) ? "selected" : ""}
                    key={airport}
                    onClick={() => update("airports", toggle(preferences.airports, airport))}
                  >
                    {airport}
                  </button>
                ))}
              </div>
            </FilterGroup>
          )}
          {hasDepartures && (
            <FilterGroup label="Departure">
              <div className="filter-choice-row">
                {(["morning", "afternoon", "evening"] as const).map((period) => (
                  <button
                    className={preferences.departurePeriods.includes(period) ? "selected" : ""}
                    key={period}
                    onClick={() => update("departurePeriods", toggle(preferences.departurePeriods, period))}
                  >
                    {period[0]!.toUpperCase() + period.slice(1)}
                  </button>
                ))}
              </div>
            </FilterGroup>
          )}
          <FilterGroup label="Maximum price">
            <input
              className="sheet-input"
              type="number"
              min={1}
              value={preferences.maximumPrice ?? ""}
              placeholder="No maximum"
              onChange={(event) => update(
                "maximumPrice",
                event.target.value ? Number(event.target.value) : null
              )}
            />
          </FilterGroup>
        </div>
        <footer>
          <button className="secondary-action" onClick={() => onPreferences(EMPTY_BROWSE_PREFERENCES)}>
            Reset
          </button>
          <button className="primary-action" onClick={onApply}>
            Show {matches}
          </button>
        </footer>
      </section>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div className="filter-group"><strong>{label}</strong>{children}</div>;
}

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}
