// Order acknowledgement email. Composes a receipt for a freshly-created BC order/quote
// and — when enabled — sends it from the order@ mailbox via Microsoft Graph app-only
// Mail.Send. Kept OUT of ingestion/mailbox.js on purpose (that module is read-only).
//
// SAFE BY DEFAULT. On every create the server composes the acknowledgement and gets a
// preview back; it only performs a REAL send when BOTH are true:
//   • ACK_SEND=1                (master switch — off by default)
//   • a recipient email exists  (the PO's buyer contact, or ACK_TEST_TO)
// ACK_TEST_TO redirects EVERY send to one address — set it while testing so real
// customers are never emailed. A real send also requires the Graph app to have the
// **Mail.Send** application permission (admin-consented) and the mailbox Application
// Access Policy applied; until then a send returns an error that is reported but never
// blocks the order create.
//
// Env:
//   ACK_SEND=1                     enable real sending (default: compose-only / dry-run)
//   ACK_TEST_TO=you@buckeye.com    redirect all sends here (testing)
//   ACK_FROM_NAME="Buckeye Fasteners"   display context in the body
import "dotenv/config";

const TENANT = process.env.GRAPH_TENANT_ID, CLIENT = process.env.GRAPH_CLIENT_ID;
const SECRET = process.env.GRAPH_CLIENT_SECRET, MAILBOX = process.env.GRAPH_MAILBOX;
const GRAPH = "https://graph.microsoft.com/v1.0";
const ACK_SEND = process.env.ACK_SEND === "1";
const ACK_TEST_TO = (process.env.ACK_TEST_TO || "").trim() || null;
const ACK_FROM_NAME = process.env.ACK_FROM_NAME || "Buckeye Fasteners";

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
  if (!r.ok) throw new Error(`token -> HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.access_token;
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Compose the acknowledgement from the review record + the created BC doc result.
// Returns { to, subject, html, text, meta } — `to` is null when the PO carried no email.
export function buildAck(record, created) {
  const to = (record.customer?.contact_email || "").trim() || null;
  const docLabel = created?.docType === "quote" ? "Quote" : "Order";
  const bcNo = created?.number || null;
  const po = record.po_number || "";
  const cust = record.rule1?.match?.displayName || record.customer?.name || "there";
  const contactName = (record.customer?.contact_name || "").trim();
  const shipDate = (record.requested_ship_date || "").trim();

  const subject = `Order received — ${docLabel}${bcNo ? ` ${bcNo}` : ""} for your PO ${po}`;
  const shipLine = shipDate ? ` Your requested ship date of <b>${esc(shipDate)}</b> is noted.` : "";
  const shipLineTxt = shipDate ? ` Your requested ship date of ${shipDate} is noted.` : "";

  // Lower-price courtesy notice: when our price is below what the PO stated, we honor our
  // lower price and tell the customer (per the pricing rule). Fasteners quote per-piece.
  const uprice = (v) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 5 })}`;
  const under = (created?.underPriced || []).filter((u) => Number.isFinite(u.ourPrice) && Number.isFinite(u.poPrice));
  const underHtml = under.length
    ? `<p>Please note: on the following item${under.length > 1 ? "s" : ""} our current price is <b>lower</b> than the price on your PO, and we have entered the order at our lower price:</p>
  <ul>${under.map((u) => `<li>${esc(u.label || u.item)}: our price <b>${uprice(u.ourPrice)}</b>/ea (your PO: ${uprice(u.poPrice)}/ea)</li>`).join("")}</ul>`
    : "";
  const underTxt = under.length
    ? `\nPlease note: on the following item${under.length > 1 ? "s" : ""} our current price is lower than the price on your PO, and we entered the order at our lower price:\n`
      + under.map((u) => `  - ${u.label || u.item}: our price ${uprice(u.ourPrice)}/ea (your PO: ${uprice(u.poPrice)}/ea)`).join("\n") + "\n"
    : "";

  // Brief acknowledgement of receipt (no line-item table). Pricing/ship-date confirmation
  // is handled as a follow-up, so this note doesn't commit to either.
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1c2230">
  <p>Hello${contactName ? ` ${esc(contactName)}` : ""},</p>
  <p>Thank you — we have received your purchase order <b>${esc(po)}</b>${cust ? ` from ${esc(cust)}` : ""} and entered it as ${docLabel}${bcNo ? ` <b>${esc(bcNo)}</b>` : ""}.${shipLine} We will follow up shortly to confirm pricing and the ship date.</p>
  ${underHtml}
  <p>Please reply to this email with any questions.</p>
  <p>Regards,<br>${esc(ACK_FROM_NAME)}</p>
</div>`;

  const text = `Hello${contactName ? ` ${contactName}` : ""},\n\n`
    + `Thank you - we have received your purchase order ${po}${cust ? ` from ${cust}` : ""} and entered it as ${docLabel}${bcNo ? ` ${bcNo}` : ""}.${shipLineTxt} We will follow up shortly to confirm pricing and the ship date.\n`
    + underTxt
    + `\nPlease reply with any questions.\n\nRegards,\n${ACK_FROM_NAME}\n`;

  return { to, subject, html, text, meta: { bcNo, docLabel, po } };
}

async function sendMail({ to, subject, html }) {
  if (!TOKEN) TOKEN = await token();
  const message = { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] };
  const r = await fetch(`${GRAPH}/users/${encodeURIComponent(MAILBOX)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (r.status === 202) return { ok: true };
  const t = await r.text().catch(() => "");
  return { ok: false, status: r.status, error: t.slice(0, 300) };
}

// Compose and (only when enabled + a recipient exists) send. NEVER throws to the caller
// in a way that would fail the order create — a send problem is returned, not raised.
// Returns { composed, sent, to, redirected, reason, subject }.
export async function acknowledge(record, created) {
  let ack;
  try { ack = buildAck(record, created); }
  catch (e) { return { composed: false, sent: false, reason: `compose failed: ${e.message}` }; }
  const recipient = ACK_TEST_TO || ack.to;
  const base = { composed: true, sent: false, subject: ack.subject, to: recipient };
  if (!recipient) return { ...base, reason: "no recipient email on the PO — nothing sent" };
  if (!ACK_SEND) return { ...base, reason: "ACK_SEND not enabled — composed only (dry-run)" };
  try {
    const res = await sendMail({ to: recipient, subject: ack.subject, html: ack.html });
    if (res.ok) return { ...base, sent: true, redirected: !!ACK_TEST_TO };
    return { ...base, reason: `send failed (HTTP ${res.status}) — ${res.error}` };
  } catch (e) { return { ...base, reason: `send error: ${e.message}` }; }
}
