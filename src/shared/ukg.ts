import { config } from "./config";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;          // 1 try + 3 retries (2s, 4s, 8s)
const TIMEOUT_MS = 30_000;

export class UkgError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function headers(): Record<string, string> {
  const basic = Buffer.from(`${config.ukgUsername}:${config.ukgPassword}`, "utf8").toString("base64");
  return {
    Authorization: `Basic ${basic}`,
    "US-Customer-Api-Key": config.ukgCustomerApiKey,
    Accept: "application/json"
  };
}

/** GET a UKG Pro REST path (e.g. "/personnel/v1/employee-changes?..."). Returns parsed JSON. */
export async function ukgGet<T = any>(path: string): Promise<T> {
  const url = config.ukgBaseUrl + path;
  const safePath = path.split("?")[0];   // never put query strings in errors/logs
  const hdrs = headers();                // throws immediately (no retries) if a setting is missing

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e: any) {
      if (attempt < MAX_ATTEMPTS) { await sleep(1000 * 2 ** attempt); continue; }
      throw new UkgError(0, `UKG request failed on ${safePath}: ${e?.name ?? "error"}`);
    }

    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      // 401s are NOT retried: repeated bad logins can lock the service account.
      throw new UkgError(res.status, `UKG ${res.status} on ${safePath}`);
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : []) as T;
  }
}

/** Page through a list endpoint until a short page is returned. */
export async function ukgGetAll<T = any>(path: string, perPage = 100, maxPages = 200): Promise<T[]> {
  const sep = path.includes("?") ? "&" : "?";
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await ukgGet<T[]>(`${path}${sep}page=${page}&per_Page=${perPage}`);
    const rows = Array.isArray(batch) ? batch : [];
    all.push(...rows);
    if (rows.length < perPage) break;
  }
  return all;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
