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

// --- matching helpers (v1, heuristic) ---------------------------------------
const SUFFIXES = /\b(inc|incorporated|llc|l\.l\.c|co|corp|corporation|company|ltd|limited|lp|llp)\b/gi;
function normName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[.,&]/g, " ")
    .replace(SUFFIXES, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const emailDomain = (e) => ((e || "").split("@")[1] || "").toLowerCase().trim();

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
async function checkCustomer(company, order, custCache) {
  const want = normName(order?.customer?.name);
  const domain = emailDomain(order?.customer?.contact_email);
  if (!want && !domain) {
    return { rule: "1 customer", pass: false, detail: "no customer name or email in the order to match on" };
  }
  const customers = custCache.rows;
  const scored = [];
  for (const c of customers) {
    const cn = normName(c.displayName);
    let score = 0;
    if (want && cn === want) score += 100;
    else if (want && cn && (cn.includes(want) || want.includes(cn))) score += 60;
    if (domain && emailDomain(c.email) === domain) score += 50;
    if (score > 0) scored.push({ number: c.number, displayName: c.displayName, blocked: c.blocked, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((s) => s.score === scored[0]?.score);
  if (scored.length === 0) return { rule: "1 customer", pass: false, detail: `no BC customer matches "${order?.customer?.name ?? ""}"` };
  if (top.length > 1) return { rule: "1 customer", pass: false, detail: `ambiguous — ${top.length} customers tie (${top.map((t) => t.number).join(", ")})`, candidates: top };
  return { rule: "1 customer", pass: true, detail: `resolved to ${top[0].number} (${top[0].displayName})`, match: top[0] };
}

// Fetch one item record by our item number (for inventory/UoM after resolution).
async function fetchItem(company, number) {
  const r = await get(`companies(${company.id})/items?$filter=number eq ${odataStr(number)}&$select=number,displayName,inventory,blocked,baseUnitOfMeasureCode`);
  return r.ok ? (r.json?.value || [])[0] : null;
}

// Cross-reference lookup against the LIVE Item_References_Excel OData service:
// customer part # -> our item #. Prefers refs tied to the resolved customer.
async function crossRefItems(company, custNo, partNo) {
  const flt = `Reference_Type eq 'Customer' and Reference_No eq ${odataStr(partNo)}`;
  const url = encodeURI(`${ODBASE}/Company(${odataStr(company.name)})/Item_References_Excel?$filter=${flt}&$select=Item_No,Reference_Type_No`);
  const r = await get(url);
  if (!r.ok) return { ok: false, status: r.status, items: [] };
  let rows = r.json?.value || [];
  if (custNo) { // narrow to this customer's own refs when we know who they are
    const own = rows.filter((x) => (x.Reference_Type_No || "") === custNo);
    if (own.length) rows = own;
  }
  const items = [...new Set(rows.map((x) => x.Item_No).filter(Boolean))];
  return { ok: true, items };
}

// Rule 2 + 3 — per line: resolve item (direct, then cross-ref), then inventory.
async function checkLine(company, line, custNo) {
  const supplier = (line.supplier_part || "").trim();
  const customer = (line.customer_part || "").trim();
  const qty = line.quantity;
  const label = supplier || customer || line.description || `line ${line.line_no ?? "?"}`;

  // Rule 2, path (a) DIRECT — supplier PN, then customer PN, as our items.number.
  let item = null, via = null;
  for (const [pn, tag] of [[supplier, "supplier_part"], [customer, "customer_part"]]) {
    if (!pn) continue;
    const hit = await fetchItem(company, pn);
    if (hit) { item = hit; via = tag; break; }
  }

  // Rule 2, path (b) CROSS-REFERENCE — customer part # via Item_References_Excel.
  if (!item && customer) {
    const cr = await crossRefItems(company, custNo, customer);
    if (!cr.ok) {
      return { label, pass: false, rule2: false, detail: `cross-ref lookup for "${customer}" failed (HTTP ${cr.status})` };
    }
    if (cr.items.length === 1) {
      item = await fetchItem(company, cr.items[0]);
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
  const custCache = await getAll(`companies(${company.id})/customers?$select=number,displayName,email,blocked`);
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
async function batch(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  let orders = 0, r1pass = 0, overallReady = 0;
  console.log(`Batch over ${dir} — Rule 1 (customer match) focus:\n`);
  console.log("  sample  R1    lines        overall            customer / detail");
  console.log("  ------  ----  -----------  -----------------  -----------------");
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (raw.classification && raw.classification !== "order") continue; // only orders have a customer to match
    const order = unwrap(raw);
    orders++;
    let res;
    try { res = await verifyOrder(order); }
    catch (e) { console.log(`  ${(raw.sample_id || f).padEnd(6)}  ERR   —            —                  ${e.message}`); continue; }
    if (res.rule1.pass) r1pass++;
    if (res.approveReady) overallReady++;
    const nOk = res.lines.filter((l) => l.pass).length;
    const id = (raw.sample_id || f).replace(/\.json$/, "");
    console.log(
      `  ${id.padEnd(6)}  ${(res.rule1.pass ? "PASS" : "FLAG")}  ${`${nOk}/${res.lines.length} ok`.padEnd(11)}  ` +
      `${(res.approveReady ? "APPROVE-READY" : "flagged").padEnd(17)}  ${res.rule1.detail}`
    );
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
  if (batchFlag !== -1 && args[batchFlag + 1]) return batch(args[batchFlag + 1]);
  if (orderFlag !== -1 && args[orderFlag + 1]) {
    const order = unwrap(JSON.parse(readFileSync(args[orderFlag + 1], "utf8")));
    return printReport(order, await verifyOrder(order));
  }
  console.log("Usage:\n  verify.js --order <extracted-order.json>\n  verify.js --batch <dir>   (all order-classified *.json in a dir)\n  verify.js --selftest      (builds pass/flag orders from live BC)");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
