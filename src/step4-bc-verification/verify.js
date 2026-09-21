// Read-only Business Central order verification — v1 rules (see VERIFICATION-RULES.md).
// Takes an extracted order (Step-2 shape) and returns pass/flag per rule. Nothing
// is written to BC. No Claude API calls — pure OData reads, free.
//
// v1 implements:
//   Rule 1  Customer resolves            (fuzzy name/email match — best-effort, v1)
//   Rule 2  Every line item resolves      (DIRECT: part # -> items.number, then
//                                          CROSS-REF: customer part # -> our item #
//                                          via the live Item_References_Excel OData
//                                          service, narrowed to the resolved customer.)
//   Rule 3  Every line in stock           (items.inventory >= quantity ordered)
//   Rule 4  All-or-nothing across lines
//
// Usage:
//   NODE_OPTIONS=--use-system-ca node src/step4-bc-verification/verify.js --order path/to/order.json
//   NODE_OPTIONS=--use-system-ca node src/step4-bc-verification/verify.js --selftest
// (no args prints usage — nothing runs without --order or --selftest)
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env.BC_BASE_URL || "").replace(/\/$/, "");
const USER = process.env.BC_USERNAME;
const PASS = process.env.BC_PASSWORD;
const COMPANY = process.env.BC_COMPANY;
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
// Classic OData v4 web-services root (same server, /ODataV4 instead of /api/v2.0).
// The standard API v2.0 does not expose item references; the published
// `Item_References_Excel` page does (a LIVE view of the Item Reference table).
const ODBASE = BASE.replace(/\/api\/v2\.0$/i, "/ODataV4");
// Contact/email as a HARD gate (Rule 5). Off by default — BC lacks per-customer buyer
// emails today, so gating on it reviews nearly every order. Flip on once BC is populated.
const CONTACT_GATE = process.env.CONTACT_GATE === "1";

async function get(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}/${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: AUTH, Accept: "application/json" } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}
async function getAll(firstPath) {
  const rows = [];
  let next = firstPath;
  while (next) {
    const r = await get(next);
    if (!r.ok) return { ok: false, status: r.status, text: r.text, rows };
    rows.push(...(r.json?.value || []));
    next = r.json?.["@odata.nextLink"] || null;
  }
  return { ok: true, rows };
}
const odataStr = (s) => `'${String(s).replace(/'/g, "''")}'`; // escape single quotes

// --- customer-matching config (ONE place to tune; rules are expected to change) ---
// Everything the Rule-1 matcher does is driven by this object. To change matching
// behavior, edit here — no need to touch the scoring logic below.
const MATCH = {
  // Match policy: a candidate qualifies only if it contains ALL of the order's
  // name tokens (whole words, after suffix-strip / abbrev-expand / plural-stem).
  // Matching on a single shared common word ("iron", "engineering") is unsafe in a
  // human-in-the-loop flow, so we prefer to FLAG rather than guess.
  minOrderTokens: 1,   // uniqueness is the confidence signal: if the name's tokens
                       //   match exactly ONE customer we resolve it, even for short
                       //   names ("Mac B", "T/J") — >1 match still flags for a rep.
  minTokenLen: 1,      // keep 1-char tokens — initials like "B"/"T"/"J" are meaningful
  geoTieBreak: true,   // when several candidates qualify, prefer the one whose
                       //   city/state matches the order's ship-to (BC email is a
                       //   shared placeholder, so it can't break ties here)
  // Legal/entity words removed before tokenizing.
  suffixes: new Set(["inc", "incorporated", "llc", "co", "corp", "corporation",
    "company", "ltd", "limited", "lp", "llp", "the", "usa"]),
  // Abbreviation -> canonical, applied per token (fixes e.g. "Mfg" vs "Manufacturing").
  abbrev: {
    mfg: "manufacturing", intl: "international", assoc: "associates",
    svc: "services", svcs: "services", prod: "products", prods: "products",
    ind: "industries", inds: "industries", mach: "machine", fab: "fabrication",
    prec: "precision", mtl: "metal", prods_: "products",
  },
};

const emailDomain = (e) => ((e || "").split("@")[1] || "").toLowerCase().trim();

// Light stem: drop a trailing plural "s" so fastener/fasteners, product/products match.
const stem = (t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

// Strip company legal-entity designators that otherwise become junk match tokens.
// Handles foreign forms (esp. Mexican "S.A. de C.V.", "S. de R.L. de C.V.", "S.A.P.I.")
// as whole phrases — before the dots are split — so we don't leave stray s/r/l/c/v tokens.
function stripEntitySuffixes(x) {
  return (x || "")
    .replace(/\bs\.?\s*a\.?\s*p\.?\s*i\.?(\s+de\s+c\.?\s*v\.?)?/gi, " ") // S.A.P.I. (de C.V.)
    .replace(/\bs\.?\s*a\.?\s*b\.?(\s+de\s+c\.?\s*v\.?)?/gi, " ")         // S.A.B. (de C.V.)
    .replace(/\bs\.?\s*de\s*r\.?\s*l\.?(\s+de\s+c\.?\s*v\.?)?/gi, " ")    // S. de R.L. (de C.V.)
    .replace(/\bs\.?\s*a\.?\s+de\s+c\.?\s*v\.?/gi, " ")                   // S.A. de C.V.
    .replace(/\bde\s+c\.?\s*v\.?/gi, " ")                                 // de C.V.
    .replace(/\bs\.?\s*c\.?\b/gi, " ")                                    // S.C.
    .replace(/\s+/g, " ").trim();
}

function normName(s) {
  const x = stripEntitySuffixes((s || "").toLowerCase());
  return x.replace(/[.,&/]/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
// Tokenize a company name into comparable whole-word tokens (suffixes dropped,
// abbreviations expanded, plurals stemmed). Returns a de-duplicated array.
function tokenize(name) {
  const out = new Set();
  for (let t of normName(name).split(" ")) {
    if (!t || t.length < MATCH.minTokenLen || MATCH.suffixes.has(t)) continue;
    t = MATCH.abbrev[t] || t;
    out.add(stem(t));
  }
  return [...out];
}
const normGeo = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();

async function resolveCompany() {
  const cr = await get("companies");
  if (!cr.ok) throw new Error(`companies -> HTTP ${cr.status}`);
  const companies = cr.json?.value || [];
  const c = COMPANY
    ? companies.find((x) => (x.name || "").toLowerCase() === COMPANY.toLowerCase())
    : companies[0];
  if (!c) throw new Error(COMPANY ? `Company "${COMPANY}" not found` : "No companies");
  return c;
}

// Rank the closest BC customers to an order name — for the review-card pick-list
// when we can't confidently auto-resolve. Ranks by shared whole-word tokens, then
// ship-to geo match, then closeness (fewest extra words in the candidate).
function suggestCustomers(order, wantTokens, rows, limit = 3) {
  if (!wantTokens.length) return [];
  const oCity = normGeo(order?.ship_to?.city), oState = normGeo(order?.ship_to?.state);
  const need = Math.max(1, Math.ceil(wantTokens.length / 2)); // at least half the order's words
  const scored = [];
  for (const c of rows) {
    const ct = tokenize(c.displayName);
    const set = new Set(ct);
    const shared = wantTokens.filter((t) => set.has(t)).length;
    if (shared < need) continue;
    const geo = !!oCity && normGeo(c.city) === oCity && (!oState || normGeo(c.state) === oState);
    scored.push({ number: c.number, displayName: c.displayName, city: c.city, state: c.state, shared, of: wantTokens.length, geo, extra: ct.length - shared });
  }
  scored.sort((a, b) => b.shared - a.shared || (b.geo - a.geo) || a.extra - b.extra);
  return scored.slice(0, limit);
}

// Detect multiple PO numbers merged into one extraction (one email carried 2+ POs,
// e.g. "MTMX33819; MTMX33818"). We can't reliably assign the merged lines back to
// each PO, so such an order routes to Needs-review for a human to enter separately.
// Conservative: only `;`, `&`, or " and " as separators (NOT `/` or `-`, which occur
// inside real PO numbers), and each side must look like a PO code.
function multiplePOs(poNumber) {
  if (!poNumber) return null;
  const parts = String(poNumber).split(/\s*;\s*|\s*&\s*|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  const poLike = parts.filter((p) => p.length >= 4 && /[A-Za-z0-9][A-Za-z0-9-]{2,}/.test(p));
  return poLike.length >= 2 ? poLike : null;
}

// Rule 1 — customer resolves ------------------------------------------------
// A candidate qualifies iff it contains ALL order name tokens (whole words).
// Exact normalized-name match takes precedence; ties broken by ship-to geo.
// On any non-resolve, attach `suggestions` (top near-matches) for a human to pick.
async function checkCustomer(company, order, custCache) {
  const wantName = normName(order?.customer?.name);
  const wantTokens = tokenize(order?.customer?.name);
  if (!wantName) {
    return { rule: "1 customer", pass: false, detail: "no customer name or email in the order to match on" };
  }
  if (wantTokens.length < MATCH.minOrderTokens) {
    return { rule: "1 customer", pass: false, detail: `customer name "${order?.customer?.name}" is too generic to match confidently (needs ${MATCH.minOrderTokens}+ significant words)` };
  }

  const exact = [], subset = [];
  for (const c of custCache.rows) {
    const cand = { number: c.number, displayName: c.displayName, city: c.city, state: c.state, blocked: c.blocked };
    if (normName(c.displayName) === wantName) { exact.push(cand); continue; }
    const ct = new Set(tokenize(c.displayName));
    if (wantTokens.every((t) => ct.has(t))) subset.push(cand); // contains all order tokens
  }
  let pool = exact.length ? exact : subset;
  const via = exact.length ? "exact name" : "all-tokens";
  if (pool.length === 0) {
    return { rule: "1 customer", pass: false, detail: `no exact BC customer for "${order?.customer?.name}"`, suggestions: suggestCustomers(order, wantTokens, custCache.rows) };
  }

  // Tie-break on ship-to city/state when several candidates qualify.
  let brokeBy = null;
  if (pool.length > 1 && MATCH.geoTieBreak) {
    const oCity = normGeo(order?.ship_to?.city), oState = normGeo(order?.ship_to?.state);
    if (oCity) {
      const geo = pool.filter((t) => normGeo(t.city) === oCity && (!oState || normGeo(t.state) === oState));
      if (geo.length === 1) { pool = geo; brokeBy = "ship-to city/state"; }
    }
  }
  if (pool.length > 1) {
    const suggestions = pool.slice(0, 4).map((c) => ({ ...c, shared: wantTokens.length, of: wantTokens.length, geo: normGeo(c.city) === normGeo(order?.ship_to?.city) }));
    return { rule: "1 customer", pass: false, detail: `ambiguous — ${pool.length} customers match; pick one`, suggestions };
  }
  return { rule: "1 customer", pass: true, detail: `resolved to ${pool[0].number} (${pool[0].displayName}) [via ${via}${brokeBy ? ` + ${brokeBy}` : ""}]`, match: pool[0] };
}

// Fetch one item record by our item number (for inventory/UoM after resolution).
// Part numbers are formatted inconsistently: BC has "HW 4432" / "2004-1", customers
// reformat on POs ("HW4432", "2004 1"). Normalize case, whitespace and hyphens.
// Slash is KEPT (one real item — BF CI1/42 — contains one), but matched BOTH ways:
// a part is looked up with the slash and with it removed, so "/2004" and "2004" both hit.
const stripSD = (s) => (s || "").toUpperCase().replace(/[\s-]+/g, ""); // upper, no space/hyphen; slash kept
const noSlash = (k) => k.replace(/\//g, "");
const normPart = (s) => noSlash(stripSD(s)); // fully normalized (slash-insensitive) — used by cross-ref

// Customers often cite OUR part number in the line description as a vendor part
// number, e.g. "(V.PN# WPM 08002)" or "V.PN# HS3 5811". When the part fields don't
// resolve, mine this as a fallback candidate for a direct (our-item) match.
function vendorPartFromDesc(desc) {
  const m = String(desc || "").match(/v\.?\s*p\.?\s*n\.?\s*#?\s*:?\s*([A-Za-z0-9][A-Za-z0-9 .\/-]*?)\s*(?:\)|\]|—|,|;|$)/i);
  return m ? m[1].trim() : null;
}

// Item index: our whole item master, keyed by BOTH the slash-kept and slash-removed
// normalized forms, so a part matches whether or not the slash is present, while the
// slash stays real for the item that has one. Loaded once, cached for the process.
let ITEM_INDEX = null;
async function buildItemIndex(company) {
  if (ITEM_INDEX) return ITEM_INDEX;
  const res = await getAll(`companies(${company.id})/items?$select=number,displayName,inventory,blocked,baseUnitOfMeasureCode`);
  if (!res.ok) throw new Error(`items read -> HTTP ${res.status}`);
  const idx = new Map();
  const add = (k, it) => { if (k) (idx.get(k) || idx.set(k, []).get(k)).push(it); };
  for (const it of res.rows) {
    const k = stripSD(it.number);   // slash kept, e.g. "BFCI1/42"
    add(k, it);
    const k2 = noSlash(k);          // slash removed, e.g. "BFCI142"
    if (k2 !== k) add(k2, it);
  }
  ITEM_INDEX = idx;
  return idx;
}
// Resolve a part string to a single item, trying both the slash-kept and
// slash-removed forms. -> { item } | { ambiguous:[numbers] } | { item:null }
async function resolveItem(company, pn) {
  const idx = await buildItemIndex(company);
  const k = stripSD(pn), k2 = noSlash(k);
  const hits = [...(idx.get(k) || []), ...(k2 !== k ? (idx.get(k2) || []) : [])];
  if (!hits.length) return { item: null };
  const distinct = [...new Map(hits.map((h) => [h.number, h])).values()];
  return distinct.length > 1 ? { ambiguous: distinct.map((d) => d.number) } : { item: distinct[0] };
}

// Cross-reference lookup against the LIVE Item_References_Excel OData service:
// customer part # -> our item #. Whitespace-insensitive; prefers the resolved
// customer's own refs but also catches refs with a blank customer number.
async function crossRefItems(company, custNo, partNo) {
  const want = normPart(partNo);
  const base = `${ODBASE}/Company(${odataStr(company.name)})/Item_References_Excel`;
  const found = new Set();
  // (1) exact filter server-side — cheap, catches correctly-formatted refs (any customer).
  const exactUrl = encodeURI(`${base}?$filter=Reference_Type eq 'Customer' and Reference_No eq ${odataStr(partNo)}&$select=Item_No,Reference_Type_No`);
  const ex = await get(exactUrl);
  if (!ex.ok && !custNo) return { ok: false, status: ex.status, items: [] };
  let exRows = ex.ok ? (ex.json?.value || []) : [];
  if (custNo) { const own = exRows.filter((x) => (x.Reference_Type_No || "") === custNo); if (own.length) exRows = own; }
  exRows.forEach((x) => x.Item_No && found.add(x.Item_No));
  // (2) if we know the customer, scan THEIR refs and normalize-match (handles spacing).
  if (custNo) {
    const cUrl = encodeURI(`${base}?$filter=Reference_Type eq 'Customer' and Reference_Type_No eq ${odataStr(custNo)}&$select=Item_No,Reference_No`);
    const cr = await get(cUrl);
    if (cr.ok) (cr.json?.value || []).forEach((x) => { if (normPart(x.Reference_No) === want && x.Item_No) found.add(x.Item_No); });
  }
  return { ok: true, items: [...found] };
}

// Units that mean "one piece" (BC base is usually PCS). An order in one of these
// is safe to treat as a piece count; anything else (100PACK, M=thousand, C=hundred,
// BOX, CASE, …) is a MULTIPLIER — the raw quantity is NOT pieces, so we can't create
// it safely and must route the order to a human. Extend as real units appear.
const PIECE_UOMS = new Set(["EA", "EACH", "EACH.", "PC", "PCS", "PCE", "PIECE", "PIECES", "UN", "UNIT", "UNITS", "ST", "EU"]);
function uomNeedsReview(orderUom, baseUom) {
  if (!orderUom) return false;                              // no unit stated -> assume pieces
  const o = String(orderUom).toUpperCase().trim();
  if (PIECE_UOMS.has(o)) return false;                     // piece-equivalent
  if (baseUom && o === String(baseUom).toUpperCase().trim()) return false; // matches BC base exactly
  return true;                                             // multiplier/other unit -> human must set qty
}

// Rule 2 + 3 — per line: resolve item (direct, then cross-ref), then inventory.
async function checkLine(company, line, custNo) {
  const supplier = (line.supplier_part || "").trim();
  const customer = (line.customer_part || "").trim();
  const qty = line.quantity;
  const label = supplier || customer || line.description || `line ${line.line_no ?? "?"}`;

  // Rule 2, path (a) DIRECT — try supplier PN, then customer PN, then a vendor P/N
  // mined from the description, each as our items.number (whitespace/-/-insensitive).
  const vpn = vendorPartFromDesc(line.description);
  let item = null, via = null;
  for (const [pn, tag] of [[supplier, "supplier_part"], [customer, "customer_part"], [vpn, "vendor P/N in description"]]) {
    if (!pn) continue;
    const r = await resolveItem(company, pn);
    if (r.ambiguous) return { label, pass: false, rule2: false, detail: `part "${pn}" matches ${r.ambiguous.length} items (${r.ambiguous.slice(0, 4).join(", ")}) — ambiguous` };
    if (r.item) { item = r.item; via = tag; break; }
  }

  // Rule 2, path (b) CROSS-REFERENCE — customer part # via Item_References_Excel.
  if (!item && customer) {
    const cr = await crossRefItems(company, custNo, customer);
    if (!cr.ok) {
      return { label, pass: false, rule2: false, detail: `cross-ref lookup for "${customer}" failed (HTTP ${cr.status})` };
    }
    if (cr.items.length === 1) {
      item = (await resolveItem(company, cr.items[0])).item;
      via = "cross-ref";
    } else if (cr.items.length > 1) {
      return { label, pass: false, rule2: false, detail: `customer part "${customer}" cross-refs to ${cr.items.length} items (${cr.items.slice(0, 4).join(", ")}) — ambiguous` };
    }
  }

  if (!item) {
    return {
      label, pass: false, rule2: false,
      detail: `no BC item matches ${supplier ? `supplier part "${supplier}"` : `customer part "${customer}"`}${customer && !supplier ? " (no cross-reference either)" : ""}`,
    };
  }

  // Rule 3 — inventory >= quantity ordered.
  if (qty == null) {
    return { label, pass: false, rule2: true, item: item.number, detail: `resolved to ${item.number} (via ${via}) but order has no quantity to verify` };
  }
  const onHand = Number(item.inventory ?? 0);
  const enough = onHand >= qty;
  const uomFlag = uomNeedsReview(line.uom, item.baseUnitOfMeasureCode);
  const uomNote = uomFlag
    ? ` [⚠ UoM needs review: order "${line.uom}" is a multiplier, not pieces (base "${item.baseUnitOfMeasureCode}") — quantity not safe to create]`
    : "";
  return {
    label, pass: enough, rule2: true, item: item.number, via, uomFlag,
    detail: `${item.number} (via ${via}) — on-hand ${onHand} vs ordered ${qty}${enough ? " ✓" : " — SHORT"}${uomNote}`,
  };
}

// --- Rules 4 & 5: ship-to and contact validation (against live BC OData) ---
const normPost = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
const streetNo = (s) => (String(s || "").match(/\d+/) || [""])[0];
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

// Rule 4 — does the PO ship-to match one of the customer's ship-to addresses on file?
// Uses the published `ShipTo` OData page. Match = same postal code AND (same city or
// same street number). Returns the matched row so create can copy its address.
async function checkShipTo(company, order, custNo) {
  const st = order?.ship_to || {};
  const wantPost = normPost(st.postal_code), wantCity = normGeo(st.city), wantNum = streetNo(st.line1);
  const url = encodeURI(`${ODBASE}/Company(${odataStr(company.name)})/ShipTo?$filter=Customer_No eq ${odataStr(custNo)}&$select=Code,Name,Address,Address_2,City,Post_Code,County,Contact,E_Mail`);
  const r = await get(url);
  if (!r.ok) return { pass: false, detail: `ship-to lookup failed (HTTP ${r.status})` };
  const rows = r.json?.value || [];
  if (!rows.length) return { pass: false, detail: "customer has no ship-to addresses on file" };
  for (const row of rows) {
    const postOK = wantPost && wantPost === normPost(row.Post_Code);
    const cityOK = wantCity && wantCity === normGeo(row.City);
    const numOK = wantNum && wantNum === streetNo(row.Address);
    if ((postOK && (cityOK || numOK)) || (!wantPost && cityOK && numOK)) {
      return { pass: true, detail: `matched ship-to "${row.Code}" (${row.City || ""} ${row.Post_Code || ""})`, shipTo: row };
    }
  }
  return { pass: false, detail: `PO ship-to (${st.city || "?"} ${st.postal_code || ""}) not among ${rows.length} on file` };
}

// Rule 5 — is the PO's contact already associated with the customer? In BC the
// customer has a *company* contact (via ContactBusinessRelation), and the individual
// buyers are Person contacts linked by Company_No to that company contact. We match
// the PO's contact EMAIL (works in production) with a NAME fallback (works even in the
// test instance, where emails are scrubbed to a single placeholder). Returns the
// matched contact so create can name it.
async function checkContact(company, order, custNo) {
  const email = String(order?.customer?.contact_email || "").toLowerCase().trim();
  const wantName = normName(order?.customer?.contact_name || "");
  if (!email && !wantName) return { pass: false, detail: "no contact email/name on the PO to match" };
  const ODC = `${ODBASE}/Company(${odataStr(company.name)})`;

  // the customer's company contact
  const rel = await get(encodeURI(`${ODC}/ContactBusinessRelation?$filter=No eq ${odataStr(custNo)}&$select=Contact_No,Link_to_Table`));
  const companyContactNo = (rel.json?.value || []).find((x) => /customer/i.test(x.Link_to_Table || ""))?.Contact_No;

  // customer's own email + every Person contact under the company contact
  const emails = new Set();
  const people = [];
  const cr = await get(`companies(${company.id})/customers?$filter=number eq ${odataStr(custNo)}&$select=email`);
  const custEmail = String(cr.json?.value?.[0]?.email || "").toLowerCase().trim();
  if (custEmail) emails.add(custEmail);
  if (companyContactNo) {
    const res = await getAll(encodeURI(`${ODC}/Contact?$filter=Company_No eq ${odataStr(companyContactNo)}&$select=No,Name,E_Mail`));
    for (const c of res.rows || []) {
      const e = String(c.E_Mail || "").toLowerCase().trim();
      if (e) emails.add(e);
      people.push({ no: c.No, name: c.Name, email: e });
    }
  }

  // match: email against a person, else customer-level email, else name against a person
  let matched = email ? people.find((p) => p.email === email) : null;
  let via = matched ? "email" : null;
  if (!matched && email && emails.has(email)) { matched = { no: null, name: null }; via = "customer email"; }
  if (!matched && wantName) { const p = people.find((x) => normName(x.name) === wantName); if (p) { matched = p; via = "name"; } }
  if (matched) {
    return { pass: true, detail: matched.no ? `matched contact ${matched.no} (${matched.name}) [via ${via}]` : "matched customer email", contact: matched.no ? { no: matched.no, name: matched.name } : null };
  }
  return { pass: false, detail: `PO contact "${email || order?.customer?.contact_name || "?"}" not on file (${people.length} contact(s) under customer)` };
}

// Cached full customer list (BC has ~9k; the pull is the slow part). Cached for 10
// min so verify/preview/approve/search reuse it instead of re-pulling every call.
let CUST_LIST = null, CUST_LIST_AT = 0;
async function allCustomers(company) {
  if (CUST_LIST && Date.now() - CUST_LIST_AT < 10 * 60 * 1000) return CUST_LIST;
  const res = await getAll(`companies(${company.id})/customers?$select=number,displayName,email,city,state,blocked`);
  if (!res.ok) throw new Error(`customers read -> HTTP ${res.status}`);
  CUST_LIST = res.rows; CUST_LIST_AT = Date.now();
  return CUST_LIST;
}

// Name-substring search over BC customers, for the review app's "search customer" box.
export async function searchCustomers(q, limit = 15) {
  const needle = String(q || "").toLowerCase().trim();
  if (needle.length < 2) return [];
  const company = await resolveCompany();
  const rows = await allCustomers(company);
  return rows
    .filter((c) => (c.displayName || "").toLowerCase().includes(needle))
    .slice(0, limit)
    .map((c) => ({ number: c.number, displayName: c.displayName, city: c.city, state: c.state }));
}

export async function verifyOrder(order, opts = {}) {
  const company = await resolveCompany();
  let r1;
  if (opts.forceCustomer?.number) {
    // A rep manually assigned this customer in the review app — trust it, skip name-match.
    r1 = {
      rule: "1 customer", pass: true,
      match: { number: opts.forceCustomer.number, displayName: opts.forceCustomer.displayName || opts.forceCustomer.number },
      detail: `assigned to ${opts.forceCustomer.number}${opts.forceCustomer.displayName ? ` (${opts.forceCustomer.displayName})` : ""}${opts.forceCustomer.via ? ` [${opts.forceCustomer.via}]` : ""}`,
    };
  } else {
    // No $top — in BC OData, $top hard-caps the total AND suppresses @odata.nextLink,
    // so a small $top silently hides the rest of the table. Cached (allCustomers).
    r1 = await checkCustomer(company, order, { rows: await allCustomers(company) });
  }
  const custNo = r1.match?.number || null; // resolved customer #, sharpens cross-ref
  const lines = [];
  for (const li of order.line_items || []) lines.push(await checkLine(company, li, custNo));

  // Disposition: what document to create in BC (after a human approves).
  //   Gates that force a human: customer not matched with high certainty, OR any
  //   line not resolved to a BC item. Otherwise stock ROUTES the document type:
  //   all lines in stock -> Order; any short line -> Quote (whole PO, option A).
  const gateCustomer = r1.pass;
  const resolved = lines.filter((l) => l.rule2).length;
  const gateParts = lines.length > 0 && lines.every((l) => l.rule2);
  const uomIssue = lines.some((l) => l.uomFlag); // non-piece unit -> qty not safe to auto-create
  const allInStock = gateParts && lines.every((l) => l.pass);
  const multiPO = multiplePOs(order.po_number); // one email carrying 2+ POs
  let disposition, dispositionReason;
  if (lines.length === 0) {
    disposition = "review"; dispositionReason = "no line items extracted";
  } else if (multiPO) {
    disposition = "review"; dispositionReason = `multiple PO numbers in one email (${multiPO.join(", ")}) — enter each order separately`;
  } else if (!gateCustomer && !gateParts) {
    disposition = "review"; dispositionReason = `customer not confidently matched, and ${lines.length - resolved} line(s) unresolved`;
  } else if (!gateCustomer) {
    disposition = "review"; dispositionReason = `customer not confidently matched — ${r1.detail}`;
  } else if (!gateParts) {
    disposition = "review"; dispositionReason = `${lines.length - resolved} of ${lines.length} line(s) not matched to a BC item`;
  } else if (uomIssue) {
    disposition = "review";
    const n = lines.filter((l) => l.uomFlag).length;
    dispositionReason = `${n} line(s) use a non-piece unit (e.g. 100PACK / M / C) — a human must confirm the quantity before creating`;
  }
  // Customer + parts + UoM all clean → Rules 4 & 5: ship-to and contact.
  // Ship-to is a hard gate. Contact is INFORMATIONAL by default: BC does not store the
  // individual buyer emails that appear on POs (customers have one company-contact,
  // usually with no/placeholder email), so gating on it would reject nearly every order.
  // Set CONTACT_GATE=1 to make it a hard gate (only sensible once BC contacts are populated).
  let shipToRes = null, contactRes = null;
  if (!disposition) {
    shipToRes = await checkShipTo(company, order, custNo);
    contactRes = await checkContact(company, order, custNo);
    const contactNote = contactRes.pass ? "" : " (contact not on file)";
    if (!shipToRes.pass) {
      disposition = "review"; dispositionReason = `ship-to not on file — ${shipToRes.detail}`;
    } else if (CONTACT_GATE && !contactRes.pass) {
      disposition = "review"; dispositionReason = `contact/email not on file — ${contactRes.detail}`;
    } else if (allInStock) {
      disposition = "order"; dispositionReason = `customer & ship-to matched; all lines in stock${contactNote}`;
    } else {
      disposition = "quote"; dispositionReason = `customer & ship-to matched; one or more lines short → quote${contactNote}`;
    }
  }
  return { company: company.name, rule1: r1, lines, linesPass: allInStock, gateCustomer, gateParts, disposition, dispositionReason, shipTo: shipToRes, contact: contactRes };
}

const DISPO = { order: "🟢 CREATE AS ORDER", quote: "📄 CREATE AS QUOTE", review: "⛔ NEEDS REVIEW" };

function printReport(order, res) {
  console.log(`\nOrder: PO ${order.po_number ?? "?"} — customer "${order?.customer?.name ?? "?"}"  [company: ${res.company}]`);
  console.log(`  Customer:  ${res.rule1.pass ? "matched" : "NOT matched"} — ${res.rule1.detail}`);
  console.log(`  Lines:`);
  for (const l of res.lines) console.log(`     - ${l.pass ? "in stock " : l.rule2 ? "short    " : "no match "} ${l.detail}`);
  console.log(`  ── ${DISPO[res.disposition]} — ${res.dispositionReason}`);
}

// --- selftest: build should-pass / should-flag orders from live BC ----------
async function selftest() {
  const company = await resolveCompany();
  const cust = (await get(`companies(${company.id})/customers?$top=1&$select=number,displayName,email`)).json?.value?.[0];
  // NOTE: `inventory` is a FlowField — $filter on it returns HTTP 400. So pick an
  // in-stock item client-side: read a small page and choose the first with stock.
  const pool = (await get(`companies(${company.id})/items?$top=25&$select=number,displayName,inventory`)).json?.value || [];
  const item = pool.find((i) => Number(i.inventory ?? 0) > 0) ?? pool[0];
  if (!cust || !item) { console.error("selftest needs at least 1 customer and 1 item in BC."); process.exit(1); }
  console.log(`Selftest built from live BC — customer ${cust.number}, item ${item.number} (on-hand ${item.inventory ?? 0}).`);

  const passOrder = {
    po_number: "SELFTEST-PASS", customer: { name: cust.displayName, contact_email: cust.email },
    line_items: [{ line_no: 1, supplier_part: item.number, quantity: 1, uom: null }],
  };
  const flagOrder = {
    po_number: "SELFTEST-FLAG", customer: { name: cust.displayName, contact_email: cust.email },
    line_items: [
      { line_no: 1, supplier_part: item.number, quantity: 1 },
      { line_no: 2, supplier_part: "NO-SUCH-PART-zzz999", quantity: 5 },
    ],
  };
  printReport(passOrder, await verifyOrder(passOrder));
  printReport(flagOrder, await verifyOrder(flagOrder));
  console.log("\nSelftest done (read-only). Expect: first CREATE AS ORDER, second NEEDS REVIEW (unresolved line).");
}

// Accept either a raw order (Step-2 shape) or an answer-key wrapper {extraction, ...}.
const unwrap = (j) => (j && j.extraction ? j.extraction : j);

// --- batch: run every order-classified file in a dir, focus on Rule 1 -------
async function batch(dir, jsonOut) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  let orders = 0;
  const tally = { order: 0, quote: 0, review: 0 };
  const records = [];
  if (!jsonOut) {
    console.log(`Batch over ${dir} — disposition (Order / Quote / Needs-review):\n`);
    console.log("  sample  disposition       customer -> detail");
    console.log("  ------  ----------------  ------------------");
  }
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (raw.classification && raw.classification !== "order") continue; // only orders have a customer to match
    const order = unwrap(raw);
    orders++;
    let res;
    try { res = await verifyOrder(order); }
    catch (e) {
      if (!jsonOut) console.log(`  ${(raw.sample_id || f).padEnd(6)}  ERR               ${e.message}`);
      continue;
    }
    tally[res.disposition]++;
    const id = (raw.sample_id || f).replace(/\.json$/, "");
    // Structured record (order fields + verification) for the review UI / future app.
    records.push({
      id, po_number: order.po_number, order_date: order.order_date,
      requested_ship_date: order.requested_ship_date,
      customer: order.customer, ship_to: order.ship_to,
      line_items: order.line_items, company: res.company,
      rule1: res.rule1, lines: res.lines, linesPass: res.linesPass,
      disposition: res.disposition, dispositionReason: res.dispositionReason,
    });
    const label = { order: "ORDER (in stock)", quote: "QUOTE (short)", review: "needs review" }[res.disposition];
    if (!jsonOut) console.log(`  ${id.padEnd(6)}  ${label.padEnd(16)}  ${res.dispositionReason}`);
  }
  if (jsonOut) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(jsonOut), { recursive: true }); // ensure out/ exists
    writeFileSync(jsonOut, JSON.stringify({ generated: new Date().toISOString(), orders, tally, records }, null, 2));
    console.log(`Wrote ${records.length} verified orders -> ${jsonOut}`);
    return;
  }
  console.log(`\n  Orders: ${orders}`);
  console.log(`  → Create as ORDER (all in stock):   ${tally.order}`);
  console.log(`  → Create as QUOTE (some short):     ${tally.quote}`);
  console.log(`  → NEEDS REVIEW (customer/parts):    ${tally.review}`);
  console.log(`\n  Read-only. Disposition = what would be created after a human approves.`);
}

async function main() {
  for (const [k, v] of [["BC_BASE_URL", BASE], ["BC_USERNAME", USER], ["BC_PASSWORD", PASS]]) {
    if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
  }
  const args = process.argv.slice(2);
  const orderFlag = args.indexOf("--order");
  const batchFlag = args.indexOf("--batch");
  if (args.includes("--selftest")) return selftest();
  const jsonFlag = args.indexOf("--json");
  const jsonOut = jsonFlag !== -1 ? args[jsonFlag + 1] : null;
  if (batchFlag !== -1 && args[batchFlag + 1]) return batch(args[batchFlag + 1], jsonOut);
  if (orderFlag !== -1 && args[orderFlag + 1]) {
    const order = unwrap(JSON.parse(readFileSync(args[orderFlag + 1], "utf8")));
    return printReport(order, await verifyOrder(order));
  }
  console.log("Usage:\n  verify.js --order <extracted-order.json>\n  verify.js --batch <dir>   (all order-classified *.json in a dir)\n  verify.js --selftest      (builds pass/flag orders from live BC)");
}

// Only run the CLI when executed directly — importing this module (e.g. from the
// Step-6 create tool) should not trigger main().
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

export { normPart, resolveItem, buildItemIndex, normName };
