import { localDev, verifyHttpBasic, type AuthFn } from "eve/channels/auth";
import { defaultEveAuth, eveChannel } from "eve/channels/eve";

import { loadEnv } from "../../services/app/env.js";

const local = localDev();
const localAuth: AuthFn<Request> = (request) =>
  process.env.NODE_ENV === "production" ? null : local(request);

const ownerAuth: AuthFn<Request> = (request) => {
  const env = loadEnv();
  if (!env.basicPassword) return null;
  const result = verifyHttpBasic(request.headers.get("authorization"), {
    username: env.basicUsername,
    password: env.basicPassword
  });
  if (!result.ok) return null;
  return result.sessionAuth;
};

export default eveChannel({
  auth: [localAuth, ownerAuth],
  uploadPolicy: "disabled",
  onMessage(context) {
    return defaultEveAuth(context) ? { auth: defaultEveAuth(context)! } : null;
  }
});
