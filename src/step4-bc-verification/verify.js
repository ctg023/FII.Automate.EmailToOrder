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
  minOrderTokens: 2,   // orders whose name reduces to <2 tokens are too generic to
                       //   auto-resolve (e.g. "Mac B" -> just "mac") -> flag for a rep
  minTokenLen: 2,      // drop 1-char tokens
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

function normName(s) {
  return (s || "").toLowerCase().replace(/[.,&/]/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
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

// Rule 1 — customer resolves ------------------------------------------------
// A candidate qualifies iff it contains ALL order name tokens (whole words).
// Exact normalized-name match takes precedence; ties broken by ship-to geo.
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
    return { rule: "1 customer", pass: false, detail: `no BC customer matches "${order?.customer?.name}"` };
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
    return { rule: "1 customer", pass: false, detail: `ambiguous — ${pool.length} customers tie (${pool.slice(0, 6).map((t) => t.number).join(", ")}${pool.length > 6 ? ", …" : ""})`, candidates: pool };
  }
  return { rule: "1 customer", pass: true, detail: `resolved to ${pool[0].number} (${pool[0].displayName}) [via ${via}${brokeBy ? ` + ${brokeBy}` : ""}]`, match: pool[0] };
}

// Fetch one item record by our item number (for inventory/UoM after resolution).
// Part numbers are formatted inconsistently: BC has "HW 4432" / "2004-1", customers
// reformat on POs ("HW4432", "2004 1"). Match ignoring case, whitespace, hyphens and
// slashes (verified against the item master: 0 slashes except one item, 6,339 hyphens,
// and ignoring -,/ introduces only 6 same-part collisions, which we flag not guess).
const normPart = (s) => (s || "").toUpperCase().replace(/[\s\/-]+/g, "");

// Customers often cite OUR part number in the line description as a vendor part
// number, e.g. "(V.PN# WPM 08002)" or "V.PN# HS3 5811". When the part fields don't
// resolve, mine this as a fallback candidate for a direct (our-item) match.
function vendorPartFromDesc(desc) {
  const m = String(desc || "").match(/v\.?\s*p\.?\s*n\.?\s*#?\s*:?\s*([A-Za-z0-9][A-Za-z0-9 .\/-]*?)\s*(?:\)|\]|—|,|;|$)/i);
  return m ? m[1].trim() : null;
}

// Item index: our whole item master, keyed by normalized number. Loaded once,
// cached for the process (so a --batch run pulls items just once).
let ITEM_INDEX = null;
async function buildItemIndex(company) {
  if (ITEM_INDEX) return ITEM_INDEX;
  const res = await getAll(`companies(${company.id})/items?$select=number,displayName,inventory,blocked,baseUnitOfMeasureCode`);
  if (!res.ok) throw new Error(`items read -> HTTP ${res.status}`);
  const idx = new Map();
  for (const it of res.rows) {
    const k = normPart(it.number);
    if (!k) continue;
    (idx.get(k) || idx.set(k, []).get(k)).push(it);
  }
  ITEM_INDEX = idx;
  return idx;
}
// Resolve a part string to a single item by normalized number.
// -> { item } | { ambiguous:[numbers] } | { item:null }
async function resolveItem(company, pn) {
  const hits = (await buildItemIndex(company)).get(normPart(pn));
  if (!hits || !hits.length) return { item: null };
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
  const uomNote = line.uom && item.baseUnitOfMeasureCode && line.uom.toUpperCase() !== item.baseUnitOfMeasureCode.toUpperCase()
    ? ` [UoM check skipped: order "${line.uom}" vs base "${item.baseUnitOfMeasureCode}"]` : "";
  return {
    label, pass: enough, rule2: true, item: item.number, via,
    detail: `${item.number} (via ${via}) — on-hand ${onHand} vs ordered ${qty}${enough ? " ✓" : " — SHORT"}${uomNote}`,
  };
}

export async function verifyOrder(order) {
  const company = await resolveCompany();
  // No $top — in BC OData, $top hard-caps the total AND suppresses @odata.nextLink,
  // so a small $top silently hides the rest of the table. Let nextLink page it all.
  const custCache = await getAll(`companies(${company.id})/customers?$select=number,displayName,email,city,state,blocked`);
  if (!custCache.ok) throw new Error(`customers read -> HTTP ${custCache.status}`);

  const r1 = await checkCustomer(company, order, custCache);
  const custNo = r1.match?.number || null; // resolved customer #, sharpens cross-ref
  const lines = [];
  for (const li of order.line_items || []) lines.push(await checkLine(company, li, custNo));

  const linesPass = lines.length > 0 && lines.every((l) => l.pass);
  const approveReady = r1.pass && linesPass; // Rule 4 = all-or-nothing
  return { company: company.name, rule1: r1, lines, linesPass, approveReady };
}

function printReport(order, res) {
  console.log(`\nOrder: PO ${order.po_number ?? "?"} — customer "${order?.customer?.name ?? "?"}"  [company: ${res.company}]`);
  console.log(`  Rule 1 (customer):   ${res.rule1.pass ? "PASS" : "FLAG"} — ${res.rule1.detail}`);
  console.log(`  Rule 2+3 (lines):    ${res.linesPass ? "PASS" : "FLAG"}`);
  for (const l of res.lines) console.log(`     - ${l.pass ? "ok  " : "FLAG"} ${l.detail}`);
  console.log(`  ── Overall: ${res.approveReady ? "✅ APPROVE-READY" : "⛔ FLAGGED for a rep"}`);
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
  console.log("\nSelftest done (read-only). Expect: first APPROVE-READY, second FLAGGED.");
}

// Accept either a raw order (Step-2 shape) or an answer-key wrapper {extraction, ...}.
const unwrap = (j) => (j && j.extraction ? j.extraction : j);

// --- batch: run every order-classified file in a dir, focus on Rule 1 -------
async function batch(dir, jsonOut) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  let orders = 0, r1pass = 0, overallReady = 0;
  const records = [];
  if (!jsonOut) {
    console.log(`Batch over ${dir} — Rule 1 (customer match) focus:\n`);
    console.log("  sample  R1    lines        overall            customer / detail");
    console.log("  ------  ----  -----------  -----------------  -----------------");
  }
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (raw.classification && raw.classification !== "order") continue; // only orders have a customer to match
    const order = unwrap(raw);
    orders++;
    let res;
    try { res = await verifyOrder(order); }
    catch (e) {
      if (!jsonOut) console.log(`  ${(raw.sample_id || f).padEnd(6)}  ERR   —            —                  ${e.message}`);
      continue;
    }
    if (res.rule1.pass) r1pass++;
    if (res.approveReady) overallReady++;
    const nOk = res.lines.filter((l) => l.pass).length;
    const id = (raw.sample_id || f).replace(/\.json$/, "");
    // Structured record (order fields + verification) for the review UI / future app.
    records.push({
      id, po_number: order.po_number, order_date: order.order_date,
      requested_ship_date: order.requested_ship_date,
      customer: order.customer, ship_to: order.ship_to,
      line_items: order.line_items, company: res.company,
      rule1: res.rule1, lines: res.lines, linesPass: res.linesPass,
      approveReady: res.approveReady,
    });
    if (!jsonOut) console.log(
      `  ${id.padEnd(6)}  ${(res.rule1.pass ? "PASS" : "FLAG")}  ${`${nOk}/${res.lines.length} ok`.padEnd(11)}  ` +
      `${(res.approveReady ? "APPROVE-READY" : "flagged").padEnd(17)}  ${res.rule1.detail}`
    );
  }
  if (jsonOut) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(jsonOut, JSON.stringify({ generated: new Date().toISOString(), orders, r1pass, overallReady, records }, null, 2));
    console.log(`Wrote ${records.length} verified orders -> ${jsonOut}`);
    return;
  }
  console.log(`\n  Orders tested: ${orders}`);
  console.log(`  Rule 1 (customer) resolved: ${r1pass}/${orders}  (${orders ? ((r1pass / orders) * 100).toFixed(0) : 0}%)`);
  console.log(`  Fully APPROVE-READY:        ${overallReady}/${orders}  (parts via direct + cross-ref; limited by unresolved customers, real stock-outs, UoM skips)`);
  console.log(`\n  Read-only. Overall-ready is NOT the metric here; Rule 1 hit-rate on real customer names is.`);
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

main().catch((e) => { console.error(e.message || e); process.exit(1); });
