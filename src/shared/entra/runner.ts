import { InvocationContext } from "@azure/functions";
import { config } from "../config";
import { openHubPool } from "../sql";
import { buildGraphClient } from "../graph";
import { SqlEntraStore } from "./store";
import { EntraSyncResult, runEntraSync } from "./sync";

/*
  Wires one Entra sync run to the hub: pool, SQL store, Graph client with the managed identity token, settings.
  Used by the timer, the after-sync hook in hubSync.ts and POST /api/hub/entra/sync. Log lines go out as [entra] ...
  with counts and ids only.
*/

export async function runEntraSyncJob(ctx: InvocationContext, trigger: "timer" | "after-sync" | "manual"): Promise<EntraSyncResult> {
  const pool = await openHubPool();
  try {
    const log = (m: string) => ctx.log(m.startsWith("[entra]") || m.startsWith("[graph]") ? m : `[entra] ${m}`);
    const result = await runEntraSync(new SqlEntraStore(pool), buildGraphClient({ log }), {
      domains: config.entraAccountDomains, headOfficeCity: config.entraHeadOfficeCity, trigger, log
    });
    ctx.log(`[entra] ${trigger}: ${JSON.stringify(result)}`);
    if (result.status === "failed") ctx.error(`[entra] failed: ${result.message}`);
    return result;
  } finally {
    await pool.close().catch(() => {});
  }
}
