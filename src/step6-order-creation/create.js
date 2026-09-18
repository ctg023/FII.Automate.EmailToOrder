// Step 6 — create the verified order in Business Central as a Sales ORDER (all in
// stock) or a Sales QUOTE (some lines short). SAFE BY DEFAULT: dry-run only — it
// builds and prints the exact payload but writes NOTHING. An actual write requires
// the explicit --create flag AND naming the target company with --company, and is
// intended for a BC SANDBOX only (never production).
//
//   node src/step6-order-creation/create.js --order <file.json>            # dry-run (default)
//   node src/step6-order-creation/create.js --order <file.json> --create --company "<Sandbox>"
//
// Mapping: customerNumber <- resolved customer; externalDocumentNumber <- PO number
// (traceability + duplicate detection); order/requested dates when ISO; each line ->
// lineType "Item", lineObjectNumber = our resolved item number, quantity as ordered.
// UoM is intentionally omitted for now (order-vs-base UoM mapping is unresolved — BC
// uses the item's base UoM). Nothing is released; the doc is created in its open state.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { verifyOrder } from "../step4-bc-verification/verify.js";

const BASE = (process.env.BC_BASE_URL || "").replace(/\/$/, "");
const USER = process.env.BC_USERNAME, PASS = process.env.BC_PASSWORD, COMPANY = process.env.BC_COMPANY;
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

async function api(method, path, body) {
  const res = await fetch(`${BASE}/${path}`, {
    method,
    headers: { Authorization: AUTH, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function resolveCompany() {
  const r = await api("GET", "companies");
  if (!r.ok) throw new Error(`companies -> HTTP ${r.status}`);
  const companies = r.json?.value || [];
  const c = COMPANY ? companies.find((x) => (x.name || "").toLowerCase() === COMPANY.toLowerCase()) : companies[0];
  if (!c) throw new Error(COMPANY ? `Company "${COMPANY}" not found` : "No companies");
  return c;
}

const isISO = (s) => /^\d{4}-\d{2}-\d{2}/.test(s || "");
const unwrap = (j) => (j && j.extraction ? j.extraction : j);

// Build the BC document (header + lines) from a verified order.
function buildDoc(order, res) {
  const header = { customerNumber: res.rule1.match?.number };
  if (order.po_number) header.externalDocumentNumber = String(order.po_number).slice(0, 35);
  if (isISO(order.order_date)) header.orderDate = order.order_date.slice(0, 10);
  if (isISO(order.requested_ship_date)) header.requestedDeliveryDate = order.requested_ship_date.slice(0, 10);
  const lines = res.lines
    .map((l, i) => ({ lineType: "Item", lineObjectNumber: l.item, quantity: order.line_items?.[i]?.quantity }))
    .filter((l) => l.lineObjectNumber && l.quantity != null);
  const ent = res.disposition === "order" ? "salesOrders" : "salesQuotes";
  const lineEnt = res.disposition === "order" ? "salesOrderLines" : "salesQuoteLines";
  return { docType: res.disposition, ent, lineEnt, header, lines };
}

async function run({ orderPath, doCreate, targetCompany }) {
  const order = unwrap(JSON.parse(readFileSync(orderPath, "utf8")));
  const res = await verifyOrder(order);

  console.log(`PO ${order.po_number ?? "?"} — "${order.customer?.name ?? "?"}"  →  ${res.disposition.toUpperCase()}`);
  console.log(`  ${res.dispositionReason}`);
  if (res.disposition === "review") {
    console.log("  ⛔ Not creatable — needs a human to resolve the customer/parts first.");
    return;
  }

  const doc = buildDoc(order, res);
  console.log(`\n  Would POST ${doc.ent}:`);
  console.log("    " + JSON.stringify(doc.header));
  console.log(`  then POST ${doc.lineEnt} ×${doc.lines.length}:`);
  doc.lines.forEach((l) => console.log("    " + JSON.stringify(l)));

  if (!doCreate) {
    console.log("\n  DRY RUN — nothing written to BC. Re-run with --create --company \"<sandbox>\" to write.");
    return;
  }

  // --- guarded real write (sandbox only) ---
  const company = await resolveCompany();
  if (!targetCompany || targetCompany.toLowerCase() !== company.name.toLowerCase()) {
    console.error(`\n  REFUSING TO WRITE: --company must exactly match the target company.`);
    console.error(`  Resolved company is "${company.name}". Pass --company "${company.name}" to confirm you intend to write there.`);
    process.exit(1);
  }
  console.log(`\n  Writing to "${company.name}" (id ${company.id}) ...`);
  const hdr = await api("POST", `companies(${company.id})/${doc.ent}`, doc.header);
  if (!hdr.ok) { console.error(`  header POST failed HTTP ${hdr.status}: ${(hdr.text || "").slice(0, 400)}`); process.exit(1); }
  const docId = hdr.json?.id, number = hdr.json?.number;
  console.log(`  created ${doc.docType} ${number ?? ""} (id ${docId})`);
  for (const line of doc.lines) {
    const lr = await api("POST", `companies(${company.id})/${doc.ent}(${docId})/${doc.lineEnt}`, line);
    console.log(`    line ${line.lineObjectNumber} x${line.quantity} -> HTTP ${lr.status}${lr.ok ? " ok" : " FAILED: " + (lr.text || "").slice(0, 200)}`);
  }
  console.log(`  Done. Review ${doc.docType} ${number ?? docId} in BC (created open, not released).`);
}

function main() {
  for (const [k, v] of [["BC_BASE_URL", BASE], ["BC_USERNAME", USER], ["BC_PASSWORD", PASS]]) {
    if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
  }
  const args = process.argv.slice(2);
  const orderPath = args[args.indexOf("--order") + 1];
  if (args.indexOf("--order") === -1 || !orderPath) {
    console.log('Usage: create.js --order <file.json> [--create --company "<Sandbox company>"]');
    console.log("Default is a DRY RUN (writes nothing).");
    return;
  }
  const doCreate = args.includes("--create");
  const targetCompany = args.indexOf("--company") !== -1 ? args[args.indexOf("--company") + 1] : null;
  return run({ orderPath, doCreate, targetCompany });
}

main();
