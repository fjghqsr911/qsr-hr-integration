import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { UkgError } from "../shared/ukg";
import { authorize, describeCaller, Roles, Scopes } from "../shared/auth";
import { findEmployment, ID_PATTERN, storeFields, dateOnly } from "../shared/employees";

// GET /api/employees/{id}/summary
// Scope: Employees.Summary.Read   Role: Summary.Read or Summary.Admin
// Returns employment basics only - no SIN, DOB, address, or pay.
export async function employeeSummary(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const auth = authorize(req, { scope: Scopes.SummaryRead, anyRole: [Roles.SummaryRead] });
  if (!auth.ok) return auth.response!;

  const id = req.params.id ?? "";
  if (!ID_PATTERN.test(id)) return { status: 400, jsonBody: { error: "Invalid employee id" } };
  ctx.log(`summary id=${id} by=${describeCaller(auth.caller!)}`);

  try {
    const { record: e, filterIgnored } = await findEmployment(id);
    if (filterIgnored) ctx.warn("employee-employment-details appears to ignore the employeeId filter");
    if (!e) return { status: 404, jsonBody: { error: "Employee not found" } };

    return {
      jsonBody: {
        employeeId: e.employeeID,
        employeeNumber: e.employeeNumber,
        companyId: e.companyID,
        ...storeFields(e.orgLevel2Code),
        orgLevel1: e.orgLevel1Code,       // district/region for stores (e.g. W5); CORP for head office
        orgLevel2: e.orgLevel2Code,       // store code or department (e.g. W06448, HR)
        workLocation: e.primaryWorkLocationCode,
        jobCode: e.primaryJobCode,
        status: e.employeeStatusCode,
        statusStartDate: dateOnly(e.employeeStatusStartDate),
        originalHireDate: dateOnly(e.originalHireDate),
        lastHireDate: dateOnly(e.lastHireDate),
        fullOrPartTime: e.fullTimeOrPartTimeCode,
        salaryOrHourly: e.salaryOrHourly
      }
    };
  } catch (err: any) {
    ctx.error(`summary failed id=${id}: ${err.message}`);
    return { status: 502, jsonBody: { error: "Upstream error", ukgStatus: err instanceof UkgError ? err.status : "unreachable" } };
  }
}

app.http("employeeSummary", {
  methods: ["GET"], authLevel: "anonymous", route: "employees/{id}/summary", handler: employeeSummary
});
