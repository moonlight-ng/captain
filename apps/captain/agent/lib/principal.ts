import type { DynamicResolveContext } from "eve";
import type { ToolContext } from "eve/tools";

type SessionAuth = DynamicResolveContext["session"]["auth"];

export function captainUserId(auth: SessionAuth): string | null {
  const current = auth.current ?? auth.initiator;
  if (!current || current.attributes.captain_principal !== "traveller") return null;
  const value = current.attributes.captain_user_id;
  const userId = Array.isArray(value) ? value[0] : value;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

export function requireCaptainUser(ctx: Pick<ToolContext, "session">): string {
  const userId = captainUserId(ctx.session.auth);
  if (!userId) throw new Error("This tool requires an authenticated Captain traveller");
  return userId;
}
