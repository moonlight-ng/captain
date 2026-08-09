const MOCK_ACCESS = "design";

/** True when Vite is proxying `/api` at a remote (non-loopback) Captain. */
function isRemoteApiProxy(): boolean {
  const target = String(import.meta.env.VITE_CAPTAIN_API_PROXY_TARGET ?? "").trim();
  if (!target) return false;
  try {
    const host = new URL(target).hostname;
    return host !== "127.0.0.1" && host !== "localhost";
  } catch {
    return false;
  }
}

/** Local design / prototype mode (`#access=design`). */
export function isMockMode(): boolean {
  const hash = new URLSearchParams(window.location.hash.slice(1)).get("access")?.trim();
  if (hash === MOCK_ACCESS) return true;
  // Do not treat a bare local URL as mock when `/api` is pointed at production.
  if (isRemoteApiProxy()) return false;
  // Vite local proxy runs against the design mock API.
  return import.meta.env.DEV && !hash;
}

/**
 * In local Vite, force `#access=design` so the whole app stays on the mock API
 * without needing a Telegram login link. Skipped when the API proxy targets a
 * remote Captain — that needs a real Telegram access hash or session cookie.
 */
export function ensureMockAccess(): boolean {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const current = hashParams.get("access")?.trim();
  if (!import.meta.env.DEV || isRemoteApiProxy()) {
    return current === MOCK_ACCESS;
  }
  if (current === MOCK_ACCESS) return true;
  if (current) return false;
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  hash.set("access", MOCK_ACCESS);
  url.hash = hash.toString();
  window.history.replaceState(null, "", url.toString());
  return true;
}
