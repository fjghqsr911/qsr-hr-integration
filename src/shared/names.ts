/*
  Name comparison shared by the connectors: an employee number (or other id) is the key, the last name is only a sanity
  check, so punctuation, spaces, case and accents must not make two spellings of one name differ.
*/

/** Letters only, upper-cased, accents stripped: O'Brien / OBRIEN / O Brien / Ó Brien compare equal. */
export const foldName = (s: unknown) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
/** Same last name ignoring punctuation, spaces, case and accents; never true for an empty name. */
export const sameName = (a: unknown, b: unknown) => { const x = foldName(a); return x !== "" && x === foldName(b); };
