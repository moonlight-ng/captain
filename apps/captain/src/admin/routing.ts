export type AdminRoute =
  | { page: "overview" }
  | { page: "conversations" }
  | { page: "conversation"; id: string }
  | { page: "costs" };

export function parseAdminRoute(pathname: string): AdminRoute {
  const match = /^\/admin\/conversations\/([^/]+)\/?$/u.exec(pathname);
  if (match?.[1]) return { page: "conversation", id: safelyDecode(match[1]) };
  if (/^\/admin\/conversations\/?$/u.test(pathname)) return { page: "conversations" };
  if (/^\/admin\/costs\/?$/u.test(pathname)) return { page: "costs" };
  return { page: "overview" };
}

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
