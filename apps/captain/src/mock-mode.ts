const MOCK_ACCESS = "design";

/** Local design / prototype mode (`#access=design`). */
export function isMockMode(): boolean {
  const hash = new URLSearchParams(window.location.hash.slice(1)).get("access")?.trim();
  if (hash === MOCK_ACCESS) return true;
  // Vite local proxy runs against the design mock API.
  return import.meta.env.DEV && (hash === MOCK_ACCESS || !hash);
}

/**
 * In local Vite, force `#access=design` so the whole app stays on the mock API
 * without needing a Telegram login link.
 */
export function ensureMockAccess(): boolean {
  if (!import.meta.env.DEV) {
    return new URLSearchParams(window.location.hash.slice(1)).get("access")?.trim() === MOCK_ACCESS;
  }
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const current = hash.get("access")?.trim();
  if (current === MOCK_ACCESS) return true;
  if (current) return false;
  hash.set("access", MOCK_ACCESS);
  url.hash = hash.toString();
  window.history.replaceState(null, "", url.toString());
  return true;
}
