import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type CaptainAdminIdentity = {
  id: string;
  email: string;
};

export class CaptainAdminAuth {
  readonly #url: string | null;
  readonly #publishableKey: string | null;
  readonly #allowedEmails: Set<string>;
  readonly #client: SupabaseClient | null;

  constructor(options: {
    url: string | null;
    publishableKey: string | null;
    allowedEmails: string[];
    client?: SupabaseClient;
  }) {
    this.#url = options.url;
    this.#publishableKey = options.publishableKey;
    this.#allowedEmails = new Set(options.allowedEmails.map((email) => email.toLowerCase()));
    this.#client = options.client ?? (options.url && options.publishableKey
      ? createClient(options.url, options.publishableKey, {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
          }
        })
      : null);
  }

  publicConfig(): { supabaseUrl: string; supabasePublishableKey: string } | null {
    if (!this.#url || !this.#publishableKey || this.#allowedEmails.size === 0) return null;
    return {
      supabaseUrl: this.#url,
      supabasePublishableKey: this.#publishableKey
    };
  }

  async authenticate(request: Request): Promise<
    | { status: "authenticated"; identity: CaptainAdminIdentity }
    | { status: "unauthorized" }
    | { status: "forbidden" }
    | { status: "unconfigured" }
  > {
    if (!this.#client || this.#allowedEmails.size === 0) return { status: "unconfigured" };
    const token = /^Bearer\s+(\S+)$/iu.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return { status: "unauthorized" };
    try {
      const { data, error } = await this.#client.auth.getUser(token);
      const email = data.user?.email?.trim().toLowerCase();
      if (error || !data.user || !email) return { status: "unauthorized" };
      if (!this.#allowedEmails.has(email)) return { status: "forbidden" };
      return { status: "authenticated", identity: { id: data.user.id, email } };
    } catch {
      return { status: "unauthorized" };
    }
  }
}
