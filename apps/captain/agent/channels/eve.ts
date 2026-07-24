import { localDev, verifyHttpBasic, type AuthFn } from "eve/channels/auth";
import { defaultEveAuth, eveChannel } from "eve/channels/eve";

import { loadEnv } from "../../services/app/env.js";
import { getCaptainServices } from "../../services/app/services.js";

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
  async onMessage(context) {
    const auth = defaultEveAuth(context);
    if (!auth) return null;
    if (process.env.NODE_ENV === "production") return { auth };
    const services = await getCaptainServices();
    const user = await services.platformStore.ensureTelegramUser({
      telegramUserId: 9_000_000_001,
      telegramChatId: 9_000_000_001,
      username: "captain_local_eval",
      firstName: "Local",
      lastName: "Traveller"
    }, new Date());
    return {
      auth: {
        ...auth,
        attributes: {
          ...auth.attributes,
          captain_principal: "traveller",
          captain_user_id: user.id
        }
      }
    };
  }
});
