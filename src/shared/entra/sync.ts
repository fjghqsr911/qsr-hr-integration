import { GraphClient } from "../graph";
import { EntraStore } from "./store";
import { snapshotEntra } from "./snapshot";
import { computeLinks } from "./link";
import { computeDesired, diff, GroupSnapshot, OpenProposal, ProposalCandidate, torontoToday } from "./compare";

/*
  One Entra sync run: lock -> snapshot (Graph reads only) -> link employees to users -> compare every linked employee
  with the snapshot -> upsert proposals, stale the ones whose difference is gone, drop rejections that no longer
  suppress anything. Nothing is written to Entra here, ever.
*/

export interface EntraSyncResult {
  status: "succeeded" | "failed" | "locked";
  trigger: string;
  runId?: string;
  usersFetched?: number; groupsFetched?: number; linked?: number; linkIssues?: number;
  proposalsNew?: number; proposalsOpen?: number; proposalsStale?: number; proposalsBlocked?: number;
  message?: string;
}

export interface EntraSyncOptions {
  domains: string[];
  headOfficeCity: string | null;
  trigger: "timer" | "after-sync" | "manual";
  log: (m: string) => void;
  now?: () => Date;
}

export async function runEntraSync(store: EntraStore, graph: GraphClient, opts: EntraSyncOptions): Promise<EntraSyncResult> {
  const now = opts.now ?? (() => new Date());
  if (await store.isRunning()) return { status: "locked", trigger: opts.trigger, message: "an Entra sync is already running" };
  const runId = await store.startRun(opts.trigger);
  const counts = { usersFetched: 0, groupsFetched: 0, linked: 0, proposalsNew: 0, proposalsStale: 0 };
  try {
    const fetchedUtc = now();
    const snap = await snapshotEntra(graph, store, { domains: opts.domains, fetchedUtc, log: opts.log });
    counts.usersFetched = snap.usersFetched; counts.groupsFetched = snap.groupsFetched;

    // link
    const employees = await store.directory();
    const users = await store.users();
    const linkResult = computeLinks(employees, users, await store.links());
    counts.linked = await store.replaceAutoLinks(linkResult.autoLinks);
    await store.replaceLinkIssues(linkResult.issues);
    opts.log(`links: employees=${employees.length} linked=${counts.linked} issues=${linkResult.issues.length}`);

    // compare
    const today = torontoToday(now());
    const links = await store.links();
    const userById = new Map(users.map(u => [u.objectId, u]));
    const groups = new Map<string, GroupSnapshot>((await store.groups()).map(g => [g.objectId, g]));
    const memberships = await store.memberships();
    const rules = await store.rules();
    const rejections = await store.rejections();
    const events = await store.latestEvents(today);
    const open = await store.openProposals();
    const openByEmployee = new Map<string, OpenProposal[]>();
    for (const p of open) openByEmployee.set(p.employeeId, [...(openByEmployee.get(p.employeeId) ?? []), p]);
    const linkByEmployee = new Map(links.map(l => [l.employeeId, l]));

    const create: ProposalCandidate[] = [], blocked: ProposalCandidate[] = [], stale: number[] = [], suppressed = new Set<string>();
    const seenEmployees = new Set<string>(), compared: string[] = [];
    for (const emp of employees) {
      seenEmployees.add(emp.employeeId);
      const link = linkByEmployee.get(emp.employeeId);
      const found = link ? userById.get(link.userObjectId) ?? null : null;
      const user = found && !found.missingSinceUtc ? found : null;
      if (user) compared.push(emp.employeeId);
      const r = diff({
        employee: emp, desired: computeDesired(emp, { headOfficeCity: opts.headOfficeCity }), user,
        openProposals: openByEmployee.get(emp.employeeId) ?? [], rejections, rules, groups,
        memberships: user ? memberships.get(user.objectId) ?? new Set<string>() : new Set<string>(), eventId: events.get(emp.employeeId) ?? null, today
      });
      create.push(...r.create); blocked.push(...r.blocked); stale.push(...r.stale);
      for (const h of r.suppressed) suppressed.add(h);
    }
    for (const p of open) if (!seenEmployees.has(p.employeeId) && p.status !== "applying") stale.push(p.proposalId);   // employee left the hub

    counts.proposalsNew = await store.upsertProposals([...create, ...blocked]);
    counts.proposalsStale = await store.staleProposals(stale);
    const pruned = await store.pruneRejections(compared, [...suppressed]);
    opts.log(`compare: candidates=${create.length} blocked=${blocked.length} new=${counts.proposalsNew} stale=${counts.proposalsStale} rejections_cleared=${pruned}`);

    await store.finishRun(runId, "succeeded", counts);
    return { status: "succeeded", trigger: opts.trigger, runId, ...counts, linkIssues: linkResult.issues.length, proposalsOpen: create.length, proposalsBlocked: blocked.length };
  } catch (e: any) {
    const message = String(e?.message ?? "error").replace(/\?.*$/, "").slice(0, 300);
    await store.finishRun(runId, "failed", counts, message).catch(() => {});
    return { status: "failed", trigger: opts.trigger, runId, ...counts, message };
  }
}
