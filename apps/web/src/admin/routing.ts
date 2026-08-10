export type AdminRoute =
  | { page: "overview" }
  | { page: "conversations" }
  | { page: "conversation"; id: string }
  | { page: "trips" }
  | { page: "trip"; id: string }
  | { page: "costs" }
  | { page: "settings" };

export function parseAdminRoute(pathname: string): AdminRoute {
  const conversation = /^\/admin\/conversations\/([^/]+)\/?$/u.exec(pathname);
  if (conversation?.[1]) return { page: "conversation", id: safelyDecode(conversation[1]) };
  if (/^\/admin\/conversations\/?$/u.test(pathname)) return { page: "conversations" };
  const trip = /^\/admin\/trips\/([^/]+)\/?$/u.exec(pathname);
  if (trip?.[1]) return { page: "trip", id: safelyDecode(trip[1]) };
  if (/^\/admin\/trips\/?$/u.test(pathname)) return { page: "trips" };
  if (/^\/admin\/costs\/?$/u.test(pathname)) return { page: "costs" };
  if (/^\/admin\/settings\/?$/u.test(pathname)) return { page: "settings" };
  return { page: "overview" };
}

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
