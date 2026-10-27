import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ukgGet, UkgError } from "../shared/ukg";

// GET /api/health  - confirms settings resolve and UKG login works (1 record, read-only).
export async function health(_req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  const started = Date.now();
  try {
    await ukgGet("/personnel/v1/employee-employment-details?per_Page=1");
    return { jsonBody: { status: "ok", ukg: "ok", ms: Date.now() - started } };
  } catch (e: any) {
    const status = e instanceof UkgError ? e.status : 0;
    ctx.warn(`health check failed: ${e.message}`);
    const hint =
      status === 401 ? "UKG rejected the credentials - check Key Vault values" :
      status === 403 ? "Login worked but the account lacks Employment Details permission" :
      e.message?.startsWith("Missing required setting") ? e.message :
      "UKG unreachable or error";
    return { status: 502, jsonBody: { status: "error", ukg: status || "unreachable", hint } };
  }
}

app.http("health", { methods: ["GET"], authLevel: "anonymous", route: "health", handler: health });
