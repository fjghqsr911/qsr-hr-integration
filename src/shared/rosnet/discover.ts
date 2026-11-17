import { CodeMaps, CodeType, XrefIds } from "../delivery";
import { sameName } from "../names";
import { EdtEmployee, RosnetClient } from "./client";

/*
  Rosnet mapping discovery (read-only against Rosnet).
    what = "codes"      GET /Location, /JobCodes, /TermCodes. Hub W stores are paired with location numbers by their digits
                        (W06000 -> 6000) and written to ref.destination_codes; the job and termination rows already in the
                        table (provisioning/25) are checked against Rosnet's lists.
    what = "employees"  GET /Employee/getMultipleEmployeeInfo/{location} for every location (only employees submitted
                        through EDT are listed), matched to hub employees without an xref: POS UID = UKG employee id, else
                        payroll id = employee number (same last name, or the number unique on both sides) -> xref 'extract'
                        with the payroll id and POS number.
  Against the SANDBOX host nothing is written: the report is returned and the tables are left alone.
  The report holds codes, location numbers and counts: never employee names.
*/

export interface RosnetDiscoveryStore {
  hubStores(): Promise<string[]>;
  allCodes(): Promise<CodeMaps>;
  upsertCodes(rows: { codeType: CodeType; company?: string; ukgCode: string; destinationCode: string; destinationId: string | null; notes: string | null }[]): Promise<void>;
  employeesWithoutXref(): Promise<{ employeeId: string; companyId: string; employeeNumber: string | null; lastName: string | null }[]>;
  upsertXrefMany(rows: ({ employeeId: string; externalId: string; source: "extract" } & XrefIds)[]): Promise<void>;
}

export interface RosnetDiscoverReport {
  what: "codes" | "employees";
  sandbox: boolean;
  written: number;                                   // rows written to the hub (0 against the sandbox)
  clientCode: string | null;
  error?: string;
  locations: { rosnet: number; paired: number; unpairedHub: string[]; unpairedRosnet: number[] };
  jobCodes: { jobCode: number; description: string }[];
  termCodes: { terminationCode: number; description: string }[];
  staleMappings: { codeType: string; ukgCode: string; destinationCode: string }[];
  employees?: { rosnet: number; active: number; hubWithoutXref: number; matched: number; byUid: number; byPayrollId: number; lastNameMismatch: number; locationsFailed: number[] };
}

const W_STORE = /^W\d{5}$/i;
export const storeDigits = (code: string) => Number(code.replace(/\D/g, ""));
const norm = (n: unknown) => String(n ?? "").trim().replace(/^0+/, "");

export async function discoverRosnet(client: RosnetClient, store: RosnetDiscoveryStore,
                                     opts: { companies: string[]; what?: "codes" | "employees"; log?: (m: string) => void }): Promise<RosnetDiscoverReport> {
  const log = opts.log ?? (() => {});
  const what: "codes" | "employees" = opts.what === "employees" ? "employees" : "codes";
  const report: RosnetDiscoverReport = { what, sandbox: client.sandbox, written: 0, clientCode: null,
    locations: { rosnet: 0, paired: 0, unpairedHub: [], unpairedRosnet: [] }, jobCodes: [], termCodes: [], staleMappings: [] };
  if (!client.hasCredentials()) return { ...report, error: "no Rosnet credentials configured" };

  let locationNumbers: number[] = [];
  try {
    const loc = await client.locations();
    report.clientCode = loc.clientCode; locationNumbers = loc.locationNumbers;
    report.locations.rosnet = locationNumbers.length;
  } catch (e: any) { report.error = String(e?.message ?? "error").slice(0, 300); log(`discover: ${report.error}`); return report; }

  if (what === "codes") {
    const hubStores = (await store.hubStores()).filter(s => W_STORE.test(s));
    const known = new Set(locationNumbers);
    const paired = hubStores.filter(s => known.has(storeDigits(s)));
    const pairedNumbers = new Set(paired.map(storeDigits));
    report.locations.paired = paired.length;
    report.locations.unpairedHub = hubStores.filter(s => !known.has(storeDigits(s)));
    report.locations.unpairedRosnet = locationNumbers.filter(n => !pairedNumbers.has(n));
    try {
      report.jobCodes = await client.jobCodes();
      report.termCodes = await client.termCodes();
    } catch (e: any) { report.error = String(e?.message ?? "error").slice(0, 300); log(`discover: ${report.error}`); return report; }

    if (!client.sandbox) {
      await store.upsertCodes(paired.map(s => ({ codeType: "store" as CodeType, company: "", ukgCode: s, destinationCode: String(storeDigits(s)), destinationId: null,
                                                 notes: `Rosnet location ${storeDigits(s)} (${report.clientCode ?? "?"})` })));
      report.written = paired.length;
    }
    // rows a person filled (provisioning/25) that Rosnet does not know
    const existing = await store.allCodes();
    const jobs = new Set(report.jobCodes.map(j => String(j.jobCode))), terms = new Set(report.termCodes.map(t => String(t.terminationCode)));
    for (const m of existing.job.values()) if (!jobs.has(m.destinationCode)) report.staleMappings.push({ codeType: "job", ukgCode: m.ukgCode, destinationCode: m.destinationCode });
    for (const m of existing.termination.values()) if (!terms.has(m.destinationCode)) report.staleMappings.push({ codeType: "termination", ukgCode: m.ukgCode, destinationCode: m.destinationCode });
    for (const m of existing.store.values()) if (!known.has(Number(m.destinationCode))) report.staleMappings.push({ codeType: "store", ukgCode: m.ukgCode, destinationCode: m.destinationCode });
    return report;
  }

  // ---- employees -> xref 'extract' ----
  const companies = new Set(opts.companies.map(c => c.toUpperCase()));
  const hub = (await store.employeesWithoutXref()).filter(h => companies.has((h.companyId ?? "").toUpperCase()));
  const rosnet: EdtEmployee[] = [];
  const failed: number[] = [];
  for (const n of locationNumbers) {
    try { rosnet.push(...await client.locationEmployees(n)); }
    catch (e: any) { failed.push(n); log(`discover employees location ${n}: ${String(e?.message ?? "error").slice(0, 200)}`); }
  }
  // one row per person: an active profile wins over a terminated one (a transferred employee is listed at both stores)
  const best = new Map<string, EdtEmployee>();
  for (const e of rosnet) { const cur = best.get(e.uid.toUpperCase()); if (!cur || (cur.terminated && !e.terminated)) best.set(e.uid.toUpperCase(), e); }
  const people = [...best.values()];

  const byId = new Map(hub.map(h => [h.employeeId.toUpperCase(), h]));
  const byNumber = new Map<string, typeof hub>();
  for (const h of hub) { const k = norm(h.employeeNumber); if (k) byNumber.set(k, [...(byNumber.get(k) ?? []), h]); }
  const rosnetByNumber = new Map<string, number>();
  for (const e of people) { const k = norm(e.payrollId); if (k) rosnetByNumber.set(k, (rosnetByNumber.get(k) ?? 0) + 1); }

  const rows: ({ employeeId: string; externalId: string; source: "extract" } & XrefIds)[] = [];
  const linked = new Set<string>();
  let byUid = 0, byPayroll = 0, mismatch = 0;
  const link = (h: { employeeId: string }, e: EdtEmployee) => { linked.add(h.employeeId); rows.push({ employeeId: h.employeeId, externalId: e.uid, source: "extract", payrollId: e.payrollId, posId: e.posId }); };
  for (const e of people) {                                                 // the UKG employee id is the POS UID we send: an exact match
    const h = byId.get(e.uid.toUpperCase());
    if (h && !linked.has(h.employeeId)) { link(h, e); byUid++; }
  }
  for (const e of people) {                                                 // otherwise the payroll id is the key, the last name a sanity check
    if (rows.some(r => r.externalId === e.uid)) continue;
    const k = norm(e.payrollId);
    const candidates = (byNumber.get(k) ?? []).filter(h => !linked.has(h.employeeId));
    for (const h of candidates) {
      if (!sameName(e.lastName, h.lastName) && (candidates.length !== 1 || rosnetByNumber.get(k) !== 1)) { mismatch++; continue; }
      link(h, e); byPayroll++;
      break;
    }
  }
  if (!client.sandbox) { await store.upsertXrefMany(rows); report.written = rows.length; }
  report.employees = { rosnet: people.length, active: people.filter(e => !e.terminated).length, hubWithoutXref: hub.length, matched: rows.length,
                       byUid, byPayrollId: byPayroll, lastNameMismatch: mismatch, locationsFailed: failed };
  return report;
}
