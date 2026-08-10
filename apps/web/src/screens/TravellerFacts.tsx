import { useEffect, useState } from "react";

import { dismissTravellerFact, listTravellerFacts } from "../api";
import type { TravellerFact } from "../domain";
import { label } from "../format";

/**
 * What Captain has learned about this traveller across trips. Each fact
 * carries the quote that produced it, and dismissing one is permanent for
 * that evidence — Captain will not re-learn the same sentence.
 */
export function TravellerFacts() {
  const [facts, setFacts] = useState<TravellerFact[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listTravellerFacts()
      .then((next) => {
        if (!cancelled) setFacts(next);
      })
      .catch(() => {
        if (!cancelled) setError("Captain couldn’t load what it remembers.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function dismiss(factId: string) {
    setBusyId(factId);
    setError("");
    try {
      await dismissTravellerFact(factId);
      setFacts((current) => (current ?? []).filter((fact) => fact.id !== factId));
    } catch {
      setError("Captain couldn’t forget that. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  const count = facts?.length ?? 0;

  return (
    <details className="settings-card settings-disclosure" open={count > 0}>
      <summary>
        <span><strong>What Captain remembers</strong></span>
        <em>{count === 0 ? "Nothing yet" : `${count} fact${count === 1 ? "" : "s"}`}</em>
      </summary>
      <div className="settings-body">
        <p>
          Things Captain learned from your chats — home airport, cabin habits,
          airlines you avoid. Each one keeps the words you used. Forget any that
          are wrong or out of date.
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {facts === null && !error ? <p>Loading…</p> : null}
        {facts && facts.length === 0 ? (
          <p>Nothing durable yet. Preferences above still apply.</p>
        ) : null}
        {facts && facts.length > 0 ? (
          <ul className="traveller-facts-list">
            {facts.map((fact) => (
              <li key={fact.id}>
                <div>
                  <strong>{label(fact.kind)}</strong>
                  <span>{fact.value}</span>
                  <small>“{fact.evidence}”</small>
                </div>
                <button
                  type="button"
                  disabled={busyId === fact.id}
                  onClick={() => void dismiss(fact.id)}
                >
                  {busyId === fact.id ? "Forgetting…" : "Forget"}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}
