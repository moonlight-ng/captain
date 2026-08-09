import { useState, type FormEvent } from "react";

import { ApiError, updateTripBrief } from "../api";
import type { TripPayload } from "../domain";
import { routeLabel } from "../format";
import {
  addMultiCityLeg,
  removeMultiCityLeg,
  updateMultiCityLeg,
  type EditableTripBrief
} from "../multi-city-editor";
import { AirlineSearchSelect } from "./AirlineSearchSelect";

export function TripPlanEditor({
  trip,
  onSaved
}: {
  trip: NonNullable<TripPayload["trip"]>;
  onSaved: () => Promise<void>;
}) {
  const [brief, setBrief] = useState<EditableTripBrief>(() => ({
    ...trip.brief,
    ...(trip.brief.legs ? {
      legs: trip.brief.legs.map((leg) => ({
        ...leg,
        originAirports: [...leg.originAirports],
        destinationAirports: [...leg.destinationAirports],
        departureWindow: { ...leg.departureWindow }
      }))
    } : {}),
    context: /^Prepared from confirmed Captain trip draft\b/iu.test(trip.brief.context)
      ? ""
      : trip.brief.context
  }));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const airportCodes = (value: string) => [...new Set(
    value.toUpperCase().match(/[A-Z]{3}/gu) ?? []
  )].slice(0, 6);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      await updateTripBrief(trip.id, trip.version, brief);
      setSaved(true);
      await onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409
        ? "This trip changed elsewhere. Reload it from Telegram before editing."
        : "Captain couldn’t update this plan. Check the route and dates, then try again.");
    } finally {
      setBusy(false);
    }
  }

  const legs = brief.legs ?? [];
  return (
    <details className="settings-card settings-disclosure plan-editor" open>
      <summary>
        <span><strong>Trip plan</strong></span>
        <em>{routeLabel({ ...trip, brief })}</em>
      </summary>
      <div className="settings-body">
        <form onSubmit={(event) => void save(event)}>
          {brief.tripType === "multi_city" ? (
            <div className="multi-city-editor" aria-label="Multi-city itinerary">
              {legs.map((leg, index) => (
                <fieldset className="multi-city-leg-editor" key={index}>
                  <legend>
                    <span>Flight {index + 1}</span>
                    {legs.length > 2 ? (
                      <button
                        type="button"
                        onClick={() => setBrief(removeMultiCityLeg(brief, index))}
                      >
                        Remove
                      </button>
                    ) : null}
                  </legend>
                  <div className="form-grid two">
                    <label>
                      From
                      <input
                        value={leg.originAirports.join(", ")}
                        placeholder="LOS"
                        onChange={(event) => setBrief(updateMultiCityLeg(brief, index, {
                          originAirports: airportCodes(event.target.value)
                        }))}
                      />
                    </label>
                    <label>
                      To
                      <input
                        value={leg.destinationAirports.join(", ")}
                        placeholder="NBO"
                        onChange={(event) => setBrief(updateMultiCityLeg(brief, index, {
                          destinationAirports: airportCodes(event.target.value)
                        }))}
                      />
                    </label>
                  </div>
                  <div className="form-grid two">
                    <label>
                      Earliest departure
                      <input
                        type="date"
                        value={leg.departureWindow.start}
                        onChange={(event) => setBrief(updateMultiCityLeg(brief, index, {
                          departureWindow: {
                            ...leg.departureWindow,
                            start: event.target.value
                          }
                        }))}
                      />
                    </label>
                    <label>
                      Latest departure
                      <input
                        type="date"
                        value={leg.departureWindow.end}
                        onChange={(event) => setBrief(updateMultiCityLeg(brief, index, {
                          departureWindow: {
                            ...leg.departureWindow,
                            end: event.target.value
                          }
                        }))}
                      />
                    </label>
                  </div>
                  <label>
                    Arrive by <small>Optional</small>
                    <input
                      type="date"
                      value={leg.arriveBy ?? ""}
                      onChange={(event) => setBrief(updateMultiCityLeg(brief, index, {
                        arriveBy: event.target.value || null
                      }))}
                    />
                  </label>
                </fieldset>
              ))}
              {legs.length < 6 ? (
                <button
                  className="add-leg-button"
                  type="button"
                  onClick={() => setBrief(addMultiCityLeg(brief))}
                >
                  Add flight
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <div className="form-grid two">
                <label>
                  From
                  <input
                    value={brief.originAirports.join(", ")}
                    onChange={(event) => setBrief({
                      ...brief,
                      originAirports: airportCodes(event.target.value)
                    })}
                  />
                </label>
                <label>
                  To
                  <input
                    value={brief.destinationAirports.join(", ")}
                    onChange={(event) => setBrief({
                      ...brief,
                      destinationAirports: airportCodes(event.target.value)
                    })}
                  />
                </label>
              </div>
              <div className="form-grid two">
                <label>
                  Earliest departure
                  <input
                    type="date"
                    value={brief.departureWindow.start}
                    onChange={(event) => setBrief({
                      ...brief,
                      departureWindow: { ...brief.departureWindow, start: event.target.value }
                    })}
                  />
                </label>
                <label>
                  Latest departure
                  <input
                    type="date"
                    value={brief.departureWindow.end}
                    onChange={(event) => setBrief({
                      ...brief,
                      departureWindow: { ...brief.departureWindow, end: event.target.value }
                    })}
                  />
                </label>
              </div>
            </>
          )}

          {brief.tripType === "round_trip" && brief.stayNights ? (
            <div className="form-grid three">
              {(["minimum", "preferred", "maximum"] as const).map((key) => (
                <label key={key}>
                  {key[0]!.toUpperCase() + key.slice(1)} nights
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={brief.stayNights![key]}
                    onChange={(event) => setBrief({
                      ...brief,
                      stayNights: { ...brief.stayNights!, [key]: Number(event.target.value) }
                    })}
                  />
                </label>
              ))}
            </div>
          ) : null}

          <div className="form-grid two">
            <label>
              Cabin
              <select
                value={brief.cabin}
                onChange={(event) => setBrief({ ...brief, cabin: event.target.value })}
              >
                <option value="economy">Economy</option>
                <option value="premium_economy">Premium economy</option>
                <option value="business">Business</option>
                <option value="first">First</option>
              </select>
            </label>
            <label>
              Stops
              <select
                value={brief.maxStops}
                onChange={(event) => setBrief({ ...brief, maxStops: Number(event.target.value) })}
              >
                <option value={0}>Direct only</option>
                <option value={1}>Up to 1</option>
                <option value={2}>Up to 2</option>
              </select>
            </label>
          </div>
          <div className="form-grid two">
            <label>
              Currency
              <input
                value={brief.currency}
                maxLength={3}
                pattern="[A-Za-z]{3}"
                onChange={(event) => setBrief({
                  ...brief,
                  currency: event.target.value.toUpperCase()
                })}
              />
            </label>
            <label>
              Maximum fare
              <input
                type="number"
                min={1}
                placeholder="None"
                value={brief.maximumPrice ?? ""}
                onChange={(event) => setBrief({
                  ...brief,
                  maximumPrice: event.target.value ? Number(event.target.value) : null
                })}
              />
            </label>
          </div>
          <label>
            Preferred airlines
            <AirlineSearchSelect
              values={brief.preferredAirlines}
              placeholder="Search airlines"
              onChange={(preferredAirlines) => setBrief({ ...brief, preferredAirlines })}
            />
          </label>
          <label>
            Avoid airlines
            <AirlineSearchSelect
              values={brief.excludedAirlines}
              placeholder="Search airlines to avoid"
              onChange={(excludedAirlines) => setBrief({ ...brief, excludedAirlines })}
            />
          </label>
          <label>
            Notes
            <textarea
              value={brief.context}
              maxLength={1000}
              placeholder="Timing or airport constraints"
              onChange={(event) => setBrief({ ...brief, context: event.target.value })}
            />
          </label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="save-button" disabled={busy}>
            {busy ? "Saving…" : saved ? "Plan updated" : "Update plan"}
          </button>
        </form>
      </div>
    </details>
  );
}
