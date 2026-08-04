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

  return (
    <section className="invoices-tab-view">
      <div className="profile-section-heading">
        <div>
          <p className="eyebrow">Invoices</p>
          <h1>Payment history</h1>
          <p>Receipts and refunds will appear here after live booking is enabled.</p>
        </div>
      </div>

      {loading ? (
        <section className="profile-empty-state"><p>Loading invoices…</p></section>
      ) : error ? (
        <section className="profile-empty-state form-error" role="alert">{error}</section>
      ) : invoices.length === 0 ? (
        <section className="invoice-empty-state">
          <span className="invoice-empty-icon" aria-hidden="true">≡</span>
          <h2>No invoices yet</h2>
          <p>Mock bookings do not create charges, receipts, or refunds.</p>
        </section>
      ) : (
        <div className="invoice-list">
          {invoices.map((invoice) => (
            <article key={invoice.id}>
              <span>
                <strong>{invoice.reference}</strong>
                <small>{formatDate(invoice.createdAt)}</small>
              </span>
              <span className="invoice-amount">
                <strong>{formatMoney(invoice.amount, invoice.currency)}</strong>
                <small>{invoice.status}</small>
              </span>
            </article>
          ))}
        </div>
      )}
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
