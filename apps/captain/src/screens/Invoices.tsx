import { useEffect, useState } from "react";

import { ApiError, listInvoices } from "../api";
import type { Invoice } from "../domain";

export function Invoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        setInvoices(await listInvoices());
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : "Could not load invoices.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <p className="settings-card set-note">Loading invoices…</p>;
  if (error) return <p className="settings-card form-error" role="alert">{error}</p>;

  if (invoices.length === 0) {
    return (
      <section className="settings-card">
        <p className="set-note">No invoices yet</p>
      </section>
    );
  }

  return (
    <section className="settings-card">
      <div className="invoice-list">
        {invoices.map((invoice) => (
          <article key={invoice.id} className="entity-row">
            <span>
              <strong>{invoice.reference}</strong>
              <div className="set-note">{formatDate(invoice.createdAt)}</div>
            </span>
            <span>
              <strong>{formatMoney(invoice.amount, invoice.currency)}</strong>
              <div className="set-note">{invoice.status}</div>
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(value));
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount);
}
