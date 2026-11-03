import { createHash } from "crypto";

/*
  Generic delivery runner: drains out.deliveries for one destination (Clearview today, Rosnet in phase 6).
  Pure logic over the DeliveryStore / Connector / UkgSensitiveSource interfaces so it is testable with fakes.

  Per run:  lock (stage.sync_runs run_type 'delivery') -> claim a batch (per-employee blocking rule, action order)
            -> per delivery: re-read the store mode, read what the action needs from UKG, plan -> hash
               -> shadow (masked copy stored) | live (unchanged by hash, else execute and record last_sent + xref)
            -> resolveCreated (imports Payroll has added) -> purge old shadow payloads -> queue summary log line.
  Never logs or stores SIN, date of birth or pay in clear: payloads are masked by the connector before storage, log lines
  carry ids, counts and Clearview messages only.
*/

export type DeliveryAction = "create" | "job" | "store" | "pay" | "update" | "terminate";
export const ACTION_RANK: Record<DeliveryAction, number> = { create: 0, job: 1, store: 2, pay: 3, update: 4, terminate: 5 };

/** Retry schedule for transient failures: after the 1st failure wait 5 min, then 30 min, 2 h, 12 h; the 5th failure is dead. */
export const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000];
export const WAITING_DELAY_MS = 3600_000;

export interface ClaimedDelivery {
  deliveryId: number; destination: string; employeeId: string; eventKey: Buffer | null;
  kind: "event" | "removed"; eventType: string; action: DeliveryAction | null; effectiveDate: string; store: string | null;
  status: "pending" | "failed" | "waiting"; attempts: number;
}

export interface EventContext {
  eventType: string; effectiveDate: string; fromCompany: string | null; toCompany: string | null;
  fromStore: string | null; toStore: string | null; fromJob: string | null; toJob: string | null; terminationCategory: string | null;
}

export interface EmploymentContext {
  employeeId: string; companyId: string; employeeNumber: string | null; isHomeCompany: boolean | null;
  employeeStatus: string | null; originalHireDate: string | null; lastHireDate: string | null; terminationDate: string | null;
  orgLevel2: string | null; jobCode: string | null; fullOrPartTime: string | null;
  firstName: string | null; preferredName: string | null; lastName: string | null;
}

export interface DestinationCode { ukgCode: string; company: string; destinationCode: string; destinationId: string | null; }
export type CodeType = "store" | "job" | "termination" | "category" | "company";
/** Per code type: codeKey(company, ukgCode) -> mapping. company '' = shared by every organization (stores, company rows);
 *  a company-specific row (jobs, termination reasons differ per Clearview organization) wins over the shared one. */
export type CodeMaps = Record<CodeType, Map<string, DestinationCode>>;
export const codeKey = (company: string | null | undefined, ukgCode: string) => `${(company ?? "").trim().toUpperCase()}|${ukgCode.trim().toUpperCase()}`;
export function findCode(codes: CodeMaps, type: CodeType, company: string | null | undefined, ukgCode: string | null | undefined): DestinationCode | undefined {
  if (!ukgCode) return undefined;
  return codes[type].get(codeKey(company, ukgCode)) ?? codes[type].get(codeKey("", ukgCode));
}

export interface DeliveryContext {
  delivery: ClaimedDelivery;
  event: EventContext | null;                       // null when the event no longer exists
  employment: EmploymentContext | null;             // the employment record the event belongs to
  xref: { externalId: string; source: string } | null;
  codes: CodeMaps;
  storeMode: "off" | "shadow" | "live";             // re-read at send time
  lastSent: Map<string, Buffer>;                    // operation -> payload hash of what was last sent live
}

/** What a connector may ask the runner to read from UKG at send time. */
export type SensitiveNeed = "person" | "pay";
export interface Sensitive {
  sin: string | null; dateOfBirth: string | null; email: string | null;     // person details
  salaryOrHourly: string | null; hourlyPayRate: number | null; annualSalary: number | null;   // employment details
}
export const EMPTY_SENSITIVE: Sensitive = { sin: null, dateOfBirth: null, email: null, salaryOrHourly: null, hourlyPayRate: null, annualSalary: null };

export interface UkgSensitiveSource {
  person(employeeId: string): Promise<Pick<Sensitive, "sin" | "dateOfBirth" | "email"> | null>;
  pay(employeeId: string): Promise<Pick<Sensitive, "salaryOrHourly" | "hourlyPayRate" | "annualSalary"> | null>;
}

export interface PlanStep { method: "GET" | "POST" | "PUT" | "PATCH"; path: string; body?: unknown; note?: string; }
export interface Plan { operation: string; steps: PlanStep[]; payload: unknown; }
export type PlanOutcome =
  | { decision: "send"; plan: Plan }
  | { decision: "skipped"; reason: string }
  | { decision: "review"; reason: string };

/** Thrown by a connector's plan() when a code has no mapping or a value fails validation: the delivery is dead at once. */
export class MappingError extends Error {}

/** Thrown by a connector's execute() to classify a failure (the runner treats any other error as transient). */
export class DeliveryError extends Error {
  constructor(public kind: "retry" | "dead" | "waiting" | "abort", message: string) { super(message); }
}

export interface ExecuteResult {
  responseRef: string | null;
  warning?: string;                                                  // recorded in last_error, delivery still sent
  xref?: { externalId: string; source: "created" | "matched" };      // Clearview id learned on the way
}

export interface PendingCreate { deliveryId: number; employeeId: string; companyId: string | null; employeeNumber: string | null; lastName: string | null; finishedUtc: Date; }

export interface Connector {
  readonly destination: string;
  hasCredentials(companyId: string | null): boolean;
  sensitiveNeeds(ctx: DeliveryContext): SensitiveNeed[];
  plan(ctx: DeliveryContext, sensitive: Sensitive): PlanOutcome;
  redactForHash(payload: unknown): unknown;
  redactForStore(payload: unknown): unknown;
  execute(plan: Plan, ctx: DeliveryContext): Promise<ExecuteResult>;
  resolveCreated(pending: PendingCreate): Promise<{ externalId: string; source: "created" | "matched" } | null>;
}

export interface QueueStats { pending: number; waiting: number; failed: number; dead: number; oldestPendingMinutes: number | null; }

export interface DeliveryStore {
  isRunning(): Promise<boolean>;
  startRun(): Promise<string>;
  finishRun(runId: string, status: "succeeded" | "partial" | "failed", counts: { processed: number; calls: number }, error?: string): Promise<void>;
  claim(destination: string, limit: number): Promise<ClaimedDelivery[]>;
  loadContext(delivery: ClaimedDelivery): Promise<DeliveryContext>;
  markShadow(deliveryId: number, hash: Buffer, storedPayload: string, operation: string): Promise<void>;
  markSent(deliveryId: number, hash: Buffer, operation: string, responseRef: string | null, warning: string | null): Promise<void>;
  markUnchanged(deliveryId: number, hash: Buffer): Promise<void>;
  markFailed(deliveryId: number, attempts: number, nextAttemptUtc: Date, error: string): Promise<void>;
  markDead(deliveryId: number, attempts: number, error: string): Promise<void>;
  markWaiting(deliveryId: number, nextAttemptUtc: Date, reason: string): Promise<void>;
  markSkipped(deliveryId: number, reason: string): Promise<void>;
  markReview(deliveryId: number, reason: string): Promise<void>;
  upsertXref(destination: string, employeeId: string, externalId: string, source: "created" | "matched"): Promise<void>;
  pendingCreates(destination: string): Promise<PendingCreate[]>;
  queueStats(destination: string): Promise<QueueStats>;
  purgeShadowPayloads(destination: string, retentionDays: number): Promise<number>;
}

export interface RunOptions {
  liveEnabled: boolean;
  maxPerRun: number;
  waitingAlertDays: number;
  shadowRetentionDays: number;
  now?: () => Date;
  log?: (m: string) => void;
  warn?: (m: string) => void;
  error?: (m: string) => void;
}

export interface RunResult {
  status: "succeeded" | "partial" | "failed" | "skipped";
  destination: string; claimed: number; sent: number; shadow: number; unchanged: number; skipped: number; review: number;
  failed: number; dead: number; waiting: number; resolved: number; purged: number; message?: string;
  queue?: QueueStats;
}

// ---------------------------------------------------------------- helpers ----------------------------------------------------------------
/** JSON with object keys sorted and null / undefined members dropped, so the same payload always hashes the same. */
export function canonicalJson(value: unknown): string {
  const walk = (v: any): any => {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) return v.map(x => { const w = walk(x); return w === undefined ? null : w; });
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) { const w = walk(v[k]); if (w !== undefined) out[k] = w; }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value) ?? null);
}

export function payloadHash(redacted: unknown): Buffer {
  return createHash("sha256").update(canonicalJson(redacted), "utf8").digest();
}

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const errorText = (e: any) => clip(String(e?.message ?? "error").replace(/[\r\n]+/g, " "));

/** Orders a claimed batch the way the SQL does, so fakes and SQL agree: employee, effective date, action rank, id. */
export function orderDeliveries<T extends { employeeId: string; effectiveDate: string; action: DeliveryAction | null; deliveryId: number }>(rows: T[]): T[] {
  const rank = (a: DeliveryAction | null) => (a ? ACTION_RANK[a] ?? 9 : 9);
  return [...rows].sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.effectiveDate.localeCompare(b.effectiveDate)
    || rank(a.action) - rank(b.action) || a.deliveryId - b.deliveryId);
}

/** The employment record an event belongs to: the event's company, else the home company, else the first. */
export function pickEmployment(rows: EmploymentContext[], event: EventContext | null): EmploymentContext | null {
  if (!rows.length) return null;
  const company = event?.toCompany ?? event?.fromCompany ?? null;
  return (company && rows.find(r => r.companyId === company)) || rows.find(r => r.isHomeCompany) || rows[0];
}

// ---------------------------------------------------------------- runner ----------------------------------------------------------------
export async function runDeliveries(store: DeliveryStore, connector: Connector, ukg: UkgSensitiveSource, opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {}), warn = opts.warn ?? log, error = opts.error ?? log;
  const now = opts.now ?? (() => new Date());
  const destination = connector.destination;
  const r: RunResult = { status: "succeeded", destination, claimed: 0, sent: 0, shadow: 0, unchanged: 0, skipped: 0, review: 0,
                         failed: 0, dead: 0, waiting: 0, resolved: 0, purged: 0 };

  if (await store.isRunning()) return { ...r, status: "skipped", message: "Another delivery run is in progress" };
  const runId = await store.startRun();
  let calls = 0;
  let aborted: string | null = null;
  const sensitiveCache = new Map<string, Sensitive>();
  let shadowWarned = false;

  try {
    const batch = orderDeliveries(await store.claim(destination, opts.maxPerRun));
    r.claimed = batch.length;
    log(`claimed ${batch.length} delivery(ies) for ${destination}`);
    const stopped = new Set<string>();                       // employees whose later deliveries wait for the next run

    for (const d of batch) {
      if (aborted) break;
      if (stopped.has(d.employeeId)) continue;
      const stop = () => stopped.add(d.employeeId);

      const ctx = await store.loadContext(d);
      if (ctx.storeMode === "off") { await store.markSkipped(d.deliveryId, "store switched off"); r.skipped++; continue; }
      if (!ctx.event) { await store.markDead(d.deliveryId, d.attempts, "event no longer exists in rpt.workforce_events"); r.dead++; stop(); continue; }
      if (!ctx.employment) { await store.markDead(d.deliveryId, d.attempts, "employee not in stage.employment_current"); r.dead++; stop(); continue; }

      const company = ctx.employment.companyId;
      const credentials = connector.hasCredentials(company);
      let live = ctx.storeMode === "live";
      if (live && (!opts.liveEnabled || !credentials)) {
        live = false;
        if (!shadowWarned) { warn(`${destination}: live stores run as shadow (${!opts.liveEnabled ? "CLEARVIEW_LIVE_ENABLED is not true" : `no credentials for ${company}`})`); shadowWarned = true; }
      }

      try {
        // what the action needs from UKG, read at send time in both modes (so shadow surfaces "SIN missing in UKG")
        const sensitive = await readSensitive(ukg, d.employeeId, connector.sensitiveNeeds(ctx), sensitiveCache, () => calls++);
        const outcome = connector.plan(ctx, sensitive);
        if (outcome.decision === "skipped") { await store.markSkipped(d.deliveryId, outcome.reason); r.skipped++; continue; }
        if (outcome.decision === "review") { await store.markReview(d.deliveryId, outcome.reason); r.review++; stop(); continue; }

        const plan = outcome.plan;
        const hash = payloadHash(connector.redactForHash(plan.payload));
        if (!live) {
          const stored = JSON.stringify({ operation: plan.operation, mode: "shadow", steps: connector.redactForStore(plan.steps), payload: connector.redactForStore(plan.payload) });
          await store.markShadow(d.deliveryId, hash, stored, plan.operation);
          r.shadow++;
          continue;
        }
        const previous = ctx.lastSent.get(plan.operation);
        if (previous && previous.equals(hash)) { await store.markUnchanged(d.deliveryId, hash); r.unchanged++; continue; }

        calls++;
        const result = await connector.execute(plan, ctx);
        if (result.xref) { await store.upsertXref(destination, d.employeeId, result.xref.externalId, result.xref.source); ctx.xref = result.xref; }
        await store.markSent(d.deliveryId, hash, plan.operation, result.responseRef, result.warning ?? null);
        r.sent++;
      } catch (e: any) {
        if (e instanceof MappingError) {
          await store.markDead(d.deliveryId, d.attempts, errorText(e)); r.dead++; stop();
          error(`[delivery] dead: destination=${destination} delivery_id=${d.deliveryId} employee=${d.employeeId} attempts=${d.attempts}`);
          continue;
        }
        const kind: DeliveryError["kind"] = e instanceof DeliveryError ? e.kind : "retry";
        const msg = errorText(e);
        if (kind === "abort") { aborted = msg; error(`${destination}: run aborted, rows untouched: ${msg}`); break; }
        if (kind === "waiting") {
          await store.markWaiting(d.deliveryId, new Date(now().getTime() + WAITING_DELAY_MS), msg); r.waiting++; stop(); continue;
        }
        if (kind === "dead") {
          await store.markDead(d.deliveryId, d.attempts + 1, msg); r.dead++; stop();
          error(`[delivery] dead: destination=${destination} delivery_id=${d.deliveryId} employee=${d.employeeId} attempts=${d.attempts + 1}`);
          continue;
        }
        const attempts = d.attempts + 1;
        if (attempts > RETRY_DELAYS_MS.length) {
          await store.markDead(d.deliveryId, attempts, msg); r.dead++; stop();
          error(`[delivery] dead: destination=${destination} delivery_id=${d.deliveryId} employee=${d.employeeId} attempts=${attempts}`);
          continue;
        }
        await store.markFailed(d.deliveryId, attempts, new Date(now().getTime() + RETRY_DELAYS_MS[attempts - 1]), msg);
        r.failed++; stop();
        log(`delivery ${d.deliveryId} failed (attempt ${attempts}): ${msg}`);
      }
    }

    // imports Payroll has since added: learn Clearview's employeeId so the employee's later deliveries can go
    if (!aborted) {
      for (const p of await store.pendingCreates(destination)) {
        if (!connector.hasCredentials(p.companyId)) continue;
        try {
          calls++;
          const found = await connector.resolveCreated(p);
          if (found) { await store.upsertXref(destination, p.employeeId, found.externalId, found.source); r.resolved++; continue; }
          const days = (now().getTime() - new Date(p.finishedUtc).getTime()) / 86_400_000;
          if (days >= opts.waitingAlertDays)
            error(`[delivery] waiting: destination=${destination} delivery_id=${p.deliveryId} employee=${p.employeeId} days=${Math.floor(days)} import not yet added by Payroll`);
        } catch (e: any) {
          if (e instanceof DeliveryError && e.kind === "abort") { aborted = errorText(e); error(`${destination}: resolveCreated aborted: ${aborted}`); break; }
          log(`resolveCreated ${p.employeeId}: ${errorText(e)}`);
        }
      }
    }

    r.purged = await store.purgeShadowPayloads(destination, opts.shadowRetentionDays);
    r.queue = await store.queueStats(destination);
    log(`[delivery] queue: destination=${destination} pending=${r.queue.pending} oldest_pending_minutes=${r.queue.oldestPendingMinutes ?? 0}`);

    r.status = aborted ? "failed" : (r.failed + r.dead + r.waiting > 0 ? "partial" : "succeeded");
    if (aborted) r.message = aborted;
    await store.finishRun(runId, r.status, { processed: r.sent + r.shadow + r.unchanged + r.skipped + r.review, calls },
      aborted ?? (r.status === "partial" ? `${r.failed} failed, ${r.dead} dead, ${r.waiting} waiting` : undefined));
    return r;
  } catch (e: any) {
    const msg = errorText(e);
    await store.finishRun(runId, "failed", { processed: 0, calls }, msg).catch(() => {});
    error(`${destination}: run failed: ${msg}`);
    return { ...r, status: "failed", message: msg };
  }
}

async function readSensitive(ukg: UkgSensitiveSource, employeeId: string, needs: SensitiveNeed[], cache: Map<string, Sensitive>, count: () => void): Promise<Sensitive> {
  const key = `${employeeId}|${[...needs].sort().join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const s: Sensitive = { ...EMPTY_SENSITIVE };
  if (needs.includes("person")) { count(); Object.assign(s, (await ukg.person(employeeId)) ?? {}); }
  if (needs.includes("pay")) { count(); Object.assign(s, (await ukg.pay(employeeId)) ?? {}); }
  cache.set(key, s);
  return s;
}
