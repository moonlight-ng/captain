import { useEffect, useId, useRef, useState } from "react";
import { DuffelCardForm, useDuffelCardFormActions } from "@duffel/components";

import { ApiError, createPaymentClientKey, savePaymentMethod } from "../api";

type PendingCard = {
  cardId: string;
  brand: string;
  last4: string;
};

export default function DuffelCardMount({
  onSaved,
  onError
}: {
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { ref, saveCard } = useDuffelCardFormActions();
  const setupIntentId = useRef(crypto.randomUUID()).current;
  const initGeneration = useRef(0);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const [cardholderName, setCardholderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [keyError, setKeyError] = useState("");
  const [pendingCard, setPendingCard] = useState<PendingCard | null>(null);
  const formId = useId();

  async function loadClientKey() {
    const generation = ++initGeneration.current;
    setKeyError("");
    setClientKey(null);
    try {
      const result = await createPaymentClientKey(setupIntentId);
      if (generation !== initGeneration.current) return;
      setClientKey(result.clientKey);
    } catch (cause) {
      if (generation !== initGeneration.current) return;
      const message = cause instanceof ApiError ? cause.message : "Could not start card form.";
      setKeyError(message);
      onError(message);
    }
  }

  useEffect(() => {
    void loadClientKey();
    return () => {
      initGeneration.current += 1;
    };
  }, []);

  async function finalize(card: PendingCard, name: string) {
    setBusy(true);
    setLocalError("");
    try {
      await savePaymentMethod({
        setupIntentId,
        cardId: card.cardId,
        brand: card.brand,
        last4: card.last4,
        cardholderName: name
      });
      setPendingCard(null);
      await onSaved();
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : "Could not save card.";
      setLocalError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  if (keyError) {
    return (
      <div className="card-form">
        <p className="form-error" role="alert">{keyError}</p>
        <button type="button" className="save-button" onClick={() => void loadClientKey()}>
          Retry
        </button>
      </div>
    );
  }

  if (!clientKey) return <p>Preparing secure card form…</p>;

  return (
    <div className="card-form" id={formId}>
      <label>
        Cardholder name
        <input
          required
          value={cardholderName}
          onChange={(event) => setCardholderName(event.target.value)}
        />
      </label>
      <DuffelCardForm
        ref={ref}
        clientKey={clientKey}
        intent="to-save-card"
        styles={{
          label: { color: "var(--ink)", "font-size": "var(--type-body)" },
          input: {
            default: {
              color: "var(--ink)",
              "border-radius": "var(--radius-card, 11px)",
              "border-color": "rgba(167, 196, 154, .34)"
            }
          },
          sectionTitle: { color: "var(--green, #a7c49a)" }
        }}
        onSaveCardSuccess={(data) => {
          const card: PendingCard = {
            cardId: data.id,
            brand: data.brand,
            last4: data.last_4_digits
          };
          setPendingCard(card);
          void finalize(card, cardholderName.trim() || "Cardholder");
        }}
        onSaveCardFailure={(error) => {
          setLocalError(error.message || "Card could not be saved.");
          onError(error.message || "Card could not be saved.");
        }}
      />
      {localError && <p className="form-error" role="alert">{localError}</p>}
      <button
        type="button"
        className="save-button"
        disabled={busy || !cardholderName.trim()}
        onClick={() => {
          if (pendingCard) {
            void finalize(pendingCard, cardholderName.trim());
            return;
          }
          saveCard();
        }}
      >
        {busy ? "Saving…" : pendingCard ? "Retry save" : "Save card"}
      </button>
    </div>
  );
}
