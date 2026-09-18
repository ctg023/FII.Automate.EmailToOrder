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
async function gget(pathOrUrl) {
  if (!TOKEN) TOKEN = await token();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } });
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

// Read-only: list recent Inbox messages (metadata only).
async function listMessages(limit) {
  const sel = "id,receivedDateTime,from,subject,hasAttachments,bodyPreview";
  const r = await gget(`${mbPath()}/mailFolders/Inbox/messages?$select=${sel}&$top=${limit}&$orderby=receivedDateTime desc`);
  if (!r.ok) throw new Error(`list -> HTTP ${r.status}: ${(r.text || "").slice(0, 400)}`);
  return r.json?.value || [];
}

// Read-only: full message body + attachments (native contentBytes) for one message.
async function fetchMessage(id) {
  const msg = await gget(`${mbPath()}/messages/${id}?$select=id,receivedDateTime,from,subject,body,hasAttachments`);
  const atts = msg.json?.hasAttachments
    ? (await gget(`${mbPath()}/messages/${id}/attachments?$select=id,name,contentType,size,isInline`)).json?.value || []
    : [];
  return { msg: msg.json, atts };
}

const senderOf = (m) => m?.from?.emailAddress?.address || "(unknown)";

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
      const safe = record.message_id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
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
  if (args.includes("--list")) return cmdList(limit);
  if (args.includes("--pull")) return cmdPull(limit, outDir);
  console.log("Usage:\n  mailbox.js --list [--limit N]           (read-only preview)\n  mailbox.js --pull [--limit N] [--out <dir>]  (emit new messages, update local state)");
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
