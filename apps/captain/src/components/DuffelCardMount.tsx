import { useEffect, useId, useRef, useState } from "react";
import { DuffelCardForm, useDuffelCardFormActions } from "@duffel/components";

import { ApiError, createPaymentClientKey, savePaymentMethod } from "../api";

const SETUP_INTENT_STORAGE_KEY = "captain:payment-setup-intent";

type PendingCard = {
  cardId: string;
  brand: string;
  last4: string;
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function readStoredSetupIntentId(): string | null {
  try {
    const value = sessionStorage.getItem(SETUP_INTENT_STORAGE_KEY)?.trim() ?? "";
    return isUuid(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredSetupIntentId(setupIntentId: string): void {
  try {
    sessionStorage.setItem(SETUP_INTENT_STORAGE_KEY, setupIntentId);
  } catch {
    // Private mode / quota — remounts without storage hit setup_in_progress until expiry.
  }
}

function clearStoredSetupIntentId(): void {
  try {
    sessionStorage.removeItem(SETUP_INTENT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function allocateSetupIntentId(): string {
  const existing = readStoredSetupIntentId();
  if (existing) return existing;
  const created = crypto.randomUUID();
  writeStoredSetupIntentId(created);
  return created;
}

export default function DuffelCardMount({
  onSaved,
  onError
}: {
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { ref, saveCard } = useDuffelCardFormActions();
  const setupIntentIdRef = useRef(allocateSetupIntentId());
  const initGeneration = useRef(0);
  const [clientKey, setClientKey] = useState<string | null>(null);
  const [cardholderName, setCardholderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [keyError, setKeyError] = useState("");
  const [pendingCard, setPendingCard] = useState<PendingCard | null>(null);
  const formId = useId();

  async function loadClientKey(rotateCompletedIntent = true) {
    const generation = ++initGeneration.current;
    setKeyError("");
    setClientKey(null);
    try {
      writeStoredSetupIntentId(setupIntentIdRef.current);
      const result = await createPaymentClientKey(setupIntentIdRef.current);
      if (generation !== initGeneration.current) return;
      setupIntentIdRef.current = result.setupIntentId;
      writeStoredSetupIntentId(result.setupIntentId);
      setClientKey(result.clientKey);
    } catch (cause) {
      if (generation !== initGeneration.current) return;
      const code = cause instanceof ApiError ? cause.message : "";
      if (rotateCompletedIntent && code === "setup_intent_completed") {
        clearStoredSetupIntentId();
        setupIntentIdRef.current = allocateSetupIntentId();
        await loadClientKey(false);
        return;
      }
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
        setupIntentId: setupIntentIdRef.current,
        cardId: card.cardId,
        brand: card.brand,
        last4: card.last4,
        cardholderName: name
      });
      clearStoredSetupIntentId();
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
              "border-color": "rgba(255, 255, 255, .22)"
            }
          },
          sectionTitle: { color: "var(--ink)" }
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
