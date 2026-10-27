import { HttpRequest, HttpResponseInit } from "@azure/functions";
import { config } from "./config";

/*
  Access model
  ------------
  Every endpoint requires BOTH:
    - a SCOPE the calling app was granted (you control per app, in each app's API permissions), and
    - a ROLE the signed-in user was assigned (Enterprise app -> Users and groups).
  Admin roles include their Read role.

  Caller types:
    - "delegated": a client app (e.g. Lovable) calling on behalf of a signed-in user -> token has scp + roles
    - "self":      a user signed in directly at the Function App URL (browser testing) -> no scp;
                   gets SELF_CLIENT_SCOPES (default summary only)
    - "app":       an app with no user (e.g. Logic Apps managed identity) -> application roles only
*/

export const Scopes = {
  SummaryRead: "Employees.Summary.Read",
  SummaryWrite: "Employees.Summary.Write",
  SensitiveRead: "Employees.Sensitive.Read",
  SensitiveReveal: "Employees.Sensitive.Reveal",
  SensitiveWrite: "Employees.Sensitive.Write"
} as const;

export const Roles = {
  SummaryRead: "Summary.Read",
  SummaryAdmin: "Summary.Admin",
  SensitiveRead: "Sensitive.Read",
  SensitiveAdmin: "Sensitive.Admin",
  IntegrationRun: "Integration.Run",  // application role (Logic Apps / sync)
  RosterReadApp: "Roster.Read.All",   // application role: roster endpoint ONLY (e.g. directory app server)
  RosterContactsReadApp: "RosterContacts.Read.All"   // application role: roster + contact details endpoint ONLY (e.g. rewards app)
} as const;

/** Admin implies Read within the same tier. */
const IMPLIES: Record<string, string[]> = {
  [Roles.SummaryAdmin]: [Roles.SummaryRead],
  [Roles.SensitiveAdmin]: [Roles.SensitiveRead]
};

const CLAIM = {
  scope: ["scp", "http://schemas.microsoft.com/identity/claims/scope"],
  roles: ["roles", "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"],
  clientId: ["azp", "appid"],
  objectId: ["oid", "http://schemas.microsoft.com/identity/claims/objectidentifier"],
  name: ["preferred_username", "upn", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn", "name", "email"],
  idtyp: ["idtyp"]
};

export interface Caller {
  kind: "delegated" | "self" | "app" | "local";
  user: string;            // UPN / display name ("" for app-only)
  userId: string;          // Entra object ID
  clientAppId: string;     // calling app's client ID ("self" for direct browser sessions)
  roles: Set<string>;      // effective (with Admin -> Read expansion)
  scopes: Set<string>;
}

export interface AuthResult { ok: boolean; caller?: Caller; response?: HttpResponseInit; }

interface Claim { typ: string; val: string; }

function claimValues(claims: Claim[], names: string[]): string[] {
  return claims.filter(c => names.includes(c.typ)).map(c => c.val);
}

function expandRoles(raw: string[]): Set<string> {
  const out = new Set<string>(raw);
  for (const r of raw) (IMPLIES[r] ?? []).forEach(x => out.add(x));
  return out;
}

/** Builds the caller from the Easy Auth x-ms-client-principal header (or local-dev settings). */
export function getCaller(req: HttpRequest): Caller | null {
  const header = req.headers.get("x-ms-client-principal");

  if (!header) {
    if (!config.localDevAuth) return null;
    return {
      kind: "local", user: "local-dev", userId: "local-dev", clientAppId: "local",
      roles: expandRoles(config.localRoles), scopes: new Set(config.localScopes)
    };
  }

  let claims: Claim[] = [];
  try {
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    claims = Array.isArray(p?.claims) ? p.claims : [];
  } catch { return null; }

  const scopes = claimValues(claims, CLAIM.scope).flatMap(v => v.split(" ")).filter(Boolean);
  const roles = claimValues(claims, CLAIM.roles);
  const clientId = (claimValues(claims, CLAIM.clientId)[0] ?? "").toLowerCase();
  const userId = claimValues(claims, CLAIM.objectId)[0] ?? "";
  const user = claimValues(claims, CLAIM.name)[0] ?? req.headers.get("x-ms-client-principal-name") ?? "";
  const idtyp = claimValues(claims, CLAIM.idtyp)[0] ?? "";

  let kind: Caller["kind"];
  if (scopes.length > 0) kind = "delegated";
  else if (idtyp === "app" || (!user && roles.length > 0)) kind = "app";
  else kind = "self";

  return {
    kind,
    user,
    userId,
    clientAppId: kind === "self" ? "self" : clientId,
    roles: expandRoles(roles),
    scopes: new Set(kind === "self" ? config.selfClientScopes : scopes)
  };
}

const deny = (status: number, error: string, detail?: string): AuthResult =>
  ({ ok: false, response: { status, jsonBody: detail ? { error, detail } : { error } } });

/**
 * Authorize a request.
 *  scope: required delegated scope (checked for delegated/self/local callers)
 *  anyRole: user must hold at least one of these roles (Admin roles already expand to Read)
 *  appRole: if set, app-only callers (no user) are allowed when they hold this (or any of these) application role(s)
 */
export function authorize(req: HttpRequest, opts: { scope: string; anyRole: string[]; appRole?: string | string[] }): AuthResult {
  const caller = getCaller(req);
  if (!caller) return deny(401, "Unauthenticated");

  if (caller.kind === "delegated" && config.allowedClientIds.length > 0 &&
      !config.allowedClientIds.includes(caller.clientAppId)) {
    return deny(403, "Forbidden", "client_app_not_allowed");
  }

  if (caller.kind === "app") {
    const appRoles = opts.appRole ? (Array.isArray(opts.appRole) ? opts.appRole : [opts.appRole]) : [];
    if (appRoles.some(r => caller.roles.has(r))) return { ok: true, caller };
    return deny(403, "Forbidden", "app_only_not_allowed");
  }

  if (!caller.scopes.has(opts.scope)) return deny(403, "Forbidden", "insufficient_scope");
  if (!opts.anyRole.some(r => caller.roles.has(r))) return deny(403, "Forbidden", "insufficient_role");

  return { ok: true, caller };
}

/** Safe summary of the caller for logs/audit (no tokens, no claim dumps). */
export function describeCaller(c: Caller): string {
  return `${c.kind}:${c.user || c.clientAppId}`;
}
