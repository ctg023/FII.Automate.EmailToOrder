// Live READ-ONLY ingestion from the orders@ shared mailbox via Microsoft Graph.
//
// SAFETY: this module is strictly read-only against the mailbox. It issues ONLY
// GET requests for message data (plus the OAuth token POST to log in). It NEVER
// marks messages read, moves, deletes, flags, or otherwise mutates the mailbox —
// per the hard project rule. Because we may not mark messages "done" in the
// mailbox, already-processed messages are tracked in a LOCAL state file keyed by
// the Graph message id, so the same email is never emitted to the pipeline twice.
//
// Auth: app-only (client credentials). The Entra app registration needs
// application permission Mail.Read, admin-consented, and should be scoped to just
// this mailbox with an Application Access Policy (see README).
//
// .env:
//   GRAPH_TENANT_ID=<entra tenant id>
//   GRAPH_CLIENT_ID=<app (client) id>
//   GRAPH_CLIENT_SECRET=<client secret>     # git-ignored; prefer a certificate in prod
//   GRAPH_MAILBOX=orders@yourdomain.com     # the shared mailbox UPN/address
//
// Usage (both read-only against the mailbox):
//   node src/ingestion/mailbox.js --list [--limit 25]           # preview recent, NO state change
//   node src/ingestion/mailbox.js --pull [--limit 25] [--out <dir>]  # emit NEW messages, update state
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const TENANT = process.env.GRAPH_TENANT_ID, CLIENT = process.env.GRAPH_CLIENT_ID;
const SECRET = process.env.GRAPH_CLIENT_SECRET, MAILBOX = process.env.GRAPH_MAILBOX;
const GRAPH = "https://graph.microsoft.com/v1.0";
const STATE_FILE = process.env.INGEST_STATE || "src/ingestion/.ingest-state.json";

let TOKEN = null;
async function token() {
  const body = new URLSearchParams({
    client_id: CLIENT, client_secret: SECRET,
    scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials",
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token -> HTTP ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j.access_token;
}

// GET-only Graph client. This function must never be used for a mutating verb.
async function gget(pathOrUrl, extraHeaders = {}) {
  if (!TOKEN) TOKEN = await token();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json", ...extraHeaders } });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { ok: r.ok, status: r.status, json, text };
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { processed: {} }; }
}
function saveState(state) {
  try { mkdirSync("src/ingestion", { recursive: true }); } catch { /* exists */ }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const mbPath = () => `/users/${encodeURIComponent(MAILBOX)}`;

// Read-only: list recent messages in a folder (metadata only). Default Inbox.
async function listMessages(limit, folder = "Inbox") {
  const sel = "id,conversationId,receivedDateTime,from,toRecipients,subject,hasAttachments,bodyPreview";
  const r = await gget(`${mbPath()}/mailFolders/${folder}/messages?$select=${sel}&$top=${limit}&$orderby=receivedDateTime desc`);
  if (!r.ok) throw new Error(`list ${folder} -> HTTP ${r.status}: ${(r.text || "").slice(0, 400)}`);
  return r.json?.value || [];
}

// Read-only: full message body + attachments (native contentBytes) for one message.
async function fetchMessage(id) {
  const msg = await gget(`${mbPath()}/messages/${id}?$select=id,conversationId,receivedDateTime,from,toRecipients,subject,body,hasAttachments`);
  const atts = msg.json?.hasAttachments
    ? (await gget(`${mbPath()}/messages/${id}/attachments?$select=id,name,contentType,size,isInline`)).json?.value || []
    : [];
  return { msg: msg.json, atts };
}

const senderOf = (m) => m?.from?.emailAddress?.address || "(unknown)";

// Read-only: fetch one attachment's native bytes (base64) for a message. Used by
// the Step-5 pipeline to send real PDFs to the model. Returns null on failure.
export async function fetchAttachmentBytes(messageId, attachmentId) {
  const r = await gget(`${mbPath()}/messages/${encodeURIComponent(messageId)}/attachments/${attachmentId}`);
  if (!r.ok || !r.json) return null;
  return { name: r.json.name, contentType: r.json.contentType, contentBytes: r.json.contentBytes || null };
}

// Read-only: some senders (e.g. Bunn) forward the PO as an EMAIL attached to the
// email — a Graph `itemAttachment` (message/rfc822) whose real PO PDF is nested one
// level down inside that attached message. Graph can't address the nested email's
// attachments by URL path (that segment 400s), but a nested $expand returns them
// inline WITH contentBytes. Return the nested file attachments (metadata + bytes) so
// the caller can filter to PDFs. Returns [] on any failure or non-item attachment.
export async function fetchItemAttachmentFiles(messageId, attachmentId) {
  const r = await gget(
    `${mbPath()}/messages/${encodeURIComponent(messageId)}/attachments/${attachmentId}` +
    `?$expand=microsoft.graph.itemAttachment/item($expand=microsoft.graph.message/attachments)`
  );
  const nested = r.json?.item?.attachments || [];
  return nested
    .filter((a) => /fileAttachment/i.test(a["@odata.type"] || "") && !a.isInline)
    .map((a) => ({ name: a.name, contentType: a.contentType, isInline: a.isInline, contentBytes: a.contentBytes || null }));
}

// Read-only: the Inbox folder's id (cached), to test message membership by parentFolderId.
let INBOX_ID = null;
async function inboxId() {
  if (INBOX_ID) return INBOX_ID;
  const r = await gget(`${mbPath()}/mailFolders/Inbox?$select=id`);
  INBOX_ID = r.ok ? (r.json?.id || null) : null;
  return INBOX_ID;
}

// Read-only: does the Inbox currently contain a message matching this text (a PO number
// or subject)? A content search that DOESN'T depend on the volatile default message id —
// used to CONFIRM an id-based "gone" before a card is dropped. -> true | false | null(unknown).
export async function inboxContains(query) {
  const q = String(query || "").trim();
  if (q.length < 3) return null;
  const r = await gget(
    `${mbPath()}/mailFolders/Inbox/messages?$search=${encodeURIComponent(`"${q}"`)}&$select=id&$top=1`,
    { ConsistencyLevel: "eventual" }
  );
  if (!r.ok) return null;
  return (r.json?.value || []).length > 0;
}

// Read-only: is a message still in the Inbox? Returns "in" | "gone" | "unknown".
// NOTE: a folder-scoped GET (/mailFolders/Inbox/messages/{id}) does NOT enforce the
// folder — Graph resolves by id regardless — so we must compare parentFolderId. A
// hard delete or a MOVE (default ids change on move) yields 404 -> "gone"; a message
// still in another folder yields a different parentFolderId -> also "gone" (handled).
// Any non-404 error -> "unknown" so callers never prune on a transient failure.
export async function messageInInbox(messageId) {
  const r = await gget(`${mbPath()}/messages/${encodeURIComponent(messageId)}?$select=id,parentFolderId`);
  if (r.status === 404) return "gone";
  if (!r.ok || !r.json) return "unknown";
  const ib = await inboxId();
  if (!ib) return "unknown";
  return r.json.parentFolderId === ib ? "in" : "gone";
}

// Read-only: collect recent messages across folders (Inbox = inbound customer mail,
// SentItems = outbound rep replies), fetch each full body, and group into threads by
// Graph conversationId — so a PO and its whole back-and-forth are one unit. Never
// mutates the mailbox. Returns threads newest-activity-first. Used by the Step-5 live
// review runner (src/step5-review/pipeline.js).
export async function collectThreads({ limit = 50, folders = ["Inbox", "SentItems"] } = {}) {
  const byConv = new Map();
  for (const folder of folders) {
    const direction = folder.toLowerCase().includes("sent") ? "outbound" : "inbound";
    let heads = [];
    try { heads = await listMessages(limit, folder); }
    catch (e) { if (direction === "outbound") continue; throw e; } // Sent optional; skip if absent
    for (const h of heads) {
      const { msg, atts } = await fetchMessage(h.id);
      if (!msg) continue;
      const rec = msgRecord(msg, atts, direction);
      if (!byConv.has(rec.conversationId)) byConv.set(rec.conversationId, []);
      byConv.get(rec.conversationId).push(rec);
    }
  }
  const threads = [];
  for (const [conversationId, msgs] of byConv) {
    msgs.sort((a, b) => (a.received || "").localeCompare(b.received || ""));
    const last = msgs[msgs.length - 1];
    threads.push({
      conversationId,
      subject: msgs.find((m) => m.subject)?.subject || "(no subject)",
      messages: msgs,
      last_received: last?.received || null,
      has_attachments: msgs.some((m) => m.attachments.length),
      message_ids: msgs.map((m) => m.message_id),
    });
  }
  threads.sort((a, b) => (b.last_received || "").localeCompare(a.last_received || ""));
  return threads;
}

// One message -> the thread-message record shape used above (and by fetchThreadByIds).
function msgRecord(msg, atts, direction = "inbound") {
  return {
    message_id: msg.id, conversationId: msg.conversationId || msg.id, direction,
    received: msg.receivedDateTime, from: senderOf(msg),
    to: (msg.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean),
    subject: msg.subject,
    body_text: (msg.body?.contentType === "html" ? htmlToText(msg.body?.content) : msg.body?.content) || "",
    attachments: (atts || []).map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size, isInline: a.isInline, odataType: a["@odata.type"] })),
  };
}

// Read-only: rebuild a thread object from a known set of message ids (e.g. a cached
// card's message_ids). Used by cache-aware thread-merge to pull a split PO's other
// half — which has scrolled out of the recent-message pull window — back in, fresh
// (with attachment ids), so its PDFs hydrate and it re-extracts as one unit. Returns
// null if none resolve. Direction defaults to inbound (order@ Inbox is inbound mail).
export async function fetchThreadByIds(messageIds, direction = "inbound") {
  const messages = [];
  for (const id of messageIds || []) {
    const { msg, atts } = await fetchMessage(id);
    if (msg) messages.push(msgRecord(msg, atts, direction));
  }
  if (!messages.length) return null;
  messages.sort((a, b) => (a.received || "").localeCompare(b.received || ""));
  const last = messages[messages.length - 1];
  return {
    conversationId: messages[0].conversationId,
    subject: messages.find((m) => m.subject)?.subject || "(no subject)",
    messages, last_received: last?.received || null,
    has_attachments: messages.some((m) => m.attachments.length),
    message_ids: messages.map((m) => m.message_id),
  };
}

async function cmdList(limit) {
  const msgs = await listMessages(limit);
  const state = loadState();
  console.log(`Inbox of ${MAILBOX} — ${msgs.length} most recent (READ-ONLY, no state change):\n`);
  for (const m of msgs) {
    const seen = state.processed[m.id] ? "•" : " ";
    console.log(`  ${seen} ${m.receivedDateTime?.slice(0, 16).replace("T", " ")}  ${senderOf(m).padEnd(28).slice(0, 28)}  ${m.hasAttachments ? "📎" : "  "} ${(m.subject || "(no subject)").slice(0, 60)}`);
  }
  console.log(`\n  ( • = already processed )  Nothing was modified in the mailbox.`);
}

async function cmdPull(limit, outDir) {
  const msgs = await listMessages(limit);
  const state = loadState();
  const fresh = msgs.filter((m) => !state.processed[m.id]);
  console.log(`${fresh.length} new message(s) of ${msgs.length} scanned.`);
  if (outDir) mkdirSync(outDir, { recursive: true });

  for (const head of fresh) {
    const { msg, atts } = await fetchMessage(head.id);
    // Normalized inbound-email record the downstream pipeline consumes.
    const record = {
      message_id: msg.id,
      received: msg.receivedDateTime,
      from: senderOf(msg),
      subject: msg.subject,
      body_text: (msg.body?.contentType === "html" ? htmlToText(msg.body?.content) : msg.body?.content) || "",
      attachments: atts.map((a) => ({ name: a.name, contentType: a.contentType, size: a.size, isInline: a.isInline })),
    };
    console.log(`  • ${record.received?.slice(0, 16).replace("T", " ")}  ${record.from}  "${record.subject}"  (${atts.length} attachment(s))`);
    if (outDir) {
      // Filename must be UNIQUE per message. Graph ids share a long common prefix,
      // so a truncated id collides and silently overwrites other records; key the
      // name on a stable hash of the FULL id instead (a re-pull of the same message
      // overwrites itself, which is correct; different messages never collide).
      const hash = createHash("sha256").update(record.message_id).digest("hex").slice(0, 16);
      const day = (record.received || "").slice(0, 10) || "nodate"; // readable prefix
      const safe = `${day}_${hash}`;
      writeFileSync(join(outDir, `${safe}.json`), JSON.stringify(record, null, 2));
      // Native attachment bytes are available on each attachment (contentBytes); a
      // later stage saves/extracts them. Kept out of the record to avoid bloat/PII.
    }
    state.processed[msg.id] = new Date().toISOString();
  }
  saveState(state);
  console.log(`\n  State updated (${Object.keys(state.processed).length} processed ids). Mailbox not modified.`);
  if (outDir) console.log(`  Records written to ${outDir}/`);
}

// Diagnostic: is Graph access already set up? Reports each step and what a failure means.
async function cmdCheck() {
  console.log("Graph ingestion diagnostic (read-only) — is it already set up?\n");
  console.log(`  tenant : ${TENANT}`);
  console.log(`  client : ${CLIENT}`);
  console.log(`  mailbox: ${MAILBOX}\n`);
  try {
    TOKEN = await token();
    console.log("  [1/2] OAuth token .......... OK  (app registration exists, secret valid)");
  } catch (e) {
    console.log(`  [1/2] OAuth token .......... FAILED — ${e.message}`);
    console.log("        → wrong tenant/client id or secret, or the app registration doesn't exist yet.");
    return;
  }
  const r = await gget(`${mbPath()}/mailFolders/Inbox?$select=displayName,totalItemCount`);
  if (r.ok) {
    console.log(`  [2/2] Read ${MAILBOX} Inbox .. OK  ("${r.json.displayName}", ${r.json.totalItemCount} items)`);
    console.log("\n  ✅ Already set up — Mail.Read works for this mailbox. You can run --list / --pull.");
  } else {
    console.log(`  [2/2] Read ${MAILBOX} Inbox .. HTTP ${r.status}`);
    if (r.status === 403) console.log("        → app authenticates but is NOT permitted. Add Mail.Read (Application) + admin consent,\n          and ensure the Application Access Policy grants THIS app access to THIS mailbox.");
    else if (r.status === 404) console.log("        → mailbox not found. Check GRAPH_MAILBOX is the exact shared-mailbox address.");
    else console.log("        → " + (r.text || "").slice(0, 300));
    console.log("\n  ⚠ Not fully set up yet (see above).");
  }
}

// Minimal HTML → text for email bodies (strip tags/entities). Extraction proper is Step 2.
function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

async function main() {
  for (const [k, v] of [["GRAPH_TENANT_ID", TENANT], ["GRAPH_CLIENT_ID", CLIENT], ["GRAPH_CLIENT_SECRET", SECRET], ["GRAPH_MAILBOX", MAILBOX]]) {
    if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
  }
  const args = process.argv.slice(2);
  const limit = args.indexOf("--limit") !== -1 ? parseInt(args[args.indexOf("--limit") + 1], 10) : 25;
  const outDir = args.indexOf("--out") !== -1 ? args[args.indexOf("--out") + 1] : null;
  if (args.includes("--check")) return cmdCheck();
  if (args.includes("--list")) return cmdList(limit);
  if (args.includes("--pull")) return cmdPull(limit, outDir);
  console.log("Usage:\n  mailbox.js --check                      (diagnose whether Graph access is set up)\n  mailbox.js --list [--limit N]           (read-only preview)\n  mailbox.js --pull [--limit N] [--out <dir>]  (emit new messages, update local state)");
}

// Only run the CLI when executed directly; importing (e.g. collectThreads from the
// Step-5 pipeline) must NOT trigger main().
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
