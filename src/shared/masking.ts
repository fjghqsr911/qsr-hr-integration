import { payloadHash } from "./delivery";

/*
  Masking of sensitive values in connector payloads, shared by every destination (moved here from clearview/mapper.ts).
  Keys are matched case-insensitively at any depth. Two copies are derived from a payload:
    redactForHash   DOB, SIN and email masked, pay kept: the payload hash must change when a rate changes, and nothing
                    derived from SIN, DOB or email may survive in it
    redactForStore  DOB, SIN, email and pay masked: the copy kept in out.shadow_payloads for admins to inspect
  The payload a connector actually sends is never passed through here.
*/

export const DOB_MASK = "****-**-**", SIN_MASK = "*********", PAY_MASK = "***", EMAIL_MASK = "***@***";
const SIN_KEYS = new Set(["sin", "sinno", "nationalid", "ssn"]);
const EMAIL_KEYS = new Set(["email", "emailaddress", "personalemail", "emailid"]);     // contact details are sensitive tier: masked like SIN
const DOB_KEYS = new Set(["birthdate", "dateofbirth", "dob"]);
const PAY_KEYS = new Set(["payrate", "hourlypayrate", "annualsalary"]);

function redact(value: unknown, maskPay: boolean): unknown {
  const walk = (v: any, key: string | null): any => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (typeof v === "object") { const o: Record<string, unknown> = {}; for (const k of Object.keys(v)) o[k] = walk(v[k], k.toLowerCase()); return o; }
    if (key && SIN_KEYS.has(key)) return SIN_MASK;
    if (key && DOB_KEYS.has(key)) return DOB_MASK;
    if (key && EMAIL_KEYS.has(key)) return EMAIL_MASK;
    if (maskPay && key && PAY_KEYS.has(key)) return PAY_MASK;
    return v;
  };
  return walk(value, null);
}

/** Masks DOB, SIN and email but keeps pay (a rate change must change the hash). Nothing derived from SIN, DOB or email survives. */
export const redactForHash = (payload: unknown) => redact(payload, false);
/** Masks DOB, SIN, email and pay: the copy kept in out.shadow_payloads for admins to inspect. */
export const redactForStore = (payload: unknown) => redact(payload, true);
export const hashPayload = (payload: unknown): Buffer => payloadHash(redactForHash(payload));
