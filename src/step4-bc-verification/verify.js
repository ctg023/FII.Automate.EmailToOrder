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

// The customer's part FIELD can carry a trailing tag (e.g. Hatfield's "RW2114OHIO" =
// part + plant code) while the clean part sits in the DESCRIPTION ("RW-2114 Buckeye
// Fastener"). Mine part-like tokens from the description, ordered by confidence:
//   • ANCHORED — the token's normalized form appears inside a part field (so the
//     field is the real part wrapped in the customer's own prefix/suffix codes, e.g.
//     "RW2114OHIO", "XOHOPC1220HWZ"). High confidence; tried first.
//   • LEADING — the first part-like token in the description. Weaker; best-effort.
// A token qualifies as part-like only if, normalized, it is >=4 chars and has a digit.
// Callers still require a UNIQUE BC item match, so this never guesses among several.
function descPartCandidates(description, partFields = []) {
  const raw = String(description || "").split(/[\s,;()\[\]]+/).filter(Boolean);
  const fields = partFields.map((f) => normPart(f || "")).filter(Boolean);
  const seen = new Set();
  const anchored = [], leading = [];
  let sawLead = false;
  for (const tok of raw) {
    const n = normPart(tok);
    if (n.length < 4 || !/\d/.test(n)) continue; // must look like a part number
    const first = !sawLead; sawLead = true;
    if (seen.has(n)) continue; seen.add(n);
    if (fields.some((f) => f.length > n.length && f.includes(n))) anchored.push(tok);
    else if (first) leading.push(tok);
  }
  return [...anchored, ...leading];
}

// A part FIELD can be the real part number followed by crammed-in description words,
// e.g. "HS3 M6 PROJECTION WELD NUT" where the item is "HS3 M6". Try progressively
// longer LEADING token-prefixes of the field and take the LONGEST that uniquely
// resolves (the most complete part number; trailing tokens are descriptive noise).
// resolveItem hits the in-memory item index, so these extra tries cost no BC calls.
async function resolvePartFieldPrefix(company, fields) {
  let best = null;
  for (const field of fields) {
    const toks = String(field || "").trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2) continue;                    // single-token fields already tried directly
    const maxLen = Math.min(toks.length - 1, 5);      // strictly shorter than the whole field
    for (let k = 1; k <= maxLen; k++) {
      const pn = toks.slice(0, k).join(" ");
      const r = await resolveItem(company, pn);
      if (r.item) best = { item: r.item, pn };        // keep the longest unique match
    }
  }
  return best;
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

// Piece quantities must be whole multiples of this many pieces — fasteners ship in
// hundreds, so 2100/2200/3000/5000 are valid but 2120/2150 are not. A non-multiple is
// usually a typo or a pack/each mix-up, so route it to a human. Applies only to PIECE
// quantities (a non-piece UoM is already flagged by uomNeedsReview). Override QTY_STEP=1
// to disable. Configurable via env.
const QTY_STEP = Number(process.env.QTY_STEP || 100);
const qtyNeedsReview = (qty, uomFlag) =>
  !uomFlag && QTY_STEP > 1 && Number.isFinite(qty) && qty > 0 && qty % QTY_STEP !== 0;

// --- Plating substitution ----------------------------------------------------
// Customers often order the BASE item number and ask (in the line text / notes) for a
// finish; the plated finish is a DIFFERENT item, base + "-P##" (e.g. SSM 05014 ->
// SSM 05014-P44 for black oxide). The authoritative finish per item is the classic
// Item_Card_Excel field ARC_Plating_Desc. We detect a plating request, resolve it to a
// single plated variant, and swap the item number — or FLAG to review when unsure
// (e.g. bare "zinc" with several zinc variants), never guessing.
const PLATING_TERMS = /\b(plat(e|ed|ing)?|zinc|oxide|chromate|chrome|nickel|phosphat\w*|trivalent|cadmium|cad|galvaniz\w*|passivat\w*|copper|tin|electroplat\w*|black ?ox\w*|yellow|dacromet|geomet|xylan)\b/i;
const PLATING_NEGATION = /\b(no (zinc|plat\w*|finish|coat\w*)|plain finish|unplated|bare|no plate)\b/i;
const FINISH_WORDS = new Set(["zinc", "black", "oxide", "yellow", "clear", "trivalent", "copper", "flash", "nickel", "tin", "phosphate", "cadmium", "galvanized", "chrome", "chromate", "blue", "olive", "silver"]);
// Reduce a plating string (customer text or ARC_Plating_Desc) to comparable finish tokens.
function platingTokens(s) {
  const syn = { blk: "black", ox: "oxide", yellw: "yellow", yel: "yellow", trival: "trivalent", triv: "trivalent", galv: "galvanized", cad: "cadmium", ni: "nickel", cu: "copper", electroplate: "zinc", electroplated: "zinc" };
  const out = new Set();
  for (let t of String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (!t) continue;
    t = syn[t] || t;
    if (FINISH_WORDS.has(t)) out.add(t);
  }
  return out;
}
// Detect a plating request for a line (from its description + order-level notes).
function requestedPlating(line, notes) {
  const text = `${line.description || ""}  ${notes || ""}`;
  if (PLATING_NEGATION.test(text)) return { none: true };            // "plain / no plate" -> keep base
  const suf = text.match(/-\s*P\s*(\d{1,3})\b/i);                    // explicit "-P44"
  if (suf) return { suffix: `-P${suf[1]}` };
  const tokens = platingTokens(text);
  if (!PLATING_TERMS.test(text) || !tokens.size) return null;
  return { tokens };
}
// The base item's plated variants, with their authoritative ARC_Plating_Desc.
async function platedVariants(company, baseNo) {
  const C = `${ODBASE}/Company(${odataStr(company.name)})`;
  const r = await get(encodeURI(`${C}/Item_Card_Excel?$filter=startswith(No,${odataStr(baseNo + "-P")})&$select=No,ARC_Plating_Desc,Description`));
  return (r.json?.value || []).map((v) => ({ no: v.No, plating: v.ARC_Plating_Desc || "", desc: v.Description || "" }));
}
// Resolve a plating request to ONE plated variant. -> { item } | { item:null, note, candidates }
async function resolvePlated(company, baseNo, req) {
  const variants = await platedVariants(company, baseNo);
  if (!variants.length) return { item: null, note: `plating requested but no plated variants of ${baseNo} exist in BC` };
  // (1) explicit -P## the customer wrote
  if (req.suffix) {
    const v = variants.find((x) => stripSD(x.no).endsWith(stripSD(baseNo + req.suffix)));
    if (v) return { item: (await resolveItem(company, v.no)).item, note: `plated: ${baseNo} → ${v.no} (${v.plating || req.suffix})` };
    return { item: null, note: `PO cites ${req.suffix} but ${baseNo}${req.suffix} isn't in BC`, candidates: variants };
  }
  // (2) bare "zinc" with no qualifier is ambiguous -> review (per decision)
  const want = req.tokens;
  const isGenericZinc = want.size === 1 && want.has("zinc");
  // candidates = variants whose finish tokens cover everything the customer asked for
  const cands = variants.filter((v) => { const vt = platingTokens(`${v.plating} ${v.desc}`); return [...want].every((t) => vt.has(t)); });
  if (isGenericZinc) return { item: null, note: `"zinc" is ambiguous — pick the exact zinc finish`, candidates: cands.length ? cands : variants };
  if (cands.length === 1) { const it = (await resolveItem(company, cands[0].no)).item; return { item: it, note: `plated: ${baseNo} → ${cands[0].no} (${cands[0].plating || cands[0].desc})` }; }
  if (cands.length > 1) return { item: null, note: `plating "${[...want].join(" ")}" matches ${cands.length} variants — pick one`, candidates: cands };
  return { item: null, note: `plating "${[...want].join(" ")}" didn't match a plated variant of ${baseNo}`, candidates: variants };
}

// Rule 2 + 3 — per line: resolve item (direct, then cross-ref), then inventory.
async function checkLine(company, line, custNo, notes) {
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

  // Rule 2, path (c) PART-FIELD PREFIX — real part + crammed description words in one
  // field (e.g. "HS3 M6 PROJECTION WELD NUT" -> item "HS3 M6").
  if (!item) {
    const best = await resolvePartFieldPrefix(company, [supplier, customer]);
    if (best) { item = best.item; via = `part prefix "${best.pn}"`; }
  }

  // Rule 2, path (d) DESCRIPTION-ANCHORED — clean part in the description when the
  // part field carries a trailing tag (e.g. "RW2114OHIO" -> description "RW-2114").
  if (!item) {
    for (const pn of descPartCandidates(line.description, [supplier, customer])) {
      const r = await resolveItem(company, pn);
      if (r.item) { item = r.item; via = `description part "${pn}"`; break; }
      // ambiguous -> skip (never guess among several)
    }
  }

  if (!item) {
    return {
      label, pass: false, rule2: false,
      detail: `no BC item matches ${supplier ? `supplier part "${supplier}"` : `customer part "${customer}"`}${customer && !supplier ? " (no cross-reference either)" : ""}`,
    };
  }

  // Plating: base item + a requested finish -> swap in the plated variant (or flag).
  let platingNote = null, platingFlag = false, platingCandidates = null;
  if (!/-P\d+$/i.test(item.number)) {
    const req = requestedPlating(line, notes);
    if (req && !req.none) {
      const pr = await resolvePlated(company, item.number, req);
      if (pr.item) { item = pr.item; via = `${via} +plating`; platingNote = pr.note; }
      else { platingFlag = true; platingNote = pr.note; platingCandidates = (pr.candidates || []).slice(0, 6).map((c) => ({ no: c.no, plating: c.plating })); }
    }
  }

  // Rule 3 — inventory >= quantity ordered.
  if (qty == null) {
    return { label, pass: false, rule2: true, item: item.number, detail: `resolved to ${item.number} (via ${via}) but order has no quantity to verify` };
  }
  const onHand = Number(item.inventory ?? 0);
  const enough = onHand >= qty;
  const uomFlag = uomNeedsReview(line.uom, item.baseUnitOfMeasureCode);
  const qtyFlag = qtyNeedsReview(qty, uomFlag);
  const uomNote = uomFlag
    ? ` [⚠ UoM needs review: order "${line.uom}" is a multiplier, not pieces (base "${item.baseUnitOfMeasureCode}") — quantity not safe to create]`
    : "";
  const qtyNote = qtyFlag
    ? ` [⚠ quantity ${qty} is not a multiple of ${QTY_STEP} pieces — confirm before creating]`
    : "";
  const platingText = platingNote ? ` [${platingFlag ? "⚠ " : ""}${platingNote}]` : "";
  return {
    label, pass: enough, rule2: true, item: item.number, via, uomFlag, qtyFlag, platingFlag, platingNote, platingCandidates,
    detail: `${item.number} (via ${via}) — on-hand ${onHand} vs ordered ${qty}${enough ? " ✓" : " — SHORT"}${uomNote}${qtyNote}${platingText}`,
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

// --- Rule 6: price match against the referenced BC quote (the "BC/Q #") ----------
// Prices must match; PRICE_TOL is a per-unit $ tolerance (0 = exact, the default).
const PRICE_TOL = Number(process.env.PRICE_TOL || 0);

// Item-line unit prices for a referenced quote number, via the CLASSIC published pages
// (the standard salesQuotes API exposes no usable No./lines). Two cases, because reps
// convert accepted quotes into orders:
//   • still an OPEN quote  -> Sales_Quote_Excel (No)      + Sales_Quote_ExcelSalesLines
//   • CONVERTED to an order -> Sales_Order_Excel (Quote_No) + Sales_Order_ExcelSalesLines
// Returns our-item(normalized) -> { unitPrice, quote, via }. Charge/freight lines are
// skipped (Type != Item). found:false if the number is neither in this company (e.g. it
// lives in a different instance) — then the price check is reported, not gated.
async function quoteLinePrices(company, quoteNo) {
  const C = `${ODBASE}/Company(${odataStr(company.name)})`;
  const itemsFrom = (rows, via) => {
    const prices = new Map();
    for (const l of rows || []) {
      if (String(l.Type || "").toLowerCase() !== "item" || !l.No) continue; // items only
      prices.set(stripSD(l.No), { unitPrice: Number(l.Unit_Price), quote: quoteNo, via });
    }
    return prices;
  };
  // (1) still an open quote
  const q = await get(encodeURI(`${C}/Sales_Quote_Excel?$filter=No eq ${odataStr(quoteNo)}&$select=No`));
  if (q.json?.value?.length) {
    const l = await getAll(encodeURI(`${C}/Sales_Quote_ExcelSalesLines?$filter=Document_No eq ${odataStr(quoteNo)}&$select=Type,No,Unit_Price`));
    return { found: true, prices: itemsFrom(l.rows, "quote") };
  }
  // (2) converted to an order — matched by the order's Quote_No
  const o = await get(encodeURI(`${C}/Sales_Order_Excel?$filter=Quote_No eq ${odataStr(quoteNo)}&$select=No`));
  const orderNo = o.json?.value?.[0]?.No;
  if (orderNo) {
    const l = await getAll(encodeURI(`${C}/Sales_Order_ExcelSalesLines?$filter=Document_No eq ${odataStr(orderNo)}&$select=Type,No,Unit_Price`));
    return { found: true, prices: itemsFrom(l.rows, `order ${orderNo}`) };
  }
  return { found: false, prices: new Map() };
}

// Compare each resolved order line's unit price to the referenced quote's price for the
// same item. Sets l.priceFlag / l.priceNote per line. Returns a summary.
async function checkPrices(company, order, lines, quoteNos) {
  if (!quoteNos.length) return { checked: false, detail: "no BC/Q number referenced" };
  const byItem = new Map();
  let anyFound = false;
  for (const qn of quoteNos) {
    const { found, prices } = await quoteLinePrices(company, qn);
    if (found) { anyFound = true; for (const [k, v] of prices) if (!byItem.has(k)) byItem.set(k, v); }
  }
  if (!anyFound) return { checked: false, detail: `referenced quote(s) ${quoteNos.join(", ")} not in ${company.name} (may live in production)` };
  let compared = 0, mismatches = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.item) continue;
    const poPrice = Number(order.line_items?.[i]?.unit_price);
    const q = byItem.get(stripSD(l.item));
    if (!q) { l.priceNote = "item not on the referenced quote"; continue; }
    if (!Number.isFinite(poPrice)) { l.priceNote = `PO line has no price (quote ${q.unitPrice})`; continue; }
    compared++;
    const src = `BC/Q ${q.quote}${q.via && q.via.startsWith("order") ? ` → ${q.via}` : ""}`;
    if (Math.abs(poPrice - q.unitPrice) > PRICE_TOL) {
      l.priceFlag = true;
      l.priceNote = `⚠ price ${poPrice} ≠ quote ${q.unitPrice} (${src})`;
      mismatches++;
    } else {
      l.priceNote = `price matches quote ${q.unitPrice} (${src})`;
    }
  }
  return { checked: true, compared, mismatches, quotes: quoteNos, detail: mismatches ? `${mismatches} of ${compared} priced line(s) differ from the quote` : `all ${compared} priced line(s) match the quote` };
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
  const orderNotes = order.notes ?? order.special_instructions ?? "";
  for (const li of order.line_items || []) lines.push(await checkLine(company, li, custNo, orderNotes));

  // Rule 6 — price match against the referenced BC quote (exact by default). Sets
  // per-line priceFlag/priceNote; a mismatch gates to review below.
  const priceRes = await checkPrices(company, order, lines, (order.quote_refs || []).filter(Boolean));

  // Disposition: what document to create in BC (after a human approves).
  //   Gates that force a human: customer not matched with high certainty, OR any
  //   line not resolved to a BC item. Otherwise stock ROUTES the document type:
  //   all lines in stock -> Order; any short line -> Quote (whole PO, option A).
  const gateCustomer = r1.pass;
  const resolved = lines.filter((l) => l.rule2).length;
  const gateParts = lines.length > 0 && lines.every((l) => l.rule2);
  const uomIssue = lines.some((l) => l.uomFlag); // non-piece unit -> qty not safe to auto-create
  const qtyIssue = lines.some((l) => l.qtyFlag); // piece qty not a multiple of QTY_STEP (e.g. 2120)
  const platingIssue = lines.some((l) => l.platingFlag); // plating requested but not resolved to one variant
  const priceIssue = priceRes.checked && priceRes.mismatches > 0; // PO price != referenced quote
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
  } else if (qtyIssue) {
    disposition = "review";
    const bad = lines.filter((l) => l.qtyFlag);
    dispositionReason = `${bad.length} line(s) have a quantity that is not a multiple of ${QTY_STEP} pieces (${bad.map((l) => l.label).slice(0, 3).join(", ")}) — confirm the quantity before creating`;
  } else if (platingIssue) {
    disposition = "review";
    const p = lines.find((l) => l.platingFlag);
    dispositionReason = `plating/finish needs a pick — ${p?.platingNote || "couldn't resolve the requested finish to one BC item"}`;
  } else if (priceIssue) {
    disposition = "review";
    dispositionReason = `${priceRes.mismatches} line(s) priced differently from the referenced quote (BC/Q ${priceRes.quotes.join(", ")}) — confirm the price before creating`;
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
  return { company: company.name, rule1: r1, lines, linesPass: allInStock, gateCustomer, gateParts, disposition, dispositionReason, shipTo: shipToRes, contact: contactRes, price: priceRes };
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
