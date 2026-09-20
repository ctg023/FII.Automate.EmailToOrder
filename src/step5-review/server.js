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
import { page } from "./render.js";

const PORT = Number(process.env.REVIEW_PORT || 8787);
const STORE = process.env.REVIEW_STORE || "out/review-store.json";
const PDF_ROOT = resolve("out/pdfs");
const TARGET_COMPANY = process.env.BC_COMPANY || null; // the sandbox company to write to

const loadStore = () => { try { return JSON.parse(readFileSync(STORE, "utf8")); } catch { return { threads: {} }; } };
const saveStore = (s) => { import("node:fs").then(({ writeFileSync }) => writeFileSync(STORE, JSON.stringify(s, null, 2))); };

// Rebuild the extracted-order shape (Step-2) from a stored review record.
const orderFromRecord = (rec) => ({
  customer: rec.customer, po_number: rec.po_number, order_date: rec.order_date,
  requested_ship_date: rec.requested_ship_date, ship_to: rec.ship_to, line_items: rec.line_items,
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
  res.writeHead(200, { "Content-Type": MIME[extname(full).toLowerCase()] || "application/octet-stream" });
  res.end(readFileSync(full));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/") {
    const store = loadStore();
    const records = openRecords(store);
    const tally = records.reduce((t, r) => ((t[r.disposition] = (t[r.disposition] || 0) + 1), t), {});
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(page({ generated: store.generated, records, tally }, { interactive: true }));
  }
  if (req.method === "GET" && p.startsWith("/pdfs/")) return servePdf(req, res, p);

  if (req.method === "POST" && p === "/api/preview") {
    const { conversationId } = await readBody(req);
    const entry = loadStore().threads[conversationId];
    if (!entry?.record) return json(res, 404, { ok: false, reason: "not found" });
    try { return json(res, 200, await createDoc(orderFromRecord(entry.record), { doCreate: false })); }
    catch (e) { return json(res, 500, { ok: false, reason: e.message }); }
  }

  if (req.method === "POST" && p === "/api/approve") {
    const { conversationId, allowDuplicate } = await readBody(req);
    const store = loadStore();
    const entry = store.threads[conversationId];
    if (!entry?.record) return json(res, 404, { ok: false, reason: "not found" });
    try {
      const out = await createDoc(orderFromRecord(entry.record), { doCreate: true, targetCompany: TARGET_COMPANY, allowDuplicate: !!allowDuplicate });
      if (out.ok && out.created) { // mark actioned so it leaves the open queue
        entry.record.status = "actioned"; entry.record.bc_number = out.number; entry.record.bc_docType = out.docType;
        saveStore(store);
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
