import { TableClient } from "@azure/data-tables";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "crypto";
import { config, inAzure } from "./config";
import { Caller } from "./auth";

/*
  Access audit for sensitive reads and all writes.
  Records WHO (user + app), WHAT (endpoint, employee, field names, action), WHEN, OUTCOME.
  NEVER records data values.

  Fail-closed: if the audit record cannot be written, the caller must NOT return sensitive data.
*/

export interface AuditEntry {
  caller: Caller;
  endpoint: string;           // e.g. "GET /employees/{id}/sensitive"
  employeeId: string;
  action: "read" | "reveal_sin" | "write";
  fields: string[];           // field NAMES only
  outcome: "allowed" | "not_found" | "error";
}

let tableClient: TableClient | null = null;
let tableReady: Promise<void> | null = null;

function getTable(): TableClient {
  if (!tableClient) {
    const url = `https://${config.auditStorageAccount}.table.core.windows.net`;
    tableClient = new TableClient(url, config.auditTable, new DefaultAzureCredential());
    tableReady = tableClient.createTable().catch((e: any) => {
      if (e?.statusCode !== 409) throw e;      // 409 = already exists
    });
  }
  return tableClient;
}

/** Writes one audit record. Throws if it cannot be persisted (callers must fail closed). */
export async function writeAudit(e: AuditEntry): Promise<void> {
  const now = new Date();
  const record = {
    partitionKey: now.toISOString().slice(0, 7).replace("-", ""),                 // yyyyMM
    rowKey: `${(8.64e15 - now.getTime()).toString().padStart(16, "0")}_${randomUUID()}`, // newest first
    timestampUtc: now.toISOString(),
    callerKind: e.caller.kind,
    user: e.caller.user,
    userId: e.caller.userId,
    clientAppId: e.caller.clientAppId,
    endpoint: e.endpoint,
    employeeId: e.employeeId,
    action: e.action,
    fields: e.fields.join(","),
    outcome: e.outcome
  };

  if (!config.auditStorageAccount) {
    if (inAzure()) throw new Error("Audit storage not configured (AUDIT_STORAGE_ACCOUNT)");
    console.log(`[audit-local] ${JSON.stringify(record)}`);                       // local dev only
    return;
  }

  const table = getTable();
  await tableReady;
  await table.createEntity(record);
}
