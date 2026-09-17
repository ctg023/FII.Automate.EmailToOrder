// Read-only Business Central data-quality probe.
// Answers the two open Step-4 questions directly from live BC, and prints the
// field shapes of the verification entities so we design checks against real
// fields. Nothing is written to BC.
//
//   Q1  Salesperson-code coverage across active (non-blocked) customers
//         -> how much load the review-queue fallback path carries
//   Q2  Item cross-reference / item reference population (customer part # -> item #)
//         -> how often item resolution "just works" vs. flags for a rep
//
// Privacy: field-shape output prints field NAMES only, never values. Coverage
// passes $select only the minimal fields (number / code / blocked), so no
// customer names, contacts, or pricing are fetched or logged.
//
// Uses the same .env as ping.js (BC_BASE_URL, BC_USERNAME, BC_PASSWORD,
// optional BC_COMPANY). Run trusting the corporate/Windows CA:
//   NODE_OPTIONS=--use-system-ca node src/step4-bc-verification/data-quality.js
import "dotenv/config";

const BASE = (process.env.BC_BASE_URL || "").replace(/\/$/, "");
const USER = process.env.BC_USERNAME;
const PASS = process.env.BC_PASSWORD;
const COMPANY = process.env.BC_COMPANY;

for (const [k, v] of [["BC_BASE_URL", BASE], ["BC_USERNAME", USER], ["BC_PASSWORD", PASS]]) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

async function get(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE}/${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: AUTH, Accept: "application/json" } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, ok: res.ok, json, text };
}

// Page through an OData collection, following @odata.nextLink. Returns all rows.
async function getAll(firstPath, cap = 100000) {
  const rows = [];
  let next = firstPath;
  while (next) {
    const r = await get(next);
    if (!r.ok) return { ok: false, status: r.status, text: r.text, rows };
    rows.push(...(r.json?.value || []));
    next = r.json?.["@odata.nextLink"] || null;
    if (rows.length >= cap) break;
  }
  return { ok: true, rows };
}

// Print the field names (shape) of one record without exposing its values.
async function shape(company, entity) {
  const r = await get(`companies(${company.id})/${entity}?$top=1`);
  if (!r.ok) {
    console.log(`  ${entity}: HTTP ${r.status} — not readable`);
    return;
  }
  const rec = r.json?.value?.[0];
  if (!rec) { console.log(`  ${entity}: readable, but 0 records to sample`); return; }
  const fields = Object.keys(rec).filter((k) => !k.startsWith("@")).sort();
  console.log(`  ${entity} (${fields.length} fields):`);
  console.log("    " + fields.join(", "));
}

async function main() {
  const cr = await get("companies");
  if (!cr.ok) { console.error(`companies -> HTTP ${cr.status}: ${(cr.text || "").slice(0, 400)}`); process.exit(1); }
  const companies = cr.json?.value || [];
  const company = COMPANY
    ? companies.find((c) => (c.name || "").toLowerCase() === COMPANY.toLowerCase())
    : companies[0];
  if (!company) { console.error(COMPANY ? `Company "${COMPANY}" not found.` : "No companies returned."); process.exit(1); }
  console.log(`Company: ${company.name}  (id ${company.id})\n`);

  // ---- Q1: salesperson-code coverage across customers ------------------------
  console.log("Q1  Salesperson-code coverage");
  // No $top: in BC OData a small $top caps the total AND drops @odata.nextLink,
  // hiding the rest of the table. Let nextLink page the full set.
  const custRes = await getAll(`companies(${company.id})/customers?$select=number,salespersonCode,blocked`);
  if (!custRes.ok) {
    console.log(`  customers -> HTTP ${custRes.status} — could not read. ${(custRes.text || "").slice(0, 300)}\n`);
  } else {
    const all = custRes.rows;
    const active = all.filter((c) => !c.blocked || c.blocked === " " || c.blocked === "_x0020_");
    const withCode = (list) => list.filter((c) => (c.salespersonCode || "").trim() !== "").length;
    const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "n/a");
    console.log(`  Total customers:            ${all.length}`);
    console.log(`  Active (not blocked):       ${active.length}`);
    console.log(`  Active w/ salespersonCode:  ${withCode(active)}  (${pct(withCode(active), active.length)})`);
    console.log(`  All w/ salespersonCode:     ${withCode(all)}  (${pct(withCode(all), all.length)})`);
    const missing = active.length - withCode(active);
    console.log(`  -> ${missing} active customer(s) would hit the salesperson fallback path.\n`);
  }

  // ---- Q2: item cross-reference / item reference population ------------------
  // NOTE: standard API v2.0 does not expose the Item Reference table. Try the
  // known candidate endpoints and report honestly which (if any) are reachable.
  console.log("Q2  Item cross-reference / item reference population");
  const candidates = ["itemReferences?$top=1&$count=true", "itemCrossReferences?$top=1&$count=true"];
  let found = false;
  for (const ep of candidates) {
    const r = await get(`companies(${company.id})/${ep}`);
    const name = ep.split("?")[0];
    if (r.ok) {
      found = true;
      const count = r.json?.["@odata.count"];
      console.log(`  ${name}: HTTP 200 — reachable${count != null ? `, ${count} row(s)` : ""}`);
    } else {
      console.log(`  ${name}: HTTP ${r.status} — not a standard v2.0 endpoint here`);
    }
  }
  if (!found) {
    console.log("  None of the standard endpoints expose item references. To answer Q2 we need");
    console.log("  either a small custom API page over the Item Reference table, or an OData");
    console.log("  query endpoint. Flag this as a BC-side item to confirm with the BC admin.\n");
  } else {
    console.log("");
  }

  // ---- Field shapes for check design ----------------------------------------
  console.log("Field shapes (names only, no values) for check design:");
  for (const entity of ["customers", "items", "salesOrders"]) {
    await shape(company, entity);
  }
  console.log("\nData-quality probe done (read-only).");
}

main().catch((e) => { console.error(e); process.exit(1); });
