import { GraphClient, GraphError, USER_APPLY_SELECT } from "../graph";
import { ProposalRow, SqlEntraStore, STUCK_APPLYING_MINUTES } from "./store";
import { AttributeField } from "./compare";

/*
  Apply one accepted proposal to Entra: claim it (accepted -> applying, only when due; the status-guarded UPDATE is what
  stops two admins applying the same row), re-read the user from Graph, give up as stale when Entra no longer holds the
  value the proposal was built on, otherwise write, then applied (snapshot row refreshed) or failed with the Graph code.
  The caller audits before calling; this module never logs values.
*/

export type ApplyOutcome = "applied" | "failed" | "stale" | "not_found" | "conflict" | "not_due" | "writes_disabled";

export interface ApplyResult { outcome: ApplyOutcome; proposal: ProposalRow | null; }

export interface ApplyDeps {
  store: Pick<SqlEntraStore, "proposal" | "claim" | "finish" | "refreshUser" | "setMember">;
  graph: Pick<GraphClient, "getUser" | "patchUser" | "addGroupMember" | "removeGroupMember">;
  writeEnabled: boolean;
  today: string;
  log: (m: string) => void;
}

const norm = (v: string | null | undefined) => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());
const errText = (e: any) => (e instanceof GraphError ? `Graph ${e.status}${e.code ? `: ${e.code}` : ""}` : String(e?.message ?? "error").replace(/\?.*$/, "").slice(0, 200));

/** Is this accepted proposal due today (Toronto)? */
export const isDue = (p: { dueDate: string | null }, today: string) => !p.dueDate || p.dueDate <= today;

/** An applying row whose claim is older than STUCK_APPLYING_MINUTES: the apply crashed between claim and finish. */
export const isStuck = (p: { status: string; lastSeenUtc: string | null }, now: number = Date.now()) =>
  p.status === "applying" && (!p.lastSeenUtc || now - Date.parse(p.lastSeenUtc) > STUCK_APPLYING_MINUTES * 60_000);

/** accepted, or applying but stuck. */
export const isClaimable = (p: { status: string; lastSeenUtc: string | null }) => p.status === "accepted" || isStuck(p);

export async function applyProposal(id: number, deps: ApplyDeps): Promise<ApplyResult> {
  const before = await deps.store.proposal(id);
  if (!before) return { outcome: "not_found", proposal: null };
  if (!isClaimable(before)) return { outcome: "conflict", proposal: before };
  if (!isDue(before, deps.today)) return { outcome: "not_due", proposal: before };
  if (!deps.writeEnabled) return { outcome: "writes_disabled", proposal: before };

  const p = await deps.store.claim(id, deps.today);
  if (!p) { const again = await deps.store.proposal(id); return { outcome: again && again.status === "accepted" ? "not_due" : "conflict", proposal: again }; }

  // Entra is changed before the row is finished; the snapshot refresh afterwards is best effort (the next sync corrects it anyway).
  const refresh: (() => Promise<void>)[] = [];
  try {
    if (p.kind === "attribute" || p.kind === "disable" || p.kind === "enable") {
      const user = await deps.graph.getUser(p.userObjectId, USER_APPLY_SELECT);
      if (!user) return { outcome: "failed", proposal: await deps.store.finish(id, "failed", null, "user not found in Entra") };
      if (p.kind === "attribute") {
        const field = p.field as AttributeField;
        const current = user[field];
        if (norm(current) !== norm(p.currentValue)) return { outcome: "stale", proposal: await deps.store.finish(id, "stale", current ?? null, "Entra value changed since the proposal") };
        await deps.graph.patchUser(p.userObjectId, { [field]: p.proposedValue });
        refresh.push(() => deps.store.refreshUser(p.userObjectId, { [field]: p.proposedValue }));
      } else {
        const want = p.kind === "enable";
        if (user.accountEnabled === want) {                                   // already there: nothing to write
          await deps.store.refreshUser(p.userObjectId, { accountEnabled: want });
          return { outcome: "stale", proposal: await deps.store.finish(id, "stale", String(user.accountEnabled), "account already in the proposed state") };
        }
        await deps.graph.patchUser(p.userObjectId, { accountEnabled: want });
        refresh.push(() => deps.store.refreshUser(p.userObjectId, { accountEnabled: want }));
      }
    } else if (p.kind === "group_add" || p.kind === "group_remove") {
      if (!p.groupId) return { outcome: "failed", proposal: await deps.store.finish(id, "failed", null, "proposal has no group") };
      if (p.kind === "group_add") await deps.graph.addGroupMember(p.groupId, p.userObjectId);
      else await deps.graph.removeGroupMember(p.groupId, p.userObjectId);
      const groupId = p.groupId, member = p.kind === "group_add";
      refresh.push(() => deps.store.setMember(groupId, p.userObjectId, member));
    } else {
      return { outcome: "failed", proposal: await deps.store.finish(id, "failed", null, `unknown kind ${p.kind}`) };
    }
    deps.log(`applied proposal ${id} kind=${p.kind}${p.field ? ` field=${p.field}` : ""} employee=${p.employeeId}`);
    const applied = await deps.store.finish(id, "applied", null, null);
    for (const fn of refresh) { try { await fn(); } catch (e: any) { deps.log(`snapshot refresh after proposal ${id} failed: ${errText(e)}`); } }
    return { outcome: "applied", proposal: applied };
  } catch (e: any) {
    const text = errText(e);
    deps.log(`apply failed proposal ${id} kind=${p.kind} employee=${p.employeeId}: ${text}`);
    return { outcome: "failed", proposal: await deps.store.finish(id, "failed", null, text) };
  }
}
