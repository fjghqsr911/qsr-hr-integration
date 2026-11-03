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
  await store.upsertUsers(users, opts.fetchedUtc);
  const usersMissing = await store.markMissingUsers(opts.fetchedUtc);

  const groups: GraphGroup[] = await graph.listGroups();
  await store.upsertGroups(groups, opts.fetchedUtc);

  const managed = (await store.groups()).filter(g => g.managed);
  for (const g of managed) {
    const ids = await graph.listGroupMemberUserIds(g.objectId);
    await store.replaceGroupMembers(g.objectId, ids, opts.fetchedUtc);
  }
  opts.log(`snapshot: users=${users.length} missing=${usersMissing} groups=${groups.length} managed=${managed.length}`);
  return { usersFetched: users.length, groupsFetched: groups.length, managedGroups: managed.length, usersMissing };
}
