import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

import type {
  AdminAutomationPage,
  AdminConversationDetail,
  AdminConversationPage,
  AdminCostRange,
  AdminCostReport,
  AdminOverview,
  AdminTripDetail,
  AdminTripPage
} from "@agents/flight-domain/admin";

type PublicAdminConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
};

export class AdminApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export function loadErrorCopy(error: unknown): { title: string; body: string } {
  if (error instanceof AdminApiError) {
    if (error.status === 401) {
      return { title: "Production data couldn’t be loaded.", body: "Your session may have expired." };
    }
    if (error.status === 403) {
      return { title: "This account isn’t allowed.", body: "Your identity is valid, but it is not on Captain’s administrator allowlist." };
    }
    if (error.status === 404) {
      return {
        title: "That production record isn’t available.",
        body: "It may have been removed, or this Captain server may not have the requested API yet."
      };
    }
    return {
      title: "Production data couldn’t be loaded.",
      body: `The server returned ${error.status}${error.code ? ` (${error.code})` : ""}.`
    };
  }
  return {
    title: "Production data couldn’t be loaded.",
    body: "Captain couldn’t reach the production API. Check the connection and try again."
  };
}

export class AdminApi {
  readonly supabase: SupabaseClient;

  private constructor(config: PublicAdminConfig) {
    this.supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }

  static async connect(): Promise<AdminApi> {
    const response = await fetch("/api/admin/config", { cache: "no-store" });
    if (!response.ok) throw await apiError(response);
    return new AdminApi(await response.json() as PublicAdminConfig);
  }

  async session(): Promise<Session | null> {
    const { data } = await this.supabase.auth.getSession();
    return data.session;
  }

  async sendMagicLink(email: string): Promise<void> {
    const redirect = new URL("/admin", window.location.origin).toString();
    await this.supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: redirect }
    });
  }

  async signOut(): Promise<void> {
    await this.supabase.auth.signOut();
  }

  async verifySession(): Promise<{ id: string; email: string }> {
    const payload = await this.#get<{ identity: { id: string; email: string } }>("/api/admin/session");
    return payload.identity;
  }

  overview(): Promise<AdminOverview> {
    return this.#get("/api/admin/overview");
  }

  conversations(input: {
    query?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<AdminConversationPage> {
    const search = new URLSearchParams();
    if (input.query) search.set("query", input.query);
    if (input.cursor) search.set("cursor", input.cursor);
    if (input.limit) search.set("limit", String(input.limit));
    return this.#get(`/api/admin/conversations?${search}`);
  }

  conversation(id: string, before?: string): Promise<AdminConversationDetail> {
    const search = new URLSearchParams({ limit: "50" });
    if (before) search.set("before", before);
    return this.#get(`/api/admin/conversations/${encodeURIComponent(id)}?${search}`);
  }

  automations(input: {
    query?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<AdminAutomationPage> {
    const search = new URLSearchParams();
    if (input.query) search.set("query", input.query);
    if (input.cursor) search.set("cursor", input.cursor);
    if (input.limit) search.set("limit", String(input.limit));
    return this.#get(`/api/admin/automations?${search}`);
  }

  trips(input: {
    query?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<AdminTripPage> {
    const search = new URLSearchParams();
    if (input.query) search.set("query", input.query);
    if (input.cursor) search.set("cursor", input.cursor);
    if (input.limit) search.set("limit", String(input.limit));
    return this.#get(`/api/admin/trips?${search}`);
  }

  trip(id: string): Promise<AdminTripDetail> {
    return this.#get(`/api/admin/trips/${encodeURIComponent(id)}`);
  }

  costs(range: AdminCostRange): Promise<AdminCostReport> {
    return this.#get(`/api/admin/costs?range=${range}`);
  }

  async #get<T>(path: string): Promise<T> {
    const session = await this.session();
    if (!session?.access_token) throw new AdminApiError(401, "session_expired");
    const response = await fetch(path, {
      cache: "no-store",
      headers: { authorization: `Bearer ${session.access_token}` }
    });
    if (!response.ok) {
      const error = await apiError(response);
      if (error.status === 401) await this.supabase.auth.signOut({ scope: "local" });
      throw error;
    }
    return response.json() as Promise<T>;
  }
}

async function apiError(response: Response): Promise<AdminApiError> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  const code = typeof body?.error === "string" ? body.error : "request_failed";
  return new AdminApiError(response.status, code);
}
