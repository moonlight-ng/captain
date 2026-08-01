import { useEffect, useState } from "react";
import { DuffelCardForm, useDuffelCardFormActions } from "@duffel/components";

import { ApiError, createPaymentClientKey, savePaymentMethod } from "../api";

export default function DuffelCardMount({
  onSaved,
  onError
}: {
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { ref, saveCard } = useDuffelCardFormActions();
  const [clientKey, setClientKey] = useState<string | null>(null);
  const [cardholderName, setCardholderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setClientKey(await createPaymentClientKey());
      } catch (cause) {
        onError(cause instanceof ApiError ? cause.message : "Could not start card form.");
      }
    })();
  }, [onError]);

  if (!clientKey) return <p>Preparing secure card form…</p>;

  return (
    <div className="card-form">
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
          void (async () => {
            setBusy(true);
            setLocalError("");
            try {
              const expiry = data as typeof data & {
                expiry_month?: number;
                expiry_year?: number;
              };
              await savePaymentMethod({
                cardId: data.id,
                brand: data.brand,
                last4: data.last_4_digits,
                expiryMonth: expiry.expiry_month ?? 12,
                expiryYear: expiry.expiry_year ?? 2099,
                cardholderName: cardholderName.trim() || "Cardholder"
              });
              await onSaved();
            } catch (cause) {
              const message = cause instanceof ApiError ? cause.message : "Could not save card.";
              setLocalError(message);
              onError(message);
            } finally {
              setBusy(false);
            }
          })();
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
        onClick={() => saveCard()}
      >
        {busy ? "Saving…" : "Save card"}
      </button>
    </div>
  );
}
