/** Credential kinds returned by CaptainWebAuth.resolve. */
export type AuthCredentialKind = "session" | "legacy-bearer";

export type ResolvedAuth = {
  userId: string;
  credential: AuthCredentialKind;
};

/**
 * Runtime allowlist for legacy `#access` bearer tokens.
 * Same function gates real requests and tests — unknown/new routes default to session-only.
 */
export function legacyBearerAllowed(method: string, pathname: string): boolean {
  const normalized = method.toUpperCase();
  if (pathname === "/api/auth/session" && normalized === "GET") return true;
  if (pathname === "/api/me/profile" && (normalized === "GET" || normalized === "PATCH")) return true;
  if (pathname === "/api/me/facts" && normalized === "GET") return true;
  if (pathname === "/api/me/trip" && (normalized === "GET" || normalized === "PATCH")) return true;
  if (pathname === "/api/me/trip/actions" && normalized === "POST") return true;
  if (pathname === "/api/me/trip/selections" && normalized === "POST") return true;
  if (
    normalized === "POST"
    && /^\/api\/me\/trip\/legs\/[^/]+\/searches$/u.test(pathname)
  ) return true;
  if (
    normalized === "GET"
    && /^\/api\/me\/trip\/legs\/[^/]+\/searches\/[^/]+$/u.test(pathname)
  ) return true;
  if (
    normalized === "POST"
    && /^\/api\/me\/trip\/legs\/[^/]+\/selection$/u.test(pathname)
  ) return true;
  return false;
}
