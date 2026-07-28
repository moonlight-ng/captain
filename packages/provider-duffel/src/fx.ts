export const SUPPORTED_FX_CURRENCIES = ["USD", "GBP"] as const;
export type SupportedFxCurrency = (typeof SUPPORTED_FX_CURRENCIES)[number];

export type FxQuote = {
  from: string;
  to: string;
  rate: number;
  asOf: string;
  provider: "identity" | "open_er_api";
};

export class FxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxError";
  }
}

type RateTable = {
  base: string;
  rates: Record<string, number>;
  asOf: string;
};

const cache = new Map<string, { table: RateTable; expiresAt: number }>();
const CACHE_MS = 60 * 60 * 1_000;

export function isSupportedFxCurrency(currency: string): currency is SupportedFxCurrency {
  return (SUPPORTED_FX_CURRENCIES as readonly string[]).includes(currency.trim().toUpperCase());
}

export async function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  options: { fetch?: typeof fetch } = {}
): Promise<{ amount: number; quote: FxQuote }> {
  const from = fromCurrency.trim().toUpperCase();
  const to = toCurrency.trim().toUpperCase();
  if (!Number.isFinite(amount) || amount < 0) throw new FxError("Amount must be a non-negative number");
  if (!isSupportedFxCurrency(from) || !isSupportedFxCurrency(to)) {
    throw new FxError(`Captain currently converts only between USD and GBP (got ${from} → ${to})`);
  }
  if (from === to) {
    return {
      amount: roundMoney(amount),
      quote: { from, to, rate: 1, asOf: new Date().toISOString().slice(0, 10), provider: "identity" }
    };
  }
  const table = await loadRates(from, options.fetch ?? fetch);
  const rate = table.rates[to];
  if (!rate || !Number.isFinite(rate) || rate <= 0) {
    throw new FxError(`No FX rate from ${from} to ${to}`);
  }
  return {
    amount: roundMoney(amount * rate),
    quote: { from, to, rate, asOf: table.asOf, provider: "open_er_api" }
  };
}

async function loadRates(base: string, fetchImpl: typeof fetch): Promise<RateTable> {
  const cached = cache.get(base);
  if (cached && cached.expiresAt > Date.now()) return cached.table;
  const response = await fetchImpl(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new FxError(`FX provider returned HTTP ${response.status}`);
  const body = await response.json() as {
    result?: string;
    base_code?: string;
    time_last_update_utc?: string;
    rates?: Record<string, number>;
  };
  if (body.result !== "success" || !body.rates || !body.base_code) {
    throw new FxError("FX provider returned an invalid payload");
  }
  const table: RateTable = {
    base: body.base_code.toUpperCase(),
    rates: Object.fromEntries(
      Object.entries(body.rates).map(([code, value]) => [code.toUpperCase(), Number(value)])
    ),
    asOf: (body.time_last_update_utc ?? new Date().toISOString()).slice(0, 10)
  };
  cache.set(base, { table, expiresAt: Date.now() + CACHE_MS });
  return table;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Test helper */
export function clearFxCache(): void {
  cache.clear();
}
