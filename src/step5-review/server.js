// Step 5 — LIVE review server (Option B, v1).
//
// Serves the review queue as an interactive page and wires the buttons to real
// actions. HUMAN-IN-THE-LOOP is preserved: Approve is two-step — a dry-run preview
// (build the BC doc + duplicate check, write nothing) then, only after the rep
// confirms, a guarded real create against the BC sandbox (BC260TEST / the company
// in BC_COMPANY). Nothing auto-creates. Verification and reads are read-only.
//
// Runs as a standalone Node service; an IIS reverse proxy sits in front later with
// no code change. It reads the pipeline's store (out/review-store.json) fresh on
// every request, so a --run refresh shows up immediately.
//
// Usage (PowerShell): $env:NODE_OPTIONS="--use-system-ca"; node src/step5-review/server.js
//   then open http://localhost:8787
import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, normalize, extname } from "node:path";
import { spawn } from "node:child_process";
import { createDoc } from "../step6-order-creation/create.js";
import { verifyOrder, searchCustomers, listShipTos } from "../step4-bc-verification/verify.js";
import { setAlias } from "./aliases.js";
import { acknowledge } from "./acknowledge.js";
import { page } from "./render.js";
import { bcqNumbers } from "./thread-merge.js";

const PORT = Number(process.env.REVIEW_PORT || 8787);
const STORE = process.env.REVIEW_STORE || "out/review-store.json";
const PDF_ROOT = resolve("out/pdfs");
const TARGET_COMPANY = process.env.BC_COMPANY || null; // the sandbox company to write to
// Ship-from branches a rep may re-point an order to (same list the stock cells use).
const STOCK_LOCATIONS = (process.env.STOCK_LOCATIONS || "CL,CH,AT").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const BC_WEB_URL = process.env.BC_WEB_URL || null;     // BC web client base (browser URL), for deep links

// Deep link to open a created doc in the BC web client. Sales Quote = page 41,
// Sales Order = page 42. Needs BC_WEB_URL set (the browser URL, not the API URL).
function bcLink(docType, number) {
  if (!BC_WEB_URL || !number) return null;
  const page = docType === "quote" ? 41 : 42;
  const base = BC_WEB_URL.split("?")[0].replace(/\/$/, ""); // drop any existing ?query and trailing slash
  // Use %20 (encodeURIComponent), NOT + (URLSearchParams) — the BC filter needs %20.
  const company = encodeURIComponent(TARGET_COMPANY || "");
  const filter = encodeURIComponent(`'No.' IS '${number}'`);
  return `${base}/?company=${company}&page=${page}&filter=${filter}`;
}

const loadStore = () => { try { return JSON.parse(readFileSync(STORE, "utf8")); } catch { return { threads: {} }; } };
const saveStore = (s) => { import("node:fs").then(({ writeFileSync }) => writeFileSync(STORE, JSON.stringify(s, null, 2))); };

// Rebuild the extracted-order shape (Step-2) from a stored review record. When the PO
// stated no requested/ship date, create.js fills TODAY's order-entry date (and sets the
// line Shipment Date to match) — so pass the requested date through as-is here.
const orderFromRecord = (rec) => ({
  customer: rec.customer, po_number: rec.po_number, order_date: rec.order_date,
  requested_ship_date: rec.requested_ship_date,
  ship_to: rec.ship_to, line_items: rec.line_items,
  special_instructions: rec.special_instructions,
  service_action_required: rec.service_action_required, service_action_reason: rec.service_action_reason,
  quote_refs: rec.quote_refs?.length ? rec.quote_refs : [...new Set((rec.conversation || []).flatMap((m) => bcqNumbers(m.subject || "")))],
});

// All active rep overrides for a record, so every re-verify / preview / create carries
// the full set (customer, ship-to, ship-from location, price-reviewed lines) — not just
// the one being changed. Mirrors the verifyOrder / createDoc opts shape.
const optsFromRecord = (r) => ({
  ...(r.customer_assigned ? { forceCustomer: { number: r.customer_assigned.number, displayName: r.customer_assigned.name } } : {}),
  ...(r.shipto_assigned?.code ? { forceShipTo: r.shipto_assigned.code } : {}),
  ...(r.location_assigned?.code ? { forceLocation: r.location_assigned.code } : {}),
});

// Open queue = cached order/quote/review records not yet actioned.
function openRecords(store) {
  return Object.values(store.threads)
    .filter((x) => x.record && x.disposition !== "not_order" && x.record.status !== "actioned")
    .map((x) => x.record)
    .sort((a, b) => (b.last_received || "").localeCompare(a.last_received || ""));
}

const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch { res({}); } }); });
const json = (r, code, obj) => { r.writeHead(code, { "Content-Type": "application/json" }); r.end(JSON.stringify(obj)); };

const MIME = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg" };
function servePdf(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/pdfs\//, ""));
  const full = normalize(resolve(PDF_ROOT, rel));
  if (!full.startsWith(PDF_ROOT) || !existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); return res.end("not found"); }
  const buf = readFileSync(full);
  // `inline` (not `attachment`) tells the browser to render the PDF in its viewer/new
  // tab rather than prompt a download. Quote the filename so spaces don't break the header.
  const name = full.split(/[\\/]/).pop().replace(/"/g, "");
  res.writeHead(200, {
    "Content-Type": MIME[extname(full).toLowerCase()] || "application/octet-stream",
    "Content-Disposition": `inline; filename="${name}"`,
    "Content-Length": buf.length,
  });
  res.end(buf);
}

// Resolve a client-supplied pdfs/ path to a real file UNDER PDF_ROOT (rejects anything
// outside it), so the open endpoint can't be pointed at an arbitrary file on disk.
function resolvePdf(relPath) {
  const rel = decodeURIComponent(String(relPath || "").replace(/^\/?pdfs\//, ""));
  const full = normalize(resolve(PDF_ROOT, rel));
  if (!full.startsWith(PDF_ROOT) || !existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

// Launch a file in the machine's default application (Adobe/Edge/etc.). This opens on
// the HOST running the server — intended for local use (viewer on the same machine).
// Detached + unref so the viewer's lifetime is independent of the server.
function openInDefaultApp(fullPath) {
  const child =
    process.platform === "win32" ? spawn("cmd", ["/c", "start", "", fullPath], { detached: true, stdio: "ignore" })
    : process.platform === "darwin" ? spawn("open", [fullPath], { detached: true, stdio: "ignore" })
    : spawn("xdg-open", [fullPath], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/") {
    const store = loadStore();
    const records = openRecords(store);
    const tally = records.reduce((t, r) => ((t[r.disposition] = (t[r.disposition] || 0) + 1), t), {});
    // Actioned orders whose acknowledgement failed to send (excludes intentional dry-runs).
    const needsAck = Object.values(store.threads)
      .map((x) => x.record)
      .filter((r) => r && r.status === "actioned" && r.ack && r.ack.sent === false && !/dry-run/i.test(r.ack.reason || ""))
      .sort((a, b) => (b.ack?.at || "").localeCompare(a.ack?.at || ""));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(page({ generated: store.generated, records, tally, needsAck }, { interactive: true }));
  }
  if (req.method === "GET" && p.startsWith("/pdfs/")) return servePdf(req, res, p);

  // Open a saved PDF in the host's default PDF viewer (local-use convenience).
  if (req.method === "POST" && p === "/api/open-pdf") {
    const { path: relPath } = await readBody(req);
    const full = resolvePdf(relPath);
    if (!full) return json(res, 404, { ok: false, reason: "PDF not found" });
    try { openInDefaultApp(full); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 500, { ok: false, reason: e.message }); }
  }

  if (req.method === "GET" && p === "/api/search-customers") {
    try { return json(res, 200, { ok: true, results: await searchCustomers(url.searchParams.get("q")) }); }
    catch (e) { return json(res, 500, { ok: false, reason: e.message }); }
  }

  // Assign a customer a rep picked from the "did you mean" list, then re-verify.
  if (req.method === "POST" && p === "/api/assign") {
    const { conversationId, customerNumber, customerName } = await readBody(req);
    const store = loadStore();
    const entry = store.threads[conversationId];
    if (!entry?.record) return json(res, 404, { ok: false, reason: "not found" });
    try {
      const res2 = await verifyOrder(orderFromRecord(entry.record), { forceCustomer: { number: customerNumber, displayName: customerName } });
      const r = entry.record;
      r.rule1 = res2.rule1; r.lines = res2.lines; r.linesPass = res2.linesPass;
      // Re-scan Rules 4 & 5 against the newly-assigned customer (verifyOrder already
      // computed them) so the Ship-To / Contact panels reflect the new customer, not
      // the stale pre-change result.
      r.shipTo = res2.shipTo; r.contact = res2.contact;
      r.disposition = res2.disposition; r.dispositionReason = res2.dispositionReason; entry.disposition = res2.disposition;
      // Re-derived overlays for the newly-assigned customer (payment gate, high-value, blocked).
      r.paymentReview = res2.paymentReview; r.customerBlocked = res2.customerBlocked;
      r.requiresApproval = res2.requiresApproval; r.approvalReason = res2.approvalReason;
      r.orderTotal = res2.orderTotal; r.threshold = res2.threshold; r.blockedLines = res2.blockedLines;
      r.customer_assigned = { number: customerNumber, name: customerName };
      // A prior ship-to / ship-from pick belongs to the old customer.
      delete r.shipto_assigned;
      delete r.location_assigned;
      saveStore(store);
      // Learn from the pick: future emails from this customer (domain/name) auto-resolve.
      setAlias({ email: r.customer?.contact_email, name: r.customer?.name, number: customerNumber, customerName });
      return json(res, 200, { ok: true, disposition: res2.disposition, dispositionReason: res2.dispositionReason });
    } catch (e) { return json(res, 500, { ok: false, reason: e.message }); }
  }

  // Resend a failed order acknowledgement for an already-created order.
  if (req.method === "POST" && p === "/api/resend-ack") {
    const { conversationId } = await readBody(req);
    const store = loadStore();
    const entry = store.threads[conversationId];
    if (!entry?.record?.bc_number) return json(res, 404, { ok: false, reason: "no created order for this thread" });
    const r = entry.record;
    try {
      const ack = await acknowledge(r, { docType: r.bc_docType, number: r.bc_number });
      r.ack = { sent: !!ack.sent, to: ack.to || null, subject: ack.subject || null, reason: ack.reason || null, at: new Date().toISOString() };
      saveStore(store);
      return json(res, 200, { ok: true, sent: r.ack.sent, to: r.ack.to, reason: r.ack.reason });
    } catch (e) { return json(res, 500, { ok: false, reason: e.message }); }
  }

  // List the (resolved) customer's ship-to addresses for the "change ship-to" picker.
  if (req.method === "GET" && p === "/api/shiptos") {
    const entry = loadStore().threads[url.searchParams.get("conversationId")];
    const custNo = entry?.record?.customer_assigned?.number || entry?.record?.rule1?.match?.number;
    if (!custNo) return json(res, 200, { ok: true, results: [] });
    try { return json(res, 200, { ok: true, results: await listShipTos(custNo) }); }
    catch (e) { return json(res, 500, { ok: false, reason: e.message }); }
  }

  // Assign a ship-to a rep picked, then re-verify (clears the ship-to gate).
  if (req.method === "POST" && p === "/api/assign-shipto") {
    const { conversationId, code } = await readBody(req);
    const store = loadStore();
    const entry = store.threads[conversationId];
    if (!entry?.record) return json(res, 404, { ok: false, reason: "not found" });
    const r = entry.record;
    try {
      const res2 = await verifyOrder(orderFromRecord(r), { ...optsFromRecord(r), forceShipTo: code });
      r.shipTo = res2.shipTo; r.contact = res2.contact;
      r.disposition = res2.disposition; r.dispositionReason = res2.dispositionReason; entry.disposition = res2.disposition;
      r.shipto_assigned = { code };
      saveStore(store);
      return json(res, 200, { ok: true, disposition: res2.disposition, dispositionReason: res2.dispositionReason });
    } catch (e) { return json(res, 500, { ok: false, reason: e.message }); }
  }

  // Assign a ship-from location a rep picked (STOCK_LOCATIONS branch), then re-verify. A
  // line short at the customer's default branch can flip to in-stock (Quote→Order) when the
  // chosen branch has stock. code = "" clears the override (back to the customer's default).
  if (req.method === "POST" && p === "/api/assign-location") {
    const { conversationId, code } = await readBody(req);
    const store = loadStore();
    const entry = store.threads[conversationId];
    if (!entry?.record) return json(res, 404, { ok: false, reason: "not found" });
    const loc = (code || "").trim().toUpperCase();
    if (loc && !STOCK_LOCATIONS.includes(loc)) return json(res, 400, { ok: false, reason: `unknown location "${loc}" (allowed: ${STOCK_LOCATIONS.join(", ")})` });
    const r = entry.record;
    if (loc) r.location_assigned = { code: loc }; else delete r.location_assigned;
    try {
      const res2 = await verifyOrder(orderFromRecord(r), optsFromRecord(r));
      r.lines = res2.lines; r.linesPass = res2.linesPass;
      r.disposition = res2.disposition; r.dispositionReason = res2.dispositionReason; entry.disposition = res2.disposition;
      saveStore(store);
      return json(res, 200, { ok: true, disposition: res2.disposition, dispositionReason: res2.dispositionReason });
    } catch (e) { return json(res, 500, { ok: false, reason: e.message }); }
  }

  if (req.method === "POST" && p === "/api/preview") {
    const { conversationId } = await readBody(req);
    const entry = loadStore().threads[conversationId];
    if (!entry?.record) return json(res, 404, { ok: false, reason: "not found" });
    try { return json(res, 200, await createDoc(orderFromRecord(entry.record), { doCreate: false, ...optsFromRecord(entry.record) })); }
    catch (e) { return json(res, 500, { ok: false, reason: e.message }); }
  }

  if (req.method === "POST" && p === "/api/approve") {
    const { conversationId, allowDuplicate, approver } = await readBody(req);
    const store = loadStore();
    const entry = store.threads[conversationId];
    if (!entry?.record) return json(res, 404, { ok: false, reason: "not found" });
    try {
      // `approver` = the second, independent sign-off for high-value POs (createDoc
      // refuses a high-value write without it). Ignored for normal-value POs.
      const out = await createDoc(orderFromRecord(entry.record), { doCreate: true, targetCompany: TARGET_COMPANY, allowDuplicate: !!allowDuplicate, approval: approver, ...optsFromRecord(entry.record) });
      if (out.ok && out.created) { // mark actioned so it leaves the open queue
        entry.record.status = "actioned"; entry.record.bc_number = out.number; entry.record.bc_docType = out.docType;
        entry.record.bc_url = bcLink(out.docType, out.number);
        if (out.approvedBy) entry.record.approved_by = out.approvedBy; // audit: who signed off
        // Order acknowledgement to the customer. Composes always; SENDS only when ACK_SEND=1
        // + a recipient exists (see acknowledge.js). A send problem never fails the create.
        try {
          const ack = await acknowledge(entry.record, out);
          entry.record.ack = { sent: !!ack.sent, to: ack.to || null, subject: ack.subject || null, reason: ack.reason || null, at: new Date().toISOString() };
          out.ack = entry.record.ack;
        } catch (e) { out.ack = { sent: false, reason: `ack error: ${e.message}` }; }
        saveStore(store);
        out.url = entry.record.bc_url;
      }
      return json(res, 200, out);
    } catch (e) { return json(res, 500, { ok: false, reason: e.message }); }
  }

  if (req.method === "POST" && p === "/api/refresh") {
    // Re-run the pipeline for new mail (child process; inherits corporate-CA env).
    const child = spawn(process.execPath, ["src/step5-review/pipeline.js", "--run"], {
      cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "--use-system-ca" },
    });
    let tail = "";
    child.stdout.on("data", (d) => (tail += d));
    child.stderr.on("data", (d) => (tail += d));
    child.on("close", () => {
      const m = tail.match(/Rendered .*|Order \d+ · Quote \d+ · Needs review \d+/g);
      json(res, 200, { ok: true, message: m ? m[m.length - 1].trim() : "refreshed" });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

createServer((req, res) => handle(req, res).catch((e) => { json(res, 500, { ok: false, reason: e.message }); }))
  .listen(PORT, () => {
    console.log(`Review server on http://localhost:${PORT}`);
    console.log(`  store: ${STORE} · write target (BC_COMPANY): ${TARGET_COMPANY || "(unset!)"}`);
    console.log(`  Approve = dry-run preview -> confirm -> guarded create. Reads are read-only.`);
  });
