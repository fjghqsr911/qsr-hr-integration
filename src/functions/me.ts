import { app, HttpRequest, HttpResponseInit } from "@azure/functions";
import { getCaller } from "../shared/auth";

// GET /api/me - shows how the API sees the caller: user, calling app, effective roles and scopes.
// No UKG call, no employee data. Useful for checking role/scope setup.
export async function me(req: HttpRequest): Promise<HttpResponseInit> {
  const c = getCaller(req);
  if (!c) return { status: 401, jsonBody: { error: "Unauthenticated" } };
  return {
    jsonBody: {
      callerType: c.kind,          // delegated (app + user), self (direct browser), app (no user), local
      user: c.user,
      clientAppId: c.clientAppId,
      roles: [...c.roles].sort(),  // includes Read roles implied by Admin
      scopes: [...c.scopes].sort()
    }
  };
}

app.http("me", { methods: ["GET"], authLevel: "anonymous", route: "me", handler: me });
