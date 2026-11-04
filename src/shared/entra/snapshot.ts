import { GraphClient, GraphGroup, GraphUser } from "../graph";
import { EntraStore } from "./store";

/*
  Pull the Entra users (per account domain, guests dropped) and groups into entra.users / entra.groups, and the members
  of every managed group into entra.group_members. Users that drop out of the listing get missing_since_utc.
  Logs counts only.
*/

export interface SnapshotCounts { usersFetched: number; groupsFetched: number; managedGroups: number; usersMissing: number; }

export async function snapshotEntra(graph: GraphClient, store: EntraStore, opts: { domains: string[]; fetchedUtc: Date; log: (m: string) => void }): Promise<SnapshotCounts> {
  const byId = new Map<string, GraphUser>();
  for (const domain of opts.domains) {
    const users = await graph.listUsers(domain);
    for (const u of users) byId.set(u.id, u);
    opts.log(`users @${domain}: ${users.length}`);
  }
  const users = [...byId.values()];
  // an empty or collapsed listing would mark everyone missing, stale every proposal and drop every rejection: refuse it
  if (!users.length) throw new Error(`Graph listed no users for ${opts.domains.join(", ")}: snapshot not written (check ENTRA_ACCOUNT_DOMAINS and the Graph permissions)`);
  const previous = await store.activeUserCount();
  if (previous > 0 && users.length < previous / 2) throw new Error(`Graph listed ${users.length} users but the previous snapshot has ${previous}: listing collapsed, snapshot not written`);
  await store.upsertUsers(users, opts.fetchedUtc);
  const usersMissing = await store.markMissingUsers(opts.fetchedUtc);

  const groups: GraphGroup[] = await graph.listGroups();
  await store.upsertGroups(groups, opts.fetchedUtc);

  const listed = new Set(groups.map(g => g.id));
  const managed = (await store.groups()).filter(g => g.managed && listed.has(g.objectId));   // a managed group deleted in Entra is skipped, not fatal
  for (const g of managed) {
    const ids = await graph.listGroupMemberUserIds(g.objectId);
    await store.replaceGroupMembers(g.objectId, ids, opts.fetchedUtc);
  }
  opts.log(`snapshot: users=${users.length} missing=${usersMissing} groups=${groups.length} managed=${managed.length}`);
  return { usersFetched: users.length, groupsFetched: groups.length, managedGroups: managed.length, usersMissing };
}
