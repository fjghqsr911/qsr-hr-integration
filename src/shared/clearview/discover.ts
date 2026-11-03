import { CodeMaps, CodeType } from "../delivery";
import { ClearviewClient } from "./client";
import { ClearviewApiReads, ClearviewReads } from "./connector";

/*
  Mapping discovery, per Clearview organization key (= per UKG company):
    GET /organization/stores (+ GET /store/{storeId} for tdlNumber and employerCode), /job, /terminationReason,
    /organization/filecontrol?requiredAttributesOnly=true.
  Stores are paired automatically: hub org_level2 digits (T22446 -> 22446) = tdlNumber without its leading 1 (122446),
  never derived from the UKG code (UKG could not hold six digits). Paired stores and the company row are written to
  ref.destination_codes; jobs and termination reasons are listed for a person to pair in provisioning/17.
  what = "employees": GET /organization/employees matched to hub employees by employeeNumber + last name -> xref 'extract'.
  The report holds ids, codes, names of stores / jobs / reasons and counts: never employee names.
*/

export interface DiscoveryStore {
  hubStores(): Promise<string[]>;
  allCodes(): Promise<CodeMaps>;
  upsertCodes(rows: { codeType: CodeType; ukgCode: string; destinationCode: string; destinationId: string | null; notes: string | null }[]): Promise<void>;
  employeesWithoutXref(): Promise<{ employeeId: string; companyId: string; employeeNumber: string | null; lastName: string | null }[]>;
  upsertXrefMany(rows: { employeeId: string; externalId: string; source: "extract" }[]): Promise<void>;
}

export interface OrganizationReport {
  company: string; organizationId: number | null; name: string | null; employerCode: string | null; error?: string;
  stores: { storeId: number; storeNumber: number; name: string; tdlNumber: string | null; status: string | null; pairedWith: string | null }[];
  jobs: { jobId: number; jobCode: number | null; name: string; abbreviation: string | null; status: string | null }[];
  terminationReasons: { terminationReasonId: number; name: string; code: string | null }[];
  mandatoryAttributes: string[];
}

export interface DiscoverReport {
  what: "codes" | "employees";
  organizations: OrganizationReport[];
  stores: { paired: number; written: number; unpairedHub: string[]; unpairedClearview: { company: string; storeId: number; storeNumber: number; tdlNumber: string | null; name: string }[] };
  staleMappings: { codeType: string; ukgCode: string; destinationCode: string; destinationId: string | null }[];
  employees?: { clearview: number; hubWithoutXref: number; matched: number; lastNameMismatch: number; unmatchedHub: number };
}

export const hubDigits = (code: string) => code.replace(/\D/g, "").replace(/^0+/, "");
/** tdlNumber "122446" -> "22446"; the leading 1 is the TDL prefix. */
export const tdlDigits = (tdl: string | null | undefined) => { const d = String(tdl ?? "").replace(/\D/g, ""); return d.startsWith("1") && d.length >= 2 ? d.slice(1).replace(/^0+/, "") : null; };

const normNumber = (n: unknown) => String(n ?? "").trim().replace(/^0+/, "");

export async function discover(client: ClearviewClient, store: DiscoveryStore, opts: { companies: string[]; what?: "codes" | "employees"; log?: (m: string) => void; reads?: ClearviewReads }): Promise<DiscoverReport> {
  const log = opts.log ?? (() => {});
  const reads = opts.reads ?? new ClearviewApiReads(client);          // Get Employees product: employee list, termination reasons
  const what: "codes" | "employees" = opts.what === "employees" ? "employees" : "codes";
  const hubStores = await store.hubStores();
  const byDigits = new Map(hubStores.map(s => [hubDigits(s), s]));
  const paired = new Map<string, { company: string; storeId: number; storeNumber: number; name: string; tdl: string; org: number | null }>();
  const report: DiscoverReport = { what, organizations: [], stores: { paired: 0, written: 0, unpairedHub: [], unpairedClearview: [] }, staleMappings: [] };
  const codeRows: Parameters<DiscoveryStore["upsertCodes"]>[0] = [];
  const knownJobIds = new Set<string>(), knownJobCodes = new Set<string>(), knownReasonIds = new Set<string>(), knownStoreIds = new Set<string>();

  for (const company of opts.companies) {
    if (!client.hasKey(company)) { report.organizations.push({ company, organizationId: null, name: null, employerCode: null, error: "no authorizationKey", stores: [], jobs: [], terminationReasons: [], mandatoryAttributes: [] }); continue; }
    const org: OrganizationReport = { company, organizationId: null, name: null, employerCode: null, stores: [], jobs: [], terminationReasons: [], mandatoryAttributes: [] };
    report.organizations.push(org);
    try {
      if (what === "codes") {
        const o = await client.get(company, "/organization/stores", { includeInactiveStores: false });
        org.organizationId = Number(o?.organizationId) || null; org.name = o?.name ?? null;
        for (const s of (o?.stores ?? []) as any[]) {
          const detail = await client.getOrNull(company, `/store/${s.storeId}`);
          const tdl = detail?.tdlNumber ?? null;
          if (!org.employerCode && detail?.employerCode) org.employerCode = String(detail.employerCode);
          const digits = tdlDigits(tdl);
          const hub = digits ? byDigits.get(digits) ?? null : null;
          knownStoreIds.add(String(s.storeId));
          org.stores.push({ storeId: Number(s.storeId), storeNumber: Number(s.storeNumber), name: String(s.name ?? s.displayName ?? ""), tdlNumber: tdl ? String(tdl) : null, status: s.status ?? null, pairedWith: hub });
          if (hub) paired.set(hub, { company, storeId: Number(s.storeId), storeNumber: Number(s.storeNumber), name: String(s.name ?? ""), tdl: String(tdl), org: org.organizationId });
          else report.stores.unpairedClearview.push({ company, storeId: Number(s.storeId), storeNumber: Number(s.storeNumber), tdlNumber: tdl ? String(tdl) : null, name: String(s.name ?? "") });
        }
        if (org.organizationId) codeRows.push({ codeType: "company", ukgCode: company, destinationCode: String(org.organizationId), destinationId: null,
                                                notes: [org.employerCode ? `employerCode ${org.employerCode}` : null, org.name].filter(Boolean).join(" · ").slice(0, 200) || null });
        const jobs: any[] = (await client.get(company, "/job", { includeInactiveJobs: false })) ?? [];
        for (const j of jobs) {
          org.jobs.push({ jobId: Number(j.jobId), jobCode: j.jobCode === null || j.jobCode === undefined ? null : Number(j.jobCode), name: String(j.jobName ?? j.name ?? ""), abbreviation: j.jobAbbreviation ?? null, status: j.jobStatus ?? null });
          knownJobIds.add(String(j.jobId)); if (j.jobCode !== null && j.jobCode !== undefined) knownJobCodes.add(String(j.jobCode));
        }
        const reasons: any[] = await reads.terminationReasons(company);
        for (const t of reasons) { org.terminationReasons.push({ terminationReasonId: Number(t.terminationReasonId), name: String(t.name ?? ""), code: t.code ?? null }); knownReasonIds.add(String(t.terminationReasonId)); }
        const attrs: any[] = (await client.get(company, "/organization/filecontrol", { requiredAttributesOnly: true, includedAttributesOnly: false })) ?? [];
        org.mandatoryAttributes = attrs.filter(a => a?.isRequired !== false).map(a => String(a.attributeName ?? a.attributeId ?? "")).filter(Boolean);
      }
    } catch (e: any) {
      org.error = String(e?.message ?? "error").slice(0, 300);
      log(`discover ${company}: ${org.error}`);
    }
  }

  if (what === "codes") {
    for (const [hub, p] of paired) {
      codeRows.push({ codeType: "store", ukgCode: hub, destinationCode: String(p.storeNumber), destinationId: String(p.storeId),
                      notes: `org ${p.org ?? "?"} · tdl ${p.tdl} · ${p.name}`.slice(0, 200) });
    }
    report.stores.paired = paired.size;
    report.stores.unpairedHub = hubStores.filter(s => !paired.has(s));
    await store.upsertCodes(codeRows);
    report.stores.written = codeRows.length;

    // mappings Clearview no longer knows (only for types the organizations answered for)
    const existing = await store.allCodes();
    const anyOrg = report.organizations.some(o => !o.error);
    if (anyOrg) {
      for (const [ukg, m] of existing.job) if (!knownJobIds.has(String(m.destinationId ?? "")) && !knownJobCodes.has(m.destinationCode)) report.staleMappings.push({ codeType: "job", ukgCode: ukg, destinationCode: m.destinationCode, destinationId: m.destinationId });
      for (const [ukg, m] of existing.termination) if (!knownReasonIds.has(String(m.destinationId ?? m.destinationCode))) report.staleMappings.push({ codeType: "termination", ukgCode: ukg, destinationCode: m.destinationCode, destinationId: m.destinationId });
      for (const [ukg, m] of existing.store) if (m.destinationId && !knownStoreIds.has(m.destinationId)) report.staleMappings.push({ codeType: "store", ukgCode: ukg, destinationCode: m.destinationCode, destinationId: m.destinationId });
    }
    return report;
  }

  // ---- employees extract -> xref 'extract' ----
  const hub = await store.employeesWithoutXref();
  const byNumber = new Map<string, typeof hub>();
  for (const h of hub) { if (!h.employeeNumber) continue; const k = normNumber(h.employeeNumber); byNumber.set(k, [...(byNumber.get(k) ?? []), h]); }
  const rows: { employeeId: string; externalId: string; source: "extract" }[] = [];
  const matchedIds = new Set<string>();
  let clearviewCount = 0, mismatch = 0;
  for (const org of report.organizations) {
    if (org.error) continue;
    try {
      const o = await reads.organizationEmployees(org.company, true);
      org.organizationId = Number(o?.organizationId) || null; org.name = o?.name ?? null;
      for (const e of (o?.employees ?? []) as any[]) {
        clearviewCount++;
        const candidates = byNumber.get(normNumber(e.employeeNumber)) ?? [];
        for (const h of candidates) {
          if (matchedIds.has(h.employeeId)) continue;
          if (!sameLast(e.lastName, h.lastName)) { mismatch++; continue; }
          matchedIds.add(h.employeeId);
          rows.push({ employeeId: h.employeeId, externalId: String(e.employeeId), source: "extract" });
        }
      }
    } catch (e: any) { org.error = String(e?.message ?? "error").slice(0, 300); log(`discover employees ${org.company}: ${org.error}`); }
  }
  await store.upsertXrefMany(rows);
  report.employees = { clearview: clearviewCount, hubWithoutXref: hub.length, matched: rows.length, lastNameMismatch: mismatch, unmatchedHub: hub.length - rows.length };
  return report;
}

const sameLast = (a: unknown, b: unknown) => String(a ?? "").trim().toUpperCase() === String(b ?? "").trim().toUpperCase() && String(a ?? "").trim() !== "";
