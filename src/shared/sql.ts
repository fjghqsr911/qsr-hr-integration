import sql from "mssql";
import { DefaultAzureCredential } from "@azure/identity";
import { config } from "./config";

const credential = new DefaultAzureCredential();   // managed identity in Azure; your az login locally

/** Opens a connection pool to the hub database using an Entra access token (no passwords). Caller closes it. */
export async function openHubPool(): Promise<sql.ConnectionPool> {
  const token = await credential.getToken("https://database.windows.net/.default");
  const pool = new sql.ConnectionPool({
    server: config.hubSqlServer,
    database: config.hubSqlDatabase,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
    requestTimeout: 120_000,
    connectionTimeout: 60_000            // Basic tier can take a moment to respond
  } as sql.config);
  return pool.connect();
}

/* Shared pool for API requests (reused across requests; renewed before the token expires). */
let shared: { pool: sql.ConnectionPool; expires: number } | null = null;
let opening: Promise<sql.ConnectionPool> | null = null;

export async function getSharedHubPool(): Promise<sql.ConnectionPool> {
  if (shared && shared.pool.connected && Date.now() < shared.expires) return shared.pool;
  if (opening) return opening;
  opening = (async () => {
    const old = shared; shared = null;
    if (old) old.pool.close().catch(() => {});
    const token = await credential.getToken("https://database.windows.net/.default");
    const pool = await new sql.ConnectionPool({
      server: config.hubSqlServer, database: config.hubSqlDatabase,
      options: { encrypt: true, trustServerCertificate: false },
      authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
      requestTimeout: 60_000, connectionTimeout: 60_000,
      pool: { max: 5, min: 0, idleTimeoutMillis: 300_000 }
    } as sql.config).connect();
    // renew 10 minutes before the token expires
    shared = { pool, expires: (token.expiresOnTimestamp ?? Date.now() + 3600_000) - 600_000 };
    return pool;
  })();
  try { return await opening; } finally { opening = null; }
}

/** Drop the shared pool (e.g. after a connection error) so the next request reconnects. */
export function resetSharedHubPool() { const old = shared; shared = null; if (old) old.pool.close().catch(() => {}); }

export { sql };
