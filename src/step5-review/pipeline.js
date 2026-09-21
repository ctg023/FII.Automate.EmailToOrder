// Step 5 — LIVE review runner (Option A).
//
// Pulls the order@ mailbox (Inbox = inbound customer mail, Sent Items = outbound
// rep replies), groups messages into THREADS by Graph conversationId, then for
// each thread runs: classify (Step 3) -> extract (Step 2) -> verify against BC
// (Step 4) -> render the review page (Step 5). One card per thread; the whole
// back-and-forth is shown so a rep can follow the order all the way through.
//
// INCREMENTAL: results are cached per conversationId in out/review-store.json. A
// re-run only sends NEW/changed threads to Claude, then re-renders the whole open
// queue — so "refresh" is cheap (you pay only for genuinely new mail).
//
// READ-ONLY on the mailbox and on BC. The only writes are local files in out/
// (which hold customer PII — git-ignored). Buttons in the page are still a mock;
// nothing is created in BC here. Order creation stays the separate, human-approved
// Step-6 tool.
//
// ⚠️ v1 limitation: extraction reads the email BODY text only. Attachment CONTENT
// (the PDF/Word PO itself) is NOT yet fed to the model — only its filename. Orders
// that live entirely in a PDF will extract thin / land in "needs review" until we
// add native-attachment passthrough (the next increment).
//
// Usage (PowerShell; set $env:NODE_OPTIONS="--use-system-ca" first):
//   node src/step5-review/pipeline.js --threads            # FREE: pull+group, list threads, no Claude
//   node src/step5-review/pipeline.js --estimate           # cheap: token/cost estimate for new threads
//   node src/step5-review/pipeline.js --run --limit 1      # process ONE new thread (safe first run)
//   node src/step5-review/pipeline.js --run                # process all new threads, then render
// Nothing calls Claude without --estimate or --run.
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { collectThreads, fetchAttachmentBytes } from "../ingestion/mailbox.js";
import { makeClient, extractOne, countOne } from "../step2-extraction/extract.js";
import { classifyOne } from "../step3-classification/classify.js";
import { verifyOrder } from "../step4-bc-verification/verify.js";
import { findDuplicates, resolveCompany, docExists } from "../step6-order-creation/create.js";
import { lookupAlias } from "./aliases.js";
import { page } from "./render.js";

const STORE = process.env.REVIEW_STORE || "out/review-store.json";
const OUT_HTML = process.env.REVIEW_HTML || "out/review-live.html";
const PULL_LIMIT = Number(process.env.REVIEW_PULL_LIMIT || 50); // messages to scan
// Live pipeline defaults to Sonnet 5 (cheaper; good for classify/extract at volume);
// override with MODEL=claude-opus-5 for a run.
const MODEL = process.env.MODEL || "claude-sonnet-5";

// $ per 1M tokens (mirror of run.js PRICING; keep in sync with the claude-api table).
const PRICING = {
  "claude-opus-5": { in: 5, out: 25 }, "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 }, "claude-fable-5-1": { in: 10, out: 50 },
};

const loadStore = () => { try { return JSON.parse(readFileSync(STORE, "utf8")); } catch { return { threads: {} }; } };
const saveStore = (s) => { mkdirSync(dirname(STORE), { recursive: true }); writeFileSync(STORE, JSON.stringify(s, null, 2)); };
const sameIds = (a = [], b = []) => a.length === b.length && a.every((x, i) => x === b[i]);

const isPdf = (a) => (a.contentType || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(a.name || "");
const PDF_DIR = "out/pdfs";
let _company = null;
const getCompany = async () => (_company ||= await resolveCompany());

// Save a thread's PDFs under out/pdfs/<conv>/ so a review card can link the source
// document. Returns [{name, href}] with href relative to out/ (where the page lives).
function savePdfs(conversationId, pdfs) {
  if (!pdfs.length) return [];
  // Hash the FULL conversationId — Graph ids share a long prefix, so slice(0,40)
  // collided and mixed different orders' PDFs into one folder.
  const dir = `${PDF_DIR}/${createHash("sha256").update(conversationId).digest("hex").slice(0, 16)}`;
  mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const p of pdfs) {
    const fname = (p.name || "attachment.pdf").replace(/[^A-Za-z0-9._-]/g, "_");
    try { writeFileSync(`${dir}/${fname}`, Buffer.from(p.bytes, "base64")); saved.push({ name: p.name, href: `${dir}/${fname}`.replace(/^out\//, "") }); }
    catch { /* skip unsavable */ }
  }
  return saved;
}

// For an order/quote record: has this PO already been entered in BC (dup guard),
// and save its source PDFs. Read-only against BC. Mutates the record in place.
async function enrichRecord(record, pdfs) {
  try {
    const company = await getCompany();
    record.duplicates = await findDuplicates(company, record.rule1?.match?.number, record.po_number);
  } catch { record.duplicates = []; }
  record.attachments_saved = savePdfs(record.conversationId, pdfs);
}

// Fetch native PDF bytes for a thread's non-inline attachments so the model reads
// the real PO (incl. scanned PDFs). Read-only. Only called for threads we process.
async function hydratePdfs(thread) {
  const out = [];
  for (const m of thread.messages) {
    for (const a of m.attachments || []) {
      if (a.isInline || !isPdf(a)) continue;
      const b = await fetchAttachmentBytes(m.message_id, a.id);
      if (b?.contentBytes) out.push({ name: b.name || a.name, contentType: b.contentType || a.contentType, bytes: b.contentBytes });
    }
  }
  return out;
}

// Turn a thread (ordered messages) into the {id, email, attachments} shape the
// Step-2 loader produces, so classify/extract see the whole chain + PDFs as one input.
function threadSample(thread, pdfs = []) {
  const chain = thread.messages.map((m) => {
    const tag = m.direction === "outbound" ? "[Buckeye reply]" : "[customer]";
    return `--- ${tag}  ${m.received || ""}  from ${m.from || ""} ---\nSubject: ${m.subject || ""}\n${m.body_text || ""}`;
  }).join("\n\n");
  const first = thread.messages.find((m) => m.direction === "inbound") || thread.messages[0];
  return {
    id: thread.conversationId,
    email: { sender: { name: "", address: first?.from || "" }, subject: thread.subject, received: thread.last_received, body_text: chain },
    attachments: pdfs, // {name, contentType, bytes} -> sent as native document blocks
  };
}

// The chain, shaped for render.js's conversation block.
const conversationOf = (thread) =>
  thread.messages.map((m) => ({ direction: m.direction, from: m.from, received: m.received, subject: m.subject, body_text: m.body_text }));

// Verify an order, honoring (1) an existing rep assignment, else (2) a learned alias
// (email domain / name), else (3) normal name-matching. Returns the verify result and
// the customer assignment to persist (so preview/approve force the same customer).
async function verifyWithAlias(order, existing) {
  if (existing?.number) {
    return { res: await verifyOrder(order, { forceCustomer: { number: existing.number, displayName: existing.name } }), assigned: existing };
  }
  const a = lookupAlias({ email: order.customer?.contact_email, name: order.customer?.name });
  if (a) {
    return { res: await verifyOrder(order, { forceCustomer: { number: a.number, displayName: a.name, via: a.via } }), assigned: { number: a.number, name: a.name } };
  }
  return { res: await verifyOrder(order), assigned: null };
}

// Assemble the review record the renderer expects from an extracted order + verify result.
function toRecord(thread, order, res, classification) {
  return {
    id: thread.conversationId, conversationId: thread.conversationId,
    po_number: order.po_number, order_date: order.order_date, requested_ship_date: order.requested_ship_date,
    customer: order.customer, ship_to: order.ship_to, line_items: order.line_items,
    company: res.company, rule1: res.rule1, lines: res.lines, linesPass: res.linesPass,
    shipTo: res.shipTo, contact: res.contact,
    disposition: res.disposition, dispositionReason: res.dispositionReason,
    classification, conversation: conversationOf(thread), last_received: thread.last_received,
  };
}

async function getThreads() {
  // Inbox only: reps reply from their own mailboxes, not order@, so the shared
  // mailbox's Sent Items doesn't hold the rep side — no point reading it.
  console.log(`Pulling order@ threads (Inbox, up to ${PULL_LIMIT}, read-only)…`);
  const threads = await collectThreads({ limit: PULL_LIMIT, folders: ["Inbox"] });
  console.log(`  ${threads.length} thread(s) found.\n`);
  return threads;
}

// FREE: list threads, no Claude, no BC.
async function cmdThreads() {
  const threads = await getThreads();
  for (const t of threads) {
    const dirs = t.messages.map((m) => (m.direction === "outbound" ? "↑" : "↓")).join("");
    console.log(`  ${(t.last_received || "").slice(0, 16).replace("T", " ")}  ${String(t.messages.length).padStart(2)} msg ${dirs.padEnd(6)}  ${t.has_attachments ? "📎" : "  "} ${(t.subject || "").slice(0, 60)}`);
  }
  mkdirSync("out", { recursive: true });
  writeFileSync("out/live-threads.json", JSON.stringify(threads, null, 2));
  console.log(`\n  ↓ inbound (customer) · ↑ outbound (rep). Wrote out/live-threads.json (PII — git-ignored).`);
  console.log(`  Nothing sent to Claude. Next: --estimate, then --run --limit 1.`);
}

function whichNew(threads, store) {
  return threads.filter((t) => {
    const prev = store.threads[t.conversationId];
    return !prev || !sameIds(prev.message_ids, t.message_ids); // new thread or new reply
  });
}

// Cheap: estimate the Claude cost for the NEW threads (token count only, incl. PDFs).
// Measures `limit` threads (or all) and projects across all fresh threads.
async function cmdEstimate(limit) {
  const threads = await getThreads();
  const store = loadStore();
  const fresh = whichNew(threads, store);
  const measure = limit ? fresh.slice(0, limit) : fresh;
  console.log(`  ${fresh.length} new/changed thread(s); measuring ${measure.length} to project.\n`);
  if (!measure.length) return;
  const client = makeClient();
  let inTok = 0;
  for (const t of measure) {
    const pdfs = await hydratePdfs(t);
    inTok += await countOne(client, threadSample(t, pdfs), { model: MODEL });
  }
  const p = PRICING[MODEL] || PRICING["claude-sonnet-5"];
  const perIn = inTok / measure.length;
  const estIn = perIn * 2 * fresh.length;     // classify + extract each send the input
  const estOut = fresh.length * 1200;         // rough per-thread generation
  const cost = (estIn / 1e6) * p.in + (estOut / 1e6) * p.out;
  console.log(`  model ${MODEL} · ~${Math.round(perIn).toLocaleString()} input tok/thread (measured ${measure.length})`);
  console.log(`  Projected for all ${fresh.length} thread(s): ~$${cost.toFixed(2)} (approx; PDFs dominate).`);
  console.log(`  Then a safe first run: node src/step5-review/pipeline.js --run --limit 1`);
}

// Spends: classify -> extract -> verify the new threads, cache, re-render the queue.
async function cmdRun(limit) {
  const threads = await getThreads();
  const store = loadStore();
  const fresh = whichNew(threads, store);
  const todo = limit ? fresh.slice(0, limit) : fresh;
  console.log(`  ${fresh.length} new/changed thread(s); processing ${todo.length}${limit && fresh.length > limit ? ` (--limit ${limit})` : ""}.\n`);
  const client = makeClient();

  for (const t of todo) {
    const pdfs = await hydratePdfs(t);
    const sample = threadSample(t, pdfs);
    let cls;
    try { cls = (await classifyOne(client, sample, { model: MODEL })).parsed_output; }
    catch (e) { console.log(`  ! ${t.subject?.slice(0, 40)} — classify failed: ${e.message}`); continue; }
    // Classification schema fields are `classification` and `reasoning` (not label/reason).
    const label = cls.classification;
    const classification = { label, confidence: cls.confidence, reason: cls.reasoning };

    if (label === "not_order") {
      store.threads[t.conversationId] = { message_ids: t.message_ids, classification, disposition: "not_order" };
      console.log(`  – not_order  ${t.subject?.slice(0, 50)}`);
      continue;
    }
    // order or unsure -> extract + verify (alias-aware)
    let order, res, assigned;
    try { order = (await extractOne(client, sample, { model: MODEL })).parsed_output; }
    catch (e) { console.log(`  ! ${t.subject?.slice(0, 40)} — extract failed: ${e.message}`); continue; }
    try { ({ res, assigned } = await verifyWithAlias(order)); }
    catch (e) { console.log(`  ! ${t.subject?.slice(0, 40)} — verify failed: ${e.message}`); continue; }
    const record = toRecord(t, order, res, classification);
    if (assigned) record.customer_assigned = { number: assigned.number, name: assigned.name };
    if (res.disposition === "order" || res.disposition === "quote") await enrichRecord(record, pdfs);
    store.threads[t.conversationId] = { message_ids: t.message_ids, classification, disposition: res.disposition, record };
    const dupNote = record.duplicates?.length ? " ⚠dup-in-BC" : "";
    console.log(`  ✓ ${res.disposition.padEnd(6)} ${t.subject?.slice(0, 50)}  (${label})${dupNote}`);
  }

  await reconcileActioned(store); // return any orders whose BC doc was deleted
  store.generated = new Date().toISOString();
  saveStore(store);
  renderFromStore(store);
}

// Enrich the EXISTING cache (no Claude): add the BC duplicate check + save source
// PDFs for cached order/quote records, then re-render. Cheap way to add these to a
// backlog already processed. Re-pulls threads to recover attachment ids.
async function cmdEnrich() {
  const store = loadStore();
  const threads = await getThreads();
  const byConv = Object.fromEntries(threads.map((t) => [t.conversationId, t]));
  let n = 0;
  for (const [cid, entry] of Object.entries(store.threads)) {
    if (!entry.record || (entry.disposition !== "order" && entry.disposition !== "quote")) continue;
    const pdfs = byConv[cid] ? await hydratePdfs(byConv[cid]) : [];
    await enrichRecord(entry.record, pdfs);
    n++;
    if (entry.record.duplicates?.length) console.log(`  ⚠ dup-in-BC  PO ${entry.record.po_number}  ${entry.record.customer?.name || ""}`);
  }
  store.generated = new Date().toISOString();
  saveStore(store);
  console.log(`  Enriched ${n} order/quote record(s) with BC duplicate check + saved PDFs.`);
  renderFromStore(store);
}

// Reconcile actioned orders against BC: if a created doc was later DELETED in BC,
// clear its actioned flag so it returns to the review queue. On any BC error we
// leave it actioned (don't resurrect on a transient blip). Read-only against BC.
async function reconcileActioned(store) {
  const actioned = Object.values(store.threads).filter((x) => x.record?.status === "actioned" && x.record.bc_number);
  if (!actioned.length) return;
  const company = await getCompany();
  let returned = 0;
  for (const x of actioned) {
    let exists = true;
    try { exists = await docExists(company, x.record.bc_docType, x.record.bc_number); } catch { exists = true; }
    if (!exists) {
      console.log(`  ↩ ${x.record.bc_docType} ${x.record.bc_number} gone from BC — returning PO ${x.record.po_number} to review`);
      delete x.record.status; delete x.record.bc_number; delete x.record.bc_docType;
      returned++;
    }
  }
  if (returned) console.log(`  ${returned} order(s) returned to the queue (deleted in BC).`);
}

// Re-run BC verification on cached (non-actioned) orders using the current rules —
// no Claude, no re-extraction. Picks up verify.js changes (e.g. the UoM gate).
async function cmdReverify() {
  const store = loadStore();
  const targets = Object.values(store.threads).filter((x) => x.record && x.disposition !== "not_order" && x.record.status !== "actioned");
  console.log(`Re-verifying ${targets.length} cached order(s) against BC (no Claude)…\n`);
  for (const x of targets) {
    const r = x.record;
    const order = { customer: r.customer, po_number: r.po_number, order_date: r.order_date, requested_ship_date: r.requested_ship_date, ship_to: r.ship_to, line_items: r.line_items };
    try {
      const { res, assigned } = await verifyWithAlias(order, r.customer_assigned);
      const was = x.disposition;
      r.rule1 = res.rule1; r.lines = res.lines; r.linesPass = res.linesPass;
      r.shipTo = res.shipTo; r.contact = res.contact;
      r.disposition = res.disposition; r.dispositionReason = res.dispositionReason; x.disposition = res.disposition;
      if (assigned) r.customer_assigned = { number: assigned.number, name: assigned.name };
      console.log(`  ${was === res.disposition ? " " : "→"} ${res.disposition.padEnd(6)} PO ${r.po_number} · ${r.customer?.name || ""}${was !== res.disposition ? `  (was ${was})` : ""}`);
    } catch (e) { console.log(`  ! ${r.po_number}: ${e.message}`); }
  }
  store.generated = new Date().toISOString();
  saveStore(store);
  renderFromStore(store);
}

// Standalone reconcile (no pull, no Claude): return BC-deleted orders to the queue.
async function cmdReconcile() {
  const store = loadStore();
  await reconcileActioned(store);
  store.generated = new Date().toISOString();
  saveStore(store);
  renderFromStore(store);
}

// Build the review page from every cached thread that isn't a not_order.
function renderFromStore(store) {
  const records = Object.values(store.threads)
    .filter((x) => x.record && x.disposition !== "not_order" && x.record.status !== "actioned")
    .map((x) => x.record)
    .sort((a, b) => (b.last_received || "").localeCompare(a.last_received || ""));
  const tally = records.reduce((t, r) => ((t[r.disposition] = (t[r.disposition] || 0) + 1), t), {});
  mkdirSync(dirname(OUT_HTML), { recursive: true });
  writeFileSync(OUT_HTML, page({ generated: store.generated, records, tally }));
  console.log(`\n  Rendered ${records.length} open thread(s) -> ${OUT_HTML}`);
  console.log(`  Order ${tally.order || 0} · Quote ${tally.quote || 0} · Needs review ${tally.review || 0}`);
  console.log("  (Prototype — buttons are a mock; PII stays in out/, never commit.)");
}

async function main() {
  const args = process.argv.slice(2);
  const limFlag = args.indexOf("--limit");
  const limit = limFlag !== -1 ? Number(args[limFlag + 1]) : null;
  if (args.includes("--threads")) return cmdThreads();
  if (args.includes("--estimate")) return cmdEstimate(limit);
  if (args.includes("--enrich")) return cmdEnrich(); // BC dup-check + save PDFs for cached orders
  if (args.includes("--reverify")) return cmdReverify(); // re-run BC verify on cache (picks up rule changes)
  if (args.includes("--reconcile")) return cmdReconcile(); // return orders deleted in BC to the queue
  if (args.includes("--rerender")) return renderFromStore(loadStore()); // re-render cache, no pull
  if (args.includes("--run")) return cmdRun(limit);
  console.log("Usage:\n  pipeline.js --threads          (FREE: pull + group + list threads)\n  pipeline.js --estimate         (token/cost estimate for new threads)\n  pipeline.js --run [--limit N]  (classify+extract+verify new threads, reconcile, then render)\n  pipeline.js --enrich           (BC dup-check + save PDFs for cached orders)\n  pipeline.js --reconcile        (return orders deleted in BC to the queue)\n  pipeline.js --rerender         (rebuild the page from cache; no pull, no Claude)");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
