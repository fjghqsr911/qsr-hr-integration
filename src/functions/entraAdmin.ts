import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorize, Caller, describeCaller, Roles, Scopes } from "../shared/auth";
import { config } from "../shared/config";
import { getSharedHubPool, resetSharedHubPool } from "../shared/sql";
import { writeAudit } from "../shared/audit";
import { buildGraphClient, GraphClient, GraphError } from "../shared/graph";
import { ProposalRow, publicProposal, SqlEntraStore } from "../shared/entra/store";
import { applyProposal, ApplyOutcome, isClaimable, isDue, isStuck } from "../shared/entra/apply";
import { dedupeHash, groupManageable, torontoToday } from "../shared/entra/compare";

// Entra admin actions (used by the read-only monitor UI). Every route: scope Employees.Summary.Write + role Entra.Admin;
// delegated callers only (no app-only tokens). Every change is audited as a write BEFORE it happens (who, which
// employee, which field / kind - never values); when the audit record cannot be written nothing changes and the caller
// gets 503. Every Graph write is also gated by ENTRA_WRITE_ENABLED (409 writes_disabled); accepting still records.
//
//   POST   /api/hub/entra/proposals/{id}/accept     proposed -> accepted, then applied at once unless due later (disable on date last worked)
//   POST   /api/hub/entra/proposals/{id}/reject     proposed | accepted -> rejected (+ rejection row: not proposed again until the difference goes)
//   POST   /api/hub/entra/proposals/{id}/apply      accepted -> applying -> applied | failed | stale; 409 before the due date
//   POST   /api/hub/entra/proposals/decide          { ids: [...], action: "accept" | "reject" }   bulk, max ENTRA_MAX_DECIDE, per id result
//   POST   /api/hub/entra/groups/{gid}/members      { employeeIds: [...] }   add now (Graph), recorded as manual applied proposals
//   DELETE /api/hub/entra/groups/{gid}/members      { employeeIds: [...] }   remove now
//   PUT    /api/hub/entra/groups/{gid}/managed      { managed: true | false }
//   PUT    /api/hub/entra/rules[/{id}]              rule body (csv tokens ^[A-Za-z0-9]{1,20}$); the group must be managed
//   DELETE /api/hub/entra/rules/{id}
//   POST   /api/hub/entra/links                     { employeeId, userObjectId }   manual link (open proposals of the old link -> stale)
//   DELETE /api/hub/entra/links/{employeeId}

const NO_STORE = { "Cache-Control": "no-store", "Pragma": "no-cache" };
const ID_PATTERN = /^\d{1,15}$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPLOYEE_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9]{1,20}$/;
const STATUS_TOKENS = ["A", "L", "T"];
const RULE_MODES = ["add_only", "add_and_remove"] as const;
const MAX_TOKENS = 100;

const errText = (e: any) => String(e?.message ?? "error").replace(/\?.*$/, "").slice(0, 200);
const unavailable = (): HttpResponseInit => ({ status: 503, headers: NO_STORE, jsonBody: { error: "Temporarily unavailable" } });
const bad = (error: string): HttpResponseInit => ({ status: 400, headers: NO_STORE, jsonBody: { error } });
const notFound = (error: string): HttpResponseInit => ({ status: 404, headers: NO_STORE, jsonBody: { error } });
const ok = (jsonBody: unknown, status = 200): HttpResponseInit => ({ status, headers: NO_STORE, jsonBody });
const writesDisabled = (): HttpResponseInit => ({ status: 409, headers: NO_STORE, jsonBody: { error: "writes_disabled", detail: "ENTRA_WRITE_ENABLED is not true: nothing is written to Entra" } });

type Deps = { store: SqlEntraStore; graph: GraphClient; today: string; writeEnabled: boolean };

/** Shared pool + store; a thrown error resets the pool and answers 503. */
async function withDeps(ctx: InvocationContext, label: string, fn: (d: Deps) => Promise<HttpResponseInit>): Promise<HttpResponseInit> {
  try {
    const pool = await getSharedHubPool();
    const log = (m: string) => ctx.log(`[entra] ${m}`);
    return await fn({ store: new SqlEntraStore(pool), graph: buildGraphClient({ log }), today: torontoToday(), writeEnabled: config.entraWriteEnabled });
  } catch (e: any) {
    resetSharedHubPool();
    ctx.error(`[entra] ${label} failed: ${errText(e)}`);
    return unavailable();
  }
}

function adminAuth(req: HttpRequest) { return authorize(req, { scope: Scopes.SummaryWrite, anyRole: [Roles.EntraAdmin] }); }

async function readJson(req: HttpRequest): Promise<any | undefined> { try { return await req.json(); } catch { return undefined; } }

/** Audits BEFORE a change. Returns a 503 response when the record cannot be written (fail closed). */
async function auditBefore(ctx: InvocationContext, label: string, entry: { caller: Caller; endpoint: string; employeeId: string; fields: string[] }): Promise<HttpResponseInit | null> {
  try { await writeAudit({ ...entry, action: "write", outcome: "allowed" }); return null; }
  catch (e: any) { ctx.error(`[entra] ${label} audit failed: ${errText(e)}`); return unavailable(); }
}

const fieldsOf = (p: ProposalRow) => [p.field ?? p.kind];

/** The response for a proposal after an action: the row plus what happened to the apply, if one was attempted. */
type ApplyNote = ApplyOutcome | "due_later" | null;
const proposalBody = (p: ProposalRow, applyOutcome: ApplyNote) => ({ ...publicProposal(p), applyOutcome });
const conflict = (p: ProposalRow, need: string): HttpResponseInit =>
  ({ status: 409, headers: NO_STORE, jsonBody: { error: `Proposal is ${p.status}; ${need}`, status: p.status } });

/** Accept, then apply at once when due and writes are on. Shared by the single and the bulk endpoint. */
async function acceptAndApply(d: Deps, p: ProposalRow, by: string, log: (m: string) => void): Promise<{ proposal: ProposalRow; applyOutcome: ApplyNote; httpStatus: number }> {
  const accepted = await d.store.accept(p.proposalId, by);
  if (!accepted) { const again = (await d.store.proposal(p.proposalId)) ?? p; return { proposal: again, applyOutcome: null, httpStatus: 409 }; }
  if (!isDue(accepted, d.today)) return { proposal: accepted, applyOutcome: "due_later", httpStatus: 200 };
  if (!d.writeEnabled) return { proposal: accepted, applyOutcome: "writes_disabled", httpStatus: 200 };
  const r = await applyProposal(accepted.proposalId, { store: d.store, graph: d.graph, writeEnabled: true, today: d.today, log });
  return { proposal: r.proposal ?? accepted, applyOutcome: r.outcome, httpStatus: r.outcome === "failed" ? 502 : 200 };
}

// ---------------------------------------------------------------- proposals ----------------------------------------------------------------
type ProposalAction = "accept" | "reject" | "apply";

async function proposalAction(req: HttpRequest, ctx: InvocationContext, action: ProposalAction): Promise<HttpResponseInit> {
  const auth = adminAuth(req);
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const idText = req.params.id ?? "";
  if (!ID_PATTERN.test(idText)) return bad("Invalid proposal id");
  const id = Number(idText);
  const endpoint = `POST /hub/entra/proposals/{id}/${action}`;
  const by = describeCaller(caller).slice(0, 200);
  ctx.log(`[entra] proposal ${action} id=${id} by=${by}`);

  return withDeps(ctx, `proposal ${action}`, async (d) => {
    const p = await d.store.proposal(id);
    if (!p) { try { await writeAudit({ caller, endpoint, employeeId: "", action: "write", fields: ["status"], outcome: "not_found" }); } catch { /* read only */ } return notFound("Proposal not found"); }

    if (action === "accept") {
      if (p.status !== "proposed") return conflict(p, "accept needs proposed");
    } else if (action === "reject") {
      if (p.status !== "proposed" && p.status !== "accepted" && !isStuck(p)) return conflict(p, "reject needs proposed or accepted");
    } else {
      if (!isClaimable(p)) return conflict(p, "apply needs accepted");
      if (!isDue(p, d.today)) return { status: 409, headers: NO_STORE, jsonBody: { error: `Proposal is due on ${p.dueDate}`, status: p.status, dueDate: p.dueDate } };
      if (!d.writeEnabled) return writesDisabled();
    }

    const refused = await auditBefore(ctx, `proposal ${action}`, { caller, endpoint, employeeId: p.employeeId, fields: fieldsOf(p) });
    if (refused) return refused;
    const log = (m: string) => ctx.log(`[entra] ${m}`);

    if (action === "accept") {
      const r = await acceptAndApply(d, p, by, log);
      return r.httpStatus === 409 ? conflict(r.proposal, "accept needs proposed") : ok(proposalBody(r.proposal, r.applyOutcome), r.httpStatus);
    }
    if (action === "reject") {
      const rejected = await d.store.reject(id, by);
      if (!rejected) { const again = (await d.store.proposal(id)) ?? p; return conflict(again, "reject needs proposed or accepted"); }
      return ok(proposalBody(rejected, null));
    }
    const r = await applyProposal(id, { store: d.store, graph: d.graph, writeEnabled: d.writeEnabled, today: d.today, log });
    if (r.outcome === "conflict" || r.outcome === "not_due") return r.proposal ? conflict(r.proposal, "apply needs accepted and due") : notFound("Proposal not found");
    if (r.outcome === "writes_disabled") return writesDisabled();
    if (r.outcome === "not_found") return notFound("Proposal not found");
    return ok(proposalBody(r.proposal!, r.outcome), r.outcome === "failed" ? 502 : 200);
  });
}

export const entraProposalAccept = (req: HttpRequest, ctx: InvocationContext) => proposalAction(req, ctx, "accept");
export const entraProposalReject = (req: HttpRequest, ctx: InvocationContext) => proposalAction(req, ctx, "reject");
export const entraProposalApply = (req: HttpRequest, ctx: InvocationContext) => proposalAction(req, ctx, "apply");

export async function entraProposalsDecide(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = adminAuth(req);
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const body = await readJson(req);
  if (body === undefined) return bad("Body must be JSON");
  const action = typeof body?.action === "string" ? body.action.toLowerCase() : "";
  if (action !== "accept" && action !== "reject") return bad("action must be accept or reject");
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (!ids || ids.length === 0) return bad("ids must be a non-empty array");
  if (ids.length > config.entraMaxDecide) return bad(`ids must hold at most ${config.entraMaxDecide} entries`);
  if (!ids.every((v: unknown) => ID_PATTERN.test(String(v)))) return bad("Invalid proposal id");
  const unique = [...new Set(ids.map((v: unknown) => Number(v)))] as number[];
  const endpoint = "POST /hub/entra/proposals/decide";
  const by = describeCaller(caller).slice(0, 200);
  ctx.log(`[entra] decide ${action} ids=${unique.length} by=${by}`);

  return withDeps(ctx, "decide", async (d) => {
    const log = (m: string) => ctx.log(`[entra] ${m}`);
    const results: { proposalId: number; outcome: string; status: string | null; error?: string | null }[] = [];
    for (const id of unique) {
      const p = await d.store.proposal(id);
      if (!p) { results.push({ proposalId: id, outcome: "not_found", status: null }); continue; }
      const allowed = action === "accept" ? p.status === "proposed" : (p.status === "proposed" || p.status === "accepted" || isStuck(p));
      if (!allowed) { results.push({ proposalId: id, outcome: "conflict", status: p.status }); continue; }
      const refused = await auditBefore(ctx, "decide", { caller, endpoint, employeeId: p.employeeId, fields: fieldsOf(p) });
      if (refused) return { ...refused, jsonBody: { error: "Temporarily unavailable", action, results } };     // stop: nothing further changes
      if (action === "accept") {
        const r = await acceptAndApply(d, p, by, log);
        results.push({ proposalId: id, outcome: r.httpStatus === 409 ? "conflict" : (r.applyOutcome ?? "accepted"), status: r.proposal.status, error: r.proposal.error });
      } else {
        const rejected = await d.store.reject(id, by);
        results.push(rejected ? { proposalId: id, outcome: "rejected", status: rejected.status } : { proposalId: id, outcome: "conflict", status: ((await d.store.proposal(id))?.status) ?? null });
      }
    }
    return ok({ action, results });
  });
}

// ---------------------------------------------------------------- group members ----------------------------------------------------------------
async function groupMembers(req: HttpRequest, ctx: InvocationContext, kind: "group_add" | "group_remove"): Promise<HttpResponseInit> {
  const auth = adminAuth(req);
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const gid = (req.params.gid ?? "").toLowerCase();
  if (!GUID_PATTERN.test(gid)) return bad("Invalid group id");
  const body = await readJson(req);
  if (body === undefined) return bad("Body must be JSON");
  const employeeIds = Array.isArray(body?.employeeIds) ? body.employeeIds : null;
  if (!employeeIds || employeeIds.length === 0) return bad("employeeIds must be a non-empty array");
  if (employeeIds.length > config.entraMaxDecide) return bad(`employeeIds must hold at most ${config.entraMaxDecide} entries`);
  if (!employeeIds.every((v: unknown) => typeof v === "string" && EMPLOYEE_PATTERN.test(v))) return bad("Invalid employee id");
  const unique = [...new Set(employeeIds as string[])];
  const method = kind === "group_add" ? "POST" : "DELETE";
  const endpoint = `${method} /hub/entra/groups/{gid}/members`;
  const by = describeCaller(caller).slice(0, 200);
  ctx.log(`[entra] group members ${kind} group=${gid} employees=${unique.length} by=${by}`);

  return withDeps(ctx, `group members ${kind}`, async (d) => {
    const group = await d.store.group(gid);
    if (!group) return notFound("Group not in the Entra snapshot");
    if (!groupManageable(group)) return { status: 409, headers: NO_STORE, jsonBody: { error: "group_not_manageable", detail: group.managed ? "dynamic or role-assignable groups cannot be targeted" : "group is not managed" } };
    if (!d.writeEnabled) return writesDisabled();

    const results: { employeeId: string; outcome: string; error?: string }[] = [];
    for (const employeeId of unique) {
      const link = await d.store.linkFor(employeeId);
      if (!link) { results.push({ employeeId, outcome: "skipped_unlinked" }); continue; }
      const member = await d.store.isMember(gid, link.userObjectId);
      if (kind === "group_add" && member) { results.push({ employeeId, outcome: "skipped_existing" }); continue; }
      if (kind === "group_remove" && !member) { results.push({ employeeId, outcome: "skipped_not_member" }); continue; }
      const refused = await auditBefore(ctx, `group members ${kind}`, { caller, endpoint, employeeId, fields: [kind] });
      if (refused) return { ...refused, jsonBody: { error: "Temporarily unavailable", groupId: gid, results } };
      try {
        if (kind === "group_add") await d.graph.addGroupMember(gid, link.userObjectId);
        else await d.graph.removeGroupMember(gid, link.userObjectId);
        await d.store.setMember(gid, link.userObjectId, kind === "group_add");
        await d.store.insertManualApplied({ employeeId, userObjectId: link.userObjectId, kind, groupId: gid, hash: dedupeHash(employeeId, kind, null, gid, null), by });
        results.push({ employeeId, outcome: kind === "group_add" ? "added" : "removed" });
      } catch (e: any) {
        const text = e instanceof GraphError ? `Graph ${e.status}${e.code ? `: ${e.code}` : ""}` : errText(e);
        ctx.error(`[entra] group members ${kind} failed group=${gid} employee=${employeeId}: ${text}`);
        results.push({ employeeId, outcome: "failed", error: text });
      }
    }
    return ok({ groupId: gid, action: kind === "group_add" ? "add" : "remove", results });
  });
}

export const entraGroupMembersAdd = (req: HttpRequest, ctx: InvocationContext) => groupMembers(req, ctx, "group_add");
export const entraGroupMembersRemove = (req: HttpRequest, ctx: InvocationContext) => groupMembers(req, ctx, "group_remove");

export async function entraGroupManaged(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = adminAuth(req);
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const gid = (req.params.gid ?? "").toLowerCase();
  if (!GUID_PATTERN.test(gid)) return bad("Invalid group id");
  const body = await readJson(req);
  if (body === undefined) return bad("Body must be JSON");
  if (typeof body?.managed !== "boolean") return bad("managed must be true or false");
  const managed: boolean = body.managed;
  ctx.log(`[entra] group managed=${managed} group=${gid} by=${describeCaller(caller)}`);

  return withDeps(ctx, "group managed", async (d) => {
    const group = await d.store.group(gid);
    if (!group) return notFound("Group not in the Entra snapshot");
    if (managed && !groupManageable({ ...group, managed: true }))
      return { status: 409, headers: NO_STORE, jsonBody: { error: "group_not_manageable", detail: "dynamic or role-assignable groups cannot be managed" } };
    const refused = await auditBefore(ctx, "group managed", { caller, endpoint: "PUT /hub/entra/groups/{gid}/managed", employeeId: "", fields: ["managed"] });
    if (refused) return refused;
    const row = await d.store.setManaged(gid, managed);
    return row ? ok(row) : notFound("Group not in the Entra snapshot");
  });
}

// ---------------------------------------------------------------- rules ----------------------------------------------------------------
/** csv string or array of tokens -> upper-case csv (null when empty); throws a message on a bad token. */
function csvTokens(v: unknown, name: string, allowed?: readonly string[]): string | null {
  if (v === null || v === undefined || v === "") return null;
  const items = (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [v]).map(x => String(x).trim()).filter(Boolean);
  if (items.length > MAX_TOKENS) throw new Error(`${name} must hold at most ${MAX_TOKENS} entries`);
  for (const t of items) {
    if (!TOKEN_PATTERN.test(t)) throw new Error(`${name} contains an invalid token`);
    if (allowed && !allowed.includes(t.toUpperCase())) throw new Error(`${name} must only contain ${allowed.join(", ")}`);
  }
  return items.length ? [...new Set(items.map(x => x.toUpperCase()))].join(",") : null;
}

export function parseRule(body: any): { ok: true; rule: { groupId: string; name: string; jobCodes: string | null; districts: string | null; stores: string | null; companies: string | null; statuses: string; mode: string; enabled: boolean; notes: string | null } } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be JSON" };
  const groupId = typeof body.groupId === "string" ? body.groupId.toLowerCase() : "";
  if (!GUID_PATTERN.test(groupId)) return { ok: false, error: "groupId must be a group object id" };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) return { ok: false, error: "name is required (max 100 characters)" };
  const mode = typeof body.mode === "string" ? body.mode.toLowerCase() : "add_only";
  if (!(RULE_MODES as readonly string[]).includes(mode)) return { ok: false, error: "mode must be add_only or add_and_remove" };
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
  const notes = body.notes === null || body.notes === undefined ? null : String(body.notes).trim().slice(0, 300) || null;
  try {
    return { ok: true, rule: {
      groupId, name, jobCodes: csvTokens(body.jobCodes, "jobCodes"), districts: csvTokens(body.districts, "districts"), stores: csvTokens(body.stores, "stores"),
      companies: csvTokens(body.companies, "companies"), statuses: csvTokens(body.statuses, "statuses", STATUS_TOKENS) ?? "A,L", mode, enabled: body.enabled ?? true, notes
    } };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

export async function entraRuleSave(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = adminAuth(req);
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const idText = req.params.id ?? "";
  if (idText && !ID_PATTERN.test(idText)) return bad("Invalid rule id");
  const id = idText ? Number(idText) : null;
  const body = await readJson(req);
  if (body === undefined) return bad("Body must be JSON");
  const parsed = parseRule(body);
  if (parsed.ok === false) return bad(parsed.error);
  const endpoint = id === null ? "PUT /hub/entra/rules" : "PUT /hub/entra/rules/{id}";
  const by = describeCaller(caller).slice(0, 200);
  ctx.log(`[entra] rule save id=${id ?? "new"} group=${parsed.rule.groupId} by=${by}`);

  return withDeps(ctx, "rule save", async (d) => {
    if (id !== null && !(await d.store.rule(id))) return notFound("Rule not found");
    const group = await d.store.group(parsed.rule.groupId);
    if (!group) return notFound("Group not in the Entra snapshot");
    if (!groupManageable(group)) return { status: 409, headers: NO_STORE, jsonBody: { error: "group_not_manageable", detail: group.managed ? "dynamic or role-assignable groups cannot be targeted" : "group is not managed" } };
    const refused = await auditBefore(ctx, "rule save", { caller, endpoint, employeeId: "", fields: ["rule"] });
    if (refused) return refused;
    const row = await d.store.saveRule(id, parsed.rule, by);
    return row ? ok(row) : notFound("Rule not found");
  });
}

export async function entraRuleDelete(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = adminAuth(req);
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const idText = req.params.id ?? "";
  if (!ID_PATTERN.test(idText)) return bad("Invalid rule id");
  const id = Number(idText);
  ctx.log(`[entra] rule delete id=${id} by=${describeCaller(caller)}`);
  return withDeps(ctx, "rule delete", async (d) => {
    if (!(await d.store.rule(id))) return notFound("Rule not found");
    const refused = await auditBefore(ctx, "rule delete", { caller, endpoint: "DELETE /hub/entra/rules/{id}", employeeId: "", fields: ["rule"] });
    if (refused) return refused;
    const deleted = await d.store.deleteRule(id);
    return deleted ? ok({ ruleId: id, deleted: true }) : notFound("Rule not found");
  });
}

// ---------------------------------------------------------------- links ----------------------------------------------------------------
export async function entraLinkCreate(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = adminAuth(req);
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const body = await readJson(req);
  if (body === undefined) return bad("Body must be JSON");
  const employeeId = typeof body?.employeeId === "string" ? body.employeeId.trim() : "";
  const userObjectId = typeof body?.userObjectId === "string" ? body.userObjectId.trim().toLowerCase() : "";
  if (!EMPLOYEE_PATTERN.test(employeeId)) return bad("Invalid employee id");
  if (!GUID_PATTERN.test(userObjectId)) return bad("userObjectId must be a user object id");
  const by = describeCaller(caller).slice(0, 200);
  ctx.log(`[entra] link employee=${employeeId} user=${userObjectId} by=${by}`);

  return withDeps(ctx, "link", async (d) => {
    const user = await d.store.user(userObjectId);
    if (!user) return notFound("Entra user not in the snapshot");
    const taken = await d.store.linkForUser(userObjectId);
    if (taken && taken.employeeId !== employeeId) return { status: 409, headers: NO_STORE, jsonBody: { error: "user_already_linked", employeeId: taken.employeeId } };
    if (taken && taken.method === "manual") return ok(taken);                 // unchanged: nothing to write, nothing to stale
    const refused = await auditBefore(ctx, "link", { caller, endpoint: "POST /hub/entra/links", employeeId, fields: ["link"] });
    if (refused) return refused;
    try { return ok(await d.store.linkManual(employeeId, userObjectId, by)); }
    catch (e: any) {
      if (e?.number === 2601 || e?.number === 2627) {                        // unique index: someone linked the user meanwhile
        const now = await d.store.linkForUser(userObjectId);
        return { status: 409, headers: NO_STORE, jsonBody: { error: "user_already_linked", employeeId: now?.employeeId ?? null } };
      }
      throw e;
    }
  });
}

export async function entraLinkDelete(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = adminAuth(req);
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;
  const employeeId = (req.params.employeeId ?? "").trim();
  if (!EMPLOYEE_PATTERN.test(employeeId)) return bad("Invalid employee id");
  ctx.log(`[entra] unlink employee=${employeeId} by=${describeCaller(caller)}`);
  return withDeps(ctx, "unlink", async (d) => {
    if (!(await d.store.linkFor(employeeId))) return notFound("Employee is not linked");
    const refused = await auditBefore(ctx, "unlink", { caller, endpoint: "DELETE /hub/entra/links/{employeeId}", employeeId, fields: ["link"] });
    if (refused) return refused;
    const deleted = await d.store.unlink(employeeId);
    return deleted ? ok({ employeeId, unlinked: true }) : notFound("Employee is not linked");
  });
}

app.http("entraProposalAccept", { methods: ["POST"], authLevel: "anonymous", route: "hub/entra/proposals/{id}/accept", handler: entraProposalAccept });
app.http("entraProposalReject", { methods: ["POST"], authLevel: "anonymous", route: "hub/entra/proposals/{id}/reject", handler: entraProposalReject });
app.http("entraProposalApply", { methods: ["POST"], authLevel: "anonymous", route: "hub/entra/proposals/{id}/apply", handler: entraProposalApply });
app.http("entraProposalsDecide", { methods: ["POST"], authLevel: "anonymous", route: "hub/entra/proposals/decide", handler: entraProposalsDecide });
app.http("entraGroupMembersAdd", { methods: ["POST"], authLevel: "anonymous", route: "hub/entra/groups/{gid}/members", handler: entraGroupMembersAdd });
app.http("entraGroupMembersRemove", { methods: ["DELETE"], authLevel: "anonymous", route: "hub/entra/groups/{gid}/members", handler: entraGroupMembersRemove });
app.http("entraGroupManaged", { methods: ["PUT"], authLevel: "anonymous", route: "hub/entra/groups/{gid}/managed", handler: entraGroupManaged });
app.http("entraRuleCreate", { methods: ["PUT"], authLevel: "anonymous", route: "hub/entra/rules", handler: entraRuleSave });
app.http("entraRuleUpdate", { methods: ["PUT"], authLevel: "anonymous", route: "hub/entra/rules/{id}", handler: entraRuleSave });
app.http("entraRuleDelete", { methods: ["DELETE"], authLevel: "anonymous", route: "hub/entra/rules/{id}", handler: entraRuleDelete });
app.http("entraLinkCreate", { methods: ["POST"], authLevel: "anonymous", route: "hub/entra/links", handler: entraLinkCreate });
app.http("entraLinkDelete", { methods: ["DELETE"], authLevel: "anonymous", route: "hub/entra/links/{employeeId}", handler: entraLinkDelete });
