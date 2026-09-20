// Learned customer aliases — maps a customer's email domain and/or name to a BC
// customer number, built from reps' picks/corrections in the review app. Consulted
// BEFORE name-matching, so a customer the matcher missed (or got wrong) auto-resolves
// on every future email once a human has resolved it once.
//
// Deterministic and inspectable — this is a lookup table, not model "learning".
// Stored locally (data/customer-aliases.json, git-ignored — it holds customer PII).
// A pick overwrites any previous alias for that domain/name, so corrections stick.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normName } from "../step4-bc-verification/verify.js";

const ALIAS_FILE = process.env.ALIAS_FILE || "data/customer-aliases.json";
// Emails forwarded internally arrive from our own domain, so it must never be used
// as a customer key (it would map "buckeyefasteners.com" to whichever customer).
const INTERNAL_DOMAINS = new Set(["buckeyefasteners.com", "fastenerind.com"]);

const empty = () => ({ byDomain: {}, byName: {} });
function load() {
  try { const o = JSON.parse(readFileSync(ALIAS_FILE, "utf8")); return { byDomain: o.byDomain || {}, byName: o.byName || {} }; }
  catch { return empty(); }
}
function save(store) {
  mkdirSync(dirname(ALIAS_FILE), { recursive: true });
  writeFileSync(ALIAS_FILE, JSON.stringify(store, null, 2));
}

export function domainOf(email) {
  const d = String(email || "").split("@")[1]?.toLowerCase().trim() || "";
  return d && !INTERNAL_DOMAINS.has(d) ? d : "";
}
const nameKey = (name) => normName(name || ""); // same normalization the matcher uses

// Find a saved customer for this order's email domain (preferred) or name. -> {number, name, via} | null
export function lookupAlias({ email, name } = {}) {
  const store = load();
  const d = domainOf(email);
  if (d && store.byDomain[d]) return { ...store.byDomain[d], via: `alias: ${d}` };
  const nk = nameKey(name);
  if (nk && store.byName[nk]) return { ...store.byName[nk], via: "alias: name" };
  return null;
}

// Record a rep's pick/correction. Writes both keys (domain when non-internal, name).
// Overwrites any prior mapping, so a correction replaces a wrong alias.
export function setAlias({ email, name, number, customerName } = {}) {
  if (!number) return;
  const store = load();
  const rec = { number, name: customerName || "", updated: new Date().toISOString() };
  const d = domainOf(email);
  if (d) store.byDomain[d] = rec;
  const nk = nameKey(name);
  if (nk) store.byName[nk] = rec;
  save(store);
}

export function listAliases() { return load(); }
