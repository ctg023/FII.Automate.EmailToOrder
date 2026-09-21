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

export async function resolveCompany() {
  const r = await api("GET", "companies");
  if (!r.ok) throw new Error(`companies -> HTTP ${r.status}`);
  const companies = r.json?.value || [];
  const c = COMPANY ? companies.find((x) => (x.name || "").toLowerCase() === COMPANY.toLowerCase()) : companies[0];
  if (!c) throw new Error(COMPANY ? `Company "${COMPANY}" not found` : "No companies");
  return c;
}

const isISO = (s) => /^\d{4}-\d{2}-\d{2}/.test(s || "");
// Local (order-entry) date as YYYY-MM-DD — the day filled on the line when stock is
// available, so the confirmation shows it. Local, not UTC, to avoid a near-midnight skew.
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const unwrap = (j) => (j && j.extraction ? j.extraction : j);

// Numbering is owned entirely by BC: the "Email Order No. Series" AL subscriber
// (keyed to the EMAILORDER user) stamps S-ORD-EMAIL / S-QUO-EMAIL on API-created
// docs. This tool posts WITHOUT a number and never manages a sequence.

// Duplicate-PO guard: has this PO already been turned into a doc for this customer?
// Checks open orders, open quotes, and posted invoices for the same
// externalDocumentNumber + customerNumber. Returns any matches found.
export async function findDuplicates(company, custNumber, poNumber) {
  if (!custNumber || !poNumber) return [];
  const po = String(poNumber).replace(/'/g, "''");
  const cust = String(custNumber).replace(/'/g, "''");
  const filter = `externalDocumentNumber eq '${po}' and customerNumber eq '${cust}'`;
  const out = [];
  for (const ent of ["salesOrders", "salesQuotes", "salesInvoices"]) {
    const r = await api("GET", encodeURI(`companies(${company.id})/${ent}?$filter=${filter}&$select=number,status`));
    if (r.ok) for (const d of (r.json?.value || [])) out.push({ ent, number: d.number, status: d.status });
  }
  return out;
}

// Build the BC document (header + lines) from a verified order.
function buildDoc(order, res) {
  const header = { customerNumber: res.rule1.match?.number };
  if (order.po_number) header.externalDocumentNumber = String(order.po_number).slice(0, 35);
  // Sales orders use `orderDate`; sales quotes use `documentDate`.
  const isOrder = res.disposition === "order";
  const dateField = isOrder ? "orderDate" : "documentDate";
  if (isISO(order.order_date)) header[dateField] = order.order_date.slice(0, 10);
  // Requested delivery date (General fast tab): the PO's requested/required date, else
  // TODAY's order-entry date (the day the line ships when stock is available). Order only
  // — salesQuote 400s on requestedDeliveryDate. The line Shipment Date (Shipping & Billing)
  // is set to MATCH below (the API doesn't expose the header Shipment Date).
  let delivery = null;
  if (isOrder) {
    delivery = isISO(order.requested_ship_date) ? order.requested_ship_date.slice(0, 10) : todayISO();
    header.requestedDeliveryDate = delivery;
  }
  // Ship-to + contact from the matched BC records (Rules 4 & 5), so the doc uses the
  // address/contact on file rather than re-typed values.
  const s = res.shipTo?.shipTo;
  if (s) {
    if (s.Name) header.shipToName = s.Name;
    if (s.Address) header.shipToAddressLine1 = s.Address;
    header.shipToAddressLine2 = s.Address_2 || "";
    if (s.City) header.shipToCity = s.City;
    if (s.County) header.shipToState = s.County;
    if (s.Post_Code) header.shipToPostCode = s.Post_Code;
  }
  if (res.contact?.contact?.name) header.shipToContact = res.contact.contact.name;
  const lines = res.lines
    .map((l, i) => {
      const ln = { lineType: "Item", lineObjectNumber: l.item, quantity: order.line_items?.[i]?.quantity };
      if (delivery) ln.shipmentDate = delivery; // Shipment Date matches the requested delivery date
      return ln;
    })
    .filter((l) => l.lineObjectNumber && l.quantity != null);
  const ent = res.disposition === "order" ? "salesOrders" : "salesQuotes";
  const lineEnt = res.disposition === "order" ? "salesOrderLines" : "salesQuoteLines";
  return { docType: res.disposition, ent, lineEnt, header, lines };
}

// Programmatic create — for the Step-5 review server. Returns a structured result
// (never console/exit). doCreate=false = dry-run preview (build doc + duplicate
// check, write nothing). doCreate=true = guarded real write to the sandbox: the
// caller must pass targetCompany matching the resolved company, exactly like the CLI.
// Does a created doc still exist in BC? Used by the review app to return an order
// to the queue if its BC document was later deleted. Read-only.
export async function docExists(company, docType, number) {
  if (!number) return false;
  const ent = docType === "quote" ? "salesQuotes" : "salesOrders";
  const n = String(number).replace(/'/g, "''");
  const r = await api("GET", encodeURI(`companies(${company.id})/${ent}?$filter=number eq '${n}'&$select=number`));
  return r.ok && (r.json?.value?.length > 0);
}

export async function createDoc(order, { doCreate = false, targetCompany = null, allowDuplicate = false, forceCustomer = null } = {}) {
  const res = await verifyOrder(order, forceCustomer ? { forceCustomer } : {});
  if (res.disposition === "review") {
    return { ok: false, stage: "verify", disposition: res.disposition, dispositionReason: res.dispositionReason };
  }
  const company = await resolveCompany();
  const doc = buildDoc(order, res);
  const duplicates = await findDuplicates(company, res.rule1.match?.number, order.po_number);
  const preview = { docType: doc.docType, company: company.name, header: doc.header, lines: doc.lines, duplicates };

  if (!doCreate) return { ok: true, dryRun: true, ...preview };

  if (!targetCompany || targetCompany.toLowerCase() !== company.name.toLowerCase()) {
    return { ok: false, stage: "guard", reason: `company mismatch — pass "${company.name}" to confirm the write target`, ...preview };
  }
  if (duplicates.length && !allowDuplicate) {
    return { ok: false, stage: "duplicate", reason: `PO "${order.po_number}" already exists in BC`, ...preview };
  }
  const hdr = await api("POST", `companies(${company.id})/${doc.ent}`, doc.header);
  if (!hdr.ok) return { ok: false, stage: "post-header", reason: `header POST HTTP ${hdr.status}: ${(hdr.text || "").slice(0, 300)}`, ...preview };
  const docId = hdr.json?.id, number = hdr.json?.number;
  const lineResults = [];
  for (const line of doc.lines) {
    const lr = await api("POST", `companies(${company.id})/${doc.ent}(${docId})/${doc.lineEnt}`, line);
    lineResults.push({ item: line.lineObjectNumber, quantity: line.quantity, ok: lr.ok, status: lr.status });
  }
  return { ok: true, created: true, docType: doc.docType, number, id: docId, company: company.name, duplicates, lineResults };
}

async function run({ orderPath, doCreate, targetCompany, allowDuplicate }) {
  const order = unwrap(JSON.parse(readFileSync(orderPath, "utf8")));
  const res = await verifyOrder(order);

  console.log(`PO ${order.po_number ?? "?"} — "${order.customer?.name ?? "?"}"  →  ${res.disposition.toUpperCase()}`);
  console.log(`  ${res.dispositionReason}`);
  if (res.disposition === "review") {
    console.log("  ⛔ Not creatable — needs a human to resolve the customer/parts first.");
    return;
  }

  const company = await resolveCompany();           // read-only
  const doc = buildDoc(order, res);

  // BC assigns the number via the "Email Order No. Series" subscriber (EMAILORDER user).
  console.log(`\n  Would POST ${doc.ent} (number assigned by BC — Email Order No. Series subscriber):`);
  console.log("    " + JSON.stringify(doc.header));
  console.log(`  then POST ${doc.lineEnt} ×${doc.lines.length}:`);
  doc.lines.forEach((l) => console.log("    " + JSON.stringify(l)));

  // Duplicate-PO guard (read-only) — surface any existing doc for this PO + customer.
  const dups = await findDuplicates(company, res.rule1.match?.number, order.po_number);
  if (dups.length) {
    console.log(`\n  ⚠ DUPLICATE CHECK — PO "${order.po_number}" already exists for customer ${res.rule1.match?.number}:`);
    dups.forEach((d) => console.log(`     - ${d.ent} ${d.number}${d.status ? ` [${d.status}]` : ""}`));
  } else {
    console.log(`\n  Duplicate check: none found for PO "${order.po_number}" / customer ${res.rule1.match?.number}.`);
  }

  if (!doCreate) {
    console.log("\n  DRY RUN — nothing written to BC. Re-run with --create --company \"<sandbox>\" to write.");
    return;
  }

  // --- guarded real write (sandbox only) ---
  if (!targetCompany || targetCompany.toLowerCase() !== company.name.toLowerCase()) {
    console.error(`\n  REFUSING TO WRITE: --company must exactly match the target company.`);
    console.error(`  Resolved company is "${company.name}". Pass --company "${company.name}" to confirm you intend to write there.`);
    process.exit(1);
  }
  if (dups.length && !allowDuplicate) {
    console.error(`\n  REFUSING TO WRITE: PO "${order.po_number}" already exists in BC (see duplicate check above).`);
    console.error(`  Re-run with --allow-duplicate to create it anyway.`);
    process.exit(1);
  }
  console.log(`\n  Writing to "${company.name}" (id ${company.id}) ...`);

  const hdr = await api("POST", `companies(${company.id})/${doc.ent}`, doc.header);
  if (!hdr.ok) { console.error(`  header POST failed HTTP ${hdr.status}: ${(hdr.text || "").slice(0, 500)}`); process.exit(1); }
  const docId = hdr.json?.id, number = hdr.json?.number;
  console.log(`  created ${doc.docType} ${number} (id ${docId})`);
  for (const line of doc.lines) {
    const lr = await api("POST", `companies(${company.id})/${doc.ent}(${docId})/${doc.lineEnt}`, line);
    console.log(`    line ${line.lineObjectNumber} x${line.quantity} -> HTTP ${lr.status}${lr.ok ? " ok" : " FAILED: " + (lr.text || "").slice(0, 200)}`);
  }
  console.log(`  Done. Review ${doc.docType} ${number} in BC (created open, not released).`);
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
  const allowDuplicate = args.includes("--allow-duplicate");
  const targetCompany = args.indexOf("--company") !== -1 ? args[args.indexOf("--company") + 1] : null;
  return run({ orderPath, doCreate, targetCompany, allowDuplicate });
}

// Only run the CLI when executed directly; importing (e.g. findDuplicates from the
// Step-5 pipeline) must NOT trigger main() — this module can WRITE to BC.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
