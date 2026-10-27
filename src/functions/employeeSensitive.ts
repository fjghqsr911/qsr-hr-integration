import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { UkgError } from "../shared/ukg";
import { authorize, describeCaller, Roles, Scopes } from "../shared/auth";
import { findEmployment, findPerson, ID_PATTERN, maskSin, formatSin, dateOnly } from "../shared/employees";
import { writeAudit } from "../shared/audit";

// GET /api/employees/{id}/sensitive              -> SIN masked
// GET /api/employees/{id}/sensitive?reveal=sin   -> full SIN
//
// Read:   scope Employees.Sensitive.Read                               + role Sensitive.Read or Sensitive.Admin
// Reveal: scopes Employees.Sensitive.Read AND Employees.Sensitive.Reveal + role Sensitive.Admin
//
// Every call is audited (who, which app, which employee, which fields - never values).
// If the audit write fails, no data is returned (fail closed).

const ENDPOINT = "GET /employees/{id}/sensitive";
const NO_STORE = { "Cache-Control": "no-store", "Pragma": "no-cache" };

export async function employeeSensitive(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SensitiveRead, anyRole: [Roles.SensitiveRead] });
  if (!auth.ok) return auth.response!;
  const caller = auth.caller!;

  const reveal = (req.query.get("reveal") ?? "").toLowerCase() === "sin";
  if (reveal) {
    if (!caller.scopes.has(Scopes.SensitiveReveal))
      return { status: 403, jsonBody: { error: "Forbidden", detail: "insufficient_scope" } };
    if (!caller.roles.has(Roles.SensitiveAdmin))
      return { status: 403, jsonBody: { error: "Forbidden", detail: "insufficient_role" } };
  }

  const id = req.params.id ?? "";
  if (!ID_PATTERN.test(id)) return { status: 400, jsonBody: { error: "Invalid employee id" } };
  ctx.log(`sensitive id=${id} reveal=${reveal} by=${describeCaller(caller)}`);

  const fields = ["sin", "dateOfBirth", "address", "homePhone", "personalEmail",
                  "hourlyPayRate", "annualSalary", "salaryOrHourly", "payGroupCode"];
  const action = reveal ? "reveal_sin" : "read";

  try {
    const [person, emp] = await Promise.all([findPerson(id), findEmployment(id)]);
    if (person.filterIgnored) ctx.warn("person-details appears to ignore the employeeId filter");
    if (emp.filterIgnored) ctx.warn("employee-employment-details appears to ignore the employeeId filter");

    const p = person.record, e = emp.record;
    if (!p && !e) {
      await writeAudit({ caller, endpoint: ENDPOINT, employeeId: id, action, fields: [], outcome: "not_found" });
      return { status: 404, jsonBody: { error: "Employee not found" }, headers: NO_STORE };
    }

    // Audit BEFORE returning data. If this throws, we return 503 with no data.
    await writeAudit({ caller, endpoint: ENDPOINT, employeeId: id, action, fields, outcome: "allowed" });

    const sinRaw = p?.nationalId || p?.ssn;
    return {
      headers: NO_STORE,
      jsonBody: {
        employeeId: id,
        sin: reveal ? formatSin(sinRaw) : maskSin(sinRaw),
        sinMasked: !reveal,
        dateOfBirth: dateOnly(p?.dateOfBirth),
        address: p ? {
          line1: p.addressLine1 ?? null, line2: p.addressLine2 ?? null,
          city: p.addressCity ?? null, province: p.addressState ?? null,
          postalCode: p.addressZipCode ?? null, country: p.addressCountry ?? null
        } : null,
        homePhone: p?.homePhone ?? null,
        personalEmail: p?.emailAddress ?? null,
        pay: e ? {
          salaryOrHourly: e.salaryOrHourly ?? null,
          hourlyPayRate: e.hourlyPayRate ?? null,
          annualSalary: e.annualSalary ?? null,
          payGroupCode: e.payGroupCode ?? null
        } : null
      }
    };
  } catch (err: any) {
    const isUkg = err instanceof UkgError;
    ctx.error(`sensitive failed id=${id}: ${isUkg ? err.message : "audit or internal error"}`);
    try { await writeAudit({ caller, endpoint: ENDPOINT, employeeId: id, action, fields: [], outcome: "error" }); } catch { /* already failing */ }
    return isUkg
      ? { status: 502, jsonBody: { error: "Upstream error", ukgStatus: err.status || "unreachable" }, headers: NO_STORE }
      : { status: 503, jsonBody: { error: "Temporarily unavailable" }, headers: NO_STORE };
  }
}

app.http("employeeSensitive", {
  methods: ["GET"], authLevel: "anonymous", route: "employees/{id}/sensitive", handler: employeeSensitive
});
